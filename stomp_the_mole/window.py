"""Open the floor page in its own browser window over the play pane.

Modes (config window.mode):
  borderless  an Edge/Chrome --app window with its caption and frame stripped, placed at (x, y)
              at exactly the floor size in physical pixels, kept on top, re-asserted every few seconds
  kiosk       the browser's fullscreen kiosk mode; the page draws at the top-left of the screen
  none        no window; the URL is printed so it can be opened by hand
Off Windows, or when no browser is found, the URL is printed instead.

The browser can never outlive the game: before launching it, this process joins a Windows job
that kills everything in it when the game's process ends for any reason (Ctrl+C, the console's
X button, Task Manager, a crash). Ctrl+C still closes the window gracefully first.
"""

import ctypes
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

log = logging.getLogger(__name__)

WINDOW_TITLE = "Stomp the Mole"          # floor.html's <title>
WINDOW_TITLES = (WINDOW_TITLE, WINDOW_TITLE + " - [InPrivate]")   # Edge adds the suffix (--inprivate)
BROWSER_CLASS = "Chrome_WidgetWin_1"     # top-level window class of Edge and Chrome
CONTENT_CLASS = "Chrome_RenderWidgetHostHWND"
FIND_TIMEOUT_S = 30.0
REASSERT_S = 3.0


def find_browser(choice: str = "auto") -> Path | None:
    """Edge first (Program Files (x86), then Program Files), then Chrome; or an explicit exe path."""
    choice = (choice or "auto").strip()
    if choice.lower() not in ("auto", "edge", "chrome"):
        path = Path(os.path.expandvars(choice))
        return path if path.is_file() else None
    env = os.environ.get
    edge = [Path(root, "Microsoft", "Edge", "Application", "msedge.exe")
            for root in (env("ProgramFiles(x86)"), env("ProgramFiles"), env("ProgramW6432")) if root]
    chrome = [Path(root, "Google", "Chrome", "Application", "chrome.exe")
              for root in (env("ProgramFiles"), env("ProgramW6432"), env("ProgramFiles(x86)"),
                           env("LOCALAPPDATA")) if root]
    candidates = {"edge": edge, "chrome": chrome}.get(choice.lower(), edge + chrome)
    return next((path for path in candidates if path.is_file()), None)


def browser_name(exe: Path) -> str:
    return {"msedge.exe": "Microsoft Edge", "chrome.exe": "Google Chrome"}.get(exe.name.lower(), exe.name)


def profile_dir() -> Path:
    """A browser profile of our own, so the game never touches the operator's normal browser."""
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    return Path(base, "StompTheMole", "browser")


def browser_command(exe: Path, url: str, mode: str, x: int, y: int, width: int, height: int,
                    user_data_dir: Path) -> list[str]:
    args = [
        str(exe),
        f"--user-data-dir={user_data_dir}",
        "--autoplay-policy=no-user-gesture-required",
        "--no-first-run",
        "--no-default-browser-check",
        f"--window-position={x},{y}",
        # one CSS pixel = one screen pixel, so 560 x 448 means the same thing at any display scaling
        "--force-device-scale-factor=1",
        "--disable-translate",
        "--disable-features=Translate,TranslateUI",
        "--disable-pinch",
        "--overscroll-history-navigation=0",
        # keep animating at full rate even if Windows thinks the window is covered
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--hide-crash-restore-bubble",
        "--disable-session-crashed-bubble",
        "--noerrdialogs",
    ]
    if exe.name.lower() == "msedge.exe":
        # A fresh Edge profile signs itself in with the PC's Microsoft account and shows a "syncing
        # your browsing data" popup whose dark backdrop dims the whole game to ~40% (seen on the dev
        # PC 2026-10-10). InPrivate never signs in or syncs; the game stores nothing in the browser.
        args.append("--inprivate")
    args.append("--disable-sync")
    if mode == "kiosk":
        args += ["--kiosk", url]
        if exe.name.lower() == "msedge.exe":
            args.append("--edge-kiosk-type=fullscreen")
    else:
        args += [f"--window-size={width},{height}", f"--app={url}"]
    return args


# ---------------------------------------------------------------- Win32

