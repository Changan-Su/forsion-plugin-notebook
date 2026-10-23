/**
 * One Python process per open notebook (keyed by user + absolute notebook path).
 * The process is python/runner.py; this file owns its lifecycle, the run queue and an event log
 * the renderer reads by polling (`since` cursor), because the host transport is request/response JSON.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import type { EnvInfo } from './envs.js';

export interface KernelEvent {
  seq: number;
  /** stream | display | result | error | clear | start | done | status */
  t: string;
  /** cell id the event belongs to (absent on `status`) */
  cell?: string;
  [k: string]: unknown;
}

interface Exec { id: string; cell: string; code: string }

export interface KernelStatus {
  state: 'starting' | 'idle' | 'busy' | 'dead';
  python: { path: string; label: string; kind: string; version?: string; ipython?: string; vendored?: boolean } | null;
  /** set when the interpreter the user picked could not start and the bundled one took over */
  fellBack?: { wanted: string; reason: string };
  error?: string;
  current: string | null;
  queue: string[];
  head: number;
}

const MAX_EVENTS = 4000;
const MAX_BYTES = 48 * 1024 * 1024;
const READY_TIMEOUT_MS = 30_000;

export class Kernel {
  private proc: ChildProcess | null = null;
  private events: KernelEvent[] = [];
  private bytes = 0;
  private seq = 0;
  /** highest seq any poller has been handed; stream text is only merged into events nobody has seen yet */
  private delivered = 0;
  private queue: Exec[] = [];
  private current: Exec | null = null;
  private execCells = new Map<string, string>();
  private waiters = new Set<() => void>();
  private counter = 0;
  private state: KernelStatus['state'] = 'dead';
  private python: KernelStatus['python'] = null;
  private fellBack: KernelStatus['fellBack'];
  private error: string | undefined;
  private starting: Promise<void> | null = null;
  private generation = 0;
  lastTouch = Date.now();
  private epoch = 0;
  private cancelLaunch: (() => void) | null = null;
  private lastPagePoll = 0;
  /** A notebook page is following this kernel (it long-polls every 10 s): it will write the outputs to the file. */
  attached(): boolean { return Date.now() - this.lastPagePoll < 20_000; }

  constructor(
    readonly nb: string,
    private readonly pythonDir: string,
    private readonly bundled: EnvInfo | null,
    private readonly log: (msg: string) => void,
  ) {}

  status(): KernelStatus {
    return {
      state: this.state, python: this.python, fellBack: this.fellBack, error: this.error,
      current: this.current?.cell ?? null, queue: this.queue.map((e) => e.cell), head: this.seq,
    };
  }

  /** Start (or restart on a different interpreter). Resolves once the runner said `ready`, or the kernel is dead. */
  async open(want: EnvInfo | null, opts: { restart?: boolean } = {}): Promise<KernelStatus> {
    this.lastTouch = Date.now();
    const target = want ?? this.bundled;
    const same = this.proc && this.python && target && this.python.path === target.path;
    if (this.starting && !opts.restart) { await this.starting; return this.status(); }
    if (same && !opts.restart && this.state !== 'dead') return this.status();
    this.stop('restart');
    this.fellBack = undefined; this.error = undefined;
    const epoch = this.epoch; // stop() 会让它前进:启动途中被关掉 / 又重启了,这一次启动后面的步骤(退回自带、报失败)都作废
    this.starting = (async () => {
      if (!target) { this.fail('没有可用的 Python:自带的那份不在,系统里也没找到 python3'); return; }
      const first = await this.launch(target);
      if (first === true || epoch !== this.epoch) return;
      if (this.bundled && target.path !== this.bundled.path) {
        // 用户选的那个起不来:退回自带的,并把原因带给界面。
        this.log(`interpreter ${target.path} failed (${first}); falling back to bundled`);
        const second = await this.launch(this.bundled);
        if (epoch !== this.epoch) return;
        if (second === true) { this.fellBack = { wanted: target.label || target.path, reason: first }; this.push({ t: 'status' }); return; }
        this.fail(second);
        return;
      }
      this.fail(first);
    })();
    const mine = this.starting;
    try { await mine; } finally { if (this.starting === mine) this.starting = null; }
    return this.status();
  }

  private fail(reason: string): void {
    this.state = 'dead'; this.error = reason; this.python = null;
    this.push({ t: 'status' });
  }

