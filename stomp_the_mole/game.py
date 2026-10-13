"""GameEngine: the one place where phases, score, timer, combo, moles and results live.

Pure logic. No I/O and no real clock: every call takes ``now`` (milliseconds from one monotonic
clock), and the random generator and the high-score table are injected, so a round replays
exactly in tests. Things that fall due between calls (countdown steps, mole states, warnings,
the end of the round) are processed at their own scheduled times, in order, so the outcome does
not depend on how often ``update`` is called. New moles spawn only in ``update``, at its ``now``.

Browser pages only draw what ``snapshot()`` and the events say (see "Data feed" in DESIGN.md).
"""

import copy
import math
from dataclasses import dataclass, field

from .config import hole_centres

ATTRACT, COUNTDOWN, PLAY, RESULTS = "attract", "countdown", "play", "results"
RISING, UP, SINKING, HIT, ESCAPED = "rising", "up", "sinking", "hit", "escaped"
LIVE = (RISING, UP, SINKING)
COUNTDOWN_FROM = 3
INF = math.inf


def _lerp(a, b, f):
    return a + (b - a) * f


def _ms(t):
    """Times and positions go out rounded to 0.1, which keeps the JSON short."""
    return None if t is None else round(t, 1)


@dataclass(slots=True)
class Mole:
    id: int
    hole: int
    state: str
    t0: float            # start of the current state
    t1: float            # end of the current state (for sinking: when the hittable window closes)
    up_ms: float
    window_start: float  # hittable from here ...
    window_end: float    # ... until here (sink start + hit_grace_ms)


@dataclass(slots=True)
class Contact:
    x: float
    y: float
    # Holes this foot has been farther than exit_radius from since it landed (or last stomped
    # there). Only moving into one of these is a stomp; see touch_move.
    cleared: set = field(default_factory=set)
    in_pad: bool = False
    armed: bool = False             # went down, or entered the START pad, after attract began