_JOB = None  # handle of the kill-on-close job this process is in; kept open for the life of the process


def kill_children_with_us() -> bool:
    """Make Windows end every process this one starts from now on when this one ends.

    Joins this process to a job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Child processes
    (the browser) inherit the job; the only handle to it is ours, so it closes when this process
    exits, whatever the reason, and Windows then ends the children too. Returns False (and
    changes nothing) when that is not possible; the game works without it.
    """
    global _JOB
    if _JOB is not None:
        return True
    if sys.platform != "win32":
        return False
    try:
        from ctypes import wintypes as w

        class _Basic(ctypes.Structure):  # JOBOBJECT_BASIC_LIMIT_INFORMATION
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", w.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", w.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", w.DWORD), ("SchedulingClass", w.DWORD)]

        class _Extended(ctypes.Structure):  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION
            _fields_ = [("BasicLimitInformation", _Basic), ("IoInfo", ctypes.c_uint64 * 6),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateJobObjectW.argtypes, k32.CreateJobObjectW.restype = [ctypes.c_void_p, w.LPCWSTR], w.HANDLE
        k32.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        k32.SetInformationJobObject.restype = w.BOOL
        k32.AssignProcessToJobObject.argtypes, k32.AssignProcessToJobObject.restype = [w.HANDLE, w.HANDLE], w.BOOL
        k32.GetCurrentProcess.argtypes, k32.GetCurrentProcess.restype = [], w.HANDLE
        k32.CloseHandle.argtypes, k32.CloseHandle.restype = [w.HANDLE], w.BOOL

        job = k32.CreateJobObjectW(None, None)
        if not job:
            raise ctypes.WinError(ctypes.get_last_error())
        info = _Extended()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not (k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))  # 9: extended limits
                and k32.AssignProcessToJobObject(job, k32.GetCurrentProcess())):
            error = ctypes.get_last_error()
            k32.CloseHandle(job)
            raise ctypes.WinError(error)
    except (OSError, AttributeError) as exc:
        log.debug("Could not tie the browser's life to the game (%s); it may outlive a killed console", exc)
        return False
    _JOB = job
    return True


def make_dpi_aware() -> None:
    """Work in physical pixels, so 560 x 448 is not stretched by display scaling."""
    try:
        user32 = ctypes.WinDLL("user32")
        user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        user32.SetProcessDpiAwarenessContext.restype = ctypes.c_int
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):  # PER_MONITOR_AWARE_V2
            return
    except (AttributeError, OSError):
        pass
    try:
        ctypes.WinDLL("shcore").SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
        return
    except (AttributeError, OSError):
        pass
    try:
        ctypes.WinDLL("user32").SetProcessDPIAware()
    except (AttributeError, OSError):
        pass


