"""Bring a VS Code window, a window by its class name, a herdr window, or the terminal window a process
runs in, to the front.

Windows refuses SetForegroundWindow from a background process (it only flashes the taskbar), so
this attaches to the current foreground window's input thread first, which lifts that lock.
A raised window then flashes: its border and title bar pulse cyan three times (about 1.5 s) and go
back to Windows' colors, so it's plain which window came forward. A detached copy of this script
does the flashing (--flash), so whoever asked for the raise isn't kept waiting. Windows 11 only;
on Windows 10 the colors are refused and nothing flashes.
Usage: python -I raise-window.py "<folder>" ["<folder>" ...]  |  --class "<class prefix>"  |  --herdr "<workspace label>"
       |  --pid <pid>  |  --flash <hwnd>
Tries the folders in order and raises the first open window that names one; prints that folder.
Exit: 0 raised, 2 no window names any of them, 3 Windows refused.

Two more modes move Cleon's own windows (a class is "<base><digits>", as lib/open.mjs names them):
  --close "<base>"   closes every window of that base and prints where each sat, as JSON
                     [[show, left, top, right, bottom], ...] (its restored position, and whether it was
                     maximized or minimized). Exit 0, even when there were none.
  --place "<class>" <show> <left> <top> <right> <bottom>   puts that window there. Exit 0, or 2 if it isn't open.
"""
import ctypes
import json
import os
import subprocess
import sys
import time
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


dwm = ctypes.WinDLL("dwmapi")
dwm.DwmSetWindowAttribute.argtypes = [HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
dwm.DwmSetWindowAttribute.restype = ctypes.c_long
DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR, DWMWA_COLOR_DEFAULT = 34, 35, 36, 0xFFFFFFFF
# COLORREF is 0x00BBGGRR: border #3ef0ff (Cleon's cyan), title bar #0e5a66, title text white.
LIT = (0x00FFF03E, 0x00665A0E, 0x00FFFFFF)
UNLIT = (DWMWA_COLOR_DEFAULT,) * 3


def colors(hwnd, values):
    for attr, value in zip((DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR), values):
        v = wintypes.DWORD(value)
        dwm.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(v), ctypes.sizeof(v))


def flash(hwnd, pulses=3):
    try:
        for _ in range(pulses):
            colors(hwnd, LIT)
            time.sleep(0.35)
            colors(hwnd, UNLIT)
            time.sleep(0.2)
    finally:
        colors(hwnd, UNLIT)


def flash_detached(hwnd):
    DETACHED_PROCESS, CREATE_NEW_PROCESS_GROUP = 0x8, 0x200
    subprocess.Popen([sys.executable, "-I", os.path.abspath(__file__), "--flash", str(int(hwnd))],
                     creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, close_fds=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def class_window(prefix):
    """A window whose class name (mintty --class) starts with this prefix, whatever its title says."""
    user32.GetClassNameW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
    found = []

    def visit(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, buf, 256)
            if buf.value.startswith(prefix):
                found.append(hwnd)
        return True

    user32.EnumWindows(EnumProc(visit), 0)
    return (found[0], prefix) if found else (None, None)


def herdr_window(label):
    """A herdr client titles its window "<host>: <focused workspace label>", sometimes padded with spaces."""
    found = []

    def visit(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(user32.GetWindowTextLengthW(hwnd) + 1)
            user32.GetWindowTextW(hwnd, buf, len(buf))
            if buf.value.rstrip().endswith(f": {label}"):
                found.append(hwnd)
        return True

    user32.EnumWindows(EnumProc(visit), 0)
    return (found[0], label) if found else (None, None)


# Terminal hosts that own one top-level window per terminal (VS Code isn't one: its windows share a process,
# so it's matched by folder instead).
TERMINALS = {"mintty.exe", "windowsterminal.exe", "wezterm-gui.exe", "alacritty.exe"}


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG), ("dwFlags", wintypes.DWORD),
                ("szExeFile", wintypes.WCHAR * 260)]


def processes():
    """{pid: (parent pid, exe name in lower case)} for every running process."""
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    snap = kernel32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    entry, out = PROCESSENTRY32W(), {}
    entry.dwSize = ctypes.sizeof(entry)
    ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
    while ok:
        out[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile.lower())
        ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    kernel32.CloseHandle(snap)
    return out


