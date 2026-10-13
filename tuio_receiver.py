"""Minimal TUIO receiver: listens for OSC-over-UDP and prints touches.

Built to check what an interactive platform actually sends, pressure in
particular. Plain TUIO 1.1 touches (/tuio/2Dcur) carry only x/y, so pressure
has to arrive some other way; this script recognises the usual ones:
  * TUIO 2.0 pointers (/tuio2/ptr)        -> explicit pressure field
  * 2.5D / 3D cursors (/tuio/25Dcur ...)  -> z is often used as pressure
  * blobs (/tuio/2Dblb ...)               -> contact area grows with force
  * custom profiles (/tuio/_sxyP ...)     -> letter-coded fields
Every OSC address is announced the first time it is seen, and when a touch
lifts it prints which values changed while it was down, so the field that
follows finger force shows up even if it is none of the above.

No third-party packages needed. Run:
    python tuio_receiver.py                     # listen on 0.0.0.0:3333
    python tuio_receiver.py --port 3334         # another port
    python tuio_receiver.py --raw               # also dump every OSC message
    python tuio_receiver.py --record floor.jsonl
                                                # also save every packet for tuio_replay.py
Every line starts with the wall-clock time and a millisecond counter (t=...), so flicker,
dropouts and frame gaps can be read off directly.
"""

import argparse
import json
import math
import socket
import struct
import time

# ---------------------------------------------------------------- OSC decode


def _read_string(data, pos):
    end = data.index(b"\0", pos)
    text = data[pos:end].decode("utf-8", "replace")
    return text, (end + 4) & ~3  # strings are padded to a 4-byte boundary


def _read_blob(data, pos):
    (size,) = struct.unpack_from(">i", data, pos)
    pos += 4
    return data[pos:pos + size], (pos + size + 3) & ~3


def parse_message(data):
    """Return (address, [args]) for one OSC message."""
    address, pos = _read_string(data, 0)
    if pos >= len(data) or data[pos:pos + 1] != b",":
        return address, []
    tags, pos = _read_string(data, pos)
    args = []
    for tag in tags[1:]:
        if tag == "i":
            args.append(struct.unpack_from(">i", data, pos)[0]); pos += 4
        elif tag == "f":
            args.append(struct.unpack_from(">f", data, pos)[0]); pos += 4
        elif tag in "sS":
            value, pos = _read_string(data, pos); args.append(value)
        elif tag == "b":
            value, pos = _read_blob(data, pos); args.append(value)
        elif tag == "h":
            args.append(struct.unpack_from(">q", data, pos)[0]); pos += 8
        elif tag == "d":
            args.append(struct.unpack_from(">d", data, pos)[0]); pos += 8
        elif tag == "t":
            args.append(struct.unpack_from(">Q", data, pos)[0]); pos += 8
        elif tag in "cr":
            args.append(struct.unpack_from(">I", data, pos)[0]); pos += 4
        elif tag == "T":
            args.append(True)
        elif tag == "F":
            args.append(False)
        elif tag in "NI":
            args.append(None)
        # unknown tags carry no data we know how to skip; stop here
        else:
            break
    return address, args


MAX_BUNDLE_DEPTH = 8


def iter_messages(data, depth=0):
    """Yield (address, args) for a packet, flattening nested bundles.

    Raises ValueError for a bundle element whose size is negative or runs past the end of the
    packet, and for bundles nested deeper than MAX_BUNDLE_DEPTH, so one malformed packet can never
    hang or crash a listener. Up to 3 trailing pad bytes after the last element are tolerated.
    """
    if data.startswith(b"#bundle\0"):
        if depth > MAX_BUNDLE_DEPTH:
            raise ValueError("bundles nested too deep")
        pos = 16  # "#bundle\0" + 8-byte timetag
        while pos + 4 <= len(data):
            (size,) = struct.unpack_from(">i", data, pos)
            pos += 4
            if size < 0 or pos + size > len(data):
                raise ValueError(f"bad bundle element size {size}")
            yield from iter_messages(data[pos:pos + size], depth + 1)
            pos += size
    elif data:
        yield parse_message(data)


# ---------------------------------------------------------------- TUIO profiles

