"""The launcher side: console logging that never blocks the game, the browser's kill-on-close job,
the window keeper's console messages, and the wall PC's address on the console."""

import io
import logging
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from stomp_the_mole import run, window

ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------- console logging


class StuckConsole(io.StringIO):
    """A console with text selected in it: every write blocks until the selection ends."""

    def __init__(self):
        super().__init__()
        self.selection_ended = threading.Event()

    def write(self, text):
        self.selection_ended.wait(10)
        return super().write(text)


@pytest.fixture
def restore_root_logger():
    root = logging.getLogger()
    saved = root.handlers[:], root.level
    yield
    root.handlers[:], level = saved
    root.setLevel(level)


def test_logging_never_blocks_the_game_while_the_console_is_stuck(restore_root_logger):
    console = StuckConsole()
    listener = run.setup_logging(console)
    log = logging.getLogger("stomp_the_mole")
    try:
        started = time.monotonic()
        log.info("Round started")
        for i in range(50):
            log.info("line %d", i)
        log.warning("careful")
        assert time.monotonic() - started < 0.5, "a log call waited for the console"
        assert console.getvalue() == ""  # nothing could be written yet
        console.selection_ended.set()  # Esc
    finally:
        run.stop_logging(listener)  # writes out what was queued
    lines = console.getvalue().splitlines()
    assert len(lines) == 52
    stamp, _, text = lines[0].partition("  ")
    assert len(stamp) == 8 and stamp[2] == ":" and text == "Round started"
    assert lines[50].endswith("  line 49") and lines[51].endswith("  WARNING: careful")
    # after shutdown, late lines still reach the console (straight, no thread)
    logging.getLogger().handlers[0].stream = io.StringIO()
    log.info("late")
    assert logging.getLogger().handlers[0].stream.getvalue().endswith("late\n")


def test_logged_exceptions_keep_their_traceback(restore_root_logger):
    console = io.StringIO()
    listener = run.setup_logging(console)
    try:
        try:
            raise RuntimeError("boom")
        except RuntimeError:
            logging.getLogger("stomp_the_mole.netserver").exception("Error in the game loop")
    finally:
        run.stop_logging(listener)
    text = console.getvalue()
    assert "ERROR: Error in the game loop" in text and "RuntimeError: boom" in text and "Traceback" in text


# ---------------------------------------------------------------- the browser dies with the game


def _gone_within(pid, seconds):
    """True once the process has exited (Windows)."""
    import ctypes
    from ctypes import wintypes as w

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.argtypes, k32.OpenProcess.restype = [w.DWORD, w.BOOL, w.DWORD], w.HANDLE
    k32.WaitForSingleObject.argtypes, k32.WaitForSingleObject.restype = [w.HANDLE, w.DWORD], w.DWORD
    k32.CloseHandle.argtypes = [w.HANDLE]
    handle = k32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
    if not handle:
        return True  # no such process any more
    try:
        return k32.WaitForSingleObject(handle, int(seconds * 1000)) == 0
    finally:
        k32.CloseHandle(handle)


GAME_STAND_IN = """
import subprocess, sys, time
sys.path.insert(0, {root!r})
from stomp_the_mole.window import kill_children_with_us
print(kill_children_with_us(), kill_children_with_us(), flush=True)
browser = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
print(browser.pid, flush=True)
time.sleep(60)
"""


@pytest.mark.skipif(sys.platform != "win32", reason="Windows job objects")
def test_the_browser_dies_with_the_game_even_when_no_cleanup_runs():
    """Closing the console with X (or Task Manager) ends python without running any cleanup code;
    the browser it started must not stay behind as a frozen, topmost window on the floor."""
    game = subprocess.Popen([sys.executable, "-c", GAME_STAND_IN.format(root=str(ROOT))],
                            stdout=subprocess.PIPE, text=True)
    browser = None
    try:
        assert game.stdout.readline().split() == ["True", "True"]  # joined the job; a second call is a no-op
        browser = int(game.stdout.readline())
        assert not _gone_within(browser, 0.2)
        game.kill()  # TerminateProcess: no finally blocks, no atexit, like the console's X button
        game.wait(5)
        assert _gone_within(browser, 5), "the browser outlived the game"
    finally:
        game.kill()
        game.stdout.close()
        if browser is not None and not _gone_within(browser, 0):
            subprocess.run(["taskkill", "/F", "/PID", str(browser)], capture_output=True)


