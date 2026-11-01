"""Bring a VS Code window to the front by folder name.

Windows refuses SetForegroundWindow from a background process (it only flashes the taskbar), so
this attaches to the current foreground window's input thread first, which lifts that lock.
Usage: python -I raise-window.py "<folder>" ["<folder>" ...]
Tries the folders in order and raises the first open window that names one; prints that folder.
Exit: 0 raised, 2 no window names any of them, 3 Windows refused.
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


def vscode_titles():
    found = []

    def visit(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(user32.GetWindowTextLengthW(hwnd) + 1)
            user32.GetWindowTextW(hwnd, buf, len(buf))
            if buf.value.endswith(" - Visual Studio Code"):
                found.append((hwnd, buf.value))
        return True

    user32.EnumWindows(EnumProc(visit), 0)
    return found


def find(folders):
    """Titles read "<editor> - <folder> - Visual Studio Code" or "<folder> - Visual Studio Code"."""
    windows = vscode_titles()
    for folder in folders:
        tail, whole = f" - {folder} - Visual Studio Code", f"{folder} - Visual Studio Code"
        for hwnd, title in windows:
            if title.endswith(tail) or title == whole:
                return hwnd, folder
    return None, None


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
    hwnd, folder = find(sys.argv[1:])
    if not hwnd:
        sys.exit(2)
    print(folder)
    sys.exit(0 if raise_window(hwnd) else 3)
