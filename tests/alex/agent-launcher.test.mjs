import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentPaths, hermesEnvironment, initializeAgent, checkAgentBackend, runHermes, resolveHermesExecutable, resolveHermesPython } from '../../scripts/alex-agent.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'alex-agent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Alex ignores inherited Hermes home and refuses installing inside the default profile', () => {
  const home = join(tmpdir(), 'person');
  const env = { HERMES_HOME: join(home, '.hermes'), ALEX_API_TOKEN_FILE: 'a-token-file', HERMES_ENABLE_PROJECT_PLUGINS: '1' };
  const paths = agentPaths({ env, home });
  const isolated = hermesEnvironment(paths, env);
  assert.equal(isolated.HERMES_HOME, join(home, '.alex', 'profiles', 'alex'));
  assert.equal(isolated.ALEX_API_TOKEN_FILE, 'a-token-file');
  assert.equal(isolated.HERMES_ENABLE_PROJECT_PLUGINS, undefined);
  assert.equal(env.HERMES_HOME, join(home, '.hermes'));
  assert.throws(() => agentPaths({ home, env: { ALEX_AGENT_ROOT: join(home, '.hermes', 'profiles', 'alex') } }), /独立目录/);
  assert.throws(() => agentPaths({ home, env: { ALEX_AGENT_ROOT: 'relative' } }), /绝对路径/);
});

test('initialization uses official distribution install once and preserves user state on repeated init', async t => {
  const directory = await workspace(t);
  const paths = agentPaths({ env: { ALEX_AGENT_ROOT: join(directory, 'alex') } });
  const calls = [];
  const runner = async (args, options) => {
    calls.push({ args, options });
    await cp(paths.stage, paths.profile, { recursive: true });
    return 0;
  };
  const result = await initializeAgent({ paths, env: {}, runner });
  assert.equal(result.created, true);
  assert.deepEqual(calls[0].args, ['profile', 'install', paths.stage, '--name', 'alex', '--yes']);
  assert.equal(calls[0].options.root, true);
  await writeFile(join(paths.profile, 'config.yaml'), 'user-owned-config');
  await writeFile(join(paths.profile, '.env'), 'PRIVATE_PLACEHOLDER=not-a-real-secret');
  await mkdir(join(paths.profile, 'memories'), { recursive: true });
  await writeFile(join(paths.profile, 'memories', 'USER.md'), 'User business memory');
  const again = await initializeAgent({ paths, env: {}, runner });
  assert.equal(again.created, false);
  assert.equal(calls.length, 1);
  assert.equal(await readFile(join(paths.profile, 'config.yaml'), 'utf8'), 'user-owned-config');
  assert.equal(await readFile(join(paths.profile, '.env'), 'utf8'), 'PRIVATE_PLACEHOLDER=not-a-real-secret');
  assert.equal(await readFile(join(paths.profile, 'memories', 'USER.md'), 'utf8'), 'User business memory');
});

test('initialization fails closed for foreign existing data and official installer failure', async t => {
  const directory = await workspace(t);
  const foreign = agentPaths({ env: { ALEX_AGENT_ROOT: join(directory, 'foreign') } });
  await mkdir(foreign.profile, { recursive: true });
  await writeFile(join(foreign.profile, 'keep.txt'), 'untouched');
  let calls = 0;
  await assert.rejects(initializeAgent({ paths: foreign, runner: async () => { calls++; } }), /已有其他数据/);
  assert.equal(calls, 0);
  assert.equal(await readFile(join(foreign.profile, 'keep.txt'), 'utf8'), 'untouched');
  const failed = agentPaths({ env: { ALEX_AGENT_ROOT: join(directory, 'failed') } });
  await assert.rejects(initializeAgent({ paths: failed, runner: async () => 7 }), /退出码 7/);
  await assert.rejects(initializeAgent({ paths: failed, update: true }), /尚未初始化/);
});

