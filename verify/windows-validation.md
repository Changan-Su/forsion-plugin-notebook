# Windows 验证记录 / Windows validation

2026-10-23，Windows 11（10.0.26200），Python 3.12.15，真实 Forsion Electron 宿主。

本轮实际复现并修复：

- `.ipynb` 的 CRLF 被保存成 LF；未编辑的文件现在保留原始字节，编辑后保留换行约定，旧文件补 id 的迁移仍生效。
- `time.sleep(60)` 收到中断后不能及时退出；Windows 改为 `signal.raise_signal(SIGINT)`，实际唤醒休眠，内核与变量保留。
- 先结束父 Python 再调用 `taskkill /T` 会留下子进程；现在父进程仍在时先收整棵树。taskkill 使用 System32 绝对路径，启动或退出失败有终止兜底。
- `!dir` 的中文文件名乱码；Windows 的 `!command` 改用无窗口的 ConPTY，原生命令和 Python 程序的控制台输出由系统统一转成 UTF-8。没有更改父 Python 的环境、私有子进程管道或系统代码页。

## 验证

- `npm run verify`：类型、构建、19 项自检通过。LF、CRLF、原样保存、旧文件迁移、输出格式、双语和发布产物均有检查。
- `npm run check:windows-kernel -- "C:\path\to\python.exe"`：21 项真实 Windows Python 检查，覆盖中文及空格路径、`!dir`、`%timeit`、Python 与 cmd 同行混合输出、直接子进程、私有管道 `text=True`、捕获 `!dir`、中断 shell/休眠/死循环、取消排队、保留变量、进程树、缺失解释器回退、无 System32 PATH 的清理，以及实际 `.venv\Scripts\python.exe` 的发现和切换。
- 真实应用 `verify/smoke.cjs`：35 项通过；实际点击运行，输出/图/错误写盘，菜单与变量栏，重启内核，编辑/阅读，嵌入，关闭标签和应用的进程清理。图按列宽适配；变量面板通过明确按钮打开，避免依赖宿主启动时恢复侧栏的顺序。
- 真引擎 + GPT 6 Luna：`--only notebook` 场景 12 项通过，模型实际使用 read/edit/run，4 次审批全部通过。没有用假模型代替。
- 聚焦 Codex 评审发现的 taskkill PATH 依赖已修复，并新增真实缺 PATH 回归。编码实现采用 ConPTY，没有保留按整行猜测编码或全局改写 Python stdio 编码的方案；捕获子进程的 `text=True` 也有真实回归。

真实应用复跑（PowerShell，先构建宿主并备好内置 Python）：

```powershell
$env:GENESIS_DESKTOP = 'C:\path\to\Forsion-Genesis\desktop'
$env:FORSION_TEST_DESKTOP = 'left'
node verify/smoke.cjs
```

机器没有额外安装 conda 或低于 3.10 的 Python，未声称实测这些安装；实际 venv 已建立、枚举并运行。未发布商店版本，本轮修复由源码主分支提供。
