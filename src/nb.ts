// .ipynb(nbformat 4)的读、改、写。不碰 DOM、不碰 ctx —— check.mjs 直接拿它做往返测试。
//
// 写盘的纪律:内存里就是文件里那棵 JSON 树本身,只改我们动过的地方,不认识的键原样留着、键的顺序也不动;
// 序列化成 Jupyter 自己写的样子(缩进 1 格、末尾换行、多行文本拆成一行一个元素),这样同一个文件在 Jupyter
// 里再打开、或者放在 git 里,只看得到真正改过的那几行。

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
export type Mime = Record<string, Json>

export interface Output {
  output_type: 'stream' | 'display_data' | 'execute_result' | 'error' | string
  name?: string
  text?: string | string[]
  data?: Mime
  metadata?: Record<string, Json>
  execution_count?: number | null
  ename?: string
  evalue?: string
  traceback?: string[]
  [k: string]: unknown
}

export interface Cell {
  cell_type: 'code' | 'markdown' | 'raw' | string
  id?: string
  source: string | string[]
  metadata: Record<string, Json>
  outputs?: Output[]
  execution_count?: number | null
  [k: string]: unknown
}

export interface Notebook {
  cells: Cell[]
  metadata: Record<string, Json>
  nbformat: number
  nbformat_minor: number
  [k: string]: unknown
}

/** 打不开的原因。`old` = nbformat 3 及更早(单元格在 worksheets 里);`bad` = 不是一份笔记本。 */
export class NotebookError extends Error {
  constructor(readonly why: 'old' | 'bad', detail = '') { super(detail || why) }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 多行文本:文件里可以是一整个字符串,也可以是一行一个元素的数组。读的时候两种都认。 */
export const joined = (v: unknown): string => Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : ''
/** 拆成 Jupyter 写的样子:每个元素带着自己的换行,最后一行没有。空串 → 空数组。 */
export const lines = (s: string): string[] => s === '' ? [] : s.split(/(?<=\n)/)

const newId = (taken: Set<string>): string => {
  for (;;) {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')
    if (!taken.has(id)) { taken.add(id); return id }
  }
}

/** 一本空的笔记本:只有一个空的代码格。键的顺序和 Jupyter 写出来的一样(按字母)。 */
export function emptyNotebook(): Notebook {
  return {
    cells: [newCell('code', new Set())],
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  }
}

export function newCell(type: 'code' | 'markdown', taken: Set<string>, source = ''): Cell {
  return type === 'code'
    ? { cell_type: 'code', execution_count: null, id: newId(taken), metadata: {}, outputs: [], source: lines(source) }
    : { cell_type: 'markdown', id: newId(taken), metadata: {}, source: lines(source) }
}

// 数字逐字保留:JSON.parse 会把 `1.0` 读成 1、把超过 2^53 的整数读歪。写法和 JS 自己写出来不一样的数字,留着原文
// (JSON.rawJSON,序列化时原样吐回去)。我们自己要当数字读的那几个键除外。
// 没有这两个接口的老运行时(Node 20 及更早)退回普通解析:那里数字的写法不保留,超大整数会失真。
const NUMERIC_KEYS = new Set(['nbformat', 'nbformat_minor', 'execution_count', 'width', 'height'])
const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON
function parseJson(text: string): unknown {
  if (!rawJSON) return JSON.parse(text)
  return (JSON.parse as (t: string, r: (this: unknown, k: string, v: unknown, c?: { source?: string }) => unknown) => unknown)(text, (k, v, c) =>
    typeof v === 'number' && c?.source !== undefined && c.source !== JSON.stringify(v) && !NUMERIC_KEYS.has(k) ? rawJSON(c.source) : v)
}

/** 换单元格的类型:原来的对象照抄一份(别的工具写的键都留着),只动这一类特有的那两个键。 */
export function retype(old: Cell, type: 'code' | 'markdown'): Cell {
  const next: Cell = { ...old, cell_type: type }
  if (type === 'code') { next.outputs = []; next.execution_count = null } else { delete next.outputs; delete next.execution_count }
  return next
}

/** 解析。空文件当成一本空笔记本(`touch a.ipynb` 出来的那种);别的读不懂的一律抛 NotebookError,调用方不许写回去。
 *  `changed` = 解析时就动过内容(补了 id);它只说明「下次写盘会带上这些」,不触发写盘。 */
export function parse(text: string): { nb: Notebook; changed: boolean } {
  if (!text.trim()) return { nb: emptyNotebook(), changed: false }
  let raw: unknown
  try { raw = parseJson(text) } catch (e) { throw new NotebookError('bad', String((e as Error).message)) }
  if (!isObj(raw)) throw new NotebookError('bad', 'not an object')
  if (typeof raw.nbformat === 'number' && raw.nbformat < 4) throw new NotebookError('old', `nbformat ${raw.nbformat}`)
  if (raw.nbformat !== 4 || !Array.isArray(raw.cells) || !raw.cells.every(isObj)) throw new NotebookError('bad', 'not an nbformat 4 notebook')
  const nb = raw as unknown as Notebook
  if (!isObj(nb.metadata)) nb.metadata = {}
  if (typeof nb.nbformat_minor !== 'number') nb.nbformat_minor = 0
  // 每格都要有一个不重复的 id(运行时认格子、笔记里按格嵌入都靠它)。4.5 之前的文件没有:补上,并把小版本抬到 5
  // —— Jupyter 自己保存这类文件时也是这么做的。
  const taken = new Set<string>()
  let changed = false
  for (const c of nb.cells) {
    if (!isObj(c.metadata)) c.metadata = {}
    if (c.source == null) c.source = []
    if (c.cell_type === 'code' && !Array.isArray(c.outputs)) c.outputs = []
    if (typeof c.id === 'string' && c.id && !taken.has(c.id)) { taken.add(c.id); continue }
    // 插在 cell_type 后面的位置不重要;放进对象就行,序列化时键序跟着插入顺序走
    c.id = newId(taken); changed = true
  }
  if (changed && nb.nbformat_minor < 5) nb.nbformat_minor = 5
  return { nb, changed }
}

const TEXT_MIME = /^text\/|^image\/svg\+xml$|^application\/javascript$/

/** 序列化成 Jupyter 写的样子。不做任何整理:哪里要拆成「一行一个元素」,在改的那一刻就拆好了
 *  (`setSource`、`OutputSink.finish`)—— 没动过的格子,文件里原来是什么样写回去还是什么样。 */
export const serialize = (nb: Notebook): string => JSON.stringify(nb, null, 1) + '\n'

export const source = (c: Cell): string => joined(c.source)
export const setSource = (c: Cell, text: string): void => { c.source = lines(text) }
export const ids = (nb: Notebook): Set<string> => new Set(nb.cells.map((c) => c.id!).filter(Boolean))

// ── 运行时的输出 → nbformat 的 outputs ──────────────────────────────────────────────────────────────

/** 运行器发来的一条事件(引擎插件原样转过来)。 */
export interface RunEvent {
  t: string
  cell?: string
  name?: string
  text?: string
  data?: Mime
  metadata?: Record<string, Json>
  display_id?: string | null
  update?: boolean
  n?: number | null
  ename?: string
  evalue?: string
  traceback?: string[]
  wait?: boolean
  ok?: boolean
  ms?: number
  [k: string]: unknown
}

/** 一格的输出收集器:把事件一条条并进 `cell.outputs`。display_id → 那条输出,给 update_display 用(只活在这一次打开里)。 */
export class OutputSink {
  private byDisplay = new Map<string, Output>()
  private clearNext = false
  constructor(private cell: Cell) {}

