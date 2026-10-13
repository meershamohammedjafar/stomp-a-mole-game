"""Network side of Stomp the Mole: TUIO in, the game loop, and the data feed out.

One asyncio loop runs everything:
  * a UDP endpoint that decodes TUIO with tuio_receiver and, after each packet, hands the live
    /tuio/2Dcur cursors to the TouchTracker as one frame,
  * the game loop at 60 Hz (tracker.tick -> engine.update -> events out at once, state at 30 Hz),
  * an HTTP server for the files in web/ plus an RFC 6455 WebSocket hub on /ws.

The engine owns all game state; this module only moves data in and out of it.
"""

import asyncio
import base64
import binascii
import ctypes
import errno
import hashlib
import ipaddress
import json
import logging
import socket
import struct
import sys
import time
from http import HTTPStatus
from pathlib import Path
from urllib.parse import unquote

try:
    import tuio_receiver
except ImportError:  # started from another folder: the decoder lives in the project root
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import tuio_receiver

log = logging.getLogger(__name__)

TICK_HZ = 60
STATE_EVERY_TICKS = 2            # state snapshots at 60 / 2 = 30 Hz
# Up to 3 s of feed queued in the game for one client; a client further behind is dropped. The OS
# socket buffers in front of the queue hold much more (minutes of feed on a fast link), so a page
# that stops reading but keeps its connection (a hung browser, a frozen PC) is found by its silence.
SEND_QUEUE_MAX = 90
# Pages that send heartbeats (feed.js: {"type":"beat"} at most once a second while it receives the
# feed) and then go silent: left out of "screens" after SILENT_MS (the floor takes its HUD back),
# dropped after DEAD_MS. Clients that never beat (older pages, test tools) are never timed out.
SILENT_MS = 3000
DEAD_MS = 10000
MAX_CLIENT_MESSAGE = 64 * 1024
HTTP_HEAD_TIMEOUT_S = 10
NO_TUIO_HINT_S = 15
TUIO_CURSOR = "/tuio/2Dcur"
WEB_DIR = Path(__file__).resolve().parent / "web"


def now_ms() -> float:
    """Server clock in milliseconds, shared by the engine and every feed message."""
    return time.monotonic() * 1000.0


# ---------------------------------------------------------------- WebSocket protocol (RFC 6455)

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class WsProtocolError(Exception):
    """The peer broke the protocol; `code` is the close code to answer with."""

    def __init__(self, code: int, reason: str):
        super().__init__(reason)
        self.code = code
        self.reason = reason


