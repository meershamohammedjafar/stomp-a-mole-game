"""Game settings: load config.json, merge it over the built-in defaults, check it, derive the holes.

Every key in config.json is optional; anything left out takes the value in DEFAULTS below
(identical to DESIGN.md). ``load_config()`` returns one plain dict with the same sections, plus
``"hole_centres"``: the derived list of holes (see ``hole_centres()``). A relative
``highscores.file`` is turned into an absolute path inside this package's folder.
"""

import copy
import json
import logging
import math
from pathlib import Path

log = logging.getLogger(__name__)

PACKAGE_DIR = Path(__file__).resolve().parent
DEFAULT_PATH = PACKAGE_DIR / "config.json"

DEFAULTS = {
    "floor": {"width": 560, "height": 448},
    "tuio": {"host": "0.0.0.0", "port": 3333, "flip_x": False, "flip_y": False},
    "http": {"host": "0.0.0.0", "port": 8080},
    "window": {"mode": "borderless", "x": 0, "y": 0, "browser": "auto"},
    "hud": {"show_on_floor": "auto", "rotation": 0},
    "room": {"width": 2600, "height": 1820, "safe_inset": 40, "fps": 60,
             "ceiling": {"x": 800, "y": 0, "w": 1000, "h": 787},
             "left": {"x": 0, "y": 787, "w": 800, "h": 1014},
             "front": {"x": 800, "y": 787, "w": 1000, "h": 1013},
             "right": {"x": 1800, "y": 787, "w": 800, "h": 1014}},
    "holes": {"cols": 3, "rows": 3, "top_margin": 40, "draw_radius": 48, "hit_radius": 58, "exit_radius": 100,
              "miss_radius": 48},
    "start_pad": {"x": 280, "y": 244, "radius": 72, "hold_ms": 1000, "gap_ms": 250},
    "round": {"countdown_step_ms": 1000, "go_ms": 800, "play_ms": 60000, "results_ms": 8000,
              "first_spawn_delay_ms": 500, "time_warning_s": 10},
    "moles": {"rise_ms": 160, "sink_ms": 200, "hit_anim_ms": 450, "escape_anim_ms": 350,
              "hittable_from_rise_frac": 0.3, "hit_grace_ms": 350,
              "hole_cooldown_ms": 350, "double_stomp_ms": 500, "reland_ms": 500},
    "difficulty": {"up_ms_start": 1500, "up_ms_end": 650, "gap_ms_start": 1000, "gap_ms_end": 380,
                   "gap_jitter": 0.3, "max_active": [[0.0, 1], [0.2, 2], [0.55, 3]]},
    "input": {"debounce_ms": 120, "reacquire_px": 28, "merge_px": 30, "match_px": 56},
    "combo": {"milestone_every": 5},
    "highscores": {"size": 10, "file": "data/highscores.json"},
    "audio": {"volume": 0.8},
}

DERIVED_KEYS = {"hole_centres"}  # added by build_config, never read from the file
WINDOW_MODES = ("borderless", "kiosk", "none")
ROOM_REGIONS = ("ceiling", "left", "front", "right")
ROOM_SIZE_RANGE = (100, 8192)    # room.width / room.height: what the wall page (room.js) accepts
ROOM_INSET_MAX = 200             # room.safe_inset: the wall page's signboard layout allows no more


class ConfigError(ValueError):
    """The config file is missing, unreadable, or has a value the game cannot use."""


def load_config(path=None) -> dict:
    """Load ``path`` (default: this package's config.json) over DEFAULTS and return the full config.

    An explicit path that does not exist is an error; a missing default config.json just means
    "use the defaults".
    """
    explicit = path is not None
    file = Path(path) if explicit else DEFAULT_PATH
    try:
        text = file.read_text(encoding="utf-8-sig")  # -sig: Notepad may save a BOM
    except FileNotFoundError:
        if explicit:
            raise ConfigError(f"Config file not found: {file}") from None
        log.warning("No config file at %s; using the built-in defaults", file)
        return build_config({})
    except OSError as exc:
        raise ConfigError(f"Cannot read config file {file}: {exc}") from None
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{file} is not valid JSON (line {exc.lineno}, column {exc.colno}): "
                          f"{exc.msg}") from None
    if not isinstance(data, dict):
        raise ConfigError(f"{file} must hold a JSON object like {{\"round\": {{...}}}}")
    return build_config(data, source=str(file))