def test_no_job_off_windows(monkeypatch):
    monkeypatch.setattr(window, "_JOB", None)
    monkeypatch.setattr(window.sys, "platform", "linux")
    assert window.kill_children_with_us() is False


# ---------------------------------------------------------------- the window keeper's messages


class _FakeUser32:
    def __init__(self):
        self.windows = set()

    def IsWindow(self, hwnd):  # noqa: N802 - the Win32 name
        return hwnd in self.windows


class _FakeWin32:
    def __init__(self):
        self.u = _FakeUser32()


def _keeper(monkeypatch, fake):
    monkeypatch.setattr(window, "FIND_TIMEOUT_S", 0.2)
    keeper = window.BrowserWindow("http://127.0.0.1:8080/floor.html", mode="kiosk")  # kiosk: no placing
    keeper._win = fake
    keeper._find = lambda: next(iter(fake.u.windows), None)
    thread = threading.Thread(target=keeper._watch, args=("Microsoft Edge",), daemon=True)
    return keeper, thread


def _messages(caplog):
    return [r.getMessage() for r in caplog.records if r.name == "stomp_the_mole.window"]


def test_a_closed_window_is_reported_once_and_not_as_never_appeared(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="stomp_the_mole.window")
    fake = _FakeWin32()
    fake.u.windows.add(42)
    keeper, thread = _keeper(monkeypatch, fake)
    thread.start()
    try:
        deadline = time.monotonic() + 3
        while not any(m.startswith("Game window opened") for m in _messages(caplog)):
            assert time.monotonic() < deadline, _messages(caplog)
            time.sleep(0.02)
        time.sleep(0.3)  # past FIND_TIMEOUT_S
        fake.u.windows.clear()  # someone closes the game window
        time.sleep(1.5)
    finally:
        keeper._stop.set()
        thread.join(3)
    messages = _messages(caplog)
    assert sum("was closed" in m for m in messages) == 1, messages
    assert not any("has not appeared" in m for m in messages), messages


def test_a_window_that_never_appears_is_reported(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="stomp_the_mole.window")
    keeper, thread = _keeper(monkeypatch, _FakeWin32())
    thread.start()
    try:
        time.sleep(0.8)
    finally:
        keeper._stop.set()
        thread.join(3)
    messages = _messages(caplog)
    assert sum("has not appeared" in m for m in messages) == 1, messages


# ---------------------------------------------------------------- the address the wall PC opens


def _addrinfo(*addresses):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (addr, 0)) for addr in addresses]


def test_lan_addresses_leave_out_loopback_and_link_local_and_list_the_default_route_first(monkeypatch):
    asked = []

    def getaddrinfo(host, port, family=0, *args, **kwargs):
        asked.append((host, family))
        return _addrinfo("127.0.0.1", "169.254.10.20", "192.168.56.1", "192.168.123.228", "10.0.0.5",
                         "192.168.56.1")

    monkeypatch.setattr(run, "_default_route_ipv4", lambda: "192.168.123.228")
    monkeypatch.setattr(run.socket, "gethostname", lambda: "FLOOR-PC")
    monkeypatch.setattr(run.socket, "getaddrinfo", getaddrinfo)
    assert run.lan_ipv4_addresses() == ["192.168.123.228", "192.168.56.1", "10.0.0.5"]
    assert asked == [("FLOOR-PC", socket.AF_INET)]


