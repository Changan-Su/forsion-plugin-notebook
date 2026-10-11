// 一本笔记本的页面:顶栏(编辑 / 阅读、全部运行、内核)+ 一列单元格。摆法是「像一篇笔记」:
// 文字格用宿主的 Markdown 编辑器,代码格是 CodeMirror,输出跟在代码下面;变量 / 大纲 / 对话在右栏(panels.ts)。
//
// 运行那一半在同包的引擎插件里(tangu-plugins/notebook-kernel):这里只发「跑这几格」、再把事件一条条收回来。
// 没有本机引擎的地方(网页版、手机、云端库)照样能看能改,只是没有运行那几颗按钮。
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { tags } from '@lezer/highlight'
import { NotebookError, OutputSink, headings, ids, newCell, parse, retype, serialize, setSource, source, type Cell, type Notebook, type RunEvent } from './nb'
import { renderOutputs } from './outputs'
import { esc, icon } from './icons'
import { t } from './i18n'

// 颜色照笔记里代码块的那一套:关键字和函数名一个色,字符串、数字各一个,注释斜体变淡;不加粗。
const HL = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.bool, tags.null, tags.self], color: 'var(--accent-ink)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName), tags.className], color: 'var(--accent-ink)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--green)' },
  { tag: tags.number, color: 'var(--danger)' },
  { tag: tags.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
])

export interface Variable { name: string; type: string; shape?: string; value?: string; cols?: [string, string][] }
interface EnvInfo { path: string; label: string; kind: string; hint?: string; version?: string; ok: boolean; why?: 'old' | 'broken' }
interface KernelStatus {
  state: 'starting' | 'idle' | 'busy' | 'dead'
  python: { path: string; label: string; kind: string; version?: string } | null
  fellBack?: { wanted: string; reason: string }
  error?: string
  head: number
}
interface Poll extends KernelStatus { events: (RunEvent & { seq: number })[]; gap: boolean; current: string | null; queue: string[] }

const ENGINE = 'notebook-kernel'
const post = <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> => ctx.tangu!.request!(ENGINE, path, { method: 'POST', body, signal }) as Promise<T>
const errText = (e: unknown): string => e instanceof Error ? e.message : String(e)

// ── 每本笔记本记住选的解释器(存在插件自己的数据里,不写进 .ipynb:本机路径不该跟着文件走) ──
const prefs: { python: Record<string, string> } = { python: {} }
void ctx.loadData?.<typeof prefs>().then((d) => { if (d?.python && typeof d.python === 'object') Object.assign(prefs.python, d.python) }).catch(() => {})

// ── 右栏跟着「最近操作过的那本」走 ──
const views = new Set<NotebookView>()
let active: NotebookView | null = null
const activeSubs = new Set<() => void>()
export const getActive = (): NotebookView | null => active
export const onActive = (cb: () => void): (() => void) => { activeSubs.add(cb); return () => { activeSubs.delete(cb) } }
const setActive = (v: NotebookView | null): void => { if (active !== v) { active = v; for (const cb of [...activeSubs]) cb() } }
export const allViews = (): NotebookView[] => [...views]
/** 右栏的对话挂上之后登记在这里;「问 Tangu」把报错递给它。面板还没挂上时先放在 pending,挂上就取走。 */
export const chat: { quote: ((text: string) => void) | null; pending: string | null } = { quote: null, pending: null }

let panelOpened = false
/** 这个页面旁边有没有放面板的右栏(移到新窗口的标签、开在对话旁边那一格里的都没有)。
 *  ponytail: 后一种认的是宿主那一格的类名 .agent-desk,同 Better PDF;宿主给出正式的容器信息后换掉。 */
export const hasRight = (at?: Element | null): boolean => !!ctx.viewLocations?.includes('right') && !at?.closest('.agent-desk')
export function openPanel(id: 'vars' | 'outline' | 'chat', at?: Element | null): void {
  if (!hasRight(at)) return
  const open = (v: string): void => ctx.openView(v, { location: 'right' })
  if (!panelOpened) { open('vars'); open('outline'); if (ctx.tangu?.mountChat) open('chat') }
  panelOpened = true
  open(id)
}

const fmtMs = (ms: number): string => ms < 60_000 ? t('cell.seconds', { n: (ms / 1000).toFixed(1) }) : t('cell.minutes', { m: Math.floor(ms / 60_000), s: Math.round(ms % 60_000 / 1000) })
const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const dirOf = (p: string): string => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
/** 记着的解释器路径 → 给人看的名字:环境文件夹的名字(…/analysis/bin/python → analysis);系统路径下的就用文件名。 */
const envName = (p: string): string => {
  const parts = p.replace(/\\/g, '/').split('/')
  const env = parts.at(-3) ?? ''
  return !env || ['usr', 'local', 'opt', 'homebrew'].includes(env) ? parts.at(-1)! : env
}

interface CellUI {
  cell: Cell
  el: HTMLElement
  bar: HTMLElement
  out?: HTMLElement
  gut?: HTMLElement
  editor?: EditorView
  md?: HostMarkdownEditor
  /** 文字格:人动过手之后才认宿主编辑器报上来的改动(它挂载时自己整理一遍 Markdown 不算改动)。 */
  touched?: boolean
  sink?: OutputSink
  state: 'idle' | 'queued' | 'run'
  t0: number
  ms: number | null
  bad: boolean
  /** 阅读模式下代码是不是展开着 */
  shown: boolean
  focus(): void
  dispose(): void
}

