"""Bring a VS Code window to the front by its folder name.

Windows refuses SetForegroundWindow from a background process (it only flashes the taskbar), so
this attaches to the current foreground window's input thread first, which lifts that lock.
Usage: python -I raise-window.py "<folder name>"   Exit: 0 raised, 2 not found, 3 refused.
"""
import ctypes
import sys
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32")
HWND = wintypes.HWND
user32.GetForegroundWindow.restype = HWND
user32.GetWindowThreadProcessId.argtypes = [HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
for name in ("SetForegroundWindow", "BringWindowToTop", "IsIconic", "IsWindowVisible"):
    getattr(user32, name).argtypes = [HWND]
user32.ShowWindow.argtypes = [HWND, ctypes.c_int]
user32.GetWindowTextLengthW.argtypes = [HWND]
user32.GetWindowTextW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, HWND, wintypes.LPARAM)
SW_RESTORE = 9


def find(folder):
    """Titles read "<editor> - <folder> - Visual Studio Code" or "<folder> - Visual Studio Code"."""
    tail, whole, found = f" - {folder} - Visual Studio Code", f"{folder} - Visual Studio Code", []

    def visit(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(user32.GetWindowTextLengthW(hwnd) + 1)
            user32.GetWindowTextW(hwnd, buf, len(buf))
            if buf.value.endswith(tail) or buf.value == whole:
                found.append(hwnd)
        return True

    user32.EnumWindows(EnumProc(visit), 0)
    return found[0] if found else None


def raise_window(hwnd):
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    fg_thread = user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), None)
    me = kernel32.GetCurrentThreadId()
    attached = fg_thread and fg_thread != me and user32.AttachThreadInput(me, fg_thread, True)
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(me, fg_thread, False)
    return user32.GetForegroundWindow() == hwnd


if __name__ == "__main__":
    hwnd = find(sys.argv[1])
    sys.exit(2 if not hwnd else 0 if raise_window(hwnd) else 3)
