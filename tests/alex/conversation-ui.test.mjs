import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { createAlexServer } from '../../apps/alex/server.mjs';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function until(check) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Conversation UI operation did not finish');
}
async function workbench(t, llm) {
  const directory = await mkdtemp(join(tmpdir(), 'alex-chat-ui-'));
  const app = await createAlexServer({ dataDir: directory, allowLocalTest: true, llm });
  const base = await listen(app.server);
  const browser = await chromium.launch({ executablePath: process.env.ALEX_CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  await page.goto(base);
  await page.locator('#connection-label').filter({ hasText: '持续存档' }).waitFor();
  return { app, page, errors };
}

test('multi-turn workbench restores the exact proposal and launches one real fixture task across reloads', async t => {
  let fixtureBase;
  const planningInputs = [];
  const fixture = http.createServer(async (req, res) => {
    if (req.url === '/company') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>Controlled Chat Supplier</title><h1>Controlled Chat Supplier</h1><p>This is a controlled test company, not a real prospect. Precision fasteners distributor.</p><a href="mailto:trade@controlled-supplier.test">trade@controlled-supplier.test</a>');
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    let answer;
    if (data.messages[0].content.startsWith('You plan trade customer')) {
      const input = JSON.parse(data.messages[1].content);
      planningInputs.push(input);
      answer = planningInputs.length === 1
        ? { criteria: { product: '精密紧固件', count: 1 }, missing: ['market', 'customerType'], questions: ['希望研究哪个市场和哪类客户？'], profileUpdates: {}, profileEvidence: {}, plan: [] }
        : { criteria: { product: '精密紧固件', market: '德国', customerType: '进口商', count: 1, urls: [`${fixtureBase}/company`] }, missing: [], questions: [], profileUpdates: {}, profileEvidence: {}, plan: ['访问用户指定官网并保存实际证据'] };
    } else answer = { status: 'needs_review', reason: 'Controlled fixture requires manual review.', citations: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  });
  fixtureBase = await listen(fixture);
  t.after(async () => { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); });
  const { app, page, errors } = await workbench(t, { baseUrl: `${fixtureBase}/v1`, model: 'controlled-fixture', apiKey: 'controlled-model-fixture' });
  await page.locator('#request').fill('产品是精密紧固件');
  await page.locator('#plan-button').click();
  await page.locator('.from-alex').filter({ hasText: '哪个市场' }).waitFor();
  assert.equal(app.store.listTasks().length, 0);
  await page.locator('#request').fill(`这次先核验德国进口商，1家：${fixtureBase}/company`);
  await page.locator('#plan-button').click();
  await page.locator('#start-plan').waitFor();
  assert.equal(planningInputs.length, 2);
  assert.equal(planningInputs[1].history.filter(item => item.role === 'user')[0].content, '产品是精密紧固件');
  assert.equal(app.store.listTasks().length, 0);
  assert.deepEqual(app.store.getProfile().facts, {});
  const conversation = app.store.listConversations()[0];
  assert.equal(app.store.listMessages(conversation.id).length, 4);
  await page.reload();
  await page.locator('#start-plan').waitFor();
  assert.equal(await page.locator('.from-alex').count(), 2);
  await page.locator('#start-plan').click();
  await until(() => app.store.listCompanies().length === 1);
  const task = app.store.listTasks()[0];
  assert.equal(task.criteria.product, '精密紧固件');
  assert.equal(task.criteria.market, '德国');
  assert.deepEqual(task.criteria.urls, [`${fixtureBase}/company`]);
  assert.equal(app.store.listCompanies()[0].name, 'Controlled Chat Supplier');
  await page.reload();
  await page.locator('#start-plan').waitFor();
  await page.locator('#start-plan').click();
  await page.locator('#tasks-list').filter({ hasText: task.request }).waitFor();
  assert.equal(app.store.listTasks().length, 1);
  assert.equal(app.store.listTasks()[0].id, task.id);
  assert.deepEqual(errors, []);
});

test('unconfigured conversation UI archives the user turn without a fabricated assistant reply', async t => {
  const { app, page, errors } = await workbench(t, { apiKey: '' });
  await page.locator('#request').fill('我想先介绍我的实际产品，再决定目标客户');
  await page.locator('#plan-button').click();
  await page.locator('.from-user').filter({ hasText: '实际产品' }).waitFor();
  await page.locator('#plan-structured').waitFor();
  assert.equal(await page.locator('.from-alex').count(), 0);
  assert.equal(app.store.listTasks().length, 0);
  await page.reload();
  await page.locator('.from-user').filter({ hasText: '实际产品' }).waitFor();
  assert.equal(await page.locator('.from-alex').count(), 0);
  assert.equal(app.store.listMessages(app.store.listConversations()[0].id).length, 1);
  assert.deepEqual(errors, []);
});

test('creating a conversation blocks overlapping submission until the new session is selected', async t => {
  const { app, page, errors } = await workbench(t, { apiKey: '' });
  await page.locator('#request').fill('这是旧会话里的消息');
  await page.locator('#plan-button').click();
  await page.locator('#plan-structured').waitFor();
  const previous = app.store.listConversations()[0];
  let received = false, release;
  const barrier = new Promise(resolve => { release = resolve; });
  await page.route('**/api/conversations', async route => {
    if (route.request().method() === 'POST') { received = true; await barrier; }
    await route.continue();
  });
  await page.locator('#new-conversation').click();
  await until(() => received);
  assert.equal(await page.locator('#plan-button').isDisabled(), true);
  assert.equal(await page.locator('#request').isDisabled(), true);
  assert.equal(await page.locator('#conversation-select').isDisabled(), true);
  await page.locator('#plan-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(app.store.listMessages(previous.id).length, 1);
  release();
  await until(async () => !await page.locator('#request').isDisabled());
  const selectedId = await page.locator('#conversation-select').inputValue();
  assert.notEqual(selectedId, previous.id);
  await page.locator('#request').fill('这条消息只属于新会话');
  await page.locator('#plan-button').click();
  await page.locator('.from-user').filter({ hasText: '只属于新会话' }).waitFor();
  assert.equal(app.store.listMessages(previous.id).length, 1);
  assert.equal(app.store.listMessages(selectedId).length, 1);
  assert.equal(app.store.listMessages(selectedId)[0].content, '这条消息只属于新会话');
  assert.deepEqual(errors, []);
});
