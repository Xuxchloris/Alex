import { normalizeCriteria } from '../alex-research/index.mjs';

function error(message, code = 'invalid_request', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function validatePlan(plan) {
  if (!plan || !['ready', 'needs_input', 'unavailable'].includes(plan.status)) throw error('Conversation planner returned an invalid status', 'invalid_plan');
  const criteria = normalizeCriteria(plan.criteria || {});
  if (!Array.isArray(plan.missing) || plan.missing.some(key => !['product', 'market', 'customerType'].includes(key))) throw error('Conversation missing fields are invalid', 'invalid_plan');
  for (const field of ['questions', 'plan']) if (!Array.isArray(plan[field]) || plan[field].length > (field === 'questions' ? 6 : 8) || plan[field].some(item => typeof item !== 'string' || !item.trim() || item.length > 2000)) throw error('Conversation proposal failed validation', 'invalid_plan');
  if (!plan.profileUpdates || typeof plan.profileUpdates !== 'object' || Array.isArray(plan.profileUpdates)) throw error('Conversation profile changes are invalid', 'invalid_plan');
  return { ...plan, criteria };
}

function replyText(plan, summary) {
  const saved = Object.keys(plan.profileUpdates).length ? `已按本次明确要求保存长期资料：${Object.entries(plan.profileUpdates).map(([key, value]) => `${({ product: '产品', market: '市场', customerType: '客户类型' })[key]}=${value}`).join('；')}。\n\n` : '';
  const archive = summary.companyCount ? `已读取客户档案，共 ${summary.companyCount} 家（归档 ${summary.archivedCount} 家），研究时继续使用同一档案去重。\n\n` : '';
  if (plan.status === 'needs_input') return `${saved}${archive}我已保存这次交流。为了确定可执行的获客方案，还需要了解：\n${plan.questions.map(question => `• ${question}`).join('\n')}`;
  const labels = { product: '产品', market: '目标市场', customerType: '客户类型', count: '本次目标数量' };
  const facts = Object.entries(labels).filter(([key]) => plan.criteria[key] !== undefined).map(([key, label]) => `${label}：${plan.criteria[key]}`).join('\n');
  return `${saved}${archive}已整理本次研究方案：\n${facts}\n\n${plan.plan.length ? `拟执行步骤：\n${plan.plan.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\n` : ''}请核对下方方案，点击“执行此方案”后执行。方案尚未执行，客户结果以任务和来源证据为准。`;
}

/** Multi-turn planning backed by the same business database and validated research planner. */
export class ConversationService {
  constructor({ store, runner } = {}) {
    if (!store || !runner || typeof runner.plan !== 'function') throw new TypeError('ConversationService requires a store and ResearchRunner');
    this.store = store;
    this.runner = runner;
    this.queue = Promise.resolve();
    this.inFlight = new Map();
    this.controller = null;
    this.closed = false;
  }

  send(conversationId, { content, idempotencyKey } = {}) {
    if (this.closed) return Promise.reject(error('Conversation service is closing', 'service_closed', 503));
    if (typeof content !== 'string' || !content.trim() || content.length > 12_000) return Promise.reject(error('Message must contain 1 to 12000 characters'));
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 300)) return Promise.reject(error('Message idempotency key must contain 1 to 300 characters'));
    try { this.store.getConversation(conversationId); } catch (failure) { return Promise.reject(failure); }
    content = content.trim();
    const flightKey = idempotencyKey ? `${conversationId}:${idempotencyKey}` : null;
    if (flightKey && this.inFlight.has(flightKey)) {
      const pending = this.inFlight.get(flightKey);
      if (pending.content !== content) return Promise.reject(error('Message idempotency key belongs to different content', 'idempotency_conflict', 409));
      return pending.job;
    }
    // One write/planning sequence at a time, including across conversations: the next
    // turn reads a coherent profile and the complete prior turn, not stale model state.
    const job = this.queue.then(() => this.execute(conversationId, { content, idempotencyKey }));
    this.queue = job.catch(() => {});
    if (flightKey) {
      this.inFlight.set(flightKey, { content, job });
      job.finally(() => this.inFlight.delete(flightKey)).catch(() => {});
    }
    return job;
  }

  async execute(conversationId, { content, idempotencyKey }) {
    const userMessage = this.store.appendMessage(conversationId, { role: 'user', content, ...(idempotencyKey ? { idempotencyKey: `user:${idempotencyKey}` } : {}) });
    const responseKey = `reply:${userMessage.id}`;
    const archived = this.store.getMessageByIdempotencyKey(conversationId, responseKey);
    if (archived) return { conversation: this.store.getConversation(conversationId), userMessage, assistantMessage: archived, plan: archived.plan, status: archived.status };
    const history = this.store.listMessages(conversationId, { limit: 20 });
    if (history.some(message => message.sequence > userMessage.sequence)) return { conversation: this.store.getConversation(conversationId), userMessage, assistantMessage: null, plan: null, status: 'unavailable', code: 'turn_interrupted', message: '这条消息之后已有新的交流，请在当前会话继续。' };
    if (this.closed) return { conversation: this.store.getConversation(conversationId), userMessage, assistantMessage: null, plan: null, status: 'unavailable', code: 'service_closed', message: '消息已存档，服务正在关闭，请重新启动后继续。' };
    const previous = [...history].reverse().find(message => message.role === 'assistant' && message.plan);
    this.controller = new AbortController();
    try {
      const plan = validatePlan(await this.runner.plan(content, { history: history.filter(message => message.id !== userMessage.id).map(message => ({ role: message.role, content: message.content })), previousCriteria: previous?.plan?.criteria || null, signal: this.controller.signal }));
      if (plan.status === 'unavailable') return { conversation: this.store.getConversation(conversationId), userMessage, assistantMessage: null, plan, status: 'unavailable', code: plan.code || 'model_unavailable', message: plan.message || '模型不可用；用户消息已存档，没有生成回复或执行研究。' };
      if (this.closed || this.controller.signal.aborted) return { conversation: this.store.getConversation(conversationId), userMessage, assistantMessage: null, plan: null, status: 'unavailable', code: 'service_closed', message: '消息已存档，服务正在关闭，请重新启动后继续。' };
      const companies = this.store.listCompanies({ includeArchived: true });
      const tasks = this.store.listTasks();
      const references = { taskIds: tasks.slice(0, 5).map(task => task.id), companyIds: companies.slice(0, 5).map(company => company.id) };
      const assistantMessage = this.store.appendMessage(conversationId, { role: 'assistant', replyTo: userMessage.id, content: replyText(plan, { companyCount: companies.length, archivedCount: companies.filter(company => company.archived).length }), status: plan.status, plan, references, idempotencyKey: responseKey });
      return { conversation: this.store.getConversation(conversationId), userMessage, assistantMessage, plan, status: plan.status };
    } catch (failure) {
      // Provider bodies and keys never become conversation content. A failed request
      // remains a saved user turn, with an explicit diagnostic rather than fake prose.
      const code = failure?.code === 'model_unavailable' ? 'model_unavailable' : failure?.code === 'invalid_plan' ? 'invalid_plan' : this.closed ? 'service_closed' : 'conversation_failed';
      return { conversation: this.store.getConversation(conversationId), userMessage, assistantMessage: null, plan: null, status: code === 'invalid_plan' || code === 'conversation_failed' ? 'failed' : 'unavailable', code, message: code === 'invalid_plan' ? '模型方案未通过验证；消息已保存，未执行任务或保存推断资料。' : '模型当前不可用；消息已保存，未生成回复或执行任务。' };
    } finally { this.controller = null; }
  }

  async close() {
    this.closed = true;
    this.controller?.abort();
    await this.queue;
  }
}
