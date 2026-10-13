"""Start Stomp the Mole: load the config, build the game, serve the feed, open the floor window.

    python -m stomp_the_mole [--config PATH] [--no-window] [--seed N]

The console shows plain status lines for the operator. Ctrl+C stops everything, including the
browser window this program opened; closing the console window ends that browser too (see window.py).
"""

import argparse
import asyncio
import ipaddress
import logging
import logging.handlers
import queue
import random
import socket
import sys

from . import netserver
from .config import DEFAULT_PATH, ConfigError, load_config
from .game import GameEngine
from .highscores import HighScores
from .touch_input import TouchTracker
from .window import BrowserWindow

log = logging.getLogger("stomp_the_mole")


class _ConsoleFormat(logging.Formatter):
    """'12:34:56  message', with WARNING / ERROR spelled out when it is one."""

    def format(self, record):
        line = super().format(record)
        if record.levelno >= logging.WARNING:
            stamp, _, rest = line.partition("  ")
            line = f"{stamp}  {record.levelname}: {rest}"
        return line


def setup_logging(stream=None) -> logging.handlers.QueueListener:
    """Console status lines, written by a thread of their own.

    While someone has text selected in a Windows console (one click in it with QuickEdit on),
    every write to that console blocks. Log calls only put the record on a queue, so the game
    loop never waits for the console; the lines appear once the selection ends (Esc).
    Returns the started listener; stop it at shutdown to flush the last lines.
    """
    console = logging.StreamHandler(stream)
    console.setFormatter(_ConsoleFormat("%(asctime)s  %(message)s", datefmt="%H:%M:%S"))
    records = queue.SimpleQueue()
    root = logging.getLogger()
    root.handlers[:] = [logging.handlers.QueueHandler(records)]
    root.setLevel(logging.INFO)
    listener = logging.handlers.QueueListener(records, console)
    listener.start()
    return listener


def stop_logging(listener: logging.handlers.QueueListener) -> None:
    """Write out what is still queued, then log straight to the console again."""
    listener.stop()
    logging.getLogger().handlers[:] = list(listener.handlers)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(prog="python -m stomp_the_mole",
                                     description="Stomp the Mole: whack-a-mole for the LED floor.")
    parser.add_argument("--config", metavar="PATH",
                        help=f"config file (default: {DEFAULT_PATH})")
    parser.add_argument("--no-window", action="store_true",
                        help="do not open the browser window (open the printed page URL yourself)")
    parser.add_argument("--seed", type=int, metavar="N",
                        help="random seed, to replay the same moles in the same order")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    listener = setup_logging()
    try:
        try:
            cfg = load_config(args.config)
        except ConfigError as exc:
            log.error("%s", exc)
            return 1
        if args.config or DEFAULT_PATH.is_file():
            log.info("Config loaded from %s", args.config or DEFAULT_PATH)
        try:
            return asyncio.run(_serve(cfg, args))
        except KeyboardInterrupt:
            log.info("Stopped.")
            return 0
    finally:
        stop_logging(listener)


def build_server(cfg: dict, seed=None) -> netserver.GameServer:
    """Wire high scores, touch tracker, engine and server together (not started yet)."""
    floor, tuio, touch = cfg["floor"], cfg["tuio"], cfg["input"]
    highscores = HighScores(cfg["highscores"]["file"], size=cfg["highscores"]["size"])
    tracker = TouchTracker(floor["width"], floor["height"], debounce_ms=touch["debounce_ms"],
                           reacquire_px=touch["reacquire_px"], merge_px=touch["merge_px"],
                           match_px=touch["match_px"], flip_x=tuio["flip_x"], flip_y=tuio["flip_y"])
    engine = GameEngine(cfg, highscores, random.Random(seed), now=netserver.now_ms())
    return netserver.GameServer(cfg, engine, tracker, on_event=_round_reporter(cfg))


async def _serve(cfg: dict, args) -> int:
    floor = cfg["floor"]
    server = build_server(cfg, args.seed)
    try:
        await server.start()
    except netserver.PortInUseError as exc:
        log.error("%s", exc)
        return 1
    except OSError as exc:
        log.error("Could not open the network ports (check tuio and http in config.json): %s", exc)
        return 1

    report_wall_address(server.http_host, server.http_port)
    window = None
    try:
        win = cfg["window"]
        if args.no_window:
            log.info("No game window (--no-window). Open %s yourself.", server.page_url)
        else:
            window = BrowserWindow(server.page_url, mode=win["mode"], x=win["x"], y=win["y"],
                                   width=floor["width"], height=floor["height"], browser=win["browser"])
            window.open()
        log.info("Running. Press Ctrl+C to stop.")
        await asyncio.Event().wait()  # until Ctrl+C cancels us
    finally:
        log.info("Shutting down...")
        if window is not None:
            window.close()
        await server.stop()
    return 0


# ---------------------------------------------------------------- the address for the wall PC


def _default_route_ipv4():
    """The address this PC sends from towards other networks, or None. connect() on a UDP socket only
    picks the outgoing interface; nothing is sent (192.0.2.1 is TEST-NET-1, never a real host)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 9))
            return probe.getsockname()[0]
    except OSError:
        return None


def lan_ipv4_addresses() -> list[str]:
    """This PC's IPv4 addresses that another PC could use, the default-route one first.

    Loopback (127.x) is left out, and so is link-local (169.254.x: what Windows gives a network port
    that found no DHCP server); nobody on another subnet can reach those.
    """
    found = [_default_route_ipv4()]
    try:
        found += [info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)]
    except (OSError, UnicodeError):
        pass
    out = []
    for addr in found:
        try:
            ip = ipaddress.IPv4Address(addr)
        except (ValueError, TypeError):
            continue
        if ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast:
            continue
        if addr not in out:
            out.append(addr)
    return out


def _this_pc_only(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def report_wall_address(http_host: str, port: int) -> None:
    """Console lines telling the operator what the wall PC opens (DESIGN.md "Wall PC")."""
    if http_host in ("", "0.0.0.0"):
        addresses = lan_ipv4_addresses()
        for addr in addresses:
            log.info("Wall PC: open http://%s:%d/room.html", addr, port)
        if not addresses:
            log.warning("Wall PC: this PC has no network address yet. Connect it to the network, then open "
                        "http://<this PC's IP address>:%d/room.html on the wall PC (ipconfig shows the "
                        "address).", port)
        if sys.platform == "win32":
            log.info("Windows Firewall must let python.exe accept connections, or the wall PC cannot connect. "
                     "Windows asks only the first time python.exe uses the network (maybe already for "
                     "tuio_floor_map.py) and never again: if the walls keep saying WAITING FOR THE GAME, see "
                     "\"Firewall\" in README.md.")
    elif _this_pc_only(http_host):
        log.info("The walls cannot connect: http.host in config.json is %s (this PC only). To let the "
                 "wall PC read the game, set it to \"0.0.0.0\" and restart the game.", http_host)
    else:
        log.info("Wall PC: open http://%s:%d/room.html", http_host, port)


def _round_reporter(cfg: dict):
    size = cfg["highscores"]["size"]

    def report(event: dict) -> None:
        name = event.get("name")
        if name == "round_start":
            log.info("Round started")
        elif name == "round_end":
            rank = event.get("rank")
            if event.get("new_high"):
                place = "NEW HIGH SCORE for today"
            elif rank:
                place = f"rank {rank} of today's top {size}"
            else:
                place = f"not in today's top {size}"
            log.info("Round over: score %s, best combo %s (%s hits, %s misses), %s",
                     event.get("score"), event.get("best_combo"), event.get("hits"),
                     event.get("misses"), place)

    return report
