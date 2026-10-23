"""Forsion notebook runner: one long-lived Python process per notebook.

Commands arrive as JSON lines on stdin; events leave as JSON lines on the original stdout.
User code never sees either pipe: fd 0 is re-pointed at /dev/null, and fds 1 / 2 are re-pointed
at pipes this process reads itself, so output from C code or child processes (`subprocess.run`,
`!cmd`) becomes `stream` events instead of corrupting the protocol.

IPython runs in-process (no ZMQ, no ipykernel): magics, `!cmd`, rich display and inline
matplotlib all come from IPython. The environment's own IPython is used when it has one;
otherwise the pure-Python copy shipped next to this file (FORSION_NB_VENDOR).

Commands:  {"op": "exec", "id": ..., "code": ...} | {"op": "interrupt"} | {"op": "vars", "id": ...} | {"op": "shutdown"}
Events:    ready | fatal | stream | display | result | error | clear | done | vars   (each carries the request "id")
"""
import _thread
import ast
import base64
import builtins
import codecs
import io
import json
import os
import queue
import signal
import sys
import threading
import time
import types
import warnings
if sys.platform == 'win32':
    from windows_shell import install as _install_windows_shell

_cmd = os.fdopen(os.dup(0), 'r', encoding='utf-8')
_out = os.fdopen(os.dup(1), 'w', encoding='utf-8')
_null = os.open(os.devnull, os.O_RDONLY)
os.dup2(_null, 0)


_lock = threading.Lock()
CUR = None   # id of the request being served
LAST = None  # id of the last exec: output from a background thread that outlives its cell still belongs to it
BUSY = False
IN_USER = False      # the cell's own code is running (between IPython's pre- and post-execution machinery)
INT_PENDING = False  # an interrupt arrived for this cell before its code started: stop it at the gate
EXECS = 0            # exec requests accepted and not finished yet (queued, starting or running)


def _send(obj):
    with _lock:
        _out.write(json.dumps(obj, ensure_ascii=False, default=str) + '\n')
        _out.flush()


def emit(obj):
    obj['id'] = CUR if CUR is not None else LAST
    _send(obj)


def _capture(fd, name):
    """Point an OS-level fd at a pipe and turn whatever is written to it into stream events."""
    r, w = os.pipe()
    os.dup2(w, fd)
    os.close(w)
    dec = codecs.getincrementaldecoder('utf-8')('replace')

    def pump():
        while True:
            try:
                chunk = os.read(r, 65536)
            except OSError:
                break
            if not chunk:
                break
            text = dec.decode(chunk)
            if text:
                emit({'t': 'stream', 'name': name, 'text': text})

    threading.Thread(target=pump, name='nb-' + name, daemon=True).start()


_capture(1, 'stdout')
_capture(2, 'stderr')


class Stream(io.TextIOBase):
    encoding = 'utf-8'

    def __init__(self, name):
        self.name = name

    def writable(self):
        return True

    def isatty(self):
        return False

    def write(self, s):
        if not isinstance(s, str):
            s = str(s)
        if s:
            emit({'t': 'stream', 'name': self.name, 'text': s})
        return len(s)


sys.stdout, sys.stderr = Stream('stdout'), Stream('stderr')
sys.stdin = open(os.devnull)
# `python runner.py` puts this file's folder first on sys.path; a notebook expects its own folder there.
sys.path[0] = os.getcwd()

# find_spec, not import: importing matplotlib_inline before the shell exists makes its backend
# skip the IPython integration for good (it checks get_ipython() once, at import).
from importlib.util import find_spec  # noqa: E402

_vendor = os.environ.get('FORSION_NB_VENDOR')
if _vendor and not (find_spec('IPython') and find_spec('matplotlib_inline')):
    sys.path.append(_vendor)
os.environ.setdefault('MPLBACKEND', 'module://matplotlib_inline.backend_inline')

