"""Tests for the network side: WebSocket framing, static files, and a real server on free ports.

Most tests use stand-in engine and tracker objects, so they need no game logic. The last test
runs the real game modules end to end (TUIO packet in, feed events out).
"""

import asyncio
import base64
import json
import logging
import os
import socket
import struct
import time

import pytest

from fake_floor import osc_bundle, osc_message, tuio_frame
from stomp_the_mole import netserver
from stomp_the_mole.netserver import (OP_BINARY, OP_CLOSE, OP_CONT, OP_PING, OP_PONG, OP_TEXT,
                                      GameServer, MessageAssembler, PortInUseError, WsProtocolError,
                                      accept_key, apply_mask, content_type, encode_frame,
                                      osc_framing_ok, parse_request, read_frame, resolve_static)

LOCAL = {"tuio": {"host": "127.0.0.1", "port": 0}, "http": {"host": "127.0.0.1", "port": 0}}


# ---------------------------------------------------------------- WebSocket protocol


def test_accept_key_matches_rfc_example():
    assert accept_key("dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="


def test_unmasked_hello_frame_matches_rfc_example():
    assert encode_frame(b"Hello") == bytes([0x81, 0x05, 0x48, 0x65, 0x6C, 0x6C, 0x6F])


def test_masked_hello_frame_matches_rfc_example():
    frame = bytes([0x81, 0x85, 0x37, 0xFA, 0x21, 0x3D, 0x7F, 0x9F, 0x4D, 0x51, 0x58])
    assert encode_frame(b"Hello", mask=bytes([0x37, 0xFA, 0x21, 0x3D])) == frame
    assert asyncio.run(_read(frame)) == (True, OP_TEXT, b"Hello")


@pytest.mark.parametrize("n, length_bytes", [
    (0, bytes([0])), (125, bytes([125])),
    (126, bytes([126]) + struct.pack(">H", 126)), (65535, bytes([126]) + struct.pack(">H", 65535)),
    (65536, bytes([127]) + struct.pack(">Q", 65536)), (70000, bytes([127]) + struct.pack(">Q", 70000)),
])
def test_server_frames_are_unmasked_with_7_16_or_64_bit_lengths(n, length_bytes):
    payload = os.urandom(n)
    frame = encode_frame(payload)
    assert frame[0] == 0x81  # FIN + text
    assert frame[1:1 + len(length_bytes)] == length_bytes  # mask bit clear
    assert frame[1 + len(length_bytes):] == payload


@pytest.mark.parametrize("n", [0, 1, 5, 125, 126, 127, 65535, 65536, 100_000])
def test_masked_client_frames_decode_at_every_length(n):
    payload = os.urandom(n)
    frame = encode_frame(payload, OP_BINARY, mask=os.urandom(4))
    assert frame[1] & 0x80
    assert asyncio.run(_read(frame, max_size=200_000)) == (True, OP_BINARY, payload)


def test_mask_is_its_own_inverse():
    data, mask = os.urandom(1001), os.urandom(4)
    assert apply_mask(apply_mask(data, mask), mask) == data
    assert apply_mask(b"\x00\x00\x00\x00\x00", b"\x01\x02\x03\x04") == b"\x01\x02\x03\x04\x01"


def test_unmasked_client_frame_is_a_protocol_error():
    with pytest.raises(WsProtocolError) as err:
        asyncio.run(_read(encode_frame(b"hi")))
    assert err.value.code == 1002


def test_bad_frames_are_refused():
    with pytest.raises(WsProtocolError) as err:  # control frames are at most 125 bytes
        asyncio.run(_read(encode_frame(b"x" * 126, OP_PING, mask=b"abcd")))
    assert err.value.code == 1002
    with pytest.raises(WsProtocolError) as err:  # fragmented control frame
        asyncio.run(_read(encode_frame(b"x", OP_PING, fin=False, mask=b"abcd")))
    assert err.value.code == 1002
    with pytest.raises(WsProtocolError) as err:  # reserved bits
        asyncio.run(_read(bytes([0xC1]) + encode_frame(b"x", mask=b"abcd")[1:]))
    assert err.value.code == 1002
    with pytest.raises(WsProtocolError) as err:
        asyncio.run(_read(encode_frame(b"x" * 2000, mask=b"abcd"), max_size=1000))
    assert err.value.code == 1009


def test_assembler_joins_fragments_and_passes_control_frames_through():
    asm = MessageAssembler()
    assert asm.feed(False, OP_TEXT, b'{"a":') is None
    assert asm.feed(True, OP_PING, b"p") == ("ping", b"p")  # allowed between fragments
    assert asm.feed(False, OP_CONT, b" 1") is None
    assert asm.feed(True, OP_CONT, b"}") == ("text", '{"a": 1}')
    assert asm.feed(True, OP_BINARY, b"\x00") == ("binary", b"\x00")
    assert asm.feed(True, OP_PONG, b"") == ("pong", b"")
    assert asm.feed(True, OP_CLOSE, struct.pack(">H", 1001) + b"bye") == ("close", 1001, "bye")
    assert asm.feed(True, OP_CLOSE, b"") == ("close", 1005, "")


@pytest.mark.parametrize("frames, code", [
    ([(True, OP_CONT, b"x")], 1002),                              # continuation with nothing to continue
    ([(False, OP_TEXT, b"a"), (True, OP_TEXT, b"b")], 1002),      # new message inside a fragmented one
    ([(True, 0x3, b"")], 1002),                                   # unknown opcode
    ([(True, OP_TEXT, b"\xff\xfe")], 1007),                       # text that is not UTF-8
    ([(True, OP_CLOSE, b"\x03")], 1002),                          # 1-byte close payload
    ([(False, OP_TEXT, b"a" * 600), (True, OP_CONT, b"a" * 600)], 1009),
])
def test_assembler_rejects_broken_sequences(frames, code):
    asm = MessageAssembler(max_size=1000)
    with pytest.raises(WsProtocolError) as err:
        for frame in frames:
            asm.feed(*frame)
    assert err.value.code == code


async def _read(data, **kw):
    reader = asyncio.StreamReader()
    reader.feed_data(data)
    reader.feed_eof()
    return await read_frame(reader, **kw)


# ---------------------------------------------------------------- HTTP helpers


@pytest.fixture
def web_root(tmp_path):
    web = tmp_path / "web"
    (web / "sub").mkdir(parents=True)
    (web / "floor.html").write_text("<title>Stomp the Mole</title>", encoding="utf-8")
    (web / "floor.js").write_text("console.log(1)", encoding="utf-8")
    (web / "sub" / "a.css").write_text("body{}", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("top secret", encoding="utf-8")
    return web


def test_static_paths_inside_web_resolve(web_root):
    assert resolve_static(web_root, "/floor.html") == (web_root / "floor.html").resolve()
    assert resolve_static(web_root, "/sub/a.css") == (web_root / "sub" / "a.css").resolve()
    assert resolve_static(web_root, "/./floor.js") == (web_root / "floor.js").resolve()
    assert resolve_static(web_root, "/floor%2Ejs") == (web_root / "floor.js").resolve()


@pytest.mark.parametrize("path", [
    "/../secret.txt", "/sub/../../secret.txt", "/%2e%2e/secret.txt", "/%2E%2E%2Fsecret.txt",
    "/..%2fsecret.txt", "/..\\secret.txt", "/%5c..%5csecret.txt", "/sub%5c..%5c..%5csecret.txt",
    "/C:/Windows/win.ini", "/c:%5cwindows%5cwin.ini", "//etc/passwd", "/floor.html%00.js",
    "/floor.html::$DATA", "/%ff%fe", "/", "/sub", "/sub/", "/missing.html", "/NUL", "/con",
])
def test_static_traversal_and_odd_paths_are_rejected(web_root, path):
    assert resolve_static(web_root, path) is None


@pytest.mark.parametrize("name, expected", [
    ("floor.html", "text/html; charset=utf-8"),
    ("floor.js", "text/javascript; charset=utf-8"),
    ("FEED.JS", "text/javascript; charset=utf-8"),
    ("style.css", "text/css; charset=utf-8"),
    ("data.json", "application/json"),
    ("icon.svg", "image/svg+xml"),
    ("pic.png", "image/png"),
    ("blob.bin", "application/octet-stream"),
    ("noext", "application/octet-stream"),
])
def test_content_types(name, expected):
    assert content_type(name) == expected


def test_parse_request():
    head = b"GET /ws?x=1 HTTP/1.1\r\nHost: a\r\nUpgrade: WebSocket\r\nX-A: 1\r\nx-a: 2\r\n\r\n"
    method, target, headers = parse_request(head)
    assert (method, target) == ("GET", "/ws?x=1")
    assert headers["upgrade"] == "WebSocket" and headers["x-a"] == "1, 2"
    assert parse_request(b"GARBAGE\r\n\r\n") is None
    assert parse_request(b"GET / HTTP/1.1\r\nNoColonHere\r\n\r\n") is None


# ---------------------------------------------------------------- a real server on free ports


class StubEngine:
    """Records touches; every down produces an empty_stomp event, like a stomp on an empty hole."""

    def __init__(self, snapshot_padding=0):
        self.touches, self.events, self.updates = [], [], 0
        self.padding = "x" * snapshot_padding

    def touch_down(self, cid, x, y, now):
        self.touches.append(("down", cid, x, y))
        self.events.append({"type": "event", "now": now, "name": "empty_stomp", "hole": 0, "x": x, "y": y})

    def touch_move(self, cid, x, y, now):
        self.touches.append(("move", cid, x, y))

    def touch_up(self, cid, now):
        self.touches.append(("up", cid))

    def update(self, now):
        self.updates += 1

    def drain_events(self):
        events, self.events = self.events, []
        return events

    def snapshot(self, now):
        return {"type": "state", "now": now, "phase": "attract", "score": 0, "padding": self.padding}

    def public_config(self):
        return {"floor": {"width": 560, "height": 448}}


class StubTracker:
    """Records every frame; each position that appears is a down, each that goes is an up."""

    def __init__(self):
        self.frames, self.ticks = [], 0
        self._ids, self._next = {}, 1

    def on_frame(self, points, now):
        pts = [(p["x"], p["y"]) for p in points]
        self.frames.append(pts)
        out = [("up", self._ids.pop(p)) for p in list(self._ids) if p not in pts]
        for p in pts:
            if p not in self._ids:
                self._ids[p], self._next = self._next, self._next + 1
                out.append(("down", self._ids[p], p[0] * 560, p[1] * 448))
        return out

    def tick(self, now):
        self.ticks += 1
        return []


async def ws_connect(port):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    key = base64.b64encode(os.urandom(16)).decode()
    writer.write((f"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
                  f"Connection: keep-alive, Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                  f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
    head = (await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 2)).decode()
    assert head.startswith("HTTP/1.1 101"), head
    assert f"Sec-WebSocket-Accept: {accept_key(key)}" in head
    return reader, writer


async def recv(reader, timeout=2.0):
    """Next frame from the server as (opcode, payload); text payloads are parsed JSON."""
    fin, opcode, payload = await asyncio.wait_for(
        read_frame(reader, require_mask=False, max_size=1 << 24), timeout)
    assert fin
    return opcode, json.loads(payload) if opcode == OP_TEXT else payload


async def recv_until(reader, predicate, timeout=3.0):
    deadline = time.monotonic() + timeout
    while True:
        opcode, msg = await recv(reader, max(0.05, deadline - time.monotonic()))
        if opcode == OP_TEXT and predicate(msg):
            return msg


async def http(port, target, method="GET"):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(f"{method} {target} HTTP/1.1\r\nHost: x\r\n\r\n".encode())
    data = await asyncio.wait_for(reader.read(), 2)
    writer.close()
    head, _, body = data.partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    headers = dict(line.split(": ", 1) for line in lines[1:])
    return int(lines[0].split()[1]), headers, body


def run_server(test, engine=None, tracker=None, web_dir=None, cfg=LOCAL):
    """Start a server on free ports, run `await test(server, engine, tracker)`, always stop it."""
    engine = engine or StubEngine()
    tracker = tracker or StubTracker()

    async def main():
        server = GameServer(cfg, engine, tracker, web_dir=web_dir or netserver.WEB_DIR)
        await server.start()
        try:
            await test(server, engine, tracker)
        finally:
            await server.stop()

    asyncio.run(main())


def send_udp(port, data):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.sendto(data, ("127.0.0.1", port))


def test_websocket_gets_hello_then_state_then_events_from_tuio():
    async def test(server, engine, tracker):
        reader, writer = await ws_connect(server.http_port)
        _, hello = await recv(reader)
        assert hello["type"] == "hello" and hello["config"]["floor"]["width"] == 560
        assert isinstance(hello["now"], float)
        _, state = await recv(reader)
        assert state["type"] == "state" and state["phase"] == "attract"
        assert state["now"] >= hello["now"] - 0.1  # hello's clock is rounded to 0.1 ms

        # an object-profile packet must not reach the tracker; a cursor bundle is one frame
        send_udp(server.tuio_port, osc_bundle([osc_message("/tuio/2Dobj", "alive", 1)]))
        send_udp(server.tuio_port, tuio_frame("test@here", [(7, 0.5, 0.25)], 1))
        event = await recv_until(reader, lambda m: m["type"] == "event")
        assert event["name"] == "empty_stomp" and event["x"] == pytest.approx(280.0)
        assert engine.touches == [("down", 1, pytest.approx(280.0), pytest.approx(112.0))]
        assert tracker.frames == [[(0.5, 0.25)]]
        assert server.packets == 2

        # cursor gone from the alive list -> an empty frame -> up
        send_udp(server.tuio_port, tuio_frame("test@here", [], 2))
        for _ in range(50):
            if engine.touches[-1] == ("up", 1):
                break
            await asyncio.sleep(0.02)
        assert engine.touches[-1] == ("up", 1)
        assert tracker.frames[-1] == []
        writer.close()

    run_server(test)


def test_state_is_broadcast_at_about_30_hz_and_the_loop_runs_at_60():
    async def test(server, engine, tracker):
        reader, writer = await ws_connect(server.http_port)
        await recv(reader)
        await recv(reader)
        ticks0, t0 = server.ticks, time.monotonic()
        states = 0
        while time.monotonic() - t0 < 1.0:
            opcode, msg = await recv(reader)
            states += msg["type"] == "state"
        rate = (server.ticks - ticks0) / (time.monotonic() - t0)
        assert 25 <= states <= 35, states
        assert 52 <= rate <= 66, rate
        assert tracker.ticks > 0 and engine.updates > 0
        writer.close()

    run_server(test)


def test_ping_fragmented_client_message_and_close(caplog):
    caplog.set_level(logging.INFO, logger="stomp_the_mole.netserver")

    async def test(server, engine, tracker):
        reader, writer = await ws_connect(server.http_port)
        await recv(reader)
        text = json.dumps({"type": "client", "role": "floor", "audio": "running"}).encode()
        writer.write(encode_frame(text[:10], OP_TEXT, fin=False, mask=b"\x01\x02\x03\x04"))
        writer.write(encode_frame(b"are you there", OP_PING, mask=b"\x05\x06\x07\x08"))
        writer.write(encode_frame(text[10:], OP_CONT, mask=b"\x09\x0a\x0b\x0c"))
        writer.write(encode_frame(b'{"type":"something-new"}', mask=b"abcd"))  # ignored
        writer.write(encode_frame(b"not json", mask=b"abcd"))                   # ignored
        while True:
            opcode, payload = await recv(reader)
            if opcode == OP_PONG:
                assert payload == b"are you there"
                break
        for _ in range(50):
            if server.clients and server.clients[0]["role"] == "floor":
                break
            await asyncio.sleep(0.02)
        assert server.clients[0]["role"] == "floor" and server.clients[0]["audio"] == "running"

        writer.write(encode_frame(struct.pack(">H", 1000) + b"bye", OP_CLOSE, mask=b"abcd"))
        while True:
            opcode, payload = await recv(reader)
            if opcode == OP_CLOSE:
                assert struct.unpack(">H", payload[:2])[0] == 1000
                break
        assert await asyncio.wait_for(reader.read(), 2) == b""  # server closed the connection
        for _ in range(50):
            if not server.clients:
                break
            await asyncio.sleep(0.02)
        assert not server.clients

    run_server(test)
    messages = [r.getMessage() for r in caplog.records]
    assert "Screen connected: floor (sound on)" in messages
    assert "Screen disconnected: floor" in messages


HANG_PACKET = b"#bundle\0" + struct.pack(">Q", 1) + struct.pack(">i", -4)  # loops iter_messages forever


def test_bundle_framing_check():
    good = tuio_frame("x@y", [(1, 0.5, 0.5)], 1)
    assert osc_framing_ok(good)
    assert osc_framing_ok(osc_message("/tuio/2Dcur", "fseq", 1))  # a bare message is fine too
    assert not osc_framing_ok(HANG_PACKET)
    assert not osc_framing_ok(good[:-3])  # last element cut short
    assert osc_framing_ok(good + b"\0\0\0")  # trailing pad bytes: tuio_receiver decodes these fine
    nested = osc_message("/tuio/2Dcur", "alive")
    for _ in range(20):
        nested = osc_bundle([nested])
    assert not osc_framing_ok(nested)


def test_each_tuio_bundle_is_one_frame_for_the_real_tracker():
    """Per-cell cursors, ids that swap between feet and set-before-alive bundles: no false downs."""
    from stomp_the_mole.touch_input import TouchTracker

    clock = [1000.0]
    engine = StubEngine()
    server = GameServer(LOCAL, engine, TouchTracker(560, 448), clock=lambda: clock[0])

    def send(cursors, fseq, order="alive-first"):
        clock[0] += 33
        if order == "alive-first":
            data = tuio_frame("t@x", cursors, fseq)
        else:  # set messages before the alive message
            sets = [osc_message("/tuio/2Dcur", "set", sid, x, y, 0.0, 0.0, 0.0) for sid, x, y in cursors]
            data = osc_bundle(sets + [osc_message("/tuio/2Dcur", "alive", *[c[0] for c in cursors]),
                                      osc_message("/tuio/2Dcur", "fseq", fseq)])
        server._on_datagram(data, ("127.0.0.1", 50000))

    # one foot reported as 8 pressed cells (14 px apart), plus a second foot 100 px away
    foot = [(10 + i, (280 + dx) / 560, (244 + dy) / 448)
            for i, (dx, dy) in enumerate((dx, dy) for dx in (-7, 7) for dy in (-21, -7, 7, 21))]
    other = (99, 380 / 560, 244 / 448)
    send(foot + [other], 1)
    assert [t[0] for t in engine.touches] == ["down", "down"]
    assert engine.touches[0][2:] == (pytest.approx(280), pytest.approx(244))

    # every frame the sender hands the ids out again in another order, then relabels set-first
    for fseq in range(2, 12):
        ids = list(range(100 * fseq, 100 * fseq + 9))
        send([(sid, x, y) for sid, (_, x, y) in zip(ids, reversed(foot + [other]))], fseq,
             order="set-first" if fseq % 2 else "alive-first")
    send(foot + [other], 12, order="set-first")
    server._on_datagram(HANG_PACKET, ("127.0.0.1", 50000))  # a bad packet changes nothing either
    assert [t[0] for t in engine.touches] == ["down", "down"]

    # the foot lifts: after the debounce the tracker reports the up on a game-loop tick
    send([other], 13)
    clock[0] += 200
    server._tick()
    assert engine.touches[-1] == ("up", 1)


def test_a_malformed_tuio_packet_does_not_stop_the_game():
    async def test(server, engine, tracker):
        reader, writer = await ws_connect(server.http_port)
        await recv(reader)
        send_udp(server.tuio_port, HANG_PACKET)
        send_udp(server.tuio_port, b"\x00garbage")
        send_udp(server.tuio_port, tuio_frame("test@here", [(3, 0.1, 0.1)], 1))
        event = await recv_until(reader, lambda m: m["type"] == "event")
        assert event["name"] == "empty_stomp" and server.packets == 3
        ticks = server.ticks
        await asyncio.sleep(0.1)
        assert server.ticks > ticks
        writer.close()

    run_server(test)


def test_unmasked_client_frame_gets_close_1002():
    async def test(server, engine, tracker):
        reader, writer = await ws_connect(server.http_port)
        writer.write(encode_frame(b"{}"))  # no mask: not allowed from a client
        while True:
            opcode, payload = await recv(reader)
            if opcode == OP_CLOSE:
                assert struct.unpack(">H", payload[:2])[0] == 1002
                break

    run_server(test)


def test_bad_handshakes_are_refused():
    async def test(server, engine, tracker):
        status, headers, _ = await http(server.http_port, "/ws")  # no Upgrade header
        assert status == 426
        reader, writer = await asyncio.open_connection("127.0.0.1", server.http_port)
        writer.write(b"GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                     b"Sec-WebSocket-Key: short\r\nSec-WebSocket-Version: 13\r\n\r\n")
        assert (await asyncio.wait_for(reader.read(), 2)).startswith(b"HTTP/1.1 400")
        writer.close()

    run_server(test)


def test_slow_client_is_dropped_without_stalling_the_game_loop(caplog):
    caplog.set_level(logging.INFO, logger="stomp_the_mole.netserver")

    async def test(server, engine, tracker):
        reader, writer = await ws_connect(server.http_port)  # ... and then never reads again
        fast_reader, fast_writer = await ws_connect(server.http_port)
        t0, ticks0 = time.monotonic(), server.ticks
        dropped = False
        while time.monotonic() - t0 < 15:
            await recv(fast_reader)  # the healthy client keeps reading
            if len(server.clients) == 1:
                dropped = True
                break
        assert dropped, "the stalled client was never dropped"
        rate = (server.ticks - ticks0) / (time.monotonic() - t0)
        assert rate > 45, f"game loop slowed to {rate:.0f} Hz"
        await recv(fast_reader)  # the healthy client still gets the feed
        writer.close()
        fast_writer.close()

    run_server(test, engine=StubEngine(snapshot_padding=300_000))
    assert any("could not keep up" in r.getMessage() for r in caplog.records)


def test_static_files_over_http(web_root):
    async def test(server, engine, tracker):
        port = server.http_port
        status, headers, body = await http(port, "/floor.html")
        assert status == 200 and body == b"<title>Stomp the Mole</title>"
        assert headers["Content-Type"] == "text/html; charset=utf-8"
        assert headers["Cache-Control"] == "no-store"
        status, headers, _ = await http(port, "/floor.js?v=2")
        assert status == 200 and headers["Content-Type"] == "text/javascript; charset=utf-8"
        status, headers, body = await http(port, "/floor.js", method="HEAD")
        assert status == 200 and body == b"" and headers["Content-Length"] == "14"
        status, headers, _ = await http(port, "/")
        assert status == 302 and headers["Location"] == "/floor.html"
        for target in ("/../secret.txt", "/%2e%2e/secret.txt", "/..%5csecret.txt", "/missing.js"):
            status, _, body = await http(port, target)
            assert status == 404 and b"secret" not in body
        status, _, _ = await http(port, "/favicon.ico")
        assert status == 204
        status, headers, _ = await http(port, "/floor.html", method="POST")
        assert status == 405

    run_server(test, web_dir=web_root)


def test_tuio_port_in_use_names_the_likely_culprit():
    # tuio_receiver.py and tuio_floor_map.py bind with SO_REUSEADDR; the game must refuse to share
    blocker = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    blocker.bind(("127.0.0.1", 0))
    try:
        cfg = {"tuio": {"host": "127.0.0.1", "port": blocker.getsockname()[1]}, "http": LOCAL["http"]}
        server = GameServer(cfg, StubEngine(), StubTracker())
        with pytest.raises(PortInUseError, match="tuio_floor_map.py or tuio_receiver.py"):
            asyncio.run(server.start())
    finally:
        blocker.close()


def test_http_port_in_use_says_so():
    blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    blocker.bind(("127.0.0.1", 0))
    blocker.listen()
    try:
        cfg = {"tuio": LOCAL["tuio"], "http": {"host": "127.0.0.1", "port": blocker.getsockname()[1]}}
        server = GameServer(cfg, StubEngine(), StubTracker())
        with pytest.raises(PortInUseError, match="already running"):
            asyncio.run(server.start())
    finally:
        blocker.close()


def test_real_game_start_pad_over_the_wire():
    """TUIO packets -> TouchTracker -> GameEngine -> feed, with the real modules."""
    import random

    from stomp_the_mole.config import build_config
    from stomp_the_mole.game import GameEngine
    from stomp_the_mole.highscores import HighScores
    from stomp_the_mole.touch_input import TouchTracker

    cfg = build_config({})
    cfg["tuio"] = {**cfg["tuio"], "host": "127.0.0.1", "port": 0}
    cfg["http"] = {**cfg["http"], "host": "127.0.0.1", "port": 0}
    engine = GameEngine(cfg, HighScores(None), random.Random(1), now=netserver.now_ms())
    tracker = TouchTracker(560, 448)

    async def test(server, engine, tracker):
        reader, writer = await ws_connect(server.http_port)
        _, hello = await recv(reader)
        assert len(hello["config"]["holes"]) == 9
        _, state = await recv(reader)
        assert state["phase"] == "attract" and state["start_progress"] == 0

        # stand on the START pad (floor centre) and keep sending frames like the floor does
        pad = (280 / 560, 244 / 448)
        names, fseq = [], 0
        t0 = time.monotonic()
        while "countdown" not in names and time.monotonic() - t0 < 3:
            fseq += 1
            send_udp(server.tuio_port, tuio_frame("test@here", [(1, *pad)], fseq))
            try:
                opcode, msg = await recv(reader, timeout=1 / 30)
            except TimeoutError:
                continue
            if msg["type"] == "event":
                names.append(msg["name"])
            elif msg["phase"] == "attract":
                assert msg["touches"] and msg["touches"][0]["x"] == pytest.approx(280, abs=0.1)
        assert names[:2] == ["start_pad", "countdown"], names
        state = await recv_until(reader, lambda m: m["type"] == "state")
        assert state["phase"] == "countdown" and state["countdown"] == 3
        writer.close()

    run_server(test, engine=engine, tracker=tracker, cfg=cfg)


# ---------------------------------------------------------------- screens: who is connected


def client_message(writer, role=None, audio="none"):
    msg = {"type": "client", "audio": audio}
    if role is not None:
        msg["role"] = role
    writer.write(encode_frame(json.dumps(msg).encode(), OP_TEXT, mask=os.urandom(4)))


def screens_are(expected):
    return lambda m: m["type"] == "state" and m.get("screens") == expected


def test_state_counts_connected_screens_per_declared_role():
    async def test(server, engine, tracker):
        watcher, watcher_w = await ws_connect(server.http_port)  # never says what it is
        _, hello = await recv(watcher)
        assert "screens" not in hello
        _, first = await recv(watcher)
        assert first["type"] == "state" and first["screens"] == {}  # added by the server to every state

        floor_r, floor_w = await ws_connect(server.http_port)
        client_message(floor_w, "floor", "running")
        await recv_until(watcher, screens_are({"floor": 1}))

        room_r, room_w = await ws_connect(server.http_port)
        client_message(room_w, "room")
        room2_r, room2_w = await ws_connect(server.http_port)
        client_message(room2_w, "room")
        nameless_r, nameless_w = await ws_connect(server.http_port)
        client_message(nameless_w)  # a client message without a role is not a role
        await recv_until(watcher, screens_are({"floor": 1, "room": 2}))
        assert server.screens == {"floor": 1, "room": 2}

        room2_w.write(encode_frame(struct.pack(">H", 1000), OP_CLOSE, mask=b"abcd"))  # closes cleanly
        await recv_until(watcher, screens_are({"floor": 1, "room": 1}))
        room_w.close()  # just goes away (the wall PC switched off)
        await recv_until(watcher, screens_are({"floor": 1}))

        # a page may change what it is: it is counted once, under its new role
        client_message(floor_w, "scoreboard")
        await recv_until(watcher, screens_are({"scoreboard": 1}))
        assert len(server.clients) == 3  # the watcher, the scoreboard and the nameless page
        for w in (watcher_w, floor_w, nameless_w):
            w.close()

    run_server(test)


def test_a_page_on_another_pc_is_named_with_its_address(caplog):
    caplog.set_level(logging.INFO, logger="stomp_the_mole.netserver")
    server = GameServer(LOCAL, StubEngine(), StubTracker())
    wall = netserver._WsClient(None, ("192.168.10.78", 50123))
    assert wall.name == "unnamed page at 192.168.10.78:50123"
    server._on_client_text(wall, json.dumps({"type": "client", "role": "room", "audio": "none"}))
    assert wall.name == "room at 192.168.10.78"
    server._on_client_text(wall, json.dumps({"type": "client", "role": "room", "audio": "none"}))  # no news
    local = netserver._WsClient(None, ("127.0.0.1", 50124))
    server._on_client_text(local, json.dumps({"type": "client", "role": "room", "audio": "none"}))
    assert local.name == "room"
    nameless = netserver._WsClient(None, ("192.168.10.78", 50125))
    server._on_client_text(nameless, json.dumps({"type": "client", "audio": "running"}))
    assert nameless.role is None and nameless.name == "unnamed page at 192.168.10.78"
    server._on_client_text(nameless, json.dumps({"type": "client", "audio": "suspended"}))
    assert [r.getMessage() for r in caplog.records][:4] == [
        "Screen connected: room at 192.168.10.78 (no sound)",
        "Screen connected: room (no sound)",
        "Screen connected: unnamed page at 192.168.10.78 (sound on)",
        "Screen unnamed page at 192.168.10.78: sound BLOCKED by the browser",
    ]
    assert netserver.is_loopback("127.0.0.1") and netserver.is_loopback("::1") and netserver.is_loopback("")
    assert not netserver.is_loopback("192.168.10.78")


def test_connect_and_disconnect_lines_show_where_a_wall_page_is(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="stomp_the_mole.netserver")
    monkeypatch.setattr(netserver, "is_loopback", lambda host: False)  # as if 127.0.0.1 were the wall PC

    async def test(server, engine, tracker):
        reader, writer = await ws_connect(server.http_port)
        client_message(writer, "room")
        await recv_until(reader, screens_are({"room": 1}))
        writer.close()
        for _ in range(100):
            if not server.clients:
                break
            await asyncio.sleep(0.02)
        assert not server.clients

    run_server(test)
    messages = [r.getMessage() for r in caplog.records]
    assert "Screen connected: room at 127.0.0.1 (no sound)" in messages
    assert "Screen disconnected: room at 127.0.0.1" in messages


# ---------------------------------------------------------------- heartbeats: a page that hangs


def beat(writer):
    writer.write(encode_frame(b'{"type":"beat"}', OP_TEXT, mask=os.urandom(4)))


def test_a_page_that_beats_and_then_goes_silent_is_uncounted_then_dropped(caplog):
    """A hung wall page (or a frozen wall PC) keeps its connection open; its missing beats give it away.

    The server clock is a stand-in here, so the test does not wait the real 3 s and 10 s."""
    caplog.set_level(logging.INFO, logger="stomp_the_mole.netserver")
    clock = [5_000_000.0]

    async def main():
        server = GameServer(LOCAL, StubEngine(), StubTracker(), clock=lambda: clock[0])
        await server.start()
        try:
            watcher, watcher_w = await ws_connect(server.http_port)   # never says anything: never timed out
            room_r, room_w = await ws_connect(server.http_port)
            client_message(room_w, "room")
            beat(room_w)
            floor_r, floor_w = await ws_connect(server.http_port)     # an older page: declares, never beats
            client_message(floor_w, "floor", "running")
            await recv_until(watcher, screens_are({"floor": 1, "room": 1}))

            # the wall page hangs: nothing more comes from it, but its connection stays open
            clock[0] += netserver.SILENT_MS + 100
            await recv_until(watcher, screens_are({"floor": 1}))   # the floor takes its HUD back
            assert len(server.clients) == 3                          # ... but it is not dropped yet

            beat(room_w)   # it comes back to life: counted again
            await recv_until(watcher, screens_are({"floor": 1, "room": 1}))

            clock[0] += netserver.DEAD_MS + 100   # silent for good: dropped (checked once a second)
            for _ in range(150):
                if len(server.clients) == 2:
                    break
                await asyncio.sleep(0.02)
            assert len(server.clients) == 2
            assert server.screens == {"floor": 1}   # the page that never beat is still counted
            await recv_until(watcher, screens_are({"floor": 1}))
            for w in (watcher_w, room_w, floor_w):
                w.close()
        finally:
            await server.stop()

    asyncio.run(main())
    messages = [r.getMessage() for r in caplog.records]
    assert "Screen dropped because nothing was heard from it for 10 s: room" in messages
    assert not any("could not keep up" in m for m in messages)


def test_any_frame_from_a_beating_page_counts_as_a_sign_of_life():
    clock = [1000.0]
    server = GameServer(LOCAL, StubEngine(), StubTracker(), clock=lambda: clock[0])
    page = netserver._WsClient(None, ("192.168.10.78", 50123))
    server._clients.add(page)
    server._on_client_text(page, json.dumps({"type": "client", "role": "room", "audio": "none"}))
    page.last_heard = clock[0]
    clock[0] += netserver.SILENT_MS + 1
    assert server.screens == {"room": 1}   # it never beat: silence means nothing
    server._on_client_text(page, '{"type":"beat"}')
    assert page.beats and server.screens == {}   # it beats, and has been silent for over SILENT_MS
    page.last_heard = clock[0]
    assert server.screens == {"room": 1}
    server._on_client_text(page, '{"type":"beat", "extra": [1, 2]}')   # extra fields are fine
    server._on_client_text(page, '"beat"')                             # not an object: ignored
    assert server.screens == {"room": 1}