# TUIO 1.1 letter codes, used by the standard profiles and by custom ones.
LETTERS = {
    "i": "class_id", "x": "x", "y": "y", "z": "z",
    "a": "angle", "b": "angle_b", "c": "angle_c",
    "w": "w", "h": "h", "d": "d", "f": "area", "v": "volume",
    "X": "vx", "Y": "vy", "Z": "vz", "A": "vangle", "B": "vangle_b", "C": "vangle_c",
    "m": "accel", "r": "raccel",
}
# "set" argument layout per TUIO 1.1 profile (session id excluded).
PROFILES = {
    "/tuio/2Dcur": "xyXYm",
    "/tuio/25Dcur": "xyzXYZm",
    "/tuio/3Dcur": "xyzXYZm",
    "/tuio/2Dobj": "ixyaXYAmr",
    "/tuio/25Dobj": "ixyzaXYZAmr",
    "/tuio/3Dobj": "ixyzabcXYZABCmr",
    "/tuio/2Dblb": "xyawhfXYAmr",
    "/tuio/25Dblb": "xyzawhfXYZAmr",
    "/tuio/3Dblb": "xyzabcwhdvXYZABCmr",
}
# TUIO 2.0 pointer: /tuio2/ptr s_id tu_id c_id x y angle shear radius press [vx vy vp accel paccel]
TUIO2_PTR = ("tu_id", "c_id", "x", "y", "angle", "shear", "radius", "pressure",
             "vx", "vy", "vpressure", "accel", "paccel")

# Fields that might carry pressure, best guess first.
PRESSURE_CANDIDATES = ("pressure", "P", "z", "area")
# Velocities/accelerations change on every move; leave them out of summaries.
NOISY = {"vx", "vy", "vz", "vangle", "vangle_b", "vangle_c", "accel", "raccel",
         "vpressure", "paccel"}


def field_names(address):
    if address == "/tuio2/ptr":
        return TUIO2_PTR
    code = PROFILES.get(address)
    if code is None and address.startswith("/tuio/_"):
        code = address[len("/tuio/_"):].lstrip("s")  # custom profile, e.g. /tuio/_sxyP
    if code is None:
        return None
    return tuple(LETTERS.get(ch, ch) for ch in code)


def kind_of(address):
    for tag, kind in (("ptr", "pointer"), ("cur", "cursor"), ("obj", "object"), ("blb", "blob")):
        if tag in address:
            return kind
    return "custom"


def pressure_of(fields):
    for name in PRESSURE_CANDIDATES:
        if isinstance(fields.get(name), (int, float)):
            return name, fields[name]
    return None, None


class Touch:
    def __init__(self, fields):
        self.start = time.monotonic()
        self.fields = fields
        self.ranges = {}
        self.update(fields)

    def update(self, fields):
        self.fields = fields
        for name, value in fields.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                lo, hi = self.ranges.get(name, (value, value))
                self.ranges[name] = (min(lo, value), max(hi, value))


class TuioState:
    def __init__(self, on_event):
        self.on_event = on_event
        self.live = {}  # address -> {session_id: Touch}

    def handle(self, address, args):
        if address == "/tuio2/ptr" and args:
            self._set(address, args[0], args[1:])
        elif address == "/tuio2/alv":
            # TUIO 2.0 has one alive list for every component type
            for table_address in [a for a in self.live if a.startswith("/tuio2/")]:
                self._alive(table_address, args)
        elif args and field_names(address) is not None:
            command = args[0]
            if command == "set" and len(args) > 1:
                self._set(address, args[1], args[2:])
            elif command == "alive":
                self._alive(address, args[1:])
        # source / fseq / frm just frame the data; nothing to do for a printer

    def _set(self, address, sid, values):
        fields = dict(zip(field_names(address), values))
        table = self.live.setdefault(address, {})
        if sid in table:
            table[sid].update(fields)
            self.on_event("update", address, sid, table[sid])
        else:
            table[sid] = Touch(fields)
            self.on_event("add", address, sid, table[sid])

    def _alive(self, address, alive_ids):
        table = self.live.setdefault(address, {})
        alive = set(alive_ids)
        for sid in [s for s in table if s not in alive]:
            self.on_event("remove", address, sid, table.pop(sid))


# ---------------------------------------------------------------- main


def bar(value, width=20):
    filled = round(max(0.0, min(1.0, value)) * width)
    return "[" + "#" * filled + " " * (width - filled) + "]"


def _jsonable(value):
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)  # NaN / inf are not valid JSON

    return value


def record_line(t_ms, sender, messages, error=None):
    """One line of a --record file (JSON): when the packet arrived (time.monotonic() in ms), who sent
    it, and its decoded messages as [address, arg, ...]. Blobs are written as hex."""
    entry = {"t_ms": round(t_ms, 3), "from": sender,
             "msgs": [[address, *map(_jsonable, args)] for address, args in messages]}
    if error is not None:
        entry["error"] = error
    return json.dumps(entry, separators=(",", ":"))