try:
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        import IPython
        from IPython.core.displayhook import DisplayHook
        from IPython.core.displaypub import DisplayPublisher
        from IPython.core.interactiveshell import InteractiveShell
        from traitlets import Type
except Exception as e:  # no usable IPython here: say so and stop; the host falls back to the bundled Python
    _send({'t': 'fatal', 'reason': 'no-ipython', 'detail': repr(e)[:400], 'python': sys.version.split()[0], 'id': None})
    sys.exit(3)


def _bundle(data):
    return {k: (base64.b64encode(v).decode('ascii') if isinstance(v, (bytes, bytearray)) else v) for k, v in (data or {}).items()}


class Pub(DisplayPublisher):
    def publish(self, data, metadata=None, source=None, *, transient=None, update=False, **kwargs):
        emit({'t': 'display', 'data': _bundle(data), 'metadata': metadata or {}, 'display_id': (transient or {}).get('display_id'), 'update': bool(update)})

    def clear_output(self, wait=False):
        emit({'t': 'clear', 'wait': bool(wait)})


class Hook(DisplayHook):
    def write_output_prompt(self):
        pass

    def write_format_data(self, format_dict, md_dict=None):
        emit({'t': 'result', 'n': self.prompt_count, 'data': _bundle(format_dict), 'metadata': md_dict or {}})

    def finish_displayhook(self):
        pass


class Shell(InteractiveShell):
    display_pub_class = Type(Pub)
    displayhook_class = Type(Hook)

    def _showtraceback(self, etype, evalue, stb):
        emit({'t': 'error', 'ename': getattr(etype, '__name__', str(etype)), 'evalue': str(evalue), 'traceback': list(stb)})

    def enable_gui(self, gui=None):  # `%matplotlib inline` asks for this; there is no GUI loop here
        pass



shell = Shell.instance(colors='NoColor')
if sys.platform == 'win32':
    _install_windows_shell()
shell.system = shell.system_piped  # `!cmd` output goes through sys.stdout
# Crisp figures on HiDPI screens; the stored png carries its display size, so other tools show it the same size.
shell.config.InlineBackend.figure_formats = {'retina'}


def _input(prompt=''):
    raise RuntimeError('input() is not available in this notebook')


builtins.input = _input


# Interrupts. Both paths (the in-band request and an OS SIGINT sent to the process group) end up in this
# handler on the main thread. While the cell's own code runs it raises KeyboardInterrupt as usual. Before
# that, IPython is running its pre-execution callbacks, which swallow exceptions ("Error in callback…") and
# would then run the cell anyway: remember the interrupt instead and refuse the cell at the gate below.
# Between cells an interrupt means nothing.
def _on_sigint(signum, frame):
    global INT_PENDING
    if IN_USER:
        signal.default_int_handler(signum, frame)
    elif EXECS > 0:
        INT_PENDING = True


def _poke_main():
    """Deliver an interrupt to the main thread. A real signal aimed at that thread, so a blocking call
    (time.sleep, a socket read) wakes up at once; `interrupt_main` alone only sets a flag that is looked
    at when the call returns by itself. On Windows raise_signal also sets CPython's SIGINT event,
    which wakes time.sleep; interrupt_main alone does not set that event."""
    if hasattr(signal, 'pthread_kill'):
        signal.pthread_kill(threading.main_thread().ident, signal.SIGINT)
    elif sys.platform == 'win32':
        signal.raise_signal(signal.SIGINT)
    else:
        _thread.interrupt_main()


signal.signal(signal.SIGINT, _on_sigint)


class _Gate(ast.NodeTransformer):
    """Last stop before a cell's code is compiled and run."""

    def visit(self, node):
        global IN_USER
        if INT_PENDING:
            raise KeyboardInterrupt()  # not an Exception: IPython lets it through to do_exec
        IN_USER = True
        return node


def _left_user_code(*_a, **_k):
    global IN_USER
    IN_USER = False


