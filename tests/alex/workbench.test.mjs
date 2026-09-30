import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createAlexServer } from '../../apps/alex/server.mjs';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Expected workbench operation did not complete');
}

test('Chinese workbench stores a user-defined business, researches an actual fixture browser, exports evidence and archives without duplicates', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alex-workbench-'));
  const fixture = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Controlled Trade Fixture</title><h1>Controlled Trade Fixture</h1><p>A controlled test catalog for precision tooling. Contact sales@controlledtrade.test and +49 123 456789.</p><button style="position:absolute;left:20px;top:220px;width:200px;height:50px" onclick="this.textContent=\'Human action completed\'">Test browser control</button>');
  });
  const website = await listen(fixture);
  const app = await createAlexServer({ dataDir: join(directory, 'data'), allowLocalTest: true, llm: { apiKey: '' } });
  const base = await listen(app.server);
  const browser = await chromium.launch({ executablePath: app.browser.executablePath, headless: true });
  t.after(async () => { await browser.close(); await app.close(); await new Promise(resolve => fixture.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  assert.match(await page.title(), /Alex/u);
  await page.locator('#structured-open').click();
  await page.locator('#structured-form [name=product]').fill('Precision tooling');
  await page.locator('#structured-form [name=market]').fill('Germany');
  await page.locator('#structured-form [name=customerType]').fill('Distributors');
  await page.locator('#structured-form [name=count]').fill('1');
  await page.locator('#structured-form [name=urls]').fill(website);
  await page.locator('#structured-form [name=remember]').check();
  await page.locator('#structured-form button[type=submit]').click();
  await until(() => app.store.listTasks().some(task => task.status === 'completed'));
  assert.equal(app.store.listCompanies().length, 1);
  assert.equal(app.store.getProfile().facts.product, 'Precision tooling');
  await page.reload({ waitUntil: 'networkidle' });
  assert.match(await page.locator('#profile-summary').innerText(), /Precision tooling/u);
  await page.locator('[data-tab=companies]').click();
  await page.locator('[data-action=company]').click();
  assert.match(await page.locator('#modal-body').innerText(), /sales@controlledtrade\.test/u);
  assert.match(await page.locator('#modal-body').innerText(), /127\.0\.0\.1/u);
  await page.locator('#modal-close').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const download = await downloadPromise;
  assert.match(await readFile(await download.path(), 'utf8'), /sales@controlledtrade\.test/u);
  await page.locator('[data-action=archive]').click();
  await until(() => app.store.listCompanies().length === 0);
  assert.equal(app.store.listCompanies({ includeArchived: true }).length, 1);
  await page.locator('#include-archived').check();
  await page.locator('[data-action=company]').waitFor();
  assert.match(await page.locator('#companies-list').innerText(), /已归档/u);
  await page.locator('[data-tab=backups]').click();
  await page.locator('#backup-button').click();
  await page.locator('#backups-list .record-card').waitFor();
  await page.locator('#takeover-button').click();
  await page.locator('#release-button').waitFor();
  assert.equal(app.browser.state().owner, 'human');
  assert.equal(await page.locator('#browser-frame').isVisible(), true);
  const dimensions = await page.locator('#browser-frame').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
  assert.equal(dimensions.width, 1280);
  assert.equal(dimensions.height, 800);
  await page.locator('#release-button').click();
  await until(() => app.browser.state().owner === 'agent');
  assert.deepEqual(errors, []);
});
