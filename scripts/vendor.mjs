// 重建 tangu-plugins/notebook-kernel/python/vendor(随插件带的 IPython)。
// 用法:node scripts/vendor.mjs [python]   缺省用桌面端检出里的自带 Python(GENESIS_DESKTOP 可改)。
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const py = process.argv[2] || join(process.env.GENESIS_DESKTOP || join(root, '..', '..', 'Forsion-Genesis', 'desktop'), 'build', 'python', 'bin', 'python3')
const dir = join(root, 'tangu-plugins', 'notebook-kernel', 'python')
const vendor = join(dir, 'vendor')
if (!existsSync(py)) throw new Error(`找不到 Python:${py}`)
rmSync(vendor, { recursive: true, force: true })
const env = { ...process.env, PYTHONNOUSERSITE: '1', PIP_USER: '0', PIP_REQUIRE_VIRTUALENV: '0', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_CONFIG_FILE: '/dev/null' }
delete env.PYTHONPATH; delete env.PYTHONHOME
execFileSync(py, ['-m', 'pip', 'install', '-q', '--no-deps', '--no-compile', '--target', vendor, '-r', join(dir, 'requirements.txt')], { env, stdio: 'inherit' })
for (const junk of ['bin', 'share']) rmSync(join(vendor, junk), { recursive: true, force: true })
console.log('vendor:', readdirSync(vendor).filter((n) => !n.endsWith('.dist-info')).join(' '))
