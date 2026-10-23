# Windows 验证记录 / Windows validation

2026-10-23，Windows 11（10.0.26200），Python 3.12.15，真实 Forsion Electron 宿主。

本轮实际复现并修复：

- `.ipynb` 的 CRLF 被保存成 LF；未编辑的文件现在保留原始字节，编辑后保留换行约定，旧文件补 id 的迁移仍生效。
- `time.sleep(60)` 收到中断后不能及时退出；Windows 改为 `signal.raise_signal(SIGINT)`，实际唤醒休眠，内核与变量保留。
- 先结束父 Python 再调用 `taskkill /T` 会留下子进程；现在父进程仍在时先收整棵树。taskkill 使用 System32 绝对路径，启动或退出失败有终止兜底。
- `!dir` 的中文文件名乱码；在私有隐藏控制台里设定 UTF-8 后，另起 CMD 执行命令（CMD 会在启动时缓存代码页）。保留 IPython 原有管道、UNC 路径处理、错误策略与捕获语义，没有更改父 Python 的环境或系统代码页。

## 验证

- `npm run verify`：类型、构建、19 项自检通过。LF、CRLF、原样保存、旧文件迁移、输出格式、双语和发布产物均有检查。
- `npm run check:windows-kernel -- "C:\path\to\python.exe"`：24 项真实 Windows Python 检查，覆盖中文及空格路径、`!dir`、`%timeit`、Python 与 cmd 同行混合输出、直接子进程、私有管道 `text=True`、捕获文本的空行/制表符/尾空格、stdin EOF、中断 shell/休眠/死循环、取消排队、保留变量、进程树、缺失解释器回退、无 System32 PATH 的清理，以及实际 `.venv\Scripts\python.exe` 的发现、切换和带空格路径的 shell 调用。另提供 `FORSION_TEST_OLD_PYTHON`，可使用实际旧解释器核对禁用状态。
- 真实应用 `verify/smoke.cjs`：35 项通过；实际点击运行，输出/图/错误写盘，菜单与变量栏，重启内核，编辑/阅读，嵌入，关闭标签和应用的进程清理。图按列宽适配；变量面板通过明确按钮打开，避免依赖宿主启动时恢复侧栏的顺序。
- 真引擎 + GPT 6 Luna：`--only notebook` 场景 12 项通过，模型实际使用 read/edit/run，4 次审批全部通过。没有用假模型代替。
- 聚焦 Codex 评审发现的 taskkill PATH 依赖已修复，并新增真实缺 PATH 回归。编码路径最终保留原始字节管道；没有保留编码猜测、全局改写 Python 编码或 ConPTY 文本重绘方案。捕获的空行、制表符、尾空格、stdin EOF 及子进程 `text=True` 均有真实回归。

真实应用复跑（PowerShell，先构建宿主并备好内置 Python）：

```powershell
$env:GENESIS_DESKTOP = 'C:\path\to\Forsion-Genesis\desktop'
$env:FORSION_TEST_DESKTOP = 'left'
node verify/smoke.cjs
```

补验 conda：在独立临时 profile 安装真实 Miniforge 26.9.4-0，再用实际 conda 克隆创建子环境；base 和子环境的发现、内核选择和实际执行共 **6/6** 通过，均未退回内置 Python。安装采用 `/NoRegistry=1 /NoShortcuts=1 /RegisterPython=0 /AddToPath=0`，不初始化用户 shell；检查进程的 USERPROFILE、APPDATA 和 Python user base 均隔离。不是伪造 conda 清单或返回值。

复跑须先准备这两个真实环境（base 位于 fixture profile 的 `miniforge3`，或由该 profile 的 `.conda/environments.txt` 注册）：

```powershell
node verify/windows-conda.mjs 'C:\fixture-profile' 'C:\fixture-profile\miniforge3' 'C:\fixture-profile\miniforge3\envs\acceptance'
```

官方安装选项见 [constructor 文档](https://conda.github.io/constructor/cli-options/)，实际使用的安装器来自 [Miniforge 26.9.4-0](https://github.com/conda-forge/miniforge/releases/tag/26.9.4-0)，SHA256 `43638698f5ee811debae27b0dc3ab5c0300129bd400a847376c4bd2f6be15ceb`，与发布方校验文件一致。实际 venv 亦已建立、枚举并运行。未发布商店版本，本轮修复由源码主分支提供。
