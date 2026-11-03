"""Per-process CPU time and memory, straight from Win32 (no counters, nothing to align).

Prints one JSON array: [{pid, name, cpu (total CPU time in 100 ns units), ram (working set bytes),
private (private bytes)}]. CPU % is the caller's job: the change in `cpu` between two samples.
Processes Windows won't open (a few protected system ones) are listed with null figures.
With --io PID, prints that one process's I/O totals instead: {read, write} bytes since it started
(files and pipes alike), or null when Windows won't open it.
Usage: python -I proc-stats.py [--io PID]
"""
import ctypes
import json
import os
import sys
from ctypes import wintypes

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
psapi = ctypes.WinDLL("psapi", use_last_error=True)
TH32CS_SNAPPROCESS = 0x2
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
INVALID = ctypes.c_void_p(-1).value


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG), ("dwFlags", wintypes.DWORD),
                ("szExeFile", wintypes.WCHAR * 260)]


class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t), ("PrivateUsage", ctypes.c_size_t)]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                 "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
kernel32.GetProcessIoCounters.argtypes = [wintypes.HANDLE, ctypes.POINTER(IO_COUNTERS)]


def io(pid):
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return None
    try:
        c = IO_COUNTERS()
        return {"read": c.ReadTransferCount, "write": c.WriteTransferCount} if kernel32.GetProcessIoCounters(h, ctypes.byref(c)) else None
    finally:
        kernel32.CloseHandle(h)


def ft(f):
    return (f.dwHighDateTime << 32) | f.dwLowDateTime


def stats(pid):
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return None, None, None
    try:
        c, e, k, u = (wintypes.FILETIME() for _ in range(4))
        cpu = ft(k) + ft(u) if kernel32.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(k), ctypes.byref(u)) else None
        m = PROCESS_MEMORY_COUNTERS_EX()
        m.cb = ctypes.sizeof(m)
        ok = psapi.GetProcessMemoryInfo(h, ctypes.byref(m), m.cb)
        return cpu, (m.WorkingSetSize if ok else None), (m.PrivateUsage if ok else None)
    finally:
        kernel32.CloseHandle(h)


def main():
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == INVALID:
        print("[]")
        return
    out, e = [], PROCESSENTRY32W()
    e.dwSize = ctypes.sizeof(e)
    try:
        more = kernel32.Process32FirstW(snap, ctypes.byref(e))
        while more:
            pid = e.th32ProcessID
            if pid:
                cpu, ram, private = stats(pid)
                out.append({"pid": pid, "name": os.path.splitext(e.szExeFile)[0], "cpu": cpu, "ram": ram, "private": private})
            more = kernel32.Process32NextW(snap, ctypes.byref(e))
    finally:
        kernel32.CloseHandle(snap)
    print(json.dumps(out))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--io" and sys.argv[2].isdigit():
        print(json.dumps(io(int(sys.argv[2]))))
    else:
        main()