  /** Spawn the runner on one interpreter; true when it reported ready, otherwise a short reason. */
  private launch(env: EnvInfo): Promise<true | string> {
    return new Promise((resolve) => {
      const runner = join(this.pythonDir, 'runner.py');
      if (!existsSync(runner)) { resolve('runner.py 不在插件目录里'); return; }
      const penv: NodeJS.ProcessEnv = {
        ...process.env,
        FORSION_NB_VENDOR: join(this.pythonDir, 'vendor'),
        PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1',
        // 像激活了这个环境一样:笔记本里 `!python` / `!pip` 落在同一个解释器上。
        PATH: `${dirname(env.path)}${delimiter}${process.env.PATH ?? ''}`,
      };
      if (env.kind !== 'bundled') { delete penv.PYTHONHOME; delete penv.PYTHONPATH; delete penv.PYTHONNOUSERSITE; }
      const gen = ++this.generation;
      let settled = false; let buf = ''; let diag = '';
      this.state = 'starting';
      let proc: ChildProcess;
      try {
        // 自成一个进程组(Windows 除外:那边 detached 会弹出控制台窗口):关内核时连同代码里起的子进程一起收掉。
        proc = spawn(env.path, [runner], { cwd: dirname(this.nb), env: penv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      } catch (e) { resolve(`起不来:${(e as Error).message}`); return; }
      this.proc = proc;
      const finish = (r: true | string) => { if (settled) return; settled = true; clearTimeout(timer); if (this.cancelLaunch === cancel) this.cancelLaunch = null; resolve(r); };
      const cancel = () => finish('已取消');
      this.cancelLaunch = cancel;
      const timer = setTimeout(() => { if (!settled) { killTree(proc, 'SIGKILL'); finish('30 秒内没有就绪'); } }, READY_TIMEOUT_MS);
      proc.stdout!.setEncoding('utf8');
      proc.stdout!.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (gen !== this.generation) return;
          if (ev.t === 'ready') {
            this.python = { path: env.path, label: env.label, kind: env.kind, version: ev.python, ipython: ev.ipython, vendored: !!ev.vendored };
            this.state = 'idle'; this.push({ t: 'status' }); finish(true); this.pump();
          } else if (ev.t === 'fatal') {
            finish(ev.reason === 'no-ipython' ? `这个环境里没有 IPython,插件带的那份也装不上(Python ${ev.python ?? '?'})` : String(ev.detail ?? ev.reason));
          } else this.onRunnerEvent(ev);
        }
      });
      proc.stderr!.setEncoding('utf8');
      proc.stderr!.on('data', (c: string) => { diag = (diag + c).slice(-2000); });
      proc.on('error', (e) => finish(`起不来:${e.message}`));
      proc.on('exit', (code, signal) => {
        if (gen !== this.generation) return;
        this.proc = null;
        if (!settled) { finish(diag.trim().split('\n').pop() || `进程退出了(${signal ?? code})`); return; }
        // 运行中途死掉:把正在跑的和排队的都收尾,界面才不会一直转圈。
        const reason = `Python 进程退出了(${signal ?? code})`;
        this.abortAll('KernelDied', reason);
        this.state = 'dead'; this.error = reason; this.python = null;
        this.push({ t: 'status' });
      });
    });
  }

  private onRunnerEvent(ev: any): void {
    const cell = ev.id ? this.execCells.get(ev.id) : undefined;
    if (!cell) return; // output with no cell to attach to (before the first run, or a restart in between)
    const { id: _id, ...rest } = ev;
    if (ev.t === 'stream') {
      const text = String(ev.text ?? '').replace(/\r\n/g, '\n');
      const last = this.events[this.events.length - 1];
      if (last && last.seq > this.delivered && last.t === 'stream' && last.cell === cell && last.name === ev.name) {
        last.text = String(last.text) + text; this.bytes += text.length; this.wake();
      } else this.push({ t: 'stream', cell, name: ev.name, text });
      return;
    }
    if (ev.t === 'done') {
      const { vars, ...done } = rest;
      this.push({ ...done, cell, vars });
      if (this.current && this.current.id === ev.id) {
        this.current = null; this.state = 'idle';
        if (ev.ok === false) this.abortQueue(); // 照 Jupyter:一格出错(或被中断),后面排着的不再跑
        this.pump();
      }
      return;
    }
    this.push({ ...rest, cell });
  }

  /** Queue cells for execution, in order. Returns the cells accepted. */
  exec(cells: Array<{ cell: string; code: string }>): string[] {
    this.lastTouch = Date.now();
    for (const c of cells) {
      const ex: Exec = { id: `e${++this.counter}`, cell: c.cell, code: c.code };
      this.execCells.set(ex.id, ex.cell);
      this.queue.push(ex);
      this.push({ t: 'queued', cell: ex.cell });
    }
    this.pump();
    return cells.map((c) => c.cell);
  }

  private pump(): void {
    if (this.current || !this.proc || this.state !== 'idle') return;
    const ex = this.queue.shift();
    if (!ex) return;
    this.current = ex; this.state = 'busy';
    this.push({ t: 'start', cell: ex.cell });
    this.send({ op: 'exec', id: ex.id, code: ex.code });
  }

  private send(obj: unknown): void {
    try { this.proc?.stdin?.write(JSON.stringify(obj) + '\n'); } catch { /* the exit handler reports it */ }
  }

  interrupt(): void {
    this.lastTouch = Date.now();
    if (!this.proc || !this.current) { this.abortQueue(); return; }
    this.send({ op: 'interrupt' });
    // 进程卡在系统调用里(sleep、等网络)时,带内的中断要等它返回才生效;类 Unix 上再补一个真信号。
    // 像终端里按 Ctrl-C 一样发给整个进程组:`!cmd` 和代码里起的子进程也一起停。
    if (process.platform !== 'win32') killTree(this.proc, 'SIGINT');
  }

  private abortQueue(): void {
    const q = this.queue; this.queue = [];
    for (const ex of q) this.push({ t: 'done', cell: ex.cell, ok: false, aborted: true, n: null, ms: 0 });
  }

  private abortAll(ename: string, evalue: string): void {
    if (this.current) {
      this.push({ t: 'error', cell: this.current.cell, ename, evalue, traceback: [evalue] });
      this.push({ t: 'done', cell: this.current.cell, ok: false, died: true, n: null, ms: 0 });
      this.current = null;
    }
    this.abortQueue();
  }

  /** Kill the process. `restart` keeps the event log so pollers see the hand-over. */
  stop(why: 'restart' | 'shutdown'): void {
    this.generation++; this.epoch++;
    this.cancelLaunch?.(); this.cancelLaunch = null;
    const p = this.proc; this.proc = null;
    this.abortAll('KernelRestarted', why === 'restart' ? '内核重启了' : '内核关闭了');
    if (p) {
      if (process.platform === 'win32') {
        // taskkill must enumerate descendants while the parent is alive. Ending stdin or
        // p.kill() first loses the tree and leaves notebook subprocesses orphaned.
        killTree(p, 'SIGKILL');
      } else {
        try { p.stdin?.end(); } catch { /* gone */ }
        killTree(p, 'SIGTERM');
        setTimeout(() => killTree(p, 'SIGKILL'), 1500).unref?.();
      }
    }
    this.state = 'dead'; this.python = null; this.execCells.clear();
    if (why === 'shutdown') { this.error = undefined; this.fellBack = undefined; }
    this.push({ t: 'status' });
  }

  private push(ev: Omit<KernelEvent, 'seq'>): void {
    const full = { ...ev, seq: ++this.seq } as KernelEvent;
    const size = approxSize(full);
    this.events.push(full); this.bytes += size;
    while (this.events.length > MAX_EVENTS || (this.bytes > MAX_BYTES && this.events.length > 50)) {
      this.bytes -= approxSize(this.events.shift()!);
    }
    this.wake();
  }

  private wake(): void {
    const w = [...this.waiters]; this.waiters.clear();
    for (const f of w) f();
  }

  /** Events after `since`. Waits up to `waitMs` when there are none yet. `gap` = the cursor fell off the log. */
  async poll(since: number, waitMs: number, page = true): Promise<{ events: KernelEvent[]; gap: boolean } & KernelStatus> {
    this.lastTouch = Date.now();
    if (page) this.lastPagePoll = Date.now();
    if (since > this.seq) since = 0; // the engine restarted under an old cursor
    if (this.seq <= since && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); };
        const t = setTimeout(done, Math.min(waitMs, 15_000));
        this.waiters.add(done);
      });
    }
    const first = this.events[0]?.seq ?? this.seq + 1;
    const events = this.events.filter((e) => e.seq > since);
    if (events.length) this.delivered = Math.max(this.delivered, events[events.length - 1].seq);
    return { events, gap: since > 0 && since + 1 < first, ...this.status() };
  }
}

