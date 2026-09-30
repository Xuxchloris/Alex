import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { TradeStore } from '../../packages/alex-core/index.mjs';
import { ResearchRunner } from '../../services/alex-research/index.mjs';

// Controlled fixtures test orchestration only. They are never a live customer discovery claim.
const COMPANY_A = 'http://127.0.0.1:34561/company-a';
const COMPANY_B = 'http://127.0.0.2:34561/company-b';
const profile = { product: 'precision bearings', market: 'Canada', customerType: 'distributors' };
const fixturePage = (url = COMPANY_A) => ({ url, title: 'Fixture Bearing Company | Official', text: 'Fixture Bearing Company supplies precision bearings. Contact sales@fixture-business.test or +1 555 555 0100.', links: [], emails: ['sales@fixture-business.test', 'invented@fixture-business.test'], phones: ['+1 555 555 0100', '+1 555 000 0000'] });

function fixture(browser = {}) {
  const store = new TradeStore({ path: ':memory:', allowLocalTest: true });
  const calls = [];
  const controller = { owner: 'agent', state() { return { owner: this.owner }; }, async inspect(url) { calls.push(url); return fixturePage(url); }, ...browser };
  return { store, browser: controller, calls, runner: new ResearchRunner({ store, browser: controller }) };
}

async function modelServer(response) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const value = typeof response === 'function' ? response(parsed) : response;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, config: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture-model', apiKey: 'fixture-key-not-secret' }, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('no model reports unavailable, reads profile, and never installs preset industry or market', async () => {
  const { store, runner, calls } = fixture();
  try {
    const initial = await runner.plan('帮我找客户');
    assert.equal(initial.status, 'unavailable');
    assert.equal(initial.code, 'model_unavailable');
    assert.deepEqual(initial.missing, ['product', 'market', 'customerType']);
    assert.deepEqual(initial.criteria, { count: 5 });
    store.saveProfile(profile);
    const next = await runner.plan('继续上次的方案');
    assert.deepEqual(next.criteria, { ...profile, count: 5 });
    assert.deepEqual(next.missing, []);
    assert.deepEqual(calls, []);
    assert.equal(store.listCompanies().length, 0);
  } finally { store.close(); }
});

test('model planning sees saved facts and memories; explicit quoted updates are versioned', async () => {
  const { store, browser } = fixture();
  const model = await modelServer({ criteria: { ...profile, market: 'Japan', count: 3 }, missing: [], questions: [], profileUpdates: { market: 'Japan' }, profileEvidence: { market: '长期目标市场改成 Japan' }, plan: ['读取已有客户并核验公司官网'] });
  try {
    store.saveProfile(profile);
    store.addMemory({ type: 'exclusion', content: 'Exclude existing archived customers.' });
    const runner = new ResearchRunner({ store, browser, llm: model.config });
    const planned = await runner.plan('我的长期目标市场改成 Japan，继续找客户。');
    assert.equal(planned.status, 'ready');
    assert.equal(store.getProfile().facts.market, 'Japan');
    assert.equal(store.getProfile().version, 2);
    const sent = JSON.parse(model.requests[0].messages[1].content);
    assert.equal(sent.savedProfile.product, profile.product);
    assert.equal(sent.memories[0].content, 'Exclude existing archived customers.');
    assert.ok(store.listMemories().some(item => item.type === 'profile_confirmation'));
  } finally { await model.close(); store.close(); }
});

test('invalid model facts and invented URLs fail validation without changing memory', async () => {
  const { store, browser } = fixture();
  const model = await modelServer({ criteria: { ...profile, count: 1 }, missing: [], questions: [], profileUpdates: { product: 'aircraft' }, profileEvidence: { product: 'not present in request' }, plan: [] });
  try {
    const runner = new ResearchRunner({ store, browser, llm: model.config });
    await assert.rejects(runner.plan('继续找客户'), error => error.code === 'invalid_plan');
    assert.equal(store.getProfile().version, 0);
    assert.equal(store.listMemories().length, 0);
  } finally { await model.close(); store.close(); }
});

