// 不起应用的自检:① .ipynb 往返(写盘路径)② 输出收集 ③ main.js 与 src 同步 ④ 文案成对 ⑤ 清单与引擎插件对得上。
// 跑:npm run check
import { build } from 'esbuild'
import { readFileSync, existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { options, engineOptions } from './build.mjs'

const mod = async (entry) => {
  const out = await build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, platform: 'node', logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}
let bad = 0
const ok = (label, fn) => { try { fn(); console.log(`✓ ${label}`) } catch (e) { bad++; console.log(`✗ ${label}\n    ${String(e.message).split('\n').slice(0, 6).join('\n    ')}`) } }
const nbm = await mod('src/nb.ts')
const { parse, serialize, emptyNotebook, newCell, OutputSink, setSource, source, carriage, stripAnsi, headings, NotebookError, ids } = nbm

const jup = readFileSync('verify/fixtures/jupyter.ipynb', 'utf8')
ok('Jupyter 写的文件:读进来再写出去,一个字节都不变(不认识的键、键序、字符串形式的 source、ANSI、浮点)', () => {
  const { nb, changed } = parse(jup)
  assert.equal(changed, false)
  assert.equal(serialize(nb), jup)
})
ok('已知的边界:数字的写法不保留(1.0 → 1、1e-07 → 1e-7),值不变', () => {
  const text = '{"cells": [], "metadata": {"a": 1.0, "b": 1e-07}, "nbformat": 4, "nbformat_minor": 5}'
  assert.deepEqual(JSON.parse(serialize(parse(text).nb)), JSON.parse(text))
})
ok('只改一格的源码:其余部分逐行不变', () => {
  const { nb } = parse(jup)
  setSource(nb.cells[1], 'x = 1\ny = 2\n')
  const a = jup.split('\n'), b = serialize(nb).split('\n')
  const diff = b.filter((l) => !a.includes(l))
  assert.deepEqual(diff, ['    "x = 1\\n",', '    "y = 2\\n"'])
  assert.deepEqual(JSON.parse(serialize(nb)).cells[1].source, ['x = 1\n', 'y = 2\n'])
  assert.equal(JSON.parse(serialize(nb)).cells[2].source, 'df["baseline"]') // 没动过的那格还是字符串形式
})
ok('4.4 的老文件:补上不重复的 id,小版本抬到 5,别的不动', () => {
  const { nb, changed } = parse(readFileSync('verify/fixtures/v44.ipynb', 'utf8'))
  assert.equal(changed, true); assert.equal(nb.nbformat_minor, 5)
  assert.equal(ids(nb).size, 2)
  const again = parse(serialize(nb)); assert.equal(again.changed, false); assert.deepEqual(again.nb, nb)
})
ok('空文件 = 一本空笔记本(一个空的代码格,没有示例)', () => {
  const { nb } = parse('  \n')
  assert.equal(nb.cells.length, 1); assert.equal(nb.cells[0].cell_type, 'code'); assert.equal(source(nb.cells[0]), ''); assert.deepEqual(nb.cells[0].outputs, [])
  assert.deepEqual(Object.keys(emptyNotebook()), ['cells', 'metadata', 'nbformat', 'nbformat_minor'])
})
ok('读不懂的不许当成笔记本:坏 JSON / 不是对象 / nbformat 3 / 缺 cells', () => {
  for (const [text, why] of [['{oops', 'bad'], ['[1]', 'bad'], ['{"nbformat":3,"worksheets":[]}', 'old'], ['{"nbformat":4}', 'bad'], ['{"nbformat":4,"cells":[1]}', 'bad']]) {
    assert.throws(() => parse(text), (e) => e instanceof NotebookError && e.why === why, text)
  }
})
ok('重复的 id 会被换掉一个', () => {
  const { nb, changed } = parse(JSON.stringify({ cells: [{ cell_type: 'code', id: 'x', source: [] }, { cell_type: 'code', id: 'x', source: [] }], metadata: {}, nbformat: 4, nbformat_minor: 5 }))
  assert.equal(changed, true); assert.equal(ids(nb).size, 2); assert.equal(nb.cells[0].id, 'x')
})
ok('输出收集:流合并、\\r 进度条、结果、图、报错、clear_output、update_display,跑完拆成一行一个元素', () => {
  const cell = newCell('code', new Set(), 'print(1)')
  cell.outputs = [{ output_type: 'stream', name: 'stdout', text: ['旧的\n'] }]; cell.execution_count = 9
  const sink = new OutputSink(cell)
  sink.begin(); assert.deepEqual(cell.outputs, []); assert.equal(cell.execution_count, null)
  sink.apply({ t: 'stream', name: 'stdout', text: 'a\n' }); sink.apply({ t: 'stream', name: 'stdout', text: 'b\n10%\r' }); sink.apply({ t: 'stream', name: 'stdout', text: '50%\r100%\n' })
  sink.apply({ t: 'stream', name: 'stderr', text: 'warn\n' })
  sink.apply({ t: 'display', data: { 'text/plain': 'v1' }, metadata: {}, display_id: 'd1' })
  sink.apply({ t: 'display', data: { 'text/plain': 'v2' }, metadata: {}, display_id: 'd1', update: true })
  sink.apply({ t: 'result', n: 4, data: { 'text/plain': '<x>', 'text/html': '<b>x</b>\n<i>y</i>', 'image/png': 'AAAA' }, metadata: {} })
  sink.apply({ t: 'error', ename: 'ValueError', evalue: 'no', traceback: ['l1', 'l2'] })
  sink.finish(4)
  assert.deepEqual(cell.outputs, [
    { name: 'stdout', output_type: 'stream', text: ['a\n', 'b\n', '100%\n'] },
    { name: 'stderr', output_type: 'stream', text: ['warn\n'] },
    { data: { 'text/plain': ['v2'] }, metadata: {}, output_type: 'display_data' },
    { data: { 'text/plain': ['<x>'], 'text/html': ['<b>x</b>\n', '<i>y</i>'], 'image/png': 'AAAA' }, execution_count: 4, metadata: {}, output_type: 'execute_result' },
    { ename: 'ValueError', evalue: 'no', output_type: 'error', traceback: ['l1', 'l2'] },
  ])
  assert.equal(cell.execution_count, 4)
  sink.begin(); sink.apply({ t: 'stream', name: 'stdout', text: 'x' }); sink.apply({ t: 'clear', wait: true }); assert.equal(cell.outputs.length, 1)
  sink.apply({ t: 'stream', name: 'stdout', text: 'y' }); assert.deepEqual(cell.outputs.map((o) => o.text), ['y'])
  sink.apply({ t: 'clear', wait: false }); assert.deepEqual(cell.outputs, [])
  assert.equal(carriage('a\r\nb'), 'a\nb'); assert.equal(carriage('1\r2\r'), '2\r'); assert.equal(stripAnsi('\x1b[0;31mKeyError\x1b[0m: x'), 'KeyError: x')
})
ok('大纲:只认文字格里的标题,代码围栏里的 # 不算', () => {
  const { nb } = parse(jup)
  setSource(nb.cells[0], '# 一\n```\n# 不是标题\n```\n## 二 ##\n')
  assert.deepEqual(headings(nb).map((h) => [h.level, h.text]), [[1, '一'], [2, '二']])
})

if (existsSync('src/index.ts')) {
  const built = await build({ ...options, write: false, logLevel: 'silent' })
  ok('main.js 和 src 是同步的(改了 src 要重跑 npm run build)', () => assert.equal(readFileSync('main.js', 'utf8'), built.outputFiles[0].text))
  const engBuilt = await build({ ...engineOptions, write: false, logLevel: 'silent' })
  ok('引擎插件的 dist/index.js 和源码是同步的', () => assert.equal(readFileSync(engineOptions.outfile, 'utf8'), engBuilt.outputFiles[0].text))
  ok('main.js 顶层没有 import / export(宿主按函数体装载)', () => assert.ok(!/^\s*(import|export)\s/m.test(readFileSync('main.js', 'utf8'))))
  const { M } = await mod('src/i18n.ts')
  ok('文案:每条都有中英两份,英文里没有汉字,{占位符} 两边一致', () => {
    for (const [k, v] of Object.entries(M)) {
      assert.ok(Array.isArray(v) && v.length === 2 && v[0] && v[1], `${k} 缺一种语言`)
      assert.ok(!/[一-鿿]/.test(v[1]), `${k} 的英文里有汉字`)
      assert.deepEqual((v[0].match(/\{\w+\}/g) ?? []).sort(), (v[1].match(/\{\w+\}/g) ?? []).sort(), `${k} 的占位符不一致`)
    }
    const used = new Set([...readFileSync('src/view.ts', 'utf8').matchAll(/\bt\('([\w.]+)'/g), ...readFileSync('src/panels.ts', 'utf8').matchAll(/\bt\('([\w.]+)'/g), ...readFileSync('src/index.ts', 'utf8').matchAll(/\bt\('([\w.]+)'/g), ...readFileSync('src/outputs.ts', 'utf8').matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]))
    for (const k of used) assert.ok(M[k], `源码用到的 ${k} 不在字典里`)
  })
  const man = JSON.parse(readFileSync('manifest.json', 'utf8')); const eng = JSON.parse(readFileSync('tangu-plugins/notebook-kernel/tangu-plugin.json', 'utf8'))
  ok('清单:后缀声明、双语名字和说明、版本与引擎插件一致、引擎产物和运行器都在', () => {
    assert.deepEqual(man.fileExtensions, ['.ipynb']); assert.ok(man.nameEn && man.descriptionEn && !/[一-鿿]/.test(man.nameEn + man.descriptionEn))
    assert.equal(man.version, eng.version); assert.equal(man.version, JSON.parse(readFileSync('package.json', 'utf8')).version)
    for (const f of ['dist/index.js', 'python/runner.py', 'python/vendor/IPython/__init__.py']) assert.ok(existsSync(`tangu-plugins/notebook-kernel/${f}`), f)
  })
}
console.log(bad ? `\n${bad} 项没过` : '\n全部通过')
process.exit(bad ? 1 : 0)
