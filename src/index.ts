// Jupyter 笔记本插件入口。宿主以 new Function('ctx', <本文件的 esbuild IIFE 产物>) 装载:`ctx` 是宿主注入的自由变量,
// 产物顶层不能有 import/export。
//
// 做四件事:认领 .ipynb(文件树图标 + 点开就是笔记本页面);右栏注册变量 / 大纲 / 对话三个视图;
// 文件树右键「新建 Jupyter 笔记本」;笔记里 `![[x.ipynb#格子]]` 画成那一格的结果。
// 装好就是空的:不带示例笔记本,新建出来只有一个空的代码格。
import css from './style.css'
import { NotebookView, allViews, hasRight, openPanel } from './view'
import { mountChat, mountOutline, mountVars } from './panels'
import { NotebookError, embedTarget, emptyNotebook, parse, serialize, source } from './nb'
import { renderOutputs } from './outputs'
import { esc, icon } from './icons'
import { t } from './i18n'

function injectCss(): void {
  const ID = 'forsion-notebook-css'
  // 恒覆写:热更新(停用 → 装新版 → 启用,渲染进程不重启)时旧 <style> 还挂着,只查存在会让新版顶着旧样式跑。
  let el = document.getElementById(ID) as HTMLStyleElement | null
  if (!el) { el = document.createElement('style'); el.id = ID; document.head.append(el) }
  el.textContent = css
}

/** 窗口要关 / 退到后面 / 插件要停:没落盘的改动马上写下去(平时是停手 0.8 秒后写)。 */
const flushAll = (): void => { for (const v of allViews()) v.flush() }
const flushSoon = (): void => { if (document.visibilityState !== 'visible' || !document.hasFocus()) flushAll() }

let opened = false
ctx.registerFileType({
  id: 'ipynb',
  extensions: ['.ipynb'],
  icon: 'code',
  title: 'Jupyter',
  mount(el, file) {
    injectCss()
    const v = new NotebookView(el, file.filePath)
    // 这一程第一次打开笔记本时把右栏的三个视图开出来;之后用户关了就不再自作主张(顶栏上有按钮)。
    if (!opened && hasRight(el)) { opened = true; openPanel('vars', el) }
    return () => v.dispose()
  },
})

// ponytail: 视图标题在装载时按当时的语言定下(宿主的视图标题只收字符串),切语言后要重载插件才变;侧栏标签只显示图标,影响很小。
ctx.registerView({ id: 'vars', title: t('view.vars'), icon: 'table', mount: (el) => { injectCss(); return mountVars(el) } })
ctx.registerView({ id: 'outline', title: t('view.outline'), icon: 'bulleted-list', mount: (el) => { injectCss(); return mountOutline(el) } })
ctx.registerView({ id: 'chat', title: t('view.chat'), icon: 'callout-note', mount: (el) => { injectCss(); return mountChat(el) } })

ctx.registerFileCreator({
  id: 'ipynb',
  label: t('new.label'),
  icon: 'code',
  async run(parent) {
    // 找一个没被占用的名字;读得到内容 = 已经有这个文件了。
    const base = `${parent ? `${parent}/` : ''}${t('new.name')}`
    let path = `${base}.ipynb`
    for (let i = 2; (await ctx.app.readFile(path).catch(() => null)) != null; i++) path = `${base} ${i}.ipynb`
    await ctx.app.writeFile(path, serialize(emptyNotebook()))
    ctx.app.openFile(path)
  },
})

// `![[分析/结果.ipynb#<格子 id>]]`:画那一格上次运行的结果(只读;要更新就打开笔记本再跑一次)。
// 不带 #:一张写着文件名和格数的小卡片。宿主把整条 target(连同 #…)交过来问 match,所以正则要放过锚点。
ctx.registerEmbedRenderer({
  id: 'ipynb',
  match: (target) => !!embedTarget(target),
  mount(el, embed) {
    injectCss()
    const { path, anchor } = embedTarget(embed.target) ?? { path: embed.target, anchor: '' }
    const box = document.createElement('div'); box.className = 'nb-embed'
    el.replaceChildren(box)
    let last: string | null | undefined
    const draw = async (): Promise<void> => {
      const text = await ctx.app.readFile(path).catch(() => null)
      if (text === last) return
      last = text
      const name = path.slice(path.lastIndexOf('/') + 1)
      const cap = (label: string): string => `<div class="cap">${icon('code')}<b>${esc(name)}</b>${esc(label)}<button data-open title="${esc(t('embed.open'))}">${icon('open')}</button></div>`
      try {
        if (text == null) throw new NotebookError('bad')
        const { nb } = parse(text)
        if (!anchor) { box.innerHTML = cap(t('embed.cells', { n: nb.cells.length })); return }
        // 锚点 = 格子的 id;也认「第几格」的数字(手写链接时方便)
        const i = nb.cells.findIndex((c) => c.id === anchor)
        const at = i >= 0 ? i : /^\d+$/.test(anchor) ? Number(anchor) - 1 : -1
        const cell = nb.cells[at]
        if (!cell) { box.innerHTML = `<div class="nb-embed-empty">${esc(t('embed.noCell'))}</div>${cap('')}`; return }
        const out = document.createElement('div')
        const any = renderOutputs(out, cell)
        box.innerHTML = any ? '' : `<div class="nb-embed-empty">${esc(t('embed.noOutput'))}</div>`
        if (any) box.append(out)
        const title = source(cell).split('\n').find((l) => l.trim().startsWith('#'))?.replace(/^[#\s]+/, '') ?? ''
        box.insertAdjacentHTML('beforeend', cap(`${t('embed.cell', { n: at + 1 })}${title ? ` · ${title}` : ''}`))
      } catch (e) {
        box.innerHTML = `<div class="nb-embed-empty">${esc(t(e instanceof NotebookError && e.why === 'old' ? 'load.old' : text == null ? 'load.missing' : 'load.bad'))}</div>`
      }
    }
    const click = (e: Event): void => { if ((e.target as Element).closest('[data-open]')) { e.preventDefault(); e.stopPropagation(); ctx.app.openFile(path) } }
    box.addEventListener('click', click)
    void draw()
    const off = ctx.app.watchFile?.(path, () => void draw())
    return () => { off?.(); box.remove() }
  },
})

const offLocale = ctx.subscribeLocale?.(() => { for (const v of allViews()) v.relocale() })
window.addEventListener('pagehide', flushAll)
window.addEventListener('blur', flushSoon)
document.addEventListener('visibilitychange', flushSoon)

/** 宿主停用 / 重载插件时先调它(这时 ctx 还能用),build.mjs 的 footer 把它 return 给宿主。 */
export default (): void => {
  flushAll()
  offLocale?.()
  window.removeEventListener('pagehide', flushAll)
  window.removeEventListener('blur', flushSoon)
  document.removeEventListener('visibilitychange', flushSoon)
}
