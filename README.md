# Stomp the Mole

A whack-a-mole game for the interactive LED floor, played with the feet. Moles pop out of 9 holes;
stomp on one while it is up to score. A round lasts 60 seconds and gets faster as it goes.
Players start a round by standing on the START pad in the middle of the floor for one second.

Everything runs on the floor PC with plain Python (no installs) and Microsoft Edge. The three walls
and the ceiling are shown by a second PC, the wall PC, which reads the game from the floor PC over the
network (see "Walls and ceiling" below). `DESIGN.md` has the full rules and the technical details.

## Running it on the floor PC

1. Keep **Interactive Platform** open. It sends the floor's touches to the game (TUIO on UDP port 3333).
2. Close `tuio_floor_map.py` and `tuio_receiver.py` if either is running. Only one program can
   listen for the floor's touches at a time; the game tells you if something else has the port.
3. Double-click **`Start Stomp the Mole.bat`**.

A console window shows what is happening, and the game opens in its own window over the play pane
(screen position 0,0, 560 x 448), so it appears on the floor. Typical console lines:

```
12:00:01  Config loaded from ...\stomp_the_mole\config.json
12:00:01  Listening for floor touches (TUIO) on UDP port 3333
12:00:01  Game page: http://127.0.0.1:8080/floor.html   (feed test page: .../scoreboard.html)
12:00:01  Wall PC: open http://192.168.123.228:8080/room.html
12:00:01  Windows Firewall must let python.exe accept connections, or the wall PC cannot connect. ...
12:00:02  Game window opened: Microsoft Edge, borderless at 0,0 560x448, always on top
12:00:02  Screen connected: floor (sound on)
12:00:03  First touch data (TUIO) received from 127.0.0.1
12:00:09  Screen connected: room at 192.168.10.78 (no sound)
12:01:10  Round over: score 23, best combo 7 (23 hits, 9 misses), rank 2 of today's top 10
```

Windows Firewall must let python.exe accept connections, or the wall PC cannot connect (the floor game
works either way). Windows asks about that only once, the first time python.exe uses the network, and
never again; see "Firewall" below if the walls keep saying WAITING FOR THE GAME.

**To stop:** click the console window's **title bar** (not the text inside it) and press **Ctrl+C**.
That also closes the game window. If the console then asks `Terminate batch job (Y/N)?`, press **N**,
read the last lines, then press any key to close the window. Closing the console with its X button
also closes the game window.

Do not click inside the console text: that selects text, and the console stops printing until the
selection ends (the game itself keeps running). If the console's title starts with **Select**, press **Esc**.

## Trying it on a development PC (no floor)

```
python -m stomp_the_mole          # from this folder; opens the game window at 0,0
python fake_floor.py              # a stand-in floor: the mouse is a foot
```

In the fake floor window, press and drag the left mouse button to step and slide; right-click to put
down a foot that stays standing (right-click it again to lift it, C lifts all). `--scale 1.5` makes
the window bigger. Use `python -m stomp_the_mole --no-window` to open the page yourself in any
browser, and `http://127.0.0.1:8080/scoreboard.html` to watch the data feed.
`http://127.0.0.1:8080/room.html?preview=1` shows the walls and the ceiling scaled to fit the browser
window. A preview does not count as the walls, so the floor keeps its score band; `room.html` without
`?preview=1` (in a big enough window) does count, and the floor hands its score band to it.

Tests: `python -m pytest tests -q` (needs pytest, dev machine only).

## Settings

All settings are in `stomp_the_mole/config.json` (restart the game after editing). The most useful:

| Setting | What it does |
|---|---|
| `moles.hit_grace_ms` | Extra time (ms) a mole still counts as hit after it starts sinking (the sink itself takes 200). Raise it if stomps that look on time are missed (the floor reports steps a little late). Default 350. |
| `round.play_ms` | Round length in ms. Default 60000 (60 s). |
| `hud.show_on_floor` | `"auto"` (default): the floor shows its score band and today's top 10 only while the walls are not connected; when they connect, those move to the walls. `true`: always on the floor too. `false`: never on the floor. |
| `hud.rotation` | 0 or 180. Turns all text and the score band to face the other side of the room. |
| `window.mode` | `borderless` (default), `kiosk` (fullscreen browser, the game draws at the top-left), or `none` (no window). `window.x` / `window.y` move it if the play pane is not at 0,0. |
| `tuio.flip_x`, `tuio.flip_y` | Mirror the touches left/right or top/bottom if feet land on the wrong side. Off by default (checked correct on site). |
| `http.host` | `0.0.0.0` (default) lets the wall PC read the game over the network. `127.0.0.1` keeps it on the floor PC only (the walls then cannot connect). |
| `room` | Where the ceiling and the three walls are in the wall PC's picture (2600 x 1820 by default). Only change these if the test pattern shows the edges in the wrong place. |

If the game window shows a title bar or sits in the wrong place, try `"mode": "kiosk"`.

Today's top 10 scores (scores only, no names) are kept in `stomp_the_mole/data/highscores.json` and
start fresh each day. To clear today's table, stop the game (Ctrl+C in its console window), delete
`stomp_the_mole/data/highscores.json`, then start the game again. Deleting the file while the game is
running does not clear it: the running game keeps the table in memory and writes it back after the next
score. (A file the game cannot read is kept as `highscores.json.bad` and the table starts empty.)