test('plan canonicalizes actual user URLs and rejects fabricated source paths', async () => {
  const { store, browser } = fixture();
  let url = 'https://trade-fixture.test/';
  const model = await modelServer(() => ({ criteria: { urls: [url], count: 1 }, missing: ['product', 'market', 'customerType'], questions: [], profileUpdates: {}, profileEvidence: {}, plan: ['核验用户给定官网'] }));
  try {
    const runner = new ResearchRunner({ store, browser, llm: model.config });
    const plan = await runner.plan('先看看 https://trade-fixture.test。');
    assert.deepEqual(plan.criteria.urls, ['https://trade-fixture.test/']);
    assert.equal(plan.questions.length, 3);
    url = 'https://trade-fixture.test/invented';
    await assert.rejects(runner.plan('先看看 https://trade-fixture.test。'), error => error.code === 'invalid_plan');
  } finally { await model.close(); store.close(); }
});

test('provided URLs save observed provenance, omit invented contacts, and dedupe archived customers', async () => {
  const { store, runner } = fixture();
  try {
    const task = store.createTask({ request: '核验给定网址', criteria: { urls: [COMPANY_A], count: 1 } });
    const result = await runner.run(task.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.result.needsReviewCount, 1);
    const company = store.listCompanies()[0];
    assert.equal(company.country, '');
    assert.equal(company.evidence[0].url, COMPANY_A);
    assert.equal(company.source, 'website');
    assert.ok(company.contacts.some(item => item.value === 'sales@fixture-business.test'));
    assert.ok(!company.contacts.some(item => item.value.includes('invented') || item.value.includes('000 0000')));
    store.archiveCompany(company.id);
    const repeat = store.createTask({ request: '再次核验', criteria: { urls: [COMPANY_A], count: 1 } });
    await runner.run(repeat.id);
    assert.equal(store.listCompanies({ includeArchived: true }).length, 1);
    assert.equal(store.getTask(repeat.id).result.companies[0].companyId, company.id);
    assert.equal(store.getTask(repeat.id).result.companies[0].created, false);
  } finally { store.close(); }
});

test('contact-page title changes enrich the known company only when its name is actually observed', async () => {
  const contact = 'http://127.0.0.1:34561/contact';
  const { store, runner } = fixture({ async inspect(url) { return { ...fixturePage(url), title: url === contact ? 'Contact Us' : fixturePage(url).title }; } });
  try {
    const first = store.createTask({ request: 'home fixture', criteria: { urls: [COMPANY_A], count: 1 } });
    await runner.run(first.id);
    const companyId = store.listCompanies()[0].id;
    const second = store.createTask({ request: 'contact fixture', criteria: { urls: [contact], count: 1 } });
    await runner.run(second.id);
    assert.equal(store.getTask(second.id).result.companies[0].companyId, companyId);
    assert.equal(store.listCompanies().length, 1);
    assert.equal(store.getCompany(companyId).name, 'Fixture Bearing Company');
    assert.ok(store.getCompany(companyId).evidence.some(item => item.title === 'Contact Us' && item.url === contact));
    runner.browser.inspect = async url => ({ ...fixturePage(url), title: 'Other Legal Entity', text: 'Other Legal Entity manufactures unrelated industrial machinery. Contact info is unconfirmed.' });
    const conflicting = store.createTask({ request: 'other entity fixture', criteria: { urls: [contact], count: 1 } });
    await runner.run(conflicting.id);
    assert.equal(store.getTask(conflicting.id).result.actualCount, 0);
    assert.equal(store.listCompanies().length, 1);
    assert.equal(store.getCompany(companyId).name, 'Fixture Bearing Company');
  } finally { store.close(); }
});

