import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TradeStore } from '../../packages/alex-core/index.mjs';
import { BrowserController } from '../../services/alex-browser/index.mjs';
import { ConversationService } from '../../services/alex-conversation/index.mjs';
import { acquireDataLock, readRuntimeConfig, isLocalPeer } from './runtime.mjs';
import { ResearchRunner, normalizeCriteria } from '../../services/alex-research/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const publicDir = join(root, 'apps/alex/public');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function fail(message, code = 'invalid_request', status = 400) {
  return Object.assign(new Error(message), { code, status });
}
function secureEqual(left, right) {
  const a = Buffer.from(String(left || '')), b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function readBackups(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    try {
      const path = join(directory, entry.name, 'manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      return [{ ...manifest, name: entry.name, location: 'local', directory: join(directory, entry.name) }];
    } catch { return []; }
  }).sort((a, b) => String(b.createdAt || b.created_at || b.name).localeCompare(String(a.createdAt || a.created_at || a.name)));
}
async function body(req) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1_000_000) throw fail('请求过大', 'payload_too_large', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fail('请求必须为 JSON 对象'); }
}

export async function createAlexServer(options = {}) {
  const runtime = readRuntimeConfig(options.env || process.env);
  const dataDir = resolve(options.dataDir || process.env.ALEX_DATA_DIR || join(root, 'work/alex'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dataLock = await (options.acquireLock || acquireDataLock)(dataDir);
  let store, browser, runner, conversation, server, automaticBackup;
  try {
    const tokenFile = join(dataDir, 'api-token');
    let token = options.token || process.env.ALEX_API_TOKEN;
    if (!token) {
      if (existsSync(tokenFile)) token = readFileSync(tokenFile, 'utf8').trim();
      else {
        token = randomBytes(32).toString('hex');
        writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' });
      }
    }
    if (!token || token.length < 24) throw fail('ALEX_API_TOKEN 至少需要 24 个字符');
    store = options.store || new TradeStore({ path: join(dataDir, 'alex.sqlite3'), workspaceId: 'local', allowLocalTest: options.allowLocalTest === true });
    store.recoverTasks();
    browser = options.browser || new BrowserController({
      dataDir: join(dataDir, 'browser'), executablePath: process.env.ALEX_CHROMIUM_PATH,
      proxyServer: process.env.HTTPS_PROXY || process.env.https_proxy, allowLocalTest: options.allowLocalTest === true,
    });
    try { await browser.start(); }
    catch (error) { store.appendEvent({ type: 'browser.unavailable', detail: { message: String(error.message).slice(0, 500) } }); }
    const llm = options.llm || {
      baseUrl: process.env.ALEX_LLM_BASE_URL || 'https://api.deepseek.com/v1',
      model: process.env.ALEX_LLM_MODEL || 'deepseek-chat', apiKey: process.env.ALEX_LLM_API_KEY || '',
    };
    runner = options.runner || new ResearchRunner({ store, browser, llm });
    conversation = options.conversation || new ConversationService({ store, runner });
    const active = new Map();
    const requests = new Set();
    const shutdown = new AbortController();
    let closing = false, closePromise, backupJob;
    const backupDirectory = resolve(process.env.ALEX_BACKUP_DIR || join(dataDir, 'backups'));
    let backupInProgress = false;

    const capabilities = () => ({
      modelConfigured: Boolean(llm.apiKey), browserAvailable: browser.state().available === true,
      model: llm.model, workspaceId: 'local', backupLocation: 'local', discoveryStatus: 'unverified', sourceMode: 'live-only',
      outboundEnabled: false, version,
    });
    const launch = id => {
      if (active.has(id)) return;
      const work = Promise.resolve().then(() => runner.run(id)).catch(error => {
        try {
          store.updateTask(id, { status: 'failed', error: String(error.message).slice(0, 1000) });
          store.appendEvent({ taskId: id, type: 'task.failed', detail: { message: String(error.message).slice(0, 1000) } });
        } catch { /* task was deleted or shutdown */ }
      }).finally(() => active.delete(id));
      active.set(id, work);
    };
    const makeBackup = async () => {
      if (closing) throw fail('Alex 正在关闭。', 'server_stopping', 503);
      if (backupInProgress) throw fail('备份正在进行', 'backup_in_progress', 409);
      backupInProgress = true;
      try { backupJob = store.backup(backupDirectory); return await backupJob; }
      finally { backupInProgress = false; }
    };

    const handleRequest = async (req, res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      const json = (value, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(value));
      };
      try {
        if (closing) throw fail('Alex 正在关闭，请稍后重启。', 'server_stopping', 503);
        if (!isLocalPeer(req.socket.remoteAddress, runtime.localProxyIp)) throw fail('仅允许本机入口访问', 'invalid_peer', 403);
        const host = req.headers.host || '';
        if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/u.test(host)) throw fail('仅允许本机访问', 'invalid_host', 403);
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`) throw fail('禁止跨站请求', 'invalid_origin', 403);
        const url = new URL(req.url, `http://${host}`);
        const pathname = url.pathname;
        if (req.method === 'GET' && pathname === '/api/health') return json({ ok: true, product: 'Alex', capabilities: capabilities() });
        if (req.method === 'GET' && pathname === '/api/bootstrap') {
          res.setHeader('Set-Cookie', `alex_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api`);
          return json({ token, workspaceId: 'local', profile: store.getProfile(), capabilities: capabilities() });
        }
        if (pathname.startsWith('/api/')) {
          const cookie = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('alex_session='));
          let cookieToken = '';
          try { cookieToken = cookie ? decodeURIComponent(cookie.slice(13)) : ''; } catch { /* invalid cookie */ }
          if (!secureEqual(req.headers['x-alex-token'] || cookieToken, token)) throw fail('请重新打开工作台或配置访问令牌', 'unauthorized', 401);
          if (!['GET', 'POST'].includes(req.method)) throw fail('不支持的请求方法', 'method_not_allowed', 405);
          if (req.method === 'GET') {
            if (pathname === '/api/conversations') return json(store.listConversations());
            const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)(\/messages)?$/u);
            if (conversationMatch) return json(conversationMatch[2] ? store.listMessages(conversationMatch[1]) : store.getConversation(conversationMatch[1]));
            if (pathname === '/api/profile') return json(store.getProfile());
            if (pathname === '/api/memories') return json(store.listMemories({ query: url.searchParams.get('query') || '' }));
            if (pathname === '/api/companies') return json(store.listCompanies({ query: url.searchParams.get('query') || '', includeArchived: url.searchParams.get('includeArchived') === '1' }));
            if (pathname === '/api/companies/export') {
              const records = store.listCompanies({ includeArchived: url.searchParams.get('includeArchived') === '1' });
              const rows = [['客户编号', '公司', '官网', '国家', '公开邮箱', '公开电话', '来源证据', '状态']];
              for (const c of records) rows.push([c.id, c.name, c.website, c.country, (c.contacts || []).map(v => v.email || (v.type === 'email' ? v.value : '')).filter(Boolean).join('; '), (c.contacts || []).map(v => v.phone || (v.type === 'phone' ? v.value : '')).filter(Boolean).join('; '), (c.evidence || []).map(v => v.url).filter(Boolean).join('; '), c.archived ? '归档' : (c.status || '待复核')]);
              res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="alex-customers.csv"' });
              return res.end('\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'));
            }
            if (pathname === '/api/tasks') return json(store.listTasks());
            let match = pathname.match(/^\/api\/tasks\/([^/]+)(\/events)?$/u);
            if (match) return json(match[2] ? store.listEvents(match[1]) : store.getTask(match[1]));
            match = pathname.match(/^\/api\/companies\/([^/]+)$/u);
            if (match) return json(store.getCompany(match[1]));
            if (pathname === '/api/drafts') return json(store.listDrafts());
            if (pathname === '/api/backups') return json(readBackups(backupDirectory));
            if (pathname === '/api/browser/state') return json(browser.state());
            if (pathname === '/api/browser/frame') {
              const frame = await browser.screenshot();
              res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(frame);
            }
            if (pathname === '/api/agent/browser/extract') return json(await browser.extract({ actor: 'agent' }));
          } else {
            const input = await body(req);
            if (closing) throw fail('Alex 正在关闭，请稍后重启。', 'server_stopping', 503);
            if (pathname === '/api/conversations') return json(store.createConversation({ title: input.title }), 201);
            const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/u);
            if (conversationMatch) return json(await conversation.send(conversationMatch[1], { content: input.content, idempotencyKey: input.idempotencyKey }));
            if (pathname === '/api/profile') {
              if (!input.facts || typeof input.facts !== 'object' || Array.isArray(input.facts)) throw fail('请提供企业资料');
              return json(store.saveProfile(input.facts, { source: 'user' }));
            }
            if (pathname === '/api/memories') return json(store.addMemory({ ...input, source: input.source || 'user' }), 201);
            if (pathname === '/api/plan') return json(await runner.plan(String(input.request || ''), { signal: shutdown.signal }));
            if (pathname === '/api/tasks') {
              const request = String(input.request || '').trim();
              if (!request || request.length > 10000) throw fail('请描述任务目标');
              const criteria = input.criteria || {};
              if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) throw fail('任务要求格式无效');
              if (input.urls !== undefined && (!Array.isArray(input.urls) || input.urls.length > 20 || input.urls.some(value => typeof value !== 'string'))) throw fail('最多提供 20 个官网地址');
              const checkedCriteria = normalizeCriteria({ ...criteria, ...(input.urls?.length ? { urls: input.urls } : {}) });
              const task = store.createTask({ request, criteria: checkedCriteria, idempotencyKey: input.idempotencyKey });
              if (task.status === 'queued') launch(task.id);
              return json(task, 201);
            }
            let match = pathname.match(/^\/api\/tasks\/([^/]+)\/(resume|pause|cancel)$/u);
            if (match) {
              const task = store.getTask(match[1]);
              if (!task) throw fail('任务不存在', 'not_found', 404);
              if (match[2] === 'pause') await runner.pause(task.id);
              if (match[2] === 'cancel') await runner.cancel(task.id);
              if (match[2] === 'resume') {
                if (task.status === 'cancelled' || task.status === 'completed') throw fail('任务已经结束', 'task_finished', 409);
                if (browser.state().owner === 'human') throw fail('请先交还浏览器控制权', 'human_has_control', 409);
                if (active.has(task.id)) throw fail('任务还在停止中，请稍后继续', 'task_busy', 409);
                store.updateTask(task.id, { status: 'queued', error: null }); launch(task.id);
              }
              return json(store.getTask(task.id));
            }
            match = pathname.match(/^\/api\/companies\/([^/]+)\/archive$/u);
            if (match) return json(store.archiveCompany(match[1], input.archived !== false));
            match = pathname.match(/^\/api\/companies\/([^/]+)\/draft$/u);
            if (match) return json(await runner.prepareDraft(match[1], { taskId: input.taskId, request: input.request }), 201);
            if (pathname === '/api/drafts') return json(store.saveDraft(input), 201);
            match = pathname.match(/^\/api\/drafts\/([^/]+)\/review$/u);
            if (match) return json(store.reviewDraft(match[1], { status: input.status, actor: 'local-user' }));
            if (pathname === '/api/backups') return json(await makeBackup(), 201);
            if (pathname === '/api/browser/takeover') {
              for (const id of active.keys()) await runner.pause(id);
              await browser.takeover(); return json(browser.state());
            }
            if (pathname === '/api/browser/release') { await browser.release(); return json(browser.state()); }
            if (pathname === '/api/browser/navigate') { await browser.navigate(input.url, { actor: 'human' }); return json(browser.state()); }
            if (pathname === '/api/browser/action') return json(await browser.act(input, { actor: 'human' }));
            if (pathname === '/api/agent/browser/navigate') { await browser.navigate(input.url, { actor: 'agent' }); return json(browser.state()); }
            if (pathname === '/api/agent/browser/action') return json(await browser.act(input, { actor: 'agent' }));
          }
          throw fail('接口不存在', 'not_found', 404);
        }
        if (req.method !== 'GET') throw fail('页面不存在', 'not_found', 404);
        const path = resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!path.startsWith(`${publicDir}/`) || !existsSync(path) || !statSync(path).isFile()) throw fail('页面不存在', 'not_found', 404);
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' }); res.end(readFileSync(path));
      } catch (error) {
        const status = error.status || (error.code === 'human_has_control' ? 409 : 400);
        if (!res.headersSent) json({ error: String(error.message || '操作失败').slice(0, 1500), code: error.code || 'operation_failed' }, status);
        else res.end();
      }
    };
    server = http.createServer((req, res) => {
      const work = handleRequest(req, res).finally(() => requests.delete(work));
      requests.add(work);
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    automaticBackup = setInterval(async () => {
      const backups = readBackups(backupDirectory);
      const last = backups[0];
      const at = Date.parse(last?.createdAt || last?.created_at || '');
      if (Number.isFinite(at) && Date.now() - at < 24 * 60 * 60 * 1000) return;
      try { await makeBackup(); }
      catch (error) {
        if (!closing) {
          try { store.appendEvent({ type: 'backup.failed', detail: { message: String(error.message).slice(0, 500) } }); }
          catch { /* the store is shutting down */ }
        }
      }
    }, 60 * 60 * 1000);
    automaticBackup.unref();

    const close = () => {
      if (closePromise) return closePromise;
      closing = true;
      shutdown.abort();
      closePromise = (async () => {
        clearInterval(automaticBackup);
        const stoppedHttp = new Promise(resolveClose => server.close(() => resolveClose()));
        server.closeIdleConnections();
        const forcedClose = setTimeout(() => server.closeAllConnections(), 5000);
        try {
          await Promise.allSettled([...active.keys()].map(id => Promise.resolve().then(() => runner.pause(id))));
          await Promise.allSettled([conversation.close(), browser.close()]);
          await Promise.allSettled([...active.values(), ...requests, ...(backupJob ? [backupJob] : [])]);
          await stoppedHttp;
        } finally {
          clearTimeout(forcedClose);
          try { store.close(); } finally { await dataLock.release(); }
        }
      })();
      return closePromise;
    };
    server.on('error', () => { close().catch(() => {}); });
    dataLock.onLost(() => { close().catch(() => {}); });
    if (!dataLock.isHeld()) { await close(); throw fail('数据目录进程锁已丢失；启动已取消。', 'data_lock_lost', 503); }
    return { hasDataLock: () => dataLock.isHeld(), server, store, browser, runner, conversation, dataDir, token, runtime, capabilities, close, makeBackup };
  } catch (error) {
    clearInterval(automaticBackup);
    await conversation?.close().catch(() => {});
    await browser?.close().catch(() => {});
    try { store?.close(); } catch { /* cleanup may already have closed it */ }
    finally { await dataLock.release(); }
    throw error;
  }
}

export async function startAlexServer(options = {}) {
  const app = await createAlexServer(options);
  try {
    if (!app.hasDataLock()) throw fail('数据目录进程锁已丢失；启动已取消。', 'data_lock_lost', 503);
    await new Promise((resolveListen, reject) => {
      app.server.once('error', reject);
      app.server.listen(app.runtime.port, app.runtime.bindHost, () => {
        app.server.off('error', reject);
        if (!app.hasDataLock()) reject(fail('数据目录进程锁已丢失；启动已取消。', 'data_lock_lost', 503));
        else resolveListen();
      });
    });
    return app;
  } catch (error) { await app.close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let startup, stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    try {
      const app = await startup.catch(() => null);
      if (app) await app.close();
      if (process.exitCode !== 1) process.exitCode = 0;
    } catch { console.error('Alex 关闭失败，请检查进程与数据目录。'); process.exitCode = 1; }
  });
  try {
    startup = startAlexServer();
    const app = await startup;
    if (!stopping) console.log(`Alex，智能外贸助手已启动，端口 ${app.runtime.port}。数据目录：${app.dataDir}`);
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? 'Alex 端口已被占用；请停止旧进程或设置其他 ALEX_PORT。' : String(error.message));
    process.exitCode = 1;
  }
}