export class NotebookView {
  readonly root: HTMLElement
  private bar: HTMLElement
  private scroll: HTMLElement
  private col: HTMLElement
  nb: Notebook | null = null
  private fail: string | null = null
  private read = false
  private selected: string | null = null
  private cells = new Map<string, CellUI>()
  private subs = new Set<() => void>()
  vars: Variable[] = []
  kernel: KernelStatus | null = null
  private since = 0
  private hostTries = 0
  private readSeq = 0
  private pollGen = 0
  private runSeq = 0
  private asked = false
  private opening: Promise<boolean> | null = null
  private dead = false
  // 保存:整本一起写。saving / again 保证同一时刻只有一次写在路上;lastWritten 用来认出「文件变了」其实是自己刚写的。
  private dirty = false
  private saving = false
  private again = false
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private lastWritten: string | null = null
  private reloadPending = false
  private tick: ReturnType<typeof setInterval> | undefined
  private paintQueued = new Set<CellUI>()
  private closeMenu: (() => void) | null = null
  private offWatch: (() => void) | undefined
  private abort = new AbortController()

  constructor(private host: HTMLElement, readonly path: string) {
    host.classList.add('nb-host')
    host.innerHTML = '<div class="nb"><div class="nb-bar"></div><div class="nb-scroll"><div class="nb-col"></div></div></div>'
    this.root = host.firstElementChild as HTMLElement
    this.bar = this.root.querySelector('.nb-bar')!
    this.scroll = this.root.querySelector('.nb-scroll')!
    this.col = this.root.querySelector('.nb-col')!
    this.bar.addEventListener('click', (e) => this.onBar(e))
    this.col.addEventListener('click', (e) => this.onCol(e))
    this.root.addEventListener('pointerdown', () => setActive(this), true)
    this.root.addEventListener('focusin', () => setActive(this))
    views.add(this)
    setActive(this)
    void this.load()
    this.offWatch = ctx.app.watchFile?.(path, () => void this.onDisk())
  }

  get name(): string { return baseOf(this.path) }
  get folder(): string { return dirOf(this.path) }
  /** 这本笔记本在这台电脑上的绝对路径;拿不到(云端库、没有本机引擎)就不能运行。 */
  private get abs(): string | null { return ctx.tangu?.request ? ctx.app.hostPath?.(this.path) ?? null : null }
  get canRun(): boolean { return !this.read && !this.fail && !!this.abs }
  private get busy(): boolean { return [...this.cells.values()].some((u) => u.state !== 'idle') }
  subscribe(cb: () => void): () => void { this.subs.add(cb); return () => { this.subs.delete(cb) } }
  private changed(): void { for (const cb of [...this.subs]) cb() }