def accept_key(key: str) -> str:
    """Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key."""
    digest = hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def apply_mask(data: bytes, mask: bytes) -> bytes:
    """XOR data with the repeating 4-byte mask (masking and unmasking are the same)."""
    if not data:
        return b""
    n = len(data)
    key = (mask * (n // 4 + 1))[:n]
    # one big-integer XOR is far faster than a Python loop over the bytes
    return (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")


def encode_frame(payload: bytes, opcode: int = OP_TEXT, *, fin: bool = True,
                 mask: bytes | None = None) -> bytes:
    """One frame. The server sends unmasked frames; pass a 4-byte mask to build a client frame."""
    head = bytearray([(0x80 if fin else 0) | opcode])
    mask_bit = 0x80 if mask is not None else 0
    n = len(payload)
    if n < 126:
        head.append(mask_bit | n)
    elif n < 1 << 16:
        head.append(mask_bit | 126)
        head += struct.pack(">H", n)
    else:
        head.append(mask_bit | 127)
        head += struct.pack(">Q", n)
    if mask is not None:
        head += mask
        payload = apply_mask(payload, mask)
    return bytes(head) + payload


def close_frame(code: int, reason: str = "") -> bytes:
    return encode_frame(struct.pack(">H", code) + reason.encode("utf-8")[:120], OP_CLOSE)


async def read_frame(reader: asyncio.StreamReader, *, max_size: int = MAX_CLIENT_MESSAGE,
                     require_mask: bool = True) -> tuple[bool, int, bytes]:
    """Read one frame and return (fin, opcode, unmasked payload).

    Raises WsProtocolError for frames the server must refuse, and IncompleteReadError at EOF.
    """
    b0, b1 = await reader.readexactly(2)
    if b0 & 0x70:
        raise WsProtocolError(1002, "reserved bits set")
    fin, opcode = bool(b0 & 0x80), b0 & 0x0F
    masked, n = bool(b1 & 0x80), b1 & 0x7F
    if n == 126:
        (n,) = struct.unpack(">H", await reader.readexactly(2))
    elif n == 127:
        (n,) = struct.unpack(">Q", await reader.readexactly(8))
    if opcode >= 0x8 and (n > 125 or not fin):
        raise WsProtocolError(1002, "control frames must be short and unfragmented")
    if require_mask and not masked:
        raise WsProtocolError(1002, "client frames must be masked")
    if n > max_size:
        raise WsProtocolError(1009, "message too big")
    mask = await reader.readexactly(4) if masked else None
    payload = await reader.readexactly(n) if n else b""
    return fin, opcode, apply_mask(payload, mask) if mask else payload


class MessageAssembler:
    """Turns frames into whole messages: joins fragments and passes control frames through."""

    def __init__(self, max_size: int = MAX_CLIENT_MESSAGE):
        self.max_size = max_size
        self._opcode = None
        self._parts = []
        self._size = 0

    def feed(self, fin: bool, opcode: int, payload: bytes):
        """Return ("text", str), ("binary", bytes), ("ping"|"pong", bytes),
        ("close", code, reason) or None while a fragmented message is still incomplete."""
        if opcode == OP_PING:
            return ("ping", payload)
        if opcode == OP_PONG:
            return ("pong", payload)
        if opcode == OP_CLOSE:
            if not payload:
                return ("close", 1005, "")
            if len(payload) == 1:
                raise WsProtocolError(1002, "bad close frame")
            return ("close", struct.unpack(">H", payload[:2])[0], payload[2:].decode("utf-8", "replace"))
        if opcode in (OP_TEXT, OP_BINARY):
            if self._opcode is not None:
                raise WsProtocolError(1002, "new message inside a fragmented one")
            self._opcode, self._parts, self._size = opcode, [], 0
        elif opcode == OP_CONT:
            if self._opcode is None:
                raise WsProtocolError(1002, "continuation frame without a message")
        else:
            raise WsProtocolError(1002, f"unknown opcode {opcode}")
        self._size += len(payload)
        if self._size > self.max_size:
            raise WsProtocolError(1009, "message too big")
        self._parts.append(payload)
        if not fin:
            return None
        data, kind = b"".join(self._parts), self._opcode
        self._opcode, self._parts, self._size = None, [], 0
        if kind == OP_BINARY:
            return ("binary", data)
        try:
            return ("text", data.decode("utf-8"))
        except UnicodeDecodeError:
            raise WsProtocolError(1007, "text message is not UTF-8") from None


# ---------------------------------------------------------------- HTTP helpers

# Explicit, so the Windows registry cannot turn .js into text/plain.
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".woff2": "font/woff2",
}


def content_type(path) -> str:
    return CONTENT_TYPES.get(Path(path).suffix.lower(), "application/octet-stream")


def resolve_static(root: Path, url_path: str) -> Path | None:
    """Map a URL path to a file inside root, or None if it is missing, a folder or outside root."""
    try:
        path = unquote(url_path, errors="strict")
    except UnicodeDecodeError:
        return None
    # backslashes and colons are Windows path syntax (separators, drives, data streams), never URL syntax
    if any(ch in path for ch in "\0\\:"):
        return None
    parts = [p for p in path.split("/") if p not in ("", ".")]
    if not parts or ".." in parts:
        return None
    root = Path(root).resolve()
    try:
        real = root.joinpath(*parts).resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    if not real.is_relative_to(root) or not real.is_file():
        return None
    return real


def parse_request(head: bytes):
    """Split an HTTP/1.x request head into (method, target, headers) or return None if malformed.

    Header names are lower-cased; repeated headers are joined with ", ".
    """
    lines = head.decode("latin-1").split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) != 3 or not parts[2].startswith("HTTP/1.") or not parts[1]:
        return None
    method, target, _ = parts
    headers = {}
    for line in lines[1:]:
        if not line:
            continue
        name, sep, value = line.partition(":")
        if not sep or not name or name != name.strip():
            return None
        name, value = name.lower(), value.strip()
        headers[name] = f"{headers[name]}, {value}" if name in headers else value
    return method, target, headers


def _tokens(value: str) -> set[str]:
    return {t.strip().lower() for t in value.split(",") if t.strip()}


def _valid_ws_key(key: str) -> bool:
    try:
        return len(base64.b64decode(key, validate=True)) == 16
    except (binascii.Error, ValueError):
        return False


async def _respond(writer, status: int, body: bytes = b"", ctype: str = "text/plain; charset=utf-8",
                   headers=(), head_only: bool = False) -> None:
    lines = [f"HTTP/1.1 {status} {HTTPStatus(status).phrase}"]
    if status != 204:
        lines += [f"Content-Type: {ctype}", f"Content-Length: {len(body)}"]
    lines += ["Cache-Control: no-store", "X-Content-Type-Options: nosniff", "Connection: close", *headers]
    writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
    if body and not head_only and status != 204:
        writer.write(body)
    await writer.drain()


async def _respond_error(writer, status: int, headers=()) -> None:
    await _respond(writer, status, f"{status} {HTTPStatus(status).phrase}\n".encode(), headers=headers)


# ---------------------------------------------------------------- sockets


class PortInUseError(RuntimeError):
    """A port the game needs is taken by another program."""


def _is_in_use(exc: OSError) -> bool:
    codes = {errno.EADDRINUSE, errno.EACCES, 10048, 10013}  # 10048/10013: WSAEADDRINUSE/WSAEACCES
    return exc.errno in codes or getattr(exc, "winerror", None) in codes


def bind_exclusive(kind: int, host: str, port: int, in_use_message: str) -> socket.socket:
    """Bind a socket nobody else can share or steal; raise PortInUseError if the port is taken."""
    sock = socket.socket(socket.AF_INET, kind)
    try:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        elif kind == socket.SOCK_STREAM:
            # POSIX only: lets a restart reuse a listening port stuck in TIME_WAIT (no sharing there)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
    except OSError as exc:
        sock.close()
        if _is_in_use(exc):
            raise PortInUseError(in_use_message) from exc
        raise
    sock.setblocking(False)
    return sock


class _TimerResolution:
    """Ask Windows for 1 ms timer ticks so 60 Hz sleeps are not rounded up to 15.6 ms steps."""

    def __init__(self):
        self.active = False

    def set(self, fine: bool) -> None:
        if sys.platform != "win32" or fine == self.active:
            return
        try:
            winmm = ctypes.WinDLL("winmm")
            (winmm.timeBeginPeriod if fine else winmm.timeEndPeriod)(1)
            self.active = fine
        except (OSError, AttributeError):
            pass


def osc_framing_ok(data: bytes, depth: int = 0) -> bool:
    """True if every bundle element size in the packet is sane (the same rule as iter_messages).

    tuio_receiver.iter_messages refuses bad sizes and deep nesting itself, but it is a generator:
    a packet that turns out bad halfway would leave its first messages applied. Checking the whole
    packet first means a bad packet changes nothing.
    """
    if not data.startswith(b"#bundle\0"):
        return True
    if depth > 8 or len(data) < 16:
        return False
    pos = 16
    # same loop condition as iter_messages: up to 3 trailing pad bytes are tolerated, as the
    # floor tools that were checked on site tolerate them
    while pos + 4 <= len(data):
        (size,) = struct.unpack_from(">i", data, pos)
        pos += 4
        if size < 0 or pos + size > len(data) or not osc_framing_ok(data[pos:pos + size], depth + 1):
            return False
        pos += size
    return True


def _dumps(msg: dict) -> bytes:
    return json.dumps(msg, separators=(",", ":")).encode("utf-8")


def _printable(value, limit: int) -> str:
    """Printable characters only, at most `limit`: client text goes straight to the operator's console."""
    return "".join(ch for ch in str(value or "") if ch.isprintable())[:limit]


def is_loopback(host: str) -> bool:
    """True for this PC's own addresses (127.x, ::1); an unknown peer counts as local."""
    try:
        return ipaddress.ip_address(host.split("%", 1)[0]).is_loopback
    except ValueError:
        return True


# ---------------------------------------------------------------- server


class _WsClient:
    """One WebSocket peer with its own bounded send queue, drained by its own writer task."""

    def __init__(self, writer: asyncio.StreamWriter, peer):
        self.writer = writer
        self.peer = f"{peer[0]}:{peer[1]}" if isinstance(peer, tuple) else str(peer)
        self.host = str(peer[0]) if isinstance(peer, tuple) else ""
        self.queue: asyncio.Queue = asyncio.Queue(SEND_QUEUE_MAX)
        self.declared = False   # sent a "client" message
        self.role = None        # the role it declared (None: it did not say)
        self.audio = None
        self.closing = False
        self.dropped = False
        self.drop_reason = "it could not keep up"
        self.beats = False       # sent a "beat": from then on, silence means it is gone
        self.last_heard = 0.0    # server clock (ms) of the last frame received from it
        self.writer_task = None

    @property
    def name(self) -> str:
        """How the console names this page: its role, plus its address when it is on another PC
        (the wall PC), so the operator sees where a screen connected from."""
        if not self.declared:
            return f"unnamed page at {self.peer}"
        label = self.role or "unnamed page"
        return label if is_loopback(self.host) else f"{label} at {self.host}"

    def send(self, frame: bytes) -> None:
        """Queue a frame without ever waiting; a client whose queue is full is dropped."""
        if self.closing:
            return
        try:
            self.queue.put_nowait(frame)
        except asyncio.QueueFull:
            self.drop()

    def send_close(self, code: int, reason: str = "") -> None:
        """Queue a close frame; the writer stops after sending it."""
        if self.closing:
            return
        self.closing = True
        try:
            self.queue.put_nowait(close_frame(code, reason))
            self.queue.put_nowait(None)
        except asyncio.QueueFull:
            self.drop()

    def drop(self) -> None:
        self.closing = True
        self.dropped = True
        self.writer.transport.abort()

    async def run_writer(self) -> None:
        try:
            while True:
                frame = await self.queue.get()
                if frame is None:
                    return
                self.writer.write(frame)
                await self.writer.drain()
        except (ConnectionError, OSError):
            pass


class _TuioProtocol(asyncio.DatagramProtocol):
    def __init__(self, server: "GameServer"):
        self.server = server

    def datagram_received(self, data, addr):
        self.server._on_datagram(data, addr)

    def error_received(self, exc):
        log.debug("TUIO socket error: %s", exc)


class GameServer:
    """Runs the TUIO endpoint, the HTTP + WebSocket hub and the game loop on the current loop.

    `await start()` binds the ports (raising PortInUseError with a plain explanation if one is
    taken) and starts the loop; `await stop()` closes everything. Port 0 in cfg picks a free
    port; the real ones are in `tuio_port` and `http_port` after start().
    """

    def __init__(self, cfg: dict, engine, tracker, *, clock=now_ms, web_dir=WEB_DIR, on_event=None):
        self.engine = engine
        self.tracker = tracker
        self.clock = clock
        self.web_dir = Path(web_dir)
        self.on_event = on_event  # called with each engine event dict (run.py prints round results)
        tuio, http = cfg.get("tuio", {}), cfg.get("http", {})
        self.tuio_host, self.tuio_port = tuio.get("host", "0.0.0.0"), int(tuio.get("port", 3333))
        self.http_host, self.http_port = http.get("host", "127.0.0.1"), int(http.get("port", 8080))
        self.ticks = 0
        self.packets = 0
        self._clients: set[_WsClient] = set()
        self._conn_tasks: set[asyncio.Task] = set()
        # The tracker reads the whole live table after each packet, so per-cursor callbacks are not needed.
        self._tuio_state = tuio_receiver.TuioState(lambda *_event: None)
        self._addresses = set()
        self._bad_packets = 0
        self._http_server = None
        self._udp = None
        self._loop_task = None
        self._hint = None
        self._timer = _TimerResolution()
        self._last_error = (None, 0.0)

    # ------------------------------------------------------------ lifecycle

    @property
    def page_url(self) -> str:
        return f"http://{self._local_host()}:{self.http_port}/floor.html"

    @property
    def scoreboard_url(self) -> str:
        return f"http://{self._local_host()}:{self.http_port}/scoreboard.html"

    def _local_host(self) -> str:
        return "127.0.0.1" if self.http_host in ("", "0.0.0.0") else self.http_host

    @property
    def clients(self) -> list[dict]:
        return [{"peer": c.peer, "role": c.role, "audio": c.audio} for c in self._clients]

    @property
    def screens(self) -> dict[str, int]:
        """Connected pages per declared role, for the state message ("screens"). Pages that never
        said what they are, that are closing, or that beat and then went silent for SILENT_MS (a hung
        page still has an open connection) are not counted."""
        now = self.clock()
        counts = {}
        for client in self._clients:
            if client.role and not client.closing and not (client.beats and now - client.last_heard > SILENT_MS):
                counts[client.role] = counts.get(client.role, 0) + 1
        return dict(sorted(counts.items()))

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        # the web port first: if another copy of the game is running, that is the clearer message
        http_sock = bind_exclusive(
            socket.SOCK_STREAM, self.http_host, self.http_port,
            f"TCP port {self.http_port} (the game page) is already in use or reserved by Windows. "
            f"Is Stomp the Mole already running in another window? Close it and start again, "
            f"or set another http.port in config.json (and the same port as GAME_PORT in "
            f"Start Walls.bat on the wall PC).")
        try:
            udp_sock = bind_exclusive(
                socket.SOCK_DGRAM, self.tuio_host, self.tuio_port,
                f"UDP port {self.tuio_port} (TUIO touches from the floor) is already in use. "
                f"Close tuio_floor_map.py or tuio_receiver.py if one is still running "
                f"(or another copy of Stomp the Mole), then start again.")
        except BaseException:
            http_sock.close()
            raise
        self.http_port = http_sock.getsockname()[1]
        self.tuio_port = udp_sock.getsockname()[1]
        try:
            self._http_server = await asyncio.start_server(self._on_connection, sock=http_sock)
            self._udp, _ = await loop.create_datagram_endpoint(lambda: _TuioProtocol(self), sock=udp_sock)
        except BaseException:
            if self._http_server:
                self._http_server.close()
            http_sock.close()
            udp_sock.close()
            raise
        self._timer.set(True)
        self._loop_task = asyncio.create_task(self._game_loop(), name="game-loop")
        self._hint = loop.call_later(NO_TUIO_HINT_S, self._no_tuio_hint)
        log.info("Listening for floor touches (TUIO) on UDP port %d", self.tuio_port)
        log.info("Game page: %s   (feed test page: %s)", self.page_url, self.scoreboard_url)

    async def stop(self) -> None:
        if self._hint:
            self._hint.cancel()
        if self._loop_task:
            self._loop_task.cancel()
            await asyncio.gather(self._loop_task, return_exceptions=True)
        if self._udp:
            self._udp.close()
        if self._http_server:
            self._http_server.close()
        clients = list(self._clients)
        for client in clients:
            client.send_close(1001, "server stopping")
        writers = [c.writer_task for c in clients if c.writer_task]
        if writers:
            await asyncio.wait(writers, timeout=0.5)
        tasks = list(self._conn_tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self._http_server:
            try:
                await asyncio.wait_for(self._http_server.wait_closed(), 2)
            except TimeoutError:
                pass
        self._timer.set(False)

    # ------------------------------------------------------------ game loop

    async def _game_loop(self) -> None:
        loop = asyncio.get_running_loop()
        period = 1.0 / TICK_HZ
        next_tick = loop.time()
        while True:
            self._tick()
            next_tick += period
            delay = next_tick - loop.time()
            if delay < -0.25:  # far behind (debugger, sleep): restart the schedule, do not catch up
                next_tick, delay = loop.time(), 0.0
            await asyncio.sleep(max(0.0, delay))

    def _tick(self) -> None:
        now = self.clock()
        try:
            for contact in self.tracker.tick(now):
                self._apply_contact(contact, now)
            self.engine.update(now)
            self._flush_events(now)
            if self.ticks % STATE_EVERY_TICKS == 0 and self._clients:
                self._broadcast(self._state_message(now))
            if self.ticks % TICK_HZ == 0:
                self._drop_silent(now)
        except Exception:
            self._report_error("game loop")
        self.ticks += 1

    def _apply_contact(self, contact: tuple, now: float) -> None:
        kind, cid = contact[0], contact[1]
        if kind == "down":
            self.engine.touch_down(cid, contact[2], contact[3], now)
        elif kind == "move":
            self.engine.touch_move(cid, contact[2], contact[3], now)
        elif kind == "up":
            self.engine.touch_up(cid, now)

    def _flush_events(self, now: float) -> None:
        for event in self.engine.drain_events():
            msg = {"type": "event", "now": now}
            msg.update(event)
            msg["type"] = "event"
            self._broadcast(msg)
            if self.on_event:
                try:
                    self.on_event(event)
                except Exception:  # a reporting problem must never hold back the feed
                    self._report_error("event report")

    def _state_message(self, now: float) -> dict:
        msg = {"type": "state", "now": now}
        msg.update(self.engine.snapshot(now))
        msg["type"] = "state"
        msg["screens"] = self.screens  # the server's to say, not the engine's (the floor's "auto" HUD reads it)
        return msg

    def _drop_silent(self, now: float) -> None:
        """Drop pages that beat and then went silent for DEAD_MS (checked once a second)."""
        for client in list(self._clients):
            if client.beats and not client.closing and now - client.last_heard > DEAD_MS:
                client.drop_reason = f"nothing was heard from it for {DEAD_MS // 1000} s"
                client.drop()

    def _broadcast(self, msg: dict) -> None:
        if not self._clients:
            return
        frame = encode_frame(_dumps(msg))
        for client in list(self._clients):
            client.send(frame)

    def _report_error(self, where: str) -> None:
        """Log a crash in game code without stopping the game or flooding the console."""
        kind = sys.exc_info()[0]
        last_kind, last_at = self._last_error
        now = time.monotonic()
        if kind is not last_kind or now - last_at > 10:
            log.exception("Error in the %s (the game keeps running)", where)
            self._last_error = (kind, now)

    # ------------------------------------------------------------ TUIO input

    def _on_datagram(self, data: bytes, addr) -> None:
        self.packets += 1
        if self.packets == 1:
            log.info("First touch data (TUIO) received from %s", addr[0])
        now = self.clock()
        cursors_seen = False
        try:
            if not osc_framing_ok(data):
                raise ValueError("bad bundle framing")
            for address, args in tuio_receiver.iter_messages(data):
                self._note_address(address)
                if address == TUIO_CURSOR:
                    self._tuio_state.handle(address, args)
                    cursors_seen = True
        except (ValueError, struct.error, IndexError):
            self._bad_packets += 1
            if self._bad_packets in (1, 10, 100) or self._bad_packets % 1000 == 0:
                log.warning("Ignored a malformed TUIO packet from %s (%d so far)", addr[0], self._bad_packets)
        except Exception:
            self._report_error("touch input")
        if not cursors_seen:
            return
        try:
            # The whole bundle is in: alive / set order and session ids no longer matter. Applied at
            # once (not on the next tick) so a stomp reaches the screens without delay.
            live = self._tuio_state.live.get(TUIO_CURSOR, {})
            for contact in self.tracker.on_frame([touch.fields for touch in live.values()], now):
                self._apply_contact(contact, now)
            self._flush_events(now)
        except Exception:
            self._report_error("touch handling")

    def _note_address(self, address: str) -> None:
        if address in self._addresses or len(self._addresses) > 256:
            return
        self._addresses.add(address)
        if address == TUIO_CURSOR:
            log.info("TUIO: receiving touches on %s", address)
        else:
            shown = "".join(ch for ch in address if ch.isprintable())[:80]
            log.info("TUIO: ignoring %r (only %s touches are used)", shown, TUIO_CURSOR)

    def _no_tuio_hint(self) -> None:
        if self.packets == 0:
            log.warning("No touch data yet. Check that Interactive Platform is open and sending TUIO "
                        "to UDP port %d.", self.tuio_port)

    # ------------------------------------------------------------ HTTP and WebSocket

    async def _on_connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        self._conn_tasks.add(task)
        try:
            await self._serve_http(reader, writer)
        except (ConnectionError, asyncio.IncompleteReadError, TimeoutError):
            pass
        except Exception:
            log.exception("Error while serving a web request")
        finally:
            self._conn_tasks.discard(task)
            writer.close()

    async def _serve_http(self, reader, writer) -> None:
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), HTTP_HEAD_TIMEOUT_S)
        except asyncio.LimitOverrunError:
            await _respond_error(writer, 431)
            return
        request = parse_request(head)
        if request is None:
            await _respond_error(writer, 400)
            return
        method, target, headers = request
        path = target.split("?", 1)[0].split("#", 1)[0]
        if not path.startswith("/"):
            await _respond_error(writer, 400)
            return
        if path == "/ws":
            if method == "GET" and "websocket" in _tokens(headers.get("upgrade", "")):
                await self._serve_websocket(reader, writer, headers)
            else:
                await _respond_error(writer, 426, headers=("Upgrade: websocket",))
            return
        if method not in ("GET", "HEAD"):
            await _respond_error(writer, 405, headers=("Allow: GET, HEAD",))
            return
        if path == "/":
            await _respond(writer, 302, b"", headers=("Location: /floor.html",))
            return
        file = resolve_static(self.web_dir, path)
        if file is None:
            if path == "/favicon.ico":  # browsers ask on their own; "no content" keeps their console quiet
                await _respond(writer, 204)
            else:
                await _respond_error(writer, 404)
            return
        try:
            body = file.read_bytes()
        except OSError:
            await _respond_error(writer, 404)
            return
        await _respond(writer, 200, body, content_type(file), head_only=(method == "HEAD"))

    async def _serve_websocket(self, reader, writer, headers: dict) -> None:
        key = headers.get("sec-websocket-key", "")
        if headers.get("sec-websocket-version", "") != "13":
            await _respond_error(writer, 426, headers=("Sec-WebSocket-Version: 13",))
            return
        if not _valid_ws_key(key) or "upgrade" not in _tokens(headers.get("connection", "")):
            await _respond_error(writer, 400)
            return
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {accept_key(key)}\r\n\r\n").encode("ascii"))
        client = _WsClient(writer, writer.get_extra_info("peername"))
        client.last_heard = self.clock()
        client.writer_task = asyncio.create_task(client.run_writer())
        self._clients.add(client)
        log.debug("WebSocket opened by %s", client.peer)
        try:
            now = self.clock()
            client.send(encode_frame(_dumps({"type": "hello", "now": round(now, 1),
                                             "config": self.engine.public_config()})))
            client.send(encode_frame(_dumps(self._state_message(now))))
            await self._read_client(reader, client)
        finally:
            self._clients.discard(client)
            if client.closing and not client.dropped:
                await asyncio.wait([client.writer_task], timeout=1.0)  # let the close frame go out
            client.writer_task.cancel()
            await asyncio.gather(client.writer_task, return_exceptions=True)
            if client.dropped:
                log.warning("Screen dropped because %s: %s", client.drop_reason, client.name)
            else:
                log.info("Screen disconnected: %s", client.name)

    async def _read_client(self, reader, client: _WsClient) -> None:
        assembler = MessageAssembler()
        while True:
            try:
                frame = await read_frame(reader)
                client.last_heard = self.clock()   # any frame is a sign of life
                message = assembler.feed(*frame)
            except WsProtocolError as exc:
                log.debug("Closing %s: %s", client.peer, exc.reason)
                client.send_close(exc.code, exc.reason)
                return
            if message is None:
                continue
            kind = message[0]
            if kind == "text":
                self._on_client_text(client, message[1])
            elif kind == "ping":
                client.send(encode_frame(message[1], OP_PONG))
            elif kind == "close":
                code = message[1]
                client.send_close(1000 if code in (1005, 1006, 1015) else code)
                return
            # binary messages and pongs carry nothing for us

    def _on_client_text(self, client: _WsClient, text: str) -> None:
        try:
            msg = json.loads(text)
        except ValueError:
            return
        if not isinstance(msg, dict):
            return
        if msg.get("type") == "beat":
            client.beats = True  # it beats: from now on its silence counts (SILENT_MS, DEAD_MS)
            return
        if msg.get("type") != "client":
            return  # unknown messages are ignored
        role = _printable(msg.get("role"), 40) or None
        audio = _printable(msg.get("audio"), 20) or "unknown"
        sound = {"running": "sound on", "none": "no sound",
                 "suspended": "sound BLOCKED by the browser"}.get(audio, f"sound {audio}")
        if not client.declared or role != client.role:
            client.declared, client.role, client.audio = True, role, audio
            log.info("Screen connected: %s (%s)", client.name, sound)
        elif audio != client.audio:
            client.audio = audio
            log.info("Screen %s: %s", client.name, sound)
        else:
            return
        if audio == "suspended":
            log.warning("The %s page cannot play sound. Start the game with 'Start Stomp the Mole.bat' "
                        "so the browser is opened with autoplay allowed.", client.name)
