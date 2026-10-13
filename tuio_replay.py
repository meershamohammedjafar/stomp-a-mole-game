"""Replay a floor recording and measure what the floor really sends (on-site tool, stdlib only).

Record first, on the floor PC, while people follow a short script: stand still on one foot, then
on two; rock heel to toe; stand between two holes; walk along a row gap; stamp fast in place; jump.

    python tuio_receiver.py --record floor.jsonl      # the game must not be running (UDP 3333), or give
                                                      # the platform a second TUIO output and use --port
Then:
    python tuio_replay.py floor.jsonl                     # the whole recording
    python tuio_replay.py floor.jsonl --start 20 --end 45 # only seconds 20..45 (one part of the script)
    python tuio_replay.py floor.jsonl --list-downs        # also list every stomp the game would see

It prints what the step-detection settings in stomp_the_mole/config.json need: the frame rate and its
gaps; cursors per frame and per foot, and how far apart neighbouring cursors are (one cursor per foot,
or one per pressed cell? -> input.merge_px); session-id relabels and impossible jumps; feet that
vanished and came back at the same spot, and for how long (-> input.debounce_ms); and the downs the
game's TouchTracker makes from this recording with the current settings (each down is a stomp).
Input latency cannot be read from a recording: film the floor next to the running recorder for that.
"""

import argparse
import json
import math
import statistics
import sys
from collections import Counter

from stomp_the_mole.config import ConfigError, load_config
from stomp_the_mole.touch_input import TouchTracker, merge_points
from tuio_receiver import TuioState

CURSOR = "/tuio/2Dcur"
CELL_PX = 14     # one sensor cell on the 560 x 448 floor
LOST_MS = 1000   # a foot gone longer than this was lifted, not lost


def read_records(lines):
    """(t_ms, msgs) for every usable line of a tuio_receiver --record file."""
    out = []
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue  # a blank line, or the last line cut short by Ctrl+C
        if (isinstance(entry, dict) and isinstance(entry.get("t_ms"), (int, float))
                and isinstance(entry.get("msgs"), list)):
            out.append((float(entry["t_ms"]), entry["msgs"]))
    return out


def frames(records):
    """(t_ms, [(session_id, x, y)]) after every packet that carried /tuio/2Dcur, like the game sees it."""
    state = TuioState(lambda *_event: None)
    for t, msgs in records:
        seen = False
        for msg in msgs:
            if isinstance(msg, list) and msg and msg[0] == CURSOR:
                state.handle(CURSOR, msg[1:])
                seen = True
        if seen:
            cursors = []
            for sid, touch in state.live.get(CURSOR, {}).items():
                x, y = touch.fields.get("x"), touch.fields.get("y")
                if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                    cursors.append((sid, x, y))
            yield t, cursors


def analyse(frame_list, *, width=560, height=448, merge_px=30, match_px=56, reacquire_px=28,
            debounce_ms=120, reland_ms=500):
    """Measure a list of frames (from frames()); returns a dict (see report())."""
    tracker = TouchTracker(width, height, debounce_ms=debounce_ms, reacquire_px=reacquire_px,
                           merge_px=merge_px, match_px=match_px)
    times, cursor_counts, neighbours, per_foot = [], Counter(), Counter(), []
    relabels = jumps = 0
    dropouts, downs, ups = [], [], []
    prev, prev_feet, lost = {}, [], []
    for t, cursors in frame_list:
        times.append(t)
        pts = {sid: (x * width, y * height) for sid, x, y in cursors}
        cursor_counts[len(pts)] += 1
        plist = list(pts.values())
        for i, p in enumerate(plist):
            nearest = min((math.dist(p, q) for j, q in enumerate(plist) if j != i), default=None)
            if nearest is not None:
                neighbours[round(nearest / CELL_PX)] += 1
        feet = merge_points(plist, merge_px)
        if feet:
            per_foot.append(len(plist) / len(feet))

        # session ids: a new id where one just vanished (relabel), or an id that jumped (swap)
        gone = [p for sid, p in prev.items() if sid not in pts]
        for sid, p in pts.items():
            if sid in prev:
                jumps += math.dist(prev[sid], p) > match_px
            elif any(math.dist(g, p) <= reacquire_px for g in gone):
                relabels += 1

        # dropouts: a foot that vanished and came back at the same spot within LOST_MS
        lost = [entry for entry in lost if t - entry[2] <= LOST_MS]
        lost += [(f[0], f[1], t) for f in prev_feet if not any(math.dist(f, g) <= match_px for g in feet)]
        for f in feet:
            if any(math.dist(f, g) <= match_px for g in prev_feet):
                continue
            near = [entry for entry in lost if math.dist(entry[:2], f) <= reacquire_px]
            if near:
                entry = min(near, key=lambda e: math.dist(e[:2], f))
                lost.remove(entry)
                dropouts.append(t - entry[2])
        prev, prev_feet = pts, feet

        # what the game's tracker makes of it
        for kind, _cid, x, y in tracker.on_frame([{"x": x, "y": y} for _, x, y in cursors], t):
            if kind == "down":
                reland = any(math.dist((ux, uy), (x, y)) <= reacquire_px and t - ut < reland_ms
                             for ux, uy, ut in ups)
                downs.append({"t": t, "x": x, "y": y, "reland": reland})
            elif kind == "up":
                ups.append((x, y, t))

    gaps = [b - a for a, b in zip(times, times[1:])]
    return {
        "frames": len(times),
        "duration_s": (times[-1] - times[0]) / 1000 if len(times) > 1 else 0.0,
        "gap_median_ms": statistics.median(gaps) if gaps else None,
        "gap_max_ms": max(gaps) if gaps else None,
        "cursors_per_frame": dict(sorted(cursor_counts.items())),
        "neighbour_cells": dict(sorted(neighbours.items())),
        "cursors_per_foot": statistics.fmean(per_foot) if per_foot else None,
        "relabels": relabels,
        "jumps": jumps,
        "dropouts_ms": dropouts,
        "downs": downs,
        "settings": {"merge_px": merge_px, "match_px": match_px, "reacquire_px": reacquire_px,
                     "debounce_ms": debounce_ms, "reland_ms": reland_ms},
    }


