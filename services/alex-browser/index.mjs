import { chromium } from 'playwright-core';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function error(message, code = 'browser_error', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function blockedAddress(address) {
  const lower = address.toLowerCase().split('%')[0];
  if (isIP(lower) === 4) {
    const [a, b, c] = lower.split('.').map(Number);
    return lower === '168.63.129.16' || a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  if (isIP(lower) === 6) {
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) {
      const suffix = lower.slice(7);
      if (isIP(suffix) === 4) return blockedAddress(suffix);
      const chunks = suffix.split(':');
      if (chunks.length === 2) {
        const number = parseInt(chunks[0], 16) * 65536 + parseInt(chunks[1], 16);
        return blockedAddress([number >>> 24, (number >>> 16) & 255, (number >>> 8) & 255, number & 255].join('.'));
      }
      return true;
    }
    // Only global unicast IPv6 is routable for public research. Reject transition/tunnel ranges.
    return !/^[23][0-9a-f]{3}:/.test(lower) || lower.startsWith('2001:db8:') ||
      lower.startsWith('2001:0:') || lower.startsWith('2002:') || lower.startsWith('2001:2:');
  }
  return true;
}

async function lookupWithTimeout(host) {
  let timer;
  try {
    return await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS lookup timed out')), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
}

function loopback(address) {
  return address === '::1' || /^127\./.test(address);
}

function proxyConfiguration(value, allowLocalTest) {
  if (!value) return undefined;
  let parsed;
  try { parsed = new URL(value); } catch { throw error('Invalid egress proxy configuration.', 'invalid_proxy'); }
  if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol)) throw error('Unsupported egress proxy protocol.', 'invalid_proxy');
  return {
    server: `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) } : {}),
    ...(allowLocalTest ? { bypass: 'localhost,127.0.0.1,[::1]' } : {}),
  };
}

/** One isolated Chromium context is shared by agent research and human takeover. */
export class BrowserController {
  constructor({ executablePath, dataDir, proxyServer, allowLocalTest = false } = {}) {
    this.executablePath = executablePath || process.env.ALEX_CHROMIUM_PATH ||
      ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync) || chromium.executablePath();
    this.dataDir = dataDir;
    this.allowLocalTest = allowLocalTest;
    this.proxyServer = proxyServer ?? process.env.HTTPS_PROXY ?? process.env.https_proxy;
    this.sessionId = randomUUID();
    this.owner = 'agent';
    this.epoch = 0;
    this.context = null;
    this.page = null;
    this.currentUrl = '';
    this.currentTitle = '';
    this.lastError = null;
    this.tail = Promise.resolve();
    this.activeActor = null;
    this.starting = null;
    this.tempDataDir = false;
    this.proxyDnsRequired = false;
  }

  state() {
    return { sessionId: this.sessionId, url: this.currentUrl, title: this.currentTitle,
      owner: this.owner, available: Boolean(this.context && this.page && !this.page.isClosed()),
      error: this.lastError };
  }

  assertOwner(actor) {
    if (!['agent', 'human'].includes(actor)) throw error('Unknown browser actor.', 'invalid_actor');
    if (this.owner !== actor) throw error(this.owner === 'human' ? 'Human has control of the browser.' : 'Take over the browser before interacting.',
      this.owner === 'human' ? 'human_has_control' : 'agent_has_control', 409);
  }

  async validateUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw error('A valid HTTP(S) URL is required.', 'unsafe_url'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw error('Only HTTP(S) URLs without embedded credentials are allowed.', 'unsafe_url');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal') {
      throw error('Private network destinations are blocked.', 'unsafe_url');
    }
    let addresses;
    try {
      if (isIP(host)) addresses = [{ address: host }];
      else {
        if (this.proxyDnsRequired && this.proxyServer && host !== 'localhost') throw new Error('Proxy DNS required');
        addresses = await lookupWithTimeout(host);
      }
    }
    catch {
      // Some managed environments expose public DNS only through their HTTPS proxy.
      // Resolve via a fixed TLS-verified DoH service; never trust an unresolved hostname.
      if (!this.proxyServer) throw error('Destination DNS lookup failed.', 'dns_unavailable', 502);
      this.proxyDnsRequired = true;
      try {
        const answers = await Promise.all([1, 28].map(async type => {
          const response = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=${type}`, { signal: AbortSignal.timeout(8000), redirect: 'error' });
          if (!response.ok) throw new Error('DNS service unavailable');
          const result = await response.json();
          if (result.Status !== 0 || !Array.isArray(result.Answer)) return [];
          return result.Answer.filter(record => record.type === type && isIP(record.data) === (type === 1 ? 4 : 6)).map(record => ({ address: record.data }));
        }));
        addresses = answers.flat();
      } catch { throw error('Destination DNS lookup failed; configure public network access.', 'dns_unavailable', 502); }
    }
    if (!addresses.length) throw error('Destination has no usable DNS addresses.', 'dns_unavailable', 502);
    if (addresses.some(({ address }) => blockedAddress(address) && !(this.allowLocalTest && loopback(address)))) {
      throw error('Private network destinations are blocked.', 'unsafe_url');
    }
    return url.href;
  }

  async start() {
    if (this.context) return this.state();
    if (this.starting) return this.starting;
    this.starting = this._start();
    try { return await this.starting; } finally { this.starting = null; }
  }

  async _start() {
    try {
      if (!this.dataDir) {
        this.dataDir = await mkdtemp(join(tmpdir(), 'alex-browser-'));
        this.tempDataDir = true;
      } else { await mkdir(this.dataDir, { recursive: true }); }
      this.context = await chromium.launchPersistentContext(this.dataDir, {
        executablePath: this.executablePath,
        headless: true,
        viewport: { width: 1280, height: 800 },
        serviceWorkers: 'block',
        acceptDownloads: false,
        ignoreHTTPSErrors: false,
        proxy: proxyConfiguration(this.proxyServer, this.allowLocalTest),
        args: ['--disable-dev-shm-usage', '--no-first-run', '--disable-background-networking'],
      });
      await this.context.route('**/*', async route => {
        const request = route.request();
        const requestActor = this.activeActor;
        const requestEpoch = this.epoch;
        let fetchedResponse;
        let frame;
        try {
          try { frame = request.frame(); } catch { return await route.abort('blockedbyclient'); }
          if (this.page && frame.page() !== this.page) return await route.abort('blockedbyclient');
          // Agent browsing is read-only at the transport layer, including page scripts.
          // Human takeover permits intentional login/form submissions in the same session.
          if (this.owner === 'agent' && !['GET', 'HEAD'].includes(request.method())) {
            if (request.isNavigationRequest() && frame === this.page?.mainFrame()) {
              this.lastError = 'Agent form submissions are blocked; take over for manual interaction.';
            }
            return await route.abort('blockedbyclient');
          }
          if (this.activeActor === 'agent' && this.owner !== 'agent') return await route.abort('aborted');
          const safeUrl = await this.validateUrl(request.url());
          // Fetch one hop only: validate every redirect destination before the browser follows it.
          const response = fetchedResponse = await route.fetch({ url: safeUrl, maxRedirects: 0, timeout: 20000 });
          const location = response.headers().location;
          if (location && response.status() >= 300 && response.status() < 400) {
            await this.validateUrl(new URL(location, safeUrl).href);
          }
          if (requestActor === 'agent' && (this.owner !== 'agent' || requestEpoch !== this.epoch)) return await route.abort('aborted');
          await route.fulfill({ response });
        } catch (failure) {
          if (request.isNavigationRequest() && frame === this.page?.mainFrame()) {
            this.lastError = failure.code === 'unsafe_url' ? 'Private or unsupported destination blocked.' : 'Browser request failed.';
          }
          await route.abort('blockedbyclient').catch(() => {});
        } finally { await fetchedResponse?.dispose().catch(() => {}); }
      });
      await this.context.routeWebSocket('**/*', socket => socket.close({ code: 1008, reason: 'WebSockets are disabled for research.' }));
      this.page = this.context.pages()[0] || await this.context.newPage();
      this.context.on('page', popup => { if (popup !== this.page) popup.close().catch(() => {}); });
      this.page.setDefaultTimeout(15000);
      this.page.on('response', response => {
        const request = response.request();
        try {
          if (request.isNavigationRequest() && request.frame() === this.page?.mainFrame()) {
            this.loadedResponseUrl = response.status() < 400 ? response.url() : '';
            this.lastError = response.status() < 400 ? null : `Website returned HTTP ${response.status()}.`;
          }
        } catch { /* Popups can emit navigation before their frame exists. */ }
      });
      this.page.on('domcontentloaded', () => {
        const page = this.page;
        if (!page) return;
        const actualUrl = page.url();
        if (!/^https?:/.test(actualUrl) || actualUrl !== this.loadedResponseUrl) return;
        // Browser-driven links/redirects update the visible state only after a loaded document.
        Promise.all([this.validateUrl(actualUrl), page.title()]).then(([url, title]) => {
          if (this.page === page && page.url() === url && this.loadedResponseUrl === url) {
            this.currentUrl = url; this.currentTitle = title;
          }
        }).catch(() => {});
      });
      this.page.on('close', () => { this.lastError = 'Browser page was closed.'; });
      this.context.on('close', () => { this.context = null; this.page = null; });
      this.lastError = null;
      return this.state();
    } catch {
      this.lastError = 'Chromium could not start; check the executable and its runtime dependencies.';
      await this.context?.close().catch(() => {});
      this.context = null;
      this.page = null;
      throw error(this.lastError, 'browser_unavailable', 503);
    }
  }

  async run(actor, fn) {
    this.assertOwner(actor);
    const epoch = this.epoch;
    const result = this.tail.then(async () => {
      this.assertOwner(actor);
      if (this.epoch !== epoch) throw error('Browser ownership changed; retry the operation.', 'browser_lease_changed', 409);
      await this.start();
      this.assertOwner(actor);
      this.activeActor = actor;
      try {
        const value = await fn(() => {
          this.assertOwner(actor);
          if (this.epoch !== epoch) throw error('Browser ownership changed; retry the operation.', 'browser_lease_changed', 409);
        });
        this.assertOwner(actor);
        if (this.epoch !== epoch) throw error('Browser ownership changed; retry the operation.', 'browser_lease_changed', 409);
        return value;
      } finally { this.activeActor = null; }
    });
    this.tail = result.catch(() => {});
    return result;
  }

  async takeover() {
    this.owner = 'human';
    this.epoch += 1;
    if (this.page && !this.page.isClosed()) {
      let session;
      try {
        session = await this.context.newCDPSession(this.page);
        await session.send('Page.stopLoading');
      } catch { /* An aborted navigation may temporarily detach the page target. */ }
      finally { await session?.detach().catch(() => {}); }
    }
    await this.tail;
    return this.state();
  }

  async release() {
    // Revoke the human lease before draining any input already in progress.
    this.owner = 'agent';
    this.epoch += 1;
    await this.tail;
    return this.state();
  }

  async _navigate(url, check) {
    const destination = await this.validateUrl(url);
    check();
    this.lastError = null;
    try {
      const response = await this.page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 30000 });
      check();
      const finalUrl = await this.validateUrl(this.page.url());
      if (response && response.status() >= 400) throw error(`Website returned HTTP ${response.status()}.`, 'navigation_failed', 502);
      this.currentUrl = finalUrl;
      this.currentTitle = await this.page.title();
      this.lastError = null;
      return this.state();
    } catch (failure) {
      if (failure.code) throw failure;
      this.lastError ||= 'Website navigation failed.';
      throw error(this.lastError, 'navigation_failed', 502);
    }
  }

  navigate(url, { actor = 'agent' } = {}) {
    return this.run(actor, check => this._navigate(url, check));
  }

  async _extract() {
    if (this.page.url() !== this.loadedResponseUrl) throw error('No successfully loaded HTTP(S) document is available.', 'page_unavailable', 409);
    const url = await this.validateUrl(this.page.url());
    const facts = await this.page.evaluate(() => {
      const text = (document.body?.innerText || '').slice(0, 200000);
      const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 2000).map(a => ({ text: (a.innerText || '').trim().slice(0, 500), url: a.href }));
      const mailto = links.filter(link => link.url.startsWith('mailto:')).map(link => decodeURIComponent(link.url.slice(7).split('?')[0]));
      const tel = links.filter(link => link.url.startsWith('tel:')).map(link => decodeURIComponent(link.url.slice(4).split('?')[0]));
      const emails = [...new Set([...mailto, ...(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])])].slice(0, 200);
      const phones = [...new Set([...tel, ...(text.match(/\+?\d[\d\s().-]{6,}\d/g) || [])])].slice(0, 200);
      return { title: document.title, text, links, emails, phones };
    });
    this.currentUrl = url;
    this.currentTitle = facts.title;
    return { url, ...facts };
  }

  extract({ actor = 'agent' } = {}) { return this.run(actor, () => this._extract()); }

  inspect(url, { actor = 'agent' } = {}) {
    return this.run(actor, async check => { await this._navigate(url, check); check(); return this._extract(); });
  }

  async screenshot() {
    await this.start();
    return this.page.screenshot({ type: 'jpeg', quality: 75, fullPage: false, timeout: 10000 });
  }

  act(action, { actor = 'human' } = {}) {
    return this.run(actor, async check => {
      if (!action || typeof action !== 'object') throw error('Browser action is required.', 'invalid_action');
      check();
      switch (action.type) {
        case 'click':
          if (![action.x, action.y].every(Number.isFinite) || action.x < 0 || action.y < 0 || action.x > 1280 || action.y > 800) throw error('Click coordinates must be within the browser viewport.', 'invalid_action');
          await this.page.mouse.click(action.x, action.y); break;
        case 'type':
          if (typeof action.text !== 'string' || action.text.length > 10000) throw error('Text must be at most 10000 characters.', 'invalid_action');
          await this.page.keyboard.insertText(action.text); break;
        case 'key':
          if (typeof action.key !== 'string' || action.key.length > 80 || !/^[A-Za-z0-9+._-]+$/.test(action.key)) throw error('Invalid browser key.', 'invalid_action');
          await this.page.keyboard.press(action.key); break;
        case 'scroll':
          if (!Number.isFinite(action.deltaY) || Math.abs(action.deltaY) > 20000) throw error('Invalid scroll distance.', 'invalid_action');
          await this.page.mouse.wheel(0, action.deltaY); break;
        default: throw error('Unsupported browser action.', 'invalid_action');
      }
      check();
      // Clicking can initiate a real navigation. Wait only when the page is loading.
      await this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      check();
      const actualUrl = this.page.url();
      if (actualUrl !== 'about:blank' && actualUrl === this.loadedResponseUrl) {
        this.currentUrl = await this.validateUrl(actualUrl);
        this.currentTitle = await this.page.title();
      }
      return this.state();
    });
  }

  async close() {
    this.epoch += 1;
    const context = this.context;
    this.context = null;
    this.page = null;
    await context?.close().catch(() => {});
    if (this.tempDataDir && this.dataDir) {
      await rm(this.dataDir, { recursive: true, force: true });
      this.dataDir = undefined;
      this.tempDataDir = false;
    }
  }
}
