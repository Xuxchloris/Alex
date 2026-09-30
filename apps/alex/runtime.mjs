import { spawn } from 'node:child_process';
import { openSync, closeSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';

function failure(message, code) { return Object.assign(new Error(message), { code, status: 409 }); }
export function readRuntimeConfig(env = process.env) {
  const raw = String(env.ALEX_PORT ?? '3210').trim();
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) throw failure('ALEX_PORT 必须为 1–65535 的整数。', 'invalid_port');
  const bindHost = env.ALEX_BIND_HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(bindHost)) throw failure('ALEX_BIND_HOST 仅支持本机回环或容器的 0.0.0.0。', 'invalid_bind_host');
  const localProxyIp = env.ALEX_LOCAL_PROXY_IP || '';
  if (localProxyIp) {
    const parts = localProxyIp.split('.').map(Number);
    const privateV4 = isIP(localProxyIp) === 4 && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
    if (!privateV4) throw failure('ALEX_LOCAL_PROXY_IP 必须为一个明确的私有 IPv4 本机代理地址；不支持网段。', 'invalid_local_proxy');
  }
  return { port: Number(raw), bindHost, localProxyIp };
}
export function isLocalPeer(address, localProxyIp = '') {
  const ip = String(address || '').replace(/^::ffff:/, '');
  return ip === '::1' || /^127\.\d+\.\d+\.\d+$/.test(ip) || Boolean(localProxyIp && ip === localProxyIp);
}

/** Kernel advisory lock; crashes release it through the helper's stdin EOF. Never remove this inode. */
export async function acquireDataLock(dataDir) {
  const path = join(dataDir, '.alex-process.lock');
  closeSync(openSync(path, 'a', 0o600));
  chmodSync(path, 0o600);
  const source = "process.stdout.write('locked\\n'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));";
  const child = spawn('flock', ['--no-fork', '--exclusive', '--nonblock', '--conflict-exit-code', '73', path, process.execPath, '--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
  let released = false, ready = false, lost = false;
  let notifyLost = () => {};
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.once('exit', () => { if (ready && !released) { lost = true; notifyLost(); } });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.stdin.destroy(); child.kill(); reject(failure('数据目录进程锁启动超时。', 'data_lock_unavailable')); }, 5000);
    child.once('error', () => { clearTimeout(timer); reject(failure('需要 Linux/WSL2 的 flock（util-linux），或使用 Docker 部署。', 'data_lock_unavailable')); });
    child.stdout.once('data', chunk => {
      clearTimeout(timer);
      if (String(chunk).startsWith('locked')) { ready = true; resolve(); }
      else reject(failure('数据目录进程锁初始化失败。', 'data_lock_unavailable'));
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (!ready) reject(failure(code === 73 ? '此数据目录已由另一个 Alex 进程使用；请先停止它。' : '无法建立数据目录进程锁。', code === 73 ? 'data_directory_locked' : 'data_lock_unavailable'));
    });
  });
  return {
    isHeld() { return ready && !released && !lost && child.exitCode === null && child.signalCode === null; },
    onLost(callback) { notifyLost = callback; if (lost) notifyLost(); },
    // Runtime tests may stop this isolated helper to verify startup fails closed.
    pid: child.pid,
    async release() {
      if (released) return exited;
      released = true;
      child.stdin.end();
      const timer = setTimeout(() => { child.stdin.destroy(); child.kill('SIGTERM'); }, 3000);
      try { return await exited; } finally { clearTimeout(timer); }
    },
  };
}
