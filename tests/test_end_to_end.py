"""End to end: the real server, a WebSocket screen and a TUIO "floor", for one short round.

The server is wired exactly as ``python -m stomp_the_mole`` wires it (run.build_server) and runs
in this process on free ports. A bot plays it the way the floor would: it reads the feed through
a raw-socket WebSocket client and sends TUIO 1.1 /tuio/2Dcur bundles (alive / set / fseq) over
UDP, with a fresh session id for every stomp.

Over the round the bot:
  * stands on the START pad until the countdown starts,
  * keeps a foot standing in every hole when play starts, so the first mole rises under a foot
    (it must not score), then lifts them and leaves that mole to escape,
  * stomps every later mole it sees rising or up,
  * stomps one empty hole once, which must reset the combo and leave the score alone.
"""

import asyncio
import base64
import datetime
import hashlib
import json
import logging
import math
import os
import struct

from fake_floor import tuio_frame
from stomp_the_mole import run
from stomp_the_mole.config import build_config
from stomp_the_mole.netserver import now_ms

SEED = 7
ROUND_TIMEOUT_S = 30
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
STOMP_HOLD_S = 0.08


def short_round_config(highscore_file):
    cfg = build_config({
        "tuio": {"host": "127.0.0.1"},
        "http": {"host": "127.0.0.1"},  # the game's default 0.0.0.0 would open the feed to the LAN
        "window": {"mode": "none"},
        "start_pad": {"hold_ms": 300},
        "round": {"countdown_step_ms": 200, "go_ms": 200, "play_ms": 6000, "results_ms": 1000,
                  "time_warning_s": 3},
        "highscores": {"file": str(highscore_file)},
    })
    # port 0 = any free port; the config file itself only allows real ports
    cfg["tuio"]["port"] = cfg["http"]["port"] = 0
    return cfg


# ---------------------------------------------------------------- a screen: raw WebSocket client


