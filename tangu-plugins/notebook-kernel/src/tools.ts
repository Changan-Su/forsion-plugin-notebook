/**
 * Tangu's side of the notebook: read cells with their outputs, edit a cell, run cells.
 * Runs share the notebook's live kernel with the page (same process, same variables). Who writes the
 * outputs into the .ipynb: the page when it is following this kernel (it does so for its own runs
 * anyway), otherwise this module — never both.
 * The file format code is the renderer's own (`src/nb.ts`, DOM-free), bundled into this plugin.
 */
import type { ToolDef, ToolContext } from '@forsion/tangu-agent';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { OutputSink, ids, joined, newCell, parse, serialize, setSource, source, stripAnsi, type Cell, type Notebook, type RunEvent } from '../../../src/nb.js';
import type { Kernel } from './kernels.js';

export interface ToolHost {
  /** The live kernel for this user's notebook, started on the interpreter the page last asked for (bundled otherwise). */
  kernel(userId: string, nb: string): Promise<Kernel>;
}

const MAX_OUT = 6000;
const clip = (s: string): string => s.length <= MAX_OUT ? s : `… (${s.length - MAX_OUT} earlier characters omitted)\n${s.slice(-MAX_OUT)}`;

function pathOf(args: Record<string, any>, ctx: ToolContext): string {
  const raw = typeof args.path === 'string' ? args.path.trim() : '';
  const p = raw && (isAbsolute(raw) ? resolve(raw) : ctx.cwd ? resolve(ctx.cwd, raw) : '');
  if (!p || !/\.ipynb$/i.test(p)) throw new Error('path must point to an .ipynb file (absolute, or relative to the working directory)');
  return p;
}

async function load(p: string): Promise<{ nb: Notebook; changed: boolean }> {
  return parse(await readFile(p, 'utf8'));
}
/** Write through a temp file so a crash never leaves half a notebook behind. */
async function store(p: string, nb: Notebook): Promise<void> {
  const tmp = `${p}.tmp-${process.pid}`;
  await writeFile(tmp, serialize(nb), 'utf8');
  await rename(tmp, p);
}

/** A cell by its id, or by its 1-based position. */
function find(nb: Notebook, ref: unknown): number {
  const s = String(ref ?? '').trim();
  const byId = nb.cells.findIndex((c) => c.id === s);
  if (byId >= 0) return byId;
  return /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= nb.cells.length ? Number(s) - 1 : -1;
}

function outputsText(c: Cell): string {
  const parts: string[] = [];
  for (const o of c.outputs ?? []) {
    if (o.output_type === 'stream') parts.push(stripAnsi(joined(o.text)));
    else if (o.output_type === 'error') parts.push(`${o.ename}: ${o.evalue}\n${(o.traceback ?? []).map(stripAnsi).join('\n').split('\n').slice(-14).join('\n')}`);
    else if (o.data) {
      const kinds = Object.keys(o.data).filter((k) => k !== 'text/plain');
      const plain = stripAnsi(joined(o.data['text/plain']));
      parts.push(`${kinds.length ? `[${kinds.join(', ')} output]\n` : ''}${plain}`);
    }
  }
  return clip(parts.join('\n').trim());
}

function cellText(c: Cell, i: number): string {
  const head = `[${i + 1}] ${c.cell_type} id=${c.id}${c.cell_type === 'code' && c.execution_count != null ? ` In[${c.execution_count}]` : ''}`;
  const out = c.cell_type === 'code' ? outputsText(c) : '';
  return `${head}\n${source(c)}${out ? `\n--- output ---\n${out}` : ''}`;
}

/** Follow the kernel until every one of these cells reported `done`, folding events into the cells' outputs. */
async function collect(k: Kernel, since: number, cells: Cell[]): Promise<void> {
  const sinks = new Map(cells.map((c) => [c.id!, new OutputSink(c)]));
  const pending = new Set(sinks.keys());
  const started = new Set<string>();
  while (pending.size) {
    const r = await k.poll(since, 10_000, false);
    for (const ev of r.events as (RunEvent & { seq: number })[]) {
      since = ev.seq;
      const sink = ev.cell ? sinks.get(ev.cell) : undefined;
      if (!sink || !pending.has(ev.cell!)) continue;
      if (ev.t === 'start') { sink.begin(); started.add(ev.cell!); }
      else if (ev.t === 'done') { if (started.has(ev.cell!)) sink.finish(ev.n); pending.delete(ev.cell!); }
      else if (started.has(ev.cell!)) sink.apply(ev);
    }
    if (r.gap) since = Math.max(since, r.head);
    if (r.state === 'dead' && !r.events.length) break;
  }
}

