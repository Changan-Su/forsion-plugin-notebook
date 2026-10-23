// Actual installed Windows conda base + child environments, with an isolated profile.
// node verify/windows-conda.mjs <fixture-profile> <base-prefix> <child-prefix>
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'win32')
const [profile, base, child] = process.argv.slice(2).map(p => resolve(p))
assert.ok(profile && base && child, 'Pass an isolated profile and two real conda prefixes')
assert.notEqual(realpathSync(profile).toLowerCase(), realpathSync(homedir()).toLowerCase(), 'Use a fixture profile')
assert.notEqual(realpathSync(base).toLowerCase(), realpathSync(child).toLowerCase(), 'Base and child must be distinct environments')
process.env.USERPROFILE = profile // Only this test process and its children; no shell/system changes.
process.env.APPDATA = join(profile, 'AppData', 'Roaming')
process.env.LOCALAPPDATA = join(profile, 'AppData', 'Local')
process.env.PYTHONUSERBASE = join(profile, 'python-user')
process.env.IPYTHONDIR = join(profile, 'ipython')
delete process.env.IPYTHON_DIR
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
async function moduleAt(file) {
  const output = await build({ entryPoints: [join(root, file)], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
}
const { listEnvs } = await moduleAt('tangu-plugins/notebook-kernel/src/envs.ts')
const { Kernel } = await moduleAt('tangu-plugins/notebook-kernel/src/kernels.ts')
const folder = mkdtempSync(join(tmpdir(), 'forsion-conda-kernel-'))
const nb = join(folder, 'acceptance.ipynb'); writeFileSync(nb, '{}')
const kernel = new Kernel(nb, join(root, 'tangu-plugins/notebook-kernel/python'), null, console.log)
let passed = 0
function check(label, ok) { assert.ok(ok, label); passed++; console.log('PASS ' + label) }
try {
  const envs = await listEnvs(folder)
  for (const [label, prefix] of [['base', base], ['child', child]]) {
    const py = join(prefix, 'python.exe')
    const info = envs.find(e => e.path.toLowerCase() === py.toLowerCase() && e.kind === 'conda')
    check(`Actual conda ${label} is discovered and usable`, info?.ok && /^3\./.test(info.version))
    const status = await kernel.open(info)
    check(`Kernel selects conda ${label} without a bundled fallback`, status.state === 'idle' && status.python?.path === info.path && !status.fellBack)
    const cell = 'conda-' + label, events = []
    let since = kernel.status().head
    kernel.exec([{ cell, code: 'import sys\nprint(sys.executable)' }])
    const end = Date.now() + 10000
    while (Date.now() < end && !events.some(e => e.t === 'done' && e.cell === cell)) {
      const page = await kernel.poll(since, 100)
      if (page.events.length) since = page.events.at(-1).seq
      events.push(...page.events)
    }
    check(`Selected conda ${label} actually runs the cell`, events.some(e => e.t === 'done' && e.cell === cell) && !events.some(e => e.t === 'error') && events.some(e => e.t === 'stream' && e.text.toLowerCase().includes(py.toLowerCase())))
  }
} finally { kernel.stop('acceptance complete') }
console.log(`${passed}/6 passed`)
