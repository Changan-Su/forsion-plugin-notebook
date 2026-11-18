// 每本笔记本记住选的解释器(存在插件自己的数据里,不写进 .ipynb:本机路径不该跟着文件走)。
// 单独一个文件、不碰 DOM:check.mjs 能直接拿假宿主跑。
const prefs: { python: Record<string, string> } = { python: {} }
void ctx.loadData?.<typeof prefs>().then((d) => { if (d?.python && typeof d.python === 'object') Object.assign(prefs.python, d.python) }).catch(() => {})

/** 这本记着的解释器路径;没记 = 用随 Forsion 安装的那个。 */
export const pythonFor = (path: string): string | undefined => prefs.python[path]

/** 给这本选解释器(null = 随 Forsion 安装的那个)并记下。 */
export function choosePython(path: string, python: string | null): void {
  if (python) prefs.python[path] = python; else delete prefs.python[path]
  void ctx.saveData?.(prefs)
}
