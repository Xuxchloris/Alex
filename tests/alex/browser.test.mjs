import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BrowserController } from '../../services/alex-browser/index.mjs';

async function fixture() {
  const requests = [];
  const methods = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    methods.push({ url: req.url, method: req.method });
    if (req.url === '/redirect-private') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      return res.end();
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/company' });
      return res.end();
    }
    if (req.url === '/form') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<title>Form fixture</title><form method="POST" action="/submit"><input name="query" value="manual search"><button style="position:absolute;left:20px;top:80px;width:120px;height:35px">Submit</button></form>');
    }
    if (req.url === '/unsafe-assets') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<title>Safety fixture</title><img src="http://169.254.169.254/latest/meta-data/" onerror="window.assetBlocked=true"><iframe src="http://10.1.2.3/"></iframe><button id="popup" onclick="window.open(\'/popup\')">Popup</button>');
    }
    if (req.url === '/slow') return setTimeout(() => { res.end('<title>Slow</title>'); }, 1500);
    if (req.url === '/fail') { res.writeHead(503); return res.end('Unavailable'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><title>Real fixture company</title></head><body>
      <h1>Fixture Manufacturing</h1><p>Verified fixture contact: sales@fixture.test</p>
      <a href="mailto:sales@fixture.test">Email</a><a href="tel:+1-212-555-0100">Phone</a>
      <a href="/contact">Contact</a><input style="position:absolute;left:20px;top:210px;width:240px;height:35px" id="name">
      <button style="position:absolute;left:20px;top:270px;width:120px;height:35px" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Apply</button>
      <p id="result"></p><button id="popup" onclick="window.open('/popup')">Popup</button>
      <div style="height:2000px">Scroll target</div></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, methods, url: `http://127.0.0.1:${server.address().port}` };
}

test('real Chromium navigates, extracts, screenshots, transfers control and resumes in one session', async t => {
  const f = await fixture();
  const browser = new BrowserController({ allowLocalTest: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => f.server.close(resolve)); });
  const initial = await browser.start();
  assert.equal(initial.available, true);
  const session = initial.sessionId;
  await browser.navigate(`${f.url}/redirect`);
  assert.equal(browser.state().url, `${f.url}/company`);
  const data = await browser.extract();
  assert.equal(data.title, 'Real fixture company');
  assert.ok(data.text.includes('Fixture Manufacturing'));
  assert.ok(data.emails.includes('sales@fixture.test'));
  assert.ok(data.phones.includes('+1-212-555-0100'));
  assert.ok(data.links.some(link => link.url === `${f.url}/contact`));
  const screenshot = await browser.screenshot();
  assert.equal(screenshot[0], 0xff);
  assert.equal(screenshot[1], 0xd8);
  await browser.takeover();
  await assert.rejects(browser.navigate(`${f.url}/agent-must-not-visit`), { code: 'human_has_control' });
  await assert.rejects(browser.act({ type: 'key', key: 'Enter' }, { actor: 'agent' }), { code: 'human_has_control' });
  await browser.act({ type: 'click', x: 80, y: 230 });
  await browser.act({ type: 'type', text: 'Human takeover works' });
  await browser.act({ type: 'click', x: 65, y: 285 });
  assert.ok((await browser.extract({ actor: 'human' })).text.includes('Human takeover works'));
  await browser.act({ type: 'scroll', deltaY: 250 });
  await browser.act({ type: 'key', key: 'Home' });
  await browser.release();
  await assert.rejects(browser.act({ type: 'type', text: 'wrong actor' }), { code: 'agent_has_control' });
  await browser.navigate(`${f.url}/contact`);
  assert.equal(browser.state().sessionId, session);
  assert.equal(browser.state().owner, 'agent');
  assert.equal(f.requests.includes('/agent-must-not-visit'), false);
});

test('browser denies private addresses and unsupported schemes before networking', async t => {
  const browser = new BrowserController();
  t.after(() => browser.close());
  for (const url of ['http://127.0.0.1/', 'http://10.1.2.3/', 'http://169.254.169.254/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'file:///etc/passwd', 'data:text/html,hello', 'http://user:password@example.com']) {
    await assert.rejects(browser.validateUrl(url), { code: 'unsafe_url' });
  }
  const testBrowser = new BrowserController({ allowLocalTest: true });
  await assert.rejects(testBrowser.validateUrl('http://10.1.2.3/'), { code: 'unsafe_url' });
  assert.equal(await testBrowser.validateUrl('http://127.0.0.1:1234/'), 'http://127.0.0.1:1234/');
  for (const url of ['http://192.0.78.17/', 'http://192.2.1.2/', 'http://198.51.1.2/', 'http://203.0.1.2/']) assert.equal(await browser.validateUrl(url), url);
  for (const url of ['http://192.0.2.1/', 'http://198.51.100.2/', 'http://203.0.113.2/']) await assert.rejects(browser.validateUrl(url), { code: 'unsafe_url' });
});

test('private redirect is blocked, HTTP failure keeps prior URL and takeover interrupts agent navigation', async t => {
  const f = await fixture();
  const browser = new BrowserController({ allowLocalTest: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => f.server.close(resolve)); });
  await browser.navigate(`${f.url}/company`);
  const prior = browser.state().url;
  await assert.rejects(browser.navigate(`${f.url}/redirect-private`), { code: 'navigation_failed' });
  assert.equal(browser.state().url, prior);
  await assert.rejects(browser.navigate(`${f.url}/fail`), { code: 'navigation_failed' });
  assert.equal(browser.state().url, prior);
  await assert.rejects(browser.extract(), { code: 'page_unavailable' });
  assert.equal(browser.state().url, prior);
  const pending = browser.navigate(`${f.url}/slow`).then(() => null, failure => failure);
  await new Promise(resolve => setTimeout(resolve, 100));
  await browser.takeover();
  const failure = await pending;
  assert.ok(failure);
  assert.equal(browser.state().owner, 'human');
  await browser.navigate(`${f.url}/contact`, { actor: 'human' });
  assert.equal(browser.state().url, `${f.url}/contact`);
});