class GameEngine:
    def __init__(self, cfg: dict, highscores, rng, now: float):
        """``highscores`` needs ``submit(score, best_combo) -> rank | None`` and ``top()``; None = no table."""
        self.cfg = cfg
        self._hs = highscores
        self._rng = rng
        self._holes = [(h["x"], h["y"]) for h in hole_centres(cfg)]
        self._hit_r = cfg["holes"]["hit_radius"]
        self._exit_r = cfg["holes"]["exit_radius"]
        self._miss_r = cfg["holes"]["miss_radius"]
        self._reland_px = cfg["input"]["reacquire_px"]
        self._pad = cfg["start_pad"]
        self._round = cfg["round"]
        self._mole_cfg = cfg["moles"]
        self._diff = cfg["difficulty"]
        self._milestone = cfg["combo"]["milestone_every"]

        self._now = float(now)
        self._events = []
        self._contacts = {}       # contact id -> Contact
        self._moles = {}          # mole id -> Mole (ids only ever grow, so this is in id order)
        self._hole_mole = {}      # hole -> Mole
        self._cooldown_until = {}  # hole -> time it may take a new mole
        self._last_hit_at = {}    # hole -> time of the last hit there (double-stomp check)
        self._last_miss_at = {}   # hole -> time of the last empty stomp there (one footstep, one miss)
        self._recent_ups = []     # [(x, y, time)] where feet lifted in the last reland_ms
        self._next_mole_id = 1
        self._next_spawn_at = INF
        self._prev_spawn_hole = None
        self._warnings = []       # [(time, seconds_left)] still to fire this round
        self.result = None
        self._reset_stats()
        self._enter_attract(self._now, announce=False)

    # ------------------------------------------------------------------ public API

    def touch_down(self, cid: int, x: float, y: float, now: float) -> None:
        now = self._advance(now)
        hole = self._hole_at(x, y)
        contact = Contact(x, y, cleared=self._holes_beyond(x, y), in_pad=self._in_pad(x, y))
        self._contacts[cid] = contact
        if self.phase == ATTRACT:
            contact.armed = True
            self._pad_refresh(now)
        if hole is not None:
            self._stomp(hole, x, y, now)

    def touch_move(self, cid: int, x: float, y: float, now: float) -> None:
        now = self._advance(now)
        contact = self._contacts.get(cid)
        if contact is None:
            # A move without its down: track the foot, but it neither stomps nor arms the pad.
            self._contacts[cid] = Contact(x, y, cleared=self._holes_beyond(x, y), in_pad=self._in_pad(x, y))
            return
        contact.x, contact.y = x, y
        was_in_pad, contact.in_pad = contact.in_pad, self._in_pad(x, y)
        if self.phase == ATTRACT:
            if contact.in_pad and not was_in_pad:
                contact.armed = True
            self._pad_refresh(now)
        # Hysteresis both ways: a foot must really travel from beyond exit_radius into hit_radius.
        # A planted foot whose reported position wobbles by a cell near a rim (in or out) is
        # never a stomp, whether it landed inside the hole or just outside it.
        contact.cleared |= self._holes_beyond(x, y)
        hole = self._hole_at(x, y)
        if hole is not None and hole in contact.cleared:
            contact.cleared.discard(hole)
            self._stomp(hole, x, y, now)  # entered a hole from well outside

    def touch_up(self, cid: int, now: float) -> None:
        now = self._advance(now)
        contact = self._contacts.pop(cid, None)
        if contact is None:
            return
        if self.phase == ATTRACT:
            self._pad_refresh(now)
        reland = self._mole_cfg["reland_ms"]
        self._recent_ups = [u for u in self._recent_ups if now - u[2] < reland]
        if reland > 0:
            self._recent_ups.append((contact.x, contact.y, now))

    def handle_contacts(self, contact_events, now: float) -> None:
        """Apply TouchTracker output: [("down"|"move"|"up", cid, x, y), ...]."""
        for kind, cid, x, y in contact_events:
            if kind == "down":
                self.touch_down(cid, x, y, now)
            elif kind == "move":
                self.touch_move(cid, x, y, now)
            elif kind == "up":
                self.touch_up(cid, now)

    def update(self, now: float) -> None:
        now = self._advance(now)
        if self.phase == PLAY:
            self._try_spawn(now)

    def drain_events(self) -> list[dict]:
        events, self._events = self._events, []
        return events

    def snapshot(self, now: float) -> dict:
        """The "state" message of the data feed, complete with "type" and "now"."""
        play = self.phase == PLAY
        return {
            "type": "state",
            "now": _ms(now),
            "phase": self.phase,
            "phase_start": _ms(self.phase_start),
            "phase_end": _ms(self.phase_end),
            "countdown": self._countdown_value(now),
            "time_left_ms": int(min(self._round["play_ms"], max(0.0, self.phase_end - now))) if play else None,
            "score": self.score,
            "combo": self.combo,
            "best_combo": self.best_combo,
            "hits": self.hits,
            "misses": self.misses,
            "escaped": self.escaped,
            "level": round(self._level(now), 4),
            "moles": [
                {"id": m.id, "hole": m.hole, "state": m.state, "t0": _ms(m.t0), "t1": _ms(m.t1),
                 "rise_ms": self._mole_cfg["rise_ms"], "up_ms": _ms(m.up_ms)}
                for m in self._moles.values()
            ],
            "touches": [{"id": cid, "x": _ms(c.x), "y": _ms(c.y)} for cid, c in sorted(self._contacts.items())],
            "start_progress": round(self._start_progress(now), 4),
            "start_blocked": self._start_blocked(),
            "result": dict(self.result) if self.result is not None else None,
            "highscores": self._top(),
            "round_ms": self._round["play_ms"],
        }

    def public_config(self) -> dict:
        """The "config" body of the data feed's "hello" message."""
        cfg = self.cfg
        holes = cfg["holes"]
        return {
            "floor": {"width": cfg["floor"]["width"], "height": cfg["floor"]["height"]},
            "grid": {key: holes[key] for key in ("cols", "rows", "top_margin")},
            "holes": [
                {"index": i, "x": _ms(x), "y": _ms(y), "draw_radius": holes["draw_radius"],
                 "hit_radius": self._hit_r, "exit_radius": self._exit_r, "miss_radius": self._miss_r}
                for i, (x, y) in enumerate(self._holes)
            ],
            "start_pad": {key: self._pad[key] for key in ("x", "y", "radius", "hold_ms")},
            "hud": {"show_on_floor": cfg["hud"]["show_on_floor"], "rotation": cfg["hud"]["rotation"]},
            "round": {key: self._round[key] for key in ("play_ms", "countdown_step_ms", "go_ms", "results_ms",
                                                         "first_spawn_delay_ms", "time_warning_s")},
            "moles": {key: self._mole_cfg[key] for key in ("rise_ms", "sink_ms", "hit_anim_ms", "escape_anim_ms")},
            "highscores": {"size": cfg["highscores"]["size"]},
            "audio": {"volume": cfg["audio"]["volume"]},
            # the wall PC's canvas and its ceiling / wall regions, for room.html (the whole block)
            "room": copy.deepcopy(cfg["room"]),
        }

    def hello(self, now: float) -> dict:
        """The complete "hello" message for a newly connected page."""
        return {"type": "hello", "now": _ms(now), "config": self.public_config()}

    # ------------------------------------------------------------------ time

    def _advance(self, now):
        """Process everything that fell due up to ``now``, in time order. Returns the clamped now."""
        now = max(float(now), self._now)  # the clock never runs backwards
        while True:
            phase = self.phase
            if phase == ATTRACT:
                self._advance_attract(now)
            elif phase == COUNTDOWN:
                self._advance_countdown(now)
            elif phase == PLAY:
                self._advance_play(now)
            else:
                self._advance_results(now)
            if self.phase == phase:
                break
        self._now = now
        return now

    def _advance_attract(self, now):
        if self._pad_occupied:
            start_at = self._pad_mark + max(0.0, self._pad["hold_ms"] - self._pad_progress)
            if start_at <= now:
                self._start_countdown(start_at)
                return
            self._pad_progress += now - self._pad_mark
        elif self._pad_left_at is not None and now - self._pad_left_at >= self._pad["gap_ms"]:
            self._pad_progress = 0.0
        self._pad_mark = now

    def _advance_countdown(self, now):
        step = self._round["countdown_step_ms"]
        while True:
            shown = self._countdown_shown
            due = self.phase_start + (COUNTDOWN_FROM - shown + 1) * step
            if due > now:
                return
            if shown > 1:
                self._countdown_shown = shown - 1
                self._emit(due, "countdown", value=shown - 1)
            else:
                self._start_play(self.phase_end)
                return

    def _advance_play(self, now):
        end = self.phase_end
        while True:
            mole = self._next_mole()
            t_mole = mole.t1 if mole is not None else INF
            t_warn = self._warnings[0][0] if self._warnings else INF
            t = min(t_mole, t_warn)
            # Anything due exactly at the end loses to the end: the timer reached 0 first.
            if t < end and t <= now:
                if t_mole <= t_warn:
                    self._step_mole(mole)
                else:
                    _, seconds = self._warnings.pop(0)
                    self._emit(t, "time_warning", seconds_left=seconds)
                continue
            if end <= now:
                self._end_round(end)
            return

    def _advance_results(self, now):
        end = self.phase_end
        while True:
            mole = self._next_mole()  # hit / escaped animations finishing
            if mole is not None and mole.t1 < end and mole.t1 <= now:
                self._step_mole(mole)
                continue
            if end <= now:
                self._enter_attract(end)
            return

    # ------------------------------------------------------------------ phases

    def _reset_stats(self):
        self.score = self.combo = self.best_combo = 0
        self.hits = self.misses = self.escaped = 0

    def _enter_attract(self, t, announce=True):
        self.phase, self.phase_start, self.phase_end = ATTRACT, t, None
        self._clear_moles()
        for contact in self._contacts.values():
            contact.armed = False  # someone still standing here from the last round
            contact.in_pad = self._in_pad(contact.x, contact.y)
        self._pad_progress = 0.0
        self._pad_mark = t
        self._pad_occupied = False
        self._pad_left_at = None
        if announce:
            self._emit(t, "attract")

    def _start_countdown(self, t):
        self._reset_stats()
        self.result = None
        step = self._round["countdown_step_ms"]
        self.phase, self.phase_start, self.phase_end = COUNTDOWN, t, t + COUNTDOWN_FROM * step
        self._countdown_shown = COUNTDOWN_FROM
        self._emit(t, "countdown", value=COUNTDOWN_FROM)

    def _start_play(self, t):
        end = t + self._round["play_ms"]
        self.phase, self.phase_start, self.phase_end = PLAY, t, end
        self._emit(t, "countdown", value="GO")
        self._emit(t, "round_start")
        self._next_spawn_at = t + self._round["first_spawn_delay_ms"]
        self._prev_spawn_hole = None
        self._warnings = [(end - s * 1000, s) for s in range(self._round["time_warning_s"], 0, -1)
                          if end - s * 1000 > t]

    def _end_round(self, t):
        # The timer beat them: live moles just vanish, they do not count as escaped.
        for mole in [m for m in self._moles.values() if m.state in LIVE]:
            del self._moles[mole.id]
            del self._hole_mole[mole.hole]
        self._warnings = []
        self._next_spawn_at = INF
        rank = None
        if self._hs is not None:
            rank = self._hs.submit(self.score, self.best_combo)
        self.result = {"score": self.score, "best_combo": self.best_combo, "hits": self.hits,
                       "misses": self.misses, "rank": rank, "new_high": rank == 1}
        self._emit(t, "round_end", **self.result)
        self.phase, self.phase_start, self.phase_end = RESULTS, t, t + self._round["results_ms"]

    # ------------------------------------------------------------------ START pad

    def _pad_refresh(self, t):
        """Call after any touch change in attract (with the pad already advanced to t)."""
        occupied = any(c.armed and c.in_pad for c in self._contacts.values())
        if occupied == self._pad_occupied:
            return
        self._pad_occupied = occupied
        if occupied:
            if self._pad_left_at is not None and t - self._pad_left_at >= self._pad["gap_ms"]:
                self._pad_progress = 0.0
            self._emit(t, "start_pad", progress=round(self._start_progress(t), 4))
        else:
            self._pad_left_at = t

    def _start_progress(self, now):
        if self.phase != ATTRACT:
            return 0.0
        progress = self._pad_progress
        if self._pad_occupied:
            progress += max(0.0, now - self._pad_mark)
        elif self._pad_left_at is not None and now - self._pad_left_at >= self._pad["gap_ms"]:
            progress = 0.0
        hold = self._pad["hold_ms"]
        if hold <= 0:
            return 1.0 if self._pad_occupied else 0.0
        return min(1.0, progress / hold)

    def _start_blocked(self):
        """Someone stands on the pad but cannot start: they were already there when attract began
        (see "armed"). The floor then asks them to step off and back on."""
        return (self.phase == ATTRACT and not self._pad_occupied
                and any(c.in_pad and not c.armed for c in self._contacts.values()))

    def _in_pad(self, x, y):
        return math.hypot(x - self._pad["x"], y - self._pad["y"]) <= self._pad["radius"]

    # ------------------------------------------------------------------ moles

    def _level(self, now):
        if self.phase == PLAY:
            return min(1.0, max(0.0, (now - self.phase_start) / self._round["play_ms"]))
        return 1.0 if self.phase == RESULTS else 0.0

    def _max_active(self, f):
        steps = self._diff["max_active"]
        count = steps[0][1]
        for threshold, n in steps:
            if threshold <= f:
                count = n
        return count

    def _try_spawn(self, now):
        if now < self._next_spawn_at:
            return
        f = self._level(now)
        live = sum(1 for m in self._moles.values() if m.state in LIVE)
        if live >= self._max_active(f):
            return
        free = [h for h in range(len(self._holes))
                if h not in self._hole_mole and self._cooldown_until.get(h, -INF) <= now]
        if not free:
            return  # try again next tick
        # A foot within exit_radius could not score on this hole without lifting first, and
        # that is where sensor wobble could be mistaken for a stomp: keep moles away from it.
        stood_on = {h for c in self._contacts.values() for h in range(len(self._holes))
                    if self._dist_to_hole(c.x, c.y, h) <= self._exit_r}
        preferred = [h for h in free if h not in stood_on and h != self._prev_spawn_hole]
        hole = self._rng.choice(preferred or free)

        rise = self._mole_cfg["rise_ms"]
        up_ms = _lerp(self._diff["up_ms_start"], self._diff["up_ms_end"], f)
        mole = Mole(id=self._next_mole_id, hole=hole, state=RISING, t0=now, t1=now + rise, up_ms=up_ms,
                    window_start=now + rise * self._mole_cfg["hittable_from_rise_frac"],
                    window_end=now + rise + up_ms + self._mole_cfg["hit_grace_ms"])
        self._next_mole_id += 1
        self._moles[mole.id] = mole
        self._hole_mole[hole] = mole
        self._prev_spawn_hole = hole
        self._emit(now, "mole_up", mole_id=mole.id, hole=hole)

        jitter = self._diff["gap_jitter"]
        gap = _lerp(self._diff["gap_ms_start"], self._diff["gap_ms_end"], f)
        self._next_spawn_at = now + gap * self._rng.uniform(1 - jitter, 1 + jitter)

    def _next_mole(self):
        """The mole whose current state ends first (ties: lowest id)."""
        return min(self._moles.values(), key=lambda m: (m.t1, m.id), default=None)

    def _step_mole(self, mole):
        """Move a mole on from its current state, at the time that state ends."""
        t = mole.t1
        if mole.state == RISING:
            mole.state, mole.t0, mole.t1 = UP, t, t + mole.up_ms
        elif mole.state == UP:
            # Sinking lasts until the hittable window closes, which may outlast the animation.
            mole.state, mole.t0, mole.t1 = SINKING, t, mole.window_end
        elif mole.state == SINKING:
            self.combo = 0
            self.misses += 1
            self.escaped += 1
            mole.state, mole.t0, mole.t1 = ESCAPED, t, t + self._mole_cfg["escape_anim_ms"]
            self._emit(t, "escaped", mole_id=mole.id, hole=mole.hole)
        else:  # hit / escaped animation over: the hole rests a moment before the next mole
            del self._moles[mole.id]
            del self._hole_mole[mole.hole]
            self._cooldown_until[mole.hole] = t + self._mole_cfg["hole_cooldown_ms"]

    def _clear_moles(self):
        self._moles.clear()
        self._hole_mole.clear()
        self._cooldown_until.clear()
        self._last_hit_at.clear()
        self._last_miss_at.clear()
        self._recent_ups = []
        self._warnings = []
        self._next_spawn_at = INF

    # ------------------------------------------------------------------ stomps

    def _stomp(self, hole, x, y, t):
        if self.phase != PLAY:
            return
        mole = self._hole_mole.get(hole)
        if mole is not None and mole.state in LIVE and t >= mole.window_start:
            self.score += 1
            self.combo += 1
            self.best_combo = max(self.best_combo, self.combo)
            self.hits += 1
            mole.state, mole.t0, mole.t1 = HIT, t, t + self._mole_cfg["hit_anim_ms"]
            self._last_hit_at[hole] = t
            self._emit(t, "hit", mole_id=mole.id, hole=hole, x=_ms(x), y=_ms(y),
                       score=self.score, combo=self.combo)
            if self._milestone and self.combo % self._milestone == 0:
                self._emit(t, "combo", combo=self.combo)
            return
        window = self._mole_cfg["double_stomp_ms"]
        last_hit = self._last_hit_at.get(hole)
        if last_hit is not None and t - last_hit <= window:
            return  # second foot of a two-footed jump: not punished
        if mole is not None and mole.state == RISING:
            return  # too early: the mole is not out yet, so it is not a miss either
        if mole is not None and mole.state == ESCAPED:
            return  # too late, but the escape already counted: one late stomp is one miss, not two
        if self._dist_to_hole(x, y, hole) > self._miss_r:
            return  # on the grass at the rim, outside the drawn hole: walking there is free
        if any(math.hypot(x - ux, y - uy) <= self._reland_px and t - ut < self._mole_cfg["reland_ms"]
               for ux, uy, ut in self._recent_ups):
            return  # the same foot back where it just lifted: a sensor dropout, not a new step
        last_miss = self._last_miss_at.get(hole)
        if last_miss is not None and t - last_miss <= window:
            return  # the same footstep reported as several touches is one miss
        self._last_miss_at[hole] = t
        self.combo = 0
        self.misses += 1
        self._emit(t, "empty_stomp", hole=hole, x=_ms(x), y=_ms(y))

    def _dist_to_hole(self, x, y, hole):
        hx, hy = self._holes[hole]
        return math.hypot(x - hx, y - hy)

    def _holes_beyond(self, x, y):
        """The holes (x, y) is farther than exit_radius from."""
        return {h for h in range(len(self._holes)) if self._dist_to_hole(x, y, h) > self._exit_r}

    def _hole_at(self, x, y):
        """The nearest hole within hit_radius of (x, y), or None."""
        best, best_d = None, INF
        for hole in range(len(self._holes)):
            d = self._dist_to_hole(x, y, hole)
            if d <= self._hit_r and d < best_d:
                best, best_d = hole, d
        return best

    # ------------------------------------------------------------------ feed helpers

    def _countdown_value(self, now):
        if self.phase == COUNTDOWN:
            elapsed_steps = int((now - self.phase_start) // self._round["countdown_step_ms"])
            return max(1, COUNTDOWN_FROM - max(0, elapsed_steps))
        if self.phase == PLAY and now - self.phase_start < self._round["go_ms"]:
            return "GO"
        return None

    def _top(self):
        return self._hs.top() if self._hs is not None else []

    def _emit(self, t, name, **fields):
        self._events.append({"type": "event", "now": _ms(t), "name": name, **fields})
