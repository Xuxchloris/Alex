import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isIP } from 'node:net';

const TASK_STATUSES = new Set(['queued', 'running', 'waiting_for_user', 'paused', 'completed', 'failed', 'blocked', 'unavailable', 'partial', 'cancelled']);
const TERMINAL = new Set(['completed', 'cancelled']);
const SHARED_HOSTS = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'aol.com', 'icloud.com', 'proton.me', 'protonmail.com', 'qq.com', '163.com', '126.com', 'google.com', 'bing.com', 'duckduckgo.com', 'linkedin.com', 'facebook.com', 'instagram.com', 'youtube.com', 'x.com', 'twitter.com', 'alibaba.com', 'made-in-china.com', 'globalsources.com', 'amazon.com', 'ebay.com', 'yellowpages.com', 'yelp.com', 'googleusercontent.com', 'github.io', 'wordpress.com', 'blogspot.com', 'wixsite.com', 'myshopify.com', 'squarespace.com', 'notion.site', 'linktr.ee'];
const now = () => new Date().toISOString();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const decode = (value) => JSON.parse(value);
function fail(message, code = 'validation_error', status = 400) {
  const error = new Error(message); error.code = code; error.status = status; throw error;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function json(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > 2_000_000) fail('Value must be JSON and less than 2 MB');
  return encoded;
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  json(value); return value;
}
function string(value, label, required = true, max = 100_000) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${label} must be a nonempty string of at most ${max} characters`);
  return value.trim();
}
function normalizedName(value) { return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim(); }
function sharedHost(host) { return SHARED_HOSTS.some((item) => host === item || host.endsWith(`.${item}`)); }
function publicUrl(value, allowLocalTest) {
  let url;
  try { url = new URL(string(value, 'Source URL', true, 8192)); } catch { fail('Source must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Source must use HTTP(S) without embedded credentials');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'example' || host.endsWith('.example') || ['example.com', 'example.net', 'example.org'].some((item) => host === item || host.endsWith(`.${item}`)) || host.endsWith('.invalid')) fail('Synthetic and reserved customer domains are not accepted', 'synthetic_source');
  const ip = host.replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') || isIP(ip);
  if (local && !allowLocalTest) fail('Local or IP customer sources require explicit fixture test configuration', 'invalid_source');
  url.hostname = host; url.hash = '';
  return url.toString();
}
function contactsOf(input) {
  if (!Array.isArray(input)) fail('contacts must be an array');
  const result = [];
  const add = (type, value, extra = {}) => {
    if (typeof value !== 'string' || !value.trim()) return;
    if (!['email', 'phone'].includes(type)) fail('Contact type must be email or phone');
    value = value.trim();
    const normalized = type === 'email' ? value.toLowerCase() : value.replace(/[^\d+]/g, '');
    if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) fail('Invalid email contact');
    if (type === 'phone' && normalized.replace(/\D/g, '').length < 6) return;
    if (type === 'email' && /@(?:[^@]*\.)?example(?:\.[a-z]+)?$/i.test(normalized)) fail('Synthetic email contacts are not accepted', 'synthetic_source');
    const record = { ...extra, type, value, normalized };
    delete record.email; delete record.phone;
    if (!result.some((item) => item.type === type && item.normalized === normalized)) result.push(record);
  };
  for (const item of input) {
    if (typeof item === 'string') add(item.includes('@') ? 'email' : 'phone', item);
    else if (item && typeof item === 'object') {
      if (item.type) add(item.type, item.value, item);
      else { add('email', item.email, item); add('phone', item.phone, item); }
    } else fail('Invalid contact');
  }
  return result;
}
function unionRecords(existing, incoming, key) {
  const map = new Map(existing.map((item) => [key(item), item]));
  for (const item of incoming) map.set(key(item), { ...map.get(key(item)), ...item });
  return [...map.values()];
}

/** Persistent business facts, scoped to a configured local workspace. Never uses model memory as storage. */
export class TradeStore {
  constructor({ path, workspaceId = 'local', allowLocalTest = false } = {}) {
    this.path = string(path, 'Database path');
    this.workspaceId = string(workspaceId, 'workspaceId', true, 200);
    this.allowLocalTest = allowLocalTest === true;
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS profiles (workspace TEXT PRIMARY KEY, facts TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS profile_history (workspace TEXT NOT NULL, version INTEGER NOT NULL, facts TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(workspace,version));
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, idem_key TEXT, input_hash TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(workspace,idem_key));
      CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS identities (workspace TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, company_id TEXT NOT NULL REFERENCES companies(id), PRIMARY KEY(workspace,kind,value));
      CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, workspace TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), idem_key TEXT, input_hash TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(workspace,conversation_id,idem_key));
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, workspace TEXT NOT NULL, task_id TEXT, record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companies_workspace ON companies(workspace);
      CREATE INDEX IF NOT EXISTS tasks_workspace ON tasks(workspace);
      CREATE INDEX IF NOT EXISTS events_task ON events(workspace,task_id,sequence);
      CREATE INDEX IF NOT EXISTS conversations_workspace ON conversations(workspace);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(workspace,conversation_id,sequence);
      PRAGMA user_version=2;`);
    this.closed = false;
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getProfile() {
    const row = this.db.prepare('SELECT * FROM profiles WHERE workspace=?').get(this.workspaceId);
    return row ? { facts: decode(row.facts), version: row.version, updatedAt: row.updated_at } : { facts: {}, version: 0, updatedAt: null };
  }
  getProfileHistory() {
    return this.db.prepare('SELECT * FROM profile_history WHERE workspace=? ORDER BY version').all(this.workspaceId).map((row) => ({ facts: decode(row.facts), version: row.version, source: row.source, updatedAt: row.updated_at }));
  }
  saveProfile(facts, { source = 'user' } = {}) {
    object(facts, 'facts'); string(source, 'source');
    return this.transaction(() => {
      const previous = this.getProfile();
      const result = { facts: { ...previous.facts, ...facts }, version: previous.version + 1, updatedAt: now() };
      this.db.prepare('INSERT INTO profiles VALUES(?,?,?,?) ON CONFLICT(workspace) DO UPDATE SET facts=excluded.facts,version=excluded.version,updated_at=excluded.updated_at').run(this.workspaceId, json(result.facts), result.version, result.updatedAt);
      this.db.prepare('INSERT INTO profile_history VALUES(?,?,?,?,?)').run(this.workspaceId, result.version, json(result.facts), source, result.updatedAt);
      this.appendEvent({ type: 'profile.updated', detail: { version: result.version, source, keys: Object.keys(facts) } });
      return result;
    });
  }
  addMemory({ type, content, source = 'user', taskId } = {}) {
    string(type, 'type', true, 100); string(content, 'content'); string(source, 'source', true, 200);
    if (taskId) this.getTask(taskId);
    const record = { id: randomUUID(), type, content, source, taskId: taskId || null, version: 1, status: 'active', createdAt: now(), updatedAt: now() };
    this.db.prepare('INSERT INTO memories VALUES(?,?,?)').run(record.id, this.workspaceId, json(record));
    return record;
  }
  listMemories({ query = '', limit = 30 } = {}) {
    string(query, 'query', false, 10_000);
    const needle = normalizedName(query);
    return this.db.prepare('SELECT record FROM memories WHERE workspace=? ORDER BY rowid DESC').all(this.workspaceId).map((row) => decode(row.record)).filter((item) => !needle || normalizedName(`${item.type} ${item.content}`).includes(needle)).slice(0, Math.max(0, Math.min(1000, Number(limit) || 30)));
  }
  createTask({ request, criteria = {}, idempotencyKey } = {}) {
    string(request, 'request'); object(criteria, 'criteria');
    if (idempotencyKey !== undefined) string(idempotencyKey, 'idempotencyKey', true, 500);
    const inputHash = hash(canonical({ request, criteria }));
    return this.transaction(() => {
      if (idempotencyKey) {
        const existing = this.db.prepare('SELECT record,input_hash FROM tasks WHERE workspace=? AND idem_key=?').get(this.workspaceId, idempotencyKey);
        if (existing) {
          if (existing.input_hash !== inputHash) fail('Idempotency key already belongs to a different task request or criteria', 'idempotency_conflict', 409);
          return decode(existing.record);
        }
      }
      const record = { id: randomUUID(), request, criteria, idempotencyKey: idempotencyKey || null, status: 'queued', checkpoint: {}, result: null, error: null, profileVersion: this.getProfile().version, profileSnapshot: this.getProfile().facts, version: 1, createdAt: now(), updatedAt: now() };
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(record.id, this.workspaceId, idempotencyKey || null, inputHash, json(record));
      this.appendEvent({ taskId: record.id, type: 'task.created', detail: { status: 'queued' } });
      return record;
    });
  }
  getTask(id) {
    const row = this.db.prepare('SELECT record FROM tasks WHERE workspace=? AND id=?').get(this.workspaceId, string(id, 'Task ID'));
    if (!row) fail('Task not found', 'not_found', 404);
    return decode(row.record);
  }
  listTasks() { return this.db.prepare('SELECT record FROM tasks WHERE workspace=? ORDER BY rowid DESC').all(this.workspaceId).map((row) => decode(row.record)); }
  updateTask(id, patch = {}) {
    object(patch, 'Task update');
    const keys = new Set(['status', 'criteria', 'checkpoint', 'result', 'error', 'expectedVersion']);
    if (Object.keys(patch).some((key) => !keys.has(key))) fail('Unsupported task update field');
    if (patch.status && !TASK_STATUSES.has(patch.status)) fail('Unsupported task status');
    if ('criteria' in patch) object(patch.criteria, 'criteria');
    if ('checkpoint' in patch) object(patch.checkpoint, 'checkpoint');
    return this.transaction(() => {
      const record = this.getTask(id);
      if (patch.expectedVersion !== undefined && patch.expectedVersion !== record.version) fail('Task version changed', 'version_conflict', 409);
      const { expectedVersion, ...changes } = patch;
      if (TERMINAL.has(record.status)) {
        if (Object.entries(changes).every(([key, value]) => canonical(record[key]) === canonical(value))) return record;
        fail('Completed or cancelled tasks cannot be changed by a stale worker', 'state_conflict', 409);
      }
      const updated = { ...record, ...changes, version: record.version + 1, updatedAt: now() };
      this.db.prepare('UPDATE tasks SET record=? WHERE workspace=? AND id=?').run(json(updated), this.workspaceId, id);
      this.appendEvent({ taskId: id, type: 'task.updated', detail: { from: record.status, status: updated.status, version: updated.version, fields: Object.keys(changes) } });
      return updated;
    });
  }
  recoverTasks() {
    return this.listTasks().filter((task) => ['running', 'queued'].includes(task.status)).map((task) => this.updateTask(task.id, { status: 'paused', error: { code: 'interrupted', message: 'Previous process stopped; resume from the saved checkpoint' } }));
  }
  upsertCompany({ name, website, country = '', contacts = [], evidence = [], source, sourceId, taskId } = {}) {
    name = string(name, 'Company name', true, 1000);
    country = string(country, 'country', false, 200);
    if (typeof source === 'string' && /synthetic|demo|mock|fake/i.test(source)) fail('Synthetic customer sources are not accepted', 'synthetic_source');
    if (!Array.isArray(evidence) || evidence.length === 0) fail('Real company records require source evidence', 'evidence_required');
    const observed = evidence.map((item) => {
      object(item, 'evidence');
      if (typeof item.source === 'string' && /synthetic|demo|mock|fake/i.test(item.source)) fail('Synthetic customer evidence is not accepted', 'synthetic_source');
      const url = publicUrl(item.url || item.sourceUrl, this.allowLocalTest);
      const retrievedAt = item.retrievedAt || item.observedAt || now();
      if (!Number.isFinite(Date.parse(retrievedAt))) fail('Evidence timestamp must be a valid date');
      return { ...item, id: item.id || randomUUID(), url, retrievedAt, evidenceHash: hash(canonical({ url, excerpt: item.excerpt || item.text || '', fields: item.fields || {}, retrievedAt })) };
    });
    website = website ? publicUrl(website, this.allowLocalTest) : '';
    contacts = contactsOf(contacts);
    if (taskId && this.getTask(taskId).status === 'cancelled') fail('Cancelled tasks cannot persist customer findings', 'state_conflict', 409);
    const aliases = [];
    if (sourceId !== undefined) {
      source = string(source, 'source', true, 200);
      sourceId = string(sourceId, 'sourceId', true, 2000);
      aliases.push(['source', canonical({ source, sourceId })]);
    }
    const host = website ? new URL(website).hostname.replace(/^www\./, '') : '';
    if (host && !sharedHost(host)) aliases.push(['website', host]);
    // Contact identifiers alone are ambiguous. An exact supplied name+country+phone
    // can link a phone-first finding to a later website finding without name-only merges.
    if (country) {
      for (const contact of contacts) if (contact.type === 'phone') aliases.push(['name-country-phone', canonical([normalizedName(name), normalizedName(country), contact.normalized])]);
    }
    return this.transaction(() => {
      const matched = new Set();
      for (const [kind, value] of aliases) {
        const row = this.db.prepare('SELECT company_id FROM identities WHERE workspace=? AND kind=? AND value=?').get(this.workspaceId, kind, value);
        if (row) matched.add(row.company_id);
      }
      if (matched.size > 1) fail('Conflicting company identities require human review; no automatic merge performed', 'identity_conflict', 409);
      const previous = matched.size ? this.getCompany([...matched][0]) : null;
      if (previous && website && previous.website && normalizedName(previous.name) !== normalizedName(name)) {
        const oldHost = new URL(previous.website).hostname.replace(/^www\./, '');
        if (oldHost === host && !aliases.some(([kind, value]) => kind === 'source' && this.db.prepare('SELECT company_id FROM identities WHERE workspace=? AND kind=? AND value=?').get(this.workspaceId, kind, value)?.company_id === previous.id)) fail('A shared website with different company names requires human identity review', 'identity_conflict', 409);
      }
      if (previous?.country && country && normalizedName(previous.country) !== normalizedName(country)) fail('Company country conflicts with an existing identity; review required', 'identity_conflict', 409);
      if (previous?.website && website) {
        const oldHost = new URL(previous.website).hostname.replace(/^www\./, '');
        if (oldHost !== host && !sharedHost(oldHost) && !sharedHost(host)) fail('New website conflicts with the existing company identity; review required', 'identity_conflict', 409);
      }
      const time = now();
      const record = {
        ...(previous || {}), id: previous?.id || randomUUID(), name, country: country || previous?.country || '',
        website: website || previous?.website || '', archived: previous?.archived || false,
        contacts: unionRecords(previous?.contacts || [], contacts, (item) => `${item.type}:${item.normalized}`),
        evidence: unionRecords(previous?.evidence || [], observed, (item) => item.evidenceHash),
        source: source || previous?.source || 'browser', sourceId: sourceId || previous?.sourceId || null,
        taskIds: [...new Set([...(previous?.taskIds || []), ...(taskId ? [taskId] : [])])],
        version: (previous?.version || 0) + 1, createdAt: previous?.createdAt || time, updatedAt: time,
      };
      if (previous) this.db.prepare('UPDATE companies SET record=? WHERE workspace=? AND id=?').run(json(record), this.workspaceId, record.id);
      else this.db.prepare('INSERT INTO companies VALUES(?,?,?)').run(record.id, this.workspaceId, json(record));
      for (const [kind, value] of aliases) this.db.prepare('INSERT OR IGNORE INTO identities VALUES(?,?,?,?)').run(this.workspaceId, kind, value, record.id);
      this.appendEvent({ taskId, type: previous ? 'company.updated' : 'company.created', detail: { companyId: record.id, evidenceCount: observed.length, archived: record.archived } });
      return { company: record, created: !previous };
    });
  }
  getCompany(id) {
    const row = this.db.prepare('SELECT record FROM companies WHERE workspace=? AND id=?').get(this.workspaceId, string(id, 'Company ID'));
    if (!row) fail('Company not found', 'not_found', 404);
    return decode(row.record);
  }
  listCompanies({ query = '', includeArchived = false } = {}) {
    string(query, 'query', false, 10_000); const needle = normalizedName(query);
    return this.db.prepare('SELECT record FROM companies WHERE workspace=? ORDER BY rowid DESC').all(this.workspaceId).map((row) => decode(row.record)).filter((item) => (includeArchived || !item.archived) && (!needle || normalizedName(`${item.name} ${item.website} ${item.country} ${item.contacts.map((contact) => contact.value).join(' ')}`).includes(needle)));
  }
  archiveCompany(id, archived = true) {
    if (typeof archived !== 'boolean') fail('archived must be a boolean');
    return this.transaction(() => {
      const record = this.getCompany(id); const updated = { ...record, archived, version: record.version + 1, updatedAt: now() };
      this.db.prepare('UPDATE companies SET record=? WHERE workspace=? AND id=?').run(json(updated), this.workspaceId, id);
      this.appendEvent({ type: 'company.archived', detail: { companyId: id, archived } });
      return updated;
    });
  }
  saveDraft({ companyId, taskId, subject, body } = {}) {
    this.getCompany(companyId); if (taskId) this.getTask(taskId);
    subject = string(subject, 'subject', true, 1000); body = string(body, 'body');
    const payload = { companyId, taskId: taskId || null, subject, body };
    const record = { ...payload, id: randomUUID(), status: 'pending', payloadHash: hash(canonical(payload)), reviewedPayloadHash: null, reviewedAt: null, reviewedBy: null, createdAt: now(), updatedAt: now() };
    this.db.prepare('INSERT INTO drafts VALUES(?,?,?)').run(record.id, this.workspaceId, json(record));
    this.appendEvent({ taskId, type: 'draft.created', detail: { draftId: record.id, companyId, payloadHash: record.payloadHash } });
    return record;
  }
  listDrafts() { return this.db.prepare('SELECT record FROM drafts WHERE workspace=? ORDER BY rowid DESC').all(this.workspaceId).map((row) => decode(row.record)); }
  reviewDraft(id, { status, actor = 'authenticated-user' } = {}) {
    if (!['approved', 'rejected'].includes(status)) fail('Review status must be approved or rejected');
    string(actor, 'actor', true, 200);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT record FROM drafts WHERE workspace=? AND id=?').get(this.workspaceId, string(id, 'Draft ID'));
      if (!row) fail('Draft not found', 'not_found', 404);
      const record = decode(row.record);
      const currentHash = hash(canonical({ companyId: record.companyId, taskId: record.taskId, subject: record.subject, body: record.body }));
      if (currentHash !== record.payloadHash) fail('Draft payload changed without a new approval version', 'payload_conflict', 409);
      if (record.status !== 'pending') {
        if (record.status === status) return record;
        fail('This draft has already been reviewed; create a new draft for another approval', 'state_conflict', 409);
      }
      const updated = { ...record, status, reviewedPayloadHash: record.payloadHash, reviewedAt: now(), reviewedBy: actor, updatedAt: now() };
      this.db.prepare('UPDATE drafts SET record=? WHERE workspace=? AND id=?').run(json(updated), this.workspaceId, id);
      this.appendEvent({ taskId: record.taskId, type: 'draft.reviewed', detail: { draftId: id, status, actor, payloadHash: record.payloadHash } });
      return updated;
    });
  }
  appendEvent({ taskId, type, detail = {} } = {}) {
    string(type, 'Event type', true, 200); json(detail);
    if (taskId) this.getTask(taskId);
    const record = { id: randomUUID(), taskId: taskId || null, type, detail, createdAt: now() };
    const inserted = this.db.prepare('INSERT INTO events(id,workspace,task_id,record) VALUES(?,?,?,?)').run(record.id, this.workspaceId, taskId || null, json(record));
    return { ...record, sequence: Number(inserted.lastInsertRowid) };
  }
  listEvents(taskId) {
    if (taskId) this.getTask(taskId);
    const rows = taskId ? this.db.prepare('SELECT sequence,record FROM events WHERE workspace=? AND task_id=? ORDER BY sequence').all(this.workspaceId, taskId) : this.db.prepare('SELECT sequence,record FROM events WHERE workspace=? ORDER BY sequence').all(this.workspaceId);
    return rows.map((row) => ({ ...decode(row.record), sequence: row.sequence }));
  }
  createConversation({ title = '新会话' } = {}) {
    title = string(title, 'Conversation title', true, 200);
    const record = { id: randomUUID(), title, messageCount: 0, createdAt: now(), updatedAt: now() };
    this.db.prepare('INSERT INTO conversations VALUES(?,?,?)').run(record.id, this.workspaceId, json(record));
    return record;
  }
  getConversation(id) {
    const row = this.db.prepare('SELECT record FROM conversations WHERE workspace=? AND id=?').get(this.workspaceId, string(id, 'Conversation ID'));
    if (!row) fail('Conversation not found', 'not_found', 404);
    return decode(row.record);
  }
  listConversations() {
    return this.db.prepare('SELECT record FROM conversations WHERE workspace=? ORDER BY rowid DESC').all(this.workspaceId).map(row => decode(row.record)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  listMessages(conversationId, { limit = 100 } = {}) {
    this.getConversation(conversationId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('Message limit must be an integer between 1 and 500');
    return this.db.prepare('SELECT sequence,record FROM messages WHERE workspace=? AND conversation_id=? ORDER BY sequence DESC LIMIT ?').all(this.workspaceId, conversationId, limit).reverse().map(row => ({ ...decode(row.record), sequence: row.sequence }));
  }
  getMessageByIdempotencyKey(conversationId, idempotencyKey) {
    this.getConversation(conversationId);
    string(idempotencyKey, 'Message idempotencyKey', true, 500);
    const row = this.db.prepare('SELECT sequence,record FROM messages WHERE workspace=? AND conversation_id=? AND idem_key=?').get(this.workspaceId, conversationId, idempotencyKey);
    return row ? { ...decode(row.record), sequence: row.sequence } : null;
  }
  appendMessage(conversationId, { role, content, status = 'saved', plan = null, references = {}, replyTo = null, idempotencyKey } = {}) {
    if (!['user', 'assistant'].includes(role)) fail('Conversation role must be user or assistant');
    content = string(content, 'Message content', true, role === 'user' ? 12_000 : 20_000);
    if (!['saved', 'ready', 'needs_input', 'unavailable', 'failed'].includes(status)) fail('Invalid conversation message status');
    if (plan !== null) object(plan, 'Message plan');
    object(references, 'Message references');
    if (Object.keys(references).some(key => !['taskIds', 'companyIds'].includes(key))) fail('Invalid message reference type');
    for (const [key, method] of [['taskIds', 'getTask'], ['companyIds', 'getCompany']]) {
      if (references[key] !== undefined && (!Array.isArray(references[key]) || references[key].length > 20 || references[key].some(id => typeof id !== 'string'))) fail('Invalid message references');
      for (const id of references[key] || []) this[method](id);
    }
    if (idempotencyKey !== undefined) string(idempotencyKey, 'Message idempotencyKey', true, 500);
    if (replyTo !== null) {
      string(replyTo, 'Reply message ID');
      const parent = this.db.prepare('SELECT record FROM messages WHERE workspace=? AND conversation_id=? AND id=?').get(this.workspaceId, conversationId, replyTo);
      if (!parent || decode(parent.record).role !== 'user' || role !== 'assistant') fail('Reply must reference a user message in the same conversation', 'not_found', 404);
    }
    const inputHash = hash(canonical({ role, content, status, plan, references, replyTo }));
    return this.transaction(() => {
      const conversation = this.getConversation(conversationId);
      if (idempotencyKey) {
        const existing = this.db.prepare('SELECT sequence,record,input_hash FROM messages WHERE workspace=? AND conversation_id=? AND idem_key=?').get(this.workspaceId, conversationId, idempotencyKey);
        if (existing) {
          if (existing.input_hash !== inputHash) fail('Message idempotency key belongs to different content', 'idempotency_conflict', 409);
          return { ...decode(existing.record), sequence: existing.sequence };
        }
      }
      const record = { id: randomUUID(), conversationId, role, content, status, plan, references, replyTo, idempotencyKey: idempotencyKey || null, createdAt: now() };
      const inserted = this.db.prepare('INSERT INTO messages(id,workspace,conversation_id,idem_key,input_hash,record) VALUES(?,?,?,?,?,?)').run(record.id, this.workspaceId, conversationId, idempotencyKey || null, inputHash, json(record));
      const title = conversation.title === '新会话' && role === 'user' ? content.replace(/\s+/g, ' ').slice(0, 60) : conversation.title;
      const updated = { ...conversation, title, messageCount: conversation.messageCount + 1, updatedAt: now() };
      this.db.prepare('UPDATE conversations SET record=? WHERE workspace=? AND id=?').run(json(updated), this.workspaceId, conversationId);
      return { ...record, sequence: Number(inserted.lastInsertRowid) };
    });
  }
  async backup(directory) {
    const otherWorkspace = ['profiles', 'profile_history', 'companies', 'tasks', 'memories', 'drafts', 'events', 'identities', 'conversations', 'messages'].some((table) => this.db.prepare(`SELECT 1 FROM ${table} WHERE workspace<>? LIMIT 1`).get(this.workspaceId));
    if (otherWorkspace) fail('A database-wide backup requires a single configured workspace', 'backup_scope_conflict', 409);
    const createdAt = now();
    const destination = join(resolve(string(directory, 'Backup directory')), `${createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const file = 'alex.sqlite3'; const databasePath = join(destination, file);
    // SQLite's online backup includes WAL data and a coherent snapshot, not a live file copy.
    await sqliteBackup(this.db, databasePath);
    await chmod(databasePath, 0o600);
    const snapshot = new DatabaseSync(databasePath, { readOnly: true });
    let counts;
    try {
      if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') fail('Backup integrity check failed', 'backup_error', 500);
      counts = Object.fromEntries(['companies', 'tasks', 'memories', 'drafts', 'events', 'profile_history', 'conversations', 'messages'].map((table) => [table, snapshot.prepare(`SELECT count(*) AS total FROM ${table} WHERE workspace=?`).get(this.workspaceId).total]));
      const workspaces = snapshot.prepare('SELECT DISTINCT workspace FROM profiles UNION SELECT DISTINCT workspace FROM companies UNION SELECT DISTINCT workspace FROM tasks UNION SELECT DISTINCT workspace FROM memories UNION SELECT DISTINCT workspace FROM conversations UNION SELECT DISTINCT workspace FROM messages UNION SELECT DISTINCT workspace FROM events UNION SELECT DISTINCT workspace FROM drafts UNION SELECT DISTINCT workspace FROM profile_history UNION SELECT DISTINCT workspace FROM identities').all();
      // This is a local deployment snapshot. Never label a database containing multiple
      // workspaces as one isolated workspace backup.
      if (workspaces.some((row) => row.workspace !== this.workspaceId)) fail('A database-wide backup requires a single configured workspace', 'backup_scope_conflict', 409);
    } finally { snapshot.close(); }
    const manifest = { schemaVersion: 1, createdAt, workspaceId: this.workspaceId, database: { file, sha256: hash(await readFile(databasePath)) }, counts, evidenceStorage: 'inline-database', excludes: ['browser cookies', 'credentials'], directory: destination };
    await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    this.appendEvent({ type: 'backup.created', detail: { directory: destination, databaseSha256: manifest.database.sha256 } });
    return manifest;
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