def _histogram(values, step=10):
    counts = Counter(step * round(v / step) for v in values)
    return "  ".join(f"~{k:g}: {n}" for k, n in sorted(counts.items())) or "none"


def report(s, t0=0.0, list_downs=False):
    """The measurements as plain lines, each with what it means for the settings."""
    cfg = s["settings"]
    lines = [f"Frames: {s['frames']} over {s['duration_s']:.1f} s"]
    if s["gap_median_ms"]:
        lines.append(f"  frame gap: median {s['gap_median_ms']:.1f} ms ({1000 / s['gap_median_ms']:.1f} frames/s), "
                     f"longest {s['gap_max_ms']:.0f} ms")
    lines.append("Cursors per frame: " + ("  ".join(f"{k}: {n}" for k, n in s["cursors_per_frame"].items())
                                          or "none"))
    lines.append("Nearest other cursor, in cells (14 px): "
                 + ("  ".join(f"{k}: {n}" for k, n in s["neighbour_cells"].items()) or "never two at once"))
    per_foot = s["cursors_per_foot"]
    if per_foot is not None:
        verdict = ("one cursor per foot" if per_foot < 1.3 else
                   "SEVERAL cursors per foot (per pressed cell or split blobs); merge_px must cover the "
                   "nearest-cursor distances above that belong to one foot (30 px = 2 cells; 42 px = 3)")
        lines.append(f"Cursors per foot (merge_px {cfg['merge_px']}): {per_foot:.2f} -> {verdict}")
    lines.append(f"Session ids: {s['relabels']} relabels (new id where one just vanished), "
                 f"{s['jumps']} jumps over {cfg['match_px']} px in one frame (ids swapping between feet)"
                 + (" -> ids are not stable; the game does not use them" if s["relabels"] or s["jumps"] else ""))
    drops = s["dropouts_ms"]
    lines.append(f"Feet that vanished and came back at the same spot: {len(drops)}; gone for (ms): "
                 f"{_histogram(drops)}")
    if drops:
        longer = sum(1 for d in drops if d >= cfg["debounce_ms"])
        lines.append(f"  longest {max(drops):.0f} ms; {longer} lasted debounce_ms ({cfg['debounce_ms']}) or longer "
                     "and come back as a new down. In a stand-still part, set input.debounce_ms to the "
                     "longest + one frame (at most about 200).")
    downs = s["downs"]
    lines.append(f"Downs (stomps) the game would see: {len(downs)}, of which "
                 f"{sum(d['reland'] for d in downs)} re-landed where a foot lifted < {cfg['reland_ms']} ms before")
    if list_downs:
        for d in downs:
            lines.append(f"  {(d['t'] - t0) / 1000:8.2f} s  down at ({d['x']:.0f}, {d['y']:.0f})"
                         + ("  re-landing" if d["reland"] else ""))
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Measure a tuio_receiver.py --record file.")
    parser.add_argument("file", help="the recording (JSON lines)")
    parser.add_argument("--start", type=float, help="seconds from the start of the recording to begin at")
    parser.add_argument("--end", type=float, help="seconds from the start of the recording to stop at")
    parser.add_argument("--list-downs", action="store_true", help="list every down the tracker makes")
    parser.add_argument("--config", metavar="PATH", help="game config to take the settings from")
    parser.add_argument("--merge-px", type=float, help="try another input.merge_px")
    parser.add_argument("--debounce-ms", type=float, help="try another input.debounce_ms")
    opts = parser.parse_args(argv)
    try:
        cfg = load_config(opts.config)
    except ConfigError as exc:
        print(exc, file=sys.stderr)
        return 1
    try:
        with open(opts.file, encoding="utf-8-sig") as f:
            records = read_records(f)
    except OSError as exc:
        print(f"Cannot read {opts.file}: {exc}", file=sys.stderr)
        return 1
    if not records:
        print("No packets in that file.")
        return 1
    t0 = records[0][0]
    lo = t0 + 1000 * opts.start if opts.start is not None else -math.inf
    hi = t0 + 1000 * opts.end if opts.end is not None else math.inf
    picked = [f for f in frames(records) if lo <= f[0] <= hi]
    if not picked:
        print("No /tuio/2Dcur frames in that part of the recording.")
        return 1
    inp = cfg["input"]
    summary = analyse(picked, width=cfg["floor"]["width"], height=cfg["floor"]["height"],
                      merge_px=opts.merge_px if opts.merge_px is not None else inp["merge_px"],
                      match_px=inp["match_px"], reacquire_px=inp["reacquire_px"],
                      debounce_ms=opts.debounce_ms if opts.debounce_ms is not None else inp["debounce_ms"],
                      reland_ms=cfg["moles"]["reland_ms"])
    print(f"Recording {opts.file}: {len(records)} packets")
    print(report(summary, t0, opts.list_downs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