test('captcha and proxy failures produce blocked without fallback; an explicit retry uses changed source', async () => {
  let blocked = true;
  const { store, runner, calls } = fixture({ async inspect(url) { calls.push(url); if (blocked) return { url, title: 'Access denied', text: 'Verify you are human: captcha', links: [] }; return fixturePage(url); } });
  try {
    const task = store.createTask({ request: '核验', criteria: { urls: [COMPANY_A], count: 1 } });
    const denied = await runner.run(task.id);
    assert.equal(denied.status, 'blocked');
    assert.equal(store.listCompanies().length, 0);
    assert.deepEqual(denied.checkpoint.completedUrls, []);
    blocked = false;
    const recovered = await runner.run(task.id);
    assert.equal(recovered.status, 'completed');
    assert.equal(store.listCompanies().length, 1);
    assert.equal(calls.length, 2);
  } finally { store.close(); }
});

test('pause during navigation prevents writes; resume skips already completed URLs', async () => {
  let release;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const { store, runner, calls } = fixture({ async inspect(url) { calls.push(url); if (url === COMPANY_B) { signalStarted(); await new Promise(resolve => { release = resolve; }); } return fixturePage(url); } });
  try {
    const task = store.createTask({ request: '核验两个网址', criteria: { urls: [COMPANY_A, COMPANY_B], count: 2 } });
    const pending = runner.run(task.id);
    await started;
    runner.pause(task.id);
    release();
    assert.equal((await pending).status, 'paused');
    assert.equal(store.listCompanies().length, 1);
    assert.deepEqual(store.getTask(task.id).checkpoint.completedUrls, [COMPANY_A]);
    let finishSecond;
    const continued = runner.run(task.id);
    // Replace blocking fixture before the next queued inspect begins.
    runner.browser.inspect = async url => { calls.push(url); return fixturePage(url); };
    finishSecond = await continued;
    assert.equal(finishSecond.status, 'completed');
    assert.equal(calls.filter(url => url === COMPANY_A).length, 1);
    assert.equal(store.listCompanies().length, 2);
  } finally { store.close(); }
});

test('queued cancellation remains terminal, and browser jobs are serialized', async () => {
  let release;
  let startFirst;
  const firstStarted = new Promise(resolve => { startFirst = resolve; });
  let active = 0;
  let maxActive = 0;
  const { store, runner, calls } = fixture({ async inspect(url) { calls.push(url); active++; maxActive = Math.max(active, maxActive); if (url === COMPANY_A) { startFirst(); await new Promise(resolve => { release = resolve; }); } active--; return fixturePage(url); } });
  try {
    const first = store.createTask({ request: 'first', criteria: { urls: [COMPANY_A], count: 1 } });
    const second = store.createTask({ request: 'second', criteria: { urls: [COMPANY_B], count: 1 } });
    const pending = runner.run(first.id);
    await firstStarted;
    const queued = runner.run(second.id);
    runner.cancel(second.id);
    release();
    await pending;
    assert.equal((await queued).status, 'cancelled');
    assert.equal(maxActive, 1);
    assert.ok(!calls.includes(COMPANY_B));
    assert.equal(store.listCompanies().length, 1);
  } finally { store.close(); }
});

test('human takeover pauses evidence persistence and resumes the same task after release', async () => {
  const { store, runner, browser, calls } = fixture();
  try {
    browser.owner = 'human';
    const task = store.createTask({ request: '核验', criteria: { urls: [COMPANY_A], count: 1 } });
    const waiting = await runner.run(task.id);
    assert.equal(waiting.status, 'waiting_for_user');
    assert.equal(calls.length, 0);
    assert.equal(store.listCompanies().length, 0);
    browser.owner = 'agent';
    assert.equal((await runner.run(task.id)).status, 'completed');
  } finally { store.close(); }
});

