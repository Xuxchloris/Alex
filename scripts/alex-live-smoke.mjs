import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, request as httpRequest } from 'node:http';

const args = process.argv.slice(2);
const read = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const request = read('--request');
if (!request) throw new Error('请通过 --request 提供实际任务；可用 --urls 提供逗号分隔的企业官网。不会预设行业或市场。');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.ALEX_API_TOKEN || readFileSync(process.env.ALEX_API_TOKEN_FILE || join(process.env.ALEX_DATA_DIR || join(root, 'work/alex'), 'api-token'), 'utf8').trim();
const base = process.env.ALEX_API_URL || 'http://127.0.0.1:3210';
if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(base)) throw new Error('验收脚本仅连接本机 Alex 服务');
if (!token || token.length > 4096 || /[\r\n]/u.test(token)) throw new Error('请配置有效的本机 Alex 访问令牌');
// The control credential must never use the process-wide environment proxy.
const localAgent = new Agent({ keepAlive: false, proxyEnv: {} });
const origin = new URL(base);
const redact = value => {
  if (typeof value === 'string') return value.replaceAll(token, '[redacted]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redact(item)]));
  return value;
};
const call = (path, value) => new Promise((resolveCall, reject) => {
  const payload = value === undefined ? null : Buffer.from(JSON.stringify(value));
  const request = httpRequest({
    // Both supported origin names connect to IPv4 loopback, without DNS or a proxy.
    hostname: '127.0.0.1', port: origin.port || 80, path, agent: localAgent,
    method: payload ? 'POST' : 'GET',
    headers: { Host: origin.host, 'X-Alex-Token': token, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
  }, response => {
    if (response.statusCode >= 300 && response.statusCode < 400) {
      response.resume();
      reject(new Error('本机 Alex API 重定向已阻止；访问令牌不会转发。'));
      return;
    }
    let length = 0;
    const chunks = [];
    response.on('data', chunk => {
      length += chunk.length;
      if (length > 2_000_000) { reject(new Error('本机 Alex API 响应过大')); response.destroy(); return; }
      chunks.push(chunk);
    });
    response.on('error', () => reject(new Error('读取本机 Alex API 响应失败')));
    response.on('end', () => {
      let data;
      try {
        data = redact(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch { reject(new Error('本机 Alex API 返回无效 JSON')); return; }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.statusCode}`));
        return;
      }
      resolveCall(data);
    });
  });
  request.setTimeout(45_000, () => request.destroy(new Error('本机 Alex API 请求超时')));
  request.on('error', error => reject(new Error(redact(error.message))));
  request.end(payload);
});
const urls = read('--urls')?.split(',').map(value => value.trim()).filter(Boolean);
let criteria = {};
if (!urls?.length) {
  const planned = await call('/api/plan', { request });
  if (planned.missing?.length || planned.status === 'unavailable' || planned.unavailable) throw new Error(`尚不能执行：${JSON.stringify(planned.questions || planned.error || planned.missing || planned)}`);
  criteria = planned.criteria;
}
const task = await call('/api/tasks', { request, criteria, ...(urls?.length ? { urls } : {}) });
console.log(`已创建真实模式任务 ${task.id}`);
const end = Date.now() + 180_000;
while (Date.now() < end) {
  const current = await call(`/api/tasks/${encodeURIComponent(task.id)}`);
  if (['completed', 'failed', 'blocked', 'unavailable', 'partial', 'paused', 'waiting_for_user', 'cancelled'].includes(current.status)) {
    console.log(JSON.stringify({ id: current.id, status: current.status, result: current.result, error: current.error }, null, 2));
    if (current.status !== 'completed') process.exitCode = 1;
    break;
  }
  await new Promise(resolveWait => setTimeout(resolveWait, 1500));
}
if (Date.now() >= end) { console.log('仍在执行，结果和检查点已保存；请在工作台查看。'); process.exitCode = 1; }