  // ── 读、写 ──────────────────────────────────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    const my = ++this.readSeq
    let text: string | null = null
    try { text = await ctx.app.readFile(this.path) } catch { /* 读不到,下面报 */ }
    // 这次读盘期间又有更新的读盘开始了、或者已经有内容并且人动过了:这份读数作废(它可能比手上的旧)。
    if (this.dead || my !== this.readSeq || (this.nb && (this.dirty || this.saving))) return
    if (text == null) { this.fail = t('load.missing'); this.paint(); return }
    this.adopt(text)
  }

  private adopt(text: string): void {
    try {
      this.nb = parse(text).nb
      this.fail = null
      this.lastWritten = text
    } catch (e) {
      // 读不懂的文件绝不写回去:nb 留空,所有改动入口都关着。
      this.nb = null
      this.fail = t(e instanceof NotebookError && e.why === 'old' ? 'load.old' : 'load.bad')
    }
    for (const u of this.cells.values()) u.dispose()
    this.cells.clear()
    this.asked = false
    this.paint()
    this.changed()
  }

  /** 文件在盘上变了(别的程序、同步、Tangu 改的)。自己刚写的不算;手上有没存的改动、或有格子正在跑时先不动。
   *  ponytail: 手上有没存的改动时以手上的为准(下一次保存盖过去);要做合并得按格比对,等真有人撞上再说。 */
  private async onDisk(): Promise<void> {
    const my = ++this.readSeq
    const text = await ctx.app.readFile(this.path).catch(() => null)
    if (this.dead || my !== this.readSeq || text == null || text === this.lastWritten || this.dirty || this.saving) return
    if (this.busy) { this.reloadPending = true; return }
    this.adopt(text)
  }

  private touch(): void {
    if (!this.nb) return
    this.dirty = true
    this.readSeq++ // 正在路上的读盘结果作废:它读到的是这次改动之前的文件
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.save(), 800)
  }

  async save(): Promise<void> {
    clearTimeout(this.saveTimer)
    if (!this.nb || !this.dirty) return
    if (this.saving) { this.again = true; return }
    this.saving = true
    try {
      do {
        this.again = false
        this.dirty = false
        const text = serialize(this.nb)
        this.lastWritten = text
        await ctx.app.writeFile(this.path, text)
      } while (this.again)
    } catch (e) {
      this.dirty = true
      ctx.notify?.(t('save.failed', { reason: errText(e) }), { level: 'error' })
    } finally { this.saving = false }
  }

  // ── 画 ─────────────────────────────────────────────────────────────────────────────────────────

  private paint(): void { this.paintBar(); this.layout() }

  private kernelLabel(): { cls: string; text: string } {
    const k = this.kernel
    const chosen = prefs.python[this.path]
    const who = k?.python ? (k.python.kind === 'bundled' ? t('kernel.bundled') : k.python.label) : chosen ? envName(chosen) : t('kernel.bundled')
    if (!k || k.state === 'dead') return { cls: 'off', text: `${who} · ${t(k ? 'kernel.dead' : 'kernel.off')}` }
    if (k.state === 'starting') return { cls: 'starting', text: `${who} · ${t('kernel.starting')}` }
    if (k.state === 'busy' || this.busy) return { cls: 'busy', text: `${who} · ${t('kernel.busy')}` }
    return { cls: 'idle', text: `${who} · Python ${k.python?.version ?? ''}` }
  }

  private paintBar(): void {
    this.root.classList.toggle('nb-read', this.read)
    const seg = `<div class="nb-seg"><i></i><button data-a="edit" class="${this.read ? '' : 'on'}">${esc(t('mode.edit'))}</button><button data-a="read" class="${this.read ? 'on' : ''}">${esc(t('mode.read'))}</button></div>`
    if (this.fail) { this.bar.innerHTML = ''; return }
    if (this.read) { this.bar.innerHTML = `${seg}<span class="nb-note">${esc(t('bar.readOnly'))}</span>`; return }
    const panel = hasRight(this.root) ? `<button class="nb-ibtn" data-a="panel" title="${esc(t('bar.panel'))}">${icon('panel')}</button>` : ''
    if (!this.abs) {
      // 应用刚启动时宿主还答不出这本笔记本在本机的路径:先不下结论,过一会儿再问(最多半分钟)。
      const maybe = !!ctx.tangu?.request && !!ctx.app.hostPath && this.hostTries < 30
      if (maybe) setTimeout(() => { this.hostTries++; if (!this.dead && !this.abs) this.paintBar(); else if (!this.dead) this.paint() }, 1000)
      this.bar.innerHTML = `${seg}${maybe ? '' : `<span class="nb-note" title="${esc(t('bar.noRun'))}">${esc(t('bar.noRun'))}</span>`}${panel}`
      return
    }
    if (!this.asked) { this.asked = true; void this.attach() }
    const k = this.kernelLabel()
    this.bar.innerHTML = `${seg}${this.busy
      ? `<button class="nb-btn stop" data-a="interrupt">${icon('stop')}${esc(t('bar.interrupt'))}</button>`
      : `<button class="nb-btn" data-a="runall">${icon('play')}${esc(t('bar.runAll'))}</button>`}<button class="nb-ibtn" data-a="restart" title="${esc(t('bar.restart'))}">${icon('restart')}</button><span class="nb-anchor"><button class="nb-kernel ${k.cls}" data-a="kernel"><i class="dot"></i><span>${esc(k.text)}</span>${icon('down')}</button></span>${panel}`
  }

  /** 按 nb.cells 的顺序把格子排进页面。已有的格子原样搬过去(编辑器、光标都留着),不在了的收掉。 */
  private layout(): void {
    if (this.fail || !this.nb) {
      this.col.innerHTML = this.fail ? `<div class="nb-fail">${esc(this.fail)}</div>` : ''
      return
    }
    const byId = new Map(this.nb.cells.map((c) => [c.id!, c]))
    for (const [id, u] of this.cells) if (byId.get(id) !== u.cell) { u.dispose(); this.cells.delete(id) }
    const nodes: Node[] = []
    const ins = (at: number, last = false): HTMLElement => {
      const d = document.createElement('div'); d.className = `nb-ins${last ? ' last' : ''}`; d.dataset.at = String(at)
      d.innerHTML = `<button data-a="add-code">${icon('plus')}${esc(t('cell.addCode'))}</button><button data-a="add-text">${icon('plus')}${esc(t('cell.addText'))}</button>`
      return d
    }
    this.nb.cells.forEach((c, i) => {
      let u = this.cells.get(c.id!)
      if (!u) { u = this.build(c); this.cells.set(c.id!, u) }
      if (!this.read) nodes.push(ins(i))
      nodes.push(u.el)
    })
    if (!this.read) nodes.push(ins(this.nb.cells.length, true))
    // 逐个比对着放:位置没变的节点不碰(重新插入会让编辑器丢焦点、宿主的 Markdown 编辑器重排)。
    this.col.querySelectorAll(':scope > .nb-ins').forEach((n) => n.remove())
    let at: ChildNode | null = this.col.firstChild
    for (const n of nodes) {
      if (n === at) at = at.nextSibling
      else this.col.insertBefore(n, at)
    }
    while (at) { const next: ChildNode | null = at.nextSibling; at.remove(); at = next }
    for (const u of this.cells.values()) this.paintCell(u)
  }

  private build(cell: Cell): CellUI {
    const id = cell.id!
    const el = document.createElement('div')
    el.dataset.cell = id
    el.dataset.type = cell.cell_type
    const bar = document.createElement('div'); bar.className = 'nb-cbar'
    const u: CellUI = { cell, el, bar, state: 'idle', t0: 0, ms: null, bad: false, shown: false, focus: () => {}, dispose: () => {} }
    el.addEventListener('focusin', () => this.select(id))
    el.addEventListener('pointerdown', () => this.select(id))

    if (cell.cell_type === 'code') {
      el.className = 'nb-cell nb-cc'
      u.gut = document.createElement('div'); u.gut.className = 'nb-gut'
      const code = document.createElement('div'); code.className = 'nb-code'
      u.out = document.createElement('div'); u.out.className = 'nb-out'
      u.bad = (cell.outputs ?? []).some((o) => o.output_type === 'error')
      const fold = document.createElement('button'); fold.className = 'nb-fold'; fold.dataset.a = 'fold'
      if (this.read) el.append(fold, code, u.out); else el.append(u.gut, bar, code, u.out)
      const run = (advance: boolean) => (): boolean => { if (this.read) return true; void this.runCells([id]); if (advance) this.focusNext(id); return true }
      u.editor = new EditorView({
        parent: code,
        state: EditorState.create({
          doc: source(cell),
          extensions: [
            // 运行的两个键放最前面,盖过默认的「回车换行」
            keymap.of([{ key: 'Shift-Enter', run: run(true) }, { key: 'Mod-Enter', run: run(false) }, { key: 'Escape', run: (v) => { v.contentDOM.blur(); return true } }]),
            history(), indentOnInput(), bracketMatching(), closeBrackets(), python(), indentUnit.of('    '), syntaxHighlighting(HL),
            keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
            EditorView.editable.of(!this.read), EditorState.readOnly.of(this.read),
            EditorView.updateListener.of((up) => { if (up.docChanged) { setSource(cell, up.state.doc.toString()); this.touch() } }),
          ],
        }),
      })
      u.focus = () => u.editor!.focus()
      u.dispose = () => { u.editor!.destroy(); el.remove() }
      renderOutputs(u.out, cell, this.outputActions(u))
    } else {
      el.className = `nb-cell nb-mdcell${cell.cell_type === 'markdown' ? ' nb-md' : ''}`
      const body = document.createElement('div')
      if (!this.read) el.append(bar)
      el.append(body)
      const mount = cell.cell_type === 'markdown' ? ctx.ui?.mountMarkdownEditor : undefined
      if (mount) {
        const mark = (): void => { u.touched = true }
        for (const ev of ['keydown', 'pointerdown', 'paste', 'drop', 'cut']) body.addEventListener(ev, mark, true)
        u.md = mount(body, {
          value: source(cell), readOnly: this.read, label: t('cell.textPlaceholder'),
          onChange: (md) => { if (!u.touched || this.read || md === source(cell)) return; setSource(cell, md); this.touch(); this.changed() },
        })
        u.focus = () => u.md!.focus()
        u.dispose = () => { u.md!.dispose(); el.remove() }
      } else {
        // 原始单元格,或者没有 Markdown 编辑器的旧宿主:一个朴素的文本框。
        const ta = document.createElement('textarea'); ta.className = 'nb-plain'; ta.value = source(cell); ta.readOnly = this.read
        ta.placeholder = t(cell.cell_type === 'markdown' ? 'cell.textPlaceholder' : 'cell.raw')
        ta.rows = Math.max(2, ta.value.split('\n').length)
        ta.addEventListener('input', () => { setSource(cell, ta.value); this.touch(); this.changed() })
        body.append(ta)
        u.focus = () => ta.focus()
        u.dispose = () => el.remove()
      }
    }
    return u
  }

  private outputActions(u: CellUI): { ask?: (error: string) => void } {
    if (this.read || !ctx.tangu?.mountChat || !hasRight(this.root)) return {}
    return {
      ask: (error) => {
        const text = t('out.askQuote', { file: this.name, n: this.nb!.cells.indexOf(u.cell) + 1, code: source(u.cell), error })
        if (chat.quote) chat.quote(text); else chat.pending = text
        openPanel('chat', this.root)
      },
    }
  }

  private paintCell(u: CellUI): void {
    const sel = this.selected === u.cell.id && !this.read
    u.el.classList.toggle('sel', sel)
    u.el.classList.toggle('live', u.state !== 'idle')
    if (u.cell.cell_type !== 'code') {
      if (!this.read) u.bar.innerHTML = `<span class="nb-anchor"><button data-a="more" title="${esc(t('cell.more'))}">${icon('more')}</button></span>`
      return
    }
    if (this.read) {
      const fold = u.el.querySelector<HTMLElement>('.nb-fold')!
      const n = source(u.cell).split('\n').length
      fold.innerHTML = `${icon(u.shown ? 'down' : 'right')}<span>${esc(t('cell.codeLines', { n }))}</span>`
      fold.hidden = !source(u.cell).trim()
      ;(u.el.querySelector('.nb-code') as HTMLElement).hidden = !u.shown
      return
    }
    const n = typeof u.cell.execution_count === 'number' ? u.cell.execution_count : null // 只认数字:这个值来自文件,不能原样拼进 HTML
    u.gut!.innerHTML = u.state === 'run' ? `<span class="spin">${icon('spin')}</span>` : u.state === 'queued' ? `<span class="wait">${icon('clock')}</span>` : u.bad && n != null ? `<span class="bad">[${n}]</span>` : n != null ? `[${n}]` : '[ ]'
    const time = u.state === 'run' ? fmtMs(Date.now() - u.t0) : u.ms != null ? fmtMs(u.ms) : ''
    const more = `<span class="nb-anchor"><button data-a="more" title="${esc(t('cell.more'))}">${icon('more')}</button></span>`
    u.bar.innerHTML = u.state === 'run' ? `<span class="t">${esc(time)}</span><button class="stop" data-a="interrupt" title="${esc(t('cell.stop'))}">${icon('stop')}</button>`
      : u.state === 'queued' ? `<span class="t">${esc(t('cell.queued'))}</span>`
        : `${time ? `<span class="t">${esc(time)}</span>` : ''}${this.canRun ? `<button data-a="run" title="${esc(t('cell.run'))} (⇧↵)">${icon('play')}</button>` : ''}${more}`
  }

  /** 输出来得很密(一秒几百行 print):攒到下一帧一起画。 */
  private paintOutputs(u: CellUI): void {
    if (this.paintQueued.size === 0) requestAnimationFrame(() => {
      for (const q of this.paintQueued) if (q.out && this.cells.get(q.cell.id!) === q) renderOutputs(q.out, q.cell, this.outputActions(q))
      this.paintQueued.clear()
    })
    this.paintQueued.add(u)
  }

  private select(id: string): void {
    if (this.selected === id) return
    // 只换类名:这时重画按钮条,会把手指正按着的那颗按钮换成新的,这一下点击就落空了。
    if (this.selected) this.cells.get(this.selected)?.el.classList.remove('sel')
    this.selected = id
    if (!this.read) this.cells.get(id)?.el.classList.add('sel')
  }

  /** 大纲点过来:滚到那一格。 */
  reveal(id: string): void {
    const el = this.cells.get(id)?.el
    if (el) this.scroll.scrollTop += el.getBoundingClientRect().top - this.scroll.getBoundingClientRect().top - 14
  }

  // ── 改结构 ─────────────────────────────────────────────────────────────────────────────────────

  private insert(at: number, type: 'code' | 'markdown'): void {
    if (!this.nb) return
    const c = newCell(type, ids(this.nb))
    this.nb.cells.splice(at, 0, c)
    this.afterStructure(c.id!)
  }

  private afterStructure(focus?: string): void {
    this.touch(); this.layout(); this.changed()
    if (focus) { this.select(focus); this.cells.get(focus)?.focus() }
  }

  private focusNext(id: string): void {
    const i = this.nb!.cells.findIndex((c) => c.id === id)
    const next = this.nb!.cells[i + 1]
    if (next) { this.select(next.id!); this.cells.get(next.id!)?.focus(); this.cells.get(next.id!)?.el.scrollIntoView({ block: 'nearest' }) }
    else this.insert(i + 1, 'code')
  }

  private move(id: string, by: -1 | 1): void {
    const cs = this.nb!.cells; const i = cs.findIndex((c) => c.id === id); const j = i + by
    if (i < 0 || j < 0 || j >= cs.length) return
    ;[cs[i], cs[j]] = [cs[j], cs[i]]
    this.afterStructure()
  }

  private convert(id: string): void {
    const cs = this.nb!.cells; const i = cs.findIndex((c) => c.id === id); const old = cs[i]
    if (!old || this.cells.get(id)?.state !== 'idle') return
    // 换成一个新对象(页面靠对象换了没有来决定重画):原来的键都抄过去,只动代码格特有的 outputs / execution_count。
    cs[i] = retype(old, old.cell_type === 'code' ? 'markdown' : 'code')
    this.afterStructure(id)
  }

  private remove(id: string): void {
    const cs = this.nb!.cells; const i = cs.findIndex((c) => c.id === id)
    if (i < 0 || this.cells.get(id)?.state !== 'idle') return
    cs.splice(i, 1)
    if (cs.length === 0) cs.push(newCell('code', new Set())) // 一本笔记本至少留一个格子可以下笔
    this.afterStructure()
  }

  private clearOutputs(only?: string): void {
    let any = false
    for (const u of this.cells.values()) {
      if (u.cell.cell_type !== 'code' || u.state !== 'idle' || (only && u.cell.id !== only)) continue
      if (!u.cell.outputs?.length && u.cell.execution_count == null) continue
      u.cell.outputs = []; u.cell.execution_count = null; u.ms = null; u.bad = false
      renderOutputs(u.out!, u.cell); this.paintCell(u); any = true
    }
    if (any) this.touch()
  }

  // ── 运行 ───────────────────────────────────────────────────────────────────────────────────────

  private applyStatus(s: KernelStatus): void {
    const was = this.kernel
    this.kernel = { state: s.state, python: s.python, fellBack: s.fellBack, error: s.error, head: s.head }
    if (s.fellBack && s.fellBack.wanted !== was?.fellBack?.wanted) ctx.notify?.(t('kernel.fellBack', { wanted: s.fellBack.wanted }), { level: 'warning' })
    this.paintBar()
  }

  /** 起内核(或重启)。启动要一两秒:这期间再有人要它,等的是同一次启动,不会起第二个。 */
  private ensureKernel(restart = false): Promise<boolean> {
    if (this.opening) return restart ? this.opening.then(() => this.ensureKernel(true)) : this.opening
    if (!restart && this.kernel && this.kernel.state !== 'dead') return Promise.resolve(true)
    return this.opening = this.openKernel(restart).finally(() => { this.opening = null })
  }

  /** 打开(或从盘上重新读入)时问一次引擎:这本有没有已经在跑的内核 —— Tangu 起的、或者上次没关掉的。有就接上;
   *  顺便报上这本记着的解释器,Tangu 自己起内核时照这个来。 */
  private async attach(): Promise<void> {
    const nb = this.abs
    if (!nb || this.opening || (this.kernel && this.kernel.state !== 'dead')) return
    try {
      const s = await post<KernelStatus>('/status', { nb, python: prefs.python[this.path] })
      if (this.dead || this.opening || (this.kernel && this.kernel.state !== 'dead') || s.state === 'dead') return
      this.since = s.head
      this.applyStatus(s)
      void this.poll()
    } catch { /* 引擎还没起来:不要紧,运行的时候再起 */ }
  }

  private async openKernel(restart: boolean): Promise<boolean> {
    const nb = this.abs
    if (!nb) return false
    this.kernel = { state: 'starting', python: null, head: 0 }
    this.paintBar()
    try {
      const s = await post<KernelStatus>('/open', { nb, python: prefs.python[this.path], restart })
      // 标签在启动途中关掉了:那时发的关闭请求比内核出现得早,这里补一刀,不留进程。
      if (this.dead) { void post('/shutdown', { nb }).catch(() => {}); return false }
      if (restart) { this.resetRuns(); this.vars = []; this.changed() }
      this.since = s.head
      this.applyStatus(s)
      if (s.state === 'dead') { ctx.notify?.(t('kernel.failed', { reason: s.error ?? '' }), { level: 'error' }); return false }
      void this.poll()
      return true
    } catch (e) {
      this.kernel = null; this.paintBar()
      ctx.notify?.(t('kernel.failed', { reason: errText(e) }), { level: 'error' })
      return false
    }
  }

  /** 没跑完的格子都回到「没在跑」(内核重启、关闭、断开时)。已经收到的输出留着。 */
  private resetRuns(): void {
    for (const u of this.cells.values()) if (u.state !== 'idle') { if (u.state === 'run') u.sink?.finish(null); u.state = 'idle'; this.paintCell(u) }
    this.stopTick()
  }

  async runCells(which: string[]): Promise<void> {
    if (!this.canRun || !this.nb) return
    const cells = which.map((id) => this.cells.get(id)).filter((u): u is CellUI => !!u && u.cell.cell_type === 'code' && u.state === 'idle' && !!source(u.cell).trim())
    if (!cells.length) return
    // 先标成排队:起内核要一两秒,这段时间里按钮不该还能再点一次。
    for (const u of cells) { u.state = 'queued'; this.paintCell(u) }
    this.paintBar()
    const seq = this.runSeq
    const ok = await this.ensureKernel()
    try {
      if (!ok || seq !== this.runSeq) throw new Error('kernel') // 起内核的这一两秒里按了中断:这次不跑了
      const r = await post<{ accepted?: string[] }>('/exec', { nb: this.abs, cells: cells.map((u) => ({ cell: u.cell.id, code: source(u.cell) })) })
      // 引擎一次最多收 2000 格:没收下的回到「没在跑」,不然它们永远显示排队。
      const got = new Set(r.accepted ?? [])
      for (const u of cells) if (u.state === 'queued' && !got.has(u.cell.id!)) { u.state = 'idle'; this.paintCell(u) }
    } catch (e) {
      for (const u of cells) if (u.state === 'queued') { u.state = 'idle'; this.paintCell(u) }
      this.paintBar()
      if (ok && seq === this.runSeq) ctx.notify?.(t('kernel.failed', { reason: errText(e) }), { level: 'error' })
    }
  }

  private async poll(): Promise<void> {
    // 每次调用都开新的一轮,旧的那一轮(连同它还在路上的回音)作废:重启之后,旧回音里的「已关闭」不能把新内核标成死的。
    const gen = ++this.pollGen
    try {
      while (!this.dead && gen === this.pollGen && this.kernel && this.kernel.state !== 'dead') {
        const r = await post<Poll>('/events', { nb: this.abs, since: this.since, wait: 10_000 }, this.abort.signal)
        if (this.dead || gen !== this.pollGen) return
        for (const ev of r.events) { this.since = ev.seq; this.onEvent(ev) }
        if (r.gap) {
          // 落后太多,中间的事件已经被挤掉了:页面上还标着在跑 / 排队、引擎那边却已经没有的格子,收回来(它们的输出不全,不落盘)。
          this.since = Math.max(this.since, r.head)
          for (const u of this.cells.values()) if (u.state !== 'idle' && r.current !== u.cell.id && !r.queue.includes(u.cell.id!)) { u.state = 'idle'; this.paintCell(u) }
          if (!this.busy) { this.stopTick(); this.paintBar() }
        }
        if (r.state !== this.kernel?.state || r.python?.path !== this.kernel?.python?.path || r.fellBack?.wanted !== this.kernel?.fellBack?.wanted) this.applyStatus(r)
        if (r.state === 'dead') this.resetRuns()
      }
    } catch {
      if (!this.dead && gen === this.pollGen) {
        // 引擎重启了、或者这本的内核被回收了:当成断开。输出留着,下次运行重新起。
        this.kernel = null; this.resetRuns(); this.paintBar()
        ctx.notify?.(t('kernel.lost'), { level: 'warning' })
      }
    }
  }

  private onEvent(ev: RunEvent): void {
    const u = ev.cell ? this.cells.get(ev.cell) : undefined
    if (!u || u.cell.cell_type !== 'code') return // 跑到一半被删掉的格子:事件直接丢
    if (ev.t === 'queued') { u.state = 'queued'; this.paintCell(u) }
    else if (ev.t === 'start') {
      u.sink = new OutputSink(u.cell); u.sink.begin()
      u.state = 'run'; u.t0 = Date.now(); u.ms = null; u.bad = false
      this.paintCell(u); this.paintOutputs(u); this.startTick(); this.paintBar()
    } else if (ev.t === 'done') {
      if (u.state === 'run') {
        u.sink?.finish(ev.n)
        u.ms = typeof ev.ms === 'number' ? ev.ms : Date.now() - u.t0
        u.bad = ev.ok === false
        if (Array.isArray(ev.vars)) { this.vars = ev.vars as Variable[]; this.changed() }
        this.dirty = true
        void this.save() // 结果一出来就落盘,不等防抖
      }
      u.state = 'idle'
      this.paintCell(u); this.paintOutputs(u)
      if (!this.busy) { this.stopTick(); this.paintBar(); if (this.reloadPending) { this.reloadPending = false; void this.onDisk() } }
    } else if (u.sink?.apply(ev)) {
      this.paintOutputs(u)
      // 这一格已经报过「跑完」之后才到的输出(后台线程打印的):并进去,按跑完的样子整理好再存一次。
      if (u.state !== 'run') { u.sink.finish(typeof u.cell.execution_count === 'number' ? u.cell.execution_count : null); this.touch() }
    }
  }

  private startTick(): void {
    this.tick ??= setInterval(() => { for (const u of this.cells.values()) if (u.state === 'run') { const el = u.bar.querySelector('.t'); if (el) el.textContent = fmtMs(Date.now() - u.t0) } }, 100)
  }
  private stopTick(): void { clearInterval(this.tick); this.tick = undefined }

  private interrupt(): void { this.runSeq++; if (this.abs) void post('/interrupt', { nb: this.abs }).catch(() => {}) }
  private async restart(thenRunAll = false): Promise<void> {
    if (!(await this.ensureKernel(true))) return
    ctx.notify?.(t('kernel.restarted'), { level: 'info' })
    if (thenRunAll) void this.runAll()
  }
  private runAll(upTo?: string): Promise<void> {
    const all = this.nb!.cells.filter((c) => c.cell_type === 'code').map((c) => c.id!)
    return this.runCells(upTo ? all.slice(0, all.indexOf(upTo) + 1) : all)
  }
  private async shutdown(): Promise<void> {
    if (!this.abs || !this.kernel) return
    await post('/shutdown', { nb: this.abs }).catch(() => {})
    this.kernel = { state: 'dead', python: this.kernel.python, head: 0 }
    this.resetRuns(); this.vars = []; this.changed(); this.paintBar()
  }

  // ── 点击、菜单 ─────────────────────────────────────────────────────────────────────────────────

  private onBar(e: Event): void {
    const b = (e.target as Element).closest<HTMLElement>('[data-a]')
    if (!b || b.closest('.nb-menu')) return
    const a = b.dataset.a
    if (a === 'edit' || a === 'read') this.setRead(a === 'read')
    else if (a === 'runall') void this.runAll()
    else if (a === 'interrupt') this.interrupt()
    else if (a === 'restart') void this.restart()
    else if (a === 'panel') openPanel('vars', this.root)
    else if (a === 'kernel') this.kernelMenu(b)
  }

  private onCol(e: Event): void {
    const b = (e.target as Element).closest<HTMLElement>('[data-a]')
    if (!b || b.closest('.nb-menu')) return
    const a = b.dataset.a!
    const insAt = b.closest<HTMLElement>('.nb-ins')?.dataset.at
    if (insAt != null) { this.insert(Number(insAt), a === 'add-code' ? 'code' : 'markdown'); return }
    const id = b.closest<HTMLElement>('[data-cell]')?.dataset.cell
    const u = id ? this.cells.get(id) : undefined
    if (!id || !u) return
    if (a === 'run') void this.runCells([id])
    else if (a === 'interrupt') this.interrupt()
    else if (a === 'fold') { u.shown = !u.shown; this.paintCell(u) }
    else if (a === 'more') this.cellMenu(b, u)
  }

  private setRead(read: boolean): void {
    if (this.read === read) return
    this.read = read
    this.closeMenu?.()
    const old = new Map(this.cells)
    for (const u of old.values()) u.dispose()
    this.cells.clear()
    this.paint()
    // 正在跑的格子接着跑:把进度交给新画出来的那一份。
    for (const [id, o] of old) { const u = this.cells.get(id); if (u) { Object.assign(u, { state: o.state, t0: o.t0, ms: o.ms, bad: o.bad, sink: o.sink }); this.paintCell(u) } }
  }

  /** 菜单挂在按钮旁边(.nb-anchor 里),位置全靠 CSS 跟着按钮走 —— 不量视口坐标,界面缩放成多少都不会偏。 */
  private menu(btn: HTMLElement, fill: (m: HTMLElement, close: () => void) => void): void {
    const wasOpen = btn.classList.contains('on')
    this.closeMenu?.()
    if (wasOpen) return
    const m = document.createElement('div'); m.className = 'ctx-menu nb-menu'
    const bar = btn.closest('.nb-cbar')
    const away = (e: Event): void => { if (!m.contains(e.target as Node) && !btn.contains(e.target as Node)) close() }
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') close() }
    const close = (): void => {
      m.remove(); btn.classList.remove('on'); bar?.classList.remove('open')
      document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true)
      if (this.closeMenu === close) this.closeMenu = null
    }
    this.closeMenu = close
    fill(m, close)
    btn.classList.add('on'); bar?.classList.add('open')
    btn.parentElement!.append(m)
    // 下面放不下就翻到按钮上方(两个量都是视口坐标,互相比较不受缩放影响)
    if (m.getBoundingClientRect().bottom > this.root.getBoundingClientRect().bottom - 8) m.classList.add('up')
    document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key, true)
  }

  private cellMenu(btn: HTMLElement, u: CellUI): void {
    const id = u.cell.id!
    const code = u.cell.cell_type === 'code'
    const i = this.nb!.cells.indexOf(u.cell)
    const item = (k: string, ic: string, label: string, hint = '', cls = ''): string => `<button data-k="${k}" class="${cls}">${icon(ic)}${esc(label)}${hint ? `<span class="ctx-shortcut">${hint}</span>` : ''}</button>`
    this.menu(btn, (m, close) => {
      m.innerHTML = [
        code && this.canRun ? item('next', 'play', t('cell.runNext'), '⇧ ↵') + item('upto', 'ff', t('cell.runToHere')) : '',
        code ? item('clear', 'erase', t('cell.clear')) + '<div class="ctx-separator"></div>' : '',
        i > 0 ? item('up', 'up', t('cell.up')) : '', i < this.nb!.cells.length - 1 ? item('down', 'dn', t('cell.down')) : '',
        u.cell.cell_type === 'raw' ? '' : item('conv', code ? 'text' : 'code', t(code ? 'cell.toText' : 'cell.toCode')),
        code ? item('embed', 'open', t('cell.copyEmbed')) : '',
        '<div class="ctx-separator"></div>', item('del', 'trash', t('cell.delete'), '', 'danger'),
      ].join('')
      m.addEventListener('click', (e) => {
        const k = (e.target as Element).closest<HTMLElement>('[data-k]')?.dataset.k
        if (!k) return
        close()
        if (k === 'next') { void this.runCells([id]); this.focusNext(id) }
        else if (k === 'upto') void this.runAll(id)
        else if (k === 'clear') this.clearOutputs(id)
        else if (k === 'up') this.move(id, -1)
        else if (k === 'down') this.move(id, 1)
        else if (k === 'conv') this.convert(id)
        else if (k === 'del') this.remove(id)
        else if (k === 'embed') {
          // 链接里的格子 id 得在盘上:老文件的 id 是打开时才补的,先存一次。
          this.dirty = true; void this.save()
          void navigator.clipboard.writeText(`![[${this.path}#${id}]]`).then(() => ctx.notify?.(t('cell.copied'), { level: 'success' }))
        }
      })
    })
  }

  private kernelMenu(btn: HTMLElement): void {
    this.menu(btn, (m, close) => {
      const alive = !!this.kernel && this.kernel.state !== 'dead'
      const act = (k: string, ic: string, label: string, cls = ''): string => `<button data-k="${k}" class="${cls}">${icon(ic)}${esc(label)}</button>`
      m.innerHTML = `<div class="ctx-head">${esc(t('kernel.head'))}</div><div data-envs><div class="nb-menu-note">${esc(t('kernel.finding'))}</div></div><input data-custom spellcheck="false" placeholder="${esc(t('kernel.custom'))}"><div class="ctx-separator"></div>${act('restart', 'restart', t('bar.restart'))}${act('restartall', 'play', t('kernel.restartRunAll'))}${act('clearall', 'erase', t('kernel.clearAll'))}${alive ? `<div class="ctx-separator"></div>${act('shutdown', 'stop', t('kernel.shutdown'), 'danger')}` : ''}`
      const pick = (path: string | null): void => {
        close()
        if (path) prefs.python[this.path] = path; else delete prefs.python[this.path]
        void ctx.saveData?.(prefs)
        // 内核开着就换过去(变量会清空,和 Jupyter 换内核一样);没开就只记下,下次运行时用。
        if (alive) void this.restart(); else { this.asked = false; this.paintBar() }
      }
      const using = this.kernel?.python?.path ?? prefs.python[this.path] ?? null
      void post<{ envs: EnvInfo[] }>('/envs', { nb: this.abs }).then(({ envs }) => {
        const box = m.querySelector('[data-envs]')
        if (!box) return
        box.innerHTML = envs.map((e, i) => {
          const on = using ? e.path === using : e.kind === 'bundled'
          const kind = e.kind === 'bundled' ? t('kernel.fallback') : (e.kind !== 'system' && e.hint) || t(`kernel.kind.${e.kind}`)
          const hint = !e.ok ? t(e.why === 'old' ? 'kernel.old' : 'kernel.broken') : `${kind} · ${e.version ?? ''}`
          return `<button data-env="${i}" ${e.ok ? '' : 'disabled'} title="${esc(e.path)}"><span class="ctx-check">${on ? icon('check') : ''}</span>${esc(e.kind === 'bundled' ? t('kernel.bundled') : e.label)}<span class="ctx-shortcut">${esc(hint)}</span></button>`
        }).join('')
        box.addEventListener('click', (ev) => {
          const i = (ev.target as Element).closest<HTMLElement>('[data-env]')?.dataset.env
          if (i != null) pick(envs[Number(i)].kind === 'bundled' ? null : envs[Number(i)].path)
        })
        if (m.getBoundingClientRect().bottom > this.root.getBoundingClientRect().bottom - 8) m.classList.add('up')
      }).catch(() => { const box = m.querySelector('[data-envs]'); if (box) box.innerHTML = '' })
      m.querySelector<HTMLInputElement>('[data-custom]')!.addEventListener('keydown', (e) => {
        const v = (e.target as HTMLInputElement).value.trim()
        if (e.key === 'Enter' && v) pick(v)
        e.stopPropagation()
      })
      m.addEventListener('click', (e) => {
        const k = (e.target as Element).closest<HTMLElement>('[data-k]')?.dataset.k
        if (!k) return
        close()
        if (k === 'restart') void this.restart()
        else if (k === 'restartall') void this.restart(true)
        else if (k === 'clearall') this.clearOutputs()
        else if (k === 'shutdown') void this.shutdown()
      })
    })
  }

  relocale(): void { this.paint() }

  /** 窗口要关 / 插件要停 / 标签要关:手上的改动马上写下去。 */
  flush(): void { if (this.dirty) void this.save() }

  dispose(): void {
    if (this.dead) return
    this.flush()
    this.dead = true
    this.abort.abort()
    this.closeMenu?.()
    this.stopTick()
    this.offWatch?.()
    // 关掉标签页就停这本的 Python 进程(不等回音;引擎那边两小时没人理也会自己收)。
    if (this.abs && this.kernel && this.kernel.state !== 'dead') void post('/shutdown', { nb: this.abs }).catch(() => {})
    for (const u of this.cells.values()) u.dispose()
    this.cells.clear()
    views.delete(this)
    if (active === this) setActive([...views].at(-1) ?? null)
    this.host.replaceChildren()
    this.host.classList.remove('nb-host')
  }

  /** 大纲面板用。 */
  outline(): { cell: string; level: number; text: string }[] { return this.nb ? headings(this.nb) : [] }
}
