# 更新日志

## 0.1.1(2026-11-18)

- 记着的「每本笔记本用哪个 Python」读不出来时(文件读出错、是空的、写到一半或被手改坏),先停用记忆、提示一次,也不再保存:以前会按空表接着用,下一次在内核菜单里选 Python 就把所有笔记本的选择整个盖掉。这时笔记本先用 Forsion 自带的 Python,在内核菜单里换的照样能用,只是只在这次有效、每次换都会提示不会记住。没存过时照旧。需要 2.14.2 之后的 Forsion 桌面版(更早的版本读不出来时仍当没存过)。
- 记着的选择还没读回来就在内核菜单里选了 Python,现在等读完再保存,存下的是原来的加上这次选的;以前会只存下这一本,读回来时还会把刚选的换回旧的。
- **English:** When the saved choice of which Python each notebook uses can't be read (a read error, an empty file, a write cut off halfway, or a hand edit that broke it), remembering it is paused, you're told once, and nothing is saved. Before, the plugin carried on with an empty list and the next Python you picked from the kernel menu overwrote the choices for every notebook. Notebooks now use the Python bundled with Forsion for the time being; picking another one from the kernel menu still works, but only for this session, and you're told each time that it won't be remembered. With nothing saved yet it behaves as before. Needs a Forsion desktop build newer than 2.14.2 (earlier builds still treat unreadable data as never saved).
- **English:** Picking a Python from the kernel menu before the saved choices have loaded now waits for them and saves the originals plus the new pick. Before, it saved only that one notebook, and the load then switched the new pick back to the old one.

## 0.1.0(2026-10-13)

第一版:打开、编辑、运行 `.ipynb`。

- 页面摆法「像一篇笔记」;文字格用应用自己的 Markdown 编辑器,代码格带 Python 高亮和自动缩进。
- 运行:一格 / 全部 / 从头到这一格 / 中断 / 重启;`%` 命令、`!` 命令、行内图表、表格、报错回溯。
- 每本笔记本可选 Python 环境(conda / venv / pyenv / 系统 / 手填路径),随 Forsion 安装的 Python 兜底。
- 右栏:内核里的变量、大纲、Tangu 对话(报错可以一键递过去)。
- 阅读模式;笔记里按格嵌入结果;文件树右键新建。
- Tangu 能读、改、跑单元格(`notebook_read` / `notebook_edit` / `notebook_run`;改和跑走「跑命令」那档审批),和页面共用同一个内核。
- 工具说明里明说「改笔记本用 `notebook_edit`,别用通用的文件编辑工具」:真模型实测时有一次读完先去用 `edit_file` 改 `.ipynb`。
- 写盘:Jupyter 写的文件读进再写出逐字节不变(数字的写法也保留);读不懂的文件不写回。
