"""Run notebook !commands on a private Windows pseudoconsole.

ConPTY converts real console output to UTF-8, so cmd built-ins, Python and native
programs can share a stream without guessing their pipe encodings. It has no GUI
window and does not change the user's console, code page or Python environment.
"""
import codecs
import ctypes as C
from ctypes import wintypes as W
import msvcrt
import os
import re
import subprocess
import sys
import threading

K = C.WinDLL('kernel32', use_last_error=True)


class COORD(C.Structure):
    _fields_ = [('X', W.SHORT), ('Y', W.SHORT)]


class STARTUPINFO(C.Structure):
    _fields_ = [('cb', W.DWORD), ('lpReserved', W.LPWSTR), ('lpDesktop', W.LPWSTR),
                ('lpTitle', W.LPWSTR), ('dwX', W.DWORD), ('dwY', W.DWORD),
                ('dwXSize', W.DWORD), ('dwYSize', W.DWORD), ('dwXCountChars', W.DWORD),
                ('dwYCountChars', W.DWORD), ('dwFillAttribute', W.DWORD),
                ('dwFlags', W.DWORD), ('wShowWindow', W.WORD), ('cbReserved2', W.WORD),
                ('lpReserved2', C.c_void_p), ('hStdInput', W.HANDLE),
                ('hStdOutput', W.HANDLE), ('hStdError', W.HANDLE)]


class STARTUPINFOEX(C.Structure):
    _fields_ = [('StartupInfo', STARTUPINFO), ('lpAttributeList', C.c_void_p)]


class PROCESSINFO(C.Structure):
    _fields_ = [('hProcess', W.HANDLE), ('hThread', W.HANDLE),
                ('dwProcessId', W.DWORD), ('dwThreadId', W.DWORD)]


K.CreatePipe.argtypes = [C.POINTER(W.HANDLE), C.POINTER(W.HANDLE), C.c_void_p, W.DWORD]
K.CreatePipe.restype = W.BOOL
K.CreatePseudoConsole.argtypes = [COORD, W.HANDLE, W.HANDLE, W.DWORD, C.POINTER(W.HANDLE)]
K.CreatePseudoConsole.restype = C.c_long
K.ClosePseudoConsole.argtypes = [W.HANDLE]
K.ClosePseudoConsole.restype = None
K.InitializeProcThreadAttributeList.argtypes = [C.c_void_p, W.DWORD, W.DWORD, C.POINTER(C.c_size_t)]
K.InitializeProcThreadAttributeList.restype = W.BOOL
K.UpdateProcThreadAttribute.argtypes = [C.c_void_p, W.DWORD, C.c_size_t, C.c_void_p, C.c_size_t, C.c_void_p, C.c_void_p]
K.UpdateProcThreadAttribute.restype = W.BOOL
K.DeleteProcThreadAttributeList.argtypes = [C.c_void_p]
K.DeleteProcThreadAttributeList.restype = None
K.CreateProcessW.argtypes = [W.LPCWSTR, W.LPWSTR, C.c_void_p, C.c_void_p, W.BOOL,
                            W.DWORD, C.c_void_p, W.LPCWSTR, C.POINTER(STARTUPINFOEX), C.POINTER(PROCESSINFO)]
K.CreateProcessW.restype = W.BOOL
K.WaitForSingleObject.argtypes = [W.HANDLE, W.DWORD]
K.WaitForSingleObject.restype = W.DWORD
K.GetExitCodeProcess.argtypes = [W.HANDLE, C.POINTER(W.DWORD)]
K.GetExitCodeProcess.restype = W.BOOL
K.TerminateProcess.argtypes = [W.HANDLE, W.UINT]
K.TerminateProcess.restype = W.BOOL
K.CloseHandle.argtypes = [W.HANDLE]
K.CloseHandle.restype = W.BOOL

_ANSI = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[=>]')


def _plain(text):
    def replace(match):
        # ConPTY optimizes printed spaces into cursor-forward sequences. Keep
        # those spaces when converting its terminal stream into notebook text.
        forward = re.fullmatch(r'\x1b\[(\d*)C', match.group())
        return ' ' * int(forward.group(1) or 1) if forward else ''
    return _ANSI.sub(replace, text)


def _check(ok):
    if not ok:
        raise C.WinError(C.get_last_error())


