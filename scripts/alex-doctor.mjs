import http from 'node:http';
import https from 'node:https';
import { constants, accessSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { readRuntimeConfig } from '../apps/alex/runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function localHealthUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('API 地址必须为本机 HTTP(S) 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['/', '/api/health'].includes(url.pathname)) {
    throw new Error('doctor 仅检查回环 API，不允许代理、凭据或其他网址。');
  }
  url.pathname = '/api/health';
  return url;
}
export async function checkApi(value, { timeout = 4000 } = {}) {
  const url = localHealthUrl(value);
  // Use the native client with a fixed loopback resolver: env proxy and redirects are never used.
  return new Promise(resolveCheck => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      agent: false,
      lookup: (_host, options, callback) => {
        const address = url.hostname === '[::1]' ? '::1' : '127.0.0.1';
        const family = url.hostname === '[::1]' ? 6 : 4;
        callback(null, options?.all ? [{ address, family }] : address, family);
      },
    }, response => {
      let size = 0, text = '';
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) { response.destroy(); resolveCheck({ status: 'error', detail: 'API 返回内容过大。' }); }
        else text += chunk;
      });
      response.on('end', () => {
        if (response.statusCode !== 200) return resolveCheck({ status: 'error', detail: `API HTTP ${response.statusCode}，未跟随重定向。` });
        try {
          const body = JSON.parse(text);
          if (body.ok !== true || body.product !== 'Alex') throw new Error();
          resolveCheck({ status: 'ok', detail: '本机 Alex API 已就绪。', capabilities: {
            browserAvailable: body.capabilities?.browserAvailable === true,
            modelConfigured: body.capabilities?.modelConfigured === true,
            discoveryStatus: String(body.capabilities?.discoveryStatus || 'unknown').slice(0, 80),
          } });
        } catch { resolveCheck({ status: 'error', detail: '本机端口未返回有效 Alex 健康状态。' }); }
      });
      response.on('error', () => resolveCheck({ status: 'error', detail: 'API 响应中断。' }));
    });
    request.setTimeout(timeout, () => request.destroy(new Error('timeout')));
    request.on('error', () => resolveCheck({ status: 'error', detail: '本机 API 无法连接；请先启动 Alex 并核对端口。' }));
  });
}
export async function runDoctor({ env = process.env, url, healthOnly = false } = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  let runtime;
  try { runtime = readRuntimeConfig(env); add('configuration', 'ok', '端口、绑定与本机代理配置有效。'); }
  catch (error) { add('configuration', 'error', error.message); }
  if (!healthOnly) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    add('node', major > 24 || (major === 24 && minor >= 5) ? 'ok' : 'error', `Node ${process.versions.node}；需要 >=24.5.0。`);
    const flock = spawnSync('flock', ['--version'], { timeout: 3000, encoding: 'utf8' });
    add('process_lock', flock.status === 0 ? 'ok' : 'error', flock.status === 0 ? 'flock 可用，数据目录可使用进程锁。' : '缺少 flock；请使用 Linux/WSL2（util-linux）或 Docker。');
    const executable = env.ALEX_CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync) || chromium.executablePath();
    const browser = spawnSync(executable, ['--version'], { timeout: 5000, encoding: 'utf8' });
    const browserVersion = String(browser.stdout || '').match(/\b(?:Chromium|Google Chrome|Chrome) ([\d.]+)/);
    add('chromium', browser.status === 0 && browserVersion ? 'ok' : 'error', browser.status === 0 && browserVersion ? `Chromium ${browserVersion[1]}` : 'Chromium 无法执行或版本无效；安装系统 Chromium 或设置 ALEX_CHROMIUM_PATH。');
    const directory = resolve(env.ALEX_DATA_DIR || join(root, 'work/alex'));
    try {
      if (existsSync(directory) && !statSync(directory).isDirectory()) throw new Error();
      let parent = directory;
      while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
      accessSync(parent, constants.R_OK | constants.W_OK | constants.X_OK);
      add('data_directory', 'ok', existsSync(directory) ? '数据目录存在且可读写；doctor 未修改数据。' : '数据目录尚不存在，父目录允许首次启动创建。');
    } catch { add('data_directory', 'error', '数据目录不可读写；请检查目录类型与权限。'); }
    const configured = Boolean(env.ALEX_LLM_API_KEY);
    add('model_configuration', configured ? 'ok' : 'warning', configured ? '模型密钥已设置；未显示密钥，未验证模型网络或额度。' : '未设置 ALEX_LLM_API_KEY；记忆与客户工作台可用，模型规划暂不可用。');
  }
  let api;
  try { api = await checkApi(url || `http://127.0.0.1:${runtime?.port || 3210}/api/health`); }
  catch (error) { api = { status: 'error', detail: error.message }; }
  add('api', api.status, api.detail);
  if (!healthOnly && api.status === 'ok') {
    add('browser_runtime', api.capabilities.browserAvailable ? 'ok' : 'warning', api.capabilities.browserAvailable ? '运行中的 Chromium 已启动。' : 'API 可用，但 Chromium 未启动；查看服务日志与系统依赖。');
    add('source_network', 'warning', '公网数据源未由 doctor 验证；请运行 smoke:live。网络阻断时不会返回合成客户。');
  }
  return { ok: checks.every(check => check.status !== 'error'), checks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const supported = args.every((arg, index) => ['--json', '--health-only', '--url'].includes(arg) || args[index - 1] === '--url');
  if (!supported || (args.includes('--url') && !args[args.indexOf('--url') + 1])) {
    console.error('用法：npm run doctor -- [--json] [--health-only] [--url http://127.0.0.1:3210]');
    process.exitCode = 1;
  } else {
    const report = await runDoctor({ healthOnly: args.includes('--health-only'), url: args.includes('--url') ? args[args.indexOf('--url') + 1] : undefined });
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else for (const check of report.checks) console.log(`${check.status.toUpperCase()} ${check.name}: ${check.detail}`);
    process.exitCode = report.ok ? 0 : 1;
  }
}
