// 右栏的三个视图:变量 / 大纲 / 对话。它们不属于某一个标签,跟着「最近操作过的那本笔记本」走。
import { chat, getActive, onActive, type NotebookView } from './view'
import { esc, icon } from './icons'
import { locale, t } from './i18n'

/** 当前笔记本换了、或它有变化(跑完一格 / 改了文字)时调 draw。返回卸载函数。 */
function follow(draw: (v: NotebookView | null) => void): () => void {
  let offView: (() => void) | null = null
  const bind = (): void => {
    offView?.()
    const v = getActive()
    offView = v ? v.subscribe(() => draw(v)) : null
    draw(v)
  }
  const offActive = onActive(bind)
  const offLocale = ctx.subscribeLocale?.(() => draw(getActive()))
  bind()
  return () => { offActive(); offLocale?.(); offView?.() }
}

const empty = (text: string): string => `<div class="nb-side-empty">${esc(text)}</div>`

export function mountVars(host: HTMLElement): () => void {
  const open = new Set<string>()
  let last = ''
  let cur: NotebookView | null = null
  const draw = (v: NotebookView | null): void => {
    cur = v
    const key = JSON.stringify([v?.path, v?.vars, [...open], locale()])
    if (key === last) return
    last = key
    if (!v) { host.innerHTML = empty(t('vars.none')); return }
    if (!v.vars.length) { host.innerHTML = empty(t('vars.empty')); return }
    host.innerHTML = `<div class="nb-side"><div class="nb-side-h">${esc(t('vars.head'))}<span>${v.vars.length}</span></div>${v.vars.map((x) => {
      const has = !!x.cols?.length; const on = has && open.has(x.name)
      return `<div class="nb-var${has ? ' has' : ''}${on ? ' open' : ''}"><button class="row" data-name="${esc(x.name)}">${icon(on ? 'down' : 'right')}<b>${esc(x.name)}</b><em>${esc(x.type)}</em><span>${esc(x.shape ?? x.value ?? '')}</span></button>${on ? `<div class="cols">${x.cols!.map(([a, b]) => `<div>${esc(a)}<em>${esc(b)}</em></div>`).join('')}</div>` : ''}</div>`
    }).join('')}<div class="nb-hint">${esc(t('vars.hint'))}</div></div>`
  }
  const click = (e: Event): void => {
    const name = (e.target as Element).closest<HTMLElement>('[data-name]')?.dataset.name
    if (!name) return
    if (open.has(name)) open.delete(name); else open.add(name)
    draw(cur)
  }
  host.addEventListener('click', click)
  const off = follow(draw)
  return () => { off(); host.removeEventListener('click', click); host.replaceChildren() }
}

export function mountOutline(host: HTMLElement): () => void {
  let last = ''
  let cur: NotebookView | null = null
  const draw = (v: NotebookView | null): void => {
    cur = v
    const items = v?.outline() ?? []
    const key = JSON.stringify([v?.path, items, locale()])
    if (key === last) return
    last = key
    if (!v) { host.innerHTML = empty(t('outline.none')); return }
    if (!items.length) { host.innerHTML = empty(t('outline.empty')); return }
    const top = Math.min(...items.map((h) => h.level))
    host.innerHTML = `<div class="nb-side">${items.map((h) => `<button class="nb-ol-item" data-cell="${esc(h.cell)}" style="padding-left:${8 + (h.level - top) * 14}px">${esc(h.text)}</button>`).join('')}</div>`
  }
  const click = (e: Event): void => {
    const id = (e.target as Element).closest<HTMLElement>('[data-cell]')?.dataset.cell
    if (id) cur?.reveal(id)
  }
  host.addEventListener('click', click)
  const off = follow(draw)
  return () => { off(); host.removeEventListener('click', click); host.replaceChildren() }
}

export function mountChat(host: HTMLElement): () => void {
  let folder: string | null | undefined
  let handle: HostChatMount | null = null
  const drop = (): void => { handle?.dispose(); handle = null; chat.quote = null }
  const open = (v: NotebookView, withFolder: boolean): void => {
    host.innerHTML = '<div class="nb-chat"></div>'
    const dir = v.folder
    const h = ctx.tangu!.mountChat!(host.firstElementChild as HTMLElement, { folder: (withFolder && dir) || undefined, title: t('chat.title', { name: dir ? dir.slice(dir.lastIndexOf('/') + 1) : v.name }) })
    handle = h
    let lastQuote: string | null = null
    chat.quote = (text) => { lastQuote = text; h.quote(text) }
    if (chat.pending) { chat.quote(chat.pending); chat.pending = null }
    // 给了工作目录、却在这台设备上落不了地(引擎不在本机跑):退成不带工作目录的对话,刚递过去的引文补给新的那一份。
    if (withFolder && dir) void h.ready.then((res) => {
      if (res.ok || handle !== h || !ctx.app.hostPath || ctx.app.hostPath(dir) != null) return
      const q = lastQuote; drop(); open(v, false); if (q) chat.quote?.(q)
    })
  }
  const draw = (v: NotebookView | null): void => {
    const next = v ? v.folder : null
    if (next === folder && handle) return
    folder = next
    drop()
    if (!v || !ctx.tangu?.mountChat) { host.innerHTML = empty(t(v ? 'chat.unavailable' : 'chat.none')); return }
    // 对话按文件夹一条(宿主的规则):工作目录就是这本笔记本所在的文件夹,Agent 用相对路径就能读到它和旁边的数据文件。
    // ponytail: 放在库根的笔记本没有文件夹可给,对话不带工作目录(引文照常递得过去,Agent 自己读不到文件)。
    open(v, true)
  }
  const off = follow(draw)
  return () => { off(); drop(); host.replaceChildren() }
}
