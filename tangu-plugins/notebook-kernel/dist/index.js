// tangu-plugins/notebook-kernel/src/index.ts
import { isAbsolute as isAbsolute2, dirname as dirname3, join as join3, normalize } from "node:path";

// tangu-plugins/notebook-kernel/src/kernels.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, delimiter } from "node:path";
var MAX_EVENTS = 4e3;
var MAX_BYTES = 48 * 1024 * 1024;
var READY_TIMEOUT_MS = 3e4;
var Kernel = class {
  constructor(nb, pythonDir, bundled, log) {
    this.nb = nb;
    this.pythonDir = pythonDir;
    this.bundled = bundled;
    this.log = log;
  }
  proc = null;
  events = [];
  bytes = 0;
  seq = 0;
  /** highest seq any poller has been handed; stream text is only merged into events nobody has seen yet */
  delivered = 0;
  queue = [];
  current = null;
  execCells = /* @__PURE__ */ new Map();
  waiters = /* @__PURE__ */ new Set();
  counter = 0;
  state = "dead";
  python = null;
  fellBack;
  error;
  starting = null;
  generation = 0;
  lastTouch = Date.now();
  epoch = 0;
  cancelLaunch = null;
  lastPagePoll = 0;
  /** A notebook page is following this kernel (it long-polls every 10 s): it will write the outputs to the file. */
  attached() {
    return Date.now() - this.lastPagePoll < 2e4;
  }
  status() {
    return {
      state: this.state,
      python: this.python,
      fellBack: this.fellBack,
      error: this.error,
      current: this.current?.cell ?? null,
      queue: this.queue.map((e) => e.cell),
      head: this.seq
    };
  }
  /** Start (or restart on a different interpreter). Resolves once the runner said `ready`, or the kernel is dead. */
  async open(want, opts = {}) {
    this.lastTouch = Date.now();
    const target = want ?? this.bundled;
    const same = this.proc && this.python && target && this.python.path === target.path;
    if (this.starting && !opts.restart) {
      await this.starting;
      return this.status();
    }
    if (same && !opts.restart && this.state !== "dead") return this.status();
    this.stop("restart");
    this.fellBack = void 0;
    this.error = void 0;
    const epoch = this.epoch;
    this.starting = (async () => {
      if (!target) {
        this.fail("\u6CA1\u6709\u53EF\u7528\u7684 Python:\u81EA\u5E26\u7684\u90A3\u4EFD\u4E0D\u5728,\u7CFB\u7EDF\u91CC\u4E5F\u6CA1\u627E\u5230 python3");
        return;
      }
      const first = await this.launch(target);
      if (first === true || epoch !== this.epoch) return;
      if (this.bundled && target.path !== this.bundled.path) {
        this.log(`interpreter ${target.path} failed (${first}); falling back to bundled`);
        const second = await this.launch(this.bundled);
        if (epoch !== this.epoch) return;
        if (second === true) {
          this.fellBack = { wanted: target.label || target.path, reason: first };
          this.push({ t: "status" });
          return;
        }
        this.fail(second);
        return;
      }
      this.fail(first);
    })();
    const mine = this.starting;
    try {
      await mine;
    } finally {
      if (this.starting === mine) this.starting = null;
    }
    return this.status();
  }
  fail(reason) {
    this.state = "dead";
    this.error = reason;
    this.python = null;
    this.push({ t: "status" });
  }
  /** Spawn the runner on one interpreter; true when it reported ready, otherwise a short reason. */
  launch(env) {
    return new Promise((resolve3) => {
      const runner = join(this.pythonDir, "runner.py");
      if (!existsSync(runner)) {
        resolve3("runner.py \u4E0D\u5728\u63D2\u4EF6\u76EE\u5F55\u91CC");
        return;
      }
      const penv = {
        ...process.env,
        FORSION_NB_VENDOR: join(this.pythonDir, "vendor"),
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        PYTHONUNBUFFERED: "1",
        // 像激活了这个环境一样:笔记本里 `!python` / `!pip` 落在同一个解释器上。
        PATH: `${dirname(env.path)}${delimiter}${process.env.PATH ?? ""}`
      };
      if (env.kind !== "bundled") {
        delete penv.PYTHONHOME;
        delete penv.PYTHONPATH;
        delete penv.PYTHONNOUSERSITE;
      }
      const gen = ++this.generation;
      let settled = false;
      let buf = "";
      let diag = "";
      this.state = "starting";
      let proc;
      try {
        proc = spawn(env.path, [runner], { cwd: dirname(this.nb), env: penv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
      } catch (e) {
        resolve3(`\u8D77\u4E0D\u6765:${e.message}`);
        return;
      }
      this.proc = proc;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.cancelLaunch === cancel) this.cancelLaunch = null;
        resolve3(r);
      };
      const cancel = () => finish("\u5DF2\u53D6\u6D88");
      this.cancelLaunch = cancel;
      const timer = setTimeout(() => {
        if (!settled) {
          killTree(proc, "SIGKILL");
          finish("30 \u79D2\u5185\u6CA1\u6709\u5C31\u7EEA");
        }
      }, READY_TIMEOUT_MS);
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (gen !== this.generation) return;
          if (ev.t === "ready") {
            this.python = { path: env.path, label: env.label, kind: env.kind, version: ev.python, ipython: ev.ipython, vendored: !!ev.vendored };
            this.state = "idle";
            this.push({ t: "status" });
            finish(true);
            this.pump();
          } else if (ev.t === "fatal") {
            finish(ev.reason === "no-ipython" ? `\u8FD9\u4E2A\u73AF\u5883\u91CC\u6CA1\u6709 IPython,\u63D2\u4EF6\u5E26\u7684\u90A3\u4EFD\u4E5F\u88C5\u4E0D\u4E0A(Python ${ev.python ?? "?"})` : String(ev.detail ?? ev.reason));
          } else this.onRunnerEvent(ev);
        }
      });
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (c) => {
        diag = (diag + c).slice(-2e3);
      });
      proc.on("error", (e) => finish(`\u8D77\u4E0D\u6765:${e.message}`));
      proc.on("exit", (code, signal) => {
        if (gen !== this.generation) return;
        this.proc = null;
        if (!settled) {
          finish(diag.trim().split("\n").pop() || `\u8FDB\u7A0B\u9000\u51FA\u4E86(${signal ?? code})`);
          return;
        }
        const reason = `Python \u8FDB\u7A0B\u9000\u51FA\u4E86(${signal ?? code})`;
        this.abortAll("KernelDied", reason);
        this.state = "dead";
        this.error = reason;
        this.python = null;
        this.push({ t: "status" });
      });
    });
  }
  onRunnerEvent(ev) {
    const cell = ev.id ? this.execCells.get(ev.id) : void 0;
    if (!cell) return;
    const { id: _id, ...rest } = ev;
    if (ev.t === "stream") {
      const text = String(ev.text ?? "").replace(/\r\n/g, "\n");
      const last = this.events[this.events.length - 1];
      if (last && last.seq > this.delivered && last.t === "stream" && last.cell === cell && last.name === ev.name) {
        last.text = String(last.text) + text;
        this.bytes += text.length;
        this.wake();
      } else this.push({ t: "stream", cell, name: ev.name, text });
      return;
    }
    if (ev.t === "done") {
      const { vars, ...done } = rest;
      this.push({ ...done, cell, vars });
      if (this.current && this.current.id === ev.id) {
        this.current = null;
        this.state = "idle";
        if (ev.ok === false) this.abortQueue();
        this.pump();
      }
      return;
    }
    this.push({ ...rest, cell });
  }
  /** Queue cells for execution, in order. Returns the cells accepted. */
  exec(cells) {
    this.lastTouch = Date.now();
    for (const c of cells) {
      const ex = { id: `e${++this.counter}`, cell: c.cell, code: c.code };
      this.execCells.set(ex.id, ex.cell);
      this.queue.push(ex);
      this.push({ t: "queued", cell: ex.cell });
    }
    this.pump();
    return cells.map((c) => c.cell);
  }
  pump() {
    if (this.current || !this.proc || this.state !== "idle") return;
    const ex = this.queue.shift();
    if (!ex) return;
    this.current = ex;
    this.state = "busy";
    this.push({ t: "start", cell: ex.cell });
    this.send({ op: "exec", id: ex.id, code: ex.code });
  }
  send(obj) {
    try {
      this.proc?.stdin?.write(JSON.stringify(obj) + "\n");
    } catch {
    }
  }
  interrupt() {
    this.lastTouch = Date.now();
    if (!this.proc || !this.current) {
      this.abortQueue();
      return;
    }
    this.send({ op: "interrupt" });
    if (process.platform !== "win32") killTree(this.proc, "SIGINT");
  }
  abortQueue() {
    const q = this.queue;
    this.queue = [];
    for (const ex of q) this.push({ t: "done", cell: ex.cell, ok: false, aborted: true, n: null, ms: 0 });
  }
  abortAll(ename, evalue) {
    if (this.current) {
      this.push({ t: "error", cell: this.current.cell, ename, evalue, traceback: [evalue] });
      this.push({ t: "done", cell: this.current.cell, ok: false, died: true, n: null, ms: 0 });
      this.current = null;
    }
    this.abortQueue();
  }
  /** Kill the process. `restart` keeps the event log so pollers see the hand-over. */
  stop(why) {
    this.generation++;
    this.epoch++;
    this.cancelLaunch?.();
    this.cancelLaunch = null;
    const p = this.proc;
    this.proc = null;
    this.abortAll("KernelRestarted", why === "restart" ? "\u5185\u6838\u91CD\u542F\u4E86" : "\u5185\u6838\u5173\u95ED\u4E86");
    if (p) {
      try {
        p.stdin?.end();
      } catch {
      }
      killTree(p, "SIGTERM");
      setTimeout(() => killTree(p, "SIGKILL"), 1500).unref?.();
    }
    this.state = "dead";
    this.python = null;
    this.execCells.clear();
    if (why === "shutdown") {
      this.error = void 0;
      this.fellBack = void 0;
    }
    this.push({ t: "status" });
  }
  push(ev) {
    const full = { ...ev, seq: ++this.seq };
    const size = approxSize(full);
    this.events.push(full);
    this.bytes += size;
    while (this.events.length > MAX_EVENTS || this.bytes > MAX_BYTES && this.events.length > 50) {
      this.bytes -= approxSize(this.events.shift());
    }
    this.wake();
  }
  wake() {
    const w = [...this.waiters];
    this.waiters.clear();
    for (const f of w) f();
  }
  /** Events after `since`. Waits up to `waitMs` when there are none yet. `gap` = the cursor fell off the log. */
  async poll(since, waitMs, page = true) {
    this.lastTouch = Date.now();
    if (page) this.lastPagePoll = Date.now();
    if (since > this.seq) since = 0;
    if (this.seq <= since && waitMs > 0) {
      await new Promise((resolve3) => {
        const done = () => {
          clearTimeout(t);
          this.waiters.delete(done);
          resolve3();
        };
        const t = setTimeout(done, Math.min(waitMs, 15e3));
        this.waiters.add(done);
      });
    }
    const first = this.events[0]?.seq ?? this.seq + 1;
    const events = this.events.filter((e) => e.seq > since);
    if (events.length) this.delivered = Math.max(this.delivered, events[events.length - 1].seq);
    return { events, gap: since > 0 && since + 1 < first, ...this.status() };
  }
};
function killTree(p, sig) {
  try {
    if (process.platform !== "win32") {
      if (p.pid) process.kill(-p.pid, sig);
      return;
    }
    if (sig === "SIGKILL" && p.pid) spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {
    });
    else p.kill(sig);
  } catch {
    try {
      p.kill(sig);
    } catch {
    }
  }
}
function approxSize(ev) {
  let n = 200;
  if (typeof ev.text === "string") n += ev.text.length;
  const data = ev.data;
  if (data) for (const v of Object.values(data)) n += typeof v === "string" ? v.length : 200;
  return n;
}

