const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { token: '', profile: { facts: {}, version: 0 }, capabilities: {}, companies: [], tasks: [], drafts: [], backups: [], browser: {}, plan: null, plannedRequest: '', tab: 'companies', refreshing: false, framePending: false, diagnostic: '', connected: false, submissionKey: null };
const names = { companyName: '企业', product: '产品', market: '市场', customerType: '客户类型', notes: '补充要求' };
const statuses = { queued: '等待开始', running: '正在研究', paused: '已暂停', completed: '研究完成', partial: '已获得部分结果', blocked: '访问受限', unavailable: '等待配置', failed: '执行遇到问题', cancelled: '已取消', pending: '待复核', approved: '已批准', rejected: '已退回' };
const esc = value => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const asText = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const date = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '未记录时间';
const safeDate = value => { try { return date(value); } catch { return '未记录时间'; } };
const humanError = error => {
  const code = error?.code || '';
  const raw = error?.message || asText(error);
  state.diagnostic = `${code ? `${code}: ` : ''}${raw}`;
  if (code === 'unauthorized') return '工作空间连接已失效，请刷新页面重新连接。';
  if (code === 'model_unavailable' || /model.*(?:not configured|unavailable)/iu.test(raw)) return '尚未配置智能模型。你可以直接填写筛选条件、核验已知官网，或在设置中查看模型配置方式。';
  if (['model_timeout', 'model_request_failed', 'model_http_error', 'model_error'].includes(code)) return '智能模型调用暂时未完成。你可以稍后重试，或先直接填写条件核验官网。';
  if (code === 'human_has_control') return '浏览器正在由你控制。请先交还 Alex，再继续任务。';
  if (code === 'agent_has_control') return '请先接管浏览器，再操作网页。';
  if (code === 'unsafe_url') return '请提供可公开访问的完整 http 或 https 网页地址。';
  if (code === 'dns_unavailable') return '暂时无法解析网站地址，请在环境设置中检查外部网络访问。';
  if (code === 'source_blocked' || /(?:proxy|ERR_TUNNEL|403|blocked)/iu.test(raw)) return '网页访问受限，暂时无法核验这个来源。请检查环境网络配置后继续；未生成虚构客户。';
  if (code === 'browser_unavailable' || /(?:Chromium|browser.*(?:unavailable|not started|not available))/iu.test(raw)) return '研究浏览器暂时不可用，请在工作空间设置中查看运行情况。你的历史资料仍可读取。';
  if (code === 'missing_criteria') return '请补充产品、目标市场和客户类型，或提供要核验的公司官网。';
  if (code === 'task_busy') return '任务正在保存停止点，请稍后再继续。';
  if (code === 'idempotency_conflict') return '这次请求已变化，请重新制定方案后提交。';
  if (code === 'network_error') return '暂时无法连接工作空间，请检查服务是否运行，再刷新页面。';
  if (code === 'insufficient_evidence') return '这个网页没有足够可读取的公司证据，未保存为客户。';
  if (code === 'invalid_plan') return '这次方案未能通过核验。请补充清晰的任务要求，或直接填写筛选条件。';
  return /^[\u4e00-\u9fff]/u.test(raw) ? raw : '操作暂时未完成，请重试。具体原因可在工作空间设置中查看。';
};
function toast(message, error = false) {
  const item = document.createElement('div');
  item.className = `toast${error ? ' error' : ''}`;
  item.textContent = message;
  $('#toast-region').append(item);
  setTimeout(() => item.remove(), error ? 9000 : 4500);
}
async function api(path, payload) {
  const headers = { 'X-Alex-Token': state.token };
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try { response = await fetch(path, { method: payload === undefined ? 'GET' : 'POST', headers, credentials: 'same-origin', cache: 'no-store', ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) }); }
  catch { throw Object.assign(new Error('Cannot connect to workspace'), { code: 'network_error' }); }
  let data;
  try { data = await response.json(); }
  catch { throw Object.assign(new Error('Unexpected workspace response'), { code: 'invalid_response' }); }
  if (!response.ok) throw Object.assign(new Error(data.error || '操作失败'), { code: data.code, status: response.status });
  return data;
}
async function perform(button, work) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try { return await work(); }
  catch (error) { toast(humanError(error), true); }
  finally { if (button?.isConnected) button.disabled = false; }
}
function empty(mark, title, description) { return `<div class="empty-state"><span class="empty-mark" aria-hidden="true">${mark}</span><h3>${esc(title)}</h3><p>${esc(description)}</p></div>`; }
function badge(status) {
  const tone = ['completed', 'approved'].includes(status) ? 'green' : ['failed', 'rejected'].includes(status) ? 'red' : ['paused', 'blocked', 'partial', 'unavailable'].includes(status) ? 'amber' : 'neutral';
  return `<span class="badge ${tone}">${esc(statuses[status] || status || '待复核')}</span>`;
}
function urlLink(url, label = url) {
  try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) return esc(label); }
  catch { return esc(label); }
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
}
function contactValue(contact) { return contact.value || contact.email || contact.phone || ''; }
function contactType(contact) { return contact.type || (contact.email ? 'email' : contact.phone ? 'phone' : ''); }
function qualification(company) {
  return [...(company.evidence || [])].reverse().find(item => item.fields?.qualification)?.fields.qualification || { status: 'needs_review' };
}
function renderProfile() {
  const facts = state.profile.facts || {};
  const entries = Object.entries(facts).filter(([, value]) => asText(value).trim());
  $('#profile-summary').innerHTML = entries.length
    ? `<dl class="profile-summary">${entries.slice(0, 5).map(([key, value]) => `<div class="profile-row"><dt>${esc(names[key] || key)}</dt><dd>${esc(asText(value))}</dd></div>`).join('')}</dl>${entries.length > 5 ? `<div class="profile-overflow">还有 ${entries.length - 5} 项资料，编辑时可查看</div>` : ''}`
    : '<p class="muted">还不了解你的业务。首次告诉 Alex 产品、市场和目标客户，后续就能接着做。</p>';
  $('#profile-version').textContent = state.profile.version ? `资料版本 ${state.profile.version} · ${safeDate(state.profile.updatedAt)}` : '你的资料由你定义，随时可以纠正';
  const unavailable = state.capabilities.modelConfigured === false;
  $('#model-notice').classList.toggle('hidden', !unavailable);
  $('#model-notice').textContent = '智能规划尚未配置。你仍可以填写筛选条件，访问并核验真实官网。';
}
function renderCompanies() {
  $('#company-count').textContent = state.companies.length;
  $('#companies-list').innerHTML = state.companies.length ? state.companies.map(company => {
    const match = qualification(company);
    const emails = (company.contacts || []).filter(contact => contactType(contact) === 'email');
    return `<article class="record-card"><div class="record-top"><h3>${esc(company.name)}</h3><span class="badge ${company.archived ? 'neutral' : match.status === 'matched' ? 'green' : 'amber'}">${company.archived ? '已归档' : match.status === 'matched' ? '符合条件' : '待核验匹配'}</span></div><p>${urlLink(company.website, company.website?.replace(/^https?:\/\//u, '') || '官网未记录')}</p><p>${esc(company.country || '国家尚未核验')} · ${emails.length ? `${emails.length} 个公开邮箱` : '尚未找到公开邮箱'}</p><div class="record-meta"><span class="mini-dot"></span>${(company.evidence || []).length} 条来源证据 · ${safeDate(company.updatedAt || company.createdAt)}</div><div class="record-actions"><button class="text-button" data-action="company" data-id="${esc(company.id)}" type="button">查看证据</button><button class="text-button" data-action="company-draft" data-id="${esc(company.id)}" type="button">准备开发信</button><button class="text-button" data-action="archive" data-id="${esc(company.id)}" type="button">${company.archived ? '恢复客户' : '归档'}</button></div></article>`;
  }).join('') : empty('◌', '从真实发现开始积累', '新发现的公司会显示在这里，附带官网与来源证据。');
}
function taskSummary(task) {
  const result = task.result || {};
  const count = result.actualCount ?? result.companies?.length ?? 0;
  const matched = result.matchedCount;
  const completed = task.checkpoint?.completedUrls?.length || 0;
  return `${count} 家已存档${matched != null ? ` · ${matched} 家符合条件` : ''}${result.needsReviewCount != null ? ` · ${result.needsReviewCount} 家待复核` : ''}${completed ? ` · ${completed} 个来源已核验` : ''}`;
}
function renderTasks() {
  $('#task-count').textContent = state.tasks.length;
  $('#tasks-list').innerHTML = state.tasks.length ? state.tasks.map(task => {
    const active = ['running', 'queued'].includes(task.status);
    const ended = ['completed', 'cancelled'].includes(task.status);
    const error = task.error ? humanError({ code: task.error.code, message: asText(task.error.message || task.error) }) : '';
    const stage = task.checkpoint?.stage;
    const progress = ended || stage === 'done' ? 100 : stage === 'verify' ? 75 : active ? 25 : 0;
    return `<article class="record-card"><div class="record-top"><h3>${esc(task.request)}</h3>${badge(task.status)}</div><p>${esc(taskSummary(task))}</p>${error ? `<p>${esc(error)}</p>` : ''}<div class="task-progress" data-progress="${progress}"><span></span></div><div class="record-meta">${safeDate(task.updatedAt || task.createdAt)}</div><div class="record-actions"><button class="text-button" data-action="task" data-id="${esc(task.id)}" type="button">查看进度</button>${active ? `<button class="text-button" data-action="task-pause" data-id="${esc(task.id)}" type="button">暂停</button>` : !ended ? `<button class="text-button" data-action="task-resume" data-id="${esc(task.id)}" type="button">继续</button>` : ''}${!ended ? `<button class="text-button" data-action="task-cancel" data-id="${esc(task.id)}" type="button">取消</button>` : ''}</div></article>`;
  }).join('') : empty('↗', '你的下一步，从这里开始', '任务会保留进度，暂停或重启后可以继续。');
}
function renderDrafts() {
  $('#draft-count').textContent = state.drafts.length;
  $('#drafts-list').innerHTML = state.drafts.length ? state.drafts.map(draft => {
    const company = state.companies.find(item => item.id === draft.companyId);
    return `<article class="record-card"><div class="record-top"><h3>${esc(draft.subject || '未命名开发信')}</h3>${badge(draft.status)}</div><p>${esc(company?.name || '已存档客户')} · ${safeDate(draft.createdAt)}</p><p>${esc(draft.body?.slice(0, 105))}${draft.body?.length > 105 ? '…' : ''}</p><div class="record-actions"><button class="text-button" data-action="draft" data-id="${esc(draft.id)}" type="button">查看与复核</button><button class="text-button" data-action="draft-edit" data-id="${esc(draft.id)}" type="button">编辑新版本</button></div></article>`;
  }).join('') : empty('✎', '把发现变成下一次联系', '在客户详情中准备开发信，再由你检查和批准。');
}
function renderBackups() {
  $('#backups-list').innerHTML = state.backups.length ? state.backups.map(backup => `<article class="record-card"><div class="record-top"><h3>${esc(backup.name || '工作空间备份')}</h3><span class="badge green">已保存</span></div><p>${safeDate(backup.createdAt || backup.created_at)} · 本机副本</p>${backup.counts ? `<p>${Number(backup.counts.companies || 0)} 家客户 · ${Number(backup.counts.tasks || 0)} 个任务 · ${Number(backup.counts.memories || 0)} 条记忆</p>` : ''}</article>`).join('') : '<p class="muted">还没有备份，创建后会显示保存时间。</p>';
}
function setTab(tab) {
  state.tab = tab;
  $$('.tab').forEach(button => { const selected = button.dataset.tab === tab; button.classList.toggle('active', selected); button.setAttribute('aria-selected', String(selected)); });
  $$('.tab-panel').forEach(panel => panel.classList.toggle('hidden', panel.id !== `${tab}-panel`));
}
function renderBrowser() {
  const browser = state.browser;
  const available = browser.available === true;
  const human = browser.owner === 'human';
  $('#browser-owner').textContent = !available ? '暂时不可用' : human ? '由你控制' : 'Alex 控制中';
  $('#browser-owner').className = `badge ${!available ? 'amber' : human ? 'green' : 'neutral'}`;
  $('#browser-notice').textContent = !available ? '浏览器尚未就绪，历史资料和客户档案仍会保留。' : human ? '你已接管，可以点击画面、输入或滚动。任务进度已暂停保存。' : '查看 Alex 使用的同一个浏览器；需要时随时接管。';
  $('#browser-notice').classList.toggle('warning', !available);
  if (document.activeElement !== $('#browser-url')) $('#browser-url').value = browser.url && browser.url !== 'about:blank' ? browser.url : '';
  $('#browser-title').textContent = browser.title || (browser.url === 'about:blank' ? '还没有打开网页' : browser.url) || '还没有打开网页';
  $('#takeover-button').classList.toggle('hidden', human);
  $('#takeover-button').disabled = !available;
  $('#release-button').classList.toggle('hidden', !human);
  $('#human-controls').classList.toggle('hidden', !human || !available);
  $('#navigate-button').disabled = !available || !human;
  $('#browser-url').disabled = !available || !human;
  $('#browser-canvas').classList.toggle('human', human && available);
  if (!available || !browser.url || browser.url === 'about:blank') {
    $('#browser-frame').classList.add('hidden');
    $('#browser-placeholder').classList.remove('hidden');
    $('#browser-empty-text').textContent = !available ? '浏览器暂时未就绪，请在工作空间设置中查看运行情况。' : '任务开始后，Alex 会在这里访问网页。你也可以接管浏览器，亲自继续。';
  } else {
    $('#browser-empty-text').textContent = '任务开始后，Alex 会在这里访问网页。你也可以接管浏览器，亲自继续。';
  }
}
function refreshFrame() {
  if (document.hidden || !state.browser.available || !state.browser.url || state.browser.url === 'about:blank' || state.framePending) return;
  state.framePending = true;
  $('#browser-frame').src = `/api/browser/frame?t=${Date.now()}`;
}
$('#browser-frame').addEventListener('load', () => {
  state.framePending = false;
  if (state.browser.available) {
    $('#browser-frame').classList.remove('hidden');
    $('#browser-placeholder').classList.add('hidden');
  }
});
$('#browser-frame').addEventListener('error', () => {
  state.framePending = false;
  $('#browser-frame').classList.add('hidden');
  $('#browser-placeholder').classList.remove('hidden');
  $('#browser-empty-text').textContent = '暂时无法读取浏览器画面，稍后自动重试。';
});
function connected(value) {
  state.connected = value;
  $('#connection-label').textContent = value ? '我的工作空间 · 持续存档' : '工作空间连接暂时中断';
  $('#connection-dot').classList.toggle('offline', !value);
}
async function refreshCompanies() {
  const query = new URLSearchParams({ query: $('#company-search').value.trim(), includeArchived: $('#include-archived').checked ? '1' : '0' });
  state.companies = await api(`/api/companies?${query}`);
  renderCompanies(); renderDrafts();
}
async function refreshAll({ quiet = false } = {}) {
  if (!state.token || state.refreshing) return;
  state.refreshing = true;
  const parts = [
    ['profile', '/api/profile', renderProfile], ['tasks', '/api/tasks', renderTasks], ['drafts', '/api/drafts', renderDrafts], ['backups', '/api/backups', renderBackups], ['browser', '/api/browser/state', renderBrowser],
  ];
  const results = await Promise.allSettled(parts.map(async ([key, path, render]) => { state[key] = await api(path); render(); }));
  const companyResult = await Promise.allSettled([refreshCompanies()]);
  const failure = [...results, ...companyResult].find(result => result.status === 'rejected');
  connected(!failure);
  if (failure && !quiet) toast(humanError(failure.reason), true);
  state.refreshing = false;
  refreshFrame();
}
function modal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  if (!$('#modal').open) $('#modal').showModal();
}
function closeModal() { $('#modal').close(); }
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) { const rect = $('#modal').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeModal(); } });
function profileEditor() {
  const facts = state.profile.facts || {};
  modal('我的业务资料', `<p class="modal-description">这些资料供后续任务读取。一次性要求请写在任务里；这里保存你的长期业务信息。</p><form id="profile-form"><div class="form-grid">${Object.entries(names).map(([key, label]) => `<label class="field ${key === 'notes' ? 'full' : ''}">${label}${key === 'notes' ? `<textarea name="${key}" rows="3" placeholder="长期规则、排除条件或偏好">${esc(asText(facts[key]))}</textarea>` : `<input name="${key}" value="${esc(asText(facts[key]))}" placeholder="由你填写">`}</label>`).join('')}</div>${Object.keys(facts).some(key => !(key in names)) ? `<h3 class="modal-subtitle">其他已存资料</h3><dl class="detail-grid">${Object.entries(facts).filter(([key]) => !(key in names)).map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(asText(value))}</dd>`).join('')}</dl>` : ''}<div class="form-actions"><button class="button" data-close-modal type="button">取消</button><button class="button primary" type="submit">保存到记忆</button></div></form>`);
  $('#profile-form').addEventListener('submit', event => {
    event.preventDefault();
    perform($('button[type=submit]', event.target), async () => {
      const facts = Object.fromEntries([...new FormData(event.target)].map(([key, value]) => [key, value.trim()]));
      state.profile = await api('/api/profile', { facts }); renderProfile(); closeModal(); toast('业务资料已保存，后续任务会读取新版本。');
    });
  });
}
$('#edit-profile').addEventListener('click', profileEditor);
function renderPlan(plan, request) {
  state.plan = plan;
  state.plannedRequest = request;
  state.submissionKey = crypto.randomUUID();
  const host = $('#plan-result');
  host.classList.remove('hidden');
  if (plan.status === 'unavailable') {
    host.innerHTML = `<h3>可以先直接填写研究条件</h3><p>${esc(plan.message || '智能模型尚未配置，暂时无法理解并制定自然语言方案。')}</p><button class="button" id="plan-structured" type="button">填写条件 / 核验官网</button>`;
    $('#plan-structured').addEventListener('click', structuredEditor);
    return;
  }
  const missing = plan.missing || [];
  const criteria = plan.criteria || {};
  host.innerHTML = `<h3>${missing.length ? '先了解你的业务' : '这次的研究方案'}</h3><div class="plan-criteria">${['product', 'market', 'customerType'].filter(key => criteria[key]).map(key => `<span class="chip">${esc(names[key])} · ${esc(criteria[key])}</span>`).join('')}</div>${missing.length ? `<div class="plan-questions"><strong>请补充以下信息：</strong>${(plan.questions?.length ? plan.questions : missing.map(key => `你的${names[key] || key}是什么？`)).map(question => `<p>${esc(question)}</p>`).join('')}</div><p>补充到上方任务描述，重新制定方案。你明确介绍的业务资料会存入记忆。</p>` : `<ul>${(plan.plan || []).map(step => `<li>${esc(step)}</li>`).join('')}</ul><p>目标数量：${Number(criteria.count || 5)} 家；以实际核验结果为准。</p><button class="button primary" id="start-plan" type="button">按方案开始研究 →</button>`}`;
  if (!missing.length) $('#start-plan').addEventListener('click', event => perform(event.target, () => createTask({ request: state.plannedRequest, criteria, idempotencyKey: state.submissionKey })));
}
$('#plan-form').addEventListener('submit', event => {
  event.preventDefault();
  const request = $('#request').value.trim();
  if (!request) return;
  perform($('#plan-button'), async () => {
    const plan = await api('/api/plan', { request });
    if ($('#request').value.trim() === request) renderPlan(plan, request);
    else invalidatePlan();
    state.profile = await api('/api/profile'); renderProfile();
  });
});
function invalidatePlan() {
  state.plan = null;
  $('#plan-result').classList.remove('hidden');
  $('#plan-result').innerHTML = '<p>任务目标已更新，请重新制定方案后再开始。</p>';
}
$('#request').addEventListener('input', () => { if (!$('#plan-result').classList.contains('hidden') && $('#request').value.trim() !== state.plannedRequest) invalidatePlan(); });
async function createTask(payload) {
  const task = await api('/api/tasks', payload);
  state.tasks = await api('/api/tasks'); renderTasks(); setTab('tasks');
  if ($('#modal').open) closeModal();
  $('#plan-result').classList.add('hidden');
  toast(`研究任务已保存${task.status === 'queued' ? '，开始访问真实来源。' : '。'}`);
  setTimeout(() => refreshAll({ quiet: true }), 500);
}
function structuredEditor() {
  const criteria = { ...(state.profile.facts || {}), ...(state.plan?.criteria || {}) };
  const key = crypto.randomUUID();
  modal('填写研究条件', `<p class="modal-description">根据你的实际业务填写。提供官网时直接读取网页核验；留空官网时按条件搜索真实公司。</p><form id="structured-form"><div class="form-grid"><label class="field">产品<input name="product" value="${esc(criteria.product || '')}" placeholder="你销售的产品"></label><label class="field">目标国家 / 地区<input name="market" value="${esc(criteria.market || '')}" placeholder="你的目标市场"></label><label class="field">目标客户类型<input name="customerType" value="${esc(criteria.customerType || '')}" placeholder="由你的业务决定"></label><label class="field">目标数量<input name="count" type="number" min="1" max="20" value="${Number(criteria.count || 5)}" required><span>1–20 家，以实际找到的数量为准</span></label><label class="field full">公司官网（可选）<textarea name="urls" rows="3" placeholder="每行一个真实公司官网，最多 20 个">${esc((criteria.urls || []).join('\n'))}</textarea><span>有官网即可执行网页核验；搜索发现需填写上述三项条件。</span></label><label class="field full">排除关键词（可选）<input name="excludeKeywords" value="${esc((criteria.excludeKeywords || []).join(', '))}" placeholder="逗号分隔，最多 20 个关键词"><span>从候选名称和网页正文中排除包含这些词的公司。</span></label><label class="field full">任务备注（仅存档）<textarea name="notes" rows="2" placeholder="为这个任务留一段备注"></textarea><span>此处用于记录，不自动转化为筛选条件。</span></label></div><label class="checkbox-row"><input name="remember" type="checkbox"> 将产品、市场、客户类型保存为我的长期业务资料</label><p class="invalid-form hidden" id="structured-error" role="alert"></p><div class="form-actions"><button class="button" data-close-modal type="button">取消</button><button class="button primary" type="submit">开始真实研究 →</button></div></form>`);
  $('#structured-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = new FormData(event.target);
    const values = Object.fromEntries(['product', 'market', 'customerType'].map(key => [key, String(form.get(key) || '').trim()]));
    const urls = String(form.get('urls') || '').split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
    const excludeKeywords = [...new Set(String(form.get('excludeKeywords') || '').split(/[,，\n]/u).map(value => value.trim()).filter(Boolean))];
    const error = $('#structured-error');
    let invalid = '';
    if (urls.length > 20) invalid = '最多一次核验 20 个官网。';
    else if (excludeKeywords.length > 20) invalid = '最多填写 20 个排除关键词。';
    else if (urls.some(value => { try { return !['https:', 'http:'].includes(new URL(value).protocol); } catch { return true; } })) invalid = '请填写完整的 http 或 https 官网地址，每行一个。';
    else if (!urls.length && Object.values(values).some(value => !value)) invalid = '搜索发现需要产品、目标市场和客户类型；或者先提供真实官网。';
    error.textContent = invalid; error.classList.toggle('hidden', !invalid);
    if (invalid) return;
    perform($('button[type=submit]', event.target), async () => {
      if (form.get('remember')) {
        state.profile = await api('/api/profile', { facts: Object.fromEntries(Object.entries(values).filter(([, value]) => value)) }); renderProfile();
      }
      const criteria = { ...values, count: Number(form.get('count')), ...(urls.length ? { urls } : {}), ...(excludeKeywords.length ? { excludeKeywords } : {}) };
      const notes = String(form.get('notes') || '').trim();
      const request = notes || `${urls.length ? '核验提供的真实公司官网' : '搜索并核验目标客户'}：${[values.product, values.market, values.customerType].filter(Boolean).join(' · ')}`;
      await createTask({ request, criteria, ...(urls.length ? { urls } : {}), idempotencyKey: key });
    });
  });
}
$('#structured-open').addEventListener('click', structuredEditor);
function showCompany(company) {
  const match = qualification(company);
  modal(company.name || '客户档案', `<dl class="detail-grid"><dt>官网</dt><dd>${urlLink(company.website)}</dd><dt>国家 / 地区</dt><dd>${esc(company.country || '尚未核验')}</dd><dt>公开联系方式</dt><dd>${(company.contacts || []).length ? company.contacts.map(contact => `<div>${contactType(contact) === 'email' ? '邮箱' : contactType(contact) === 'phone' ? '电话' : '联系'}：${esc(contactValue(contact))}</div>`).join('') : '网页中未发现可核验的公开联系方式'}</dd><dt>筛选匹配</dt><dd>${esc(match.status === 'matched' ? '符合本次条件' : match.status === 'not_matched' ? '不符合条件' : '需要人工核验')}${match.reason ? `<br>${esc(match.reason)}` : ''}</dd><dt>档案状态</dt><dd>${company.archived ? '已归档，后续仍参加查重' : '客户库中保留'}</dd><dt>更新时间</dt><dd>${safeDate(company.updatedAt || company.createdAt)}</dd></dl><div class="form-actions"><button class="button" data-action="browser-company" data-id="${esc(company.id)}" type="button">在研究窗口访问</button><button class="button primary" data-action="company-draft" data-id="${esc(company.id)}" type="button">准备开发信</button></div><h3 class="modal-subtitle">来源证据 · ${(company.evidence || []).length} 条</h3><div class="evidence-list">${(company.evidence || []).map(evidence => `<article class="evidence-item"><strong>${esc(evidence.title || '网页证据')}</strong><br>${urlLink(evidence.url)}<p>读取于 ${safeDate(evidence.observedAt || evidence.createdAt)}</p><p>${esc(evidence.excerpt || '此来源未保存正文摘要')}</p></article>`).join('') || '<p class="muted">未记录证据。</p>'}</div>`);
}
const eventNames = { research_started: '开始研究', research_finished: '研究完成', research_failed: '研究中断', source_failed: '来源访问遇到问题', search_observed: '搜索页面已读取', company_discovered: '发现并存档客户', company_updated: '已有客户已更新', candidate_rejected: '候选不符合条件', 'task.created': '任务已保存', 'task.updated': '任务进度已保存', 'draft.created': '开发信草稿已保存', 'draft.reviewed': '草稿已复核', 'profile.updated': '业务资料已更新', 'browser.navigated': '访问网页', 'company.created': '客户已存档', 'company.updated': '客户资料已更新' };
async function showTask(id) {
  const [task, events] = await Promise.all([api(`/api/tasks/${encodeURIComponent(id)}`), api(`/api/tasks/${encodeURIComponent(id)}/events`)]);
  if (!task) return;
  modal('任务进度与存档', `<h3>${esc(task.request)}</h3><div class="status-line">${badge(task.status)}<span>${esc(taskSummary(task))}</span></div>${task.error ? `<div class="warning-box">${esc(humanError({ code: task.error.code, message: asText(task.error.message || task.error) }))}</div>` : ''}<dl class="detail-grid">${['product', 'market', 'customerType'].filter(key => task.criteria?.[key]).map(key => `<dt>${names[key]}</dt><dd>${esc(task.criteria[key])}</dd>`).join('')}<dt>最近保存</dt><dd>${safeDate(task.updatedAt)}</dd>${task.checkpoint?.currentUrl ? `<dt>当前来源</dt><dd>${urlLink(task.checkpoint.currentUrl)}</dd>` : ''}</dl><h3 class="modal-subtitle">过程记录</h3>${events.length ? [...events].reverse().map(event => `<article class="event-row"><strong>${esc(eventNames[event.type] || '工作记录已保存')}</strong>${event.detail?.url ? `<p>${urlLink(event.detail.url)}</p>` : ''}${event.detail?.message ? `<p>${esc(humanError({ code: event.detail.code, message: event.detail.message }))}</p>` : ''}${event.detail?.actualCount != null ? `<p>${Number(event.detail.actualCount)} 家存档 · ${Number(event.detail.matchedCount || 0)} 家符合条件 · ${Number(event.detail.needsReviewCount || 0)} 家待人工核验</p>` : ''}${event.detail?.website ? `<p>${urlLink(event.detail.website)}</p>` : ''}<time>${safeDate(event.createdAt)}</time></article>`).join('') : '<p class="muted">尚未有执行记录。</p>'}`);
}
function draftEditor({ companyId, taskId, subject = '', body = '' }) {
  const company = state.companies.find(item => item.id === companyId);
  modal(subject ? '编辑开发信新版本' : '手工准备开发信', `<p class="modal-description">客户：${esc(company?.name || '已存档客户')}。修改后保存独立新版本，重新复核；之前的审批保留在旧版本中。</p><form id="draft-form"><div class="form-grid"><label class="field full">主题<input name="subject" value="${esc(subject)}" maxlength="1000" placeholder="邮件主题" required></label><label class="field full">正文<textarea name="body" rows="13" placeholder="基于已核验资料编写，避免补造客户信息" required>${esc(body)}</textarea></label></div><div class="form-actions"><button class="button" data-close-modal type="button">取消</button><button class="button primary" type="submit">保存待复核版本</button></div></form>`);
  $('#draft-form').addEventListener('submit', event => {
    event.preventDefault();
    perform($('button[type=submit]', event.target), async () => {
      const form = new FormData(event.target);
      await api('/api/drafts', { companyId, ...(taskId ? { taskId } : {}), subject: String(form.get('subject')).trim(), body: String(form.get('body')).trim() });
      state.drafts = await api('/api/drafts'); renderDrafts(); setTab('drafts'); closeModal(); toast('新草稿已保存，等待你重新复核。');
    });
  });
}
async function prepareDraft(company, button) {
  if (!state.capabilities.modelConfigured) {
    toast('智能模型尚未配置。你可以先手工编写，并保存为待复核草稿。');
    draftEditor({ companyId: company.id });
    return;
  }
  modal('为客户准备开发信', `<p class="modal-description">客户：${esc(company.name)}。Alex 将读取你的企业资料及该客户已保存的网页证据，生成待复核草稿。</p><form id="generate-draft-form"><label class="field">这封信的要求（可选）<textarea name="request" rows="4" placeholder="期望语言、切入点、语气或行动目标"></textarea></label><div class="form-actions"><button class="button" id="manual-draft" type="button">手工编写</button><button class="button primary" type="submit">生成草稿</button></div></form>`);
  $('#manual-draft').addEventListener('click', () => draftEditor({ companyId: company.id }));
  $('#generate-draft-form').addEventListener('submit', event => {
    event.preventDefault();
    perform($('button[type=submit]', event.target), async () => {
      const draft = await api(`/api/companies/${encodeURIComponent(company.id)}/draft`, { request: String(new FormData(event.target).get('request') || '').trim() });
      state.drafts = await api('/api/drafts'); renderDrafts(); setTab('drafts'); showDraft(draft); toast('草稿已生成，请检查内容后复核。');
    });
  });
}
function showDraft(draft) {
  modal('开发信复核', `<div class="status-line">${badge(draft.status)}<span class="muted">${safeDate(draft.createdAt)}</span></div><h3>${esc(draft.subject)}</h3><div class="draft-body">${esc(draft.body)}</div><p class="modal-description">审批针对这一份完整内容。修改会生成新版本，再次复核。</p>${draft.reviewedAt ? `<p class="muted">复核于 ${safeDate(draft.reviewedAt)}</p>` : ''}<div class="form-actions"><button class="button" data-action="draft-edit" data-id="${esc(draft.id)}" type="button">编辑新版本</button>${draft.status === 'pending' ? `<button class="button" data-action="draft-review-rejected" data-id="${esc(draft.id)}" type="button">退回</button><button class="button primary" data-action="draft-review-approved" data-id="${esc(draft.id)}" type="button">批准这份草稿</button>` : ''}</div><p class="panel-note">这一步只保存审批记录，不发送邮件。</p>`);
}
function settings() {
  const cap = state.capabilities;
  modal('工作空间设置', `<p class="modal-description">Alex 的业务记忆、客户证据与任务保存在当前工作空间。当前版本为个人本地工作空间。</p><dl class="detail-grid"><dt>智能规划</dt><dd>${cap.modelConfigured ? '模型已配置，实际调用结果以任务为准' : '尚未配置智能模型'}</dd><dt>研究浏览器</dt><dd>${state.browser.available ? '浏览器已就绪' : '暂时不可用'}</dd><dt>搜索与核验</dt><dd>只使用实际读取的网页；来源访问结果以任务记录为准</dd><dt>备份位置</dt><dd>本机 · ${(state.backups || []).length} 份记录</dd><dt>对外发送</dt><dd>当前只准备和复核草稿</dd></dl><h3 class="modal-subtitle">运行配置</h3><p class="modal-description">在部署环境设置中配置模型凭据，完成后重启服务。不要把密钥写进聊天、任务或企业资料。</p><div class="diagnostic">ALEX_LLM_API_KEY：智能规划与草稿使用的模型密钥\nALEX_LLM_BASE_URL：兼容接口地址\nALEX_LLM_MODEL：模型名称\nALEX_DATA_DIR：持久化资料目录\nALEX_BACKUP_DIR：备份目录</div><h3 class="modal-subtitle">备份与恢复</h3><p class="modal-description">本机备份包含数据库、存档文件和校验清单。异地恢复需将备份副本复制至独立存储，按仓库 README 的恢复步骤校验并恢复；仅存在本机副本不代表已有异地备份。</p><h3 class="modal-subtitle">最近的诊断</h3><div class="diagnostic">${esc(state.diagnostic || state.browser.error?.message || asText(state.browser.error) || '暂未记录错误。模型配置与浏览器就绪不代表外部数据源可访问，执行结果以来源证据为准。')}</div><div class="form-actions"><button class="button" id="settings-refresh" type="button">刷新运行状态</button><button class="button primary" data-close-modal type="button">完成</button></div>`);
  $('#settings-refresh').addEventListener('click', event => perform(event.target, async () => { const health = await api('/api/health'); state.capabilities = health.capabilities || {}; await refreshAll(); settings(); }));
}
$('#settings-button').addEventListener('click', settings);
async function memories() {
  const records = await api('/api/memories');
  modal('记忆与存档', `<p class="modal-description">明确保存的业务信息、历史经验与补充规则，供后续任务读取。企业资料当前为第 ${Number(state.profile.version || 0)} 版。</p><label class="field">搜索记忆<input id="memory-search" placeholder="输入关键词"></label><div class="memory-list" id="memory-list"></div><h3 class="modal-subtitle">补充一条长期记忆</h3><form id="memory-form"><label class="field">内容<textarea name="content" rows="3" placeholder="例如一条长期适用的筛选规则，由你决定" required maxlength="20000"></textarea></label><div class="form-actions"><button class="button primary" type="submit">保存记忆</button></div></form>`);
  const render = items => { $('#memory-list').innerHTML = items.length ? items.map(item => `<article class="memory-item">${esc(asText(item.content))}<small>${safeDate(item.createdAt)} · ${esc(item.source === 'user' ? '你保存的资料' : '历史记录')}</small></article>`).join('') : '<p class="muted">暂时没有单独的记忆记录；业务资料在左侧可查看和编辑。</p>'; };
  render(records);
  let timer;
  $('#memory-search').addEventListener('input', event => { clearTimeout(timer); timer = setTimeout(() => perform(null, async () => { const items = await api(`/api/memories?query=${encodeURIComponent(event.target.value)}`); if ($('#memory-list')) render(items); }), 300); });
  $('#memory-form').addEventListener('submit', event => {
    event.preventDefault();
    perform($('button[type=submit]', event.target), async () => { const content = String(new FormData(event.target).get('content')).trim(); if (!content) return; await api('/api/memories', { type: 'business_rule', content }); await memories(); toast('长期记忆已保存。'); });
  });
}
$('#memories-button').addEventListener('click', event => perform(event.target, memories));
$$('.tab').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
$('#refresh-tasks').addEventListener('click', event => perform(event.target, async () => { state.tasks = await api('/api/tasks'); renderTasks(); }));
let companySearchTimer;
$('#company-search').addEventListener('input', () => { clearTimeout(companySearchTimer); companySearchTimer = setTimeout(() => perform(null, refreshCompanies), 300); });
$('#include-archived').addEventListener('change', () => perform(null, refreshCompanies));
$('#export-button').addEventListener('click', event => perform(event.target, async () => {
  const response = await fetch(`/api/companies/export?includeArchived=${$('#include-archived').checked ? '1' : '0'}`, { headers: { 'X-Alex-Token': state.token }, credentials: 'same-origin' });
  if (!response.ok) { const result = await response.json(); throw Object.assign(new Error(result.error), { code: result.code }); }
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = objectUrl; link.download = 'alex-customers.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  toast('客户与证据来源已导出为 CSV。');
}));
$('#backup-button').addEventListener('click', event => perform(event.target, async () => { await api('/api/backups', {}); state.backups = await api('/api/backups'); renderBackups(); toast('本机备份已保存。'); }));
async function browserRefresh() { state.browser = await api('/api/browser/state'); renderBrowser(); refreshFrame(); }
$('#takeover-button').addEventListener('click', event => perform(event.target, async () => { state.browser = await api('/api/browser/takeover', {}); renderBrowser(); refreshFrame(); await refreshAll({ quiet: true }); toast('你已接管浏览器，进行中的任务已暂停。'); }));
$('#release-button').addEventListener('click', event => perform(event.target, async () => { state.browser = await api('/api/browser/release', {}); renderBrowser(); refreshFrame(); toast('浏览器已交还 Alex。在任务列表中继续研究。'); }));
$('#navigate-form').addEventListener('submit', event => {
  event.preventDefault();
  if (state.browser.owner !== 'human') return toast('请先接管浏览器，再访问网页。', true);
  perform($('#navigate-button'), async () => {
    try { state.browser = await api('/api/browser/navigate', { url: $('#browser-url').value.trim() }); renderBrowser(); refreshFrame(); }
    finally { $('#browser-url').value = state.browser.url && state.browser.url !== 'about:blank' ? state.browser.url : ''; }
  });
});
async function browserAction(action) {
  if (state.browser.owner !== 'human') throw Object.assign(new Error('请先接管浏览器，再操作页面。'), { code: 'human_has_control' });
  await api('/api/browser/action', action); await browserRefresh();
}
$('#browser-frame').addEventListener('click', event => {
  if (state.browser.owner !== 'human') return;
  const frame = event.currentTarget;
  const rect = frame.getBoundingClientRect();
  if (!frame.naturalWidth || !frame.naturalHeight || !rect.width || !rect.height) return;
  const x = Math.min(frame.naturalWidth - 1, Math.max(0, Math.round((event.clientX - rect.left) * frame.naturalWidth / rect.width)));
  const y = Math.min(frame.naturalHeight - 1, Math.max(0, Math.round((event.clientY - rect.top) * frame.naturalHeight / rect.height)));
  perform(null, () => browserAction({ type: 'click', x, y }));
  $('#browser-canvas').focus({ preventScroll: true });
});
let scrollTimer;
let pendingScroll = 0;
$('#browser-frame').addEventListener('wheel', event => {
  if (state.browser.owner !== 'human' || !state.browser.available) return;
  event.preventDefault();
  pendingScroll = Math.max(-20000, Math.min(20000, pendingScroll + event.deltaY));
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const deltaY = pendingScroll; pendingScroll = 0;
    if (state.browser.owner === 'human' && deltaY) perform(null, () => browserAction({ type: 'scroll', deltaY }));
  }, 100);
}, { passive: false });
$('#browser-canvas').addEventListener('keydown', event => {
  if (state.browser.owner !== 'human' || event.ctrlKey || event.metaKey || event.altKey) return;
  if (!['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
  event.preventDefault(); perform(null, () => browserAction({ type: 'key', key: event.key }));
});
$('#browser-type-form').addEventListener('submit', event => {
  event.preventDefault(); const text = $('#browser-text').value;
  if (!text) return;
  perform($('button[type=submit]', event.target), async () => { await browserAction({ type: 'type', text }); $('#browser-text').value = ''; });
});
$$('[data-browser-key]').forEach(button => button.addEventListener('click', () => perform(button, () => browserAction({ type: 'key', key: button.dataset.browserKey }))));
$$('[data-scroll]').forEach(button => button.addEventListener('click', () => perform(button, () => browserAction({ type: 'scroll', deltaY: Number(button.dataset.scroll) }))));
document.addEventListener('click', event => {
  const close = event.target.closest('[data-close-modal]');
  if (close) return closeModal();
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  const company = state.companies.find(item => item.id === id);
  const draft = state.drafts.find(item => item.id === id);
  perform(button, async () => {
    if (action === 'company') showCompany(company || await api(`/api/companies/${encodeURIComponent(id)}`));
    else if (action === 'archive' && company) { await api(`/api/companies/${encodeURIComponent(id)}/archive`, { archived: !company.archived }); await refreshCompanies(); toast(company.archived ? '客户已恢复。' : '客户已归档，后续仍会查重。'); }
    else if (action === 'company-draft') await prepareDraft(company || await api(`/api/companies/${encodeURIComponent(id)}`), button);
    else if (action === 'browser-company' && company) {
      state.browser = await api('/api/browser/takeover', {}); renderBrowser();
      state.browser = await api('/api/browser/navigate', { url: company.website }); renderBrowser(); refreshFrame(); closeModal();
    }
    else if (action === 'task') await showTask(id);
    else if (action.startsWith('task-')) { const verb = action.slice(5); await api(`/api/tasks/${encodeURIComponent(id)}/${verb}`, {}); state.tasks = await api('/api/tasks'); renderTasks(); toast(verb === 'pause' ? '任务已暂停，进度已保存。' : verb === 'cancel' ? '任务已取消，已发现资料仍保留。' : '正在从存档进度继续。'); }
    else if (action === 'draft' && draft) showDraft(draft);
    else if (action === 'draft-edit' && draft) draftEditor(draft);
    else if (action.startsWith('draft-review-')) { const status = action.slice('draft-review-'.length); const updated = await api(`/api/drafts/${encodeURIComponent(id)}/review`, { status }); state.drafts = await api('/api/drafts'); renderDrafts(); showDraft(updated); toast(status === 'approved' ? '这份草稿已批准，审批记录已保存。' : '草稿已退回，可编辑新版本。'); }
  });
});
async function initialize() {
  try {
    const bootstrap = await api('/api/bootstrap');
    state.token = bootstrap.token; state.profile = bootstrap.profile || { facts: {}, version: 0 }; state.capabilities = bootstrap.capabilities || {};
    if (!state.token) throw Object.assign(new Error('Session token is missing'), { code: 'unauthorized' });
    renderProfile(); await refreshAll();
  } catch (error) { connected(false); toast(humanError(error), true); renderProfile(); renderCompanies(); renderTasks(); renderDrafts(); renderBackups(); renderBrowser(); }
}
await initialize();
setInterval(() => { if (!document.hidden) refreshAll({ quiet: true }); }, 4500);
setInterval(refreshFrame, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll({ quiet: true }); });
