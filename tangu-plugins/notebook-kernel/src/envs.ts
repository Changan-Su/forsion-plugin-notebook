/**
 * Find the Python interpreters a notebook could run on: the one shipped with Forsion (the fallback),
 * virtualenvs next to the notebook, conda environments, pyenv versions and what is on PATH.
 * Each candidate is asked for its version once (cached); anything older than 3.10 is listed but not usable.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

export interface EnvInfo {
  /** absolute path of the interpreter; also its identity */
  path: string;
  label: string;
  kind: 'bundled' | 'venv' | 'conda' | 'pyenv' | 'system' | 'custom';
  /** where it lives, for the menu's right-hand hint */
  hint?: string;
  version?: string;
  /** false = listed but cannot be picked (`why` says which) */
  ok: boolean;
  why?: 'old' | 'broken';
}

const WIN = process.platform === 'win32';
const MIN = [3, 10];
const versions = new Map<string, { at: number; version: string | null }>();

const pyIn = (envDir: string): string => (WIN ? join(envDir, 'python.exe') : join(envDir, 'bin', 'python'));
const venvPy = (envDir: string): string => (WIN ? join(envDir, 'Scripts', 'python.exe') : join(envDir, 'bin', 'python'));

function real(p: string): string { try { return realpathSync(p); } catch { return p; } }

/** The interpreter Forsion ships. The desktop passes its path to the engine; a CLI engine has none. */
export function bundledPython(): EnvInfo | null {
  const p = process.env.TANGU_PYTHON_BIN;
  return p && existsSync(p) ? { path: p, label: 'Forsion', kind: 'bundled', ok: true } : null;
}

function askVersion(py: string): Promise<string | null> {
  const hit = versions.get(py);
  if (hit && Date.now() - hit.at < 120_000) return Promise.resolve(hit.version);
  return new Promise((resolve) => {
    const env = { ...process.env }; delete env.PYTHONHOME; delete env.PYTHONPATH;
    execFile(py, ['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], { timeout: 4000, windowsHide: true, env }, (err, stdout) => {
      const v = !err && /^\d+\.\d+\.\d+/.test(stdout.trim()) ? stdout.trim() : null;
      versions.set(py, { at: Date.now(), version: v });
      resolve(v);
    });
  });
}

function candidates(nbDir: string): Array<Omit<EnvInfo, 'ok'>> {
  const out: Array<Omit<EnvInfo, 'ok'>> = [];
  const home = homedir();
  // 笔记本所在文件夹往上三层里的虚拟环境
  let dir = nbDir;
  for (let i = 0; i < 4 && dir && dir !== dirname(dir); i++, dir = dirname(dir)) {
    for (const name of ['.venv', 'venv', 'env']) {
      const py = venvPy(join(dir, name));
      if (existsSync(py)) out.push({ path: py, label: name, kind: 'venv', hint: i === 0 ? '' : basename(dir) });
    }
  }
  // conda:它自己记了一份全部环境的清单;再补常见的安装位置
  const condaRoots = new Set<string>();
  try {
    for (const line of readFileSync(join(home, '.conda', 'environments.txt'), 'utf8').split(/\r?\n/)) if (line.trim()) condaRoots.add(line.trim());
  } catch { /* no conda */ }
  for (const base of ['miniconda3', 'anaconda3', 'miniforge3', 'mambaforge', join('opt', 'anaconda3'), join('opt', 'miniconda3')].map((n) => join(home, n)).concat(WIN ? [] : ['/opt/anaconda3', '/opt/miniconda3', '/opt/homebrew/Caskroom/miniconda/base', '/opt/homebrew/Caskroom/miniforge/base'])) {
    if (!existsSync(base)) continue;
    condaRoots.add(base);
    try { for (const n of readdirSync(join(base, 'envs'))) condaRoots.add(join(base, 'envs', n)); } catch { /* no envs */ }
  }
  try { for (const n of readdirSync(join(home, '.conda', 'envs'))) condaRoots.add(join(home, '.conda', 'envs', n)); } catch { /* none */ }
  for (const root of condaRoots) {
    const py = pyIn(root);
    if (existsSync(py)) out.push({ path: py, label: basename(dirname(root)) === 'envs' ? basename(root) : 'base', kind: 'conda' });
  }
  // pyenv
  try {
    for (const n of readdirSync(join(home, '.pyenv', 'versions'))) {
      const py = join(home, '.pyenv', 'versions', n, 'bin', 'python');
      if (existsSync(py)) out.push({ path: py, label: n, kind: 'pyenv' });
    }
  } catch { /* none */ }
  // PATH 上的 python3 / python
  const bundled = process.env.TANGU_PYTHON_BIN ? dirname(process.env.TANGU_PYTHON_BIN) : '';
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    if (!d || d === bundled) continue;
    for (const name of WIN ? ['python.exe'] : ['python3', 'python']) {
      const py = join(d, name);
      if (!existsSync(py)) continue;
      // macOS 的 /usr/bin/python3 在没装命令行工具时是个桩,一执行就弹系统的安装对话框:没装就不碰它。
      if (py === '/usr/bin/python3' && !existsSync('/Library/Developer/CommandLineTools/usr/bin/python3') && !existsSync('/Applications/Xcode.app')) continue;
      if (WIN && /WindowsApps/i.test(py)) continue; // 应用商店的占位程序,一执行就打开商店
      out.push({ path: py, label: name.replace(/\.exe$/, ''), kind: 'system', hint: d });
      break;
    }
  }
  return out;
}

export async function listEnvs(nbDir: string): Promise<EnvInfo[]> {
  const seen = new Set<string>();
  const list: Array<Omit<EnvInfo, 'ok'>> = [];
  const b = bundledPython();
  if (b) seen.add(real(b.path));
  for (const c of candidates(nbDir)) {
    const key = real(c.path);
    if (seen.has(key)) continue;
    seen.add(key); list.push(c);
    if (list.length >= 24) break;
  }
  const checked = await Promise.all(list.map(async (c) => describe(c)));
  // 自带的排最后:它是兜底
  return b ? [...checked, { ...b, version: (await askVersion(b.path)) ?? undefined }] : checked;
}

async function describe(c: Omit<EnvInfo, 'ok'>): Promise<EnvInfo> {
  const version = await askVersion(c.path);
  if (!version) return { ...c, ok: false, why: 'broken' };
  const [maj, min] = version.split('.').map(Number);
  const ok = maj > MIN[0] || (maj === MIN[0] && min >= MIN[1]);
  return { ...c, version, ok, ...(ok ? {} : { why: 'old' as const }) };
}

/** Resolve an interpreter path the renderer remembered (or the user typed) into something launchable. */
export async function resolveEnv(path: string, nbDir: string): Promise<EnvInfo | null> {
  if (!path) return null;
  const b = bundledPython();
  if (b && real(b.path) === real(path)) return b;
  if (!existsSync(path)) return null;
  const known = candidates(nbDir).find((c) => real(c.path) === real(path));
  const info = await describe(known ?? { path, label: basename(dirname(dirname(path))) || basename(path), kind: 'custom' });
  return info.ok ? info : null;
}