class FeedClient:
    """Minimal RFC 6455 client, written independently of netserver's own frame code."""

    def __init__(self):
        self.queue = asyncio.Queue()
        self.reader = self.writer = self.task = None

    async def open(self, port):
        self.reader, self.writer = await asyncio.open_connection("127.0.0.1", port)
        key = base64.b64encode(os.urandom(16)).decode()
        self.writer.write((f"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                           f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
        head = (await asyncio.wait_for(self.reader.readuntil(b"\r\n\r\n"), 5)).decode("latin-1")
        expected = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        assert head.startswith("HTTP/1.1 101"), head
        assert f"Sec-WebSocket-Accept: {expected}" in head, head
        self.task = asyncio.create_task(self._read_loop())

    async def _read_loop(self):
        try:
            while True:
                b0, b1 = await self.reader.readexactly(2)
                assert not b1 & 0x80, "server frames must not be masked"
                n = b1 & 0x7F
                if n == 126:
                    (n,) = struct.unpack(">H", await self.reader.readexactly(2))
                elif n == 127:
                    (n,) = struct.unpack(">Q", await self.reader.readexactly(8))
                payload = await self.reader.readexactly(n)
                opcode = b0 & 0x0F
                if opcode == 0x1:
                    self.queue.put_nowait(json.loads(payload))
                elif opcode == 0x8:
                    break
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        self.queue.put_nowait(None)

    def send_json(self, obj):
        payload = json.dumps(obj).encode()
        assert len(payload) < 126
        mask = os.urandom(4)
        self.writer.write(bytes([0x81, 0x80 | len(payload)]) + mask
                          + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    async def next(self, timeout):
        msg = await asyncio.wait_for(self.queue.get(), max(0.01, timeout))
        assert msg is not None, "the server closed the feed"
        return msg

    async def close(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        if self.writer:
            self.writer.close()


# ---------------------------------------------------------------- the floor: TUIO over UDP


class _UdpSink(asyncio.DatagramProtocol):
    pass


class Floor:
    """Sends the current feet as TUIO bundles at 30 Hz, and at once whenever a foot changes."""

    def __init__(self, port, width, height):
        self.port, self.width, self.height = port, width, height
        self.cursors = {}  # session id -> (x, y) normalised
        self.next_sid = 100
        self.fseq = 0
        self.transport = None
        self.task = None

    async def open(self):
        loop = asyncio.get_running_loop()
        self.transport, _ = await loop.create_datagram_endpoint(
            _UdpSink, remote_addr=("127.0.0.1", self.port))
        self.task = asyncio.create_task(self._frames())

    async def _frames(self):
        while True:
            self.send()
            await asyncio.sleep(1 / 30)

    def send(self):
        self.fseq += 1
        cursors = [(sid, x, y) for sid, (x, y) in self.cursors.items()]
        self.transport.sendto(tuio_frame("e2e@test", cursors, self.fseq))

    def down(self, x_px, y_px):
        sid = self.next_sid
        self.next_sid += 1
        self.cursors[sid] = (x_px / self.width, y_px / self.height)
        self.send()
        return sid

    def up(self, sid):
        if self.cursors.pop(sid, None) is not None:
            self.send()

    async def close(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        if self.transport:
            self.cursors.clear()
            self.send()
            self.transport.close()


# ---------------------------------------------------------------- plain HTTP


async def http_get(port, target):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(f"GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".encode())
    data = await asyncio.wait_for(reader.read(), 5)
    writer.close()
    head, _, body = data.partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    headers = {k.lower(): v for k, v in (line.split(": ", 1) for line in lines[1:])}
    return int(lines[0].split()[1]), headers, body


async def check_static_files(port):
    for path, kind, marker in [
        ("/floor.html", "text/html", b"<title>Stomp the Mole</title>"),
        ("/floor.js", "text/javascript", b"StompFeed.connect"),
        ("/audio.js", "text/javascript", b"StompAudio"),
        ("/feed.js", "text/javascript", b"StompFeed"),
        ("/scoreboard.html", "text/html", b"scoreboard.js"),
        ("/room.html?test=1", "text/html", b"<title>Stomp the Mole - Room</title>"),
        ("/room.js", "text/javascript", b"StompFeed.connect"),
        ("/sky.js", "text/javascript", b"root.Sky ="),
    ]:
        status, headers, body = await http_get(port, path)
        assert status == 200, (path, status)
        assert headers["content-type"].startswith(kind), (path, headers["content-type"])
        assert headers["cache-control"] == "no-store"
        assert marker in body, path
        if path.startswith("/room.html"):
            # the wall page needs the feed client and the sky before its own script
            scripts = [body.index(f'<script src="{name}"></script>'.encode()) for name in
                       ("feed.js", "sky.js", "room.js")]
            assert scripts == sorted(scripts), scripts
            # ... notes any that fails to load (a listener before them), and reloads itself once the game
            # answers again (a watchdog after them)
            assert body.index(b"__stompFailed = []") < scripts[0] < scripts[-1] < body.index(b"location.reload()")
    for target in ("/../config.py", "/%2e%2e/config.py", "/..%2fconfig.py", "/%2E%2E%2Fconfig.py",
                   "/..%5cconfig.py", "/web/../../config.py"):
        status, _, body = await http_get(port, target)
        assert status == 404, (target, status)
        assert b"load_config" not in body and b"DEFAULTS" not in body, target


# ---------------------------------------------------------------- the bot


class Bot:
    def __init__(self, feed, floor, hello, cfg):
        self.feed, self.floor = feed, floor
        self.holes = {h["index"]: h for h in hello["config"]["holes"]}
        moles = cfg["moles"]
        self.hittable_after = moles["rise_ms"] * moles["hittable_from_rise_frac"]
        self.events = []
        self.states = []
        self.latest = None
        self.handled = set()     # moles the bot has stomped (or decided to leave alone)
        self.left_alone = set()  # moles that rose while feet were standing in the holes
        self.lifted_at = {}      # hole -> when a foot last left it
        self.inflight = 0
        self.paused = False
        self.tasks = []

    def count(self, name):
        return sum(1 for e in self.events if e["name"] == name)

    async def next(self, deadline):
        msg = await self.feed.next(deadline - asyncio.get_running_loop().time())
        assert isinstance(msg.get("now"), (int, float)), msg
        if msg["type"] == "event":
            self.events.append(msg)
        elif msg["type"] == "state":
            self.states.append(msg)
            self.latest = msg
        return msg

    async def until(self, predicate, timeout, what):
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            try:
                msg = await self.next(deadline)
            except TimeoutError:
                raise AssertionError(f"timed out waiting for {what}; events: "
                                     f"{[e['name'] for e in self.events]}") from None
            if predicate(msg):
                return msg

    async def until_event(self, name, timeout, **fields):
        return await self.until(
            lambda m: m["type"] == "event" and m["name"] == name
            and all(m.get(k) == v for k, v in fields.items()), timeout, f"event {name} {fields}")

    def hole_xy(self, hole):
        return self.holes[hole]["x"], self.holes[hole]["y"]

    async def _stomp(self, hole, at=None):
        try:
            if at is not None and at > now_ms():
                await asyncio.sleep((at - now_ms()) / 1000)
            sid = self.floor.down(*self.hole_xy(hole))
            await asyncio.sleep(STOMP_HOLD_S)
            self.floor.up(sid)
            self.lifted_at[hole] = now_ms()
        finally:
            self.inflight -= 1

    def stomp(self, hole, at=None):
        self.inflight += 1
        self.tasks.append(asyncio.create_task(self._stomp(hole, at)))

    def stomp_moles_in(self, state):
        """Stomp each new mole once it is hittable."""
        if self.paused:
            return
        for mole in state["moles"]:
            if mole["id"] in self.handled or mole["state"] not in ("rising", "up"):
                continue
            self.handled.add(mole["id"])
            if mole["id"] in self.left_alone:
                continue
            at = mole["t0"] + self.hittable_after + 30 if mole["state"] == "rising" else now_ms()
            # a new foot within the tracker's debounce of the last one would be the same contact
            at = max(at, self.lifted_at.get(mole["hole"], -math.inf) + 200)
            self.stomp(mole["hole"], at)

    async def finish(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)


async def play_one_round(server, cfg):
    feed = FeedClient()
    await feed.open(server.http_port)
    floor = None
    bot = None
    try:
        hello = await feed.next(5)
        assert hello["type"] == "hello"
        holes = hello["config"]["holes"]
        assert len(holes) == 9 and [h["index"] for h in holes] == list(range(9))
        feed.send_json({"type": "client", "role": "e2e-bot", "audio": "none"})
        floor = Floor(server.tuio_port, hello["config"]["floor"]["width"], hello["config"]["floor"]["height"])
        await floor.open()
        bot = Bot(feed, floor, hello, cfg)
        first = await bot.until(lambda m: m["type"] == "state", 5, "the first state")
        assert first["phase"] == "attract" and first["start_progress"] == 0

        # stand on the START pad until the countdown starts
        pad = hello["config"]["start_pad"]
        pad_foot = floor.down(pad["x"], pad["y"])
        await bot.until_event("countdown", 5, value=3)
        assert [e["name"] for e in bot.events] == ["start_pad", "countdown"]

        # keep a foot in every hole as play starts (the pad foot already stands in the centre hole)
        standing = [pad_foot]
        for hole in holes:
            if math.dist((hole["x"], hole["y"]), (pad["x"], pad["y"])) > hole["hit_radius"]:
                standing.append(floor.down(hole["x"], hole["y"]))
        assert len(standing) == 9
        await bot.until_event("round_start", 5)
        first_mole = await bot.until_event("mole_up", 5)
        # the first mole has to rise under a standing foot: every hole has one
        await bot.until(lambda m: m["type"] == "state" and any(
            x["id"] == first_mole["mole_id"] and x["state"] == "up" and m["now"] >= x["t0"] + 200
            for x in m["moles"]), 5, "the first mole to be fully up")
        assert bot.count("hit") == 0, "a foot that was already standing in the hole scored"
        assert bot.count("empty_stomp") == 0
        for sid in standing:
            floor.up(sid)
        lift_time = now_ms()
        for hole in range(9):
            bot.lifted_at[hole] = lift_time
        bot.left_alone.update(e["mole_id"] for e in bot.events if e["name"] == "mole_up")

        # play: stomp every new mole, and once (with a combo going) stomp an empty hole
        empty = None          # the empty-hole stomp in progress
        empty_checked = None  # (score before, state after) once it worked
        deadline = asyncio.get_running_loop().time() + ROUND_TIMEOUT_S
        while True:
            msg = await bot.next(deadline)
            if msg["type"] == "event":
                if msg["name"] == "mole_up" and msg["now"] < lift_time + 200:
                    bot.left_alone.add(msg["mole_id"])  # rose while feet stood in the holes
                if msg["name"] == "round_end":
                    round_end = msg
                    break
                if empty and msg.get("hole") == empty["hole"]:
                    if msg["name"] == "empty_stomp":
                        empty["seen"] = True
                    elif msg["name"] == "hit":  # a mole popped up there first: try again later
                        empty, bot.paused = None, False
                continue
            if empty and empty.get("seen"):
                empty_checked = (empty["score"], empty["combo"], msg)
                empty, bot.paused = None, False
            elif empty and now_ms() - empty["sent"] > 1000:
                empty, bot.paused = None, False  # the stomp was neutral (mole rising): try again
            bot.stomp_moles_in(msg)
            if (empty is None and empty_checked is None and bot.count("hit") >= 2 and msg["combo"] > 0
                    and bot.inflight == 0 and msg["phase"] == "play"):
                busy = {m["hole"] for m in msg["moles"]}
                free = [h for h in range(9) if h not in busy
                        and now_ms() - bot.lifted_at.get(h, -math.inf) > 700]
                if free:
                    bot.paused = True
                    empty = {"hole": free[0], "score": bot.count("hit"), "combo": msg["combo"],
                             "sent": now_ms()}
                    bot.stomp(free[0])

        results = await bot.until(lambda m: m["type"] == "state" and m["phase"] == "results", 5,
                                  "the results phase")
        await bot.until_event("attract", 5)
        back = await bot.until(lambda m: m["type"] == "state", 5, "a state after results")
        await bot.finish()
        return hello, bot, first_mole, empty_checked, round_end, results, back
    finally:
        if bot:
            await bot.finish()
        if floor:
            await floor.close()
        await feed.close()


def test_one_round_end_to_end(tmp_path, caplog):
    caplog.set_level(logging.INFO)
    highscore_file = tmp_path / "highscores.json"
    cfg = short_round_config(highscore_file)

    async def main():
        server = run.build_server(cfg, seed=SEED)
        await server.start()
        try:
            await check_static_files(server.http_port)
            return await asyncio.wait_for(play_one_round(server, cfg), ROUND_TIMEOUT_S + 15)
        finally:
            await server.stop()

    hello, bot, first_mole, empty_checked, round_end, results, back = asyncio.run(main())
    names = [e["name"] for e in bot.events]

    # countdown 3, 2, 1, GO in order, then the round starts
    countdown = [e["value"] for e in bot.events if e["name"] == "countdown"]
    assert countdown == [3, 2, 1, "GO"], countdown
    assert names.index("round_start") == names.index("countdown") + 4

    # every point is a hit event, in order
    hits = [e for e in bot.events if e["name"] == "hit"]
    assert len(hits) > 0
    assert [h["score"] for h in hits] == list(range(1, len(hits) + 1))
    assert round_end["score"] == len(hits) == round_end["hits"]
    assert results["score"] == len(hits) and results["result"]["score"] == len(hits)

    # the mole that rose under the standing feet was never hit, and escaped
    assert first_mole["mole_id"] in bot.left_alone
    assert not {h["mole_id"] for h in hits} & bot.left_alone
    escaped = [e for e in bot.events if e["name"] == "escaped"]
    assert first_mole["mole_id"] in {e["mole_id"] for e in escaped}

    # the empty-hole stomp reset the combo and left the score alone
    assert empty_checked is not None, f"the empty-hole stomp never happened; events: {names}"
    score_before, combo_before, state_after = empty_checked
    assert combo_before > 0
    assert state_after["combo"] == 0 and state_after["score"] == score_before
    empties = [e for e in bot.events if e["name"] == "empty_stomp"]
    assert empties and round_end["misses"] == len(escaped) + len(empties)
    assert results["escaped"] == len(escaped)

    # a fresh table: this round is today's best, and it is on disk
    assert round_end["rank"] == 1 and round_end["new_high"] is True
    saved = json.loads(highscore_file.read_text(encoding="utf-8"))
    assert saved["date"] == datetime.date.today().isoformat()
    assert saved["scores"][0]["score"] == len(hits)
    assert results["highscores"][0]["score"] == len(hits)

    # back to attract, with the result kept for the screens
    assert back["phase"] == "attract" and back["result"]["score"] == len(hits)
    assert "attract" in names[names.index("round_end"):]

    # the server counts the screens by the role they declared; the walls get their geometry in hello
    assert results["screens"] == back["screens"] == {"e2e-bot": 1}
    assert hello["config"]["room"]["front"] == {"x": 800, "y": 787, "w": 1000, "h": 1013}
    assert hello["config"]["hud"]["show_on_floor"] == "auto"

    log = [r.getMessage() for r in caplog.records]
    assert "Screen connected: e2e-bot (no sound)" in log
    assert any(line.startswith(f"Round over: score {len(hits)},") for line in log), log
