/**
 * Truthful Agent integration recording. Actual Hermes AIAgent + native Alex
 * plugin + isolated live Alex/SQLite; model decisions are scripted fixtures.
 * Requirements: Node >=24.5, project npm ci, Chromium, ffmpeg, and an installed
 * Hermes Python environment. No model key, mail/WhatsApp login or real leads.
 *
 * Run on Linux/WSL from the repository:
 * ALEX_HERMES_PYTHON=/path/to/hermes/venv/bin/python \
 * ALEX_CHROMIUM_PATH=/path/to/chromium node scripts/alex-record-agent-demo.mjs
 * Optional: --output-dir /tmp/alex-agent-preview (preserves checked-in assets).
 * Source trace, invariants, exact runtime commit and replay command are saved
 * in alex-agent-demo-manifest.json. No production data is opened or modified.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createAlexServer } from '../apps/alex/server.mjs';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output-dir')) throw new Error('Usage: node scripts/alex-record-agent-demo.mjs [--output-dir PATH]');
const output = resolve(root, args[1] || 'docs/assets');
const protectedPaths = [join(root, 'work/alex'), process.env.ALEX_DATA_DIR, process.env.ALEX_BACKUP_DIR].filter(Boolean).map(value => resolve(value));
if (protectedPaths.some(path => output === path || output.startsWith(`${path}/`))) throw new Error('Recording output must not be a user workspace or backup directory');
const python = process.env.ALEX_HERMES_PYTHON;
if (!python) throw new Error('Set ALEX_HERMES_PYTHON to the Python executable in an installed Hermes environment.');
await run('ffmpeg', ['-version'], { timeout: 10_000 });
const temporary = await mkdtemp(join(tmpdir(), 'alex-agent-demo-'));
const home = join(temporary, 'home');
const hermesHome = join(temporary, 'hermes');
const dataDir = join(temporary, 'data');
const frameDir = join(temporary, 'frames');
const token = randomBytes(32).toString('hex');
const previousBackupDir = process.env.ALEX_BACKUP_DIR;
process.env.ALEX_BACKUP_DIR = join(temporary, 'backups');
let app;
let browser;
try {
  for (const directory of [home, hermesHome, frameDir, output]) await mkdir(directory, { recursive: true });
  const traces = [];
  for (const phase of ['initial', 'restart']) {
    app = await createAlexServer({ dataDir, token, llm: { apiKey: '', baseUrl: '', model: '' } });
    await new Promise((accept, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', accept); });
    const tracePath = join(temporary, `${phase}.json`);
    // Deliberate allowlist: no inherited model/provider credentials, proxy,
    // existing Hermes profile, user configuration, or real channel state.
    const env = { PATH: process.env.PATH, HOME: home, HERMES_HOME: hermesHome,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HERMES_ENABLE_PROJECT_PLUGINS: 'false',
      ALEX_API_URL: `http://127.0.0.1:${app.server.address().port}`, ALEX_API_TOKEN: token };
    try {
      const result = await run(python, [join(root, 'scripts/alex-record-agent-demo.py'),
        '--plugin', join(root, 'integrations/hermes'), '--trace', tracePath, '--phase', phase],
      { cwd: temporary, env, timeout: 120_000, maxBuffer: 2_000_000 });
      process.stdout.write(result.stdout);
    } catch (error) {
      throw new Error(`Hermes ${phase} recording failed: ${String(error.stderr || error.message).replaceAll(token, '[redacted]')}`);
    }
    traces.push(JSON.parse(await readFile(tracePath, 'utf8')));
    assert.equal(app.store.listCompanies({ includeArchived: true }).length, 0);
    assert.equal(app.store.listTasks().length, 0);
    await app.close();
    app = null;
  }
  const events = traces.flatMap(trace => trace.events);
  const prepares = events.filter(event => event.tool === 'alex_outreach_prepare');
  assert.equal(prepares.length, 2);
  assert.equal(prepares[0].result.result.id, prepares[1].result.result.id, 'Same persistent draft ID after restarting both processes');
  assert.equal(prepares[1].result.result.status, 'prepared');
  assert.equal(events.at(-1).result.result.length, 1);

  const captions = [
    ['从已保存资料开始', '先读取实际业务档案；首次运行返回空资料。'],
    ['记住用户明确给出的业务', '演示产品、目标市场与客户类型写入真实 SQLite。'],
    ['检查客户历史', '实际客户查询返回 0；没有编造获客成果。'],
    ['检查持久任务', '实际任务查询返回 0；先查询历史再执行。'],
    ['准备一封外联草稿', '测试地址 fixture@example.test；仅保存，不发送。'],
    ['默认拒绝未授权外发', '实际策略检查返回 outreach_not_authorized。'],
    ['重启后继续记住业务', 'Alex 服务与 Hermes 进程均已重启；资料仍在。'],
    ['重试同一请求不重复创建', '复用幂等键，返回重启前同一个草稿 ID。'],
    ['检查真实策略与发送次数', '策略关闭，发送尝试为 0，剩余额度为 0。'],
    ['一份草稿，零次外发', '重新打开持久账本后，仍只有一份测试草稿。'],
  ];
  function compact(event) {
    const value = event.result.result;
    if (event.tool.startsWith('alex_profile_')) return { ok: event.result.ok, facts: value.facts, version: value.version };
    if (event.tool === 'alex_outreach_prepare') return { ok: true, id: value.id, status: value.status, recipient: value.recipient };
    if (event.tool === 'alex_outreach_status') return { ok: true, enabled: value.policy.enabled, attempts_today: value.attempts_today, remaining_today: value.remaining_today };
    if (Array.isArray(value)) return { ok: event.result.ok, count: value.length, ...(value.length ? { id: value[0].id, status: value[0].status } : {}) };
    return event.result;
  }
  const frames = [{ title: 'Alex · 外贸专家 Agent', detail: '实际 Hermes AIAgent 循环 + Alex 原生工具 + 持久数据层', intro: true },
    ...events.map((event, index) => ({ event, title: captions[index][0], detail: captions[index][1], index })),
    { title: '执行可追溯，状态可继续', detail: '资料跨重启保留 · 草稿幂等去重 · 未授权发送拒绝', outro: true }];
  const icon = (await readFile(join(root, 'docs/assets/alex-agent-icon.png'))).toString('base64');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#f4f1e9;color:#102b46;font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif}
    .shell{height:640px;padding:32px 42px;display:flex;flex-direction:column}.head{display:flex;align-items:center;gap:15px}.head img{width:60px;height:60px;object-fit:contain}.name{font-size:26px;font-weight:800}.sub{font-size:12px;color:#657686}.tag{margin-left:auto;background:#102b46;color:white;padding:8px 13px;border-radius:6px;font:12px monospace}
    .warning{margin:18px 0 20px;padding:11px 16px;border-left:4px solid #ef674c;background:#fff8ef;font-size:14px;font-weight:700}.warning small{display:block;font:11px monospace;color:#667888;margin-top:4px}
    .content{display:grid;grid-template-columns:1.55fr 1fr;gap:26px;flex:1;min-height:0}.terminal{background:#102b46;color:#e1e7eb;border-radius:10px;overflow:hidden;padding:0 24px 20px;box-shadow:0 7px 18px #102b4612}.bar{font:11px monospace;color:#b6c4cf;padding:15px 0;border-bottom:1px solid #ffffff20;margin-bottom:19px}.bar span{color:#ef674c}.tool{font:17px monospace;color:#fb987d;line-height:1.5;word-break:break-word}pre{white-space:pre-wrap;word-break:break-all;font:14px/1.75 "DejaVu Sans Mono","Noto Sans CJK SC",monospace;margin:18px 0}.aside{display:flex;flex-direction:column;justify-content:center}.kicker{font:12px monospace;color:#a3513d;margin-bottom:15px}.aside h1{font-size:30px;line-height:1.45;margin:0 0 18px;letter-spacing:-.6px}.aside p{font-size:16px;line-height:1.9;color:#586e7f;margin:0}.footer{display:flex;justify-content:space-between;border-top:1px solid #102b4620;padding-top:15px;margin-top:22px;font-size:12px;color:#617383}.number{font-family:monospace;color:#a3513d}
    </style><div class="shell"><div class="head"><img src="data:image/png;base64,${icon}"><div><div class="name">Alex</div><div class="sub">Your foreign-trade agent</div></div><div class="tag">HERMES × ALEX</div></div><div class="warning">受控工具链验收 · 模型决定为脚本 Fixture<small>Real AIAgent loop & tools · Scripted model responses · No real outreach</small></div><div class="content"><section class="terminal"><div class="bar"><span>●</span> alex / isolated execution trace</div><div class="tool" id="tool"></div><pre id="result"></pre></section><section class="aside"><div class="kicker" id="phase"></div><h1 id="title"></h1><p id="detail"></p></section></div><div class="footer"><span>公开获客 0 · 真实模型调用 0 · 发送尝试 0</span><span class="number" id="number"></span></div></div></html>`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.ALEX_CHROMIUM_PATH || chromium.executablePath() });
  const page = await browser.newPage({ viewport: { width: 1100, height: 640 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  const durations = [];
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    const payload = frame.event ? compact(frame.event) : frame.intro ? {
      runtime: 'Hermes AIAgent', tools: 'Native Alex plugin', persistence: 'Real SQLite',
      model: 'SCRIPTED FIXTURE', hermesExternalNetwork: 'BLOCKED', productionData: 'NOT USED',
    } : { profileSurvivesRestart: true, sameDraftAfterRetry: true, draftCount: 1, sendAttempts: 0, actualModelInference: false };
    await page.evaluate(({ frame, payload, index, total }) => {
      document.getElementById('tool').textContent = frame.event ? `> ${frame.event.tool}()` : frame.intro ? '> begin controlled verification' : '> verification passed';
      document.getElementById('result').textContent = JSON.stringify(payload, null, 2);
      document.getElementById('phase').textContent = frame.event?.phase === 'restart' ? '02 / AFTER PROCESS RESTART' : frame.outro ? '03 / VERIFIED' : '01 / ISOLATED RUN';
      document.getElementById('title').textContent = frame.title;
      document.getElementById('detail').textContent = frame.detail;
      document.getElementById('number').textContent = `${String(index + 1).padStart(2, '0')} / ${total}`;
    }, { frame, payload, index, total: frames.length });
    const path = join(frameDir, `${String(index).padStart(2, '0')}.png`);
    await page.screenshot({ path });
    durations.push({ path, durationMs: index === 0 || index === frames.length - 1 ? 1300 : 1000 });
  }
  const concat = join(temporary, 'frames.txt');
  await writeFile(concat, durations.map(frame => `file '${frame.path}'\nduration ${frame.durationMs / 1000}\n`).join('') + `file '${durations.at(-1).path}'\n`);
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concat,
    '-filter_complex', 'fps=10,split[s0][s1];[s0]palettegen=max_colors=160:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
    '-loop', '0', join(output, 'alex-agent.gif')], { timeout: 60_000, maxBuffer: 1_000_000 });
  const report = { type: 'controlled-agent-integration-fixture', label: '受控工具链验收 · 模型决定为脚本 Fixture',
    createdAt: new Date().toISOString(), width: 1100, height: 640, frameCount: frames.length,
    durationMs: durations.reduce((sum, frame) => sum + frame.durationMs, 0),
    actualAIAgentLoop: true, nativePluginLoader: true, realAlexHttpApi: true, realSqlitePersistence: true,
    modelMode: 'scripted-openai-compatible-client-fixture', deterministicModelDecisions: true, realModelCalls: 0, publicAcquiredCustomers: 0,
    messagesSent: 0, sendAttempts: 0, productionWorkspaceUsed: false, hermesExternalNetworkBlocked: true,
    profileSurvivesServiceAndAgentRestart: true, sameDraftAfterRetry: true, draftCount: 1,
    hermesCommit: traces[0].hermesCommit, registeredToolCount: traces[0].registeredToolCount,
    fixtureCompletionCalls: traces.reduce((sum, trace) => sum + trace.fixtureCompletionCalls, 0),
    assets: ['alex-agent.gif'], source: 'Actual AIAgent tool completion callbacks; HTML visualizes captured outputs, not live terminal video.',
    requirements: ['Node.js >=24.5', 'npm ci', 'Chromium', 'ffmpeg', 'Installed Hermes Python environment'],
    reproduce: 'ALEX_HERMES_PYTHON=/path/to/hermes/venv/bin/python ALEX_CHROMIUM_PATH=/path/to/chromium node scripts/alex-record-agent-demo.mjs --output-dir /tmp/alex-agent-preview',
    steps: frames.map((frame, index) => ({ caption: frame.title, durationMs: durations[index].durationMs })),
    trace: events };
  await writeFile(join(output, 'alex-agent-demo-manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Recorded ${events.length} actual tool calls across two Hermes/SQLite sessions. Model decisions are scripted fixtures; external sends: 0.`);
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  if (previousBackupDir === undefined) delete process.env.ALEX_BACKUP_DIR;
  else process.env.ALEX_BACKUP_DIR = previousBackupDir;
  await rm(temporary, { recursive: true, force: true });
}
