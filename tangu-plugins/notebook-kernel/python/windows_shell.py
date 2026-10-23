"""UTF-8 Windows !commands without changing Python's environment or pipe semantics.

CMD caches its output code page on startup. Set UTF-8 in a private hidden console,
then start a second CMD which observes that code page before executing user code.
IPython still owns decoding, captured output, UNC handling and failure policy.
"""
import os
import subprocess
import sys


def install():
    from IPython.utils import _process_win32

    def process_handler(cmd, callback, stderr=subprocess.PIPE):
        sys.stdout.flush()
        sys.stderr.flush()
        system32 = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32')
        shell = isinstance(cmd, str)
        if shell:
            # The nested CMD is necessary: `chcp & dir` in one CMD still emits
            # its old cached ANSI encoding when stdout is redirected to a pipe.
            cmd = ('"' + os.path.join(system32, 'chcp.com') + '" 65001 >nul && "'
                   + os.path.join(system32, 'cmd.exe') + '" /d /s /c "' + cmd + '"')
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = subprocess.SW_HIDE
        proc = subprocess.Popen(cmd, shell=shell, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=stderr,
                                startupinfo=startup, creationflags=subprocess.CREATE_NEW_CONSOLE)
        try:
            return callback(proc)
        finally:
            if proc.poll() is None:
                # Interruptions must remove descendants before the CMD parent.
                try:
                    subprocess.run([os.path.join(system32, 'taskkill.exe'), '/PID', str(proc.pid), '/T', '/F'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=subprocess.CREATE_NO_WINDOW, timeout=5, check=True)
                except (OSError, subprocess.SubprocessError):
                    proc.kill()
                proc.wait(timeout=5)

    _process_win32.process_handler = process_handler
