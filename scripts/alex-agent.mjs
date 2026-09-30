import { access, cp, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { checkApi, localHealthUrl } from './alex-doctor.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const AGENT_TOOLSETS = ['alex', 'skills', 'memory', 'session_search', 'todo'];
const exists = async path => access(path).then(() => true, () => false);

export function agentPaths({ env = process.env, home = homedir() } = {}) {
  if (env.ALEX_AGENT_ROOT && !isAbsolute(env.ALEX_AGENT_ROOT)) throw new Error('ALEX_AGENT_ROOT 必须是绝对路径。');
  const root = resolve(env.ALEX_AGENT_ROOT || join(home, '.alex'));
  const defaultHome = resolve(home, '.hermes');
  const insideDefault = relative(defaultHome, root);
  if (insideDefault === '' || (!insideDefault.startsWith('..') && !isAbsolute(insideDefault))) {
    throw new Error('Alex 需要独立目录，ALEX_AGENT_ROOT 不得指向默认 Hermes profile。');
  }
  return { root, profile: join(root, 'profiles', 'alex'), stage: join(root, 'distribution') };
}

export function hermesEnvironment(paths, env = process.env, { root = false } = {}) {
  const api = localHealthUrl(env.ALEX_API_URL || 'http://127.0.0.1:3210');
  const next = { ...env, HERMES_HOME: root ? paths.root : paths.profile, ALEX_API_URL: api.origin };
  if (!next.ALEX_API_TOKEN_FILE && env.ALEX_DATA_DIR) next.ALEX_API_TOKEN_FILE = join(env.ALEX_DATA_DIR, 'api-token');
  // Project plugin discovery must never import unrelated working-directory plugins.
  delete next.HERMES_ENABLE_PROJECT_PLUGINS;
  return next;
}

export async function resolveHermesExecutable({ env = process.env, platform = process.platform } = {}) {
  const names = platform === 'win32' ? ['hermes.exe'] : ['hermes'];
  const candidates = [];
  if (env.ALEX_HERMES_EXECUTABLE) candidates.push(env.ALEX_HERMES_EXECUTABLE);
  else {
    if (platform === 'win32' && env.LOCALAPPDATA) {
      for (const venv of ['venv', '.venv']) candidates.push(join(env.LOCALAPPDATA, 'hermes', 'hermes-agent', venv, 'Scripts', 'hermes.exe'));
    }
    for (const directory of (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
      for (const name of names) candidates.push(join(directory.replace(/^"|"$/gu, ''), name));
    }
  }
  for (const candidate of candidates) {
    try { await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK); if ((await stat(candidate)).isFile()) return resolve(candidate); }
    catch { /* Continue to the next installed runtime. */ }
  }
  throw new Error('未找到 Hermes。请安装 Hermes，或将 ALEX_HERMES_EXECUTABLE 指向已安装的 hermes 可执行文件。');
}

export async function resolveHermesPython({ env = process.env, executable, platform = process.platform } = {}) {
  const hermes = executable || await resolveHermesExecutable({ env, platform });
  const python = join(dirname(hermes), platform === 'win32' ? 'python.exe' : 'python');
  try { await access(python, platform === 'win32' ? constants.F_OK : constants.X_OK); }
  catch { throw new Error('Hermes 同一虚拟环境中的 Python 不可用；不会改用系统 Python。'); }
  return python;
}

export async function runHermesPython(args, { paths = agentPaths(), env = process.env, executable, stdio = 'inherit' } = {}) {
  const python = await resolveHermesPython({ env, executable });
  return new Promise((resolveRun, reject) => {
    const child = spawn(python, args, { env: hermesEnvironment(paths, env), cwd: paths.profile, stdio, shell: false, windowsHide: true });
    child.once('error', () => reject(new Error('无法启动 Hermes Python。')));
    child.once('exit', (code, signal) => resolveRun(code ?? (signal ? 130 : 1)));
  });
}

export async function runHermes(args, { paths = agentPaths(), env = process.env, root = false, executable, stdio = 'inherit', cwd } = {}) {
  if (args.some(arg => arg === '-p' || arg === '--profile' || arg.startsWith('--profile='))) {
    throw new Error('Alex 启动器已绑定独立 profile，请勿传入其他 --profile。');
  }
  const command = executable || await resolveHermesExecutable({ env });
  const childEnv = hermesEnvironment(paths, env, { root });
  const workingDirectory = cwd || join(paths.profile, 'workspace');
  await mkdir(workingDirectory, { recursive: true });
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, root ? ['-p', 'default', ...args] : args, {
      env: childEnv, cwd: workingDirectory, stdio, shell: false, windowsHide: true,
    });
    child.once('error', () => reject(new Error('无法启动 Hermes；请检查 ALEX_HERMES_EXECUTABLE。')));
    child.once('exit', (code, signal) => resolveRun(code ?? (signal ? 130 : 1)));
  });
}