def main():
    parser = argparse.ArgumentParser(description="Print TUIO touches from UDP.")
    parser.add_argument("--host", default="0.0.0.0", help="interface to bind (default all)")
    parser.add_argument("--port", type=int, default=3333, help="UDP port (default 3333)")
    parser.add_argument("--raw", action="store_true", help="print every OSC message too")
    parser.add_argument("--no-updates", action="store_true", help="only print add/remove")
    parser.add_argument("--width", type=int, default=0, help="screen width to also show pixels")
    parser.add_argument("--height", type=int, default=0, help="screen height to also show pixels")
    parser.add_argument("--record", metavar="FILE",
                        help="also append every packet to FILE, one JSON line each (for tuio_replay.py)")
    opts = parser.parse_args()

    pressure_seen = {}  # field name -> (min, max) over the whole session
    started = time.monotonic()
    packet_at = [started]  # when the packet being decoded arrived

    def stamp():
        return f"{time.strftime('%H:%M:%S')} t={(packet_at[0] - started) * 1000:9.1f}"

    def on_event(event, address, sid, touch):
        f = touch.fields
        p_name, p_value = pressure_of(f)
        if p_name is not None:
            lo, hi = pressure_seen.get(p_name, (p_value, p_value))
            pressure_seen[p_name] = (min(lo, p_value), max(hi, p_value))
        if event == "update" and opts.no_updates:
            return

        x, y = f.get("x", 0.0), f.get("y", 0.0)
        line = f"{stamp()} {event.upper():6} {kind_of(address):7} id={sid:<5} x={x:.3f} y={y:.3f}"
        if opts.width and opts.height:
            line += f"  px=({x * opts.width:.0f},{y * opts.height:.0f})"
        if p_name is not None:
            line += f"  {p_name}={p_value:.3f} {bar(p_value)}"
        print(line, flush=True)

        if event == "remove":
            held = time.monotonic() - touch.start
            changed = [f"{n} {lo:.3f}..{hi:.3f}" for n, (lo, hi) in touch.ranges.items()
                       if n not in NOISY and hi != lo]
            print(f"         held {held:.2f}s; values that changed: "
                  f"{', '.join(changed) if changed else 'none'}", flush=True)

    state = TuioState(on_event)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((opts.host, opts.port))
    sock.settimeout(1.0)  # lets Ctrl+C through on Windows
    record = open(opts.record, "a", encoding="utf-8", buffering=1) if opts.record else None  # line-buffered
    print(f"Listening for TUIO on udp://{opts.host}:{opts.port}  (Ctrl+C to stop)"
          + (f", recording to {opts.record}" if record else ""), flush=True)

    packets = 0
    addresses = set()
    try:
        while True:
            try:
                data, sender = sock.recvfrom(65535)
            except socket.timeout:
                continue
            packet_at[0] = time.monotonic()
            packets += 1
            if packets == 1:
                print(f"First packet from {sender[0]}:{sender[1]}", flush=True)
            messages, error = [], None
            try:
                for message in iter_messages(data):
                    messages.append(message)
            except (ValueError, struct.error) as exc:
                error = f"{exc}"
            if record:
                record.write(record_line(packet_at[0] * 1000, sender[0], messages, error) + "\n")
            for address, args in messages:
                if address not in addresses:
                    addresses.add(address)
                    known = "" if field_names(address) or address.startswith("/tuio2/") \
                        else "  (not a profile this script decodes, see --raw)"
                    print(f"New OSC address: {address}{known}", flush=True)
                if opts.raw:
                    print(f"{stamp()}  {address} {args}", flush=True)
                state.handle(address, args)
            if error is not None:
                print(f"{stamp()} Bad packet from {sender[0]} ({len(data)} bytes): {error}", flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        sock.close()
        if record:
            record.close()

    print(f"\nStopped after {packets} packets. Addresses seen: {', '.join(sorted(addresses)) or 'none'}")
    if pressure_seen:
        for name, (lo, hi) in pressure_seen.items():
            print(f"Pressure-like field '{name}' ranged {lo:.3f}..{hi:.3f}"
                  + ("  <- never changed, so it is not tracking force" if lo == hi else ""))
    elif packets:
        print("No pressure field was sent: only x/y positions arrived. Check the 'values that "
              "changed' lines; if nothing besides x/y moved, the platform is not sending pressure over TUIO.")


if __name__ == "__main__":
    main()