  /** 开始跑:清掉上次的输出和序号。 */
  begin(): void { this.cell.outputs = []; this.cell.execution_count = null; this.byDisplay.clear(); this.clearNext = false }

  /** 跑完:把这一格攒下的整段文本拆成 Jupyter 写的样子(流输出、文本类的 mime 值)。 */
  finish(n: number | null | undefined): void {
    this.cell.execution_count = n ?? null
    for (const o of this.cell.outputs ?? []) {
      if (typeof o.text === 'string') o.text = lines(o.text)
      if (isObj(o.data)) for (const [k, v] of Object.entries(o.data)) if (typeof v === 'string' && TEXT_MIME.test(k)) o.data[k] = lines(v)
    }
  }

  /** 返回 true = 输出变了,需要重画。 */
  apply(ev: RunEvent): boolean {
    const outs = (this.cell.outputs ??= [])
    if (ev.t === 'clear') { if (ev.wait) this.clearNext = true; else outs.length = 0; return !ev.wait }
    if (!['stream', 'display', 'result', 'error'].includes(ev.t)) return false
    if (ev.t === 'display' && ev.update) {
      const o = ev.display_id ? this.byDisplay.get(ev.display_id) : undefined
      if (!o) return false
      o.data = ev.data ?? {}; o.metadata = ev.metadata ?? {}
      return true
    }
    if (this.clearNext) { outs.length = 0; this.clearNext = false }
    if (ev.t === 'stream') {
      const last = outs.at(-1)
      const text = ev.text ?? ''
      if (last?.output_type === 'stream' && last.name === ev.name) last.text = carriage(joined(last.text) + text)
      else outs.push({ name: ev.name ?? 'stdout', output_type: 'stream', text: carriage(text) })
    } else if (ev.t === 'display') {
      const o: Output = { data: ev.data ?? {}, metadata: ev.metadata ?? {}, output_type: 'display_data' }
      if (ev.display_id) this.byDisplay.set(ev.display_id, o)
      outs.push(o)
    } else if (ev.t === 'result') {
      outs.push({ data: ev.data ?? {}, execution_count: ev.n ?? null, metadata: ev.metadata ?? {}, output_type: 'execute_result' })
    } else {
      outs.push({ ename: ev.ename ?? 'Error', evalue: ev.evalue ?? '', output_type: 'error', traceback: ev.traceback ?? [] })
    }
    return true
  }
}

/** 进度条那类输出靠 `\r` 回到行首重写:只留每一行最后写下的那一版(末尾还悬着的 `\r` 先留着,等下一段来)。 */
export function carriage(s: string): string {
  if (!s.includes('\r')) return s
  return s.replace(/\r\n/g, '\n').replace(/[^\n]*\r(?=[^\n])/g, '')
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g
export const stripAnsi = (s: string): string => s.replace(ANSI, '')

/** `![[…]]` 里的目标 → 文件路径和格子锚点。不是 .ipynb 的返回 null。`a.ipynb#cell|别名` 里别名可以随便写。 */
export function embedTarget(target: string): { path: string; anchor: string } | null {
  const m = /^([^#|]+\.ipynb)(?:#([^|]*))?(?:\|.*)?$/i.exec(target)
  return m ? { path: m[1], anchor: m[2] ?? '' } : null
}

/** 文字格里的标题,给大纲用。跳过代码围栏里的 `#`。 */
export function headings(nb: Notebook): { cell: string; level: number; text: string }[] {
  const out: { cell: string; level: number; text: string }[] = []
  for (const c of nb.cells) {
    if (c.cell_type !== 'markdown') continue
    let fence = false
    for (const line of source(c).split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue }
      const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
      if (m) out.push({ cell: c.id!, level: m[1].length, text: m[2] })
    }
  }
  return out
}