export async function stageDistribution(paths, { repo = repository } = {}) {
  await mkdir(paths.root, { recursive: true });
  const temporary = await mkdtemp(join(paths.root, '.distribution-'));
  try {
    await cp(join(repo, 'agent'), temporary, { recursive: true });
    const plugin = join(temporary, 'plugins', 'alex');
    await mkdir(plugin, { recursive: true });
    for (const name of ['plugin.yaml', '__init__.py', 'outreach.py', 'skills']) {
      await cp(join(repo, 'integrations', 'hermes', name), join(plugin, name), { recursive: true,
        filter: source => !source.endsWith('.pyc') && !source.split(/[\\/]/u).includes('__pycache__') });
    }
    // Only this generated, dedicated staging directory is replaced. Runtime data lives in profile/.
    await rm(paths.stage, { recursive: true, force: true });
    await rename(temporary, paths.stage);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return paths.stage;
}

export async function initializeAgent({ env = process.env, paths = agentPaths({ env }), repo = repository, update = false, runner = runHermes } = {}) {
  const manifestPath = join(paths.profile, 'distribution.yaml');
  if (await exists(paths.profile)) {
    if (!(await exists(manifestPath)) || !/^name:\s*["']?alex["']?\s*$/mu.test(await readFile(manifestPath, 'utf8'))) {
      throw new Error('目标目录已有其他数据，未覆盖。请为 ALEX_AGENT_ROOT 选择新的独立目录。');
    }
    if (!update) return { created: false, updated: false, profile: paths.profile };
  } else if (update) throw new Error('Alex profile 尚未初始化，请先运行 npm run alex -- init。');
  await stageDistribution(paths, { repo });
  const args = update ? ['profile', 'update', 'alex', '--yes'] : ['profile', 'install', paths.stage, '--name', 'alex', '--yes'];
  const code = await runner(args, { paths, env, root: true, cwd: paths.root });
  if (code !== 0) throw new Error(`Hermes profile ${update ? 'update' : 'install'} 失败（退出码 ${code}）；未尝试覆盖安装。`);
  if (!(await exists(manifestPath))) throw new Error('Hermes 未生成 Alex profile；请检查安装输出。');
  return { created: !update, updated: update, profile: paths.profile };
}

export async function checkAgentBackend({ env = process.env, paths = agentPaths({ env }) } = {}) {
  const childEnv = hermesEnvironment(paths, env);
  const health = await checkApi(childEnv.ALEX_API_URL);
  if (health.status !== 'ok') throw new Error(`Alex 业务服务不可用：${health.detail} 先运行 npm start（Windows 后端使用 WSL2）。`);
  if (!childEnv.ALEX_API_TOKEN_FILE && !childEnv.ALEX_API_TOKEN) {
    throw new Error('未配置本机业务服务凭据。请设置 ALEX_API_TOKEN_FILE，指向服务数据目录的 api-token；不要把内容贴到聊天。');
  }
  if (childEnv.ALEX_API_TOKEN_FILE && !childEnv.ALEX_API_TOKEN) {
    try { await access(childEnv.ALEX_API_TOKEN_FILE, constants.R_OK); }
    catch { throw new Error('ALEX_API_TOKEN_FILE 无法读取；Windows 可指定实际 WSL UNC 文件路径。'); }
  }
  return health;
}

export async function agentStatus({ env = process.env, paths = agentPaths({ env }) } = {}) {
  const installed = await exists(join(paths.profile, 'distribution.yaml'));
  const runtime = await resolveHermesExecutable({ env }).then(() => true, () => false);
  const childEnv = hermesEnvironment(paths, env);
  const api = await checkApi(childEnv.ALEX_API_URL);
  return { product: 'Alex Agent', profile: paths.profile, installed, hermesAvailable: runtime,
    backend: api, backendCredentialConfigured: Boolean(childEnv.ALEX_API_TOKEN_FILE || childEnv.ALEX_API_TOKEN),
    model: '由独立 Hermes profile 配置；此检查未调用模型。', channels: '须按实际配置与投递结果验收。' };
}

export async function main(args = process.argv.slice(2), { env = process.env, output = console.log } = {}) {
  const paths = agentPaths({ env });
  const [command = 'chat', ...rest] = args;
  if (['help', '--help', '-h'].includes(command)) {
    output('Alex 外贸专家 Agent\n用法：npm run alex -- init | update | chat | model | setup | status | tools [list] | gateway setup | gateway run | whatsapp | whatsapp-cloud | cron ...\n外发策略：outreach show | allow <channel> <recipient> --daily-limit N | revoke <channel> <recipient> | disable\n外发记录备份：backup-outreach <destination>\n默认使用 ~/.alex/profiles/alex；ALEX_AGENT_ROOT 可指定独立根目录。\n先启动业务服务，再配置 ALEX_API_TOKEN_FILE；模型与渠道在 Alex 独立 profile 中配置。');
    return 0;
  }
  if (command === 'status') { output(JSON.stringify(await agentStatus({ env, paths }), null, 2)); return 0; }
  if (['init', 'update'].includes(command)) {
    if (rest.length) throw new Error('init/update 不接受额外参数；目录通过 ALEX_AGENT_ROOT 配置。');
    const result = await initializeAgent({ env, paths, update: command === 'update' });
    output(`${result.created ? '已安装' : result.updated ? '已更新' : '已存在，保留现有配置'} Alex Agent：${result.profile}`);
    return 0;
  }
  if (!['chat', 'model', 'setup', 'gateway', 'tools', 'whatsapp', 'whatsapp-cloud', 'cron', 'outreach', 'backup-outreach'].includes(command)) throw new Error('未知命令；运行 npm run alex -- help 查看用法。');
  if (!(await exists(join(paths.profile, 'distribution.yaml')))) throw new Error('Alex profile 尚未初始化，请先运行 npm run alex -- init。');
  if (command === 'outreach' || command === 'backup-outreach') {
    if (command === 'outreach' && !['show', 'allow', 'revoke', 'disable'].includes(rest[0])) throw new Error('outreach 只接受 show / allow / revoke / disable，不提供直接发送命令。');
    if (command === 'backup-outreach' && rest.length !== 1) throw new Error('请提供一个外发记录备份目标文件。');
    const destination = command === 'backup-outreach' ? [resolve(rest[0])] : rest;
    return runHermesPython([join(paths.profile, 'plugins', 'alex', 'outreach.py'), command === 'outreach' ? 'policy' : 'backup', ...destination], { env, paths });
  }
  if (command === 'chat' || (command === 'gateway' && (!rest.length || ['run', 'start', 'restart'].includes(rest[0])))) await checkAgentBackend({ env, paths });
  return runHermes([command, ...rest], { env, paths });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`Alex：${error.message}`); process.exitCode = 1; }
}
