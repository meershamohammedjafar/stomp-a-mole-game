"""Pretend to be the LED floor: a Tk window that sends TUIO touches to Stomp the Mole.

Left mouse button = one foot: press to step down, drag to slide, release to lift.
Right click puts down a standing foot that stays until you right-click it again (C clears them all).
The window shows the holes, the START pad and the HUD band, laid out from the game's config, and
sends TUIO 1.1 /tuio/2Dcur bundles (source, alive, set, fseq) at 30 Hz, like Interactive Platform.

    python fake_floor.py                 # 560 x 448 window, sends to 127.0.0.1:3333
    python fake_floor.py --scale 1.5     # a bigger window; coordinates sent stay normalised 0..1
    python fake_floor.py --port 3334

If config.json sets tuio.flip_x / flip_y, the same flip is applied before sending, so the game
sees each foot exactly where you clicked. Esc quits. Standard library only.
"""

import argparse
import ctypes
import socket
import struct
import time
import tkinter as tk

FPS = 30
FOOT_R = 14          # floor px
GRAB_R = 24          # floor px: how close a right click must be to pick up a standing foot

# Same defaults and formula as DESIGN.md / stomp_the_mole.config, used if the config cannot load.
DEFAULT_LAYOUT = {
    "floor": {"width": 560, "height": 448},
    "tuio": {"flip_x": False, "flip_y": False},
    "holes": {"cols": 3, "rows": 3, "top_margin": 40, "draw_radius": 48, "hit_radius": 58},
    "start_pad": {"x": 280, "y": 244, "radius": 72},
}


def hole_centres(cfg):
    w, h = cfg["floor"]["width"], cfg["floor"]["height"]
    cols, rows, top = cfg["holes"]["cols"], cfg["holes"]["rows"], cfg["holes"]["top_margin"]
    return [{"index": r * cols + c,
             "x": w * (2 * c + 1) / (2 * cols),
             "y": top + (h - top) * (2 * r + 1) / (2 * rows)}
            for r in range(rows) for c in range(cols)]


def load_layout(path=None):
    try:
        from stomp_the_mole.config import load_config
        cfg = load_config(path)
        return cfg, "config.json" if path is None else path
    except Exception as exc:  # any problem: fall back to the defaults, the tool still works
        print(f"Using default layout ({exc.__class__.__name__}: {exc})")
        return DEFAULT_LAYOUT, "defaults"


# ---------------------------------------------------------------- OSC / TUIO encoding


def osc_string(text):
    data = text.encode("utf-8") + b"\0"
    return data + b"\0" * (-len(data) % 4)


def osc_message(address, *args):
    tags, body = ",", b""
    for arg in args:
        if isinstance(arg, str):
            tags, body = tags + "s", body + osc_string(arg)
        elif isinstance(arg, int):
            tags, body = tags + "i", body + struct.pack(">i", arg)
        else:
            tags, body = tags + "f", body + struct.pack(">f", float(arg))
    return osc_string(address) + osc_string(tags) + body


def osc_bundle(messages):
    out = b"#bundle\0" + struct.pack(">Q", 1)  # time tag 1 = "immediately"
    for message in messages:
        out += struct.pack(">i", len(message)) + message
    return out


def tuio_frame(source, cursors, fseq):
    """One TUIO 1.1 2Dcur bundle; cursors is [(session_id, x, y)] in 0..1."""
    messages = [osc_message("/tuio/2Dcur", "source", source),
                osc_message("/tuio/2Dcur", "alive", *[sid for sid, _, _ in cursors])]
    messages += [osc_message("/tuio/2Dcur", "set", sid, x, y, 0.0, 0.0, 0.0) for sid, x, y in cursors]
    messages.append(osc_message("/tuio/2Dcur", "fseq", fseq))
    return osc_bundle(messages)


# ---------------------------------------------------------------- the window


class Foot:
    def __init__(self, sid, x, y, standing):
        self.sid, self.x, self.y, self.standing = sid, x, y, standing  # x, y in floor px
        self.released = False
        self.sent = False


