import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AlexApiClient } from '../../services/alex-mcp/client.mjs';

const gatewayPath = fileURLToPath(new URL('../../services/alex-mcp/index.mjs', import.meta.url));
const fixtureToken = 'protocol-fixture-credential-no-real-customer-data';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'alex-mcp-contract-'));
  const tokenFile = join(directory, 'api-token');
  await writeFile(tokenFile, fixtureToken, { mode: 0o600 });
  const calls = [];
  const state = { status: 200, reply: { fixture: true }, redirect: '' };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    calls.push({ method: request.method, path: request.url, token: request.headers['x-alex-token'], body: raw ? JSON.parse(raw) : undefined });
    response.writeHead(state.status, { 'Content-Type': 'application/json', ...(state.redirect ? { Location: state.redirect } : {}) });
    response.end(JSON.stringify(state.reply));
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(async () => {
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, tokenFile, calls, state, base: `http://127.0.0.1:${server.address().port}` };
}

async function connect(t, env) {
  const errors = [];
  let stderr = '';
  const transport = new StdioClientTransport({ command: process.execPath, args: [gatewayPath], env,
    cwd: resolve(gatewayPath, '../../..'), stderr: 'pipe' });
  transport.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'alex-official-sdk-contract-test', version: '1.0.0' });
  client.onerror = error => errors.push(error.message);
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    assert.equal(errors.length, 0, 'stdio must contain only valid MCP messages');
    assert.ok(!stderr.includes(fixtureToken), 'stderr must not expose the API credential');
  });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const envelope = JSON.parse(result.content[0].text);
    assert.deepEqual(result.structuredContent, envelope);
    assert.equal(result.isError, !envelope.ok);
    return envelope;
  };
  return { client, call };
}

test('official SDK client initializes a subprocess stdio gateway and lists the shared Alex tool contract', async t => {
  const local = await fixture(t);
  const { client, call } = await connect(t, { ALEX_API_URL: local.base, ALEX_API_TOKEN_FILE: local.tokenFile });
  assert.equal(client.getServerVersion().name, 'alex-trade-assistant');
  const { tools } = await client.listTools();
  assert.equal(tools.length, 19);
  assert.equal(new Set(tools.map(tool => tool.name)).size, 19);
  const native = await readFile(new URL('../../integrations/hermes/__init__.py', import.meta.url), 'utf8');
  const nativeNames = [...native.matchAll(/^    "(alex_[^"]+)": \(/gmu)].map(match => match[1]);
  for (const name of nativeNames) assert.ok(tools.some(tool => tool.name === name), `Native ${name} is available through MCP`);
  assert.equal(nativeNames.length, 17);
  assert.ok(!tools.some(tool => /approve|review|send|bootstrap|token|restore|takeover|release/u.test(tool.name)));
  assert.ok(tools.every(tool => tool.inputSchema.type === 'object' && tool.inputSchema.additionalProperties === false));
  assert.deepEqual(local.calls, [], 'Protocol initialization/listing must not read auth or call the business service');
  const health = await call('alex_health');
  assert.equal(health.ok, true);
  assert.deepEqual(local.calls[0], { method: 'GET', path: '/api/health', token: undefined, body: undefined });
});

test('MCP calls preserve profile, task idempotency, archived customer evidence and agent browser endpoints', async t => {
  const local = await fixture(t);
  const { call } = await connect(t, { ALEX_API_URL: local.base, ALEX_API_TOKEN_FILE: local.tokenFile });
  const profile = { facts: { product: 'User-provided fixture product', market: 'User-provided fixture market' } };
  const task = { request: 'Protocol fixture request, not live discovery', criteria: { count: 2 }, idempotencyKey: 'retry-contract-key' };
  const cases = [
    ['alex_profile_get', {}, 'GET', '/api/profile', undefined],
    ['alex_profile_update', profile, 'POST', '/api/profile', profile],
    ['alex_memory_search', { query: 'prior decision' }, 'GET', '/api/memories?query=prior+decision', undefined],
    ['alex_task_create', task, 'POST', '/api/tasks', task],
    ['alex_task_resume', { taskId: 'saved-task' }, 'POST', '/api/tasks/saved-task/resume', {}],
    ['alex_task_cancel', { taskId: 'saved-task' }, 'POST', '/api/tasks/saved-task/cancel', {}],
    ['alex_customers_list', { includeArchived: true }, 'GET', '/api/companies?includeArchived=1', undefined],
    ['alex_browser_navigate', { url: 'https://example.org' }, 'POST', '/api/agent/browser/navigate', { url: 'https://example.org' }],
    ['alex_browser_action', { type: 'scroll', deltaY: 500 }, 'POST', '/api/agent/browser/action', { type: 'scroll', deltaY: 500 }],
    ['alex_browser_extract', {}, 'GET', '/api/agent/browser/extract', undefined],
  ];
  for (const [name, args, method, path, body] of cases) {
    assert.equal((await call(name, args)).ok, true);
    assert.deepEqual(local.calls.at(-1), { method, path, token: fixtureToken, body });
  }
  local.state.reply = { id: 'company-fixture', name: 'Protocol fixture only', archived: true,
    evidence: [{ url: 'https://example.org', excerpt: 'HTTP contract fixture, not real customer evidence' }] };
  const evidence = await call('alex_customer_evidence', { companyId: 'company-fixture' });
  assert.equal(local.calls.at(-1).path, '/api/companies/company-fixture');
  assert.deepEqual(evidence.result.evidence, local.state.reply.evidence);
  assert.ok(!JSON.stringify(evidence).includes(fixtureToken));
});

