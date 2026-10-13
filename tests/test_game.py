"""GameEngine rules (and the config it runs on), driven by a fake clock and a seeded rng."""

import datetime
import json
import random
import re
from pathlib import Path

import pytest

from stomp_the_mole import config
from stomp_the_mole.game import GameEngine
from stomp_the_mole.highscores import HighScores
from stomp_the_mole.touch_input import TouchTracker

ROOT = Path(__file__).resolve().parent.parent
PAD = (280, 244)
CENTRE = (280, 244)  # also the only hole of the 1 x 1 test grid
ONE_HOLE = {"holes": {"cols": 1, "rows": 1}}
LIVE = ("rising", "up", "sinking")

STATE_KEYS = {"type", "now", "phase", "phase_start", "phase_end", "countdown", "time_left_ms",
              "score", "combo", "best_combo", "hits", "misses", "escaped", "level", "moles",
              "touches", "start_progress", "start_blocked", "result", "highscores", "round_ms"}
NO_MOLES = {"round": {"first_spawn_delay_ms": 10**6}}
EVENT_FIELDS = {
    "start_pad": {"progress"},
    "countdown": {"value"},
    "round_start": set(),
    "mole_up": {"mole_id", "hole"},
    "hit": {"mole_id", "hole", "x", "y", "score", "combo"},
    "combo": {"combo"},
    "escaped": {"mole_id", "hole"},
    "empty_stomp": {"hole", "x", "y"},
    "time_warning": {"seconds_left"},
    "round_end": {"score", "best_combo", "hits", "misses", "rank", "new_high"},
    "attract": set(),
}


def merge(*parts):
    out = {}
    for part in parts:
        for section, values in part.items():
            out.setdefault(section, {}).update(values)
    return out


class Game:
    """A GameEngine on a fake clock, stepped like the server's 60 Hz loop."""

    def __init__(self, overrides=None, seed=1, highscores=None, tracker=False):
        self.cfg = config.build_config(overrides or {})
        self.holes = [(h["x"], h["y"]) for h in self.cfg["hole_centres"]]
        self.hs = highscores or HighScores(None, today=lambda: datetime.date(2026, 10, 10),
                                           clock=lambda: "12:00")
        self.engine = GameEngine(self.cfg, self.hs, random.Random(seed), 0.0)
        self.tracker = TouchTracker(560, 448, **self.cfg["input"]) if tracker else None
        self.t = 0.0
        self.events = []
        self._cid = 100

    # clock
    def run_to(self, t, step=16):
        while self.t + step < t:
            self._tick(self.t + step)
        self._tick(max(self.t, t))

    def run_until(self, condition, step=16, limit=1_000_000):
        while not condition():
            assert self.t < limit, "condition never became true"
            self._tick(self.t + step)

    def _tick(self, t):
        self.t = t
        if self.tracker:
            self.engine.handle_contacts(self.tracker.tick(t), t)
        self.engine.update(t)
        self._pull()

    def _pull(self):
        self.events += self.engine.drain_events()

    # feet
    def down(self, cid, x, y):
        self.engine.touch_down(cid, x, y, self.t)
        self._pull()

    def move(self, cid, x, y):
        self.engine.touch_move(cid, x, y, self.t)
        self._pull()

    def up(self, cid):
        self.engine.touch_up(cid, self.t)
        self._pull()

    def stomp(self, x, y):
        """A fresh foot lands at (x, y) and lifts again."""
        self._cid += 1
        self.down(self._cid, x, y)
        self.up(self._cid)

    def stomp_hole(self, hole):
        self.stomp(*self.holes[hole])

    def tuio(self, event, sid, x=0.0, y=0.0):
        fields = {"x": x / 560, "y": y / 448}
        self.engine.handle_contacts(self.tracker.on_tuio(event, sid, fields, self.t), self.t)
        self._pull()

    def frame(self, *points):
        """One whole TUIO frame through the tracker: every cursor alive now, in floor px."""
        fields = [{"x": x / 560, "y": y / 448} for x, y in points]
        self.engine.handle_contacts(self.tracker.on_frame(fields, self.t), self.t)
        self._pull()

    # reading
    def snap(self):
        return self.engine.snapshot(self.t)

    def moles(self, *states):
        return [m for m in self.snap()["moles"] if not states or m["state"] in states]

    def named(self, name):
        return [e for e in self.events if e["name"] == name]

    def phase_is(self, phase):
        return lambda: self.engine.phase == phase

    # rounds
    def press_start(self, stay=False):
        """Stand on the START pad until the countdown starts; step off unless ``stay``."""
        self.down(999, *PAD)
        self.run_until(self.phase_is("countdown"))
        if not stay:
            self.up(999)

    def start_round(self, stay=False):
        self.press_start(stay)
        self.run_until(self.phase_is("play"))
        return self.engine.phase_start

    def hit_next(self):
        """Wait for a mole to be fully up, stomp it, and check it was a hit."""
        self.run_until(lambda: self.moles("up"))
        mole = self.moles("up")[0]
        self.stomp_hole(mole["hole"])
        assert self.events[-1]["name"] in ("hit", "combo") and self.named("hit")[-1]["mole_id"] == mole["id"]
        return mole

    def finish_round(self):
        self.run_until(self.phase_is("results"))


# ---------------------------------------------------------------------- config


def test_config_json_is_exactly_the_defaults():
    data = json.loads((ROOT / "stomp_the_mole" / "config.json").read_text(encoding="utf-8"))
    assert data == config.DEFAULTS


def test_defaults_match_design_md():
    text = (ROOT / "DESIGN.md").read_text(encoding="utf-8")
    block = re.search(r"## Config.*?```json\n(.*?)```", text, re.S).group(1)
    assert json.loads(block) == config.DEFAULTS


def test_load_config_defaults_and_derived_holes():
    cfg = config.load_config()
    holes = cfg["hole_centres"]
    assert [h["index"] for h in holes] == list(range(9))
    assert [round(h["x"], 1) for h in holes[:3]] == [93.3, 280.0, 466.7]
    assert [h["y"] for h in holes[::3]] == [108.0, 244.0, 380.0]
    assert holes[4] == {"index": 4, "x": 280.0, "y": 244.0, "draw_radius": 48, "hit_radius": 58,
                        "exit_radius": 100, "miss_radius": 48}
    assert Path(cfg["highscores"]["file"]) == config.PACKAGE_DIR / "data" / "highscores.json"
    assert config.load_config() is not cfg and config.DEFAULTS["highscores"]["file"] == "data/highscores.json"


def test_partial_file_merges_over_defaults(tmp_path):
    path = tmp_path / "custom.json"
    scores = tmp_path / "scores" / "hs.json"  # absolute: used as given
    path.write_text("﻿" + json.dumps({"round": {"play_ms": 30000}, "holes": {"cols": 4},
                                           "highscores": {"file": str(scores)}}), encoding="utf-8")
    cfg = config.load_config(path)
    assert cfg["round"]["play_ms"] == 30000
    assert cfg["round"]["results_ms"] == 8000
    assert len(cfg["hole_centres"]) == 12
    assert cfg["highscores"]["file"] == str(scores)


