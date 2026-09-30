import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TradeStore } from '../../packages/alex-core/index.mjs';
import { ResearchRunner } from '../../services/alex-research/index.mjs';
import { ConversationService } from '../../services/alex-conversation/index.mjs';

const PROFILE = { product: '精密轴承', market: '德国', customerType: '分销商' };
const proposal = (extra = {}) => ({ criteria: { ...PROFILE, count: 3 }, missing: [], questions: [], profileUpdates: {}, profileEvidence: {}, plan: ['读取已有客户档案，搜索并核验真实公司官网'], ...extra });

async function modelServer(t, respond) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let content = '';
    for await (const chunk of request) content += chunk;
    const body = JSON.parse(content);
    const payload = JSON.parse(body.messages[1].content);
    requests.push({ body, payload });
    const value = await respond(payload, requests.length);
    if (response.destroyed) return;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, llm: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'controlled-model', apiKey: 'fixture-model-key' } };
}

function fixture(t, { path = ':memory:', workspaceId = 'local', llm = {} } = {}) {
  const store = new TradeStore({ path, workspaceId, allowLocalTest: true });
  const browser = { state: () => ({ owner: 'agent' }), inspect: () => { throw new Error('Conversation must never browse'); } };
  const runner = new ResearchRunner({ store, browser, llm });
  const conversation = new ConversationService({ store, runner });
  t.after(async () => { await conversation.close(); store.close(); });
  return { store, runner, service: conversation };
}

test('unconfigured model archives the real user turn across restart without fabricating an assistant or task', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alex-chat-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'alex.sqlite3');
  const { store, service } = fixture(t, { path });
  const chat = store.createConversation();
  const sent = await service.send(chat.id, { content: '我是做精密轴承的，帮我了解获客怎么开始', idempotencyKey: 'first-message' });
  assert.equal(sent.status, 'unavailable');
  assert.equal(sent.code, 'model_unavailable');
  assert.equal(sent.assistantMessage, null);
  assert.equal(store.listMessages(chat.id).length, 1);
  assert.equal(store.listTasks().length, 0);
  assert.equal(store.getProfile().version, 0);
  await service.close(); store.close();
  const reopened = new TradeStore({ path }); t.after(() => reopened.close());
  assert.equal(reopened.listConversations()[0].messageCount, 1);
  assert.equal(reopened.listMessages(chat.id)[0].content, sent.userMessage.content);
  assert.equal(reopened.listConversations()[0].title, sent.userMessage.content);
});

test('multi-turn planning reads actual memory and prior proposal; temporary criteria remain conversation context', async t => {
  const model = await modelServer(t, (payload, turn) => {
    if (turn === 1) return proposal({ criteria: { product: '精密轴承', count: 3 }, missing: ['market', 'customerType'], questions: ['希望开发哪个国家或地区？', '希望寻找什么类型的客户？'] });
    assert.equal(payload.request, '这次先找德国分销商，3 家');
    assert.equal(payload.history[0].role, 'user');
    assert.equal(payload.history[0].content, '我的产品是精密轴承');
    assert.equal(payload.history[1].role, 'assistant');
    assert.equal(payload.previousCriteria.product, '精密轴承');
    assert.equal(payload.memories[0].content, '优先公开商务联系方式');
    return proposal();
  });
  const { store, service } = fixture(t, { llm: model.llm });
  store.addMemory({ type: 'preference', content: '优先公开商务联系方式' });
  const chat = store.createConversation();
  const first = await service.send(chat.id, { content: '我的产品是精密轴承' });
  assert.equal(first.status, 'needs_input');
  assert.match(first.assistantMessage.content, /哪个国家/u);
  const second = await service.send(chat.id, { content: '这次先找德国分销商，3 家' });
  assert.equal(second.status, 'ready');
  assert.deepEqual(second.plan.criteria, { ...PROFILE, count: 3 });
  assert.equal(second.assistantMessage.replyTo, second.userMessage.id);
  assert.match(second.assistantMessage.content, /方案尚未执行/u);
  assert.equal(store.listMessages(chat.id).length, 4);
  assert.deepEqual(store.getProfile().facts, {});
  assert.equal(store.listTasks().length, 0);
});

