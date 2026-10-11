// 不起应用:拿一个假的引擎上下文激活引擎插件,直接调它的路由,核对起停、排队、事件、中断、退回自带、进程死掉。
// 用法:node verify/engine-probe.mjs   (自带 Python 取桌面端检出里的那份,GENESIS_DESKTOP 可改)
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const kdir = join(root, 'tangu-plugins', 'notebook-kernel')
process.env.TANGU_PYTHON_BIN = join(process.env.GENESIS_DESKTOP || join(root, '..', '..', 'Forsion-Genesis', 'desktop'), 'build', 'python', 'bin', 'python3')
if (!existsSync(process.env.TANGU_PYTHON_BIN)) throw new Error(`找不到自带 Python:${process.env.TANGU_PYTHON_BIN}`)
const plugin = (await import(join(kdir, 'dist', 'index.js'))).default
const routes = {}
const router = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((m) => [m, (p, h) => { routes[p] = h }]))
let provider
plugin.activate({ registerScopedRoutes: (mount) => mount(router), registerPlugin() {}, registerToolProvider(p) { provider = p }, registerCommand() {}, log: (m) => process.env.VERBOSE && console.log('  [log]', m), paths: { pluginDir: kdir, dataDir: tmpdir() }, sdk: {}, activity: { append() {} } })
const call = (path, body) => new Promise((resolve) => { const res = { code: 200, headersSent: false, status(c) { this.code = c; return this }, json(o) { this.headersSent = true; resolve({ code: this.code, ...o }) } }; routes[path]({ body, user: { userId: 'u1' }, headers: {} }, res) })
const dir = mkdtempSync(join(tmpdir(), 'nb-engine-')); const nb = join(dir, 'a.ipynb'); writeFileSync(nb, '{}')
let bad = 0; const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : `  ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 500)}`}`); if (!cond) bad++ }
let since = 0
const drain = async (until, ms = 20000) => { const all = []; const t0 = Date.now(); for (;;) { const r = await call('/events', { nb, since, wait: 500 }); since = r.events.at(-1)?.seq ?? since; all.push(...r.events); if (until(all, r) || Date.now() - t0 > ms) return { all, last: r } } }
const doneOf = (all, cell) => all.find((e) => e.t === 'done' && e.cell === cell)

let r = await call('/exec', { nb, cells: [{ cell: 'x', code: '1' }] })
ok('没起内核就执行 → 409', r.code === 409, r)
r = await call('/open', { nb: 'relative.ipynb' })
ok('相对路径被拒', r.code === 400, r)
r = await call('/envs', { nb })
ok('环境列表里有自带的,排在最后', r.envs?.at(-1)?.kind === 'bundled' && !!r.envs.at(-1).version, r)
console.log('  环境:', r.envs.map((e) => `${e.label}(${e.kind} ${e.version ?? '?'}${e.ok ? '' : ` ✗${e.why}`})`).join(' · '))
r = await call('/open', { nb })
ok('起内核:自带 Python,就绪', r.state === 'idle' && r.python?.kind === 'bundled' && !!r.python.ipython, r)
since = r.head
r = await call('/exec', { nb, cells: [{ cell: 'c1', code: 'import time\nfor i in range(3):\n    print(i); time.sleep(0.15)\nx = 5\nx' }, { cell: 'c2', code: 'x * 2' }] })
ok('两格入队', r.accepted?.length === 2, r)
let d = await drain((all) => doneOf(all, 'c2'))
const order = d.all.filter((e) => ['queued', 'start', 'done'].includes(e.t)).map((e) => `${e.t}:${e.cell}`).join(' ')
ok('事件顺序:入队 → c1 跑完 → c2 才开始', /queued:c1 queued:c2 start:c1 done:c1 start:c2 done:c2/.test(order), order)
const stream = d.all.filter((e) => e.t === 'stream' && e.cell === 'c1').map((e) => e.text).join('')
ok('流输出完整,且被合并成比写入次数少的事件', stream === '0\n1\n2\n' && d.all.filter((e) => e.t === 'stream').length < 6, d.all.filter((e) => e.t === 'stream'))
ok('结果值和执行序号', d.all.find((e) => e.t === 'result' && e.cell === 'c2')?.data['text/plain'] === '10' && doneOf(d.all, 'c2').n === 2)
ok('done 带变量', doneOf(d.all, 'c2').vars?.some((v) => v.name === 'x' && v.value === '5'), doneOf(d.all, 'c2'))
// 出错后,后面排着的不再跑
await call('/exec', { nb, cells: [{ cell: 'e1', code: '1/0' }, { cell: 'e2', code: 'print("should not run")' }] })
d = await drain((all) => doneOf(all, 'e2'))
ok('一格出错,排在后面的被取消(不执行)', doneOf(d.all, 'e1')?.ok === false && doneOf(d.all, 'e2')?.aborted === true && !d.all.some((e) => e.t === 'stream' && e.cell === 'e2'), d.all)
// 中断卡在 sleep 里的格子
await call('/exec', { nb, cells: [{ cell: 's1', code: 'import time\ntime.sleep(30)' }, { cell: 's2', code: '1' }] })
await drain((all) => all.some((e) => e.t === 'start' && e.cell === 's1'))
const t0 = Date.now(); await call('/interrupt', { nb })
d = await drain((all) => doneOf(all, 's2'), 8000)
ok('中断:卡在 sleep 里也能马上停,排队的一并取消', Date.now() - t0 < 4000 && d.all.some((e) => e.t === 'error' && e.cell === 's1' && e.ename === 'KeyboardInterrupt') && doneOf(d.all, 's2')?.aborted, `${Date.now() - t0}ms ${JSON.stringify(d.all).slice(0, 300)}`)
await call('/exec', { nb, cells: [{ cell: 'a1', code: 'x' }] }); d = await drain((all) => doneOf(all, 'a1'))
ok('中断之后变量还在', d.all.find((e) => e.t === 'result')?.data['text/plain'] === '5')
// 重启:变量清空
r = await call('/open', { nb, restart: true }); ok('重启后就绪', r.state === 'idle', r)
await call('/exec', { nb, cells: [{ cell: 'a2', code: 'x' }] }); d = await drain((all) => doneOf(all, 'a2'))
ok('重启后变量没了', d.all.some((e) => e.t === 'error' && e.ename === 'NameError'))
// 进程自己死掉
await call('/exec', { nb, cells: [{ cell: 'k1', code: 'import os\nos._exit(7)' }, { cell: 'k2', code: '1' }] })
d = await drain((all, st) => st.state === 'dead' && doneOf(all, 'k2'), 8000)
ok('进程死掉:正在跑的和排队的都收尾,状态 dead', doneOf(d.all, 'k1')?.died && doneOf(d.all, 'k2')?.aborted && d.last.state === 'dead', d.all)
r = await call('/exec', { nb, cells: [{ cell: 'z', code: '1' }] }); ok('死了之后执行 → 409', r.code === 409, r)
// 选了一个不存在的解释器 → 退回自带
r = await call('/open', { nb, python: join(dir, 'nope', 'bin', 'python') })
ok('记着的解释器不在了:用自带的起来,并说明退回了', r.state === 'idle' && r.python?.kind === 'bundled' && !!r.fellBack, r)
// 选了一个起不来的「解释器」(不是 Python)→ 退回自带
if (process.platform !== 'win32') {
  r = await call('/open', { nb, python: '/bin/echo', restart: true })
  ok('选的那个不是能用的 Python:退回自带', r.state === 'idle' && r.python?.kind === 'bundled' && !!r.fellBack, r)
}
// 吞掉中断的死循环:关闭后进程也得没(先收 stdin,1.5 秒后强杀)
await call('/exec', { nb, cells: [{ cell: 'w1', code: 'import time\nwhile True:\n    try:\n        time.sleep(0.05)\n    except BaseException:\n        pass' }] })
await drain((all) => all.some((e) => e.t === 'start' && e.cell === 'w1'))
const alive = () => execSync(`pgrep -f "${join(kdir, 'python', 'runner.py')}" || true`).toString().trim()
ok('关闭前:运行器进程在', !!alive())
r = await call('/shutdown', { nb }); ok('关闭', r.state === 'dead')
await new Promise((res) => setTimeout(res, 3000))
ok('关闭后 3 秒:吞中断的死循环也没留下进程', !alive(), alive())
r = await call('/events', { nb, since: 0, wait: 0 }); ok('关闭后查事件不报错', r.state === 'dead' && r.code === 200, r)

// ── Tangu 的三件工具(直接调 execute,不经模型) ──
const { readFileSync } = await import('node:fs')
const tools = Object.fromEntries(provider.tools().map((d) => [d.name, d]))
const tctx = { userId: 'u1', sessionId: 's', appId: 'a', cwd: dir }
const nb2 = join(dir, 'b.ipynb')
const J = (cells, minor = 5) => JSON.stringify({ cells, metadata: { keep: { me: 1 } }, nbformat: 4, nbformat_minor: minor }, null, 1) + '\n'
writeFileSync(nb2, J([{ cell_type: 'markdown', id: 'intro', metadata: {}, source: ['# 标题'] }, { cell_type: 'code', execution_count: null, id: 'c1', metadata: { tags: ['t'] }, outputs: [], source: ['y = 20\n', 'y + 1'] }]))
ok('三件工具都在,改和跑走「跑命令」那档审批,读不用', ['notebook_read', 'notebook_edit', 'notebook_run'].every((n) => tools[n]) && tools.notebook_edit.capabilities.approval === 'command' && tools.notebook_run.capabilities.approval === 'command' && !tools.notebook_read.capabilities.approval, Object.keys(tools))
ok('工具说明是英文', provider.tools().every((d) => !/[\u4e00-\u9fff]/.test(JSON.stringify(d.definition) + (d.deferHint ?? ''))))
let out = await tools.notebook_read.execute({ path: 'b.ipynb' }, tctx)
ok('读:按相对路径,列出每格的位置 / id / 类型 / 源码', /2 cells/.test(out) && /\[1\] markdown id=intro\n# 标题/.test(out) && /\[2\] code id=c1\ny = 20\ny \+ 1/.test(out), out)
out = await tools.notebook_read.execute({ path: '../etc/passwd' }, tctx)
ok('不是 .ipynb 的路径被拒', /^Error:/.test(out), out)
out = await tools.notebook_run.execute({ path: nb2, cell: 'c1' }, tctx)
ok('跑一格:返回输出,并说明用的哪个 Python', /--- output ---\n21/.test(out) && /bundled with Forsion/.test(out), out)
let disk = JSON.parse(readFileSync(nb2, 'utf8'))
ok('没有页面跟着时由工具落盘:输出、序号写进文件,别的原样', disk.cells[1].execution_count === 1 && disk.cells[1].outputs[0]?.data?.['text/plain']?.[0] === '21' && disk.metadata.keep.me === 1 && disk.cells[1].metadata.tags[0] === 't', disk.cells[1])
out = await tools.notebook_edit.execute({ path: nb2, action: 'insert', cell: 'c1', source: 'print(y * 2)\nboom' }, tctx)
const newId = /id=(\w+)/.exec(out)?.[1]
ok('插入一格:落在指定那格后面', /Cell 3 id=/.test(out) && JSON.parse(readFileSync(nb2, 'utf8')).cells[2].source.join('') === 'print(y * 2)\nboom', out)
out = await tools.notebook_run.execute({ path: nb2, cell: newId }, tctx)
ok('和上一格共用同一个内核(y 还在),报错原样带回', /40/.test(out) && /NameError/.test(out), out)
out = await tools.notebook_edit.execute({ path: nb2, action: 'replace', cell: '3', source: 'print(y * 3)' }, tctx)
disk = JSON.parse(readFileSync(nb2, 'utf8'))
ok('替换:源码换掉、旧输出清掉,前一格的输出还在', disk.cells[2].source.join('') === 'print(y * 3)' && disk.cells[2].outputs.length === 0 && disk.cells[1].outputs.length === 1, disk.cells[2])
out = await tools.notebook_run.execute({ path: nb2, cell: 'all' }, tctx)
ok('全部运行', /21/.test(out) && /60/.test(out), out)
out = await tools.notebook_edit.execute({ path: nb2, action: 'delete', cell: 'intro' }, tctx)
ok('删除', /2 cells/.test(out) && JSON.parse(readFileSync(nb2, 'utf8')).cells[0].id === 'c1', out)
out = await tools.notebook_edit.execute({ path: nb2, action: 'replace', cell: 'nope', source: 'x' }, tctx)
ok('找不到的格子:报错,不写文件', /^Error: no cell/.test(out), out)
// 页面跟着内核时(它在轮询),工具不落盘 —— 由页面写
await call('/events', { nb: nb2, since: 0, wait: 0 })
const before = readFileSync(nb2, 'utf8')
out = await tools.notebook_run.execute({ path: nb2, cell: 'c1' }, tctx)
ok('页面跟着这个内核时:工具照样返回输出,但不去写文件(留给页面)', /21/.test(out) && readFileSync(nb2, 'utf8') === before, out)
r = await call('/status', { nb: nb2, python: '' })
ok('/status:页面打开时能看到 Tangu 起的内核', r.state === 'idle' && r.python?.kind === 'bundled', r)
// 等不到结果:先返回,内核接着跑,跑完再落盘
await new Promise((res) => setTimeout(res, 21_000)) // 等「页面跟着」的窗过去
writeFileSync(nb2, J([{ cell_type: 'code', execution_count: null, id: 'slow', metadata: {}, outputs: [], source: ['import time; time.sleep(3); print("late")'] }]))
out = await tools.notebook_run.execute({ path: nb2, cell: 'slow', timeout_seconds: 1 }, tctx)
ok('超过等待时间:先返回「还在跑」', /^Still running/.test(out), out)
await new Promise((res) => setTimeout(res, 4000))
ok('跑完之后输出照样写进了文件', JSON.parse(readFileSync(nb2, 'utf8')).cells[0].outputs[0]?.text?.join('') === 'late\n', readFileSync(nb2, 'utf8').slice(0, 400))
await call('/shutdown', { nb: nb2 })
await plugin.deactivate(); rmSync(dir, { recursive: true, force: true })
setTimeout(() => process.exit(bad ? 1 : 0), 300)