## Walls and ceiling

The wall PC shows the walls and the ceiling as one fullscreen picture; the screens' controllers cut it
into the ceiling and the three walls. The front wall is the scoreboard (countdown, time, score, combo),
the left wall shows today's top 10, the right wall the round's stats and celebrations, and the ceiling an
animated sky. While the walls are connected, the floor drops its score band and its top 10 (the
countdown stays on the floor); if the walls go away, the floor shows them again by itself.

Copy the **`wall_pc`** folder to the wall PC (the Desktop is fine). It needs no Python and nothing
installed, only Microsoft Edge. `wall_pc\README.txt` has the same steps in plain words for the operator.

1. **Once:** the floor PC's console prints `Wall PC: open http://<address>:8080/room.html` at start-up.
   On the wall PC, right-click `Start Walls.bat`, choose Edit, and put that address on the line
   `set FLOOR_PC=...` (and the port on `set GAME_PORT=...` if it is not 8080, i.e. if `http.port` was
   changed). `Wall Test Pattern.bat` uses the same address and port.
2. Start the game on the floor PC first, then pause the signage player's campaign and double-click
   **`Start Walls.bat`** on the wall PC. If the game is not running yet, it waits for it ("Waiting for the
   game on the floor PC") and opens the walls when the game answers. Check that the walls really show the
   game: while the wall page runs, the floor leaves its score band to it even if the campaign covers it.
   **Alt+F4** stops it.
3. **`Wall Test Pattern.bat`** shows each surface in its own colour with its name, size, grid and border,
   to confirm on the real screens that the edges are where `room` in config.json says.

If the walls say **WAITING FOR THE GAME...**, the wall page cannot reach the game (it retries every
second): check that the game is running, that `FLOOR_PC` (and `GAME_PORT`) match the console's
`Wall PC: open ...` line, that the floor PC's console does not say "The walls cannot connect" (that means
`http.host` is `127.0.0.1`), and the firewall (below). Opening `http://<floor PC address>:8080/scoreboard.html`
in a normal browser on the wall PC is a quick check: if it shows the game, the network and the firewall are
fine. Its status line also lists the connected screens (for example `screens: floor 1, room 1`).

If the walls cannot be relied on for a while (the signage campaign has to stay on top, or the wall screens
are off while the wall PC runs), set `hud.show_on_floor` to `true` on the floor PC: the floor then always
shows its own score band and top 10. Set it back to `"auto"` afterwards.

Both PCs should have fixed (static or reserved) IP addresses, so the address in `Start Walls.bat` stays right.

### Firewall

Windows Firewall on the floor PC must let python.exe accept connections. Windows asks about that only
**once**, the first time python.exe uses the network, and **never again**. That may have happened long
before the walls (for example when `tuio_floor_map.py` ran). If the answer then was Cancel, or only
"Private" was ticked while the network is marked Public, Windows made rules that **block** python.exe,
and a block rule wins over any allow rule: adding an allow rule alone does not help. A new network (a
cable instead of Wi-Fi, say) can come up with another profile, and Windows does not ask again either.

On the floor PC, signed in as an administrator:

1. See how the network is marked: Settings > Network & Internet > Wi-Fi (or Ethernet), click the network's
   name, and look at "Network profile" (Public or Private).
2. Press Windows+R, type `wf.msc`, press Enter, and click **Inbound Rules**. Sort by **Name**. Delete every
   rule named `python` or `python.exe` whose **Action** is **Block** (right-click, Delete; there may be several).
3. Start menu > "Allow an app through Windows Firewall" > Change settings: tick **Private** and **Public**
   for every `python` entry, then OK.
4. Restart the game, and check from the wall PC with the scoreboard page above.

The same with commands, in a Command Prompt run as administrator: `python -c "import sys; print(sys.executable)"`
prints python.exe's full path; then
`netsh advfirewall firewall delete rule name=all dir=in program="<that path>"` removes every inbound rule
for it (allow and block), and
`netsh advfirewall firewall add rule name="Stomp the Mole walls" dir=in action=allow protocol=TCP localport=8080 profile=any`
allows the game's port (use the `http.port` from config.json if it was changed). With python.exe's rules
gone, Windows asks again the next time the game starts: tick **both** Private and Public and click Allow
(Cancel would make new block rules).

## Recording what the floor sends (for tuning)

```
python tuio_receiver.py --record floor.jsonl     # with the game stopped; Ctrl+C ends the recording
python tuio_replay.py floor.jsonl                # frame rate, cursors per foot, dropouts, stomps seen
python tuio_replay.py floor.jsonl --start 20 --end 45 --list-downs
```

`DESIGN.md` ("On-site measurement") has the script to follow while recording and what each number tunes.

## Data feed for the wall and ceiling screens

The game publishes score, timer, combo, countdown and every game event on a WebSocket at
`ws://<floor PC>:8080/ws` (JSON); the floor page, the wall page and the scoreboard all read it. New
screens only need to read that feed. The message format is in `DESIGN.md` under "Data feed".
