// 打包 src/index.ts(含 CodeMirror)→ 单文件 IIFE main.js。
//  - format:'iife' → 顶层无 import/export,过宿主的「main.js 必须是裸 setup 体」闸;`ctx` 是宿主注入的自由变量。
//  - .css 当文本进包,运行时注入 <style>。
//  - globalName + footer:入口的默认导出是清理函数,footer 在函数体最外层把它 return 给宿主(停用 / 重载时先调,那时 ctx 还能用)。
//  - main.js 必须提交并与 src 同步(市场装 zip 不构建)—— 改 src 后重跑本脚本。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const dev = process.argv.includes('--dev')

export const options = {
  entryPoints: ['src/index.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'iife',
  globalName: '__nbPlugin',
  footer: { js: 'return __nbPlugin.default;' },
  platform: 'browser',
  target: 'es2022',
  minify: !dev,
  sourcemap: false,
  legalComments: 'none',
  loader: { '.css': 'text' },
  metafile: true,
  logLevel: 'info',
}

// 引擎那一半:打成一个 ESM 文件(Node 里跑)。它用的 .ipynb 读写代码就是 src/nb.ts 这一份。
export const engineOptions = {
  entryPoints: ['tangu-plugins/notebook-kernel/src/index.ts'],
  outfile: 'tangu-plugins/notebook-kernel/dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
}

// 直接运行才落盘;check.mjs 只借这份配置在内存里重打一遍,核对 main.js 和 src 是不是同步。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = await build(options)
  console.log(`built main.js (${(out.metafile.outputs['main.js'].bytes / 1024).toFixed(0)} KB)`)
  await build(engineOptions)
}