def build_config(overrides=None, source="config") -> dict:
    """Merge ``overrides`` (same shape as config.json, any subset) over DEFAULTS, check, derive."""
    cfg = _merge(DEFAULTS, overrides or {}, "", source)
    _validate(cfg, source)
    file = Path(cfg["highscores"]["file"])
    if not file.is_absolute():
        file = PACKAGE_DIR / file
    cfg["highscores"]["file"] = str(file)
    cfg["hole_centres"] = hole_centres(cfg)
    return cfg


def hole_centres(cfg) -> list[dict]:
    """The holes in row-major order (0 = top-left), centred in a grid below the HUD band."""
    width, height = cfg["floor"]["width"], cfg["floor"]["height"]
    holes = cfg["holes"]
    cols, rows, top = holes["cols"], holes["rows"], holes["top_margin"]
    return [
        {
            "index": r * cols + c,
            "x": width * (2 * c + 1) / (2 * cols),
            "y": top + (height - top) * (2 * r + 1) / (2 * rows),
            "draw_radius": holes["draw_radius"],
            "hit_radius": holes["hit_radius"],
            "exit_radius": holes["exit_radius"],
            "miss_radius": holes["miss_radius"],
        }
        for r in range(rows)
        for c in range(cols)
    ]


def _merge(base, over, prefix, source):
    out = copy.deepcopy(base)
    for key, value in over.items():
        name = f"{prefix}{key}"
        if key not in base:
            if not prefix and key in DERIVED_KEYS:
                continue
            # Kept, so a newer module can read its own section, but flagged in case it is a typo.
            log.warning("%s: unknown setting %r is not used by this version", source, name)
            out[key] = copy.deepcopy(value)
        elif isinstance(base[key], dict):
            if not isinstance(value, dict):
                raise ConfigError(f"{source}: {name} must be an object like {{...}}, got {value!r}")
            out[key] = _merge(base[key], value, name + ".", source)
        else:
            out[key] = copy.deepcopy(value)
    return out


def _validate(cfg, source):
    def fail(name, message, value):
        raise ConfigError(f"{source}: {name} {message}, got {value!r}")

    def number(section, key, *, low=None, above=None, high=None, below=None, whole=False):
        name, value = f"{section}.{key}", cfg[section][key]
        if whole and isinstance(value, float) and value.is_integer():
            value = cfg[section][key] = int(value)
        kinds = int if whole else (int, float)
        if isinstance(value, bool) or not isinstance(value, kinds) or not math.isfinite(value):
            fail(name, "must be a whole number" if whole else "must be a number", value)
        if low is not None and value < low:
            fail(name, f"must be at least {low}", value)
        if above is not None and value <= above:
            fail(name, f"must be more than {above}", value)
        if high is not None and value > high:
            fail(name, f"must be at most {high}", value)
        if below is not None and value >= below:
            fail(name, f"must be less than {below}", value)
        return value

    def flag(section, key):
        if not isinstance(cfg[section][key], bool):
            fail(f"{section}.{key}", "must be true or false", cfg[section][key])

    def text(section, key, choices=None):
        value = cfg[section][key]
        if not isinstance(value, str) or not value:
            fail(f"{section}.{key}", "must be a non-empty string", value)
        if choices and value not in choices:
            fail(f"{section}.{key}", "must be one of " + ", ".join(choices), value)

    number("floor", "width", above=0)
    height = number("floor", "height", above=0)
    for section in ("tuio", "http"):
        text(section, "host")
        number(section, "port", low=1, high=65535, whole=True)
    flag("tuio", "flip_x")
    flag("tuio", "flip_y")
    text("window", "mode", WINDOW_MODES)
    number("window", "x", whole=True)
    number("window", "y", whole=True)
    text("window", "browser")
    on_floor = cfg["hud"]["show_on_floor"]
    if not (on_floor is True or on_floor is False or on_floor == "auto"):
        # "auto": the floor shows its HUD only while no wall page ("room") is connected
        fail("hud.show_on_floor", 'must be "auto", true or false', on_floor)
    if number("hud", "rotation", whole=True) not in (0, 180):
        fail("hud.rotation", "must be 0 or 180", cfg["hud"]["rotation"])
    _validate_room(cfg["room"], fail)

    number("holes", "cols", low=1, whole=True)
    number("holes", "rows", low=1, whole=True)
    number("holes", "top_margin", low=0, below=height)
    number("holes", "draw_radius", above=0)
    hit = number("holes", "hit_radius", above=0)
    if number("holes", "exit_radius", above=0) < hit:
        fail("holes.exit_radius", f"must be at least holes.hit_radius ({hit})",
             cfg["holes"]["exit_radius"])
    number("holes", "miss_radius", above=0, high=hit)

    number("start_pad", "x")
    number("start_pad", "y")
    number("start_pad", "radius", above=0)
    number("start_pad", "hold_ms", low=0)
    number("start_pad", "gap_ms", low=0)

    number("round", "countdown_step_ms", above=0)
    number("round", "go_ms", low=0)
    number("round", "play_ms", above=0)
    number("round", "results_ms", low=0)
    number("round", "first_spawn_delay_ms", low=0)
    number("round", "time_warning_s", low=0, whole=True)

    for key in ("rise_ms", "sink_ms", "hit_anim_ms", "escape_anim_ms", "hit_grace_ms",
                "hole_cooldown_ms", "double_stomp_ms", "reland_ms"):
        number("moles", key, low=0)
    number("moles", "hittable_from_rise_frac", low=0, high=1)

    for key in ("up_ms_start", "up_ms_end", "gap_ms_start", "gap_ms_end"):
        number("difficulty", key, above=0)
    number("difficulty", "gap_jitter", low=0, below=1)
    cfg["difficulty"]["max_active"] = _max_active_steps(cfg["difficulty"]["max_active"], source)

    number("input", "debounce_ms", low=0)
    number("input", "reacquire_px", low=0)
    number("input", "merge_px", low=0)   # 0: every TUIO cursor is a contact of its own
    number("input", "match_px", low=0)
    number("combo", "milestone_every", low=0, whole=True)  # 0 turns combo milestones off
    number("highscores", "size", low=1, whole=True)
    text("highscores", "file")
    number("audio", "volume", low=0, high=1)


