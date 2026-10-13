"""Live map of an interactive LED floor, fed by its TUIO output.

Draws the floor as cabinets of sensor cells (default 5 x 4 cabinets of 8 x 8
cells, numbered like Interactive Platform's Test view) and lights each cell a
TUIO touch lands on. Cells that have fired at least once stay tinted, so
walking the whole floor shows dead sensors as the cells left dark, and
anything lighting up with nobody on the floor is a ghost trigger.

    python scripts/tuio_floor_map.py
    python scripts/tuio_floor_map.py --cab-cols 5 --cab-rows 4 --cells 8 --port 3333

The map is a borderless 560 x 448 window pinned at screen (0, 0), where the
platform's play pane sits, so it is exactly what the floor shows; --x/--y move it
if the play pane is elsewhere. Status text is in a small window below it.

Keys: R resets the coverage, Esc quits (or close the status window).
"""

import argparse
import ctypes
import queue
import socket
import struct
import threading
import tkinter as tk

from tuio_receiver import TuioState, iter_messages, pressure_of

CELL_PX = 14  # 5 x 8 cells x 14 px = 560 x 448, the floor's own resolution
IDLE, COVERED, ACTIVE = "#141414", "#1f4d2b", "#39ff6a"


def cabinet_label(col, row, cab_rows):
    """Platform numbering: snakes up the first column, down the next, from bottom-left."""
    from_bottom = cab_rows - 1 - row
    index = col * cab_rows + (from_bottom if col % 2 == 0 else row)
    return f"1-1-{index + 1}"


def listen(host, port, events):
    state = TuioState(lambda *event: events.put(event))
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    while True:
        data, _ = sock.recvfrom(65535)
        try:
            for address, args in iter_messages(data):
                state.handle(address, args)
        except (ValueError, struct.error):
            pass


def main():
    parser = argparse.ArgumentParser(description="Live TUIO map of an LED floor.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=3333)
    parser.add_argument("--cab-cols", type=int, default=5, help="cabinets across (default 5)")
    parser.add_argument("--cab-rows", type=int, default=4, help="cabinets down (default 4)")
    parser.add_argument("--cells", type=int, default=8, help="sensor cells per cabinet side (default 8)")
    parser.add_argument("--flip-x", action="store_true", help="mirror left/right")
    parser.add_argument("--flip-y", action="store_true", help="mirror top/bottom")
    parser.add_argument("--x", type=int, default=0, help="screen x of the map (play pane X, default 0)")
    parser.add_argument("--y", type=int, default=0, help="screen y of the map (play pane Y, default 0)")
    opts = parser.parse_args()

    cols, rows = opts.cab_cols * opts.cells, opts.cab_rows * opts.cells
    width, height = cols * CELL_PX, rows * CELL_PX

    try:  # draw in real screen pixels, so 560 x 448 is not stretched by display scaling
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except (AttributeError, OSError):
        pass
    # The map sits borderless at exactly the play pane's spot on the desktop, the
    # region the LED controller shows on the floor, so it cannot be resized or maximised.
    root = tk.Tk()
    root.title(f"TUIO floor map - udp {opts.port}")
    root.overrideredirect(True)
    root.geometry(f"{width}x{height}+{opts.x}+{opts.y}")
    root.attributes("-topmost", True)
    canvas = tk.Canvas(root, width=width, height=height, bg="black", highlightthickness=0)
    canvas.pack()

    # Status lives in its own small window just below the map, off the floor area.
    panel = tk.Toplevel(root)
    panel.title("TUIO floor map")
    panel.configure(bg="black")
    panel.resizable(False, False)
    panel.geometry(f"+{opts.x}+{opts.y + height + 40}")
    panel.protocol("WM_DELETE_WINDOW", root.destroy)
    status = tk.Label(panel, font=("Consolas", 9), fg="#dddddd", bg="black", anchor="w",
                      justify="left", width=62)
    status.pack(fill="x", padx=4, pady=4)

    rects = {}
    for c in range(cols):
        for r in range(rows):
            x0, y0 = c * CELL_PX, r * CELL_PX
            rects[c, r] = canvas.create_rectangle(x0, y0, x0 + CELL_PX, y0 + CELL_PX,
                                                  fill=IDLE, outline="#333333")
    cab_px = opts.cells * CELL_PX
    for cc in range(opts.cab_cols):
        for cr in range(opts.cab_rows):
            x0, y0 = cc * cab_px, cr * cab_px
            canvas.create_rectangle(x0, y0, x0 + cab_px, y0 + cab_px, outline="#1f8a1f", width=2)
            canvas.create_text(x0 + cab_px / 2, y0 + cab_px / 2, fill="#9a9a9a",
                               font=("Segoe UI", 11), text=cabinet_label(cc, cr, opts.cab_rows))

    covered = set()
    touches = {}  # (address, session id) -> set of cells
    last = {"text": "waiting for TUIO data..."}

    def cells_for(fields):
        x, y = fields.get("x", 0.0), fields.get("y", 0.0)
        if opts.flip_x:
            x = 1 - x
        if opts.flip_y:
            y = 1 - y
        # blobs carry a size; light every cell they cover
        half_w, half_h = fields.get("w", 0.0) / 2, fields.get("h", 0.0) / 2
        c0, c1 = int((x - half_w) * cols), int((x + half_w) * cols)
        r0, r1 = int((y - half_h) * rows), int((y + half_h) * rows)
        return {(c, r) for c in range(c0, c1 + 1) for r in range(r0, r1 + 1)
                if 0 <= c < cols and 0 <= r < rows}, x, y

    def redraw():
        active = set().union(*touches.values()) if touches else set()
        for cell, rect in rects.items():
            canvas.itemconfig(rect, fill=ACTIVE if cell in active else
                              COVERED if cell in covered else IDLE)
        status.config(text=f"Touches: {len(touches):<3} Fired: {len(covered)}/{cols * rows}"
                           f"   R reset, Esc quit\n{last['text']}")

    def poll():
        changed = False
        while True:
            try:
                event, address, sid, touch = events.get_nowait()
            except queue.Empty:
                break
            changed = True
            key = (address, sid)
            if event == "remove":
                touches.pop(key, None)
                continue
            cells, x, y = cells_for(touch.fields)
            touches[key] = cells
            covered.update(cells)
            text = f"x={x:.3f} y={y:.3f}"
            if cells:
                c, r = min(cells)
                cab = cabinet_label(c // opts.cells, r // opts.cells, opts.cab_rows)
                text += f"  col {c} row {r}  {cab}"
            else:
                text += "  (outside the floor)"
            p_name, p_value = pressure_of(touch.fields)
            if p_name is not None:
                text += f"  {p_name}={p_value:.3f}"
            last["text"] = text
        if changed:
            redraw()
        root.after(30, poll)

    def reset(_event=None):
        covered.clear()
        redraw()

    # bind_all so the keys work whichever of the two windows has focus
    root.bind_all("<KeyPress-r>", reset)
    root.bind_all("<KeyPress-R>", reset)
    root.bind_all("<Escape>", lambda _e: root.destroy())

    events = queue.Queue()
    threading.Thread(target=listen, args=(opts.host, opts.port, events), daemon=True).start()
    redraw()
    poll()
    root.mainloop()


if __name__ == "__main__":
    main()