test('only explicit current permanent quotes update profile; references and counts come from actual records', async t => {
  const remember = '长期记住：产品精密轴承，目标市场德国，客户类型分销商';
  const model = await modelServer(t, payload => {
    assert.equal(payload.savedRecords.companyCount, 1);
    assert.equal(payload.savedRecords.companies[0].archived, true);
    assert.equal(payload.savedRecords.tasks[0].request, '真实已存档的历史任务');
    return proposal({ profileUpdates: PROFILE, profileEvidence: Object.fromEntries(Object.keys(PROFILE).map(key => [key, remember])) });
  });
  const { store, service } = fixture(t, { llm: model.llm });
  const task = store.createTask({ request: '真实已存档的历史任务' });
  const customer = store.upsertCompany({ name: 'Controlled fixture business', website: 'http://127.0.0.1:35101/company', evidence: [{ url: 'http://127.0.0.1:35101/company', excerpt: 'Controlled local business fixture' }] }).company;
  store.archiveCompany(customer.id);
  const chat = store.createConversation();
  const result = await service.send(chat.id, { content: remember });
  assert.equal(result.status, 'ready');
  assert.deepEqual(store.getProfile().facts, PROFILE);
  assert.equal(store.getProfile().version, 1);
  assert.deepEqual(result.assistantMessage.references, { taskIds: [task.id], companyIds: [customer.id] });
  assert.match(result.assistantMessage.content, /共 1 家（归档 1 家）/u);
  assert.match(result.assistantMessage.content, /已按本次明确要求保存长期资料/u);
  assert.equal(store.listTasks().length, 1);
});

test('historical and temporary quotes cannot write permanent profile despite malicious model output', async t => {
  let mode = 'history';
  const historical = '长期记住目标市场德国';
  const model = await modelServer(t, () => proposal({ profileUpdates: { market: '德国' }, profileEvidence: { market: mode === 'history' ? historical : '这次只找德国' } }));
  const { store, service } = fixture(t, { llm: model.llm });
  const chat = store.createConversation();
  store.appendMessage(chat.id, { role: 'user', content: historical });
  const result = await service.send(chat.id, { content: '继续上次的方案' });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'invalid_plan');
  assert.equal(result.assistantMessage, null);
  assert.equal(store.getProfile().version, 0);
  mode = 'temporary';
  const temporary = await service.send(chat.id, { content: '这次只找德国' });
  assert.equal(temporary.status, 'failed');
  assert.equal(store.getProfile().version, 0);
  assert.equal(store.listMemories().length, 0);
  assert.equal(store.listMessages(chat.id).filter(message => message.role === 'assistant').length, 0);
});

test('only user-supplied history URLs authorize a later proposal; assistant and invented URLs are rejected', async t => {
  const url = 'https://controlled-company.test/';
  const model = await modelServer(t, () => proposal({ criteria: { ...PROFILE, urls: [url], count: 1 } }));
  const { runner } = fixture(t, { llm: model.llm });
  const accepted = await runner.plan('继续核验这个官网', { history: [{ role: 'user', content: `我想核验 ${url}` }], previousCriteria: { ...PROFILE, urls: [url], count: 1 } });
  assert.deepEqual(accepted.criteria.urls, [url]);
  await assert.rejects(() => runner.plan('继续核验这个官网', { history: [{ role: 'assistant', content: `建议核验 ${url}` }], previousCriteria: { ...PROFILE, urls: [url], count: 1 } }), { code: 'invalid_plan' });
  await assert.rejects(() => runner.plan('继续核验这个官网', { history: [{ role: 'user', content: '没有提供官网' }] }), { code: 'invalid_plan' });
});