class FakeFloor:
    def __init__(self, root, cfg, layout_name, host, port, scale):
        self.root = root
        self.cfg = cfg
        self.w, self.h = cfg["floor"]["width"], cfg["floor"]["height"]
        self.s = scale
        self.target = (host, port)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.source = f"fake_floor@{socket.gethostname()}"
        self.feet = []
        self.mouse_foot = None
        self.next_sid = 1
        self.fseq = 0
        self.error = ""
        self.next_frame = time.monotonic()

        root.title(f"Fake floor -> udp {host}:{port}  ({layout_name})")
        root.resizable(False, False)
        self.canvas = tk.Canvas(root, width=round(self.w * scale), height=round(self.h * scale),
                                bg="#2f6b2a", highlightthickness=0, cursor="crosshair")
        self.canvas.pack()
        self.status = tk.Label(root, anchor="w", font=("Consolas", 9), fg="#dddddd", bg="#111111")
        self.status.pack(fill="x")
        self.draw_layout()

        self.canvas.bind("<ButtonPress-1>", self.on_down)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_up)
        self.canvas.bind("<ButtonPress-3>", self.on_right)
        root.bind("<KeyPress-c>", self.clear_standing)
        root.bind("<KeyPress-C>", self.clear_standing)
        root.bind("<Escape>", lambda _e: root.destroy())
        self.send_frame()

    # -------------------------------------------------------- drawing

    def draw_layout(self):
        c, s = self.canvas, self.s
        top = self.cfg["holes"]["top_margin"]
        c.create_rectangle(0, 0, self.w * s, top * s, fill="#1d4419", outline="")
        c.create_text(8 * s, top * s / 2, anchor="w", fill="#9fc79a", font=("Segoe UI", 9),
                      text="HUD band (no holes here)")
        pad = self.cfg["start_pad"]
        self.circle(pad["x"], pad["y"], pad["radius"], outline="#f2d34a", dash=(6, 4), width=2)
        c.create_text(pad["x"] * s, (pad["y"] + pad["radius"] - 12) * s, fill="#f2d34a",
                      font=("Segoe UI", 9, "bold"), text="START")
        holes = self.cfg["holes"]
        centres = self.cfg.get("hole_centres") or hole_centres(self.cfg)
        for hole in centres:
            self.circle(hole["x"], hole["y"], holes["hit_radius"], outline="#c7e0a0", dash=(3, 3))
            self.circle(hole["x"], hole["y"], holes["draw_radius"], fill="#4a2f1b", outline="#2b1a0e", width=2)
            c.create_text(hole["x"] * s, hole["y"] * s, fill="#d9c4a8", font=("Segoe UI", 12, "bold"),
                          text=str(hole["index"]))

    def circle(self, x, y, r, **opts):
        s = self.s
        return self.canvas.create_oval((x - r) * s, (y - r) * s, (x + r) * s, (y + r) * s, **opts)

    def redraw_feet(self):
        self.canvas.delete("foot")
        for foot in self.feet:
            if foot.released:
                continue
            colour = "#3fa7ff" if foot.standing else "#ff8c2a"
            self.circle(foot.x, foot.y, FOOT_R, fill=colour, outline="white", width=2, tags="foot")
        n = sum(1 for f in self.feet if not f.released)
        self.status.config(text=f" {n} foot/feet down   sent {self.fseq} frames to "
                                f"{self.target[0]}:{self.target[1]}   {self.error}")

    # -------------------------------------------------------- input

    def floor_xy(self, event):
        x = min(max(event.x / self.s, 0.0), self.w)
        y = min(max(event.y / self.s, 0.0), self.h)
        return x, y

    def new_foot(self, x, y, standing):
        foot = Foot(self.next_sid, x, y, standing)
        self.next_sid += 1
        self.feet.append(foot)
        return foot

    def on_down(self, event):
        if self.mouse_foot is not None:
            self.mouse_foot.released = True
        self.mouse_foot = self.new_foot(*self.floor_xy(event), standing=False)

    def on_drag(self, event):
        if self.mouse_foot is not None:
            self.mouse_foot.x, self.mouse_foot.y = self.floor_xy(event)

    def on_up(self, _event):
        if self.mouse_foot is not None:
            self.mouse_foot.released = True
            self.mouse_foot = None

    def on_right(self, event):
        x, y = self.floor_xy(event)
        standing = [f for f in self.feet if f.standing and not f.released
                    and (f.x - x) ** 2 + (f.y - y) ** 2 <= GRAB_R ** 2]
        if standing:
            standing[0].released = True
        else:
            self.new_foot(x, y, standing=True)

    def clear_standing(self, _event=None):
        for foot in self.feet:
            if foot.standing:
                foot.released = True

    # -------------------------------------------------------- output

    def send_frame(self):
        # A released foot leaves only after it was in at least one frame, so quick taps are not lost.
        self.feet = [f for f in self.feet if not (f.released and f.sent)]
        flip_x, flip_y = self.cfg["tuio"]["flip_x"], self.cfg["tuio"]["flip_y"]
        cursors = []
        for foot in self.feet:
            x, y = foot.x / self.w, foot.y / self.h
            cursors.append((foot.sid, 1.0 - x if flip_x else x, 1.0 - y if flip_y else y))
            foot.sent = True
        self.fseq += 1
        try:
            self.sock.sendto(tuio_frame(self.source, cursors, self.fseq), self.target)
            self.error = ""
        except OSError as exc:
            self.error = f"send failed: {exc}"
        self.redraw_feet()
        self.next_frame = max(self.next_frame + 1 / FPS, time.monotonic())
        self.root.after(max(1, round((self.next_frame - time.monotonic()) * 1000)), self.send_frame)


def main():
    parser = argparse.ArgumentParser(description="Fake LED floor: mouse = foot, sends TUIO to the game.")
    parser.add_argument("--host", default="127.0.0.1", help="where to send TUIO (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=3333, help="UDP port (default 3333)")
    parser.add_argument("--scale", type=float, default=1.0, help="window size factor (default 1.0)")
    parser.add_argument("--config", metavar="PATH", help="game config to take the layout from")
    opts = parser.parse_args()
    if opts.scale <= 0:
        parser.error("--scale must be more than 0")

    try:  # real screen pixels, so --scale 1 is exactly the floor's 560 x 448
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except (AttributeError, OSError):
        pass
    cfg, layout_name = load_layout(opts.config)
    root = tk.Tk()
    FakeFloor(root, cfg, layout_name, opts.host, opts.port, opts.scale)
    root.mainloop()


if __name__ == "__main__":
    main()
