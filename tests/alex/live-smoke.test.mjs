import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/alex-live-smoke.mjs', import.meta.url));
const token = 'controlled-transport-token-not-a-real-secret';

// Real loopback HTTP fixtures verify CLI transport, not customer discovery.
async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

function invoke(base, proxy) {
  return run(process.execPath, ['--use-env-proxy', script, '--request', 'Controlled local API transport verification', '--urls', 'https://transport-fixture.test'], {
    timeout: 10_000,
    env: { ...process.env, ALEX_API_URL: base, ALEX_API_TOKEN: token, HTTP_PROXY: proxy, http_proxy: proxy, HTTPS_PROXY: proxy, https_proxy: proxy, ALL_PROXY: proxy, all_proxy: proxy, NO_PROXY: '', no_proxy: '' },
  });
}

test('live verification CLI connects directly to loopback despite HTTP_PROXY and never prints its token', async t => {
  let proxyCalls = 0;
  const proxy = await fixture(t, (_req, res) => { proxyCalls++; res.writeHead(502); res.end('Proxy must not receive the control request'); });
  const calls = [];
  const base = await fixture(t, (req, res) => {
    assert.equal(req.headers['x-alex-token'], token);
    calls.push([req.method, req.url]);
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.method === 'POST' ? { id: 'transport-fixture' } : { id: 'transport-fixture', status: 'completed', result: { controlEcho: token }, error: null }));
  });
  const result = await invoke(base.replace('127.0.0.1', 'localhost'), proxy);
  assert.deepEqual(calls, [['POST', '/api/tasks'], ['GET', '/api/tasks/transport-fixture']]);
  assert.equal(proxyCalls, 0);
  assert.equal((result.stdout + result.stderr).includes(token), false);
  assert.match(result.stdout, /\[redacted\]/u);
});

test('live verification CLI rejects redirects without forwarding the local token', async t => {
  let destinationCalls = 0;
  const destination = await fixture(t, (_req, res) => { destinationCalls++; res.end('{}'); });
  const base = await fixture(t, (req, res) => {
    assert.equal(req.headers['x-alex-token'], token);
    req.resume();
    res.writeHead(302, { Location: `${destination}/receive-credential` });
    res.end(JSON.stringify({ error: token }));
  });
  await assert.rejects(invoke(base, destination), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /重定向已阻止/u);
    assert.equal((error.stdout + error.stderr).includes(token), false);
    return true;
  });
  assert.equal(destinationCalls, 0);
});

test('live verification CLI redacts an accidental credential echo in an API error', async t => {
  const base = await fixture(t, (req, res) => {
    req.resume();
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Control API rejected ${token}` }));
  });
  await assert.rejects(invoke(base, base), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /\[redacted\]/u);
    assert.equal((error.stdout + error.stderr).includes(token), false);
    return true;
  });
});

test('live verification CLI does not include raw credential text in JSON parse errors', async t => {
  const base = await fixture(t, (req, res) => { req.resume(); res.end(token); });
  await assert.rejects(invoke(base, base), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /无效 JSON/u);
    assert.equal((error.stdout + error.stderr).includes(token.slice(0, 18)), false);
    return true;
  });
});
