// 真应用冒烟:隔离 home 起一份已构建的桌面端 + 它自己托管的真引擎,把本插件(界面那一半 + 引擎那一半)装进隔离 home,
// 打开一本 .ipynb → 运行 → 结果在页面上、也在盘上 → 出图 / 报错 → 变量面板 → 内核菜单 → 重启后变量清空 →
// 阅读模式 → 笔记里按格嵌入 → 关掉标签后 Python 进程退出。不碰开发实例、不用模型额度。
// 跑(仓根):node .claude/hooks/devlock.cjs run --vehicle=e2e --what="Jupyter 插件冒烟" --eta=5 -- node Forsion-Instrumentality-Project/forsion-plugin-notebook/verify/smoke.cjs
// UI_ZOOM=1.1 在界面缩放 110% 下跑同一遍(菜单位置这类问题只在这里看得见)。先 npm run build。
const fs = require('fs'); const os = require('os'); const path = require('path'); const { execSync } = require('child_process')
const ROOT = path.resolve(__dirname, '..')
const DESK = process.env.GENESIS_DESKTOP || path.resolve(ROOT, '../../Forsion-Genesis/desktop')
const electron = require(path.join(DESK, 'scripts/lib/launch-electron.cjs'))
const OUT = path.join(__dirname, '.out'); fs.mkdirSync(OUT, { recursive: true })
const Z = Number(process.env.UI_ZOOM) || 1
const TAG = Z === 1 ? '' : `-z${Math.round(Z * 100)}`
let bad = 0
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : `  ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 600)}`}`); if (!cond) bad++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, every = 300) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(every) } }

const NB = '试验.ipynb'; const NOTE = '周报'
const cell = (id, source, type = 'code') => type === 'code' ? { cell_type: 'code', execution_count: null, id, metadata: {}, outputs: [], source } : { cell_type: 'markdown', id, metadata: {}, source }
const NOTEBOOK = { cells: [
  cell('intro', ['# 试验记录\n', '\n', '先算个数,再画张图。'], 'markdown'),
  cell('calc', ['x = 6 * 7\n', 'print("hello", x)\n', 'x']),
  cell('plot', ['import matplotlib.pyplot as plt\n', 'plt.plot([1, 4, 9])\n', 'plt.title("squares");']),
  cell('boom', ['1 / 0']),
], metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, custom_tool: { keep: true } }, nbformat: 4, nbformat_minor: 5 }

async function main() {
  for (const f of ['main.js', 'tangu-plugins/notebook-kernel/dist/index.js']) if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`缺 ${f} —— 先 npm run build`)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-nbsmoke-'))
  const userData = path.join(home, 'userdata'); const vault = path.join(home, 'Vault'); const dir = path.join(vault, '分析')
  fs.mkdirSync(dir, { recursive: true })
  const nbFile = path.join(dir, NB)
  fs.writeFileSync(nbFile, JSON.stringify(NOTEBOOK, null, 1) + '\n')
  fs.writeFileSync(path.join(vault, `${NOTE}.md`), `## 结果\n\n图直接从笔记本里引过来:\n\n![[分析/${NB}#plot]]\n\n就这些。\n`)
  // 插件原样拷进隔离 home 的 plugins/(引擎不认符号链接;带 fileExtensions 的插件也不能走开发加载)
  const dest = path.join(home, 'plugins', 'notebook'); fs.mkdirSync(dest, { recursive: true })
  for (const f of ['manifest.json', 'main.js']) fs.copyFileSync(path.join(ROOT, f), path.join(dest, f))
  fs.cpSync(path.join(ROOT, 'tangu-plugins'), path.join(dest, 'tangu-plugins'), { recursive: true, filter: (s) => !/\/(src|types|node_modules|__pycache__)(\/|$)|tsconfig\.json$/.test(s) })
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({}))
  for (const d of [userData, `${userData}-dev`]) {
    fs.mkdirSync(d, { recursive: true })
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) fs.writeFileSync(path.join(d, f), JSON.stringify({ lastVault: vault, localVault: vault }))
    fs.writeFileSync(path.join(d, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed' })) // 托管引擎自起(缺省是等外部后端)
  }
  const runners = () => execSync(`pgrep -f "${dest}" || true`).toString().trim()
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', DESK], cwd: DESK, env: { ...process.env, TANGU_HOME: home, TANGU_HARNESS_QUIET: '1', ELECTRON_ENABLE_LOGGING: '1' } })
  const log = fs.createWriteStream(path.join(OUT, `app${TAG}.log`))
  for (const st of [app.process().stdout, app.process().stderr]) st?.on('data', (b) => log.write(b))
  try {
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1512, 950))
    await win.waitForSelector('#root', { timeout: 60_000 })
    await win.waitForTimeout(2500) // 第一次启动会把缩放重置回默认,等它做完再设,不然设了也被清掉
    if (Z !== 1) { await win.evaluate((z) => localStorage.setItem('forsion_ui_zoom', z), String(Z)); await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('#root', { timeout: 60_000 }); await win.waitForTimeout(3500) }
    const zoom = await win.evaluate(() => Number(getComputedStyle(document.body).zoom) || 1)
    ok(`界面缩放确实是 ${Z}(不是就等于没测)`, Math.abs(zoom - Z) < 0.001, zoom)
    for (const label of ['跳过引导', 'Skip']) { const b = win.locator(`text=${label}`).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
    await win.locator('#tangu-splash').waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {})
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.locator('.rb-space[aria-label="笔记"], .rb-space[aria-label="Note"]').first().click({ timeout: 15_000 })
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const row = (title) => win.locator('.t2s-srow', { has: win.locator('.t2s-srow-title', { hasText: new RegExp(`^${esc(title)}`) }) }).first()
    const folder = win.locator('.t2s-group', { has: win.locator('.t2s-group-label', { hasText: /^分析$/ }) }).first()
    await folder.waitFor({ timeout: 15_000 })
    const titles = () => win.evaluate(() => [...document.querySelectorAll('.t2s-srow-title')].map((e) => e.textContent))
    if (!(await titles()).some((t) => /试验/.test(t))) await folder.locator('.t2s-folder-row').click()
    await win.waitForTimeout(600)
    const shot = (name) => win.screenshot({ path: path.join(OUT, `${name}${TAG}.png`) })
    const errors = []; win.on('pageerror', (e) => errors.push(String(e.message)))

    // ── 打开 ──
    await row('试验').click()
    await win.waitForSelector('.nb [data-cell]', { timeout: 20_000 })
    await win.waitForTimeout(800)
    const cells = await win.evaluate(() => [...document.querySelectorAll('.nb [data-cell]')].map((e) => [e.dataset.cell, e.dataset.type, e.innerText.slice(0, 60).replace(/\s+/g, ' ')]))
    ok('打开:四格按顺序画出来,文字格是文字、代码格是代码', cells.length === 4 && cells[0][1] === 'markdown' && /试验记录/.test(cells[0][2]) && /x = 6 \* 7/.test(cells[1][2]), cells)
    const geo = await win.evaluate(() => { const r = (e) => e.getBoundingClientRect(); const bar = r(document.querySelector('.nb-bar')); const tab = r(document.querySelector('.dv-tab.dv-active-tab, .dv-tab')); const host = r(document.querySelector('.nb-host')); return { barTop: bar.top, tabBottom: tab.bottom, hostTop: host.top, hostH: host.height } })
    ok('页面在标签栏下面,不盖住它', geo.barTop >= geo.tabBottom - 2 && Math.abs(geo.barTop - geo.hostTop) < 1 && geo.hostH > 400, geo)
    ok('文字格里只有文字,没有宿主编辑器自带的那排切换按钮', await win.evaluate(() => [...document.querySelectorAll('.nb-md button[aria-pressed]')].every((b) => b.getBoundingClientRect().height === 0) && !/Markdown 源码/.test(document.querySelector('.nb-md').innerText)))
    await shot('0-open')
    ok('打开不改文件(没人动过就不写盘)', fs.readFileSync(nbFile, 'utf8') === JSON.stringify(NOTEBOOK, null, 1) + '\n')
    const C = (id) => win.locator(`.nb [data-cell="${id}"]`)
    const kernelBtn = win.locator('.nb .nb-kernel')
    ok('引擎连上后顶栏出现内核按钮(全新 home 要等引擎播种)', !!(await until(async () => await kernelBtn.count(), 150_000, 1000)), await win.locator('.nb-bar').innerText().catch(() => ''))
    ok('第一次打开:右栏的变量面板自己开出来了', !!(await until(async () => await win.locator('.nb-side-empty, .nb-side').count(), 8000)))

    // ── 运行一格 ──
    await C('calc').hover(); await C('calc').locator('[data-a="run"]').click()
    const g1 = await until(async () => (await C('calc').locator('.nb-gut').innerText()) === '[1]', 120_000)
    ok('运行第一格:序号变成 [1]', !!g1, await C('calc').locator('.nb-gut').innerText().catch(() => ''))
    const out1 = await C('calc').locator('.nb-out').innerText()
    ok('输出:print 的文字和最后一行的值', /hello 42/.test(out1) && /^42$/m.test(out1), out1)
    ok('内核按钮:自带 Python,绿点', /Forsion 自带 · Python 3\.\d+/.test(await kernelBtn.innerText()) && (await kernelBtn.getAttribute('class')).includes('idle'), await kernelBtn.innerText())
    const disk1 = await until(async () => { const c = JSON.parse(fs.readFileSync(nbFile, 'utf8')).cells[1]; return c.execution_count === 1 ? c : null }, 5000)
    ok('结果已经在盘上:execution_count、流输出、结果值(一行一个元素)', !!disk1 && JSON.stringify(disk1.outputs) === JSON.stringify([{ name: 'stdout', output_type: 'stream', text: ['hello 42\n'] }, { data: { 'text/plain': ['42'] }, execution_count: 1, metadata: {}, output_type: 'execute_result' }]), disk1 && disk1.outputs)
    ok('别的工具写的元数据还在', JSON.parse(fs.readFileSync(nbFile, 'utf8')).metadata.custom_tool?.keep === true)
    ok('变量面板:x = 42', !!(await until(async () => /x\s*int\s*42/.test((await win.locator('.nb-side').first().innerText()).replace(/\n/g, ' ')), 5000)), await win.locator('.nb-side').first().innerText().catch(() => ''))

    // ── 全部运行:出图、报错 ──
    await win.locator('.nb [data-a="runall"]').click()
    const allDone = await until(async () => (await C('boom').locator('.nb-err').count()) && (await win.locator('.nb [data-a="runall"]').count()), 120_000)
    ok('全部运行:跑到报错那格为止', !!allDone)
    const img = await C('plot').locator('.nb-out img.nb-img').first().evaluate((e) => ({ w: e.naturalWidth, shown: e.getBoundingClientRect().width / (document.body.currentCSSZoom || 1), src: e.src.slice(0, 22) })).catch(() => null)
    ok('图:行内 png,按高清图的一半尺寸显示', !!img && img.src === 'data:image/png;base64,' && img.w > 600 && Math.abs(img.shown * 2 - img.w) < 4, img)
    ok('报错:红色标题 + 折叠的回溯 + 序号标红', /ZeroDivisionError/.test(await C('boom').locator('.nb-err .hd').innerText()) && (await C('boom').locator('.nb-gut .bad').count()) === 1 && (await C('boom').locator('.nb-err pre').isHidden()))
    await C('boom').locator('[data-a="tb"]').click()
    ok('展开回溯:没有 ANSI 转义符', await C('boom').locator('.nb-err pre').evaluate((e) => !e.hidden && /ZeroDivisionError/.test(e.textContent) && !/\x1b\[/.test(e.textContent)))
    const disk2 = await until(async () => { const cs = JSON.parse(fs.readFileSync(nbFile, 'utf8')).cells; return cs[3].outputs.length ? cs : null }, 5000)
    ok('盘上:图是 image/png(带显示尺寸),报错是 error 输出', !!disk2 && typeof disk2[2].outputs.at(-1).data['image/png'] === 'string' && disk2[2].outputs.at(-1).metadata['image/png']?.width > 0 && disk2[3].outputs[0].ename === 'ZeroDivisionError', disk2 && disk2[2].outputs.map((o) => Object.keys(o.data || {})))
    await shot('1-ran')

    // ── 菜单:跟着按钮走(缩放下也不偏) ──
    const near = async (btn, menu) => { const b = await btn.boundingBox(); const m = await menu.boundingBox(); return { dr: Math.abs((b.x + b.width) - (m.x + m.width)), gap: m.y - (b.y + b.height), up: (b.y) - (m.y + m.height) } }
    await kernelBtn.click()
    const km = win.locator('.nb-menu')
    await until(async () => await km.locator('[data-env]').count(), 15_000)
    const envs = await km.locator('[data-env]').evaluateAll((els) => els.map((e) => [e.innerText.replace(/\s+/g, ' '), e.disabled, !!e.querySelector('.ctx-check svg')]))
    ok('内核菜单:列出这台电脑上的 Python,自带的排最后并打着勾', envs.length >= 1 && /Forsion 自带/.test(envs.at(-1)[0]) && envs.at(-1)[2] === true, envs)
    ok('3.10 以下的环境是灰的,写着原因', envs.filter((e) => e[1]).every((e) => /需要 3\.10 以上|起不来/.test(e[0])), envs)
    const kpos = await near(kernelBtn, km)
    ok(`内核菜单贴着按钮右缘、紧挨在下面(缩放 ${Z})`, kpos.dr < 3 && kpos.gap > 2 && kpos.gap < 12, kpos)
    await shot('2-kernel-menu')
    await win.keyboard.press('Escape')
    ok('Esc 关掉菜单', (await km.count()) === 0)
    await C('calc').hover(); await C('calc').locator('[data-a="more"]').click()
    const cpos = await near(C('calc').locator('[data-a="more"]'), km)
    ok('单元格菜单同样贴着按钮', cpos.dr < 3 && (cpos.gap > 2 && cpos.gap < 12 || cpos.up > 2 && cpos.up < 12), cpos)
    await shot('3-cell-menu')
    await win.keyboard.press('Escape')

    // ── 重启:变量清空;新加一格、打字、⇧↵ ──
    await win.locator('.nb [data-a="restart"]').click()
    await until(async () => /Python 3/.test(await kernelBtn.innerText()), 30_000)
    await win.locator('.nb .nb-ins.last [data-a="add-code"]').click()
    await win.keyboard.type('x')
    await win.keyboard.press('Shift+Enter')
    const newCell = win.locator('.nb [data-cell][data-type="code"]').nth(3)
    ok('重启后新加一格跑 x:NameError(变量确实清空了)', !!(await until(async () => /NameError/.test(await newCell.locator('.nb-err .hd').innerText()), 60_000)), await newCell.innerText().catch(() => ''))
    const disk3 = await until(async () => { const cs = JSON.parse(fs.readFileSync(nbFile, 'utf8')).cells; return cs.length === 6 && cs[4].outputs.length ? cs : null }, 5000)
    ok('盘上:新格子的源码和报错都在,⇧↵ 在末尾又接了一个空格子', !!disk3 && disk3[4].source.join('') === 'x' && disk3[4].outputs[0].ename === 'NameError' && disk3[5].source.length === 0 && new Set(disk3.map((c) => c.id)).size === 6, disk3 && disk3.map((c) => [c.id, c.source]))

    // ── 阅读模式 ──
    await win.locator('.nb [data-a="read"]').click()
    await win.waitForTimeout(500)
    const read = await win.evaluate(() => ({ cls: document.querySelector('.nb').classList.contains('nb-read'), codeHidden: [...document.querySelectorAll('.nb .nb-code')].every((e) => e.hidden), img: !!document.querySelector('.nb .nb-out img'), run: document.querySelectorAll('.nb [data-a="run"], .nb [data-a="runall"], .nb .nb-ins').length }))
    ok('阅读模式:代码收起、结果还在、没有运行和加格子的入口', read.cls && read.codeHidden && read.img && read.run === 0, read)
    await shot('4-read')
    await win.locator('.nb [data-a="edit"]').click()
    await win.waitForSelector('.nb [data-a="runall"]', { timeout: 5000 })
    ok('切回编辑:内核还在(没被重启)', /Python 3/.test(await kernelBtn.innerText()))
    ok('运行期间有 Python 进程', !!runners())

    // ── 笔记里的嵌入 + 关掉后进程退出 ──
    await row(NOTE).click()
    const emb = await until(async () => await win.locator('.nb-embed img.nb-img').count(), 20_000)
    ok('笔记里 ![[…ipynb#plot]]:画出那一格的图,下面有来源', !!emb && /试验\.ipynb/.test(await win.locator('.nb-embed .cap').innerText()) && /第 3 格/.test(await win.locator('.nb-embed .cap').innerText()), await win.locator('.nb-embed').innerText().catch(() => '(没有嵌入)'))
    await shot('5-embed')
    if (await win.locator('.nb').count()) { // 笔记开在了另一个标签里:把笔记本那个标签关掉
      const tab = win.locator('.dv-tab', { hasText: '试验' }).first()
      await tab.hover(); await tab.locator('.dv-default-tab-action, [class*="close"]').first().click().catch(async () => { await tab.click(); await win.keyboard.press('Meta+w') })
    }
    ok('关掉笔记本的标签:几秒内 Python 进程退出', !!(await until(async () => !runners(), 8000)), runners())
    ok('页面全程没有未捕获的错误', errors.length === 0, errors)
  } finally {
    await app.close().catch(() => {})
    await sleep(1500)
    const left = runners(); if (left) { console.log('✗ 应用退出后还留着运行器进程:', left); bad++; execSync(`pkill -f "${dest}" || true`) }
    if (!bad && !process.env.KEEP) fs.rmSync(home, { recursive: true, force: true }); else console.log('现场留在', home)
  }
  console.log(bad ? `\n${bad} 项没过(截图和日志在 ${OUT})` : `\n全部通过(截图在 ${OUT})`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
