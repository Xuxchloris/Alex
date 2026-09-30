import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TradeStore } from '../../packages/alex-core/index.mjs';

async function database(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'alex-core-'));
  const path = join(directory, 'alex.sqlite3');
  const store = new TradeStore({ path, ...options });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, directory, path };
}
function evidence(url = 'https://metal-supplier.test/contact', extra = {}) {
  return [{ url, retrievedAt: '2026-09-30T00:00:00.000Z', excerpt: 'Observed business contact page', ...extra }];
}
function company(extra = {}) {
  return { name: 'Metal Supplier Ltd', website: 'https://metal-supplier.test', country: 'Germany', contacts: [{ type: 'phone', value: '+49 234 567890' }], evidence: evidence(), source: 'browser', ...extra };
}

test('profile merges explicit facts, persists versions and memory across process recreation', async t => {
  const { store, path } = await database(t);
  assert.deepEqual(store.getProfile(), { facts: {}, version: 0, updatedAt: null });
  store.saveProfile({ product: 'Machine parts', market: 'France' });
  const historical = store.createTask({ request: 'Find distributors', criteria: { count: 4 } });
  store.saveProfile({ market: 'Germany' });
  store.addMemory({ type: 'preference', content: 'Exclude existing customers', source: 'user', taskId: historical.id });
  store.close();
  const reopened = new TradeStore({ path });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.getProfile().facts, { product: 'Machine parts', market: 'Germany' });
  assert.equal(reopened.getProfile().version, 2);
  assert.equal(reopened.getProfileHistory()[0].facts.market, 'France');
  assert.equal(reopened.getTask(historical.id).profileSnapshot.market, 'France');
  assert.equal(reopened.listMemories({ query: 'existing' }).length, 1);
  assert.equal(reopened.listMemories()[0].taskId, historical.id);
});

test('idempotent task creation checks complete inputs and checkpoint recovery survives restart', async t => {
  const { store, path } = await database(t);
  const input = { request: 'Research buyer websites', criteria: { market: 'France', product: 'Tools' }, idempotencyKey: 'run-1' };
  const task = store.createTask(input);
  assert.equal(store.createTask({ ...input, criteria: { product: 'Tools', market: 'France' } }).id, task.id);
  assert.throws(() => store.createTask({ ...input, request: 'Another request' }), { code: 'idempotency_conflict' });
  assert.throws(() => store.createTask({ ...input, criteria: { product: 'Pipes' } }), { code: 'idempotency_conflict' });
  store.updateTask(task.id, { status: 'running', checkpoint: { urls: ['https://metal-supplier.test'], visited: ['https://metal-supplier.test/about'], nextIndex: 1 } });
  store.close();
  const reopened = new TradeStore({ path }); t.after(() => reopened.close());
  const recovered = reopened.recoverTasks();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, 'paused');
  assert.equal(recovered[0].checkpoint.nextIndex, 1);
  assert.deepEqual(reopened.recoverTasks(), []);
  assert.equal(reopened.updateTask(task.id, { status: 'running' }).checkpoint.nextIndex, 1);
});

test('stable random company identity deduplicates across tasks, archived records and added websites', async t => {
  const { store, path } = await database(t);
  const firstTask = store.createTask({ request: 'First search' });
  const secondTask = store.createTask({ request: 'Search again' });
  const first = store.upsertCompany(company({ website: undefined, source: 'trade-directory', sourceId: 'real-source-record-17', taskId: firstTask.id }));
  assert.equal(first.created, true);
  assert.match(first.company.id, /^[a-f0-9-]{36}$/);
  const withSite = store.upsertCompany(company({ source: 'trade-directory', sourceId: 'real-source-record-17', taskId: secondTask.id }));
  assert.equal(withSite.created, false);
  assert.equal(withSite.company.id, first.company.id);
  store.archiveCompany(first.company.id);
  assert.equal(store.listCompanies().length, 0);
  const third = store.upsertCompany(company({ website: 'https://www.metal-supplier.test/contact', taskId: secondTask.id }));
  assert.equal(third.created, false);
  assert.equal(third.company.archived, true);
  assert.equal(third.company.id, first.company.id);
  assert.deepEqual(third.company.taskIds, [firstTask.id, secondTask.id]);
  store.close();
  const reopened = new TradeStore({ path }); t.after(() => reopened.close());
  assert.equal(reopened.listCompanies({ includeArchived: true }).length, 1);
  assert.equal(reopened.upsertCompany(company()).company.id, first.company.id);
});

