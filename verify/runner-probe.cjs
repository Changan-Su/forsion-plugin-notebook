// 不起应用,直接起一个运行器发几格,核对它出的事件。用法:node verify/runner-probe.cjs [python]
// 缺省用桌面端检出里的自带 Python。退出码非 0 = 有一项没过。
const { spawn } = require('child_process'); const path = require('path'); const fs = require('fs'); const os = require('os')
const ROOT = path.join(__dirname, '..'); const PYDIR = path.join(ROOT, 'tangu-plugins', 'notebook-kernel', 'python')
const py = process.argv[2] || path.join(process.env.GENESIS_DESKTOP || path.join(ROOT, '..', '..', 'Forsion-Genesis', 'desktop'), 'build', 'python', 'bin', 'python3')
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-probe-')); fs.writeFileSync(path.join(cwd, 'side.py'), 'VALUE = 7\n')
const env = { ...process.env, FORSION_NB_VENDOR: path.join(PYDIR, 'vendor'), PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }
const p = spawn(py, [path.join(PYDIR, 'runner.py')], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''; let cur = []; const waiters = []; let diag = ''
p.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const e = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); cur.push(e); if (['done', 'ready', 'fatal'].includes(e.t)) { const evs = cur; cur = []; waiters.shift()?.(evs) } } })
p.stderr.on('data', (c) => { diag += c })
const next = () => new Promise((r) => waiters.push(r))
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n')
let n = 0; let bad = 0
const run = async (code, opts = {}) => { send({ op: 'exec', id: `c${++n}`, code }); if (opts.interrupt === 0) send({ op: 'interrupt' }); else if (opts.interrupt) setTimeout(() => send({ op: 'interrupt' }), opts.interrupt); return next() }
const text = (evs, name) => evs.filter((e) => e.t === 'stream' && (!name || e.name === name)).map((e) => e.text).join('')
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) bad++ }
;(async () => {
  const [ready] = await next()
  if (ready.t !== 'ready') { console.log('✗ 没起来', JSON.stringify(ready), diag); process.exit(1) }
  console.log(`Python ${ready.python} · IPython ${ready.ipython}${ready.vendored ? '(插件带的)' : '(环境里的)'}`)
  let e = await run('import pandas as pd\ndf = pd.DataFrame({"a": [1, 2, 3], "b": [0.5, 1.5, 2.5]})\ndf.head()')
  const res = e.find((x) => x.t === 'result'); const done = e.at(-1)
  ok('表格:结果里有 text/html', !!res?.data['text/html']?.includes('<table'), JSON.stringify(e).slice(0, 300))
  ok('变量:df 带形状和列', done.vars?.some((v) => v.name === 'df' && v.shape === '3 × 2' && v.cols?.length === 2), JSON.stringify(done.vars))
  e = await run('import matplotlib.pyplot as plt\ndf.plot.bar(y="b");')
  const img = e.find((x) => x.t === 'display')
  ok('图:display 里有 png,带显示尺寸', (img?.data['image/png'] || '').length > 1000 && !!img?.metadata['image/png']?.width, JSON.stringify(e).slice(0, 300))
  e = await run('%matplotlib inline\n%time sum(range(10**5))')
  ok('% 命令:%time 有输出和结果', /Wall time/.test(text(e)) && e.some((x) => x.t === 'result'), JSON.stringify(e).slice(0, 300))
  e = await run('!echo from-shell')
  ok('! 命令:输出进了流', /from-shell/.test(text(e)), JSON.stringify(e))
  e = await run('import subprocess, sys\nsubprocess.run([sys.executable, "-c", "print(6*7)"])\nprint("after")')
  ok('子进程直接写到标准输出也收得到', /42/.test(text(e, 'stdout')) && /after/.test(text(e, 'stdout')), JSON.stringify(e))
  e = await run('import sys\nprint("err", file=sys.stderr)\n1/0')
  const err = e.find((x) => x.t === 'error')
  ok('报错:有 ename / evalue,回溯不带颜色码', err?.ename === 'ZeroDivisionError' && err.traceback.length > 0 && !/\x1b\[/.test(err.traceback.join('')) && /err/.test(text(e, 'stderr')) && e.at(-1).ok === false, JSON.stringify(e).slice(0, 400))
  // 刚发出去就中断(格子的代码还没开始跑,IPython 正在做开跑前的准备):照样停得住,输出里也没有 IPython 的内部报错
  for (const delay of [0, 1, 3, 8]) {
    const tq = Date.now(); e = await run('import time\ntime.sleep(20)\nprint("ran to the end")', { interrupt: delay })
    ok(`发出后 ${delay} 毫秒就中断:马上停,没有跑完,也没有「Error in callback」`, Date.now() - tq < 3000 && e.some((x) => x.t === 'error' && x.ename === 'KeyboardInterrupt') && !e.some((x) => x.t === 'stream' && /ran to the end|Error in callback/.test(x.text)), `${Date.now() - tq}ms ${JSON.stringify(e).slice(0, 300)}`)
  }
  let t0 = Date.now(); e = await run('import time\nfor i in range(100):\n    print(i); time.sleep(0.1)', { interrupt: 500 })
  ok('中断(Python 循环):很快停下,报 KeyboardInterrupt', Date.now() - t0 < 3000 && e.some((x) => x.t === 'error' && x.ename === 'KeyboardInterrupt'), `${Date.now() - t0}ms`)
  e = await run('x = 41 + 1\nx')
  ok('中断之后内核还活着,变量还在', e.find((x) => x.t === 'result')?.data['text/plain'] === '42' && e.at(-1).vars.some((v) => v.name === 'df'))
  e = await run('import side\nside.VALUE')
  ok('能 import 笔记本同一个文件夹里的模块', e.find((x) => x.t === 'result')?.data['text/plain'] === '7', JSON.stringify(e).slice(0, 300))
  e = await run('name = input("?")')
  ok('input() 给出明确的报错,不会卡住', e.some((x) => x.t === 'error' && /input\(\)/.test(x.evalue)))
  e = await run('import asyncio\nawait asyncio.sleep(0.01)\n"awaited"')
  ok('顶层 await', e.find((x) => x.t === 'result')?.data['text/plain'] === "'awaited'")
  e = await run('from IPython.display import display, HTML\ndisplay(HTML("<b>hi</b>"))')
  ok('display(HTML)', e.find((x) => x.t === 'display')?.data['text/html'] === '<b>hi</b>')
  send({ op: 'shutdown' })
  p.on('exit', (code) => { ok('shutdown 后干净退出', code === 0, `code=${code}`); fs.rmSync(cwd, { recursive: true, force: true }); if (diag.trim()) console.log('[运行器自己的 stderr]', diag.trim().slice(0, 400)); process.exit(bad ? 1 : 0) })
})()