def run_command(command, write=None):
    write = write or sys.stdout.write
    in_read, in_write, out_read, out_write, console = (W.HANDLE() for _ in range(5))
    proc = PROCESSINFO()
    attributes = None
    attributes_ready = False
    reader = None
    output = None
    errors = []
    system32 = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32')
    try:
        _check(K.CreatePipe(C.byref(in_read), C.byref(in_write), None, 0))
        _check(K.CreatePipe(C.byref(out_read), C.byref(out_write), None, 0))
        hr = K.CreatePseudoConsole(COORD(4096, 256), in_read, out_write, 0, C.byref(console))
        if hr < 0:
            raise OSError('CreatePseudoConsole failed: 0x%08x' % (hr & 0xffffffff))
        K.CloseHandle(in_read); in_read = W.HANDLE()
        K.CloseHandle(out_write); out_write = W.HANDLE()
        # The reader must drain output while ClosePseudoConsole waits for conhost.
        fd = msvcrt.open_osfhandle(out_read.value, os.O_RDONLY | os.O_BINARY)
        out_read = W.HANDLE()  # ownership moved to the CRT file object
        output = os.fdopen(fd, 'rb', buffering=0)

        def pump():
            decoder = codecs.getincrementaldecoder('utf-8')('replace')
            pending = ''
            try:
                while True:
                    data = output.read(65536)
                    if not data:
                        break
                    pending += decoder.decode(data)
                    while '\n' in pending:
                        line, pending = pending.split('\n', 1)
                        write(_plain(line + '\n'))
                pending += decoder.decode(b'', final=True)
                if pending:
                    write(_plain(pending))
            except BaseException as error:
                errors.append(error)

        reader = threading.Thread(target=pump, name='nb-shell-output', daemon=True)
        reader.start()
        size = C.c_size_t()
        K.InitializeProcThreadAttributeList(None, 1, 0, C.byref(size))
        attributes = C.create_string_buffer(size.value)
        _check(K.InitializeProcThreadAttributeList(attributes, 1, 0, C.byref(size)))
        attributes_ready = True
        _check(K.UpdateProcThreadAttribute(attributes, 0, 0x00020016, console, C.sizeof(W.HANDLE), None, None))
        startup = STARTUPINFOEX()
        startup.StartupInfo.cb = C.sizeof(startup)
        # The runner's real stdout is a JSON pipe. Explicit NULL standard handles
        # let console attachment supply ConPTY handles instead of inheriting it.
        startup.StartupInfo.dwFlags = 0x00000100
        startup.lpAttributeList = C.cast(attributes, C.c_void_p)
        cmd = os.path.join(system32, 'cmd.exe')
        args = C.create_unicode_buffer('"' + cmd + '" /d /s /c "' + command + '"')
        _check(K.CreateProcessW(cmd, args, None, None, False, 0x00080000, None, None, C.byref(startup), C.byref(proc)))
        K.CloseHandle(proc.hThread); proc.hThread = None
        while True:
            state = K.WaitForSingleObject(proc.hProcess, 50)
            if state == 0:
                break
            if state != 258:
                raise C.WinError(C.get_last_error())
        code = W.DWORD()
        _check(K.GetExitCodeProcess(proc.hProcess, C.byref(code)))
        return code.value
    finally:
        propagating = sys.exc_info()[0] is not None
        if proc.hProcess and K.WaitForSingleObject(proc.hProcess, 0) == 258:
            # Preserve the live parent while taskkill enumerates its descendants.
            try:
                subprocess.run([os.path.join(system32, 'taskkill.exe'), '/PID', str(proc.dwProcessId), '/T', '/F'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW, timeout=5, check=True)
            except (OSError, subprocess.SubprocessError) as error:
                errors.append(error)
                K.TerminateProcess(proc.hProcess, 1)
        if console:
            K.ClosePseudoConsole(console)
        if reader:
            reader.join(timeout=5)
            if reader.is_alive():
                errors.append(RuntimeError('Windows shell output did not finish'))
        if output:
            output.close()
        if attributes_ready:
            K.DeleteProcThreadAttributeList(attributes)
        for handle in [in_read, in_write, out_read, out_write, proc.hThread, proc.hProcess]:
            if handle:
                K.CloseHandle(handle)
        if errors and not propagating:
            raise errors[0]
