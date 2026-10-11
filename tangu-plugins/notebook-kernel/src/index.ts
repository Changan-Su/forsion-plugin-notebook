/**
 * Notebook kernel: the half of the notebook plugin that can start processes.
 * The renderer half (the .ipynb view) talks to these routes through the host
 * (`ctx.tangu.request('notebook-kernel', '/…')`): the host authenticates the user, pins the
 * route prefix to this bundle and refuses remote callers, so everything here is local-only.
 */
import type { TanguPlugin, PluginMeta, TanguPluginContext } from '@forsion/tangu-agent';
import { isAbsolute, dirname, join, normalize } from 'node:path';
import { Kernel } from './kernels.js';
import { bundledPython, listEnvs, resolveEnv } from './envs.js';
import { notebookTools } from './tools.js';

const ID = 'notebook-kernel';
const kernels = new Map<string, Kernel>();
let reaper: ReturnType<typeof setInterval> | null = null;

function stopAll(): void {
  for (const k of kernels.values()) k.stop('shutdown');
  kernels.clear();
  if (reaper) { clearInterval(reaper); reaper = null; }
}

const plugin: TanguPlugin = {
  activate(ctx: TanguPluginContext) {
    const pythonDir = join(ctx.paths.pluginDir, 'python');
    const keyOf = (userId: string, nb: string): string => `${userId}\n${nb}`;
    /** Validate the notebook path from the request body: absolute, normalised, an .ipynb. */
    const nbOf = (req: any, res: any): { nb: string; userId: string } | null => {
      const raw = req.body?.nb; const userId = req.user?.userId;
      if (!userId) { res.status(401).json({ detail: 'no user' }); return null; }
      if (typeof raw !== 'string' || !isAbsolute(raw) || !/\.ipynb$/i.test(raw)) { res.status(400).json({ detail: 'nb must be an absolute .ipynb path' }); return null; }
      return { nb: normalize(raw), userId: String(userId) };
    };
    const get = (userId: string, nb: string, create: boolean): Kernel | null => {
      const key = keyOf(userId, nb);
      let k = kernels.get(key);
      if (!k && create) { k = new Kernel(nb, pythonDir, bundledPython(), (m) => ctx.log(m)); kernels.set(key, k); }
      return k ?? null;
    };
    const guard = (fn: (req: any, res: any) => Promise<void> | void) => async (req: any, res: any) => {
      try { await fn(req, res); } catch (e) { ctx.log(`route failed: ${(e as Error).stack ?? e}`); if (!res.headersSent) res.status(500).json({ detail: String((e as Error).message ?? e) }); }
    };

    /** 页面最近一次说的「这本笔记本用哪个解释器」(只在内存里):Tangu 自己起内核时照这个来,没说过就用自带的。 */
    const preferred = new Map<string, string>();
    ctx.registerToolProvider({
      id: ID,
      tools: () => notebookTools({
        async kernel(userId, nb) {
          const k = get(userId, nb, true)!;
          if (k.status().state === 'dead') {
            const want = preferred.get(keyOf(userId, nb));
            await k.open(want ? await resolveEnv(want, dirname(nb)) : null);
          }
          return k;
        },
      }),
    });

    ctx.registerScopedRoutes((router) => {
      // 这本笔记本能用哪些 Python
      router.post('/envs', guard(async (req, res) => {
        const a = nbOf(req, res); if (!a) return;
        res.json({ envs: await listEnvs(dirname(a.nb)) });
      }));
      // 页面打开一本笔记本时来问一次:有没有已经在跑的内核(Tangu 起的、或者上次没关的),有就接上;顺便报上它记着的解释器。
      router.post('/status', guard((req, res) => {
        const a = nbOf(req, res); if (!a) return;
        const key = keyOf(a.userId, a.nb);
        if (typeof req.body.python === 'string' && req.body.python) preferred.set(key, req.body.python); else preferred.delete(key);
        const k = kernels.get(key);
        res.json(k ? k.status() : { state: 'dead', python: null, current: null, queue: [], head: 0 });
      }));
      // 起内核(或换解释器 / 重启)。python 省略 = 自带的。
      router.post('/open', guard(async (req, res) => {
        const a = nbOf(req, res); if (!a) return;
        const want = typeof req.body.python === 'string' && req.body.python ? req.body.python : '';
        if (want) preferred.set(keyOf(a.userId, a.nb), want); else preferred.delete(keyOf(a.userId, a.nb));
        const env = want ? await resolveEnv(want, dirname(a.nb)) : null;
        const k = get(a.userId, a.nb, true)!;
        const st = await k.open(env, { restart: !!req.body.restart });
        // 记着的那个解释器已经不在了(环境被删、路径变了):照样起自带的,并告诉界面。
        res.json(want && !env && !st.fellBack ? { ...st, fellBack: { wanted: want, reason: '找不到这个解释器,或者它的 Python 低于 3.10' } } : st);
      }));
      router.post('/exec', guard(async (req, res) => {
        const a = nbOf(req, res); if (!a) return;
        const cells = Array.isArray(req.body.cells) ? req.body.cells.filter((c: any) => c && typeof c.cell === 'string' && typeof c.code === 'string').slice(0, 2000) : [];
        const k = get(a.userId, a.nb, false);
        if (!k || k.status().state === 'dead') { res.status(409).json({ detail: 'kernel is not running' }); return; }
        res.json({ accepted: k.exec(cells), ...k.status() });
      }));
      router.post('/events', guard(async (req, res) => {
        const a = nbOf(req, res); if (!a) return;
        const k = get(a.userId, a.nb, false);
        if (!k) { res.json({ events: [], gap: false, state: 'dead', python: null, current: null, queue: [], head: 0 }); return; }
        res.json(await k.poll(Number(req.body.since) || 0, Math.max(0, Math.min(Number(req.body.wait) || 0, 15_000))));
      }));
      router.post('/interrupt', guard((req, res) => {
        const a = nbOf(req, res); if (!a) return;
        const k = get(a.userId, a.nb, false); k?.interrupt();
        res.json(k ? k.status() : { state: 'dead' });
      }));
      router.post('/shutdown', guard((req, res) => {
        const a = nbOf(req, res); if (!a) return;
        const key = keyOf(a.userId, a.nb); const k = kernels.get(key);
        if (k) { k.stop('shutdown'); kernels.delete(key); }
        res.json({ state: 'dead' });
      }));
    });

    // 界面没来得及关(窗口崩了、强退)的内核:两小时没人碰就收掉。
    reaper = setInterval(() => {
      const now = Date.now();
      for (const [key, k] of kernels) if (now - k.lastTouch > 2 * 3600_000 && k.status().state !== 'busy') { k.stop('shutdown'); kernels.delete(key); }
    }, 10 * 60_000);
    reaper.unref?.();

    const meta: PluginMeta = {
      id: ID,
      name: '笔记本内核',
      nameEn: 'Notebook kernel',
      description: '给 Jupyter 笔记本跑代码:为每本打开的笔记本起一个 Python 进程,可以选本机的 Python 环境,Forsion 自带的那份兜底。',
      descriptionEn: 'Runs the code in Jupyter notebooks: one Python process per open notebook, on a local Python environment you pick, with the Python shipped with Forsion as the fallback.',
      scopes: ['global'],
      defaultEnabled: true,
      settings: { fields: [] },
    };
    ctx.registerPlugin(meta);
    ctx.log(`${ID} activated (bundled python: ${bundledPython()?.path ?? 'none'})`);
  },
  deactivate() { stopAll(); },
};

export default plugin;
