// Native Windows Python + production kernel lifecycle. No UI, no global input.
// node verify/windows-kernel.mjs <python.exe>
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'win32', 'This check needs native Windows')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const py = process.argv[2] || process.env.TANGU_PYTHON_BIN
assert.ok(py, 'Pass the bundled python.exe path')
const built = await build({ entryPoints: [join(root, 'tangu-plugins/notebook-kernel/src/kernels.ts')], bundle: true, format: 'esm', platform: 'node', write: false })
const { Kernel } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const dir = mkdtempSync(join(tmpdir(), 'forsion-nb-windows-'))
const folder = join(dir, '我的 库', '分析'); mkdirSync(folder, { recursive: true })
const nb = join(folder, '试验.ipynb'); writeFileSync(nb, '{}')
const bundled = { path: resolve(py), label: 'Forsion', kind: 'bundled', ok: true }
const kernel = new Kernel(nb, join(root, 'tangu-plugins/notebook-kernel/python'), bundled, console.log)
let since = 0
const events = []
async function until(predicate, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const result = await kernel.poll(since, 100)
    if (result.events.length) since = result.events.at(-1).seq
    events.push(...result.events)
    if (predicate(events)) return
  }
  throw new Error('Timed out: ' + JSON.stringify(events.slice(-8)))
}
async function run(cell, code) {
  kernel.exec([{ cell, code }])
  await until(es => es.some(e => e.cell === cell && e.t === 'done'))
  return events.filter(e => e.cell === cell)
}
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const check = (label, value) => { assert.ok(value, label); console.log('PASS ' + label) }
let child
try {
  check('Bundled Python starts in a Chinese and spaced path', (await kernel.open(null)).state === 'idle')
  let result = await run('hello', 'x = 42\nprint("你好 hello")\nx')
  check('Unicode stream and result', result.some(e => e.t === 'stream' && e.text.includes('你好 hello')) && result.some(e => e.t === 'result' && e.data['text/plain'] === '42'))
  writeFileSync(join(folder, '中文 数据.txt'), 'fixture')
  result = await run('magic', '!dir /b\n%timeit -n 1 -r 1 sum(range(1000))')
  const shellText = result.filter(e => e.t === 'stream').map(e => e.text).join('')
  check('Windows shell command preserves Chinese filenames and IPython magic works: ' + JSON.stringify(shellText), shellText.includes('中文 数据.txt') && shellText.includes('per loop'))
  result = await run('utf8-shell', '!"' + py + '" -c "print(\'中文 UTF8\')"')
  check('Python shell output remains intact', result.some(e => e.t === 'stream' && e.text.includes('中文 UTF8')))
  result = await run('mixed-shell', '!echo 中文 shell & "' + py + '" -c "print(\'中文 Python\')"')
  const mixedText = result.filter(e => e.t === 'stream').map(e => e.text).join('')
  check('cmd built-ins and Python share one Unicode console output stream', mixedText.includes('中文 shell') && mixedText.includes('中文 Python') && !mixedText.includes('\ufffd'))
  result = await run('subprocess', 'import subprocess, sys\nsubprocess.run([sys.executable, "-c", "print(\'中文 subprocess\')"])')
  check('Direct Python subprocess output preserves Chinese', result.some(e => e.t === 'stream' && e.text.includes('中文 subprocess')))
  result = await run('private-pipe', 'import subprocess, sys\nprint(subprocess.check_output([sys.executable, "-c", "print(\'中文 private pipe\')"], text=True))')
  check('Captured Python subprocess text remains UTF-8', result.some(e => e.t === 'stream' && e.text.includes('中文 private pipe')))
  result = await run('captured-shell', 'files = !dir /b\nprint("中文 数据.txt" in files)')
  check('IPython captured !command output uses the same Unicode path', result.some(e => e.t === 'stream' && e.text.includes('True')))
  result = await run('same-line', '!"' + py + '" -X utf8 -c "print(\'中文 \', end=\'\')" & echo 文件')
  const sameLine = result.filter(e => e.t === 'stream').map(e => e.text).join('')
  check('UTF-8 Python and native cmd text stay intact on the same line: ' + JSON.stringify(sameLine), sameLine.includes('中文 文件'))
  kernel.exec([{ cell: 'shell-interrupt', code: '!ping -n 60 127.0.0.1' }])
  await until(es => es.some(e => e.cell === 'shell-interrupt' && e.t === 'stream' && e.text.includes('127.0.0.1')))
  let interruptStart = Date.now(); kernel.interrupt()
  await until(es => es.some(e => e.cell === 'shell-interrupt' && e.t === 'done'), 8000)
  check('Windows shell process interrupts without wedging the kernel', Date.now() - interruptStart < 8000 && events.some(e => e.cell === 'shell-interrupt' && e.ename === 'KeyboardInterrupt'))
  // Print from inside the sleep: the test must not interrupt before user code starts.
  kernel.exec([{ cell: 'sleep', code: 'import time\nprint("sleep-entered", flush=True)\ntime.sleep(60)' }, { cell: 'cancelled', code: 'print("must not run")' }])
  await until(es => es.some(e => e.cell === 'sleep' && e.t === 'stream' && e.text.includes('sleep-entered')))
  await new Promise(r => setTimeout(r, 200))
  let start = Date.now(); kernel.interrupt()
  await until(es => es.some(e => e.cell === 'cancelled' && e.t === 'done'), 4000)
  check('Blocking sleep interrupts promptly and cancels queued cell', Date.now() - start < 4000 && events.some(e => e.cell === 'sleep' && e.ename === 'KeyboardInterrupt') && events.some(e => e.cell === 'cancelled' && e.aborted))
  result = await run('after', 'x')
  check('Kernel and variables survive interruption', result.some(e => e.t === 'result' && e.data['text/plain'] === '42'))
  kernel.exec([{ cell: 'loop', code: 'print("loop-entered", flush=True)\nwhile True: pass' }])
  await until(es => es.some(e => e.cell === 'loop' && e.t === 'stream'))
  start = Date.now(); kernel.interrupt()
  await until(es => es.some(e => e.cell === 'loop' && e.t === 'done'), 4000)
  check('Busy Python loop interrupts promptly', Date.now() - start < 4000 && events.some(e => e.cell === 'loop' && e.ename === 'KeyboardInterrupt'))
  result = await run('child', 'import subprocess, sys\np = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])\nprint(p.pid)')
  child = Number(result.filter(e => e.t === 'stream').map(e => e.text).join('').trim())
  check('Notebook launched an actual child process', child > 0 && alive(child))
  kernel.stop('shutdown')
  await new Promise(r => setTimeout(r, 3000))
  check('Closing kernel also removes its child process', !alive(child))
  check('Missing custom interpreter falls back to bundled Python', (await kernel.open({ ...bundled, label: 'Missing custom', kind: 'custom', path: join(dir, 'missing.exe') })).fellBack?.wanted === 'Missing custom' && kernel.status().state === 'idle')
  result = await run('minimal-path-child', 'import subprocess, sys\np = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])\nprint(p.pid)')
  child = Number(result.filter(e => e.t === 'stream').map(e => e.text).join('').trim())
  check('A child is alive before the minimal-PATH shutdown', child > 0 && alive(child))
  const originalPath = process.env.PATH
  try { process.env.PATH = dirname(py); kernel.stop('shutdown') }
  finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath }
  await new Promise(r => setTimeout(r, 3000))
  check('Tree cleanup also works when System32 is absent from PATH', !alive(child))
  const venv = join(folder, '.venv')
  execFileSync(py, ['-m', 'venv', '--without-pip', venv], { windowsHide: true })
  const envBuild = await build({ entryPoints: [join(root, 'tangu-plugins/notebook-kernel/src/envs.ts')], bundle: true, format: 'esm', platform: 'node', write: false })
  const { listEnvs } = await import(`data:text/javascript;base64,${Buffer.from(envBuild.outputFiles[0].text).toString('base64')}`)
  const venvPy = join(venv, 'Scripts', 'python.exe')
  const envs = await listEnvs(folder)
  const discovered = envs.find(e => e.kind === 'venv' && e.path === venvPy)
  check('An actual Windows .venv is discovered at Scripts/python.exe', discovered?.ok && /^3\./.test(discovered.version))
  check('Kernel switches to the selected virtual environment', (await kernel.open(discovered)).python?.path === venvPy)
  result = await run('executable', 'import sys\nprint(sys.executable)')
  check('Selected interpreter executes the code', result.some(e => e.t === 'stream' && e.text.includes(venvPy)))
} finally {
  kernel.stop('shutdown')
  if (child && alive(child)) process.kill(child)
}