test('inspect keeps navigation and extraction atomic against concurrent operations', async t => {
  const f = await fixture();
  const browser = new BrowserController({ allowLocalTest: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => f.server.close(resolve)); });
  const [first, second] = await Promise.all([browser.inspect(`${f.url}/company`), browser.inspect(`${f.url}/contact`)]);
  assert.equal(first.url, `${f.url}/company`);
  assert.equal(second.url, `${f.url}/contact`);
});


test('private subresources are rejected and popups cannot create a second controlled session', async t => {
  const f = await fixture();
  const browser = new BrowserController({ allowLocalTest: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => f.server.close(resolve)); });
  const checked = [];
  const validate = browser.validateUrl.bind(browser);
  browser.validateUrl = async url => { checked.push(url); return validate(url); };
  await browser.navigate(`${f.url}/unsafe-assets`);
  await browser.page.waitForFunction(() => window.assetBlocked === true);
  assert.ok(checked.includes('http://169.254.169.254/latest/meta-data/'));
  assert.ok(checked.includes('http://10.1.2.3/'));
  await browser.page.locator('#popup').click();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(browser.context.pages().length, 1);
  assert.equal(f.requests.includes('/popup'), false);
});

test('takeover drains in-flight input and revokes queued agent operations before acknowledging', async t => {
  const f = await fixture();
  const browser = new BrowserController({ allowLocalTest: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => f.server.close(resolve)); });
  await browser.navigate(`${f.url}/company`);
  let finish, started;
  const finished = new Promise(resolve => { finish = resolve; });
  const inputStarted = new Promise(resolve => { started = resolve; });
  const original = browser.page.keyboard.insertText.bind(browser.page.keyboard);
  browser.page.keyboard.insertText = async text => { started(); await finished; return original(text); };
  const inFlight = browser.act({ type: 'type', text: 'in-flight' }, { actor: 'agent' }).catch(failure => failure);
  await inputStarted;
  const queued = browser.navigate(`${f.url}/must-not-visit`).catch(failure => failure);
  let acknowledged = false;
  const takeover = browser.takeover().then(value => { acknowledged = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(acknowledged, false);
  finish();
  await takeover;
  assert.equal((await inFlight).code, 'human_has_control');
  assert.equal((await queued).code, 'human_has_control');
  assert.equal(f.requests.includes('/must-not-visit'), false);
  assert.equal(browser.state().owner, 'human');
});

test('proxy DNS fallback accepts only validated IP answers and refuses private answers', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const browser = new BrowserController({ proxyServer: 'http://127.0.0.1:3128' });
  browser.proxyDnsRequired = true;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const type = Number(new URL(url).searchParams.get('type'));
    return { ok: true, json: async () => ({ Status: 0, Answer: type === 1 ? [{ type: 1, data: '151.101.192.223' }] : [] }) };
  };
  assert.equal(await browser.validateUrl('https://www.python.org/'), 'https://www.python.org/');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => new URL(call.url).origin === 'https://dns.google' && call.options.redirect === 'error'));
  globalThis.fetch = async url => ({ ok: true, json: async () => ({ Status: 0, Answer: Number(new URL(url).searchParams.get('type')) === 1 ? [{ type: 1, data: '10.1.2.3' }] : [] }) });
  await assert.rejects(browser.validateUrl('https://www.python.org/'), { code: 'unsafe_url' });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ Status: 0, Answer: [{ type: 1, data: 'not-an-ip' }] }) });
  await assert.rejects(browser.validateUrl('https://www.python.org/'), { code: 'dns_unavailable' });
});


test('agent browser transport rejects POST while human takeover can submit an intentional form', async t => {
  const f = await fixture();
  const browser = new BrowserController({ allowLocalTest: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => f.server.close(resolve)); });
  await browser.navigate(`${f.url}/form`);
  await browser.act({ type: 'click', x: 70, y: 95 }, { actor: 'agent' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.methods.some(request => request.url === '/submit' && request.method === 'POST'), false);
  assert.equal(browser.state().url, `${f.url}/form`);
  await browser.takeover();
  await browser.navigate(`${f.url}/form`, { actor: 'human' });
  await browser.act({ type: 'click', x: 70, y: 95 }, { actor: 'human' });
  await browser.page.waitForURL(`${f.url}/submit`);
  assert.equal(f.methods.some(request => request.url === '/submit' && request.method === 'POST'), true);
});

test('closing while Chromium starts reclaims the newly launched context', async () => {
  const browser = new BrowserController();
  const started = browser.start();
  const closed = browser.close();
  await Promise.allSettled([started, closed]);
  assert.equal(browser.state().available, false);
  assert.equal(browser.context, null);
  assert.equal(browser.dataDir, undefined);
});