test('search consumes actual observed outbound links then company evidence; no arbitrary fallback URL', async () => {
  const { store, runner, calls } = fixture({ async inspect(url) { calls.push(url); if (url.includes('duckduckgo.com')) return { url, title: 'Search', text: 'Observed fixture search page with results', links: [{ text: 'Bearing distributor', url: `https://duckduckgo.com/l/?uddg=${encodeURIComponent(COMPANY_A)}` }, { text: 'Social result', url: 'https://linkedin.com/company/fixture' }] }; return fixturePage(url); } });
  try {
    const task = store.createTask({ request: 'structured fixture search', criteria: { ...profile, count: 1 } });
    const done = await runner.run(task.id);
    assert.equal(done.status, 'completed');
    assert.ok(calls[0].startsWith('https://html.duckduckgo.com/html/?q='));
    assert.ok(calls.includes(COMPANY_A));
    assert.ok(!calls.some(url => url.includes('linkedin')));
    const company = store.listCompanies()[0];
    assert.equal(company.evidence[0].url, COMPANY_A);
    assert.ok(company.evidence.some(item => item.source === 'search' && item.url.startsWith('https://html.duckduckgo.com/')));
  } finally { store.close(); }
});

test('new-customer search excludes existing and archived companies rather than counting them again', async () => {
  const { store, runner, calls } = fixture({ async inspect(url) { calls.push(url); if (url.includes('duckduckgo.com')) return { url, title: 'Search', text: 'Controlled fixture search results', links: [{ text: 'Known bearing distributor', url: COMPANY_A }] }; return fixturePage(url); } });
  try {
    const first = store.createTask({ request: 'known fixture', criteria: { urls: [COMPANY_A], count: 1 } });
    await runner.run(first.id);
    store.archiveCompany(store.listCompanies()[0].id);
    const second = store.createTask({ request: 'find new fixture', criteria: { ...profile, count: 1 } });
    const outcome = await runner.run(second.id);
    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.result.actualCount, 0);
    assert.equal(calls.filter(url => url === COMPANY_A).length, 1);
    assert.ok(store.listEvents(second.id).some(event => event.type === 'known_company_skipped' && event.detail.archived));
    assert.equal(store.listCompanies({ includeArchived: true }).length, 1);
    runner.browser.inspect = async url => url.includes('duckduckgo.com') ? { url, title: 'Search', text: 'Observed fixture redirect search', links: [{ text: 'Candidate with redirected identity', url: COMPANY_B }] } : fixturePage(COMPANY_A);
    const redirected = store.createTask({ request: 'redirect fixture search', criteria: { ...profile, count: 1 } });
    const redirectOutcome = await runner.run(redirected.id);
    assert.equal(redirectOutcome.result.actualCount, 0);
    assert.ok(store.listEvents(redirected.id).some(event => event.type === 'known_company_skipped' && event.detail.reason === 'redirect_identity'));
    assert.equal(store.listCompanies({ includeArchived: true }).length, 1);
  } finally { store.close(); }
});

test('exclusion found only in actual company page prevents customer persistence', async () => {
  const { store, runner, calls } = fixture({ async inspect(url) {
    calls.push(url);
    if (url.includes('duckduckgo.com')) return { url, title: 'Search', text: 'Controlled search fixture', links: [{ text: 'Precision bearings distributor', url: COMPANY_A }] };
    return { ...fixturePage(url), text: `${fixturePage(url).text} We exclusively supply retail consumers.` };
  } });
  try {
    const task = store.createTask({ request: 'keyword fixture search', criteria: { ...profile, count: 1, excludeKeywords: ['retail consumers'] } });
    const result = await runner.run(task.id);
    assert.ok(calls.includes(COMPANY_A));
    assert.equal(result.status, 'partial');
    assert.equal(result.result.actualCount, 0);
    assert.equal(store.listCompanies().length, 0);
    const rejected = store.listEvents(task.id).find(event => event.type === 'candidate_rejected');
    assert.equal(rejected.detail.qualification.status, 'not_matched');
    assert.ok(rejected.detail.qualification.citations.some(quote => quote.includes('retail consumers')));
  } finally { store.close(); }
});

