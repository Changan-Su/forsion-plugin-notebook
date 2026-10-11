// 把构建好的插件拷进开发版的插件目录(~/.forsion-dev/plugins/notebook),重启开发版后生效。
// 只拷发布要带的那几样(和商店装的 zip 一样):manifest.json、main.js、tangu-plugins/(不带源码和类型)。
// 必须是拷贝:引擎不认符号链接的捆绑包;带 fileExtensions 的插件也不能走「开发加载」。
// 用法:npm run build && node scripts/install-dev.mjs [目标 Forsion 根目录,缺省 ~/.forsion-dev]
import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(process.argv[2] || join(homedir(), '.forsion-dev'), 'plugins', 'notebook')
for (const f of ['main.js', 'tangu-plugins/notebook-kernel/dist/index.js']) if (!existsSync(join(root, f))) throw new Error(`缺 ${f} —— 先 npm run build`)
rmSync(dest, { recursive: true, force: true }) // 只删自己这一个目录(上一次装的)
mkdirSync(dest, { recursive: true })
for (const f of ['manifest.json', 'main.js', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) copyFileSync(join(root, f), join(dest, f))
cpSync(join(root, 'tangu-plugins'), join(dest, 'tangu-plugins'), { recursive: true, filter: (s) => !/\/(src|types|node_modules|__pycache__)(\/|$)|tsconfig\.json$/.test(s) })
console.log(`已装到 ${dest}\n重启开发版后生效。卸掉:rm -rf "${dest}"`)