test('remembering this task or explicitly declining memory does not authorize a permanent update', async t => {
  const model = await modelServer(t, payload => proposal({ profileUpdates: { market: '德国' }, profileEvidence: { market: payload.request } }));
  const { store, service } = fixture(t, { llm: model.llm });
  const chat = store.createConversation();
  for (const content of ['记住这次只找德国', '不要长期记住市场德国']) {
    const result = await service.send(chat.id, { content });
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'invalid_plan');
    assert.equal(result.assistantMessage, null);
  }
  assert.equal(store.getProfile().version, 0);
  assert.equal(store.listMemories().length, 0);
});

test('a model cannot crop negation or temporary prefixes from a quote to overwrite permanent memory', async t => {
  const cases = [
    { request: '不要长期记住市场德国', quote: '长期记住市场德国' },
    { request: '这次记住市场德国', quote: '记住市场德国' },
    { request: '临时记住市场德国', quote: '记住市场德国' },
  ];
  const model = await modelServer(t, payload => proposal({ profileUpdates: { market: '德国' }, profileEvidence: { market: cases.find(item => item.request === payload.request).quote } }));
  const { store, service } = fixture(t, { llm: model.llm });
  store.saveProfile({ market: '加拿大' });
  const chat = store.createConversation();
  for (const item of cases) {
    assert.ok(item.request.includes(item.quote));
    const result = await service.send(chat.id, { content: item.request });
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'invalid_plan');
    assert.equal(result.assistantMessage, null);
    assert.equal(store.getProfile().facts.market, '加拿大');
    assert.equal(store.getProfile().version, 1);
  }
  assert.equal(store.listMemories().length, 0);
});

test('concurrent turns serialize complete history and profile writes; duplicate retries return the archived reply', async t => {
  let startFirst, releaseFirst;
  const started = new Promise(resolve => { startFirst = resolve; });
  const hold = new Promise(resolve => { releaseFirst = resolve; });
  const remember = '长期记住产品精密轴承';
  const model = await modelServer(t, async (payload, turn) => {
    if (turn === 1) {
      startFirst(); await hold;
      return proposal({ profileUpdates: { product: '精密轴承' }, profileEvidence: { product: remember } });
    }
    assert.equal(payload.savedProfile.product, '精密轴承');
    assert.deepEqual(payload.history.map(message => message.role), ['user', 'assistant']);
    return proposal();
  });
  const { store, service } = fixture(t, { llm: model.llm });
  const chat = store.createConversation();
  const first = service.send(chat.id, { content: remember, idempotencyKey: 'turn-1' });
  await started;
  const duplicate = service.send(chat.id, { content: remember, idempotencyKey: 'turn-1' });
  assert.equal(duplicate, first);
  await assert.rejects(service.send(chat.id, { content: '不同请求', idempotencyKey: 'turn-1' }), { code: 'idempotency_conflict' });
  const second = service.send(chat.id, { content: '先找三家德国分销商', idempotencyKey: 'turn-2' });
  assert.equal(model.requests.length, 1);
  releaseFirst();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 'ready'); assert.equal(b.status, 'ready');
  assert.deepEqual(store.listMessages(chat.id).map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(store.getProfile().version, 1);
  const retried = await service.send(chat.id, { content: remember, idempotencyKey: 'turn-1' });
  assert.equal(retried.assistantMessage.id, a.assistantMessage.id);
  assert.equal(model.requests.length, 2);
  assert.equal(store.listMessages(chat.id).length, 4);
});

