import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAlexServer, startAlexServer } from '../../apps/alex/server.mjs';
import { acquireDataLock, isLocalPeer, readRuntimeConfig } from '../../apps/alex/runtime.mjs';
import { BrowserController } from '../../services/alex-browser/index.mjs';
import { checkApi, localHealthUrl, runDoctor } from '../../scripts/alex-doctor.mjs';

function stubBrowser() {
  let closes = 0;
  return { start: async () => {}, close: async () => { closes++; }, state: () => ({ owner: 'agent', available: false }), get closes() { return closes; } };
}
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('invalid runtime configuration fails before allocating data or browser resources', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alex-invalid-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const browser = stubBrowser();
  for (const port of ['0', '-1', '65536', 'NaN', '3.2', '1e3', '']) {
    await assert.rejects(createAlexServer({ dataDir: join(directory, 'data'), browser, env: { ALEX_PORT: port } }), { code: 'invalid_port' });
  }
  assert.deepEqual(await readdir(directory), []);
  assert.equal(browser.closes, 0);
  assert.throws(() => readRuntimeConfig({ ALEX_BIND_HOST: 'public.invalid' }), { code: 'invalid_bind_host' });
  assert.throws(() => readRuntimeConfig({ ALEX_LOCAL_PROXY_IP: '172.29.241.0/24' }), { code: 'invalid_local_proxy' });
  assert.throws(() => readRuntimeConfig({ ALEX_LOCAL_PROXY_IP: '8.8.8.8' }), { code: 'invalid_local_proxy' });
});

test('occupied port startup cleans browser/store/lock and repeated close is safe', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alex-occupied-runtime-'));
  const occupied = http.createServer((_req, res) => res.end('occupied'));
  const base = await listen(occupied);
  t.after(async () => { await new Promise(resolve => occupied.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const browser = new BrowserController({ dataDir: join(directory, 'browser') });
  const options = { dataDir: directory, browser, llm: { apiKey: '' }, env: { ALEX_PORT: new URL(base).port } };
  await assert.rejects(startAlexServer(options), { code: 'EADDRINUSE' });
  assert.equal(browser.context, null);
  assert.equal(browser.page, null);
  const restarted = await createAlexServer({ ...options, browser: stubBrowser() });
  await Promise.all([restarted.close(), restarted.close()]);
  assert.equal(restarted.browser.closes, 1);
});

test('data directory lock blocks duplicate recover and permits restart after orderly shutdown', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alex-lock-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await createAlexServer({ dataDir: directory, browser: stubBrowser(), llm: { apiKey: '' } });
  const task = first.store.createTask({ request: 'Controlled runtime task', criteria: {} });
  first.store.updateTask(task.id, { status: 'running' });
  await assert.rejects(createAlexServer({ dataDir: directory, browser: stubBrowser() }), { code: 'data_directory_locked' });
  assert.equal(first.store.getTask(task.id).status, 'running');
  await first.close();
  const second = await createAlexServer({ dataDir: directory, browser: stubBrowser(), llm: { apiKey: '' } });
  assert.equal(second.store.getTask(task.id).status, 'paused');
  await second.close();
});

test('kernel lock releases after a crashed parent without deleting the lock inode', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alex-crash-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const module = new URL('../../apps/alex/runtime.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {acquireDataLock} from ${JSON.stringify(module)};await acquireDataLock(${JSON.stringify(directory)});console.log('ready');`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error('child failed')); }); });
  await assert.rejects(acquireDataLock(directory), { code: 'data_directory_locked' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  await new Promise(resolve => setTimeout(resolve, 150));
  const lock = await acquireDataLock(directory);
  await lock.release();
});

test('doctor checks local API without environment proxy or redirect and never reports secrets', async t => {
  let redirectTargetCalls = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') { res.writeHead(302, { Location: '/secret-target' }); return res.end(); }
    redirectTargetCalls++; res.end('{}');
  });
  const base = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal((await checkApi(base)).status, 'error');
  assert.equal((await checkApi(base.replace('127.0.0.1', 'localhost'))).detail.includes('302'), true);
  assert.equal(redirectTargetCalls, 0);
  for (const address of ['http://10.1.2.3:3210', 'http://169.254.169.254', 'http://public.invalid', 'http://localhost.evil.invalid', 'http://user:secret@127.0.0.1:3210', 'http://127.0.0.1:3210/arbitrary']) assert.throws(() => localHealthUrl(address));
  const report = await runDoctor({ env: { ALEX_PORT: new URL(base).port, ALEX_LLM_API_KEY: 'MODEL_SECRET_DO_NOT_PRINT', ALEX_API_TOKEN: 'TOKEN_SECRET_DO_NOT_PRINT', HTTPS_PROXY: 'http://PROXY_SECRET_DO_NOT_PRINT' } });
  assert.equal(report.ok, false);
  assert.equal(JSON.stringify(report).includes('SECRET_DO_NOT_PRINT'), false);
  assert.equal(isLocalPeer('8.8.8.8', '172.29.241.1'), false);
  assert.equal(isLocalPeer('::ffff:172.29.241.1', '172.29.241.1'), true);
  assert.equal(isLocalPeer('::ffff:127.0.0.1'), true);
});

test('doctor recognizes the official Playwright Chrome for Testing version output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alex-doctor-browser-'));
  const executable = join(directory, 'chrome');
  await writeFile(executable, "#!/bin/sh\nprintf 'Google Chrome for Testing 153.0.8010.12\\n'\n", { mode: 0o700 });
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ ok: true, product: 'Alex' })));
  const base = await listen(server);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const report = await runDoctor({ env: { ALEX_CHROMIUM_PATH: executable }, url: base });
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.find(check => check.name === 'chromium'), {
    name: 'chromium', status: 'ok', detail: 'Chromium 153.0.8010.12',
  });
});