def test_missing_explicit_config_is_an_error(tmp_path):
    with pytest.raises(config.ConfigError, match="not found"):
        config.load_config(tmp_path / "nope.json")


def test_bad_json_names_the_line(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text('{\n  "round": {"play_ms": 60000,}\n}', encoding="utf-8")
    with pytest.raises(config.ConfigError, match="line 2"):
        config.load_config(path)


@pytest.mark.parametrize("overrides, message", [
    ({"holes": {"exit_radius": 50}}, "exit_radius"),
    ({"holes": {"miss_radius": 60}}, "holes.miss_radius"),   # more than hit_radius
    ({"holes": {"miss_radius": 0}}, "holes.miss_radius"),
    ({"input": {"merge_px": -1}}, "input.merge_px"),
    ({"input": {"match_px": "far"}}, "input.match_px"),
    ({"moles": {"reland_ms": -5}}, "moles.reland_ms"),
    ({"hud": {"rotation": 90}}, "hud.rotation"),
    ({"window": {"mode": "fullscreen"}}, "window.mode"),
    ({"round": {"play_ms": "60"}}, "round.play_ms"),
    ({"round": {"play_ms": 0}}, "round.play_ms"),
    ({"holes": {"cols": 2.5}}, "holes.cols"),
    ({"tuio": {"port": 70000}}, "tuio.port"),
    ({"tuio": {"flip_x": "no"}}, "tuio.flip_x"),
    ({"moles": {"hittable_from_rise_frac": 1.5}}, "hittable_from_rise_frac"),
    ({"difficulty": {"gap_jitter": 1}}, "gap_jitter"),
    ({"difficulty": {"max_active": [[0.5, 2], [0.0, 1]]}}, "max_active"),
    ({"difficulty": {"max_active": [[0.0, 0]]}}, "max_active"),
    ({"difficulty": {"max_active": []}}, "max_active"),
    ({"audio": {"volume": 2}}, "audio.volume"),
    ({"round": 5}, "round"),
    ({"hud": {"show_on_floor": "yes"}}, "hud.show_on_floor"),
    ({"hud": {"show_on_floor": "Auto"}}, "hud.show_on_floor"),
    ({"hud": {"show_on_floor": 1}}, "hud.show_on_floor"),
    ({"hud": {"show_on_floor": None}}, "hud.show_on_floor"),
])
def test_obvious_mistakes_are_clear_errors(overrides, message):
    with pytest.raises(config.ConfigError, match=re.escape(message)):
        config.build_config(overrides)


@pytest.mark.parametrize("value", ["auto", True, False])
def test_hud_on_floor_is_auto_true_or_false(value):
    got = config.build_config({"hud": {"show_on_floor": value}})["hud"]["show_on_floor"]
    assert got == value and type(got) is type(value)
    assert config.DEFAULTS["hud"]["show_on_floor"] == "auto"


def test_room_defaults_are_the_signage_division_and_the_owners_led_layout():
    room = config.build_config({})["room"]
    assert (room["width"], room["height"], room["safe_inset"], room["fps"]) == (2600, 1820, 40, 60)
    regions = {name: (r["x"], r["y"], r["w"], r["h"]) for name, r in room.items() if isinstance(r, dict)}
    # the exact LED layout the owner supplied on 2026-10-12
    assert regions == {"ceiling": (800, 0, 1000, 787), "left": (0, 787, 800, 1014),
                       "front": (800, 787, 1000, 1013), "right": (1800, 787, 800, 1014)}
    # the walls are side by side across the full width; the lit area ends at y 1801, inside the division
    assert regions["left"][0] + regions["left"][2] == regions["front"][0] == regions["ceiling"][0]
    assert regions["front"][0] + regions["front"][2] == regions["right"][0]
    assert regions["right"][0] + regions["right"][2] == room["width"]
    assert max(r[1] + r[3] for r in regions.values()) == 1801 <= room["height"]
    # the ceiling's bottom edge meets the top of the front wall
    assert regions["ceiling"][1] + regions["ceiling"][3] == regions["front"][1]
    assert config.build_config({})["http"]["host"] == "0.0.0.0"


def test_room_regions_merge_key_by_key():
    room = config.build_config({"room": {"right": {"w": 790}, "fps": 30.0, "height": 1820.0}})["room"]
    assert room["right"] == {"x": 1800, "y": 787, "w": 790, "h": 1014}
    assert room["fps"] == 30 and room["height"] == 1820 and isinstance(room["height"], int)
    # a region that touches the edges exactly is fine, and so is a safe inset of 0
    edge = config.build_config({"room": {"width": 1000, "height": 786, "safe_inset": 0,
                                         "ceiling": {"x": 0, "y": 0, "w": 1000, "h": 786},
                                         "left": {"x": 0, "y": 0, "w": 1, "h": 1},
                                         "front": {"x": 999, "y": 785, "w": 1, "h": 1},
                                         "right": {"x": 0, "y": 0, "w": 1000, "h": 786}}})["room"]
    assert edge["front"] == {"x": 999, "y": 785, "w": 1, "h": 1}
    # the wall page's limits themselves are allowed
    assert config.build_config({"room": {"safe_inset": 200}})["room"]["safe_inset"] == 200
    big = config.build_config({"room": {"width": 8192, "height": 8192}})["room"]
    assert (big["width"], big["height"]) == (8192, 8192)


@pytest.mark.parametrize("room, message", [
    ({"width": 0}, "room.width"),
    ({"height": -1820}, "room.height"),
    ({"width": 99}, "room.width must be at least 100"),         # the wall page's limits: 100..8192
    ({"width": 8193}, "room.width must be at most 8192"),
    ({"height": 9000}, "room.height must be at most 8192"),
    ({"safe_inset": 201}, "room.safe_inset must be at most 200"),   # fits the regions, but not the signs
    ({"width": 2600.5}, "room.width"),
    ({"width": "2600"}, "room.width"),
    ({"safe_inset": -1}, "room.safe_inset"),
    ({"safe_inset": "40"}, "room.safe_inset"),
    ({"safe_inset": 400}, "room.safe_inset"),          # leaves nothing of the 786-tall ceiling
    ({"fps": 9}, "room.fps"),
    ({"fps": 121}, "room.fps"),
    ({"fps": True}, "room.fps"),
    ({"fps": float("nan")}, "room.fps"),
    ({"ceiling": {"w": 0}}, "room.ceiling.w"),
    ({"left": {"h": -5}}, "room.left.h"),
    ({"front": {"x": -1}}, "room.front.x"),
    ({"right": {"y": True}}, "room.right.y"),
    ({"right": {"x": 1801}}, "room.right"),           # sticks out past room.width
    ({"left": {"y": 807}}, "room.left"),              # sticks out past room.height (807 + 1014 > 1820)
    ({"height": 1800}, "room.left"),                  # the side walls run to y 1801
    ({"front": 5}, "room.front"),
    ({"front": {"x": 800.5}}, "room.front.x"),
])
def test_room_mistakes_are_clear_errors(room, message):
    with pytest.raises(config.ConfigError, match=re.escape(message)):
        config.build_config({"room": room})


def test_unknown_keys_are_kept_but_warned_about(caplog):
    cfg = config.build_config({"round": {"play_msec": 1}, "extra": {"a": 1}})
    assert cfg["extra"] == {"a": 1}
    assert "round.play_msec" in caplog.text and "extra" in caplog.text


# ---------------------------------------------------------------------- attract and START pad


def test_starts_in_attract_quietly():
    g = Game()
    g.run_to(5000)
    snap = g.snap()
    assert (snap["phase"], snap["phase_end"], snap["countdown"], snap["time_left_ms"]) == ("attract", None, None, None)
    assert g.events == []


def test_start_pad_needs_an_armed_touch_held_for_hold_ms():
    g = Game()
    g.down(1, *PAD)
    assert g.events == [{"type": "event", "now": 0.0, "name": "start_pad", "progress": 0.0}]
    g.run_to(500)
    assert g.snap()["start_progress"] == pytest.approx(0.5)
    g.run_to(999)
    assert g.engine.phase == "attract"
    g.run_to(1000)
    assert g.engine.phase == "countdown" and g.engine.phase_start == 1000
    assert g.events[-1] == {"type": "event", "now": 1000.0, "name": "countdown", "value": 3}


def test_pad_edge_counts_and_outside_does_not():
    g = Game()
    g.down(1, PAD[0] + 73, PAD[1])  # just outside the 72 px pad
    g.run_to(3000)
    assert g.engine.phase == "attract" and g.named("start_pad") == []
    g.move(1, PAD[0] + 72, PAD[1])  # walking in arms it
    assert g.named("start_pad")[0]["now"] == 3000
    g.run_to(4000)
    assert g.engine.phase == "countdown"


def test_pad_tolerates_short_gaps():
    g = Game()
    g.down(1, *PAD)
    g.run_to(600)
    g.up(1)
    g.run_to(700)
    assert g.snap()["start_progress"] == pytest.approx(0.6)  # paused, not lost
    g.run_to(840)  # 240 ms gap < gap_ms 250
    g.down(2, *PAD)
    assert g.named("start_pad")[-1]["progress"] == pytest.approx(0.6)
    g.run_to(1239)
    assert g.engine.phase == "attract"
    g.run_to(1240)
    assert g.engine.phase == "countdown" and g.engine.phase_start == pytest.approx(1240)


def test_pad_resets_after_a_long_gap():
    g = Game()
    g.down(1, *PAD)
    g.run_to(600)
    g.up(1)
    g.run_to(850)  # 250 ms gap: too long
    assert g.snap()["start_progress"] == 0
    g.down(2, *PAD)
    assert g.named("start_pad")[-1]["progress"] == 0
    g.run_to(1849)
    assert g.engine.phase == "attract"
    g.run_to(1850)
    assert g.engine.phase == "countdown"


def test_second_foot_keeps_the_pad_charging():
    g = Game()
    g.down(1, PAD[0] - 20, PAD[1])
    g.run_to(300)
    g.down(2, PAD[0] + 20, PAD[1])
    g.run_to(500)
    g.up(1)
    g.run_to(1000)
    assert g.engine.phase == "countdown" and len(g.named("start_pad")) == 1


def test_player_still_standing_on_the_pad_does_not_restart_the_game():
    g = Game({"round": {"play_ms": 3000, "results_ms": 2000}})
    g.start_round(stay=True)  # foot 999 never lifts
    g.finish_round()
    g.run_until(g.phase_is("attract"))
    attract_at = g.t
    g.move(999, PAD[0] + 10, PAD[1] + 5)  # shuffling about inside the pad
    g.run_to(attract_at + 5000)
    assert g.engine.phase == "attract" and g.snap()["start_progress"] == 0
    g.move(999, PAD[0], PAD[1] + 100)  # step off ...
    g.run_to(g.t + 100)
    g.move(999, *PAD)  # ... and back on: now it counts
    stepped_on = g.t
    g.run_to(stepped_on + 999)
    assert g.engine.phase == "attract"
    g.run_to(stepped_on + 1000)
    assert g.engine.phase == "countdown"


def test_lifting_and_stepping_back_on_also_starts():
    g = Game({"round": {"play_ms": 3000, "results_ms": 2000}})
    g.start_round(stay=True)
    g.finish_round()
    g.run_until(g.phase_is("attract"))
    g.up(999)
    g.down(5, *PAD)
    g.run_to(g.t + 1000)
    assert g.engine.phase == "countdown"


def test_start_blocked_tells_a_waiting_player_to_step_off_and_back_on():
    g = Game({"round": {"play_ms": 3000, "results_ms": 2000}})
    g.start_round()
    g.finish_round()
    g.down(7, *PAD)  # the next player steps on while the results show
    assert g.snap()["start_blocked"] is False  # only in attract
    g.run_until(g.phase_is("attract"))
    g.run_to(g.t + 3000)
    snap = g.snap()
    assert (snap["start_progress"], snap["start_blocked"]) == (0, True)
    g.down(8, PAD[0] + 20, PAD[1])  # someone else steps on: the pad charges, nothing is blocked
    assert g.snap()["start_blocked"] is False
    g.up(8)
    g.run_to(g.t + 300)
    assert g.snap()["start_blocked"] is True
    g.up(7)  # lift a foot ...
    assert g.snap()["start_blocked"] is False
    g.down(9, *PAD)  # ... and stand again: now it counts
    g.run_to(g.t + 1000)
    assert g.engine.phase == "countdown" and g.snap()["start_blocked"] is False


# ---------------------------------------------------------------------- countdown and timer


def test_countdown_then_go():
    g = Game()
    g.press_start()
    play = g.engine.phase_end
    assert play == 4000
    for t, value in ((1000, 3), (1500, 3), (2000, 2), (2999, 2), (3000, 1), (3999, 1)):
        g.run_to(t)
        assert g.snap()["countdown"] == value
    g.run_to(4000)
    assert g.snap()["phase"] == "play" and g.snap()["countdown"] == "GO"
    g.run_to(4799)
    assert g.snap()["countdown"] == "GO"
    g.run_to(4800)
    assert g.snap()["countdown"] is None
    steps = [(e["name"], e.get("value"), e["now"]) for e in g.events if e["name"] in ("countdown", "round_start")]
    assert steps == [("countdown", 3, 1000), ("countdown", 2, 2000), ("countdown", 1, 3000),
                     ("countdown", "GO", 4000), ("round_start", None, 4000)]


def test_stomps_do_nothing_during_countdown():
    g = Game()
    g.press_start()
    for hole in range(9):
        g.stomp_hole(hole)
    snap = g.snap()
    assert snap["misses"] == 0 and snap["moles"] == []
    assert not g.named("empty_stomp") and not g.named("hit")


def test_time_left_and_level_during_play():
    g = Game()
    play = g.start_round()
    assert g.snap()["time_left_ms"] == 60000 and g.snap()["level"] == 0
    g.run_to(play + 15000)
    assert g.snap()["time_left_ms"] == 45000 and g.snap()["level"] == pytest.approx(0.25)
    assert g.snap()["round_ms"] == 60000


@pytest.mark.parametrize("step", [7, 37, 333, 2500])
def test_time_warnings_fire_once_per_second_for_the_last_ten(step):
    g = Game()
    play = g.start_round()
    g.run_to(play + 60000, step=step)
    warnings = [(e["seconds_left"], e["now"]) for e in g.named("time_warning")]
    assert warnings == [(s, play + 60000 - s * 1000) for s in range(10, 0, -1)]
    assert g.named("round_end")[0]["now"] == play + 60000


def test_one_big_update_still_runs_every_step_in_order():
    engine = GameEngine(config.build_config({}), None, random.Random(1), 0)
    engine.touch_down(1, *PAD, 0)
    engine.touch_up(1, 0)
    engine.touch_down(2, *PAD, 100)  # a 100 ms flicker: progress is kept
    engine.update(100_000)
    events = engine.drain_events()
    assert [e["name"] for e in events] == (
        ["start_pad", "start_pad", "countdown", "countdown", "countdown", "countdown", "round_start"]
        + ["time_warning"] * 10 + ["round_end", "attract"])
    assert [e["now"] for e in events if e["name"] == "countdown"] == [1100, 2100, 3100, 4100]
    assert events[-1]["now"] == 4100 + 60000 + 8000


# ---------------------------------------------------------------------- what counts as a stomp


def test_standing_foot_does_not_hit_a_mole_rising_under_it():
    g = Game(ONE_HOLE)
    g.start_round(stay=True)  # foot 999 stays in the only hole
    g.run_until(lambda: g.moles("up"))
    assert g.named("mole_up")[0]["hole"] == 0
    g.move(999, CENTRE[0] + 10, CENTRE[1] + 6)  # shifting weight is not a stomp
    g.run_until(lambda: g.named("escaped"))
    snap = g.snap()
    assert (snap["score"], snap["hits"], snap["escaped"], snap["misses"]) == (0, 0, 1, 1)
    assert not g.named("hit") and not g.named("empty_stomp")


def test_lift_and_stomp_again_hits():
    g = Game(ONE_HOLE)
    g.start_round(stay=True)
    g.run_until(lambda: g.moles("up"))
    g.up(999)
    g.down(5, *CENTRE)
    hit = g.named("hit")[0]
    assert hit == {"type": "event", "now": round(g.t, 1), "name": "hit", "mole_id": 1, "hole": 0,
                   "x": 280, "y": 244, "score": 1, "combo": 1}
    snap = g.snap()
    assert (snap["score"], snap["combo"], snap["best_combo"], snap["hits"]) == (1, 1, 1, 1)
    assert snap["moles"][0]["state"] == "hit"


def test_entering_a_hole_from_outside_hits():
    g = Game(ONE_HOLE)
    g.start_round()
    g.down(5, CENTRE[0], CENTRE[1] + 120)
    g.run_until(lambda: g.moles("up"))
    g.move(5, CENTRE[0], CENTRE[1] + 65)  # inside exit_radius but not hit_radius: not in yet
    assert not g.named("hit")
    g.move(5, CENTRE[0], CENTRE[1] + 56)
    assert len(g.named("hit")) == 1 and g.snap()["score"] == 1


def test_landing_beyond_exit_radius_then_sliding_in_hits():
    g = Game(ONE_HOLE)
    g.start_round()
    g.down(5, CENTRE[0] + 110, CENTRE[1])  # 110 px > exit_radius 100
    g.run_until(lambda: g.moles("up"))
    g.move(5, CENTRE[0] + 40, CENTRE[1])
    assert len(g.named("hit")) == 1


def test_landing_short_then_sliding_in_needs_a_new_stomp():
    """The trade-off of entry hysteresis: a foot that lands between hit_radius and exit_radius
    and then settles inward is indistinguishable from a planted foot whose position wobbles."""
    g = Game(ONE_HOLE)
    g.start_round()
    g.down(5, CENTRE[0] + 90, CENTRE[1])
    g.run_until(lambda: g.moles("up"))
    g.move(5, CENTRE[0] + 40, CENTRE[1])
    assert not g.named("hit")
    g.up(5)
    g.run_to(g.t + 50)
    g.down(6, CENTRE[0] + 40, CENTRE[1])  # lifting and stomping again counts
    assert len(g.named("hit")) == 1


def test_jitter_at_the_rim_does_not_restomp():
    g = Game(merge(ONE_HOLE, NO_MOLES))
    g.start_round()
    g.down(5, *CENTRE)
    assert g.snap()["misses"] == 1  # one stomp on an empty hole
    for dy in (62, 66, 69, 57, 60, 50, 65, 70, 59, 85, 99, 40):
        g.move(5, CENTRE[0], CENTRE[1] + dy)
    assert g.snap()["misses"] == 1
    g.move(5, CENTRE[0], CENTRE[1] + 101)  # out past exit_radius
    assert g.snap()["misses"] == 1
    g.move(5, CENTRE[0], CENTRE[1] + 64)  # back near the rim, not in
    assert g.snap()["misses"] == 1
    g.run_to(g.t + 600)  # (a second miss within double_stomp_ms would count as the same footstep)
    g.move(5, CENTRE[0], CENTRE[1] + 40)  # back in: a new stomp
    assert g.snap()["misses"] == 2 and len(g.named("empty_stomp")) == 2


# The rows are 136 px apart, so between holes 1 and 4 there is only 20 px of grass outside both
# hit circles. A foot planted there sits just outside a hit circle.
BETWEEN_1_AND_4 = (280, 170)  # 62 px from hole 1, 74 px from hole 4


def test_planted_foot_beside_a_hole_does_not_hit_when_its_position_wobbles():
    g = Game(ONE_HOLE)  # the only hole: the spawn fallback puts the mole right beside the foot
    foot = (CENTRE[0], CENTRE[1] - 62)  # 62 px from the hole: just outside hit_radius
    g.press_start()
    g.down(50, *foot)  # standing there since before GO
    g.run_until(g.phase_is("play"))
    g.run_until(lambda: g.moles("up"))
    for _ in range(5):  # the floor reports the same foot half a cell nearer, then back
        g.move(50, foot[0], foot[1] + 7)  # 55 px: inside hit_radius
        g.run_to(g.t + 100)
        g.move(50, *foot)
        g.run_to(g.t + 100)
    assert not g.named("hit") and not g.named("empty_stomp")
    assert g.snap()["score"] == 0


def test_planted_foot_beside_an_empty_hole_does_not_break_the_combo():
    g = Game(merge({"difficulty": {"max_active": [[0.0, 1]]}}, NO_MOLES))
    g.start_round()
    g.engine.combo = 3
    g.down(50, *BETWEEN_1_AND_4)  # lands on the grass: not in any hole
    for dy in (-7, 0, -7, 7, 14, 0, -14):  # wobbling by up to a cell towards either hole
        g.move(50, BETWEEN_1_AND_4[0], BETWEEN_1_AND_4[1] + dy)
        g.run_to(g.t + 100)
    assert not g.named("empty_stomp") and g.snap()["combo"] == 3 and g.snap()["misses"] == 0


def test_moles_do_not_rise_beside_a_planted_foot():
    g = Game({"difficulty": {"max_active": [[0.0, 1]]}})
    g.press_start()
    g.down(50, *BETWEEN_1_AND_4)  # within exit_radius of holes 1 and 4
    g.finish_round()
    holes = [e["hole"] for e in g.named("mole_up")]
    assert len(holes) > 20 and not set(holes) & {1, 4}


def test_stomp_between_holes_does_nothing():
    g = Game()
    g.start_round()
    g.stomp(186, 176)
    g.stomp(5, 5)
    assert g.snap()["misses"] == 0 and g.events[-1]["name"] == "round_start"


def test_sensor_flicker_under_a_standing_foot_is_not_a_stomp():
    g = Game(ONE_HOLE, tracker=True)
    g.press_start()
    g.tuio("add", 50, *CENTRE)  # foot standing in the hole before GO
    g.run_until(g.phase_is("play"))
    g.run_until(lambda: g.moles("up"))
    g.tuio("remove", 50)
    g.run_to(g.t + 60)  # gone for 60 ms < debounce_ms
    g.tuio("add", 51, CENTRE[0] + 5, CENTRE[1])  # back 5 px away under a new session
    g.run_until(lambda: g.named("escaped"))
    assert g.snap()["hits"] == 0 and len(g.snap()["touches"]) == 1


def test_real_lift_through_the_tracker_hits():
    g = Game(ONE_HOLE, tracker=True)
    g.press_start()
    g.tuio("add", 50, *CENTRE)
    g.run_until(g.phase_is("play"))
    g.run_until(lambda: g.moles("up"))
    g.tuio("remove", 50)
    g.run_to(g.t + 200)  # longer than debounce_ms: the tracker reports the lift
    assert g.snap()["touches"] == []
    g.tuio("add", 51, *CENTRE)
    assert g.snap()["hits"] == 1


def test_readd_far_from_the_lost_foot_is_a_new_down_and_hits():
    g = Game(ONE_HOLE, tracker=True)
    g.press_start()
    g.tuio("add", 50, CENTRE[0] - 20, CENTRE[1])
    g.run_until(g.phase_is("play"))
    g.run_until(lambda: g.moles("up"))
    g.tuio("remove", 50)
    g.run_to(g.t + 30)
    g.tuio("add", 51, CENTRE[0] + 20, CENTRE[1])  # 40 px > reacquire_px: another foot landing
    assert g.snap()["hits"] == 1


def foot_cells(x, y):
    """One foot as a floor that reports every pressed cell would send it: 2 x 4 cells, 14 px apart."""
    return [(x + dx, y + dy) for dx in (-7, 7) for dy in (-21, -7, 7, 21)]


def test_one_landing_reported_cell_by_cell_is_one_stomp():
    g = Game(merge(NO_MOLES, {"difficulty": {"max_active": [[0.0, 1]]}}), tracker=True)
    g.start_round()
    g.frame(*foot_cells(*g.holes[0]))  # 8 cursors land on an empty hole together
    assert len(g.named("empty_stomp")) == 1 and g.snap()["misses"] == 1
    assert len(g.snap()["touches"]) == 1  # one contact, so one shadow on the floor


def test_cells_flickering_under_a_standing_foot_are_not_stomps():
    g = Game(ONE_HOLE, tracker=True)
    g.press_start()
    cells = foot_cells(*CENTRE)
    g.frame(*cells)  # standing in the only hole since before GO
    g.run_until(g.phase_is("play"))
    g.run_until(lambda: g.moles("up"))
    for _ in range(4):
        g.frame(*cells, (CENTRE[0] + 7, CENTRE[1] + 35))  # a toe cell starts reading as pressed ...
        g.run_to(g.t + 33)
        g.frame(*cells[2:])  # ... then the heel cells drop out
        g.run_to(g.t + 33)
        g.frame(*cells)
        g.run_to(g.t + 33)
    assert not g.named("hit") and not g.named("empty_stomp")
    assert len(g.snap()["touches"]) == 1


def test_standing_foot_lost_longer_than_the_debounce_is_not_a_miss():
    g = Game(merge(NO_MOLES, {"difficulty": {"max_active": [[0.0, 1]]}}), tracker=True)
    g.press_start()
    hole4 = g.holes[4]
    g.frame(hole4)  # standing in hole 4 since before GO
    g.run_until(g.phase_is("play"))
    for gone_ms in (133, 200, 300):  # the floor loses the foot for 4, 6, 9 frames
        g.frame()
        g.run_to(g.t + gone_ms)
        assert g.snap()["touches"] == []  # the tracker reported the lift ...
        g.frame(hole4)  # ... and the same foot comes back as a new down
        g.run_to(g.t + 1000)
    assert not g.named("empty_stomp") and g.snap()["misses"] == 0


def test_relanding_where_a_foot_just_lifted_is_neutral_only_on_an_empty_hole():
    g = Game(merge(NO_MOLES, {"difficulty": {"max_active": [[0.0, 1]]}}))
    g.start_round()
    spot = g.holes[2]
    g.down(1, *spot)
    assert g.snap()["misses"] == 1
    g.run_to(g.t + 1000)
    g.up(1)
    g.run_to(g.t + 200)
    g.down(2, *spot)  # back within reland_ms: the same foot after a dropout
    g.up(2)
    assert g.snap()["misses"] == 1
    g.run_to(g.t + 600)
    g.down(3, *spot)  # well after: an ordinary empty stomp
    assert g.snap()["misses"] == 2


# ---------------------------------------------------------------------- resolving stomps


def test_too_early_stomp_is_neutral_then_a_later_one_hits():
    g = Game(ONE_HOLE)
    g.start_round()
    g.run_until(lambda: g.named("mole_up"))
    spawned = g.named("mole_up")[0]["now"]
    g.run_to(spawned + 10)  # hittable only from rise_ms * 0.3 = 48 ms
    g.stomp(*CENTRE)
    snap = g.snap()
    assert (snap["misses"], snap["combo"], snap["moles"][0]["state"]) == (0, 0, "rising")
    assert g.events[-1]["name"] == "mole_up"
    g.run_to(spawned + 50)  # still rising, but hittable now
    assert g.moles()[0]["state"] == "rising"
    g.stomp(*CENTRE)
    assert g.snap()["hits"] == 1


def test_hit_in_the_grace_period_after_sinking_starts():
    g = Game(ONE_HOLE)
    grace = g.cfg["moles"]["hit_grace_ms"]
    assert grace >= g.cfg["moles"]["sink_ms"] + 100  # a mole the player can still see is hittable, with latency
    g.start_round()
    g.run_until(lambda: g.moles("sinking"))
    sinking = g.moles("sinking")[0]
    assert sinking["t1"] == pytest.approx(sinking["t0"] + grace, abs=0.2)  # window closes at sink + grace
    g.run_to(sinking["t0"] + grace - 10)  # the sink animation is long over
    g.stomp(*CENTRE)
    assert g.snap()["hits"] == 1 and not g.named("escaped")


def test_late_stomp_on_an_escaping_mole_is_one_miss_not_two():
    g = Game(ONE_HOLE)
    g.start_round()
    g.run_until(lambda: g.moles("sinking"))
    sinking = g.moles("sinking")[0]
    g.run_to(sinking["t1"] + 1)
    g.stomp(*CENTRE)  # just too late: the escape counted, the stomp adds nothing
    assert g.events[-1]["name"] == "escaped" and not g.named("empty_stomp")
    snap = g.snap()
    assert (snap["hits"], snap["escaped"], snap["misses"]) == (0, 1, 1)
    g.run_until(lambda: not g.moles())  # escape animation over, hole empty (and resting)
    g.stomp(CENTRE[0] + 30, CENTRE[1])  # now it is an ordinary empty stomp
    assert g.events[-1]["name"] == "empty_stomp" and g.snap()["misses"] == 2


def test_stomp_on_the_rim_of_an_empty_hole_is_not_a_miss():
    g = Game(merge(NO_MOLES, {"difficulty": {"max_active": [[0.0, 1]]}}))
    g.start_round()
    hx, hy = g.holes[4]
    g.engine.combo = 4
    g.stomp(hx, hy - 55)  # inside hit_radius 58, outside the drawn hole (miss_radius 48)
    assert not g.named("empty_stomp") and g.snap()["combo"] == 4
    g.stomp(hx + 46, hy)  # inside the drawn hole: a miss
    assert len(g.named("empty_stomp")) == 1 and g.snap()["combo"] == 0


def test_stomp_on_the_rim_of_a_hole_with_a_mole_hits():
    g = Game(ONE_HOLE)
    g.start_round()
    g.run_until(lambda: g.moles("up"))
    g.stomp(CENTRE[0], CENTRE[1] + 55)  # outside miss_radius, inside hit_radius
    assert g.snap()["hits"] == 1


def test_staggered_two_foot_landing_across_two_rows_keeps_the_combo():
    g = Game({"difficulty": {"max_active": [[0.0, 1]]}})
    g.start_round()
    g.run_until(lambda: g.moles("up") and g.moles("up")[0]["hole"] in (3, 4, 5))
    hx, hy = g.holes[g.moles("up")[0]["hole"]]
    before = g.snap()
    g.down(70, hx, hy - 41)  # front foot on the mole's hole
    g.down(71, hx, hy - 41 - 40)  # back foot 40 px behind: 55 px from the empty hole above
    after = g.snap()
    assert (after["hits"], after["combo"], after["misses"]) == (
        before["hits"] + 1, before["combo"] + 1, before["misses"])


def test_one_footstep_reported_as_several_touches_is_one_miss():
    g = Game(merge(NO_MOLES, {"difficulty": {"max_active": [[0.0, 1]]}}))
    g.start_round()
    for cid, (x, y) in enumerate(foot_cells(*g.holes[0]), start=40):
        g.down(cid, x, y)  # e.g. heel and toe blobs, or one cursor per cell, landing together
    assert len(g.named("empty_stomp")) == 1 and g.snap()["misses"] == 1


def test_grace_longer_than_the_sink_keeps_the_mole_sinking():
    g = Game(merge(ONE_HOLE, {"moles": {"hit_grace_ms": 400, "sink_ms": 200}}))
    g.start_round()
    g.run_until(lambda: g.moles("sinking"))
    sinking = g.moles("sinking")[0]
    assert sinking["t1"] == pytest.approx(sinking["t0"] + 400, abs=0.2)
    g.run_to(sinking["t0"] + 300)  # sink animation over, window still open
    assert g.moles()[0]["state"] == "sinking"
    g.stomp(*CENTRE)
    assert g.snap()["hits"] == 1


def test_empty_stomp_resets_combo_and_counts_a_miss_but_keeps_the_score():
    g = Game({"difficulty": {"max_active": [[0.0, 1]]}})
    g.start_round()
    first = g.hit_next()
    second = g.hit_next()
    busy = {m["hole"] for m in g.moles()} | {first["hole"], second["hole"]}
    empty = min(set(range(9)) - busy)
    g.stomp_hole(empty)
    event = g.events[-1]
    assert event["name"] == "empty_stomp" and event["hole"] == empty
    assert (event["x"], event["y"]) == (round(g.holes[empty][0], 1), round(g.holes[empty][1], 1))
    snap = g.snap()
    assert (snap["score"], snap["combo"], snap["best_combo"], snap["misses"]) == (2, 0, 2, 1)


def test_escape_resets_combo():
    g = Game({"difficulty": {"max_active": [[0.0, 1]]}})
    g.start_round()
    g.hit_next()
    g.run_until(lambda: g.named("escaped"))
    snap = g.snap()
    assert (snap["score"], snap["combo"], snap["best_combo"], snap["misses"], snap["escaped"]) == (1, 0, 1, 1, 1)
    assert g.named("escaped")[0]["mole_id"] == 2


def test_double_stomp_on_a_just_hit_hole_is_neutral():
    g = Game({"difficulty": {"max_active": [[0.0, 1]]}})
    g.start_round()
    mole = g.hit_next()
    hit_at = g.t
    g.run_to(hit_at + 100)
    g.stomp_hole(mole["hole"])  # the other foot of a two-footed jump
    g.run_to(hit_at + 500)
    g.stomp_hole(mole["hole"])
    assert g.snap()["misses"] == 0 and g.snap()["combo"] == 1
    g.run_to(hit_at + 600)
    hx, hy = g.holes[mole["hole"]]
    # well after: an ordinary empty stomp (35 px off centre: not where the last foot just lifted)
    g.stomp(hx + 35, hy)
    assert g.events[-1]["name"] == "empty_stomp" and g.snap()["misses"] == 1


def test_combo_milestones():
    g = Game({"difficulty": {"max_active": [[0.0, 1]]}})
    g.start_round()
    for _ in range(11):
        g.hit_next()
    assert [e["combo"] for e in g.named("hit")] == list(range(1, 12))
    assert [e["combo"] for e in g.named("combo")] == [5, 10]
    names = [e["name"] for e in g.events]
    fifth_hit = [i for i, n in enumerate(names) if n == "hit"][4]
    assert names[fifth_hit + 1] == "combo"  # straight after the hit that reached it
    assert g.snap()["best_combo"] == 11


def test_combo_milestones_can_be_turned_off():
    g = Game({"difficulty": {"max_active": [[0.0, 1]]}, "combo": {"milestone_every": 0}})
    g.start_round()
    for _ in range(5):
        g.hit_next()
    assert g.named("combo") == []


def test_stomps_are_ignored_in_results_and_attract():
    g = Game(merge(ONE_HOLE, {"round": {"play_ms": 2000}}))
    g.start_round()
    g.finish_round()
    before = dict(g.snap()["result"])
    g.stomp(*CENTRE)
    g.run_until(g.phase_is("attract"))
    g.stomp(CENTRE[0] + 30, CENTRE[1])  # lands on the pad: arms it, but no stomp
    snap = g.snap()
    assert snap["result"] == before and snap["misses"] == before["misses"]
    assert not g.named("empty_stomp")


# ---------------------------------------------------------------------- spawning and difficulty


def run_full_round(g, step=16):
    """Play a round with nobody stomping; return per-tick (f, live moles) samples."""
    play = g.start_round()
    samples = []
    while g.engine.phase == "play":
        g.run_to(g.t + step)
        if g.engine.phase == "play":
            samples.append(((g.t - play) / 60000, len(g.moles(*LIVE))))
    return samples


def max_active(f):
    return 3 if f >= 0.55 else 2 if f >= 0.2 else 1


def test_spawns_never_exceed_max_active_and_ramp_up():
    g = Game()
    samples = run_full_round(g)
    assert all(live <= max_active(f) for f, live in samples)
    peak = {n: max(live for f, live in samples if max_active(f) == n) for n in (1, 2, 3)}
    assert peak == {1: 1, 2: 2, 3: 3}


def test_moles_stay_up_shorter_and_come_faster_as_the_round_goes_on():
    spawned = {}
    g2 = Game()
    play = g2.start_round()
    while g2.engine.phase == "play":
        g2.run_to(g2.t + 16)
        for m in g2.moles():
            spawned.setdefault(m["id"], m["up_ms"])
    up_ms = [spawned[k] for k in sorted(spawned)]
    assert up_ms == sorted(up_ms, reverse=True)
    assert 1480 < up_ms[0] <= 1500 and 650 <= up_ms[-1] < 750
    times = [e["now"] - play for e in g2.named("mole_up")]
    early = sum(1 for t in times if t < 15000)
    late = sum(1 for t in times if t >= 45000)
    assert late >= 2 * early


def test_first_mole_after_first_spawn_delay():
    g = Game()
    play = g.start_round()
    g.run_to(play + 499)
    assert g.moles() == []
    g.run_to(play + 500)
    assert g.named("mole_up")[0]["now"] == play + 500


def test_spawns_avoid_holes_with_feet_and_the_previous_hole():
    g = Game({"difficulty": {"max_active": [[0.0, 1]]}})
    g.press_start()
    for cid, hole in enumerate((0, 1, 2, 3), start=1):
        g.down(cid, *g.holes[hole])  # four people standing in holes since before GO
    g.finish_round()
    holes = [e["hole"] for e in g.named("mole_up")]
    assert len(holes) > 20
    assert not set(holes) & {0, 1, 2, 3}
    assert all(a != b for a, b in zip(holes, holes[1:]))
    snap = g.snap()
    assert snap["misses"] == snap["escaped"] and snap["hits"] == 0  # standing feet never stomped


def test_spawn_falls_back_to_occupied_and_previous_hole_when_nothing_else_is_free():
    g = Game(ONE_HOLE)
    g.start_round(stay=True)
    g.finish_round()
    holes = [e["hole"] for e in g.named("mole_up")]
    assert len(holes) > 10 and set(holes) == {0}


def test_one_mole_per_hole_and_the_hole_rests_after_its_mole_is_gone():
    g = Game(ONE_HOLE)
    g.start_round()
    g.hit_next()
    hit_at = g.t
    g.run_until(lambda: len(g.named("mole_up")) == 2)
    assert g.named("mole_up")[1]["now"] >= hit_at + 450 + 350
    g.run_until(lambda: g.named("escaped"))
    escaped_at = g.named("escaped")[0]["now"]
    g.run_until(lambda: len(g.named("mole_up")) == 3)
    assert g.named("mole_up")[2]["now"] >= escaped_at + 350 + 350


def test_mole_lifecycle_times():
    g = Game(ONE_HOLE)
    play = g.start_round()
    g.run_to(play + 500)
    m = g.moles()[0]
    up_ms = 1500 - 850 * (500 / 60000)
    assert (m["state"], m["t0"], m["t1"], m["rise_ms"], m["up_ms"]) == (
        "rising", play + 500, play + 660, 160, round(up_ms, 1))
    g.run_to(play + 660)
    m = g.moles()[0]
    assert (m["state"], m["t0"], m["t1"]) == ("up", play + 660, round(play + 660 + up_ms, 1))
    grace = g.cfg["moles"]["hit_grace_ms"]
    g.run_to(play + 660 + up_ms)
    m = g.moles()[0]
    assert (m["state"], m["t1"]) == ("sinking", round(play + 660 + up_ms + grace, 1))
    g.run_to(play + 660 + up_ms + grace)
    m = g.moles()[0]
    assert (m["state"], m["t1"]) == ("escaped", round(play + 660 + up_ms + grace + 350, 1))
    g.run_to(play + 660 + up_ms + grace + 350)
    assert g.moles() == []


def test_same_seed_same_game_different_seed_different_game():
    def play(seed):
        g = Game({"round": {"play_ms": 20000}}, seed=seed)
        g.start_round()
        for _ in range(3):
            g.hit_next()
        g.finish_round()
        return g.events

    assert play(7) == play(7)
    assert [e for e in play(7) if e["name"] == "mole_up"] != [e for e in play(8) if e["name"] == "mole_up"]


# ---------------------------------------------------------------------- end of round, results, high scores


def test_round_end_removes_live_moles_without_counting_them_as_escaped():
    g = Game(merge(ONE_HOLE, {"round": {"play_ms": 2000}}))
    play = g.start_round()
    g.run_to(play + 1999)
    assert g.moles(*LIVE)
    g.run_to(play + 2000)
    snap = g.snap()
    assert snap["phase"] == "results" and snap["moles"] == []
    assert (snap["escaped"], snap["misses"]) == (0, 0) and not g.named("escaped")
    assert g.named("round_end") == [{"type": "event", "now": play + 2000, "name": "round_end", "score": 0,
                                     "best_combo": 0, "hits": 0, "misses": 0, "rank": None,
                                     "new_high": False}]
    assert (snap["phase_start"], snap["phase_end"], snap["time_left_ms"]) == (play + 2000, play + 10000, None)


def test_hit_animation_finishes_during_results():
    g = Game(merge(ONE_HOLE, {"round": {"play_ms": 2000}}))
    play = g.start_round()
    g.run_to(play + 1900)
    g.stomp(*CENTRE)
    g.run_to(play + 2000)
    assert [m["state"] for m in g.moles()] == ["hit"]
    g.run_to(play + 1900 + 450)
    assert g.moles() == []


def test_results_then_back_to_attract():
    g = Game(merge(ONE_HOLE, {"round": {"play_ms": 2500}}))
    play = g.start_round()
    g.hit_next()
    g.finish_round()
    end = play + 2500
    result = g.snap()["result"]
    assert result == {"score": 1, "best_combo": 1, "hits": 1, "misses": 0, "rank": 1, "new_high": True}
    g.run_to(end + 7999)
    assert g.engine.phase == "results"
    g.run_to(end + 8000)
    snap = g.snap()
    assert g.events[-1] == {"type": "event", "now": end + 8000, "name": "attract"}
    assert (snap["phase"], snap["phase_start"], snap["phase_end"]) == ("attract", end + 8000, None)
    assert snap["result"] == result  # kept until the next round starts
    assert snap["score"] == 1 and snap["level"] == 0
    g.press_start()
    assert g.snap()["result"] is None and g.snap()["score"] == 0


def test_high_scores_rank_and_new_high():
    g = Game(merge(ONE_HOLE, {"round": {"play_ms": 6000, "results_ms": 1000}}))

    def round_with(hits):
        g.run_until(g.phase_is("attract"))
        g.start_round()
        for _ in range(hits):
            g.hit_next()
        g.finish_round()
        return g.named("round_end")[-1]

    first = round_with(2)
    assert (first["score"], first["rank"], first["new_high"]) == (2, 1, True)
    second = round_with(1)
    assert (second["score"], second["rank"], second["new_high"]) == (1, 2, False)
    third = round_with(0)
    assert (third["rank"], third["new_high"]) == (None, False)
    fourth = round_with(3)
    assert (fourth["rank"], fourth["new_high"]) == (1, True)
    assert [e["score"] for e in g.snap()["highscores"]] == [3, 2, 1]
    assert g.snap()["result"]["rank"] == 1


def test_works_without_a_high_score_table():
    cfg = config.build_config({"round": {"play_ms": 1000}})
    engine = GameEngine(cfg, None, random.Random(1), 0)
    engine.touch_down(1, *PAD, 0)
    engine.update(10_000)
    snap = engine.snapshot(10_000)
    assert snap["highscores"] == [] and snap["result"]["rank"] is None


# ---------------------------------------------------------------------- the data feed


def test_snapshot_fields_match_the_data_feed():
    g = Game({"difficulty": {"max_active": [[0.0, 1]]}})
    g.down(1, 50, 50)
    snap = g.snap()
    assert set(snap) == STATE_KEYS and snap["type"] == "state" and snap["now"] == 0
    assert snap["touches"] == [{"id": 1, "x": 50, "y": 50}]
    g.press_start()
    g.run_until(g.phase_is("play"))
    g.hit_next()
    g.run_until(lambda: g.moles("up"))
    snap = g.snap()
    assert set(snap) == STATE_KEYS
    assert snap["phase"] == "play" and snap["result"] is None
    assert isinstance(snap["time_left_ms"], int)
    assert {state for m in snap["moles"] for state in [m["state"]]} <= {"rising", "up", "sinking", "hit", "escaped"}
    for mole in snap["moles"]:
        assert set(mole) == {"id", "hole", "state", "t0", "t1", "rise_ms", "up_ms"}
    for touch in snap["touches"]:
        assert set(touch) == {"id", "x", "y"}
    g.finish_round()
    snap = g.snap()
    assert set(snap["result"]) == {"score", "best_combo", "hits", "misses", "rank", "new_high"}
    assert set(snap["highscores"][0]) == {"score", "best_combo", "time"}
    assert json.loads(json.dumps(snap)) == snap


def test_every_event_has_the_documented_fields():
    g = Game({"difficulty": {"max_active": [[0.0, 1]]}, "round": {"play_ms": 20000, "results_ms": 1000}})
    g.start_round()
    for _ in range(5):
        g.hit_next()
    g.stomp_hole(min(set(range(9)) - {m["hole"] for m in g.moles()} - {e["hole"] for e in g.named("hit")}))
    g.run_until(lambda: g.named("escaped"))
    g.run_until(g.phase_is("attract"))
    assert {e["name"] for e in g.events} == set(EVENT_FIELDS)
    for event in g.events:
        assert set(event) == {"type", "now", "name"} | EVENT_FIELDS[event["name"]], event
        assert event["type"] == "event"
    assert [e["now"] for e in g.events] == sorted(e["now"] for e in g.events)
    assert json.loads(json.dumps(g.events)) == g.events


def test_public_config_matches_the_hello_message():
    g = Game()
    pub = g.engine.public_config()
    assert set(pub) == {"floor", "grid", "holes", "start_pad", "hud", "round", "moles", "highscores", "audio",
                        "room"}
    assert pub["floor"] == {"width": 560, "height": 448}
    assert pub["grid"] == {"cols": 3, "rows": 3, "top_margin": 40}
    assert pub["holes"][0] == {"index": 0, "x": 93.3, "y": 108.0, "draw_radius": 48, "hit_radius": 58,
                               "exit_radius": 100, "miss_radius": 48}
    assert [set(h) for h in pub["holes"]] == [
        {"index", "x", "y", "draw_radius", "hit_radius", "exit_radius", "miss_radius"}] * 9
    assert pub["start_pad"] == {"x": 280, "y": 244, "radius": 72, "hold_ms": 1000}
    assert pub["hud"] == {"show_on_floor": "auto", "rotation": 0}
    assert pub["round"] == {"play_ms": 60000, "countdown_step_ms": 1000, "go_ms": 800, "results_ms": 8000,
                            "first_spawn_delay_ms": 500, "time_warning_s": 10}
    assert pub["moles"] == {"rise_ms": 160, "sink_ms": 200, "hit_anim_ms": 450, "escape_anim_ms": 350}
    assert pub["highscores"] == {"size": 10}
    assert pub["audio"] == {"volume": 0.8}
    # the walls get the whole room block (canvas, safe inset, fps and the four regions)
    assert pub["room"] == config.DEFAULTS["room"]
    assert pub["room"]["front"] == {"x": 800, "y": 787, "w": 1000, "h": 1013}
    pub["room"]["front"]["x"] = -1  # a copy: changing a hello never changes the game's config
    assert g.cfg["room"]["front"]["x"] == 800
    custom = Game({"highscores": {"size": 20}, "holes": {"top_margin": 0, "rows": 2},
                   "round": {"time_warning_s": 5}, "hud": {"show_on_floor": False},
                   "room": {"fps": 30, "left": {"w": 790}}}).engine.public_config()
    assert (custom["highscores"]["size"], custom["grid"]["top_margin"], custom["grid"]["rows"],
            custom["round"]["time_warning_s"]) == (20, 0, 2, 5)
    assert custom["hud"]["show_on_floor"] is False
    assert custom["room"]["fps"] == 30 and custom["room"]["left"] == {"x": 0, "y": 787, "w": 790, "h": 1014}
    pub = g.engine.public_config()
    hello = g.engine.hello(12.34)
    assert hello == {"type": "hello", "now": 12.3, "config": pub}
    assert json.loads(json.dumps(hello)) == hello


def test_drain_events_empties_the_queue():
    g = Game()
    g.engine.touch_down(1, *PAD, 0)
    assert len(g.engine.drain_events()) == 1
    assert g.engine.drain_events() == []


def test_clock_going_backwards_is_ignored():
    g = Game()
    g.down(1, *PAD)
    g.run_to(1500)
    g.engine.update(200)  # stale timestamp
    assert g.engine.phase == "countdown"
    g.engine.touch_down(2, *g.holes[0], 100)
    assert g.engine.drain_events() == []