test('schema validation prevents arbitrary routes, credentials, workspace IDs and malformed actions before HTTP', async t => {
  const local = await fixture(t);
  const { call } = await connect(t, { ALEX_API_URL: local.base, ALEX_API_TOKEN_FILE: local.tokenFile });
  for (const key of ['token', 'path', 'workspaceId', 'actor']) {
    assert.equal((await call('alex_task_create', { request: 'fixture', [key]: 'injected' })).code, 'invalid_arguments');
  }
  assert.equal((await call('alex_task_get', { taskId: '../bootstrap' })).code, 'invalid_arguments');
  assert.equal((await call('alex_task_create', { request: 'fixture', criteria: { count: 0 } })).code, 'invalid_arguments');
  assert.equal((await call('alex_browser_action', { type: 'click' })).code, 'invalid_arguments');
  assert.equal((await call('alex_browser_action', { type: 'execute-js', text: 'fixture' })).code, 'invalid_arguments');
  assert.equal((await call('alex_approve')).code, 'unknown_tool');
  assert.deepEqual(local.calls, []);
});

test('MCP returns local configuration and human takeover errors without bootstrap or automatic retries', async t => {
  const local = await fixture(t);
  const missing = await connect(t, { ALEX_API_URL: local.base });
  assert.equal((await missing.call('alex_profile_get')).code, 'missing_token');
  assert.equal(local.calls.length, 0);
  assert.equal((await missing.call('alex_health')).ok, true);
  assert.equal(local.calls.length, 1);
  const active = await connect(t, { ALEX_API_URL: local.base, ALEX_API_TOKEN_FILE: local.tokenFile });
  local.state.status = 409;
  local.state.reply = { code: 'human_has_control', error: 'The user owns this shared browser session.' };
  const result = await active.call('alex_browser_action', { type: 'key', key: 'Enter' });
  assert.equal(result.code, 'human_has_control');
  assert.equal(local.calls.length, 2);
  assert.ok(local.calls.every(call => call.path !== '/api/bootstrap'));
});

test('direct loopback transport ignores ambient proxies, refuses remote origins and never follows redirects', async t => {
  const local = await fixture(t);
  let proxyCalls = 0;
  const proxy = http.createServer((_req, res) => { proxyCalls++; res.writeHead(500); res.end(); });
  await new Promise(resolveListen => proxy.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => proxy.close(resolveClose)));
  const proxyBase = `http://127.0.0.1:${proxy.address().port}`;
  const { call } = await connect(t, { ALEX_API_URL: local.base.replace('127.0.0.1', 'localhost'), ALEX_API_TOKEN_FILE: local.tokenFile,
    HTTP_PROXY: proxyBase, HTTPS_PROXY: proxyBase, http_proxy: proxyBase, https_proxy: proxyBase, NODE_USE_ENV_PROXY: '1' });
  assert.equal((await call('alex_profile_get')).ok, true);
  assert.equal(proxyCalls, 0);
  local.state.status = 302;
  local.state.redirect = `${proxyBase}/credential-receiver`;
  assert.equal((await call('alex_profile_get')).code, 'redirect_blocked');
  assert.equal(proxyCalls, 0);
  const remote = await connect(t, { ALEX_API_URL: 'https://example.org', ALEX_API_TOKEN_FILE: local.tokenFile });
  assert.equal((await remote.call('alex_profile_get')).code, 'invalid_api_url');
  assert.equal(local.calls.length, 2);
});

test('gateway redacts credentials from nested success/error output and reads a rotated token file internally', async t => {
  const local = await fixture(t);
  const { call } = await connect(t, { ALEX_API_URL: local.base, ALEX_DATA_DIR: local.directory });
  local.state.reply = { [fixtureToken]: { rows: [fixtureToken], text: `prefix ${fixtureToken}` } };
  const first = await call('alex_profile_get');
  assert.deepEqual(first.result['[redacted]'].rows, ['[redacted]']);
  assert.ok(!JSON.stringify(first).includes(fixtureToken));
  const rotated = 'rotated-fixture-credential-no-real-customer-data';
  await writeFile(local.tokenFile, rotated, { mode: 0o600 });
  local.state.status = 401;
  local.state.reply = { code: 'unauthorized', error: `Unexpected token echo ${rotated}` };
  const failure = await call('alex_profile_get');
  assert.equal(local.calls.at(-1).token, rotated);
  assert.equal(failure.code, 'unauthorized');
  assert.ok(failure.error.includes('[redacted]'));
  assert.ok(!JSON.stringify(failure).includes(rotated));
});

test('HTTP client bounds stalled and oversized responses and returns readable unavailable errors', async t => {
  const local = await fixture(t);
  const api = new AlexApiClient({ env: { ALEX_API_URL: local.base, ALEX_API_TOKEN_FILE: local.tokenFile }, maxResponseBytes: 16 });
  t.after(() => api.close());
  local.state.reply = { text: 'Oversized transport fixture response' };
  await assert.rejects(api.request('GET', '/api/profile'), { code: 'response_too_large' });
  const stalled = http.createServer(() => {});
  await new Promise(resolveListen => stalled.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => { stalled.closeAllConnections(); stalled.close(resolveClose); }));
  const timed = new AlexApiClient({ env: { ALEX_API_URL: `http://127.0.0.1:${stalled.address().port}`, ALEX_API_TOKEN: fixtureToken }, timeoutMs: 50 });
  t.after(() => timed.close());
  await assert.rejects(timed.request('GET', '/api/profile'), { code: 'api_timeout' });
  const unavailable = await connect(t, { ALEX_API_URL: 'http://127.0.0.1:1', ALEX_API_TOKEN: fixtureToken });
  assert.equal((await unavailable.call('alex_profile_get')).code, 'api_unavailable');
});