test('conversation HTTP routes require authentication and retain messages after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alex-conversation-http-'));
  const runner = { plan: async () => ({ status: 'ready', criteria: { product: 'Controlled fixture product', market: 'Controlled fixture market', customerType: 'distributors', count: 5 }, missing: [], questions: [], profileUpdates: {}, plan: ['Controlled fixture plan'] }), pause: async () => {} };
  let app = await createAlexServer({ dataDir: directory, browser: stubBrowser(), runner, llm: { apiKey: '' } });
  const base = await listen(app.server);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await fetch(`${base}/api/conversations`)).status, 401);
  const call = (path, value) => fetch(`${base}${path}`, { method: value ? 'POST' : 'GET', headers: { 'X-Alex-Token': app.token, 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) });
  const conversation = await (await call('/api/conversations', { title: 'Runtime conversation fixture' })).json();
  const input = { content: 'Controlled fixture request', idempotencyKey: 'same-user-message' };
  const first = await (await call(`/api/conversations/${conversation.id}/messages`, input)).json();
  await call(`/api/conversations/${conversation.id}/messages`, input);
  assert.ok(first.userMessage);
  assert.equal((await (await call(`/api/conversations/${conversation.id}/messages`)).json()).length, 2);
  await app.close();
  app = await createAlexServer({ dataDir: directory, browser: stubBrowser(), runner, llm: { apiKey: '' } });
  assert.equal(app.store.getConversation(conversation.id).title, 'Runtime conversation fixture');
  assert.equal(app.store.listMessages(conversation.id).length, 2);
});

test('losing the isolated lock helper during slow browser startup fails closed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alex-startup-lock-loss-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let heldLock;
  let helperExited, notifiedAfterLoss = false;
  const browser = stubBrowser();
  browser.start = async () => {
    process.kill(heldLock.pid, 'SIGTERM');
    for (let attempts = 0; attempts < 100 && heldLock.isHeld(); attempts++) await new Promise(resolve => setTimeout(resolve, 10));
    helperExited = !heldLock.isHeld();
  };
  await assert.rejects(createAlexServer({ dataDir: directory, browser, llm: { apiKey: '' }, acquireLock: async path => {
    heldLock = await acquireDataLock(path);
    const onLost = heldLock.onLost.bind(heldLock);
    heldLock.onLost = callback => onLost(() => { notifiedAfterLoss = true; callback(); });
    return heldLock;
  } }), { code: 'data_lock_lost' });
  assert.equal(helperExited, true);
  assert.equal(notifiedAfterLoss, true);
  assert.ok(browser.closes >= 1);
  const restarted = await createAlexServer({ dataDir: directory, browser: stubBrowser(), llm: { apiKey: '' } });
  await restarted.close();
});
