// 把一格的 outputs 画出来。编辑页、阅读模式、笔记里的嵌入共用这一份。
// 输出是别人的内容(下载来的 .ipynb、代码打印出来的 HTML):每次画之前都过一遍白名单,不只在收到时过。
import { joined, stripAnsi, type Cell, type Mime, type Output } from './nb'
import { esc, icon } from './icons'
import { t } from './i18n'

const TAGS = new Set('a abbr b blockquote br caption code col colgroup dd details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img kbd li mark ol p pre s small span strong style sub summary sup table tbody td tfoot th thead tr u ul'.split(' '))
const ATTRS = new Set('alt align border cellpadding cellspacing class colspan dir headers height href id lang open rowspan scope span src style title valign width'.split(' '))
// 样式里不许往外发请求、不许拉别的样式表。
const cleanCss = (css: string): string => css.replace(/@import[^;]*;?/gi, '').replace(/url\s*\([^)]*\)/gi, 'none').replace(/expression\s*\(/gi, '(')

/** 白名单:不在表里的标签连同里面的内容整个丢掉(script / iframe / object / form …),不在表里的属性丢掉(on* 自然也在内)。 */
export function sanitize(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const walk = (node: Element): void => {
    for (const el of [...node.children]) {
      const tag = el.tagName.toLowerCase()
      if (!TAGS.has(tag)) { el.remove(); continue }
      for (const a of [...el.attributes]) {
        const name = a.name.toLowerCase()
        if (!ATTRS.has(name)) { el.removeAttribute(a.name); continue }
        if (name === 'href' && !/^(https?:|mailto:|#)/i.test(a.value.trim())) el.removeAttribute(a.name)
        if (name === 'src' && !/^(data:image\/(png|jpeg|gif|webp);|https?:)/i.test(a.value.trim())) el.removeAttribute(a.name)
        if (name === 'style') el.setAttribute('style', cleanCss(a.value))
      }
      if (tag === 'a') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer') }
      if (tag === 'style') el.textContent = cleanCss(el.textContent ?? '')
      else walk(el)
    }
  }
  walk(doc.body)
  const frag = document.createDocumentFragment()
  frag.append(...doc.body.childNodes)
  return frag
}

// 表格的样子(pandas 的 DataFrame 走这里)。写在影子树里:输出自带的 <style> 出不来,应用的样式也进不去;颜色变量照常继承。
const SHADOW_CSS = `
:host { display: block; overflow: auto; contain: paint; font: 12.5px/1.5 var(--font-ui); color: var(--text); }
table { border-collapse: collapse; font-variant-numeric: tabular-nums; border: 0; }
th { font-weight: 500; color: var(--text-muted); text-align: right; padding: 5px 14px; border: 0; border-bottom: 1px solid var(--border); }
td { padding: 5px 14px; text-align: right; border: 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
tbody th { color: var(--text-faint); font: 11.5px var(--font-mono); padding-left: 2px; }
thead tr:first-child th:first-child { padding-left: 2px; }
p { margin: 6px 0; color: var(--text-muted); } a { color: var(--accent-ink); } img { max-width: 100%; }
pre, code { font-family: var(--font-mono); }
`

const MAX_TEXT = 200_000
function pre(cls: string, text: string): HTMLElement {
  const el = document.createElement('pre')
  el.className = cls
  const over = text.length - MAX_TEXT
  if (over > 0) {
    const note = document.createElement('div'); note.className = 'nb-cut'; note.textContent = t('out.truncated', { n: over })
    el.append(note, text.slice(over))
  } else el.textContent = text
  return el
}

function image(mime: string, data: string, meta: unknown): HTMLElement {
  const img = document.createElement('img')
  img.className = 'nb-img'
  img.src = mime === 'image/svg+xml' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}` : `data:${mime};base64,${data.replace(/\s+/g, '')}`
  const m = meta && typeof meta === 'object' ? meta as { width?: unknown; height?: unknown } : {}
  if (typeof m.width === 'number') img.width = m.width
  if (typeof m.height === 'number') img.height = m.height
  return img
}

function rich(data: Mime, meta: Record<string, unknown>): HTMLElement {
  const get = (k: string): string => joined(data[k])
  const html = get('text/html')
  const pic = ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml'].find((k) => data[k] != null)
  // 带脚本的 HTML(plotly / bokeh 那类)过了白名单就是空壳:有图用图,没有才显示清洗后的 HTML。
  if (html && !(pic && /<script/i.test(html))) {
    const box = document.createElement('div'); box.className = 'nb-html'
    const root = box.attachShadow({ mode: 'open' })
    const st = document.createElement('style'); st.textContent = SHADOW_CSS
    root.append(st, sanitize(html))
    return box
  }
  if (pic) return image(pic, get(pic), meta[pic])
  if (data['application/json'] != null) return pre('nb-text', JSON.stringify(data['application/json'], null, 2))
  return pre('nb-text', stripAnsi(get('text/markdown') || get('text/latex') || get('text/plain')))
}

export interface OutputActions {
  /** 「问 Tangu」:有对话面板的地方才给。 */
  ask?(errorText: string): void
}

function errorBox(o: Output, act: OutputActions): HTMLElement {
  const tb = (o.traceback ?? []).map(stripAnsi).join('\n')
  const head = `${o.ename ?? 'Error'}${o.evalue ? `: ${o.evalue}` : ''}`
  const n = tb.split('\n').length
  const box = document.createElement('div'); box.className = 'nb-err'
  box.innerHTML = `<div class="hd">${esc(head)}</div><button class="nb-fold" data-a="tb">${icon('right')}<span>${esc(t('out.traceback', { n }))}</span></button><pre hidden></pre><div class="nb-act">${act.ask ? `<button class="nb-chip pri" data-a="ask">${icon('chat')}${esc(t('out.ask'))}</button>` : ''}<button class="nb-chip" data-a="copy">${icon('copy')}${esc(t('out.copyError'))}</button></div>`
  const body = box.querySelector('pre')!; body.textContent = tb
  const full = `${head}\n\n${tb}`
  box.addEventListener('click', (e) => {
    const a = (e.target as Element).closest<HTMLElement>('[data-a]')?.dataset.a
    if (a === 'tb') {
      body.hidden = !body.hidden
      const b = box.querySelector('.nb-fold')!
      b.innerHTML = `${icon(body.hidden ? 'right' : 'down')}<span>${esc(t(body.hidden ? 'out.traceback' : 'out.tracebackHide', { n }))}</span>`
    } else if (a === 'copy') void navigator.clipboard.writeText(full)
    else if (a === 'ask') act.ask?.(full)
  })
  return box
}

/** 画进 host(先清空)。返回有没有画出东西。 */
export function renderOutputs(host: HTMLElement, cell: Cell, act: OutputActions = {}): boolean {
  host.replaceChildren()
  for (const o of cell.outputs ?? []) {
    if (o.output_type === 'stream') {
      const text = stripAnsi(joined(o.text))
      if (text) host.append(pre(`nb-stream${o.name === 'stderr' ? ' err' : ''}`, text))
    } else if (o.output_type === 'error') host.append(errorBox(o, act))
    else if (o.data && typeof o.data === 'object') host.append(rich(o.data, (o.metadata ?? {}) as Record<string, unknown>))
  }
  return host.childElementCount > 0
}