def test_lan_addresses_on_a_pc_without_a_network(monkeypatch):
    def getaddrinfo(*args, **kwargs):
        raise socket.gaierror(11001, "getaddrinfo failed")

    monkeypatch.setattr(run, "_default_route_ipv4", lambda: None)
    monkeypatch.setattr(run.socket, "getaddrinfo", getaddrinfo)
    assert run.lan_ipv4_addresses() == []


class _Probe:
    """Stands in for the UDP socket of the connect trick; sending anything would be a bug."""

    made = []

    def __init__(self, family, kind, fail=False):
        assert (family, kind) == (socket.AF_INET, socket.SOCK_DGRAM)
        self.fail, self.target, self.closed = fail, None, False
        _Probe.made.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True

    def connect(self, address):
        if self.fail:
            raise OSError(10051, "A socket operation was attempted to an unreachable network")
        self.target = address

    def getsockname(self):
        return ("192.168.123.228", 61000)

    def send(self, *args):
        raise AssertionError("the probe must not send anything")

    sendto = sendall = send


def test_the_default_route_probe_sends_nothing(monkeypatch):
    _Probe.made.clear()
    monkeypatch.setattr(run.socket, "socket", lambda family, kind: _Probe(family, kind))
    assert run._default_route_ipv4() == "192.168.123.228"
    assert _Probe.made[0].target == ("192.0.2.1", 9) and _Probe.made[0].closed
    monkeypatch.setattr(run.socket, "socket", lambda family, kind: _Probe(family, kind, fail=True))
    assert run._default_route_ipv4() is None  # no route out (an offline PC): just no answer


def test_the_real_lan_lookup_runs_on_this_pc():
    addresses = run.lan_ipv4_addresses()
    assert all(not a.startswith(("127.", "169.254.")) for a in addresses)
    assert len(addresses) == len(set(addresses))


def _wall_lines(caplog, host, port=8080):
    caplog.clear()
    caplog.set_level(logging.INFO, logger="stomp_the_mole")
    run.report_wall_address(host, port)
    return [(r.levelname, r.getMessage()) for r in caplog.records]


def test_console_tells_the_operator_what_to_open_on_the_wall_pc(monkeypatch, caplog):
    monkeypatch.setattr(run, "lan_ipv4_addresses", lambda: ["192.168.123.228", "192.168.56.1"])
    monkeypatch.setattr(run.sys, "platform", "win32")
    lines = _wall_lines(caplog, "0.0.0.0")
    assert lines[:2] == [("INFO", "Wall PC: open http://192.168.123.228:8080/room.html"),
                         ("INFO", "Wall PC: open http://192.168.56.1:8080/room.html")]
    assert len(lines) == 3 and "Windows Firewall" in lines[2][1] and "python.exe" in lines[2][1]
    # Windows asks only once (maybe already for tuio_floor_map.py): the line says so and where the fix is
    assert "never again" in lines[2][1] and "README.md" in lines[2][1]
    # the real port, if config.json moved it
    assert _wall_lines(caplog, "0.0.0.0", 8090)[0][1] == "Wall PC: open http://192.168.123.228:8090/room.html"

    monkeypatch.setattr(run, "lan_ipv4_addresses", lambda: [])
    lines = _wall_lines(caplog, "0.0.0.0")
    assert lines[0][0] == "WARNING" and "<this PC's IP address>:8080/room.html" in lines[0][1]
    assert "ipconfig" in lines[0][1]


def test_console_says_the_walls_cannot_connect_when_the_feed_is_for_this_pc_only(monkeypatch, caplog):
    monkeypatch.setattr(run, "lan_ipv4_addresses", lambda: pytest.fail("no need to look"))
    for host in ("127.0.0.1", "localhost", "::1"):
        lines = _wall_lines(caplog, host)
        assert len(lines) == 1, lines
        assert lines[0][1].startswith(f"The walls cannot connect: http.host in config.json is {host}")
        assert '"0.0.0.0"' in lines[0][1]
    # a feed bound to one address of this PC: that is the address to open
    assert _wall_lines(caplog, "192.168.123.228") == [
        ("INFO", "Wall PC: open http://192.168.123.228:8080/room.html")]