shell.ast_transformers.append(_Gate())
shell.events.register('post_run_cell', _left_user_code)

_SKIP = (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, types.MethodType, type)


def variables():
    out = []
    hidden = shell.user_ns_hidden
    for name, v in list(shell.user_ns.items()):
        if name.startswith('_') or name in hidden or isinstance(v, _SKIP):
            continue
        info = {'name': name, 'type': type(v).__name__}
        try:
            shape = getattr(v, 'shape', None)
            if isinstance(shape, tuple):
                info['shape'] = ' × '.join(str(n) for n in shape)
            elif hasattr(v, '__len__') and not isinstance(v, (str, bytes)):
                info['shape'] = str(len(v))
            if isinstance(v, (bool, int, float, complex, str)):
                r = repr(v)
                info['value'] = r if len(r) <= 60 else r[:57] + '…'
            dtypes = getattr(v, 'dtypes', None)
            if dtypes is not None and hasattr(dtypes, 'items'):
                info['cols'] = [[str(c), str(d)] for c, d in list(dtypes.items())[:40]]
        except Exception:
            pass
        out.append(info)
        if len(out) >= 200:
            break
    return out


def do_exec(req):
    global BUSY, IN_USER, INT_PENDING, EXECS
    t0 = time.time()
    ok, n = False, None
    BUSY = True
    try:
        if INT_PENDING:  # interrupted while it was still waiting to start
            raise KeyboardInterrupt()
        r = shell.run_cell(req.get('code', ''), store_history=True)
        ok, n = bool(r.success), r.execution_count
    except KeyboardInterrupt:
        emit({'t': 'error', 'ename': 'KeyboardInterrupt', 'evalue': '', 'traceback': ['KeyboardInterrupt']})
    finally:
        BUSY = False
        IN_USER = False
        INT_PENDING = False
        EXECS = max(0, EXECS - 1)
    done = {'t': 'done', 'ok': ok, 'n': n, 'ms': int((time.time() - t0) * 1000)}
    for _ in range(3):  # an interrupt landing right here must not swallow the `done`
        try:
            time.sleep(0.02)  # let the fd pumps hand over what the cell wrote last
            done['vars'] = variables()
            emit(done)
            break
        except KeyboardInterrupt:
            continue


_q = queue.Queue()


def _reader():
    global EXECS
    for line in _cmd:
        try:
            req = json.loads(line)
        except Exception:
            continue
        if req.get('op') == 'interrupt':
            if EXECS > 0:
                _poke_main()
            continue
        if req.get('op') == 'exec':
            EXECS += 1  # counted here, on the thread that also sees the interrupts: no window between "accepted" and "running"
        _q.put(req)
    # stdin closed: the host is gone. A cell that swallows the interrupt (`except: pass` in a loop)
    # would otherwise outlive it for good, so the timer ends the process either way.
    if EXECS > 0:
        t = threading.Timer(2, lambda: os._exit(0))
        t.daemon = True
        t.start()
        _poke_main()
    _q.put(None)


def main():
    global CUR, LAST
    _send({'t': 'ready', 'python': sys.version.split()[0], 'ipython': IPython.__version__, 'exe': sys.executable,
           'vendored': bool(_vendor) and os.path.abspath(IPython.__file__).startswith(os.path.abspath(_vendor)), 'id': None})
    threading.Thread(target=_reader, name='nb-commands', daemon=True).start()
    while True:
        try:
            req = _q.get()
        except KeyboardInterrupt:  # an interrupt that arrived between cells is not an error
            continue
        if req is None or req.get('op') == 'shutdown':
            break
        try:
            CUR = req.get('id')
            op = req.get('op')
            if op == 'exec':
                LAST = CUR
                do_exec(req)
            elif op == 'vars':
                emit({'t': 'vars', 'vars': variables()})
        except KeyboardInterrupt:
            pass
        finally:
            CUR = None


if __name__ == '__main__':
    main()