test('tasks waiting in the worker queue become resumable after restart', async t => {
  const { store, path } = await database(t);
  const queued = store.createTask({ request: 'Waiting for shared browser', criteria: { urls: ['https://metal-supplier.test'] } });
  store.updateTask(queued.id, { checkpoint: { candidates: [{ url: 'https://metal-supplier.test' }], stage: 'verify' } });
  store.close();
  const reopened = new TradeStore({ path }); t.after(() => reopened.close());
  const recovered = reopened.recoverTasks();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, 'paused');
  assert.equal(recovered[0].error.code, 'interrupted');
  assert.equal(recovered[0].checkpoint.stage, 'verify');
  const resumed = reopened.updateTask(queued.id, { status: 'queued', error: null });
  assert.equal(resumed.status, 'queued');
  assert.deepEqual(resumed.checkpoint.candidates, [{ url: 'https://metal-supplier.test' }]);
});

test('phone-first discovery gains a website without changing identity; shared contacts do not merge companies', async t => {
  const { store } = await database(t);
  const first = store.upsertCompany(company({ website: undefined }));
  const next = store.upsertCompany(company());
  assert.equal(next.company.id, first.company.id);
  const separate = store.upsertCompany(company({ name: 'Distinct Subsidiary', website: 'https://separate-supplier.test', contacts: [{ email: 'shared@gmail.com', phone: '+49 234 567890' }], evidence: evidence('https://separate-supplier.test') }));
  assert.notEqual(separate.company.id, first.company.id);
  assert.equal(store.listCompanies().length, 2);
});

test('public profiles and shared company websites never silently merge unlike companies', async t => {
  const { store } = await database(t);
  store.upsertCompany(company({ name: 'Company A', website: 'https://linkedin.com/company/a', contacts: [], evidence: evidence('https://linkedin.com/company/a') }));
  store.upsertCompany(company({ name: 'Company B', website: 'https://linkedin.com/company/b', contacts: [], evidence: evidence('https://linkedin.com/company/b') }));
  assert.equal(store.listCompanies().length, 2);
  const parent = store.upsertCompany(company({ name: 'Parent Company', contacts: [] }));
  assert.throws(() => store.upsertCompany(company({ name: 'Different Legal Entity', contacts: [] })), { code: 'identity_conflict' });
  assert.equal(store.getCompany(parent.company.id).name, 'Parent Company');
});

test('identity conflicts roll back all changes and require explicit review', async t => {
  const { store } = await database(t);
  const first = store.upsertCompany(company({ source: 'registry', sourceId: 'company-A' }));
  const second = store.upsertCompany(company({ name: 'Second Company', website: 'https://second-supplier.test', contacts: [], source: 'registry', sourceId: 'company-B', evidence: evidence('https://second-supplier.test') }));
  assert.throws(() => store.upsertCompany(company({ website: 'https://second-supplier.test', source: 'registry', sourceId: 'company-A' })), { code: 'identity_conflict' });
  assert.equal(store.getCompany(first.company.id).website, first.company.website);
  assert.equal(store.getCompany(second.company.id).name, second.company.name);
  assert.equal(store.listCompanies().length, 2);
});

test('missing evidence, synthetic records and production-local customer data are rejected', async t => {
  const { store } = await database(t);
  assert.throws(() => store.upsertCompany(company({ evidence: [] })), { code: 'evidence_required' });
  assert.throws(() => store.upsertCompany(company({ source: 'synthetic-demo' })), { code: 'synthetic_source' });
  assert.throws(() => store.upsertCompany(company({ website: 'https://customer.example' })), { code: 'synthetic_source' });
  assert.throws(() => store.upsertCompany(company({ evidence: evidence('https://example.com') })), { code: 'synthetic_source' });
  assert.throws(() => store.upsertCompany(company({ website: 'http://localhost:12000', evidence: evidence('http://localhost:12000') })), { code: 'invalid_source' });
  assert.equal(store.listCompanies().length, 0);
  const fixtureStore = new TradeStore({ path: ':memory:', allowLocalTest: true }); t.after(() => fixtureStore.close());
  assert.equal(fixtureStore.upsertCompany(company({ website: 'http://127.0.0.1:12000', evidence: evidence('http://127.0.0.1:12000') })).created, true);
  assert.throws(() => fixtureStore.upsertCompany(company({ website: 'https://customer.example' })), { code: 'synthetic_source' });
});

test('company unique identity works across independent database connections', async t => {
  const { store, path } = await database(t);
  const second = new TradeStore({ path }); t.after(() => second.close());
  const first = store.upsertCompany(company());
  const same = second.upsertCompany(company({ evidence: evidence('https://metal-supplier.test/about') }));
  assert.equal(same.company.id, first.company.id);
  assert.equal(same.created, false);
  assert.equal(store.listCompanies().length, 1);
  assert.equal(store.getCompany(first.company.id).evidence.length, 2);
});