test('missing include keyword cannot become matched; model receives actual keyword constraints', async () => {
  const { store, browser } = fixture();
  const model = await modelServer({ status: 'matched', reason: 'The observed page explicitly supplies precision bearings.', citations: ['Fixture Bearing Company supplies precision bearings.'] });
  try {
    const runner = new ResearchRunner({ store, browser, llm: model.config });
    const needsReview = await runner.qualify(fixturePage(), { ...profile, includeKeywords: ['hydraulic valves'], excludeKeywords: ['retail'] });
    assert.equal(needsReview.status, 'needs_review');
    assert.equal(model.requests.length, 0);
    const matched = await runner.qualify(fixturePage(), { ...profile, includeKeywords: ['precision bearings'], excludeKeywords: ['retail'] });
    assert.equal(matched.status, 'matched');
    const payload = JSON.parse(model.requests[0].messages[1].content);
    assert.deepEqual(payload.criteria.includeKeywords, ['precision bearings']);
    assert.deepEqual(payload.criteria.excludeKeywords, ['retail']);
  } finally { await model.close(); store.close(); }
});

test('shared directories cannot become one merged customer or substitute for company websites', async () => {
  const { store, runner } = fixture();
  try {
    const task = store.createTask({ request: 'directory fixture', criteria: { urls: ['https://yelp.com/biz/fixture-a', 'https://yelp.com/biz/fixture-b'], count: 2 } });
    const done = await runner.run(task.id);
    assert.equal(done.status, 'partial');
    assert.equal(done.result.actualCount, 0);
    assert.equal(store.listCompanies().length, 0);
    assert.equal(done.result.errors.filter(item => item.code === 'not_company_source').length, 2);
  } finally { store.close(); }
});

test('unsupported qualification claims remain needs_review, never invented customers or contacts', async () => {
  const { store, browser } = fixture();
  const model = await modelServer({ status: 'matched', reason: 'It is a Canadian distributor.', citations: ['A fabricated supporting quote.'] });
  try {
    const runner = new ResearchRunner({ store, browser, llm: model.config });
    const task = store.createTask({ request: 'qualify fixture', criteria: { ...profile, urls: [COMPANY_A], count: 1 } });
    const result = await runner.run(task.id);
    assert.equal(result.result.matchedCount, 0);
    assert.equal(result.result.needsReviewCount, 1);
    assert.equal(store.listCompanies()[0].country, '');
  } finally { await model.close(); store.close(); }
});

test('missing criteria and counts above budget fail explicitly before any navigation', async () => {
  const { store, runner, calls } = fixture();
  try {
    const missing = store.createTask({ request: 'find something', criteria: {} });
    assert.equal((await runner.run(missing.id)).status, 'unavailable');
    const excessive = store.createTask({ request: 'oversized', criteria: { ...profile, count: 21 } });
    assert.equal((await runner.run(excessive.id)).error.code, 'invalid_plan');
    assert.equal(calls.length, 0);
  } finally { store.close(); }
});

test('draft generation uses actual profile and company evidence and only saves a pending draft', async () => {
  const { store, browser, runner } = fixture();
  const model = await modelServer({ subject: 'Precision bearings supply', body: 'Hello Fixture Bearing Company, we supply precision bearings. [Sender name]' });
  try {
    const task = store.createTask({ request: 'website fixture', criteria: { urls: [COMPANY_A], count: 1 } });
    await runner.run(task.id);
    const companyId = store.listCompanies()[0].id;
    await assert.rejects(runner.prepareDraft(companyId), error => error.code === 'model_unavailable');
    assert.equal(store.listDrafts().length, 0);
    store.saveProfile(profile);
    const configured = new ResearchRunner({ store, browser, llm: model.config });
    const draft = await configured.prepareDraft(companyId, { taskId: task.id, request: '英文短邮件' });
    assert.equal(draft.status, 'pending');
    assert.equal(draft.companyId, companyId);
    const payload = JSON.parse(model.requests[0].messages[1].content);
    assert.equal(payload.profile.product, 'precision bearings');
    assert.equal(payload.company.evidence[0].url, COMPANY_A);
    assert.ok(payload.company.evidence[0].excerpt.includes('Fixture Bearing Company'));
    assert.equal(store.listDrafts().length, 1);
    assert.equal(store.getTask(task.id).status, 'completed');
  } finally { await model.close(); store.close(); }
});