/** Signal the runner and everything it started. POSIX: its process group; Windows: taskkill /T for the hard kill. */
function killTree(p: ChildProcess, sig: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void {
  try {
    if (process.platform !== 'win32') { if (p.pid) process.kill(-p.pid, sig); return; }
    if (sig === 'SIGKILL' && p.pid && p.exitCode === null && p.signalCode === null) {
      const fallback = () => {
        if (p.exitCode !== null || p.signalCode !== null) return;
        try { p.stdin?.end(); } catch { /* gone */ }
        try { p.kill('SIGKILL'); } catch { /* gone */ }
      };
      // A selected environment may have a minimal PATH. The tree killer belongs to
      // Windows, not that Python environment; resolve it independently of PATH.
      const taskkill = join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'taskkill.exe');
      spawn(taskkill, ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        .on('error', fallback).on('exit', code => { if (code !== 0) fallback(); });
    }
    else p.kill(sig);
  } catch { try { p.kill(sig); } catch { /* gone */ } }
}

function approxSize(ev: KernelEvent): number {
  let n = 200;
  if (typeof ev.text === 'string') n += ev.text.length;
  const data = ev.data as Record<string, unknown> | undefined;
  if (data) for (const v of Object.values(data)) n += typeof v === 'string' ? v.length : 200;
  return n;
}
