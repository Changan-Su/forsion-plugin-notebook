// 每本笔记本记住选的解释器(存在插件自己的数据里,不写进 .ipynb:本机路径不该跟着文件走)。
// 单独一个文件、不碰 DOM:check.mjs 能直接拿假宿主跑。
//
// 存过却读不出来(宿主 2026-11-17 起 reject,code = 'plugin-data-unreadable':读错误 / 零字节 / 写到一半 / 被手改坏):
// 按空表接着用、下一次选解释器就把所有笔记本的选择整个盖掉。所以这时不再存:选的解释器照样用,但只在这次有效
// (不让选的话,装在 conda / venv 里的包就用不了,笔记本等于跑不起来),读的时候和每次选的时候各提示一下。
// 停用到插件下次加载再读。没存过(null)照旧是空表;旧宿主读不出来也回 null,只能当空。
import { t } from './i18n'

const prefs: { python: Record<string, string> } = { python: {} }
let loaded = false
let blocked = false
/** 插件已经停用 / 重载:排在读完之后的那次存盘别再写,新实例可能已经存了更新的选择。 */
let disposed = false
export const disposePrefs = (): void => { disposed = true }
/** 读回来之前就选过的笔记本:读回来时不拿存着的旧选择盖掉(删掉的也不带回来)。 */
const early = new Set<string>()
const isDataUnreadable = (e: unknown): boolean => !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'plugin-data-unreadable'

/** 读完(成功、没存过、读不出来都算)之后 resolve,从不 reject。 */
export const prefsReady: Promise<void> = Promise.resolve()
  .then(() => ctx.loadData?.<typeof prefs>())
  .then((d) => {
    if (d?.python && typeof d.python === 'object') {
      for (const [k, v] of Object.entries(d.python)) if (!early.has(k)) prefs.python[k] = v
    }
  }, (e) => {
    if (!isDataUnreadable(e)) return
    blocked = true
    console.warn('[notebook] saved interpreter choices could not be read; remembering them is paused', e)
    ctx.notify?.(t('prefs.unreadable'), { level: 'warning' })
  })
  .finally(() => { loaded = true })

/** 这本记着的解释器路径;没记 = 用随 Forsion 安装的那个。 */
export const pythonFor = (path: string): string | undefined => prefs.python[path]

/** 给这本选解释器(null = 随 Forsion 安装的那个)。内存里马上换(换内核要立刻用上);存盘排在读完之后。 */
export function choosePython(path: string, python: string | null): void {
  if (!loaded) early.add(path)
  if (python) prefs.python[path] = python; else delete prefs.python[path]
  void prefsReady.then(() => {
    if (disposed) return
    if (blocked) { ctx.notify?.(t('prefs.notKept'), { level: 'warning' }); return }
    return ctx.saveData?.(prefs)
  }).catch((e) => console.warn('[notebook] interpreter choice could not be saved', e))
}