def _validate_room(room, fail):
    """room: the wall PC's canvas (the signage division) and the four regions in it, in desktop pixels."""

    def whole(name, value, low):
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        if isinstance(value, bool) or not isinstance(value, int):
            fail(name, "must be a whole number of pixels", value)
        if value < low:
            fail(name, f"must be at least {low}", value)
        return value

    low, high = ROOM_SIZE_RANGE
    for key in ("width", "height"):
        room[key] = whole(f"room.{key}", room[key], low)
        if room[key] > high:
            fail(f"room.{key}", f"must be at most {high} (the wall page's limit)", room[key])
    width, height = room["width"], room["height"]
    inset = room["safe_inset"]
    if isinstance(inset, bool) or not isinstance(inset, (int, float)) or not math.isfinite(inset) or inset < 0:
        fail("room.safe_inset", "must be a number of pixels, 0 or more", inset)
    if inset > ROOM_INSET_MAX:
        fail("room.safe_inset", f"must be at most {ROOM_INSET_MAX} (if more than that is cut off at the screens' "
                                f"edges, the regions are in the wrong place: correct room.ceiling, room.left, "
                                f"room.front and room.right with the test pattern instead)", inset)
    fps = room["fps"]
    if isinstance(fps, bool) or not isinstance(fps, (int, float)) or not math.isfinite(fps) or not 10 <= fps <= 120:
        fail("room.fps", "must be a number from 10 to 120", fps)
    for region in ROOM_REGIONS:
        rect = room[region]
        name = f"room.{region}"
        for key in ("x", "y"):
            rect[key] = whole(f"{name}.{key}", rect[key], 0)
        for key in ("w", "h"):
            rect[key] = whole(f"{name}.{key}", rect[key], 1)
        if rect["x"] + rect["w"] > width or rect["y"] + rect["h"] > height:
            fail(name, f"must lie inside room.width x room.height ({width} x {height}): x + w and y + h "
                       f"at most those", rect)
        if 2 * inset >= min(rect["w"], rect["h"]):
            fail("room.safe_inset", f"must be less than half of {name}'s smaller side "
                                    f"({min(rect['w'], rect['h'])} px)", inset)


def _max_active_steps(steps, source):
    """Check difficulty.max_active: [[threshold 0..1, moles >= 1], ...] with rising thresholds."""
    shape = "a list of [threshold, count] pairs like [[0.0, 1], [0.2, 2]]"
    if not isinstance(steps, list) or not steps:
        raise ConfigError(f"{source}: difficulty.max_active must be {shape}, got {steps!r}")
    out = []
    for pair in steps:
        ok = (isinstance(pair, list) and len(pair) == 2
              and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                      for v in pair))
        if not ok or not 0 <= pair[0] <= 1 or pair[1] < 1 or pair[1] != int(pair[1]):
            raise ConfigError(f"{source}: difficulty.max_active must be {shape} with thresholds "
                              f"0..1 and counts of at least 1, got {pair!r}")
        if out and pair[0] < out[-1][0]:
            raise ConfigError(f"{source}: difficulty.max_active thresholds must go up, got {steps!r}")
        out.append([float(pair[0]), int(pair[1])])
    return out