def pid_window(pid):
    """The window of the nearest terminal host among a process's ancestors (Claude in Git Bash: claude.exe
    <- bash.exe <- mintty.exe). Prints that window's title."""
    procs, chain = processes(), []
    while pid in procs and pid not in chain and len(chain) < 32:
        chain.append(pid)
        pid = procs[pid][0]
    for host in (p for p in chain if procs[p][1] in TERMINALS):
        found = []

        def visit(hwnd, _):
            owner = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value == host and user32.IsWindowVisible(hwnd) and user32.GetWindowTextLengthW(hwnd):
                buf = ctypes.create_unicode_buffer(user32.GetWindowTextLengthW(hwnd) + 1)
                user32.GetWindowTextW(hwnd, buf, len(buf))
                found.append((hwnd, buf.value))
            return True

        user32.EnumWindows(EnumProc(visit), 0)
        if found:
            return found[0]
    return None, None


class WINDOWPLACEMENT(ctypes.Structure):
    _fields_ = [("length", wintypes.UINT), ("flags", wintypes.UINT), ("showCmd", wintypes.UINT),
                ("ptMinPosition", wintypes.POINT), ("ptMaxPosition", wintypes.POINT), ("rcNormalPosition", wintypes.RECT)]


def own_windows(base=None, exact=None):
    """Visible windows whose class is exactly `exact`, or `base` followed by digits only (so the base
    "cleon-herdr-acme-" never matches "cleon-herdr-acme-api-<id>")."""
    user32.GetClassNameW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
    found = []

    def visit(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, buf, 256)
            name = buf.value
            if name == exact or (base and name.startswith(base) and name[len(base):].isdigit()):
                found.append(hwnd)
        return True

    user32.EnumWindows(EnumProc(visit), 0)
    return found


def close_windows(base):
    """Where each window sat (its restored rectangle, and whether it was maximized or minimized), then close it.
    Placements are in the same coordinates for reading and setting, so mixed-DPI monitors round-trip."""
    WM_CLOSE = 0x0010
    out = []
    for hwnd in own_windows(base=base):
        wp = WINDOWPLACEMENT()
        wp.length = ctypes.sizeof(wp)
        user32.GetWindowPlacement(hwnd, ctypes.byref(wp))
        r = wp.rcNormalPosition
        out.append([wp.showCmd, r.left, r.top, r.right, r.bottom])
        user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
    print(json.dumps(out))


def place_window(cls, show, left, top, right, bottom):
    found = own_windows(exact=cls)
    if not found:
        return False
    wp = WINDOWPLACEMENT()
    wp.length = ctypes.sizeof(wp)
    user32.GetWindowPlacement(found[0], ctypes.byref(wp))
    wp.showCmd = 7 if show in (2, 6, 7) else show  # minimized comes back minimized without taking focus
    wp.rcNormalPosition = wintypes.RECT(left, top, right, bottom)
    # Twice: moving onto a monitor with another scale makes the window resize itself for that scale once.
    for _ in range(2):
        user32.SetWindowPlacement(found[0], ctypes.byref(wp))
    return True


if __name__ == "__main__":
    # --class <prefix>: a window by its class name; --herdr <label>: the herdr window showing that
    # workspace; --pid <pid>: the terminal window that process runs in; otherwise VS Code folder names.
    sys.stdout.reconfigure(encoding="utf-8")  # window titles carry symbols (Claude Code's is "✳ ...")
    mode = sys.argv[1:2]
    if mode == ["--flash"]:
        flash(HWND(int(sys.argv[2])))
        sys.exit(0)
    if mode in (["--close"], ["--place"]):
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # real pixels on every monitor, whatever its scale
        if mode == ["--close"]:
            close_windows(sys.argv[2])
            sys.exit(0)
        sys.exit(0 if place_window(sys.argv[2], *map(int, sys.argv[3:8])) else 2)
    hwnd, folder = (class_window(sys.argv[2]) if mode == ["--class"] else herdr_window(sys.argv[2]) if mode == ["--herdr"]
                    else pid_window(int(sys.argv[2])) if mode == ["--pid"] else find(sys.argv[1:]))
    if not hwnd:
        sys.exit(2)
    print(folder)
    raised = raise_window(hwnd)
    if raised:
        flash_detached(hwnd)
    sys.exit(0 if raised else 3)
