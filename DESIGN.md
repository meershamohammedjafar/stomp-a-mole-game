# Stomp the Mole: design

A whack-a-mole arcade game played with the feet on the interactive LED floor.
This file is the contract between the parts of the build: game rules, step
detection, the data feed, and the file layout. The wall and ceiling screens
will later use the data feed described here.

## Owner decisions (2026-10-10)

| Topic | Decision |
|---|---|
| Holes | 9 holes, 3 x 3 grid |
| Players | One player at a time; any stomp counts for that player |
| Round | 60 seconds |
| Misses | Score only. A miss (escaped mole, or a stomp on an empty hole) resets the combo; score never goes down |
| Style | Cartoon moles (grassy field, dirt holes, cartoon moles), no brand |
| High scores | Today's top 10, scores only (no names, no personal data), resets each day |
| Start | Player stands on a START pad for 1 second |
| Tech | Web game (HTML canvas + JS) in a browser window, fed by a small stdlib-only Python server |
| Run mode | Own borderless window over the play pane (desktop 0,0, 560 x 448); Interactive Platform stays open to keep sending TUIO |
| Sounds | All synthesised in code (Web Audio). No sound files, so nothing to license |
| Speakers | Floor PC's speakers |
| Walls (13:22) | Front wall = scoreboard (countdown, timer, score, combo); left wall = today's top 10; right wall = round stats + celebrations. Attract: title + how to play / top 10 / waving mole pointing at the START pad |
| Floor HUD (13:22) | Score/timer move to the walls; the floor shows the playfield and effects (a setting brings the floor HUD back) |
| Wall/ceiling look (13:22) | Continue the cartoon meadow: one panorama across the 3 walls with wooden signboards; animated cartoon sky on the ceiling (clouds, sun, birds; fireworks/confetti on combos and new high scores; golden at TIME'S UP) |
| Wall PC (13:22) | Edge kiosk fullscreen shortcut on the wall PC; the game draws in the top-left 2600 x 1820 (the signage layout's division); nothing installed |
| Connection (13:54) | Local network: the wall PC reads the feed straight from the floor PC; both PCs get static IPs; the feed address stays a setting (a cloud relay can be added later) |

## Hardware facts

* Floor: 5 x 4 cabinets of 8 x 8 sensor cells. Interactive Platform's play pane
  is **560 x 448 px at desktop (0,0)**; the LED controller shows that region on the floor.
* Input: TUIO 1.1 over UDP **port 3333** on the same PC, profile `/tuio/2Dcur`
  only (x, y normalised 0..1, y = 0 at the top). There is no pressure value. Sensing is binary
  (a foot is on a cell or not). Positions were verified correct on site (no flip).
* One sensor cell is 14 x 14 px; a foot covers roughly 2 x 4 cells. **Not yet known** (record it on
  site with `tuio_receiver.py --record`, read it with `tuio_replay.py`): whether the platform sends one
  cursor per foot or one per pressed cell, whether a standing foot keeps its session id, how often and
  for how long a standing foot drops out, and the platform's frame rate. Step detection is built to
  survive all of these (see "TouchTracker"); its settings are tuned from that recording.
* A short delay between a step and its TUIO event was observed (cause and size not measured yet). The
  hit window has a grace period after the mole starts sinking to absorb it (see `hit_grace_ms`).
* Floor PC: Windows 10, Python 3.13, Microsoft Edge. **No pip packages**: everything
  is Python standard library. The floor PC may be offline, so nothing loads from the internet:
  no CDNs, no web fonts, no images. All art is drawn with canvas code.
* Walls and ceiling: driven by a **separate wall PC** (Windows 11, 3840 x 2160 at 100% scale, Ethernet
  192.168.10.78). The floor PC is on Wi-Fi at 192.168.123.228; the two subnets are routed (ping 3 ms, 0% loss).
  The signage layout "3D" uses a 2600 x 1820 division at the top-left of the 4K desktop.
  **Exact LED layout, supplied by the owner on 2026-10-12** (a labelled 3840 x 2160 layout image; positions measured
  from it at 1.92 px per image px and matching the labels): **ceiling 1000 x 787 at (800, 0)**, **left wall
  800 x 1014 at (0, 787)**, **front wall 1000 x 1013 at (800, 787)**, **right wall 800 x 1014 at (1800, 787)**. The lit
  area is 2600 x 1801; rows 1801..1819 of the division are not on any LED. (An earlier estimate from the 2600 x
  1800 sample video, ceiling 1000 x 786 and walls from y 786, was 1 px off.) The defaults use the exact values;
  `room.html?test=1` still draws a test pattern to confirm them on the real LEDs.

## Architecture

```
Interactive Platform --TUIO/UDP 3333--> stomp_the_mole server (Python, asyncio, stdlib only)
                                          |-- touch_input.TouchTracker  (TUIO frames -> one contact per foot, debounce)
                                          |-- game.GameEngine            (ALL game state & rules; authoritative)
                                          |-- highscores.HighScores      (today's top 10, JSON file)
                                          `-- netserver                  (HTTP static files + WebSocket hub)
                                                 |
                         ws://<floor-pc>:8080/ws  (JSON, see "Data feed")
                                                 |
        floor.html (floor PC: renderer + sound, 560x448)     room.html (wall PC, over the LAN: walls + ceiling,
                                                              2600x1820, no sound)
                                                             scoreboard.html (test view of the feed)
```

**The Python game engine is the one place where score, timer, combo, countdown, moles and
high scores live.** Browser pages are renderers. They draw what the feed says and play
sounds on events, and never decide game outcomes. The walls and ceiling are another page on the
same feed; the game does not change for them.

## File layout (project root `E:\Projects\interactive Floor`)

```
DESIGN.md                     this file
README.md                     how to run (operator-facing, short)
Start Stomp the Mole.bat      double-click launcher: cd to folder, `python -m stomp_the_mole`, pause on exit
tuio_receiver.py              OSC/TUIO decoder (TuioState, iter_messages; REUSE, do not copy) and on-site printer:
                              ms timestamps, `--raw`, `--record FILE` (one JSON line per packet)
tuio_replay.py                on-site tool: reads a --record file and measures frame rate, cursors per foot,
                              id stability, dropouts and the stomps the game would see
tuio_floor_map.py             existing diagnostic map (unchanged; gets iter_messages' framing checks)
fake_floor.py                 dev tool: Tk window that acts as the floor (mouse = foot), sends TUIO to 127.0.0.1:3333
stomp_the_mole/
  __init__.py
  __main__.py                 `python -m stomp_the_mole [--config PATH] [--no-window] [--seed N]` -> run.main()
  config.json                 all tunables (below)
  config.py                   load config.json, merge over defaults, derive hole centres
  touch_input.py              TouchTracker
  game.py                     GameEngine (pure logic, no I/O, injected clock/rng/highscores)
  highscores.py               HighScores (JSON file, atomic write, daily reset)
  netserver.py                asyncio HTTP static + WebSocket hub + TUIO UDP endpoint + game loop
  window.py                   launch Edge/Chrome app window, make it borderless at 0,0 560x448 (Win32 ctypes)
  run.py                      wires everything, console status lines, clean shutdown
  data/                       created at runtime (highscores.json); not committed
  web/
    floor.html  floor.js  audio.js  feed.js   (feed.js = shared WebSocket client: connect, reconnect, clock sync)
    room.html  room.js  sky.js                (walls + ceiling; sky.js = the ceiling's animated sky)
    scoreboard.html  scoreboard.js
wall_pc/                      copy this folder to the wall PC (no Python needed there)
  Start Walls.bat             waits until the game answers, then Edge kiosk on the 4K desktop ->
                              http://%FLOOR_PC%:%GAME_PORT%/room.html
  Wall Test Pattern.bat       same, with ?test=1 (region outlines to confirm the wall/ceiling edges);
                              calls Start Walls.bat, so FLOOR_PC and GAME_PORT are set in one place
  README.txt                  how to set FLOOR_PC (and GAME_PORT), start, stop (Alt+F4), firewall fixes
tests/
  test_touch_input.py  test_game.py  test_highscores.py  test_netserver.py
  test_end_to_end.py   (a bot plays one round over real UDP TUIO and the WebSocket feed; the static files,
                        including the wall page's, are served)
  test_run_window.py   (console logging, the browser's kill-on-close job, the window keeper's messages,
                        the wall PC address lines)
  test_tuio_tools.py   (iter_messages framing, --record lines, tuio_replay)
```

`python -m stomp_the_mole` is run from the project root, so `import tuio_receiver` resolves to the
root file. Python >= 3.11, stdlib only. Tests use pytest (dev machine only).

## Coordinates

All game geometry is in **floor pixels**: x 0..560 left to right, y 0..448 top to bottom, matching the
play pane. TUIO (x, y) maps to (x * 560, y * 448), with optional `flip_x` / `flip_y` applied first.
Distances are Euclidean in floor pixels.

Hole centres (3 x 3) leave a `top_margin` band for the floor HUD:
`x = W * (2c+1)/(2*cols)`, `y = top_margin + (H - top_margin) * (2r+1)/(2*rows)`.
With the defaults that is x = 93.3, 280, 466.7 and y = 108, 244, 380 (rows 136 px apart, columns 186.7 px
apart). Hole index `i = r*cols + c` (row-major, 0 = top-left). The START pad is at the floor centre
(280, 244), shown only in attract.

Radii around each hole centre (defaults): `miss_radius` 48 (= `draw_radius`, the dirt hole as drawn) <
`hit_radius` 58 (the drawn hole plus a margin for foot size) < `exit_radius` 100 (hit radius plus 3 cells:
the hysteresis band, see "Step detection").

## Config (`stomp_the_mole/config.json`, all keys optional; defaults below)

```json
{
  "floor":   {"width": 560, "height": 448},
  "tuio":    {"host": "0.0.0.0", "port": 3333, "flip_x": false, "flip_y": false},
  "http":    {"host": "0.0.0.0", "port": 8080},
  "window":  {"mode": "borderless", "x": 0, "y": 0, "browser": "auto"},
  "hud":     {"show_on_floor": "auto", "rotation": 0},
  "room":    {"width": 2600, "height": 1820, "safe_inset": 40, "fps": 60,
              "ceiling": {"x": 800,  "y": 0,   "w": 1000, "h": 787},
              "left":    {"x": 0,    "y": 787, "w": 800,  "h": 1014},
              "front":   {"x": 800,  "y": 787, "w": 1000, "h": 1013},
              "right":   {"x": 1800, "y": 787, "w": 800,  "h": 1014}},
  "holes":   {"cols": 3, "rows": 3, "top_margin": 40, "draw_radius": 48, "hit_radius": 58, "exit_radius": 100,
              "miss_radius": 48},
  "start_pad": {"x": 280, "y": 244, "radius": 72, "hold_ms": 1000, "gap_ms": 250},
  "round":   {"countdown_step_ms": 1000, "go_ms": 800, "play_ms": 60000, "results_ms": 8000,
              "first_spawn_delay_ms": 500, "time_warning_s": 10},
  "moles":   {"rise_ms": 160, "sink_ms": 200, "hit_anim_ms": 450, "escape_anim_ms": 350,
              "hittable_from_rise_frac": 0.3, "hit_grace_ms": 350,
              "hole_cooldown_ms": 350, "double_stomp_ms": 500, "reland_ms": 500},
  "difficulty": {"up_ms_start": 1500, "up_ms_end": 650, "gap_ms_start": 1000, "gap_ms_end": 380,
                 "gap_jitter": 0.3, "max_active": [[0.0, 1], [0.2, 2], [0.55, 3]]},
  "input":   {"debounce_ms": 120, "reacquire_px": 28, "merge_px": 30, "match_px": 56},
  "combo":   {"milestone_every": 5},
  "highscores": {"size": 10, "file": "data/highscores.json"},
  "audio":   {"volume": 0.8}
}
```

`window.mode`: `borderless` (default), `kiosk` (fullscreen browser; the page draws at top-left only),
or `none` (do not open a browser). `hud.rotation`: 0 or 180 (turns the floor text to face the other
side of the room; the playfield is not rotated; see "Floor renderer" for how the HUD band turns).
`hud.show_on_floor`: `"auto"` (default), `true` or `false`. `"auto"` means the floor shows its HUD band and
its top-N panels only while **no** `room` page is connected (see `screens` in the state message), so the
game is complete on the floor alone and moves its HUD to the walls as soon as they connect.
`http.host` is "0.0.0.0" so the wall PC can read the feed over the LAN. Windows Firewall must let python.exe
accept connections (local pages work either way). Windows asks only the first time python.exe uses the network
(maybe long before the walls, e.g. for `tuio_floor_map.py`) and never again; a refusal then leaves Block rules
for python.exe, which win over any Allow rule. README.md ("Firewall") and wall_pc\README.txt give the fix:
delete python's Block rules in wf.msc, then allow python for Private and Public. Set `http.host` to "127.0.0.1"
to keep the feed on the floor PC only.
`room`: the wall/ceiling canvas (the signage division) and the four regions in it, in wall-PC desktop
pixels (see "Hardware facts": the defaults are the owner's exact LED layout; confirm with the test pattern).
The walls end at y 1800 (front) / 1801 (sides); the division's last rows are not lit. Wall content keeps its
important parts above y = 1800 - `safe_inset`. `fps` caps the room page's frame rate
(30 is fine if the wall PC struggles). config.py refuses a `room` where `width`, `height` or a region's `x`, `y`,
`w`, `h` are not whole pixels, `width` or `height` is outside 100..8192, a region is empty or sticks out of
`width` x `height`, `safe_inset` is negative, above 200 or not less than half of some region's smaller side, or
`fps` is outside 10..120 (the limits of the wall page, which only clamps, with a console warning, values a game
sends anyway). A bigger `safe_inset` shrinks the front wall's digits to fit their panels below 300 px (the wall
page's console says so); see JOURNAL 2026-10-12 for the value measured with the 1013 px front wall. More than about 200
px cut off at an edge means the regions are in the wrong place: correct them rather than the inset.

**Step-detection settings that are guesses until the floor is recorded on site** (see "Hardware facts"):
`input.merge_px` (raise to about 42 if feet split into heel and toe blobs), `input.debounce_ms` (longest
dropout of a standing foot + one frame, at most about 200), `holes.exit_radius` (how far a standing
foot's reported position wanders), and `moles.hit_grace_ms` (sink_ms + measured input latency + about
50 ms for the browser and LED controller).

## Game rules (GameEngine)

Clock: `now` is milliseconds (float) from an injected monotonic clock. All timings are in config.

### Phases
1. **attract**: idle. The START pad is active. Progress fills while an *armed* touch is inside the pad
   (distance <= pad radius). Gaps shorter than `gap_ms` (sensor flicker) do not reset progress. A longer
   gap resets it to 0. Progress reaching `hold_ms` -> **countdown**.
   *Armed* means the touch went down, or entered the pad, after attract began. This stops a player who is
   still standing in the centre after a round from instantly restarting the next one. While nobody armed
   is on the pad but an unarmed touch is inside it, the state's `start_blocked` is true and the floor asks
   that person to step off and back on (lifting a foot for longer than `debounce_ms` also arms it).
2. **countdown**: shows 3, 2, 1, each for `countdown_step_ms`. No moles. Stomps do nothing.
3. **play**: lasts `play_ms` and begins with "GO" (`countdown` field = "GO" for the first `go_ms`).
   The first mole spawns after `first_spawn_delay_ms`. In the last `time_warning_s` seconds a
   `time_warning` event fires once per whole second (10, 9, ..., 1). When the timer reaches 0, every live mole
   is removed **without** counting as escaped. The round result is submitted to high scores ->
   **results**.
4. **results**: lasts `results_ms` and shows the final score, best combo, rank and today's table. Input is ignored.
   Then -> **attract** (touches present at that moment are not armed).

### Difficulty (f = elapsed play time / play_ms, clamped 0..1)
* `up_ms = lerp(up_ms_start, up_ms_end, f)` is how long a mole stays fully up (fixed when it spawns).
* `gap = lerp(gap_ms_start, gap_ms_end, f) * uniform(1 - gap_jitter, 1 + gap_jitter)` is the delay
  until the next spawn attempt.
* `max_active(f)` is the value of the last `[threshold, n]` pair with threshold <= f (1, then 2, then 3).
* `level` in the snapshot = f.

### Mole lifecycle
`rising (rise_ms) -> up (up_ms) -> sinking (until the hittable window closes, hit_grace_ms; the sink
animation itself takes sink_ms) -> escaped (escape_anim_ms) -> gone`. A mole can also go from any hittable
moment to `hit (hit_anim_ms) -> gone`. One mole per hole at a time. After a hole's mole is gone, the hole
stays unavailable for `hole_cooldown_ms`.

**Spawning:** when `now >= next_spawn_at` and live (non-gone, non-hit, non-escaped) moles < `max_active`,
pick uniformly at random from the holes that are free (no mole, not cooling down) **and** have no touch
within `exit_radius` (a foot that near could not score there without lifting, and is where sensor wobble
could look like a step), and that are not the hole used by the previous spawn. If that set is empty, drop
the touch and previous-hole filters. If no hole is free at all, retry next tick. After a spawn,
`next_spawn_at = now + gap`.

**Hittable window:** from `rise_start + rise_ms * hittable_from_rise_frac` to
`sink_start + hit_grace_ms`. The grace must be at least `sink_ms` + the input latency (foot to TUIO) +
about 50 ms for the browser and LED controller to show a frame, so a mole the player can still see is
always hittable. The default 350 (= 200 + 150) is a guess until the latency is measured on site. With
the grace longer than the sink, the mole stays "sinking" (drawn fully down) until the window closes,
and only then does it become escaped; the escape (sound, puff) therefore comes about 150 ms after the
mole has visibly gone. If the grace is set shorter than `sink_ms`, the mole escapes while the floor is
still animating its sink, and the floor finishes that animation from `sink_ms`.

### Step detection: what counts as a stomp
The TouchTracker turns raw TUIO into clean contacts (`down`, `move`, `up`), one per foot, with stable ids
(see below). The engine keeps, per contact, the set of holes the foot has **cleared**: been farther than
`exit_radius` from since it landed (or since it last stomped that hole). Hysteresis works both ways, into
and out of a hole:
* On **down** at p: cleared = every hole farther than `exit_radius` from p. If some hole has
  `dist(p, hole) <= hit_radius` (the nearest one if several), that is a **stomp** on that hole.
* On **move** to p: add every hole farther than `exit_radius` from p to cleared. If p is within
  `hit_radius` of a hole (the nearest one) **and that hole is in cleared**, it is a **stomp** on that hole
  (entering from well outside), and the hole leaves cleared. Any other move is not a stomp.
* On **up**: forget the contact (and remember where it lifted, for `reland_ms`).

So a foot that is standing still never stomps, whether it stands in a hole or on the grass right beside
one (rows are only 20 px apart outside their hit circles, so a planted foot's reported position can
easily wobble by a cell across a rim). Only a fresh landing (a new down) or a foot that really travels
from beyond `exit_radius` into `hit_radius` counts. Lifting and stomping again counts. Trade-off: a foot
that lands short (between `hit_radius` and `exit_radius`) and then settles or slides inward does not
score; the player lifts and stomps again.

**Resolving a stomp on hole h at position p, time t (play phase only; ignored in other phases):**
* If h has a mole inside its hittable window -> **hit**: `score += 1`, `combo += 1`,
  `best_combo = max(...)`, `hits += 1`, mole -> `hit`. Event `hit`. If `combo % milestone_every == 0`,
  also event `combo`.
* Else if h's mole was hit within the last `double_stomp_ms` -> **neutral**, nothing happens. (The second
  foot of a two-footed jump is not punished.)
* Else if h's mole is rising but not yet hittable -> **neutral** (too early, not counted as a miss).
* Else if h's mole has just escaped (it is in its `escaped` animation) -> **neutral** (too late, but the
  escape already counted: one late stomp is one miss, not two).
* Else if `dist(p, h) > miss_radius` -> **neutral** (on the grass at the rim, outside the drawn hole).
* Else if a foot lifted within `input.reacquire_px` of p less than `reland_ms` ago -> **neutral** (the
  same foot coming back after a sensor dropout longer than `debounce_ms`, not a new step).
* Else if h had an empty stomp within the last `double_stomp_ms` -> **neutral** (one footstep reported
  as several touches is one miss).
* Else -> **empty stomp**: `combo = 0`, `misses += 1`, event `empty_stomp`.

**Escape:** when a mole's hittable window closes without a hit: `combo = 0`, `misses += 1`,
`escaped += 1`, mole -> `escaped`, event `escaped`.

Stomps outside every hole's `hit_radius` do nothing, and on an empty hole a stomp only counts as a miss
inside the drawn hole (`miss_radius`), so stepping on visible grass never breaks the combo. Between the
rows the grass outside the hit circles is only 20 px (1.4 cells) wide, but 40 px of it is visible and free;
the column lanes (70 px between hit circles) are the wide free paths. `miss_radius` is an owner-adjustable
choice: set it to `hit_radius` to count every stomp inside the hit circle of an empty hole as a miss.

### Scoring
Each mole caught is worth 1 point. The combo is the current streak of hits; `best_combo` is the longest
streak. There is no multiplier and the score never decreases.

## TouchTracker (touch_input.py)

Input: whole TUIO frames. After every UDP packet that carried `/tuio/2Dcur` messages, the server passes
the fields (`"x"`, `"y"` normalised) of every cursor alive in `tuio_receiver.TuioState` to `on_frame`.
Output: contact events `("down"|"move"|"up", contact_id, x_px, y_px)`, one contact per **foot**. Contact
ids are tracker-assigned ints. TUIO session ids, and the order of alive / set messages inside a bundle,
are never used: a platform output whose ids swap between feet, relabel a standing foot, or put set before
alive gives the same contacts.

Per frame:
1. **Feet:** cursors closer than `merge_px` (single linkage, so a chain of adjacent cells is one foot) are
   one foot, at their mean position. With one cursor per pressed cell (a foot is about 2 x 4 cells, 14 px
   apart) this still gives one contact per foot; 30 px also covers a one-cell gap. Trade-off: a second foot
   landing within `merge_px` (about two cells) of a planted foot is not seen as a new foot.
2. **Carry on:** each live contact moves to the nearest foot within `match_px` (nearest pairs first). That
   is a **move** if the position changed.
3. **Debounce (sensor flicker):** a live contact with no foot this frame is held *pending* for
   `debounce_ms`; it is not reported as "up" yet. A foot without a live contact that is within
   `reacquire_px` of a pending contact's last position continues it (nearest first): a **move** at most,
   never a new down. When the pending time runs out, "up" is reported. `tick(now)` flushes expired pendings.
4. Any other foot is a new contact: **down**.

A lift shorter than `debounce_ms` on the same spot is therefore not a new stomp (it cannot be told apart
from a dropout). A dropout longer than that does give up + down; the engine's `reland_ms` rule keeps such
a down from counting as a miss on an empty hole.

API:
```python
class TouchTracker:
    def __init__(self, floor_w, floor_h, debounce_ms=120, reacquire_px=28, merge_px=30, match_px=56,
                 flip_x=False, flip_y=False): ...
    def on_frame(self, points: list[dict], now: float) -> list[tuple]: ...   # one TUIO frame
    def on_tuio(self, event: str, session_id, fields: dict, now: float) -> list[tuple]: ...
        # per-cursor "add"/"update"/"remove" callbacks (tools, tests): keeps its own cursor table and
        # runs on_frame on it after each change
    def tick(self, now: float) -> list[tuple]: ...
    def contacts(self) -> dict[int, tuple[float, float]]   # live + pending contacts: id -> (x_px, y_px)
```
Only `/tuio/2Dcur` is fed to the tracker. Other profiles are ignored, with one log line per new address.
At most 256 cursors per frame are looked at.

## GameEngine API (game.py)

```python
class GameEngine:
    def __init__(self, cfg: dict, highscores, rng: random.Random, now: float): ...  # starts in attract
    def touch_down(self, cid: int, x: float, y: float, now: float) -> None: ...
    def touch_move(self, cid: int, x: float, y: float, now: float) -> None: ...
    def touch_up(self, cid: int, now: float) -> None: ...
    def handle_contacts(self, contact_events, now: float) -> None: ...  # TouchTracker output, in order
    def update(self, now: float) -> None: ...          # advance phases, spawns, escapes, timers
    def drain_events(self) -> list[dict]: ...          # events produced since the last drain, in order
    def snapshot(self, now: float) -> dict: ...        # "state" message (see Data feed)
    def public_config(self) -> dict: ...                # "hello" config body (see Data feed)
    def hello(self, now: float) -> dict: ...            # the whole "hello" message
```
The touch_* methods may produce events (hits, empty stomps). They take effect at the given `now`.
`highscores` provides `submit(score:int, best_combo:int) -> int|None` (1-based rank or None) and
`top() -> list[dict]`.

## High scores (highscores.py)

`HighScores(path, size=10, today=callable returning date, clock=callable returning "HH:MM")`. The file
`{"date": "YYYY-MM-DD", "scores": [{"score": int, "best_combo": int, "time": "HH:MM"}]}` is sorted by
score descending; ties keep the earlier entry first. Scores of 0 are not recorded (rank None). When the
stored date is not today, the table is empty. Writes are atomic (temp file + `os.replace`). The file is
read once, at start, as UTF-8 with or without a BOM (Notepad). A missing file starts an empty table; a
file that is there but unreadable or not in this format is renamed to `highscores.json.bad` (so the next
save cannot destroy it) and an empty table starts. Both are logged; neither crashes the game. Deleting
the file while the game runs does not clear the table (the next save writes it back): stop the game first.

## Data feed (WebSocket `ws://<host>:8080/ws`, JSON text frames)

Every server message has `"type"` and `"now"`: server clock in ms, the same clock as the engine. Clients
estimate `server_now = performance.now() + offset` (keep the max of `msg.now - performance.now()` seen,
and re-take the max over a sliding window so drift cannot run away) and drive animations from it.

**server -> client**

* On connect: `{"type":"hello","now":..,"config":{...}}`, where config =
  `{"floor":{"width":560,"height":448},"grid":{"cols":3,"rows":3,"top_margin":40},
   "holes":[{"index":0,"x":..,"y":..,"draw_radius":..,"hit_radius":..,"exit_radius":..,"miss_radius":..},...],
   "start_pad":{"x":..,"y":..,"radius":..,"hold_ms":..},"hud":{"show_on_floor":"auto","rotation":0},
   "round":{"play_ms":60000,"countdown_step_ms":1000,"go_ms":800,"results_ms":8000,
            "first_spawn_delay_ms":500,"time_warning_s":10},
   "moles":{"rise_ms":..,"sink_ms":..,"hit_anim_ms":..,"escape_anim_ms":..},
   "highscores":{"size":10},"audio":{"volume":0.8},
   "room":{"width":2600,"height":1820,"safe_inset":40,"fps":60,
           "ceiling":{"x":..,"y":..,"w":..,"h":..},"left":{..},"front":{..},"right":{..}}}`.
  `room` is the whole `room` config block (`GameEngine.public_config` copies it).
  `grid.top_margin` is the floor HUD band height. During play, the warning period is
  `time_left_ms <= time_warning_s * 1000` (a page that connects late knows it without waiting for an
  event). `highscores.size` is the length of the `highscores` table ("TODAY'S TOP N").
  A `state` message follows immediately.
* `state`, broadcast at 30 Hz:
```json
{"type":"state","now":123456.7,
 "phase":"attract|countdown|play|results","phase_start":..,"phase_end":..|null,
 "countdown":3|2|1|"GO"|null,
 "time_left_ms":int|null,
 "score":0,"combo":0,"best_combo":0,"hits":0,"misses":0,"escaped":0,
 "level":0.0,
 "moles":[{"id":7,"hole":4,"state":"rising|up|sinking|hit|escaped","t0":..,"t1":..,"rise_ms":..,"up_ms":..}],
 "touches":[{"id":3,"x":281.0,"y":240.5}],
 "start_progress":0.0,
 "start_blocked":false,
 "result":null | {"score":..,"best_combo":..,"hits":..,"misses":..,"rank":int|null,"new_high":bool},
 "highscores":[{"score":..,"best_combo":..,"time":"HH:MM"}],
 "round_ms":60000,
 "screens":{"floor":1,"room":1}}
```
  `screens` is added by the server, not the engine: the number of connected pages per declared role
  (only roles that have at least one page; pages that never sent a `client` message, or sent one without a
  role, are not counted). A page that sends a new role is counted under the new one.
  The floor uses `screens.room` for `hud.show_on_floor: "auto"`.
  `t0` and `t1` are the start and end of the mole's *current* state (server ms). For "sinking", `t1` is
  when the hittable window closes (sink start + `hit_grace_ms`); that may be earlier or later than
  `t0 + sink_ms`, so animate the sink with `sink_ms` (and keep that animation going through "escaped").
  `touches` are the tracker's contacts, one per foot. `start_blocked` is true in attract while someone
  stands on the START pad but cannot start (they were there before attract began; see "Phases"): show
  "step off and back on". `result` is set during results (and kept until the next round starts).
  `time_left_ms` is set during play only. `new_high` is true when rank == 1.
* `event` messages are sent immediately, in engine order:
  `{"type":"event","now":..,"name":NAME, ...fields}`

| name | extra fields | when |
|---|---|---|
| `start_pad` | `progress` 0..1 | when an armed touch first enters the pad (for a "charging" sound) |
| `countdown` | `value` 3, 2, 1 or "GO" | each countdown step, and "GO" when play starts |
| `round_start` | | play starts (same moment as countdown GO) |
| `mole_up` | `mole_id`,`hole` | spawn |
| `hit` | `mole_id`,`hole`,`x`,`y`,`score`,`combo` | hit (x, y = stomp position) |
| `combo` | `combo` | combo milestone |
| `escaped` | `mole_id`,`hole` | mole escaped (its hittable window closed) |
| `empty_stomp` | `hole`,`x`,`y` | stomp on an empty hole (a miss; see "Resolving a stomp") |
| `time_warning` | `seconds_left` | last N seconds, once per second |
| `round_end` | `score`,`best_combo`,`hits`,`misses`,`rank`,`new_high` | timer reached 0 |
| `attract` | | back to attract |

**client -> server:** `{"type":"client","role":"floor"|"room"|"scoreboard"|...,"audio":"running"|"suspended"|"none"}`
is sent on connect and whenever the audio state changes. The server logs it (operator diagnostics) and counts
the declared roles for `screens`. `{"type":"beat"}` is a heartbeat: feed.js sends one at most once a second, from
its message handler (so a hung page stops beating, and a background tab, whose timers are throttled, does not).
A page that has beaten and then stays silent (no frame at all) for 3 s is left out of `screens` (a hung wall page
or a frozen wall PC keeps its connection open, and the floor takes its HUD back), and after 10 s it is dropped
("Screen dropped because nothing was heard from it for 10 s"). Clients that never beat are never timed out.
Unknown messages are ignored.

## Floor renderer (web/floor.html)

* The canvas is exactly 560 x 448 **device** pixels at the page's top-left (CSS size = 560/devicePixelRatio).
  Black page, no scrollbars, hidden cursor, no text selection, `<title>Stomp the Mole</title>` (window.py
  finds the window by this title; Edge InPrivate shows it as "Stomp the Mole - [InPrivate]"). Works in
  `borderless` (window = canvas) and `kiosk` (fullscreen, canvas top-left) modes.
* **Cartoon style**, all drawn with canvas code: a grass field with mowing stripes, tufts and small flowers;
  dirt holes with mounded rims; brown moles with a pink nose, big eyes, two teeth and whiskers, wearing a
  yellow hard hat. The mole rises out of the hole (clipped by the hole, with the front rim drawn over it),
  bobs and blinks while up, then sinks.
* Feel and feedback:
  * **hit**: squash (wide and flat), dizzy stars, X eyes, a star burst, a dirt splash, a "+1" pop,
    a small screen shake, and the sounds `bonk` + `splat`. The "+1" rises above the mole; for a hole so
    near the top that it would reach the HUD band, it pops beside the mole (to its right) instead.
  * **escaped**: the mole blows a raspberry (tongue out) as it sinks, a red puff, and the sound `boing`.
  * **empty_stomp**: a dust puff, a grey ring, and the sound `thud` (with mid-range body, so it is
    still heard on small PC speakers).
  * **combo** milestone: a big "COMBO x10!" banner and a short fanfare. The banner is drawn *under* the
    moles, so it never hides a mole that rises while it shows.
  * **countdown**: a huge zoom-pop number with `tick` (3, 2, 1), then "GO!" with the `go` sound.
  * **time_warning**: a timer pulse and `tick`. **round_end**: a "TIME'S UP!" banner and the `buzzer` sound.
  * **Feet**: a soft shadow under each touch (one per foot), so players see the floor sensing them.
    When all shadow slots are busy, a new touch takes the most faded one.
* Phases:
  * attract: title "STOMP THE MOLE", moles peeking at random (client-side cosmetic, not game state), and
    the START pad "STAND HERE" with a progress ring from `start_progress` ("STEP OFF AND BACK ON" while
    `start_blocked`). Every few seconds it switches between the title and today's top N.
  * results: "TIME'S UP!", then the score, best combo, rank / "NEW HIGH SCORE!", and today's top N
    (N = `highscores.size` from hello).
* Walls present (`hud.show_on_floor` false, or "auto" with `screens.room` >= 1): no HUD band; attract shows
  the title and START pad but not the top-N page; results show "TIME'S UP!" and the big score but not the
  table (the result column moves to the centre and grows a little). The countdown numbers stay on the floor: the player is looking down at the pad then. Hit, miss, combo
  and START-pad feedback are unchanged. Switching happens live, with a short fade, when a room page
  connects or disconnects.
* Floor HUD (when shown): a band at the top (`grid.top_margin` px) with SCORE, TIME (big) and
  COMBO. The TIME turns red in the warning period. With `hud.rotation` 180 the overlays (title, START pad
  label, countdown, combo banner, results) turn about the floor centre; the HUD band stays at the top
  edge, where `top_margin` is reserved, with its text turned in place; "+1" pops turn about their own
  anchor.
* Text must be readable on a low-resolution LED floor: large, bold, high contrast, dark outlines. No web fonts
  (offline): use the stack `"Arial Black", "Segoe UI Black", Impact, sans-serif`.
* Audio (audio.js): Web Audio synthesis only. `pop` (mole up, quiet), `bonk`, `splat`, `boing`, `thud`,
  `tick`, `go`, `buzzer`, `fanfare`, `charge`. Master volume comes from config. The page reports its audio
  state to the server. The browser is launched with `--autoplay-policy=no-user-gesture-required`, so audio
  runs without a click.
* Reconnects every second when the server is gone. Until the first message arrives, it shows a small
  "connecting..." on the floor.

## Walls and ceiling (web/room.html, room.js, sky.js)

The wall PC shows room.html fullscreen (Edge kiosk). It draws one 2600 x 1820 picture, the signage division,
at the page's top-left in **device** pixels (CSS size = size / devicePixelRatio; the wall PC is at 100%).
The LED controllers cut that picture into the ceiling and the three walls. Everything comes from the feed:
geometry from `hello.config.room`, game data from `state` and `event`. No sound (the floor PC plays it).
Role "room", audio "none" (`?test=1` reports "room-test" and `?preview=1` "room-preview": neither shows the
game on the LEDs, so the floor does not count them as the walls and keeps its HUD).
`<title>Stomp the Mole - Room</title>`. Black outside the regions. Scripts load in the order feed.js, sky.js,
room.js; without sky.js (or if it keeps failing) the ceiling is a plain day-sky gradient. room.html notes a script
that fails to load (a capturing `error` listener before the scripts) and, after them, a watchdog: if one failed
or room.js did not start (`window.StompRoom` missing), it fetches room.js every 2 s and reloads the page once that
answers (nothing else would ever load the script again, and the walls would stay black, or the ceiling plain, all
day). After 5 such reloads in a row it tries once a minute (sessionStorage counts them).

**Look: continue the floor's cartoon meadow.**
* Walls (left + front + right): **one continuous panorama** drawn across x 0..2599, so the hills, fence,
  trees, flowers and clouds flow from wall to wall like the sample content does. Rolling green hills with a
  wooden fence near the bottom (the bottom meets the floor's grass), a few trees, bushes, flowers and
  little mole mounds (the attract peeking moles pop out of mounds in front of the fence), and a light-blue sky
  with clouds in the upper part of each wall. The land is pre-rendered once to an offscreen canvas on a
  transparent sky; a few gentle animations on top (swaying flowers, drifting clouds, a mole popping out of a
  mound now and then in attract). The panorama is continuous, but each wall's **content panel** (a big wooden
  signboard) sits entirely inside its own region, at least `safe_inset` from every edge.
* The walls' sky **follows the ceiling**: it is its own gradient, drawn under the land, whose top colour is
  `Sky.horizon()` (the ceiling's bottom-edge colour right now) and which turns lighter towards the hills. So
  the front wall's top edge meets the ceiling in the same colour through day, warming and sunset, and the trees
  stay green. It is re-rendered only when that colour changes. The clouds drift behind the trees and take on
  the warm colour in a warm sky. They drift a little faster as `level` rises: each frame moves them by
  dt x speed, with the speed easing towards the level (never uptime x speed, which would make them race on a
  page open all day and jump at every round end). Tree crowns stay at least 20 px under the walls' top edge.
* Ceiling: an **animated cartoon sky**: a deep-to-light blue gradient, a smiling cartoon sun with slowly
  turning rays, drifting clouds in two or three parallax layers, birds flapping across, and occasionally a
  hot-air balloon or a plane trailing a "STOMP THE MOLE" banner in attract. Clouds drift faster as `level` rises.
  Celebrations: **combo** milestone = fireworks bursts; **new high score** = a rainbow arc + fireworks +
  confetti; **time_warning** = the sky slowly warms toward sunset; **round_end** = a golden sunset glow with
  sparkles; back to a fresh day sky in attract. The ceiling is seen from below by people on the floor, so
  it holds no text except the optional plane banner. Its bottom edge (y = ceiling.y + h) meets the top of
  the front wall.
* Text: the same chunky outlined cartoon lettering as the floor ("Arial Black", "Segoe UI Black", Impact),
  big enough to read from across the room (score and timer digits at least 300 px tall on the front wall, as
  long as `safe_inset` leaves their panels room for that: see "Config").

**What each wall shows**

| Phase | Left wall | Front wall | Right wall |
|---|---|---|---|
| attract | "TODAY'S TOP N" signboard (empty: "BE THE FIRST!") | "STOMP THE MOLE" logo sign + "HOW TO PLAY": 1 stand on the START pad, 2 stomp the moles when they pop up, 3 beat today's top score | A cartoon mole mascot waving and pointing down: "STAND ON THE START PAD!". It becomes "GET READY..." with a fill ring from `start_progress`, and "STEP OFF AND BACK ON" while `start_blocked` |
| countdown | top N | a huge 3 / 2 / 1 filling the sign, zoom-pop like the floor; "GO!" at round start | "GET READY!" |
| play | top N with a live "YOU" row showing where the current score would rank (it moves up as the score grows) | TIME (huge; red and pulsing in the warning period), SCORE (pops on each `hit`), COMBO (pops on each hit, shakes back to x0 on a miss) | stats sign: HITS, MISSES, BEST COMBO, and a SPEED meter from `level`; celebration banners on `combo` milestones ("COMBO x10!", a ribbon over the SPEED meter, so the stat rows stay readable) |
| results | top N with the player's row highlighted and blinking (rank from `result.rank`) | "TIME'S UP!" (on `round_end`), then FINAL SCORE + "#k TODAY" / "NEW HIGH SCORE!" (else "NICE ONE!", or "TRY AGAIN!" for 0, as on the floor) | NEW HIGH SCORE: trophy + confetti; otherwise "GREAT JOB!" / "NICE ONE!" / "TRY AGAIN!" + the round's stats |

* Details: the front wall's COMBO sits in a strip between the TIME and SCORE panels (about 80 px), so both
  digit panels keep 300+ px digits. The live "YOU" row has its score in the SCORE column and "YOU" on the
  right; it slides up as the score grows, and the entry it pushes below the top N is dimmed. Results on the right
  wall without a new high score: "GREAT JOB!" when the score made the table, else the floor's and the front
  wall's words: "NICE ONE!", or "TRY AGAIN!" for a score of 0.
* Disconnected or not yet connected: the panorama and sky keep animating, and the front sign says "WAITING FOR
  THE GAME..." with the feed address (it reconnects every second via feed.js). The left wall keeps the last
  table it saw ("WAITING..." before any), and the right wall shows the mascot with "BE RIGHT BACK!". The walls
  are never blank.
* `?test=1`: **test pattern** for confirming the regions on the real LEDs. Each region is filled with its own
  colour and labelled with its name, x/y/w/h, a 100 px grid with coordinates every 200 px, a bright 4 px
  border, and corner markers. An arrow on the ceiling's bottom edge says "front wall below", and wall labels
  say which neighbour is on each side. Areas of the division outside every region are drawn in a hatched grey,
  so stray pixels show. It works without game data (it only needs hello; if it gets no hello within 3 s, it
  uses the defaults above and says so). It also draws each region's `safe_inset` frame, a line at y = 1800 (the
  bottom of the 2600 x 1800 sample content), and an info box: where the regions came from, the division and
  screen size, devicePixelRatio, and the feed address and status.
* `?preview=1`: scales the whole 2600 x 1820 picture to fit the browser window, for checking on a normal
  monitor or over AnyDesk.
* `?fps=N` overrides `room.fps`.
* `window.StompRoom` (read-only diagnostics): the regions in use and where they came from, the signboards,
  safe boxes and digit sizes, `fps` and `fpsNow`.
* Performance (the wall PC's GPU is unknown): the static panorama (the land) and the ceiling's sky gradients are
  drawn into offscreen canvases once (and again only on a resize/config change); the walls' sky gradient again
  only when the ceiling's colour changes. Each frame blits them and draws only the animated parts.
  Signboards are cached and redrawn only when their content changes or while they animate.
  **Render ahead:** the first time a freshly rendered sign is drawn, the browser rasterises it there and then
  (and measures new font sizes), which stalled a slow PC at TIME'S UP, FINAL SCORE and the return to attract,
  several signs at once. So in the quiet frames before each switch (countdown -> GO -> play, the end of play ->
  TIME'S UP, TIME'S UP -> FINAL SCORE and the right wall's results, late results -> attract) the page renders
  what a sign will show next into a spare canvas and rasterises it there (drawing it once into a 1 px canvas),
  one sign or sprite at a time, at least 120 ms apart, away from the first moments of each animation; at the
  switch the canvases swap. The left wall's content (heads and bands) is the same in play, results and attract,
  so it is not redrawn there at all. Measured (real server, bot playing, headless Chrome with the GPU, CPU
  throttled x4): the slowest frames around the end of a round went from 71 / 107 / 91 ms (TIME'S UP / FINAL
  SCORE / attract) to under 30 ms at the switches, with the rendering ahead in single frames of 35-52 ms; x8:
  under 25 ms at the switches, 70-107 ms ahead; x1: 5 ms at the switches, at most 17.5 ms ahead.
  There are no per-frame allocations in hot paths, particles are capped, and frames are capped at `room.fps`.
  Target: a steady 60 fps at 2600 x 1820 on integrated graphics; 30 fps is acceptable.
  **Slow PC fallback:** if more than 15% of the frames in a 3 s window come late (over 1.5 frame intervals,
  whether the CPU or the GPU is the bottleneck), the page draws at 30 fps from then on (until it is reloaded)
  and logs it to the console; steady 30 looks better than juddering between 60 and 30. Not with `?fps=N`, and
  not when `room.fps` is already 30 or less.
  Measured on the dev PC (RTX A5000, headless Chrome, real server, a bot playing): 60 fps in every phase; room.js
  plus sky.js JS per frame (mean / p95) 0.8 / 1.4 ms in attract, 1.2 / 2.3 ms in play, 2.3 / 3.0 ms in results;
  the floor page 0.2-0.4 ms. With the GPU switched off (software drawing, a pessimistic stand-in) a room frame
  costs about 11 ms in attract and 15-25 ms in play and results, and the page drops itself to 30 fps.

`sky.js` exposes one global, `Sky`, so room.js can stay independent of it:
```js
Sky.init(ctx, rect)              // rect = {x, y, w, h} of the ceiling in canvas pixels; (re)build caches
Sky.frame(nowMs, dtMs, level)    // draw the sky into rect for this frame (level 0..1 from state)
Sky.setMood(mood)                // "day" | "warming" | "sunset"  (attract/play = day, warning = warming, results = sunset)
Sky.celebrate(kind)              // "combo" | "highscore" | "go" | "timesup"
Sky.drawTest(ctx, rect)          // not used; the test pattern is room.js's job
Sky.horizon()                    // [r, g, b] of the sky's bottom edge as of the last frame (a reused array);
                                 // room.js colours the walls' sky with it (optional: without it, a day sky)
```
room.js calls `Sky.frame` with the page's own clock (performance.now()) and `level` only during play (0
otherwise); `setMood` may be called every frame (repeats do nothing), `celebrate` once per event: "go" on
countdown GO, "combo" on each `combo` event, "timesup" on `round_end`, "highscore" when the front wall shows
"NEW HIGH SCORE!" (1.7 s into results). The API has no phase, so sky.js counts a moment as play when `level` > 0
or within 3 s of `celebrate("go")`: the attract-only plane or balloon can still be crossing during the 3 s
countdown and leaves with a quick fade at GO. The high-score rainbow lasts about 6 s and its confetti about 7 s.
The sky's randomness is seeded (the same birds, clouds and bursts on every load). sky.js catches and reports
its own errors; room.js also guards every call and shows the plain sky after 120 failures in a row.
Bottom-edge colours: day `#c8efff`, end of warming `#ffd88e`, sunset `#ffd35f`.

## Wall PC (wall_pc/)

Copy `wall_pc\` to the wall PC (Desktop, say). No Python and nothing to install there.
* `Start Walls.bat`: `set FLOOR_PC=192.168.123.228` at the top (edit to the floor PC's static IP) and
  `set GAME_PORT=8080` (the floor's `http.port`; FLOOR_PC may also be given as ADDRESS:PORT, which then wins),
  then starts
  Edge: `msedge.exe --kiosk "http://%FLOOR_PC%:%GAME_PORT%/room.html" --edge-kiosk-type=fullscreen --inprivate
  --disable-sync --no-first-run --no-default-browser-check --user-data-dir="%LOCALAPPDATA%\StompTheMoleWalls"
  --window-position=0,0 --force-device-scale-factor=1 --disable-background-timer-throttling
  --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --hide-crash-restore-bubble
  --noerrdialogs` (finding msedge.exe in Program Files (x86) or Program Files). `--window-position=0,0` puts
  the kiosk on the monitor whose top-left is the desktop origin, where the signage division is.
* Before starting Edge, `Start Walls.bat` waits until the game answers (`curl.exe -s -f -o nul -m 3 URL` every
  2 s, with one "Waiting for the game on the floor PC" message): Edge opened on an unreachable address shows an
  error page and never tries again, while a loaded wall page reconnects by itself. Without curl.exe (Windows
  older than 10 1803) it starts Edge at once.
* `Wall Test Pattern.bat`: the same, with `room.html?test=1`. It calls `Start Walls.bat test`, so the operator sets
  `FLOOR_PC` and `GAME_PORT` in one file only. `Start Walls.bat` drops spaces from both (a trailing space after an
  edit); an empty `GAME_PORT` means 8080. Both .bat files have Windows (CRLF) line ends.
* Stop with Alt+F4. The signage player's campaign is paused while the walls run (the owner's decision; covering it
  is not enough: the floor counts a connected wall page, not what the LEDs show, so a campaign on top would leave
  the players with no score or timer anywhere); restarting it is the operator's call. README.txt has the
  operator check that the walls really show the game, and `hud.show_on_floor` true as the fallback when they
  cannot be relied on.
* `README.txt`: plain steps: set FLOOR_PC (and GAME_PORT if the floor's port is not 8080), make sure the game is
  running on the floor PC, pause the campaign, double-click, check the walls, Alt+F4 to stop, and what "WAITING FOR
  THE GAME..." means (network, firewall, with the steps to remove python.exe Block rules, or the game is not running).
* The floor PC's console prints the address to use on the wall PC at start-up: "Wall PC: open
  http://<this PC's LAN IPv4>:8080/room.html". It lists every non-loopback IPv4, found with the stdlib
  (`socket.getaddrinfo(socket.gethostname(), None)` plus a UDP-connect trick that sends nothing), the
  default-route one first; link-local 169.254.x addresses (an adapter that found no DHCP server) are left out.
  With `http.host` "0.0.0.0" it also says that Windows Firewall must let python.exe accept connections, that
  Windows asks only the first time python.exe uses the network and never again, and to see "Firewall" in
  README.md if the walls keep waiting; with a loopback `http.host` it says instead that the walls cannot connect
  and to set "0.0.0.0". If `http.port` is taken, the error says to set another one in config.json and the same
  as GAME_PORT in Start Walls.bat.

## scoreboard.html (test view of the data feed)

A responsive page, any size, that shows phase, countdown, time left, score, combo, best combo, the last
event name, and today's table (top N from hello), in big text, plus the connected screens (`screens`) in its
status line, a quick network check from the wall PC. It is a stand-in for the future wall
screens. It proves the feed carries everything they need. It has no sound.

## Server (netserver.py, run.py, window.py)

* One asyncio event loop: a TUIO UDP endpoint, an HTTP+WebSocket server, and a game loop at 60 Hz
  (tracker.tick -> engine.update -> broadcast events immediately; state at 30 Hz). Each TUIO packet is
  checked as a whole (`osc_framing_ok`), decoded into `TuioState`, and then the live `/tuio/2Dcur` cursors
  go to `tracker.on_frame`; the resulting contacts reach the engine and the feed at once.
* The UDP socket binds **exclusively** (`SO_EXCLUSIVEADDRUSE` on Windows; never `SO_REUSEADDR`). If port
  3333 is taken (the floor map or receiver is still running), it exits with a clear message saying so.
* WebSocket: RFC 6455 handshake (Sec-WebSocket-Accept), reads masked client frames (text, ping -> pong,
  close), sends unmasked text frames with correct 7/16/64-bit lengths. Slow or dead clients are dropped
  without blocking the game loop: a client whose 90-message send queue (3 s of feed) overflows is dropped, but
  the OS socket buffers in front of that queue hold minutes of feed, so a page that stops reading while its
  connection stays open is found by its missing heartbeats instead (`beat`, see "Data feed": out of `screens`
  after 3 s, dropped after 10 s). A clean close, a crash or a closed browser is seen at once.
* Static files come only from `web/`, with no path traversal, correct content types, and `Cache-Control: no-store`.
* Console status lines (plain words): config loaded, TUIO listening, page URL, the wall PC's address (see
  "Wall PC"), window opened, first TUIO packet received, client connected/disconnected (with role and audio
  state; a page on another PC also with its address: "Screen connected: room at 192.168.10.78 (no sound)"),
  each round's score and rank. Log
  calls only queue the line; a thread of its own writes it to the console. (While text is selected in a
  Windows console, every write to it blocks; a click in the console text starts a selection. The game loop
  must never wait for that. The lines appear once the selection ends with Esc.)
* Stopping: Ctrl+C shuts everything down, including the browser window it launched (closed gracefully).
  Closing the console with its X button, ending python in Task Manager, or a crash also ends the browser:
  before launching it, the game joins a Windows job object with KILL_ON_JOB_CLOSE, which the browser
  inherits, so Windows ends it when the game's process ends. (No cleanup code runs in those cases; the
  job does not need any.)
* window.py: finds Edge (`Program Files (x86)\Microsoft\Edge\Application\msedge.exe`, then Program Files,
  then Chrome), and launches it with `--user-data-dir=%LOCALAPPDATA%\StompTheMole\browser
  --autoplay-policy=no-user-gesture-required --no-first-run --no-default-browser-check --window-position=X,Y
  --force-device-scale-factor=1` (one CSS px = one screen px at any display scaling), flags that suppress
  translate prompts, pinch zoom, overscroll navigation, background throttling and crash-restore bubbles,
  `--disable-sync`, and for Edge `--inprivate`, then `--window-size=560,448 --app=URL`. **InPrivate is
  needed:** a fresh Edge profile signs itself in with the PC's Microsoft account and shows a "syncing your
  data" popup whose backdrop dimmed the whole game to about 40% (seen on the dev PC); InPrivate never signs
  in, and the game keeps nothing in the browser. The coming wall-PC Edge kiosk shortcut needs the same
  `--inprivate --disable-sync` treatment. For `borderless`, the process is per-monitor DPI aware. Game
  windows left over from an earlier run are closed first. It waits for the window titled "Stomp the Mole"
  or "Stomp the Mole - [InPrivate]" (or starting with "Stomp the Mole" and owned by the launched
  process), strips its caption and frame (WS_POPUP), places it at (x, y) 560 x 448 physical pixels,
  topmost, and re-asserts that every few seconds. If the browser keeps drawing a frame of its own inside
  the stripped window (Edge: 7, 30, 7, 7 px on the dev PC), the window is grown and moved by those insets
  so the page area itself is exactly at (x, y): for example (-7, -30) 574 x 485. That is harmless on one
  monitor; with a monitor arranged left of or above the primary, a strip of Edge frame shows there. If the
  window is closed while the game runs, the console says so once (restart the game to reopen it); "has not
  appeared" is only reported before the window was ever found. For `kiosk` it uses `--kiosk URL` (Edge:
  `--edge-kiosk-type=fullscreen`) instead. If the browser is not found, it prints the URL to open by hand.

## fake_floor.py (dev tool)

A Tk window, 560 x 448 by default, that draws the 9 holes for orientation. Left mouse button down / drag /
up = one foot down, move, up. Right click toggles a "standing foot" that stays down. It sends TUIO 1.1
`/tuio/2Dcur` bundles (source, alive, set, fseq) at 30 Hz to 127.0.0.1:3333 (`--port`). Stdlib only.

## On-site measurement (tuio_receiver.py, tuio_replay.py)

Every step-detection setting depends on how the real floor reports feet, which has not been measured.
`python tuio_receiver.py --record floor.jsonl` appends one JSON line per UDP packet:
`{"t_ms": <time.monotonic() in ms>, "from": "<sender ip>", "msgs": [[address, arg, ...], ...]}` (blobs as hex;
`"error"` is added for a malformed packet). Its printed lines start with `HH:MM:SS t=<ms since start>`.
`python tuio_replay.py floor.jsonl [--start S --end S] [--list-downs]` feeds the recording through
`TuioState` and the game's `TouchTracker` (settings from config.json, `--merge-px` / `--debounce-ms` to
try others) and prints: frame rate and gaps; cursors per frame, the distance to the nearest other cursor
in cells, and cursors per foot (one per foot, or one per cell?); session-id relabels and jumps; feet that
vanished and came back at the same spot and for how long; and the downs (stomps) the game would see.
Script for the recording: stand still on one foot, then two; rock heel to toe; stand between two holes;
walk along a row gap; stamp fast in place; jump. Port 3333 is the game's while it runs, so either stop
the game or add a second TUIO output in Interactive Platform (Remote computer 127.0.0.1, port 3334) and
record with `--port 3334`. Latency is not in the recording: film a stamp next to the running recorder,
or compare the platform's Test view with the LEDs.