test('shutdown aborts model planning, drains accepted user messages, and never writes fake replies or preference changes', async t => {
  let signalStarted, release;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const remember = '长期记住产品精密轴承';
  const model = await modelServer(t, async () => {
    signalStarted(); await hold;
    return proposal({ profileUpdates: { product: '精密轴承' }, profileEvidence: { product: remember } });
  });
  const { store, service } = fixture(t, { llm: model.llm });
  const chat = store.createConversation();
  const first = service.send(chat.id, { content: remember });
  await started;
  const queued = service.send(chat.id, { content: '这是关闭前已经提交的第二条消息' });
  await service.close();
  release();
  assert.equal((await first).assistantMessage, null);
  assert.equal((await queued).code, 'service_closed');
  assert.deepEqual(store.listMessages(chat.id).map(message => message.role), ['user', 'user']);
  assert.equal(store.getProfile().version, 0);
  await assert.rejects(service.send(chat.id, { content: '新的请求' }), { code: 'service_closed' });
});

test('conversation backup preserves proposals and messages; workspace isolation includes empty conversations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alex-chat-backup-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const { store } = fixture(t, { path: join(directory, 'alex.sqlite3'), workspaceId: 'A' });
  const chat = store.createConversation({ title: '保存的获客方案' });
  const user = store.appendMessage(chat.id, { role: 'user', content: '精密轴承德国分销商', idempotencyKey: 'message-1' });
  const assistant = store.appendMessage(chat.id, { role: 'assistant', replyTo: user.id, content: '这是尚未执行的方案', status: 'ready', plan: { status: 'ready', criteria: { ...PROFILE, count: 3 } }, idempotencyKey: 'reply-1' });
  const snapshot = await store.backup(join(directory, 'backups'));
  assert.equal(snapshot.counts.conversations, 1);
  assert.equal(snapshot.counts.messages, 2);
  const restoredPath = join(directory, 'restored.sqlite3');
  await copyFile(join(snapshot.directory, snapshot.database.file), restoredPath);
  const restored = new TradeStore({ path: restoredPath, workspaceId: 'A' }); t.after(() => restored.close());
  assert.equal(restored.getConversation(chat.id).title, '保存的获客方案');
  assert.equal(restored.listMessages(chat.id)[1].id, assistant.id);
  assert.deepEqual(restored.listMessages(chat.id)[1].plan.criteria, { ...PROFILE, count: 3 });
  const other = new TradeStore({ path: join(directory, 'alex.sqlite3'), workspaceId: 'B' }); t.after(() => other.close());
  assert.deepEqual(other.listConversations(), []);
  assert.throws(() => other.listMessages(chat.id), { code: 'not_found' });
  assert.throws(() => other.appendMessage(chat.id, { role: 'user', content: 'Cannot cross workspace' }), { code: 'not_found' });
  other.createConversation({ title: 'Private empty conversation' });
  await assert.rejects(() => store.backup(join(directory, 'mixed-backups')), { code: 'backup_scope_conflict' });
});

test('messages validate inputs, scoped references, reply targets and persistent idempotency', async t => {
  const { store, service } = fixture(t);
  const chat = store.createConversation();
  await assert.rejects(service.send(chat.id, { content: 'x'.repeat(12_001) }), { code: 'invalid_request' });
  await assert.rejects(service.send(chat.id, { content: '' }), { code: 'invalid_request' });
  const first = store.appendMessage(chat.id, { role: 'user', content: 'Stable turn', idempotencyKey: 'stable' });
  assert.equal(store.appendMessage(chat.id, { role: 'user', content: 'Stable turn', idempotencyKey: 'stable' }).id, first.id);
  assert.throws(() => store.appendMessage(chat.id, { role: 'user', content: 'Changed turn', idempotencyKey: 'stable' }), { code: 'idempotency_conflict' });
  assert.throws(() => store.appendMessage(chat.id, { role: 'assistant', content: 'Invalid reference', references: { taskIds: ['missing'] } }), { code: 'not_found' });
  const another = store.createConversation();
  assert.throws(() => store.appendMessage(another.id, { role: 'assistant', content: 'Invalid reply', replyTo: first.id }), { code: 'not_found' });
  assert.throws(() => store.listMessages(chat.id, { limit: 10000 }), { code: 'validation_error' });
  assert.equal(store.getConversation(chat.id).messageCount, 1);
});