test('update delegates to Hermes without force-config and leaves configuration and credentials untouched', async t => {
  const directory = await workspace(t);
  const paths = agentPaths({ env: { ALEX_AGENT_ROOT: directory } });
  await mkdir(paths.profile, { recursive: true });
  await writeFile(join(paths.profile, 'distribution.yaml'), 'name: alex\n');
  await writeFile(join(paths.profile, 'config.yaml'), 'custom-model-settings');
  let actual;
  const result = await initializeAgent({ paths, env: {}, update: true, runner: async args => { actual = args; return 0; } });
  assert.equal(result.updated, true);
  assert.deepEqual(actual, ['profile', 'update', 'alex', '--yes']);
  assert.equal(await readFile(join(paths.profile, 'config.yaml'), 'utf8'), 'custom-model-settings');
});

test('the launched process receives the Alex home and workspace, never the inherited Hermes profile', async t => {
  const directory = await workspace(t);
  const paths = agentPaths({ env: { ALEX_AGENT_ROOT: directory } });
  const capture = join(directory, 'capture.json');
  const script = "require('node:fs').writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({home:process.env.HERMES_HOME,cwd:process.cwd(),api:process.env.ALEX_API_URL}));";
  const env = { ...process.env, HERMES_HOME: join(directory, 'other-profile'), TEST_CAPTURE: capture };
  assert.equal(await runHermes(['-e', script], { paths, env, executable: process.execPath, stdio: 'ignore' }), 0);
  const received = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(received.home, paths.profile);
  assert.equal(received.cwd, join(paths.profile, 'workspace'));
  assert.equal(received.api, 'http://127.0.0.1:3210');
  await assert.rejects(runHermes(['chat', '--profile=default'], { paths, env, executable: process.execPath }), /已绑定独立 profile/);
});

test('backend checks real health, reject redirects and never send transport credentials in health requests', async t => {
  const directory = await workspace(t);
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, 'test-fixture-only');
  let mode = 'healthy', destinationRequests = 0, tokenHeader;
  const server = http.createServer((req, res) => {
    tokenHeader = req.headers['x-alex-token'];
    if (req.url !== '/api/health') destinationRequests++;
    if (mode === 'redirect') { res.writeHead(302, { Location: '/capture' }); res.end(); }
    else res.end(JSON.stringify({ ok: true, product: mode === 'wrong-service' ? 'Other' : 'Alex' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ALEX_API_URL: `http://127.0.0.1:${server.address().port}`, ALEX_API_TOKEN_FILE: tokenFile };
  assert.equal((await checkAgentBackend({ env })).status, 'ok');
  assert.equal(tokenHeader, undefined);
  await assert.rejects(checkAgentBackend({ env: { ALEX_API_URL: env.ALEX_API_URL } }), /未配置本机业务服务凭据/);
  await assert.rejects(checkAgentBackend({ env: { ...env, ALEX_API_TOKEN_FILE: join(directory, 'missing') } }), /无法读取/);
  mode = 'redirect';
  await assert.rejects(checkAgentBackend({ env }), /不可用/);
  assert.equal(destinationRequests, 0);
  mode = 'wrong-service';
  await assert.rejects(checkAgentBackend({ env }), /不可用/);
  await assert.rejects(checkAgentBackend({ env: { ALEX_API_URL: 'https://example.com' } }), /回环/);
});

test('runtime detection uses installed Hermes and its own Python rather than system Python', async t => {
  const directory = await workspace(t);
  const scripts = join(directory, 'hermes', 'hermes-agent', 'venv', 'Scripts');
  await mkdir(scripts, { recursive: true });
  const executable = join(scripts, 'hermes.exe');
  await writeFile(executable, 'fixture');
  const env = { LOCALAPPDATA: directory, PATH: '' };
  assert.equal(await resolveHermesExecutable({ env, platform: 'win32' }), executable);
  await assert.rejects(resolveHermesPython({ env, executable, platform: 'win32' }), /不会改用系统 Python/);
  await writeFile(join(scripts, 'python.exe'), 'fixture');
  assert.equal(await resolveHermesPython({ env, executable, platform: 'win32' }), join(scripts, 'python.exe'));
  await assert.rejects(resolveHermesExecutable({ env: { ALEX_HERMES_EXECUTABLE: join(directory, 'missing') } }), /未找到 Hermes/);
});