test('state and version guards reject stale task workers and cancelled findings', async t => {
  const { store } = await database(t);
  const task = store.createTask({ request: 'Research task' });
  store.updateTask(task.id, { status: 'running', expectedVersion: task.version });
  assert.throws(() => store.updateTask(task.id, { status: 'paused', expectedVersion: task.version }), { code: 'version_conflict' });
  store.updateTask(task.id, { status: 'cancelled' });
  assert.throws(() => store.updateTask(task.id, { status: 'running' }), { code: 'state_conflict' });
  assert.throws(() => store.updateTask(task.id, { checkpoint: { nextIndex: 999 } }), { code: 'state_conflict' });
  assert.throws(() => store.upsertCompany(company({ taskId: task.id })), { code: 'state_conflict' });
  assert.throws(() => store.updateTask(task.id, { status: 'invented' }), { code: 'validation_error' });
});

test('draft approval binds the complete immutable payload, never sends and cannot be reversed', async t => {
  const { store } = await database(t);
  const buyer = store.upsertCompany(company()).company;
  const task = store.createTask({ request: 'Prepare outreach' });
  const draft = store.saveDraft({ companyId: buyer.id, taskId: task.id, subject: 'Product introduction', body: 'Dear purchasing team' });
  assert.equal(draft.status, 'pending');
  const reviewed = store.reviewDraft(draft.id, { status: 'approved', actor: 'local-user-session' });
  assert.equal(reviewed.reviewedPayloadHash, draft.payloadHash);
  assert.equal(reviewed.reviewedBy, 'local-user-session');
  assert.equal(store.reviewDraft(draft.id, { status: 'approved' }).id, draft.id);
  assert.throws(() => store.reviewDraft(draft.id, { status: 'rejected' }), { code: 'state_conflict' });
  assert.throws(() => store.reviewDraft(draft.id, { status: 'sent' }), { code: 'validation_error' });
  assert.equal(store.listEvents(task.id).some(event => event.type.includes('sent')), false);
  const altered = store.saveDraft({ companyId: buyer.id, taskId: task.id, subject: draft.subject, body: 'Different body' });
  assert.notEqual(altered.payloadHash, draft.payloadHash);
});

test('consistent backup restores customer IDs, archive, evidence, profile, draft and task checkpoint', async t => {
  const { store, directory } = await database(t);
  store.saveProfile({ product: 'Machine parts', customerType: 'Distributor' });
  store.addMemory({ type: 'preference', content: 'Prefer verified websites' });
  const task = store.createTask({ request: 'Research verified companies' });
  store.updateTask(task.id, { status: 'running', checkpoint: { nextIndex: 2, visited: ['https://metal-supplier.test'] } });
  const buyer = store.upsertCompany(company({ taskId: task.id })).company;
  store.archiveCompany(buyer.id);
  const draft = store.saveDraft({ companyId: buyer.id, taskId: task.id, subject: 'Introduction', body: 'Business introduction' });
  store.reviewDraft(draft.id, { status: 'approved' });
  const manifest = await store.backup(join(directory, 'backups'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.counts.companies, 1);
  assert.equal(manifest.counts.tasks, 1);
  const bytes = await readFile(join(manifest.directory, manifest.database.file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.database.sha256);
  const restoredPath = join(directory, 'restored.sqlite3');
  await copyFile(join(manifest.directory, manifest.database.file), restoredPath);
  const restored = new TradeStore({ path: restoredPath }); t.after(() => restored.close());
  assert.deepEqual(restored.getProfile().facts, store.getProfile().facts);
  assert.equal(restored.listCompanies().length, 0);
  assert.equal(restored.getCompany(buyer.id).evidence[0].url, buyer.evidence[0].url);
  assert.equal(restored.getTask(task.id).checkpoint.nextIndex, 2);
  assert.equal(restored.listDrafts()[0].reviewedPayloadHash, draft.payloadHash);
  assert.equal(restored.listMemories().length, 1);
  assert.equal(restored.upsertCompany(company()).company.id, buyer.id);
});

test('constructor workspace isolation includes event-only records and refuses mixed-workspace backup before writing', async t => {
  const { store, path, directory } = await database(t, { workspaceId: 'A' });
  const task = store.createTask({ request: 'A private task' });
  const buyer = store.upsertCompany(company()).company;
  const other = new TradeStore({ path, workspaceId: 'B' }); t.after(() => other.close());
  assert.deepEqual(other.getProfile().facts, {});
  assert.deepEqual(other.listTasks(), []);
  assert.deepEqual(other.listCompanies(), []);
  assert.throws(() => other.getTask(task.id), { code: 'not_found' });
  assert.throws(() => other.archiveCompany(buyer.id), { code: 'not_found' });
  assert.throws(() => other.addMemory({ type: 'note', content: 'Cannot attach another workspace', taskId: task.id }), { code: 'not_found' });
  other.appendEvent({ type: 'B.private_event', detail: { note: 'Private' } });
  assert.equal(store.listEvents().some(item => item.type === 'B.private_event'), false);
  const backups = join(directory, 'backups');
  await assert.rejects(() => store.backup(backups), { code: 'backup_scope_conflict' });
  await assert.rejects(() => readdir(backups), { code: 'ENOENT' });
});