class _Win32:
    """The user32 calls we need, typed on a private WinDLL so other modules are unaffected."""

    GWL_STYLE, GWL_EXSTYLE = -16, -20
    WS_POPUP = 0x80000000
    WS_CAPTION, WS_THICKFRAME, WS_SYSMENU = 0x00C00000, 0x00040000, 0x00080000
    WS_MINIMIZEBOX, WS_MAXIMIZEBOX = 0x00020000, 0x00010000
    WS_EX_DLGMODALFRAME, WS_EX_WINDOWEDGE, WS_EX_CLIENTEDGE, WS_EX_STATICEDGE = 0x1, 0x100, 0x200, 0x20000
    STRIP_STYLE = WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX
    STRIP_EX = WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE
    HWND_TOPMOST = -1
    SWP_NOSIZE, SWP_NOMOVE, SWP_NOACTIVATE = 0x1, 0x2, 0x10
    SWP_FRAMECHANGED, SWP_SHOWWINDOW, SWP_NOOWNERZORDER = 0x20, 0x40, 0x200
    SW_RESTORE = 9
    GW_OWNER = 4
    WM_CLOSE = 0x0010

    def __init__(self):
        from ctypes import wintypes as w
        u = ctypes.WinDLL("user32", use_last_error=True)
        self.u = u
        self.RECT, self.DWORD = w.RECT, w.DWORD
        self.ENUMPROC = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
        sigs = {
            "EnumWindows": ([self.ENUMPROC, w.LPARAM], w.BOOL),
            "EnumChildWindows": ([w.HWND, self.ENUMPROC, w.LPARAM], w.BOOL),
            "GetWindowTextLengthW": ([w.HWND], ctypes.c_int),
            "GetWindowTextW": ([w.HWND, w.LPWSTR, ctypes.c_int], ctypes.c_int),
            "GetClassNameW": ([w.HWND, w.LPWSTR, ctypes.c_int], ctypes.c_int),
            "IsWindow": ([w.HWND], w.BOOL),
            "IsWindowVisible": ([w.HWND], w.BOOL),
            "IsIconic": ([w.HWND], w.BOOL),
            "IsZoomed": ([w.HWND], w.BOOL),
            "GetWindow": ([w.HWND, w.UINT], w.HWND),
            "GetWindowThreadProcessId": ([w.HWND, ctypes.POINTER(w.DWORD)], w.DWORD),
            "GetWindowRect": ([w.HWND, ctypes.POINTER(w.RECT)], w.BOOL),
            "ShowWindow": ([w.HWND, ctypes.c_int], w.BOOL),
            "SetWindowPos": ([w.HWND, w.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, w.UINT],
                             w.BOOL),
            "PostMessageW": ([w.HWND, w.UINT, w.WPARAM, w.LPARAM], w.BOOL),
        }
        if ctypes.sizeof(ctypes.c_void_p) == 8:
            sigs["GetWindowLongPtrW"] = ([w.HWND, ctypes.c_int], ctypes.c_ssize_t)
            sigs["SetWindowLongPtrW"] = ([w.HWND, ctypes.c_int, ctypes.c_ssize_t], ctypes.c_ssize_t)
            self._get_long, self._set_long = "GetWindowLongPtrW", "SetWindowLongPtrW"
        else:  # 32-bit Python: the Ptr variants are macros, not exports
            sigs["GetWindowLongW"] = ([w.HWND, ctypes.c_int], ctypes.c_long)
            sigs["SetWindowLongW"] = ([w.HWND, ctypes.c_int, ctypes.c_long], ctypes.c_long)
            self._get_long, self._set_long = "GetWindowLongW", "SetWindowLongW"
        for name, (argtypes, restype) in sigs.items():
            fn = getattr(u, name)
            fn.argtypes, fn.restype = argtypes, restype

    def text(self, hwnd) -> str:
        n = self.u.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        self.u.GetWindowTextW(hwnd, buf, n + 1)
        return buf.value

    def class_name(self, hwnd) -> str:
        buf = ctypes.create_unicode_buffer(256)
        self.u.GetClassNameW(hwnd, buf, 256)
        return buf.value

    def pid(self, hwnd) -> int:
        pid = self.DWORD()
        self.u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return pid.value

    def rect(self, hwnd) -> tuple[int, int, int, int] | None:
        """(x, y, width, height) in screen pixels."""
        r = self.RECT()
        if not self.u.GetWindowRect(hwnd, ctypes.byref(r)):
            return None
        return r.left, r.top, r.right - r.left, r.bottom - r.top

    def get_long(self, hwnd, index: int) -> int:
        return getattr(self.u, self._get_long)(hwnd, index) & 0xFFFFFFFF

    def set_long(self, hwnd, index: int, value: int) -> None:
        if self._set_long == "SetWindowLongW" and value >= 1 << 31:
            value -= 1 << 32
        getattr(self.u, self._set_long)(hwnd, index, value)

    def top_level_browser_windows(self) -> list[tuple[int, str, int]]:
        """Visible, unowned Edge/Chrome top-level windows as (hwnd, title, pid)."""
        found = []

        def visit(hwnd, _lparam):
            if hwnd and self.u.IsWindowVisible(hwnd) and not self.u.GetWindow(hwnd, self.GW_OWNER) \
                    and self.class_name(hwnd) == BROWSER_CLASS:
                found.append((hwnd, self.text(hwnd), self.pid(hwnd)))
            return True

        self.u.EnumWindows(self.ENUMPROC(visit), 0)
        return found

    def content_rect(self, hwnd) -> tuple[int, int, int, int] | None:
        """Screen rect of the page area (the largest visible render widget child), if there is one."""
        best = []

        def visit(child, _lparam):
            if child and self.u.IsWindowVisible(child) and self.class_name(child) == CONTENT_CLASS:
                r = self.rect(child)
                if r and (not best or r[2] * r[3] > best[0][2] * best[0][3]):
                    best[:] = [r]
            return True

        self.u.EnumChildWindows(hwnd, self.ENUMPROC(visit), 0)
        return best[0] if best else None