export function notebookTools(host: ToolHost): ToolDef[] {
  const fail = (e: unknown): string => `Error: ${e instanceof Error ? e.message : String(e)}`;
  const common = {
    mode: 'host' as const,
    isEnabledFor: (profile: { capabilities: { hostExec: boolean } }) => profile.capabilities.hostExec,
  };
  return [
    {
      ...common,
      name: 'notebook_read',
      definition: { type: 'function', function: {
        name: 'notebook_read',
        description: 'Read a Jupyter notebook (.ipynb) as text: every cell with its position, id, type, source and the text of its saved outputs (images and rich outputs are listed by type). Pass `cell` to read just one cell. Use this instead of reading the .ipynb file as raw JSON. The text returned is not the file\'s raw text (on disk a notebook is JSON), so edit_file, write_file and apply_patch do not work on it: change cells with notebook_edit and execute them with notebook_run.',
        parameters: { type: 'object', properties: {
          path: { type: 'string', description: 'Path to the .ipynb file, absolute or relative to the working directory.' },
          cell: { type: 'string', description: 'Optional. A cell id, or its 1-based position, to read only that cell.' },
        }, required: ['path'] },
      } } as any,
      capabilities: { sideEffect: 'read', parallel: true },
      async execute(args, ctx) {
        try {
          const p = pathOf(args, ctx);
          const { nb } = await load(p);
          if (args.cell != null && String(args.cell).trim()) {
            const i = find(nb, args.cell);
            return i < 0 ? `Error: no cell "${args.cell}" (the notebook has ${nb.cells.length} cells)` : cellText(nb.cells[i], i);
          }
          // 真模型实测(2026-10-12,3 次里 1 次):读完之后先拿通用的 edit_file 去改 .ipynb,用的是这里显示的源码 —— 那不是文件里的原文。
          // 所以在它决定下一步的那一刻(读的结果里)再说一遍该用哪件工具。
          return `${p} — ${nb.cells.length} cells (to change a cell use notebook_edit, to run use notebook_run; the file on disk is JSON, do not edit it with edit_file / write_file)\n\n${nb.cells.map(cellText).join('\n\n')}`;
        } catch (e) { return fail(e); }
      },
    },
    {
      ...common,
      name: 'notebook_edit',
      definition: { type: 'function', function: {
        name: 'notebook_edit',
        description: 'Change a Jupyter notebook (.ipynb), one cell at a time. This is the tool for editing notebooks: never use edit_file, write_file or apply_patch on an .ipynb. `replace` sets a cell\'s source (its saved outputs are cleared), `insert` adds a new cell after the given cell (or at the top when `cell` is omitted), `delete` removes a cell. Everything else in the file is left as it is. The open notebook page reloads by itself. This does not run anything: call notebook_run afterwards to execute.',
        parameters: { type: 'object', properties: {
          path: { type: 'string', description: 'Path to the .ipynb file, absolute or relative to the working directory.' },
          action: { type: 'string', enum: ['replace', 'insert', 'delete'] },
          cell: { type: 'string', description: 'A cell id or 1-based position. Required for replace and delete; for insert, the new cell goes after it.' },
          source: { type: 'string', description: 'The full new source of the cell (replace, insert).' },
          cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Type of the inserted cell. Defaults to code.' },
        }, required: ['path', 'action'] },
      } } as any,
      capabilities: { sideEffect: 'write', approval: 'command', concurrencyKey: 'notebook' },
      async execute(args, ctx) {
        try {
          const p = pathOf(args, ctx);
          const { nb } = await load(p);
          const action = String(args.action);
          const at = args.cell != null && String(args.cell).trim() ? find(nb, args.cell) : -1;
          if (action !== 'insert' && at < 0) return `Error: no cell "${args.cell ?? ''}" (the notebook has ${nb.cells.length} cells)`;
          if (action === 'insert' && args.cell != null && String(args.cell).trim() && at < 0) return `Error: no cell "${args.cell}"`;
          if (action !== 'delete' && typeof args.source !== 'string') return 'Error: source is required';
          let touched: Cell | null = null;
          if (action === 'replace') {
            touched = nb.cells[at];
            setSource(touched, args.source);
            if (touched.cell_type === 'code') { touched.outputs = []; touched.execution_count = null; }
          } else if (action === 'insert') {
            touched = newCell(args.cell_type === 'markdown' ? 'markdown' : 'code', ids(nb), args.source);
            nb.cells.splice(at + 1, 0, touched);
          } else if (action === 'delete') {
            nb.cells.splice(at, 1);
            if (!nb.cells.length) nb.cells.push(newCell('code', new Set()));
          } else return 'Error: action must be replace, insert or delete';
          await store(p, nb);
          return touched ? `Done. Cell ${nb.cells.indexOf(touched) + 1} id=${touched.id} (${touched.cell_type}). The notebook now has ${nb.cells.length} cells.` : `Deleted. The notebook now has ${nb.cells.length} cells.`;
        } catch (e) { return fail(e); }
      },
    },
    {
      ...common,
      name: 'notebook_run',
      definition: { type: 'function', function: {
        name: 'notebook_run',
        description: 'Run code cells of a Jupyter notebook (.ipynb) in its live Python kernel and return their outputs. Variables persist between runs and are shared with the notebook page the user has open. Pass `cell` (an id or 1-based position) to run one cell, or "all" to run every code cell from the top; a failing cell stops the cells after it. Outputs are saved into the notebook. Cells still running after `timeout_seconds` keep running in the kernel; read the notebook later to see their result.',
        parameters: { type: 'object', properties: {
          path: { type: 'string', description: 'Path to the .ipynb file, absolute or relative to the working directory.' },
          cell: { type: 'string', description: 'A cell id, its 1-based position, or "all".' },
          timeout_seconds: { type: 'number', description: 'How long to wait for the result. Default 120, max 900.' },
        }, required: ['path', 'cell'] },
      } } as any,
      capabilities: { sideEffect: 'system', approval: 'command', concurrencyKey: 'notebook', defaultTimeoutMs: 960_000 },
      async execute(args, ctx) {
        try {
          const p = pathOf(args, ctx);
          const { nb, changed } = await load(p);
          // 老文件的格子 id 是读的时候才补的:先落盘,页面和这里才认得同一批格子。
          if (changed) await store(p, nb);
          const all = String(args.cell).trim().toLowerCase() === 'all';
          const at = all ? -1 : find(nb, args.cell);
          if (!all && at < 0) return `Error: no cell "${args.cell}" (the notebook has ${nb.cells.length} cells)`;
          const cells = (all ? nb.cells : [nb.cells[at]]).filter((c) => c.cell_type === 'code' && source(c).trim());
          if (!cells.length) return 'Nothing to run: no code in the selected cell(s).';
          const k = await host.kernel(ctx.userId, p);
          const st = k.status();
          if (st.state === 'dead') return `Error: Python could not start: ${st.error ?? 'unknown reason'}`;
          // 谁把输出写进文件,在开跑那一刻定下:页面那时正跟着这个内核,它会收到「开始」并照常落盘;
          // 否则由这里写(页面中途才接上的话,它没见过这几格的「开始」,不会去写)。
          const pageWrites = k.attached();
          k.exec(cells.map((c) => ({ cell: c.id!, code: source(c) })));
          const finished = collect(k, st.head, cells).then(async () => {
            if (pageWrites) return;
            // 重新读一遍文件,只换这几格的输出(这期间别处的改动原样留着)。
            const disk = await load(p);
            for (const c of cells) {
              const d = disk.nb.cells.find((x) => x.id === c.id);
              if (d && d.cell_type === 'code') { d.outputs = c.outputs; d.execution_count = c.execution_count; }
            }
            await store(p, disk.nb);
          });
          const waitMs = Math.max(1, Math.min(Number(args.timeout_seconds) || 120, 900)) * 1000;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const late = await Promise.race([finished.then(() => false), new Promise<boolean>((r) => { timer = setTimeout(() => r(true), waitMs); ctx.signal?.addEventListener('abort', () => r(true), { once: true }); })]);
          clearTimeout(timer);
          finished.catch(() => {});
          const py = k.status().python;
          const text = cells.map((c) => cellText(c, nb.cells.indexOf(c))).join('\n\n');
          return `${late ? 'Still running after the wait; the kernel keeps going and the outputs are saved when it finishes. Partial result so far:\n\n' : ''}${text}\n\n(Python ${py?.version ?? '?'} — ${py?.kind === 'bundled' ? 'bundled with Forsion' : py?.path ?? ''})`;
        } catch (e) { return fail(e); }
      },
    },
  ];
}
