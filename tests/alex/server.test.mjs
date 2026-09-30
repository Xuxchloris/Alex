import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAlexServer } from '../../apps/alex/server.mjs';
import { restoreBackup } from '../../scripts/alex-backup.mjs';
import { TradeStore } from '../../packages/alex-core/index.mjs';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP workbench protects records, persists user memory, and restores a consistent backup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alex-http-'));
  const app = await createAlexServer({ dataDir: join(directory, 'data'), allowLocalTest: true, llm: { apiKey: '' } });
  const base = await listen(app.server);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const call = async (path, value) => {
    const response = await fetch(`${base}${path}`, { method: value === undefined ? 'GET' : 'POST', headers: { 'X-Alex-Token': app.token, 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { response, data: await response.json() };
  };
  assert.equal((await fetch(`${base}/api/companies`)).status, 401);
  assert.equal((await fetch(`${base}/api/bootstrap`, { headers: { Origin: 'https://hostile.invalid' } })).status, 403);
  const hostileHostStatus = await new Promise((resolveStatus, reject) => {
    const request = http.get(`${base}/api/bootstrap`, { headers: { Host: 'hostile.invalid' } }, response => { response.resume(); resolveStatus(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
  const bootstrap = await fetch(`${base}/api/bootstrap`);
  assert.match(bootstrap.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/u);
  assert.equal((await bootstrap.json()).token, app.token);
  assert.equal((await call('/api/profile', { facts: { product: 'Precision fasteners', market: 'Germany', customerType: 'distributors' } })).response.status, 200);
  assert.equal((await call('/api/profile')).data.facts.product, 'Precision fasteners');
  await call('/api/memories', { type: 'preference', content: 'Exclude existing customers' });
  assert.equal((await call('/api/memories')).data.length, 1);
  const backup = await call('/api/backups', {});
  assert.equal(backup.response.status, 201);
  const backups = (await call('/api/backups')).data;
  assert.equal(backups.length, 1);
  const target = join(directory, 'restored');
  restoreBackup(backups[0].directory, target);
  const restored = new TradeStore({ path: join(target, 'alex.sqlite3') });
  assert.equal(restored.getProfile().facts.product, 'Precision fasteners');
  assert.equal(restored.listMemories().length, 1);
  restored.close();
  assert.throws(() => restoreBackup(backups[0].directory, target), /空/u);
  const manifest = JSON.parse(await readFile(join(backups[0].directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
});

test('same real Chromium page supports navigation, screenshot, human takeover and enforced agent pause', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alex-session-'));
  const fixture = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Controlled browser fixture</title><button style="position:absolute;left:20px;top:20px;width:200px;height:50px" onclick="document.querySelector(\'p\').textContent=\'HUMAN CONTROL CONFIRMED\'">Continue</button><p style="margin-top:100px">Before action</p>');
  });
  const fixtureBase = await listen(fixture);
  const app = await createAlexServer({ dataDir: join(directory, 'data'), allowLocalTest: true, llm: { apiKey: '' } });
  const base = await listen(app.server);
  t.after(async () => { await app.close(); await new Promise(resolve => fixture.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const call = (path, value = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'X-Alex-Token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await call('/api/agent/browser/navigate', { url: fixtureBase })).status, 200);
  const state = app.browser.state();
  assert.match(state.url, /127\.0\.0\.1/u);
  const frame = await fetch(`${base}/api/browser/frame`, { headers: { 'X-Alex-Token': app.token } });
  assert.equal(frame.headers.get('content-type'), 'image/jpeg');
  assert.ok((await frame.arrayBuffer()).byteLength > 1000);
  assert.equal((await call('/api/browser/takeover')).status, 200);
  const blocked = await call('/api/agent/browser/action', { type: 'click', x: 100, y: 40 });
  assert.equal(blocked.status, 409);
  assert.equal((await call('/api/browser/action', { type: 'click', x: 100, y: 40 })).status, 200);
  const extracted = await app.browser.extract({ actor: 'human' });
  assert.match(extracted.text, /HUMAN CONTROL CONFIRMED/u);
  assert.equal(app.browser.state().sessionId, state.sessionId);
  assert.equal((await call('/api/browser/release')).status, 200);
  assert.equal(app.browser.state().owner, 'agent');
});