# ---------------------------------------------------------------- the window


class BrowserWindow:
    """Launches the browser and keeps its window where the floor shows it. Call close() at shutdown."""

    def __init__(self, url: str, *, mode: str = "borderless", x: int = 0, y: int = 0,
                 width: int = 560, height: int = 448, browser: str = "auto"):
        self.url = url
        self.mode = mode
        self.x, self.y, self.width, self.height = int(x), int(y), int(width), int(height)
        self.browser = browser
        self._proc: subprocess.Popen | None = None
        self._hwnd = None
        self._win: _Win32 | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._target = (self.x, self.y, self.width, self.height)
        self._prev_insets = None

    def open(self) -> bool:
        """Launch the browser; returns False (after printing the URL) when no window is opened."""
        if self.mode == "none":
            log.info("No game window (window.mode is none). Open %s yourself.", self.url)
            return False
        if sys.platform != "win32":
            log.info("Open %s in a browser (automatic window placement is Windows only).", self.url)
            return False
        exe = find_browser(self.browser)
        if exe is None:
            log.warning("Could not find Microsoft Edge or Google Chrome. Open %s in a browser and place it "
                        "over the play pane by hand.", self.url)
            return False
        make_dpi_aware()
        self._win = _Win32()
        self._close_leftovers()
        user_data = profile_dir()
        user_data.mkdir(parents=True, exist_ok=True)
        cmd = browser_command(exe, self.url, self.mode, self.x, self.y, self.width, self.height, user_data)
        kill_children_with_us()  # a closed console must not leave a frozen, topmost game window behind
        try:
            self._proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                          stderr=subprocess.DEVNULL)
        except OSError as exc:
            log.warning("Could not start %s (%s). Open %s by hand.", exe, exc, self.url)
            return False
        log.info("Starting %s (%s mode)", browser_name(exe), self.mode)
        self._thread = threading.Thread(target=self._watch, args=(browser_name(exe),),
                                        name="window-keeper", daemon=True)
        self._thread.start()
        return True

    def close(self) -> None:
        """Close the window we opened, then make sure the browser's process tree is gone."""
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        win, hwnd, proc = self._win, self._hwnd, self._proc
        if win and hwnd and win.u.IsWindow(hwnd):
            win.u.PostMessageW(hwnd, win.WM_CLOSE, 0, 0)
        if proc and proc.poll() is None:
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self._proc = None
        self._hwnd = None

    # ------------------------------------------------------------ internals

    def _find(self):
        """Our window: titled exactly like the page, or starting with it and owned by our browser."""
        windows = self._win.top_level_browser_windows()
        for hwnd, title, _pid in windows:
            if title in WINDOW_TITLES:
                return hwnd
        launched = self._proc.pid if self._proc else None
        for hwnd, title, pid in windows:
            if title.startswith(WINDOW_TITLE) and pid == launched:
                return hwnd
        return None

    def _close_leftovers(self) -> None:
        """A game window left by an earlier run would block the new one. The kill-on-close job means
        a killed run no longer leaves one; this stays as the fallback for when the job is not possible."""
        old = [hwnd for hwnd, title, _ in self._win.top_level_browser_windows() if title in WINDOW_TITLES]
        if not old:
            return
        for hwnd in old:
            self._win.u.PostMessageW(hwnd, self._win.WM_CLOSE, 0, 0)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and any(self._win.u.IsWindow(h) for h in old):
            time.sleep(0.1)
        log.info("Closed a game window left over from an earlier run")

    def _watch(self, name: str) -> None:
        deadline = time.monotonic() + FIND_TIMEOUT_S
        announced = warned = ever_found = False
        settle = 0
        while not self._stop.is_set():
            hwnd = self._hwnd
            if not hwnd or not self._win.u.IsWindow(hwnd):
                if announced:
                    log.warning("The game window was closed. Restart Stomp the Mole to open it again.")
                    announced = False
                self._hwnd = hwnd = self._find()
                if not hwnd:
                    # "not appeared" is only true before the window was ever found
                    if not warned and not ever_found and time.monotonic() > deadline:
                        log.warning("The game window has not appeared after %d s. Is the page loading? "
                                    "You can open %s by hand.", FIND_TIMEOUT_S, self.url)
                        warned = True
                    self._stop.wait(0.25)
                    continue
            try:
                if self.mode == "borderless":
                    self._place(hwnd)
            except Exception:  # never let a placement problem kill the keeper thread
                log.debug("Window placement failed", exc_info=True)
            if not announced:
                where = (f"borderless at {self.x},{self.y} {self.width}x{self.height}, always on top"
                         if self.mode == "borderless" else "fullscreen kiosk")
                log.info("Game window opened: %s, %s", name, where)
                announced = ever_found = True
            # look again soon while the browser settles its layout, then every few seconds
            settle += 1
            self._stop.wait(0.5 if settle < 6 else REASSERT_S)

    def _place(self, hwnd) -> None:
        win = self._win
        if win.u.IsIconic(hwnd) or win.u.IsZoomed(hwnd):
            win.u.ShowWindow(hwnd, win.SW_RESTORE)
        style, ex = win.get_long(hwnd, win.GWL_STYLE), win.get_long(hwnd, win.GWL_EXSTYLE)
        new_style = (style & ~win.STRIP_STYLE) | win.WS_POPUP
        new_ex = ex & ~win.STRIP_EX
        restyled = (new_style, new_ex) != (style, ex)
        if restyled:
            win.set_long(hwnd, win.GWL_STYLE, new_style)
            win.set_long(hwnd, win.GWL_EXSTYLE, new_ex)
        target = self._target_rect(hwnd)
        if restyled or win.rect(hwnd) != target:
            win.u.SetWindowPos(hwnd, win.HWND_TOPMOST, *target,
                               win.SWP_FRAMECHANGED | win.SWP_NOACTIVATE | win.SWP_SHOWWINDOW
                               | win.SWP_NOOWNERZORDER)
        else:  # only re-assert "on top", which never causes a redraw
            win.u.SetWindowPos(hwnd, win.HWND_TOPMOST, 0, 0, 0, 0,
                               win.SWP_NOMOVE | win.SWP_NOSIZE | win.SWP_NOACTIVATE | win.SWP_NOOWNERZORDER)

    def _target_rect(self, hwnd) -> tuple[int, int, int, int]:
        """Where the window must be so the page area itself lands on (x, y, width, height).

        Normally that is the window rect. If the browser keeps drawing a strip of its own inside the
        stripped window (a title bar, say), the page area is smaller than the window; the window is
        then grown and shifted by those insets so the strip sits outside the play pane. Insets are
        only trusted once two looks in a row agree, so a layout in progress cannot make it jump.
        """
        insets = None
        outer, inner = self._win.rect(hwnd), self._win.content_rect(hwnd)
        if outer and inner and inner[2] >= 100 and inner[3] >= 100:
            left, top = inner[0] - outer[0], inner[1] - outer[1]
            right = outer[0] + outer[2] - inner[0] - inner[2]
            bottom = outer[1] + outer[3] - inner[1] - inner[3]
            if all(0 <= v <= 120 for v in (left, top, right, bottom)):
                insets = (left, top, right, bottom)
        if insets is not None and insets == self._prev_insets:
            left, top, right, bottom = insets
            target = (self.x - left, self.y - top, self.width + left + right, self.height + top + bottom)
            if target != self._target and any(insets):
                log.info("The browser draws %s px of its own frame inside the window; moved the window "
                         "so the game area sits exactly at %d,%d", insets, self.x, self.y)
            self._target = target
        self._prev_insets = insets
        return self._target
