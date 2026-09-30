/**
 * Reproducible UI recording against a controlled local website, never live leads.
 * Run: node scripts/alex-record-demo.mjs [--output-dir docs/assets]
 * Requires the app's playwright-core, Chromium, Python 3 and Pillow.
 * Uses temporary data/browser/backup directories and a fresh random API token.
 * No production workspace, credentials, model endpoint or external website is used.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createAlexServer } from '../apps/alex/server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some((argument, index) => argument !== '--output-dir' && args[index - 1] !== '--output-dir')) throw new Error('仅支持 --output-dir 输出目录');
const outputIndex = args.indexOf('--output-dir');
if (outputIndex >= 0 && !args[outputIndex + 1]) throw new Error('--output-dir 需要目录路径');
const outputDir = resolve(root, outputIndex < 0 ? 'docs/assets' : args[outputIndex + 1]);
const protectedDirectories = [join(root, 'work/alex'), process.env.ALEX_DATA_DIR, process.env.ALEX_BACKUP_DIR].filter(Boolean).map(value => resolve(value));
if (protectedDirectories.some(directory => outputDir === directory || outputDir.startsWith(`${directory}/`))) throw new Error('演示素材不得输出到已有用户资料或备份目录。');
const python = process.env.ALEX_DEMO_PYTHON || 'python3';
const preflight = spawnSync(python, ['-c', 'import PIL'], { encoding: 'utf8' });
if (preflight.status !== 0) throw new Error('录制需要 Python 3 与 Pillow；在独立虚拟环境中安装 Pillow，然后使用 ALEX_DEMO_PYTHON 指向该 Python。');

const fixtureHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Demo Trade Lab | 受控测试网站</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*{box-sizing:border-box}body{margin:0;font-family:Arial,"Noto Sans CJK SC",sans-serif;background:#f4f4ed;color:#20372f}.notice{background:#f4df8f;padding:14px 45px;font-size:15px;font-weight:600}.head{padding:30px 48px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #d9dece}.logo{font-weight:800;letter-spacing:2px;font-size:22px}.head span{color:#7a8973;font-size:14px}.content{padding:50px 48px;max-width:980px}.kicker{color:#7c9167;font-size:14px;letter-spacing:2px}.content h1{font-size:46px;letter-spacing:-1px;margin:18px 0 20px}.content p{font-size:18px;color:#768368;line-height:1.8;max-width:690px}.catalogue{display:flex;gap:20px;margin-top:24px}.item{padding:22px;background:#fff;border:1px solid #dbe3d2;border-radius:12px;width:250px}.item strong{display:block;color:#355535;font-size:18px}.item small{display:block;color:#8b9b7c;margin-top:12px}.action{margin-top:28px;padding:17px 25px;border:0;border-radius:9px;background:#174b40;color:white;font-size:16px;cursor:pointer}.contacts{font-size:16px;color:#7b8b6f;padding:28px 48px;border-top:1px solid #d9dece}.contacts strong{color:#486041}.confirmation{margin-top:16px;color:#537449!important;font-size:16px!important}
</style></head><body>
<div class="notice">功能演示 · 受控测试网站 · 不是真实客户来源</div>
<header class="head"><div class="logo">DEMO TRADE LAB<span> / TEST FIXTURE</span></div><span>Precision tooling · Industrial distribution</span></header>
<main class="content"><div class="kicker">CATALOGUE / 示例目录</div><h1>Precision tools,<br>documented clearly.</h1><p>受控测试目录：精密加工刀具、工业分销业务与公开联系资料。此页面只用于验证浏览器读取、证据存档、去重和人工接管。</p><div class="catalogue"><div class="item"><strong>Precision tooling</strong><small>测试产品资料 · 非商业报价</small></div><div class="item"><strong>Industrial distribution</strong><small>测试业务分类 · 非真实公司声明</small></div></div><button id="demo-action" class="action" type="button">测试人工接管：点击核验</button><p id="confirmation" class="confirmation" hidden></p></main>
<footer class="contacts"><strong>测试联系资料：</strong> sales@demo-trade.test · +49 123 456789<br>该地址和号码用于功能演示，不可作为真实客户联系方式。</footer>
<script>document.getElementById('demo-action').addEventListener('click',function(){this.textContent='人工操作已完成 · 测试网站';const message=document.getElementById('confirmation');message.hidden=false;message.textContent='同一浏览器会话收到了实际点击，Alex 截图会显示这个变化。';});</script>
</body></html>`;

async function listen(server) {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function until(check, description, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`录制步骤未完成：${description}`);
}

const temporaryDir = await mkdtemp(join(tmpdir(), 'alex-demo-recording-'));
const previousBackupDir = process.env.ALEX_BACKUP_DIR;
process.env.ALEX_BACKUP_DIR = join(temporaryDir, 'backups');
let app;
let uiBrowser;
let fixture;
const frames = [];
const diagnostics = [];
try {
  await mkdir(outputDir, { recursive: true });
  const frameDir = join(temporaryDir, 'frames');
  await mkdir(frameDir);
  fixture = http.createServer((request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(fixtureHtml);
  });
  const fixtureUrl = await listen(fixture);
  app = await createAlexServer({
    dataDir: join(temporaryDir, 'workspace'), token: randomBytes(32).toString('hex'),
    allowLocalTest: true, llm: { apiKey: '', baseUrl: '', model: '' },
  });
  assert.equal(app.browser.state().available, true, '录制必须使用实际运行的 Chromium');
  const base = await listen(app.server);
  uiBrowser = await chromium.launch({ executablePath: app.browser.executablePath, headless: true });
  const page = await uiBrowser.newPage({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => diagnostics.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });

  async function mark(caption) {
    await page.evaluate(text => {
      let banner = document.getElementById('alex-recording-banner');
      if (!banner) {
        banner = document.createElement('div'); banner.id = 'alex-recording-banner';
        Object.assign(banner.style, { position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: '10000', padding: '10px 24px', width: '650px', border: '1px solid #e1c969', borderRadius: '12px', background: '#fff6d6', color: '#665324', boxShadow: '0 3px 14px #3d442014', fontFamily: '"Noto Sans CJK SC", "Microsoft YaHei", sans-serif', textAlign: 'center', pointerEvents: 'none' });
        const title = document.createElement('strong'); title.textContent = '功能演示 · 测试网站（非真实获客数据）';
        Object.assign(title.style, { display: 'block', fontSize: '17px', letterSpacing: '.5px', lineHeight: '1.5' });
        const subtitle = document.createElement('span'); subtitle.id = 'alex-recording-caption';
        Object.assign(subtitle.style, { display: 'block', fontSize: '13px', marginTop: '3px', lineHeight: '1.5' });
        banner.append(title, subtitle);
      }
      // An open <dialog> owns the browser top layer. Keep the recording label
      // inside that layer so its backdrop cannot dim the mandatory test marker.
      const activeDialog = document.getElementById('modal');
      const parent = activeDialog?.open ? activeDialog : document.body;
      if (banner.parentElement !== parent) parent.append(banner);
      document.getElementById('alex-recording-caption').textContent = text;
    }, caption);
    assert.equal(await page.locator('#alex-recording-banner').isVisible(), true);
  }
  async function capture(caption, duration = 850, { cover = false } = {}) {
    await mark(caption);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(180);
    const path = join(frameDir, `${String(frames.length).padStart(2, '0')}.png`);
    await page.screenshot({ path, animations: 'disabled', fullPage: false });
    frames.push({ path, caption, duration, cover });
  }
  async function reload() {
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#browser-frame').waitFor({ state: 'visible' });
  }
  async function research({ again = false } = {}) {
    await page.locator('#structured-open').click();
    await page.locator('#structured-form [name=count]').fill('1');
    await page.locator('#structured-form [name=urls]').fill(fixtureUrl);
    await page.locator('#structured-form [name=notes]').fill(again ? '功能演示：归档后重复核验同一个测试网站，验证档案去重' : '功能演示：读取受控测试网站，不是真实获客数据');
    if (!again) await capture('02 / 填写本次条件，提供受控测试网站地址', 900);
    const previousCount = app.store.listTasks().length;
    await page.locator('#structured-form button[type=submit]').click();
    await until(() => app.store.listTasks().length === previousCount + 1 && app.store.listTasks()[0].status === 'completed', '测试网站核验与证据存档');
    await reload();
  }

  await capture('01 / 你的业务资料，由用户首次定义', 700);
  await page.locator('#edit-profile').click();
  await page.locator('#profile-form [name=companyName]').fill('我的外贸工作空间 · 演示资料');
  await page.locator('#profile-form [name=product]').fill('精密加工刀具');
  await page.locator('#profile-form [name=market]').fill('德国');
  await page.locator('#profile-form [name=customerType]').fill('工业分销商');
  await page.locator('#profile-form [name=notes]').fill('这是一份功能演示资料，目标与市场由用户填写。');
  await capture('01 / 保存用户明确填写的业务资料，后续任务继续读取', 950);
  await page.locator('#profile-form button[type=submit]').click();
  await until(() => app.store.getProfile().facts.product === '精密加工刀具', '用户资料保存');
  await page.locator('#modal').waitFor({ state: 'hidden' });
  await capture('01 / 业务记忆已保存，首次了解后可继续使用', 650);
  await research();
  assert.equal(app.store.listCompanies().length, 1);
  const companyId = app.store.listCompanies()[0].id;
  assert.equal(app.store.getProfile().facts.market, '德国');
  assert.equal(await page.locator('#profile-summary').innerText().then(text => text.includes('精密加工刀具')), true, '资料在页面重载后仍然存在');
  await page.locator('[data-tab=companies]').click();
  await capture('03 / 实际访问测试网站，读取网页并保存来源证据', 1200, { cover: true });
  await page.locator('[data-action=company]').click();
  assert.match(await page.locator('#modal-body').innerText(), /sales@demo-trade\.test/u);
  await capture('04 / 客户档案附带网页正文、读取时间与公开测试联系方式', 1150);
  await page.locator('#modal-close').click();
  await page.locator('[data-action=archive]').click();
  await until(() => app.store.listCompanies().length === 0, '客户归档');
  await page.locator('#include-archived').check();
  await page.locator('[data-action=company]').waitFor();
  await capture('05 / 归档保留历史，仍参加后续查重', 750);
  await research({ again: true });
  const allCompanies = app.store.listCompanies({ includeArchived: true });
  assert.equal(allCompanies.length, 1, '归档后重新研究不得新增重复公司');
  assert.equal(allCompanies[0].id, companyId, '重复来源更新同一个稳定客户编号');
  assert.equal(allCompanies[0].archived, true, '重复发现不得悄悄解除归档');
  await page.locator('[data-tab=companies]').click();
  await page.locator('#include-archived').check();
  await page.locator('[data-action=company]').waitFor();
  await capture('05 / 再次核验同一网站：仍是一份档案，不重复新增', 1100);
  await page.locator('[data-tab=backups]').click();
  await page.locator('#backup-button').click();
  await page.locator('#backups-list .record-card').waitFor();
  await capture('06 / 创建本机备份，保存客户、记忆、任务与证据', 1050);
  await page.locator('#takeover-button').click();
  await page.locator('#release-button').waitFor();
  await until(() => app.browser.state().owner === 'human', '同会话浏览器接管');
  await capture('07 / 接管正在使用的同一个浏览器，亲自继续操作', 850);
  const actionBounds = await app.browser.page.locator('#demo-action').boundingBox();
  const frameBounds = await page.locator('#browser-frame').boundingBox();
  const dimensions = await page.locator('#browser-frame').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
  assert.deepEqual(dimensions, { width: 1280, height: 800 });
  assert.ok(actionBounds && frameBounds);
  await page.locator('#browser-frame').click({ position: {
    x: (actionBounds.x + actionBounds.width / 2) * frameBounds.width / dimensions.width,
    y: (actionBounds.y + actionBounds.height / 2) * frameBounds.height / dimensions.height,
  } });
  await until(async () => (await app.browser.page.locator('#demo-action').innerText()).includes('人工操作已完成'), '通过工作台截图映射点击网页按钮');
  await page.waitForTimeout(2200);
  await capture('07 / 画面上的点击已在实际测试网页生效', 1000);
  await page.locator('#release-button').click();
  await until(() => app.browser.state().owner === 'agent', '浏览器交还');
  await capture('08 / 交还控制权，记忆、档案和备份留在工作空间', 850);
  assert.deepEqual(diagnostics, [], '工作台不得出现 JavaScript 错误');

  const manifestPath = join(temporaryDir, 'recording.json');
  await writeFile(manifestPath, JSON.stringify({ width: 1000, frames }, null, 2));
  const encoded = spawnSync(python, [join(root, 'scripts/alex-encode-demo.py'), manifestPath, outputDir], { encoding: 'utf8' });
  if (encoded.status !== 0) throw new Error(`演示编码失败：${encoded.stderr || encoded.stdout || 'unknown error'}`);
  const report = {
    type: 'controlled-functional-demo', label: '功能演示 · 测试网站（非真实获客数据）',
    frameCount: frames.length, durationMs: frames.reduce((sum, frame) => sum + frame.duration, 0),
    width: 1000, height: 750, customerCountAfterRepeatedResearch: allCompanies.length,
    stableCustomerIdentityVerified: true, archivedIdentityPreserved: true,
    profileSurvivesReload: true, browserClickVerified: true,
    modelCalls: 0, productionWorkspaceUsed: false,
    assets: ['alex-workbench.gif', 'alex-workbench-cover.png', 'alex-workbench-contactsheet.png'],
    steps: frames.map(({ caption, duration }) => ({ caption, durationMs: duration })),
  };
  await writeFile(join(outputDir, 'alex-demo-manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  const gif = await stat(join(outputDir, 'alex-workbench.gif'));
  console.log(`已录制 ${frames.length} 个真实工作台画面，${report.durationMs / 1000} 秒，GIF ${(gif.size / 1024 / 1024).toFixed(2)} MB。`);
  console.log('素材明确标注受控测试网站，不代表真实获客验收。');
} finally {
  if (uiBrowser) await uiBrowser.close();
  if (app) await app.close();
  if (fixture?.listening) await new Promise(resolveClose => fixture.close(resolveClose));
  if (previousBackupDir === undefined) delete process.env.ALEX_BACKUP_DIR;
  else process.env.ALEX_BACKUP_DIR = previousBackupDir;
  await rm(temporaryDir, { recursive: true, force: true });
}
