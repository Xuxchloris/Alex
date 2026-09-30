import http from 'node:http';
import https from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export class AlexGatewayError extends Error {
  constructor(code, message) { super(message); this.name = 'AlexGatewayError'; this.code = code; }
}

function apiOrigin(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new AlexGatewayError('invalid_api_url', 'ALEX_API_URL must be a valid loopback HTTP(S) origin.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new AlexGatewayError('invalid_api_url', 'ALEX_API_URL must be a loopback HTTP(S) origin without credentials, path or query.');
  }
  return url;
}

function expandHome(path) {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export function redact(value, token) {
  if (!token) return value;
  if (typeof value === 'string') return value.replaceAll(token, '[redacted]');
  if (Array.isArray(value)) return value.map(item => redact(item, token));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, token), redact(item, token)]));
  return value;
}

/** A direct local control channel. It never creates a second business store. */
export class AlexApiClient {
  constructor({ env = process.env, timeoutMs = 45_000, maxResponseBytes = 2_000_000 } = {}) {
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    // Explicit agents must not inherit Node's --use-env-proxy global agents.
    this.httpAgent = new http.Agent({ keepAlive: false, proxyEnv: {} });
    this.httpsAgent = new https.Agent({ keepAlive: false, proxyEnv: {} });
  }

  async token() {
    let value = String(this.env.ALEX_API_TOKEN || '').trim();
    if (!value) {
      const file = this.env.ALEX_API_TOKEN_FILE || (this.env.ALEX_DATA_DIR ? join(this.env.ALEX_DATA_DIR, 'api-token') : '');
      if (!file) throw new AlexGatewayError('missing_token', 'Configure ALEX_API_TOKEN_FILE or securely inject ALEX_API_TOKEN into the gateway process.');
      try {
        const path = expandHome(file);
        if ((await stat(path)).size > 4096) throw new AlexGatewayError('invalid_token_file', 'The Alex token file is too large.');
        value = (await readFile(path, 'utf8')).trim();
      } catch (error) {
        if (error instanceof AlexGatewayError) throw error;
        throw new AlexGatewayError('token_file_unavailable', 'Cannot read the configured Alex token file; start Alex and check the configured path.');
      }
    }
    if (!value || value.length > 4096 || /[^\x21-\x7e]/u.test(value)) {
      throw new AlexGatewayError('invalid_token', 'The configured Alex API credential is missing or invalid.');
    }
    return value;
  }

  async request(method, path, body, { authenticated = true, signal } = {}) {
    const origin = apiOrigin(this.env.ALEX_API_URL || 'http://127.0.0.1:3210');
    const token = authenticated ? await this.token() : '';
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    // Only our fixed dispatch table creates request paths; there is no model URL override.
    if (!path.startsWith('/api/') || path.startsWith('//') || /[\r\n]/u.test(path)) {
      throw new AlexGatewayError('invalid_endpoint', 'Unsupported Alex API endpoint.');
    }
    if (payload && payload.length > 1_000_000) throw new AlexGatewayError('request_too_large', 'Alex tool arguments exceed the local API request limit.');
    const response = await new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(result);
      };
      const request = (origin.protocol === 'https:' ? https : http).request({
        protocol: origin.protocol, hostname: origin.hostname === 'localhost' ? '127.0.0.1' : origin.hostname.replace(/^\[|\]$/gu, ''),
        port: origin.port || undefined, path, method,
        agent: origin.protocol === 'https:' ? this.httpsAgent : this.httpAgent,
        // Pin localhost to loopback without a DNS lookup or host-file redirect.
        headers: { Accept: 'application/json', ...(token ? { 'X-Alex-Token': token } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        signal,
      }, incoming => {
        if (incoming.statusCode >= 300 && incoming.statusCode < 400) {
          finish(new AlexGatewayError('redirect_blocked', 'Alex API redirects are not allowed.'));
          incoming.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        incoming.on('data', chunk => {
          size += chunk.length;
          if (size > this.maxResponseBytes) {
            finish(new AlexGatewayError('response_too_large', 'Alex returned too much data; narrow the customer or memory query.'));
            incoming.destroy();
          } else chunks.push(chunk);
        });
        incoming.on('error', () => finish(new AlexGatewayError('api_unavailable', 'Alex local service closed the response before completion.')));
        incoming.on('end', () => finish(null, { status: incoming.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', error => finish(new AlexGatewayError(error.name === 'AbortError' ? 'request_cancelled' : 'api_unavailable',
        error.name === 'AbortError' ? 'The MCP request was cancelled.' : 'Alex local service is unavailable; start npm start before the gateway.')));
      timer = setTimeout(() => {
        finish(new AlexGatewayError('api_timeout', 'Alex local API timed out; inspect the saved task before retrying.'));
        request.destroy();
      }, this.timeoutMs);
      timer.unref();
      request.end(payload);
    });
    let result;
    try { result = JSON.parse(response.raw); } catch {
      throw new AlexGatewayError('invalid_response', `Alex API returned non-JSON data (HTTP ${response.status}).`);
    }
    result = redact(result, token);
    if (response.status < 200 || response.status >= 300) {
      throw new AlexGatewayError(typeof result?.code === 'string' ? result.code : 'api_error',
        typeof result?.error === 'string' ? result.error.slice(0, 1500) : `Alex API request failed (HTTP ${response.status}).`);
    }
    return result;
  }

  close() { this.httpAgent.destroy(); this.httpsAgent.destroy(); }
}
