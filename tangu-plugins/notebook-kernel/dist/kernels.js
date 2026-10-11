/**
 * One Python process per open notebook (keyed by user + absolute notebook path).
 * The process is python/runner.py; this file owns its lifecycle, the run queue and an event log
 * the renderer reads by polling (`since` cursor), because the host transport is request/response JSON.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
const MAX_EVENTS = 4000;
const MAX_BYTES = 48 * 1024 * 1024;
const READY_TIMEOUT_MS = 30_000;
export class Kernel {
    nb;
    pythonDir;
    bundled;
    log;
    proc = null;
    events = [];
    bytes = 0;
    seq = 0;
    /** highest seq any poller has been handed; stream text is only merged into events nobody has seen yet */
    delivered = 0;
    queue = [];
    current = null;
    execCells = new Map();
    waiters = new Set();
    counter = 0;
    state = 'dead';
    python = null;
    fellBack;
    error;
    starting = null;
    generation = 0;
    lastTouch = Date.now();
    constructor(nb, pythonDir, bundled, log) {
        this.nb = nb;
        this.pythonDir = pythonDir;
        this.bundled = bundled;
        this.log = log;
    }
    status() {
        return {
            state: this.state, python: this.python, fellBack: this.fellBack, error: this.error,
            current: this.current?.cell ?? null, queue: this.queue.map((e) => e.cell), head: this.seq,
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
        if (same && !opts.restart && this.state !== 'dead')
            return this.status();
        this.stop('restart');
        this.fellBack = undefined;
        this.error = undefined;
        this.starting = (async () => {
            if (!target) {
                this.fail('没有可用的 Python:自带的那份不在,系统里也没找到 python3');
                return;
            }
            const first = await this.launch(target);
            if (first === true)
                return;
            if (this.bundled && target.path !== this.bundled.path) {
                // 用户选的那个起不来:退回自带的,并把原因带给界面。
                this.log(`interpreter ${target.path} failed (${first}); falling back to bundled`);
                const second = await this.launch(this.bundled);
                if (second === true) {
                    this.fellBack = { wanted: target.label || target.path, reason: first };
                    this.push({ t: 'status' });
                    return;
                }
                this.fail(second);
                return;
            }
            this.fail(first);
        })();
        try {
            await this.starting;
        }
        finally {
            this.starting = null;
        }
        return this.status();
    }
    fail(reason) {
        this.state = 'dead';
        this.error = reason;
        this.python = null;
        this.push({ t: 'status' });
    }
    /** Spawn the runner on one interpreter; true when it reported ready, otherwise a short reason. */
    launch(env) {
        return new Promise((resolve) => {
            const runner = join(this.pythonDir, 'runner.py');
            if (!existsSync(runner)) {
                resolve('runner.py 不在插件目录里');
                return;
            }
            const penv = {
                ...process.env,
                FORSION_NB_VENDOR: join(this.pythonDir, 'vendor'),
                PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1',
                // 像激活了这个环境一样:笔记本里 `!python` / `!pip` 落在同一个解释器上。
                PATH: `${dirname(env.path)}${delimiter}${process.env.PATH ?? ''}`,
            };
            if (env.kind !== 'bundled') {
                delete penv.PYTHONHOME;
                delete penv.PYTHONPATH;
                delete penv.PYTHONNOUSERSITE;
            }
            const gen = ++this.generation;
            let settled = false;
            let buf = '';
            let diag = '';
            this.state = 'starting';
            let proc;
            try {
                proc = spawn(env.path, [runner], { cwd: dirname(this.nb), env: penv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            }
            catch (e) {
                resolve(`起不来:${e.message}`);
                return;
            }
            this.proc = proc;
            const finish = (r) => { if (settled)
                return; settled = true; clearTimeout(timer); resolve(r); };
            const timer = setTimeout(() => { if (!settled) {
                try {
                    proc.kill();
                }
                catch { /* gone */ }
                finish('30 秒内没有就绪');
            } }, READY_TIMEOUT_MS);
            proc.stdout.setEncoding('utf8');
            proc.stdout.on('data', (chunk) => {
                buf += chunk;
                let i;
                while ((i = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, i);
                    buf = buf.slice(i + 1);
                    let ev;
                    try {
                        ev = JSON.parse(line);
                    }
                    catch {
                        continue;
                    }
                    if (gen !== this.generation)
                        return;
                    if (ev.t === 'ready') {
                        this.python = { path: env.path, label: env.label, kind: env.kind, version: ev.python, ipython: ev.ipython, vendored: !!ev.vendored };
                        this.state = 'idle';
                        this.push({ t: 'status' });
                        finish(true);
                        this.pump();
                    }
                    else if (ev.t === 'fatal') {
                        finish(ev.reason === 'no-ipython' ? `这个环境里没有 IPython,插件带的那份也装不上(Python ${ev.python ?? '?'})` : String(ev.detail ?? ev.reason));
                    }
                    else
                        this.onRunnerEvent(ev);
                }
            });
            proc.stderr.setEncoding('utf8');
            proc.stderr.on('data', (c) => { diag = (diag + c).slice(-2000); });
            proc.on('error', (e) => finish(`起不来:${e.message}`));
            proc.on('exit', (code, signal) => {
                if (gen !== this.generation)
                    return;
                this.proc = null;
                if (!settled) {
                    finish(diag.trim().split('\n').pop() || `进程退出了(${signal ?? code})`);
                    return;
                }
                // 运行中途死掉:把正在跑的和排队的都收尾,界面才不会一直转圈。
                const reason = `Python 进程退出了(${signal ?? code})`;
                this.abortAll('KernelDied', reason);
                this.state = 'dead';
                this.error = reason;
                this.python = null;
                this.push({ t: 'status' });
            });
        });
    }
    onRunnerEvent(ev) {
        const cell = ev.id ? this.execCells.get(ev.id) : undefined;
        if (!cell)
            return; // output with no cell to attach to (before the first run, or a restart in between)
        const { id: _id, ...rest } = ev;
        if (ev.t === 'stream') {
            const text = String(ev.text ?? '').replace(/\r\n/g, '\n');
            const last = this.events[this.events.length - 1];
            if (last && last.seq > this.delivered && last.t === 'stream' && last.cell === cell && last.name === ev.name) {
                last.text = String(last.text) + text;
                this.bytes += text.length;
                this.wake();
            }
            else
                this.push({ t: 'stream', cell, name: ev.name, text });
            return;
        }
        if (ev.t === 'done') {
            const { vars, ...done } = rest;
            this.push({ ...done, cell, vars });
            if (this.current && this.current.id === ev.id) {
                this.current = null;
                this.state = 'idle';
                if (ev.ok === false)
                    this.abortQueue(); // 照 Jupyter:一格出错(或被中断),后面排着的不再跑
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
            this.push({ t: 'queued', cell: ex.cell });
        }
        this.pump();
        return cells.map((c) => c.cell);
    }
    pump() {
        if (this.current || !this.proc || this.state !== 'idle')
            return;
        const ex = this.queue.shift();
        if (!ex)
            return;
        this.current = ex;
        this.state = 'busy';
        this.push({ t: 'start', cell: ex.cell });
        this.send({ op: 'exec', id: ex.id, code: ex.code });
    }
    send(obj) {
        try {
            this.proc?.stdin?.write(JSON.stringify(obj) + '\n');
        }
        catch { /* the exit handler reports it */ }
    }
    interrupt() {
        this.lastTouch = Date.now();
        if (!this.proc || !this.current) {
            this.abortQueue();
            return;
        }
        this.send({ op: 'interrupt' });
        // 进程卡在系统调用里(sleep、等网络)时,带内的中断要等它返回才生效;类 Unix 上再补一个真信号。
        if (process.platform !== 'win32') {
            try {
                this.proc.kill('SIGINT');
            }
            catch { /* gone */ }
        }
    }
    abortQueue() {
        const q = this.queue;
        this.queue = [];
        for (const ex of q)
            this.push({ t: 'done', cell: ex.cell, ok: false, aborted: true, n: null, ms: 0 });
    }
    abortAll(ename, evalue) {
        if (this.current) {
            this.push({ t: 'error', cell: this.current.cell, ename, evalue, traceback: [evalue] });
            this.push({ t: 'done', cell: this.current.cell, ok: false, died: true, n: null, ms: 0 });
            this.current = null;
        }
        this.abortQueue();
    }
    /** Kill the process. `restart` keeps the event log so pollers see the hand-over. */
    stop(why) {
        this.generation++;
        const p = this.proc;
        this.proc = null;
        this.abortAll('KernelRestarted', why === 'restart' ? '内核重启了' : '内核关闭了');
        if (p) {
            try {
                p.stdin?.end();
            }
            catch { /* gone */ }
            const t = setTimeout(() => { try {
                p.kill('SIGKILL');
            }
            catch { /* gone */ } }, 1500);
            p.once('exit', () => clearTimeout(t));
            try {
                p.kill();
            }
            catch { /* gone */ }
        }
        this.state = 'dead';
        this.python = null;
        this.execCells.clear();
        if (why === 'shutdown') {
            this.error = undefined;
            this.fellBack = undefined;
        }
        this.push({ t: 'status' });
    }
    push(ev) {
        const full = { ...ev, seq: ++this.seq };
        const size = approxSize(full);
        this.events.push(full);
        this.bytes += size;
        while (this.events.length > MAX_EVENTS || (this.bytes > MAX_BYTES && this.events.length > 50)) {
            this.bytes -= approxSize(this.events.shift());
        }
        this.wake();
    }
    wake() {
        const w = [...this.waiters];
        this.waiters.clear();
        for (const f of w)
            f();
    }
    /** Events after `since`. Waits up to `waitMs` when there are none yet. `gap` = the cursor fell off the log. */
    async poll(since, waitMs) {
        this.lastTouch = Date.now();
        if (since > this.seq)
            since = 0; // the engine restarted under an old cursor
        if (this.seq <= since && waitMs > 0) {
            await new Promise((resolve) => {
                const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); };
                const t = setTimeout(done, Math.min(waitMs, 15_000));
                this.waiters.add(done);
            });
        }
        const first = this.events[0]?.seq ?? this.seq + 1;
        const events = this.events.filter((e) => e.seq > since);
        if (events.length)
            this.delivered = Math.max(this.delivered, events[events.length - 1].seq);
        return { events, gap: since > 0 && since + 1 < first, ...this.status() };
    }
}
function approxSize(ev) {
    let n = 200;
    if (typeof ev.text === 'string')
        n += ev.text.length;
    const data = ev.data;
    if (data)
        for (const v of Object.values(data))
            n += typeof v === 'string' ? v.length : 200;
    return n;
}
//# sourceMappingURL=kernels.js.map