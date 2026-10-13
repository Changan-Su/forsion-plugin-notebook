# Jupyter 笔记本(Forsion 插件)

在 Forsion 里打开、编辑、运行 `.ipynb`。页面像一篇笔记:文字格就是文字,代码块下面跟着表格、图表和报错;变量、大纲和 Tangu 对话在右栏。文件始终是标准的 nbformat 4,拿到 Jupyter 或 VS Code 里照样打开。

English: open, edit and run Jupyter notebooks inside Forsion. Files stay standard nbformat 4.

## 安装

Forsion 桌面端 → 商店 → 搜「Jupyter」→ 安装。需要 Forsion 桌面 2.13.0 或更新。当前版本 0.1.0。

Install from the Store inside Forsion Desktop (search for "Jupyter"). Requires Forsion Desktop 2.13.0 or later.

## 能做什么

- 文件树里 `.ipynb` 有自己的图标,点开就是笔记本页面;右键「新建 Jupyter 笔记本」(新建出来只有一个空的代码格)。
- 运行一格(格子右上角的三角,或 `⇧↵` 运行并跳到下一格、`⌘↵` 运行不动)、全部运行、从头运行到这一格、中断、重启内核。一格出错,排在后面的不再跑。
- 输出:打印的文字(进度条那类 `\r` 重写也认)、表格(pandas)、图(matplotlib 行内,高清)、报错(回溯折叠,可以「问 Tangu」「复制报错」)。`%` 命令和 `!` 命令都能用。
- 每本笔记本可以选这台电脑上的 Python:conda、文件夹里的 `.venv` / `venv`、pyenv、系统自带的都会列出来,也可以手填解释器路径。什么都不选、或者选的那个起不来,用随 Forsion 安装的 Python。低于 3.10 的解释器用不了(列表里是灰的)。
- 阅读模式:代码收起,只看文字和结果。
- 笔记里 `![[路径/x.ipynb#格子id]]` 画出那一格上次运行的结果(格子的「更多」菜单里有「复制嵌入到笔记的链接」)。
- 自动保存:改完停手 0.8 秒写一次,每跑完一格马上写一次。没人动过的文件不会被重写。

运行需要桌面版,并且库在这台电脑上;网页版、手机、云端库里只能看和改。

## 两半

| 目录 | 是什么 |
|---|---|
| `src/` → `main.js` | 界面那一半(渲染层插件)。`nb.ts` 读写 .ipynb,`view.ts` 页面,`outputs.ts` 画输出,`panels.ts` 右栏三个面板 |
| `tangu-plugins/notebook-kernel/` | 运行那一半(引擎插件):找 Python 环境、起停进程、排队执行、事件缓冲 |
| `tangu-plugins/notebook-kernel/python/runner.py` | 每本笔记本一个的 Python 进程。IPython 在进程内跑(不经 ZMQ、不需要 ipykernel),和引擎之间是一行一条 JSON |
| `tangu-plugins/notebook-kernel/python/vendor/` | 随插件带的 IPython(纯 Python,约 14 MB)。选的环境里自己有 IPython 就用它的,没有才用这份 |

界面经 `ctx.tangu.request('notebook-kernel', …)` 调引擎插件的路由(`/envs` `/open` `/exec` `/events` `/interrupt` `/shutdown`),事件用长轮询收回来。关掉标签页就停那本笔记本的进程;引擎那边两小时没人理的也会自己收。

## 写盘的纪律

内存里就是文件里那棵 JSON 树,只改动过的地方:不认识的键、键的顺序、没动过的格子原样写回;序列化成 Jupyter 自己写的样子(缩进 1 格、多行文本一行一个元素)。Jupyter 写的文件读进来再写出去逐字节不变(`npm run check` 钉着)。数字的写法也保留(`1.0` 写回还是 `1.0`,超过 2^53 的整数不走样)。读不懂的文件(坏 JSON、nbformat 3)只显示说明,绝不写回。4.5 之前没有格子 id 的文件,第一次保存时补上 id 并把小版本抬到 5(Jupyter 自己也这么做)。

## 开发

```bash
npm install
npm run build        # main.js + 引擎插件的 dist/
npm run check        # 往返、输出收集、产物同步、文案成对、清单
node verify/runner-probe.cjs     # 只测 Python 运行器(需要 Forsion 桌面端检出里的自带 Python)
node verify/engine-probe.mjs     # 不起应用,直接调引擎插件的路由
```

真应用冒烟(隔离 home + 真引擎,不碰开发实例;在仓根跑,`UI_ZOOM=1.1` 再跑一遍):

```bash
node .claude/hooks/devlock.cjs run --vehicle=e2e --what="Jupyter 插件冒烟" --eta=5 -- node Forsion-Instrumentality-Project/forsion-plugin-notebook/verify/smoke.cjs
```

`main.js`、`tangu-plugins/notebook-kernel/dist/` 和 `python/vendor/` 都要提交(商店装的是 zip,不构建)。换 IPython 版本:改 `python/requirements.txt` 后 `npm run vendor`。

## Tangu

右栏的对话以这本笔记本所在的文件夹为工作目录。引擎那一半给 Tangu 三件工具(说明是英文的,给模型读):

| 工具 | 做什么 | 审批 |
|---|---|---|
| `notebook_read` | 把笔记本读成文本:每格的位置、id、类型、源码和已存输出的文字 | 不用 |
| `notebook_edit` | 按格改:替换源码 / 在某格后插入 / 删除;别的内容原样 | 和跑命令同一档 |
| `notebook_run` | 在这本笔记本的内核里跑一格或全部,返回输出 | 和跑命令同一档 |

Tangu 跑的和页面上跑的是同一个内核,变量互通。输出由谁写进文件在开跑那一刻定下:页面正跟着这个内核就由页面写,否则由工具写(重新读一遍文件,只换那几格的输出)。页面没打开过这本笔记本时,Tangu 用的是随 Forsion 安装的 Python。

## 已知的局限

- 后台线程在它那一格跑完之后才打印的东西,会并进当时正在跑的那一格(或者最后跑的那一格)。
- 图表是 matplotlib 默认的白底,深色界面下是一块白。
- 交互式控件(ipywidgets)不支持;带脚本的 HTML 输出(plotly / bokeh 的交互图)被清洗掉,有静态图就显示静态图。
- `input()` 会报错而不是等输入;没有代码补全;没有 Jupyter 的命令模式快捷键。
- 文字格里 `attachment:` 引用的图片不显示(文件里原样保留)。
- 文字格用的是应用给插件的 Markdown 编辑器。桌面 2.13.3 起,插件让应用不画它顶上那排「编辑 / 源码 / 预览」;2.13.0 到 2.13.2 上那一排是用样式藏掉的(`style.css` 里有说明)。
- 手上有没存的改动(停手不到 0.8 秒)时文件恰好被别处改了,以手上的为准。
- Windows 上没有实测过(中断只走进程内那一条路;关内核时用 `taskkill /T` 收子进程)。网页版 / 手机上「只能看和改」那条路也没有实测过。
- Tangu 的三件工具用真模型跑过(2026-10-12,GPT 6 Luna,Genesis 真模型台架的 `--only notebook`):「第三格报错了,改好重跑」「最后加一格再跑」这两句不点名工具的话,模型会用这三件工具,改和跑各弹一张审批,文件守得住。只测了这一个模型、这一种小任务;页面开着的时候 Tangu 来跑(输出由页面落盘)那条路,真模型没走过。