// tangu-plugins/notebook-kernel/src/envs.ts
import { execFile } from "node:child_process";
import { existsSync as existsSync2, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter as delimiter2, dirname as dirname2, join as join2, resolve } from "node:path";
var WIN = process.platform === "win32";
var MIN = [3, 10];
var versions = /* @__PURE__ */ new Map();
var pyIn = (envDir) => WIN ? join2(envDir, "python.exe") : join2(envDir, "bin", "python");
var venvPy = (envDir) => WIN ? join2(envDir, "Scripts", "python.exe") : join2(envDir, "bin", "python");
function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
function bundledPython() {
  const p = process.env.TANGU_PYTHON_BIN;
  return p && existsSync2(p) ? { path: p, label: "Forsion", kind: "bundled", ok: true } : null;
}
function askVersion(py) {
  const hit = versions.get(py);
  if (hit && Date.now() - hit.at < 12e4) return Promise.resolve(hit.version);
  return new Promise((resolve3) => {
    const env = { ...process.env };
    delete env.PYTHONHOME;
    delete env.PYTHONPATH;
    execFile(py, ["-c", 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], { timeout: 4e3, windowsHide: true, env }, (err, stdout) => {
      const v = !err && /^\d+\.\d+\.\d+/.test(stdout.trim()) ? stdout.trim() : null;
      versions.set(py, { at: Date.now(), version: v });
      resolve3(v);
    });
  });
}
function candidates(nbDir) {
  const out = [];
  const home = homedir();
  let dir = nbDir;
  for (let i = 0; i < 4 && dir && dir !== dirname2(dir); i++, dir = dirname2(dir)) {
    for (const name of [".venv", "venv", "env"]) {
      const py = venvPy(join2(dir, name));
      if (existsSync2(py)) out.push({ path: py, label: name, kind: "venv", hint: i === 0 ? "" : basename(dir) });
    }
  }
  const condaRoots = /* @__PURE__ */ new Set();
  try {
    for (const line of readFileSync(join2(home, ".conda", "environments.txt"), "utf8").split(/\r?\n/)) if (line.trim()) condaRoots.add(line.trim());
  } catch {
  }
  for (const base of ["miniconda3", "anaconda3", "miniforge3", "mambaforge", join2("opt", "anaconda3"), join2("opt", "miniconda3")].map((n) => join2(home, n)).concat(WIN ? [] : ["/opt/anaconda3", "/opt/miniconda3", "/opt/homebrew/Caskroom/miniconda/base", "/opt/homebrew/Caskroom/miniforge/base"])) {
    if (!existsSync2(base)) continue;
    condaRoots.add(base);
    try {
      for (const n of readdirSync(join2(base, "envs"))) condaRoots.add(join2(base, "envs", n));
    } catch {
    }
  }
  try {
    for (const n of readdirSync(join2(home, ".conda", "envs"))) condaRoots.add(join2(home, ".conda", "envs", n));
  } catch {
  }
  for (const root of condaRoots) {
    const py = pyIn(root);
    if (existsSync2(py)) out.push({ path: py, label: basename(dirname2(root)) === "envs" ? basename(root) : "base", kind: "conda" });
  }
  try {
    for (const n of readdirSync(join2(home, ".pyenv", "versions"))) {
      const py = join2(home, ".pyenv", "versions", n, "bin", "python");
      if (existsSync2(py)) out.push({ path: py, label: n, kind: "pyenv" });
    }
  } catch {
  }
  const bundled = process.env.TANGU_PYTHON_BIN ? dirname2(process.env.TANGU_PYTHON_BIN) : "";
  for (const d of (process.env.PATH ?? "").split(delimiter2)) {
    if (!d || d === bundled) continue;
    for (const name of WIN ? ["python.exe"] : ["python3", "python"]) {
      const py = join2(d, name);
      if (!existsSync2(py)) continue;
      if (py === "/usr/bin/python3" && !existsSync2("/Library/Developer/CommandLineTools/usr/bin/python3") && !existsSync2("/Applications/Xcode.app")) continue;
      if (WIN && /WindowsApps/i.test(py)) continue;
      out.push({ path: py, label: name.replace(/\.exe$/, ""), kind: "system", hint: d });
      break;
    }
  }
  return out;
}
async function listEnvs(nbDir) {
  const seen = /* @__PURE__ */ new Set();
  const list = [];
  const b = bundledPython();
  if (b) seen.add(real(b.path));
  for (const c of candidates(nbDir)) {
    const key = c.kind === "system" ? real(c.path) : `env:${resolve(c.path)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(c);
    if (list.length >= 24) break;
  }
  const checked = await Promise.all(list.map(async (c) => describe(c)));
  return b ? [...checked, { ...b, version: await askVersion(b.path) ?? void 0 }] : checked;
}
async function describe(c) {
  const version = await askVersion(c.path);
  if (!version) return { ...c, ok: false, why: "broken" };
  const [maj, min] = version.split(".").map(Number);
  const ok = maj > MIN[0] || maj === MIN[0] && min >= MIN[1];
  return { ...c, version, ok, ...ok ? {} : { why: "old" } };
}
async function resolveEnv(path, nbDir) {
  if (!path) return null;
  const b = bundledPython();
  if (b && resolve(b.path) === resolve(path)) return b;
  if (!existsSync2(path)) return null;
  const known = candidates(nbDir).find((c) => resolve(c.path) === resolve(path));
  const info = await describe(known ?? { path, label: basename(dirname2(dirname2(path))) || basename(path), kind: "custom" });
  return info.ok ? info : null;
}

// tangu-plugins/notebook-kernel/src/tools.ts
import { readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, resolve as resolve2 } from "node:path";

// src/nb.ts
var NotebookError = class extends Error {
  constructor(why, detail = "") {
    super(detail || why);
    this.why = why;
  }
};
var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var joined = (v) => Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "";
var lines = (s) => s === "" ? [] : s.split(/(?<=\n)/);
var newId = (taken) => {
  for (; ; ) {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
};
function emptyNotebook() {
  return {
    cells: [newCell("code", /* @__PURE__ */ new Set())],
    metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { name: "python" } },
    nbformat: 4,
    nbformat_minor: 5
  };
}
function newCell(type, taken, source2 = "") {
  return type === "code" ? { cell_type: "code", execution_count: null, id: newId(taken), metadata: {}, outputs: [], source: lines(source2) } : { cell_type: "markdown", id: newId(taken), metadata: {}, source: lines(source2) };
}
var NUMERIC_KEYS = /* @__PURE__ */ new Set(["nbformat", "nbformat_minor", "execution_count", "width", "height"]);
var rawJSON = JSON.rawJSON;
function parseJson(text) {
  if (!rawJSON) return JSON.parse(text);
  return JSON.parse(text, (k, v, c) => typeof v === "number" && c?.source !== void 0 && c.source !== JSON.stringify(v) && !NUMERIC_KEYS.has(k) ? rawJSON(c.source) : v);
}
function parse(text) {
  if (!text.trim()) return { nb: emptyNotebook(), changed: false };
  let raw;
  try {
    raw = parseJson(text);
  } catch (e) {
    throw new NotebookError("bad", String(e.message));
  }
  if (!isObj(raw)) throw new NotebookError("bad", "not an object");
  if (typeof raw.nbformat === "number" && raw.nbformat < 4) throw new NotebookError("old", `nbformat ${raw.nbformat}`);
  if (raw.nbformat !== 4 || !Array.isArray(raw.cells) || !raw.cells.every(isObj)) throw new NotebookError("bad", "not an nbformat 4 notebook");
  const nb = raw;
  if (!isObj(nb.metadata)) nb.metadata = {};
  if (typeof nb.nbformat_minor !== "number") nb.nbformat_minor = 0;
  const taken = /* @__PURE__ */ new Set();
  let changed = false;
  for (const c of nb.cells) {
    if (!isObj(c.metadata)) c.metadata = {};
    if (c.source == null) c.source = [];
    if (c.cell_type === "code" && !Array.isArray(c.outputs)) c.outputs = [];
    if (typeof c.id === "string" && c.id && !taken.has(c.id)) {
      taken.add(c.id);
      continue;
    }
    c.id = newId(taken);
    changed = true;
  }
  if (changed && nb.nbformat_minor < 5) nb.nbformat_minor = 5;
  return { nb, changed };
}
var TEXT_MIME = /^text\/|^image\/svg\+xml$|^application\/javascript$/;
var serialize = (nb) => JSON.stringify(nb, null, 1) + "\n";
var source = (c) => joined(c.source);
var setSource = (c, text) => {
  c.source = lines(text);
};
var ids = (nb) => new Set(nb.cells.map((c) => c.id).filter(Boolean));
var OutputSink = class {
  constructor(cell) {
    this.cell = cell;
  }
  byDisplay = /* @__PURE__ */ new Map();
  clearNext = false;
  /** 开始跑:清掉上次的输出和序号。 */
  begin() {
    this.cell.outputs = [];
    this.cell.execution_count = null;
    this.byDisplay.clear();
    this.clearNext = false;
  }
  /** 跑完:把这一格攒下的整段文本拆成 Jupyter 写的样子(流输出、文本类的 mime 值)。 */
  finish(n) {
    this.cell.execution_count = n ?? null;
    for (const o of this.cell.outputs ?? []) {
      if (typeof o.text === "string") o.text = lines(o.text);
      if (isObj(o.data)) {
        for (const [k, v] of Object.entries(o.data)) if (typeof v === "string" && TEXT_MIME.test(k)) o.data[k] = lines(v);
      }
    }
  }
  /** 返回 true = 输出变了,需要重画。 */
  apply(ev) {
    const outs = this.cell.outputs ??= [];
    if (ev.t === "clear") {
      if (ev.wait) this.clearNext = true;
      else outs.length = 0;
      return !ev.wait;
    }
    if (!["stream", "display", "result", "error"].includes(ev.t)) return false;
    if (ev.t === "display" && ev.update) {
      const o = ev.display_id ? this.byDisplay.get(ev.display_id) : void 0;
      if (!o) return false;
      o.data = ev.data ?? {};
      o.metadata = ev.metadata ?? {};
      return true;
    }
    if (this.clearNext) {
      outs.length = 0;
      this.clearNext = false;
    }
    if (ev.t === "stream") {
      const last = outs.at(-1);
      const text = ev.text ?? "";
      if (last?.output_type === "stream" && last.name === ev.name) last.text = carriage(joined(last.text) + text);
      else outs.push({ name: ev.name ?? "stdout", output_type: "stream", text: carriage(text) });
    } else if (ev.t === "display") {
      const o = { data: ev.data ?? {}, metadata: ev.metadata ?? {}, output_type: "display_data" };
      if (ev.display_id) this.byDisplay.set(ev.display_id, o);
      outs.push(o);
    } else if (ev.t === "result") {
      outs.push({ data: ev.data ?? {}, execution_count: ev.n ?? null, metadata: ev.metadata ?? {}, output_type: "execute_result" });
    } else {
      outs.push({ ename: ev.ename ?? "Error", evalue: ev.evalue ?? "", output_type: "error", traceback: ev.traceback ?? [] });
    }
    return true;
  }
};
function carriage(s) {
  if (!s.includes("\r")) return s;
  return s.replace(/\r\n/g, "\n").replace(/[^\n]*\r(?=[^\n])/g, "");
}
var ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
var stripAnsi = (s) => s.replace(ANSI, "");

// tangu-plugins/notebook-kernel/src/tools.ts
var MAX_OUT = 6e3;
var clip = (s) => s.length <= MAX_OUT ? s : `\u2026 (${s.length - MAX_OUT} earlier characters omitted)
${s.slice(-MAX_OUT)}`;
function pathOf(args, ctx) {
  const raw = typeof args.path === "string" ? args.path.trim() : "";
  const p = raw && (isAbsolute(raw) ? resolve2(raw) : ctx.cwd ? resolve2(ctx.cwd, raw) : "");
  if (!p || !/\.ipynb$/i.test(p)) throw new Error("path must point to an .ipynb file (absolute, or relative to the working directory)");
  return p;
}
async function load(p) {
  return parse(await readFile(p, "utf8"));
}
async function store(p, nb) {
  const tmp = `${p}.tmp-${process.pid}`;
  await writeFile(tmp, serialize(nb), "utf8");
  await rename(tmp, p);
}
function find(nb, ref) {
  const s = String(ref ?? "").trim();
  const byId = nb.cells.findIndex((c) => c.id === s);
  if (byId >= 0) return byId;
  return /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= nb.cells.length ? Number(s) - 1 : -1;
}
function outputsText(c) {
  const parts = [];
  for (const o of c.outputs ?? []) {
    if (o.output_type === "stream") parts.push(stripAnsi(joined(o.text)));
    else if (o.output_type === "error") parts.push(`${o.ename}: ${o.evalue}
${(o.traceback ?? []).map(stripAnsi).join("\n").split("\n").slice(-14).join("\n")}`);
    else if (o.data) {
      const kinds = Object.keys(o.data).filter((k) => k !== "text/plain");
      const plain = stripAnsi(joined(o.data["text/plain"]));
      parts.push(`${kinds.length ? `[${kinds.join(", ")} output]
` : ""}${plain}`);
    }
  }
  return clip(parts.join("\n").trim());
}
function cellText(c, i) {
  const head = `[${i + 1}] ${c.cell_type} id=${c.id}${c.cell_type === "code" && c.execution_count != null ? ` In[${c.execution_count}]` : ""}`;
  const out = c.cell_type === "code" ? outputsText(c) : "";
  return `${head}
${source(c)}${out ? `
--- output ---
${out}` : ""}`;
}
async function collect(k, since, cells) {
  const sinks = new Map(cells.map((c) => [c.id, new OutputSink(c)]));
  const pending = new Set(sinks.keys());
  const started = /* @__PURE__ */ new Set();
  while (pending.size) {
    const r = await k.poll(since, 1e4, false);
    for (const ev of r.events) {
      since = ev.seq;
      const sink = ev.cell ? sinks.get(ev.cell) : void 0;
      if (!sink || !pending.has(ev.cell)) continue;
      if (ev.t === "start") {
        sink.begin();
        started.add(ev.cell);
      } else if (ev.t === "done") {
        if (started.has(ev.cell)) sink.finish(ev.n);
        pending.delete(ev.cell);
      } else if (started.has(ev.cell)) sink.apply(ev);
    }
    if (r.gap) since = Math.max(since, r.head);
    if (r.state === "dead" && !r.events.length) break;
  }
}
function notebookTools(host) {
  const fail = (e) => `Error: ${e instanceof Error ? e.message : String(e)}`;
  const common = {
    mode: "host",
    isEnabledFor: (profile) => profile.capabilities.hostExec
  };
  return [
    {
      ...common,
      name: "notebook_read",
      definition: { type: "function", function: {
        name: "notebook_read",
        description: "Read a Jupyter notebook (.ipynb) as text: every cell with its position, id, type, source and the text of its saved outputs (images and rich outputs are listed by type). Pass `cell` to read just one cell. Use this instead of reading the .ipynb file as raw JSON.",
        parameters: { type: "object", properties: {
          path: { type: "string", description: "Path to the .ipynb file, absolute or relative to the working directory." },
          cell: { type: "string", description: "Optional. A cell id, or its 1-based position, to read only that cell." }
        }, required: ["path"] }
      } },
      capabilities: { sideEffect: "read", parallel: true },
      async execute(args, ctx) {
        try {
          const p = pathOf(args, ctx);
          const { nb } = await load(p);
          if (args.cell != null && String(args.cell).trim()) {
            const i = find(nb, args.cell);
            return i < 0 ? `Error: no cell "${args.cell}" (the notebook has ${nb.cells.length} cells)` : cellText(nb.cells[i], i);
          }
          return `${p} \u2014 ${nb.cells.length} cells

${nb.cells.map(cellText).join("\n\n")}`;
        } catch (e) {
          return fail(e);
        }
      }
    },
    {
      ...common,
      name: "notebook_edit",
      definition: { type: "function", function: {
        name: "notebook_edit",
        description: "Edit a Jupyter notebook (.ipynb) cell by cell. `replace` sets a cell's source (its saved outputs are cleared), `insert` adds a new cell after the given cell (or at the top when `cell` is omitted), `delete` removes a cell. Everything else in the file is left as it is. The open notebook page reloads by itself. This does not run anything: call notebook_run afterwards to execute.",
        parameters: { type: "object", properties: {
          path: { type: "string", description: "Path to the .ipynb file, absolute or relative to the working directory." },
          action: { type: "string", enum: ["replace", "insert", "delete"] },
          cell: { type: "string", description: "A cell id or 1-based position. Required for replace and delete; for insert, the new cell goes after it." },
          source: { type: "string", description: "The full new source of the cell (replace, insert)." },
          cell_type: { type: "string", enum: ["code", "markdown"], description: "Type of the inserted cell. Defaults to code." }
        }, required: ["path", "action"] }
      } },
      capabilities: { sideEffect: "write", approval: "command", concurrencyKey: "notebook" },
      async execute(args, ctx) {
        try {
          const p = pathOf(args, ctx);
          const { nb } = await load(p);
          const action = String(args.action);
          const at = args.cell != null && String(args.cell).trim() ? find(nb, args.cell) : -1;
          if (action !== "insert" && at < 0) return `Error: no cell "${args.cell ?? ""}" (the notebook has ${nb.cells.length} cells)`;
          if (action === "insert" && args.cell != null && String(args.cell).trim() && at < 0) return `Error: no cell "${args.cell}"`;
          if (action !== "delete" && typeof args.source !== "string") return "Error: source is required";
          let touched = null;
          if (action === "replace") {
            touched = nb.cells[at];
            setSource(touched, args.source);
            if (touched.cell_type === "code") {
              touched.outputs = [];
              touched.execution_count = null;
            }
          } else if (action === "insert") {
            touched = newCell(args.cell_type === "markdown" ? "markdown" : "code", ids(nb), args.source);
            nb.cells.splice(at + 1, 0, touched);
          } else if (action === "delete") {
            nb.cells.splice(at, 1);
            if (!nb.cells.length) nb.cells.push(newCell("code", /* @__PURE__ */ new Set()));
          } else return "Error: action must be replace, insert or delete";
          await store(p, nb);
          return touched ? `Done. Cell ${nb.cells.indexOf(touched) + 1} id=${touched.id} (${touched.cell_type}). The notebook now has ${nb.cells.length} cells.` : `Deleted. The notebook now has ${nb.cells.length} cells.`;
        } catch (e) {
          return fail(e);
        }
      }
    },
    {
      ...common,
      name: "notebook_run",
      definition: { type: "function", function: {
        name: "notebook_run",
        description: 'Run code cells of a Jupyter notebook (.ipynb) in its live Python kernel and return their outputs. Variables persist between runs and are shared with the notebook page the user has open. Pass `cell` (an id or 1-based position) to run one cell, or "all" to run every code cell from the top; a failing cell stops the cells after it. Outputs are saved into the notebook. Cells still running after `timeout_seconds` keep running in the kernel; read the notebook later to see their result.',
        parameters: { type: "object", properties: {
          path: { type: "string", description: "Path to the .ipynb file, absolute or relative to the working directory." },
          cell: { type: "string", description: 'A cell id, its 1-based position, or "all".' },
          timeout_seconds: { type: "number", description: "How long to wait for the result. Default 120, max 900." }
        }, required: ["path", "cell"] }
      } },
      capabilities: { sideEffect: "system", approval: "command", concurrencyKey: "notebook", defaultTimeoutMs: 96e4 },
      async execute(args, ctx) {
        try {
          const p = pathOf(args, ctx);
          const { nb, changed } = await load(p);
          if (changed) await store(p, nb);
          const all = String(args.cell).trim().toLowerCase() === "all";
          const at = all ? -1 : find(nb, args.cell);
          if (!all && at < 0) return `Error: no cell "${args.cell}" (the notebook has ${nb.cells.length} cells)`;
          const cells = (all ? nb.cells : [nb.cells[at]]).filter((c) => c.cell_type === "code" && source(c).trim());
          if (!cells.length) return "Nothing to run: no code in the selected cell(s).";
          const k = await host.kernel(ctx.userId, p);
          const st = k.status();
          if (st.state === "dead") return `Error: Python could not start: ${st.error ?? "unknown reason"}`;
          const pageWrites = k.attached();
          k.exec(cells.map((c) => ({ cell: c.id, code: source(c) })));
          const finished = collect(k, st.head, cells).then(async () => {
            if (pageWrites) return;
            const disk = await load(p);
            for (const c of cells) {
              const d = disk.nb.cells.find((x) => x.id === c.id);
              if (d && d.cell_type === "code") {
                d.outputs = c.outputs;
                d.execution_count = c.execution_count;
              }
            }
            await store(p, disk.nb);
          });
          const waitMs = Math.max(1, Math.min(Number(args.timeout_seconds) || 120, 900)) * 1e3;
          let timer;
          const late = await Promise.race([finished.then(() => false), new Promise((r) => {
            timer = setTimeout(() => r(true), waitMs);
            ctx.signal?.addEventListener("abort", () => r(true), { once: true });
          })]);
          clearTimeout(timer);
          finished.catch(() => {
          });
          const py = k.status().python;
          const text = cells.map((c) => cellText(c, nb.cells.indexOf(c))).join("\n\n");
          return `${late ? "Still running after the wait; the kernel keeps going and the outputs are saved when it finishes. Partial result so far:\n\n" : ""}${text}

(Python ${py?.version ?? "?"} \u2014 ${py?.kind === "bundled" ? "bundled with Forsion" : py?.path ?? ""})`;
        } catch (e) {
          return fail(e);
        }
      }
    }
  ];
}

// tangu-plugins/notebook-kernel/src/index.ts
var ID = "notebook-kernel";
var kernels = /* @__PURE__ */ new Map();
var reaper = null;
function stopAll() {
  for (const k of kernels.values()) k.stop("shutdown");
  kernels.clear();
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
}
var plugin = {
  activate(ctx) {
    const pythonDir = join3(ctx.paths.pluginDir, "python");
    const keyOf = (userId, nb) => `${userId}
${nb}`;
    const nbOf = (req, res) => {
      const raw = req.body?.nb;
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ detail: "no user" });
        return null;
      }
      if (typeof raw !== "string" || !isAbsolute2(raw) || !/\.ipynb$/i.test(raw)) {
        res.status(400).json({ detail: "nb must be an absolute .ipynb path" });
        return null;
      }
      return { nb: normalize(raw), userId: String(userId) };
    };
    const get = (userId, nb, create) => {
      const key = keyOf(userId, nb);
      let k = kernels.get(key);
      if (!k && create) {
        k = new Kernel(nb, pythonDir, bundledPython(), (m) => ctx.log(m));
        kernels.set(key, k);
      }
      return k ?? null;
    };
    const guard = (fn) => async (req, res) => {
      try {
        await fn(req, res);
      } catch (e) {
        ctx.log(`route failed: ${e.stack ?? e}`);
        if (!res.headersSent) res.status(500).json({ detail: String(e.message ?? e) });
      }
    };
    const preferred = /* @__PURE__ */ new Map();
    ctx.registerToolProvider({
      id: ID,
      tools: () => notebookTools({
        async kernel(userId, nb) {
          const k = get(userId, nb, true);
          if (k.status().state === "dead") {
            const want = preferred.get(keyOf(userId, nb));
            await k.open(want ? await resolveEnv(want, dirname3(nb)) : null);
          }
          return k;
        }
      })
    });
    ctx.registerScopedRoutes((router) => {
      router.post("/envs", guard(async (req, res) => {
        const a = nbOf(req, res);
        if (!a) return;
        res.json({ envs: await listEnvs(dirname3(a.nb)) });
      }));
      router.post("/status", guard((req, res) => {
        const a = nbOf(req, res);
        if (!a) return;
        const key = keyOf(a.userId, a.nb);
        if (typeof req.body.python === "string" && req.body.python) preferred.set(key, req.body.python);
        else preferred.delete(key);
        const k = kernels.get(key);
        res.json(k ? k.status() : { state: "dead", python: null, current: null, queue: [], head: 0 });
      }));
      router.post("/open", guard(async (req, res) => {
        const a = nbOf(req, res);
        if (!a) return;
        const want = typeof req.body.python === "string" && req.body.python ? req.body.python : "";
        if (want) preferred.set(keyOf(a.userId, a.nb), want);
        else preferred.delete(keyOf(a.userId, a.nb));
        const env = want ? await resolveEnv(want, dirname3(a.nb)) : null;
        const k = get(a.userId, a.nb, true);
        const st = await k.open(env, { restart: !!req.body.restart });
        res.json(want && !env && !st.fellBack ? { ...st, fellBack: { wanted: want, reason: "\u627E\u4E0D\u5230\u8FD9\u4E2A\u89E3\u91CA\u5668,\u6216\u8005\u5B83\u7684 Python \u4F4E\u4E8E 3.10" } } : st);
      }));
      router.post("/exec", guard(async (req, res) => {
        const a = nbOf(req, res);
        if (!a) return;
        const cells = Array.isArray(req.body.cells) ? req.body.cells.filter((c) => c && typeof c.cell === "string" && typeof c.code === "string").slice(0, 2e3) : [];
        const k = get(a.userId, a.nb, false);
        if (!k || k.status().state === "dead") {
          res.status(409).json({ detail: "kernel is not running" });
          return;
        }
        res.json({ accepted: k.exec(cells), ...k.status() });
      }));
      router.post("/events", guard(async (req, res) => {
        const a = nbOf(req, res);
        if (!a) return;
        const k = get(a.userId, a.nb, false);
        if (!k) {
          res.json({ events: [], gap: false, state: "dead", python: null, current: null, queue: [], head: 0 });
          return;
        }
        res.json(await k.poll(Number(req.body.since) || 0, Math.max(0, Math.min(Number(req.body.wait) || 0, 15e3))));
      }));
      router.post("/interrupt", guard((req, res) => {
        const a = nbOf(req, res);
        if (!a) return;
        const k = get(a.userId, a.nb, false);
        k?.interrupt();
        res.json(k ? k.status() : { state: "dead" });
      }));
      router.post("/shutdown", guard((req, res) => {
        const a = nbOf(req, res);
        if (!a) return;
        const key = keyOf(a.userId, a.nb);
        const k = kernels.get(key);
        if (k) {
          k.stop("shutdown");
          kernels.delete(key);
        }
        res.json({ state: "dead" });
      }));
    });
    reaper = setInterval(() => {
      const now = Date.now();
      for (const [key, k] of kernels) if (now - k.lastTouch > 2 * 36e5) {
        k.stop("shutdown");
        kernels.delete(key);
      }
    }, 10 * 6e4);
    reaper.unref?.();
    const meta = {
      id: ID,
      name: "\u7B14\u8BB0\u672C\u5185\u6838",
      nameEn: "Notebook kernel",
      description: "\u7ED9 Jupyter \u7B14\u8BB0\u672C\u8DD1\u4EE3\u7801:\u4E3A\u6BCF\u672C\u6253\u5F00\u7684\u7B14\u8BB0\u672C\u8D77\u4E00\u4E2A Python \u8FDB\u7A0B,\u53EF\u4EE5\u9009\u672C\u673A\u7684 Python \u73AF\u5883,Forsion \u81EA\u5E26\u7684\u90A3\u4EFD\u515C\u5E95\u3002",
      descriptionEn: "Runs the code in Jupyter notebooks: one Python process per open notebook, on a local Python environment you pick, with the Python shipped with Forsion as the fallback.",
      scopes: ["global"],
      defaultEnabled: true,
      settings: { fields: [] }
    };
    ctx.registerPlugin(meta);
    ctx.log(`${ID} activated (bundled python: ${bundledPython()?.path ?? "none"})`);
  },
  deactivate() {
    stopAll();
  }
};
var index_default = plugin;
export {
  index_default as default
};
