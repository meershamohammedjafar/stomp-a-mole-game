"""TouchTracker: turns raw TUIO cursors into clean floor contacts (down / move / up, stable ids).

It works on whole TUIO frames (one bundle's live /tuio/2Dcur cursors), by position, and never
trusts TUIO session ids or the order of the messages inside a bundle:

  * Cursors closer than ``merge_px`` (single linkage) are one foot, at their mean position. A floor
    that reports one cursor per pressed cell, or a foot that splits into heel and toe blobs, still
    gives one contact per foot.
  * Each live contact carries on to the nearest foot within ``match_px`` in the next frame (a move),
    nearest pairs first. Feet whose ids swap or get relabelled are the same contacts.
  * Sensing flickers: a foot can drop out for a frame or two. A contact with no foot in a frame is
    held *pending* for ``debounce_ms`` instead of being reported "up" at once. A foot that appears
    within ``reacquire_px`` of it in that time carries on the same contact (a move at most, never a
    new down). Only a foot that matches nothing is a new "down".
"""

import math
from dataclasses import dataclass

MAX_POINTS = 256  # cursors per frame looked at; more than any real floor sends, and bounds the work


def merge_points(points, radius):
    """Single linkage: points closer than ``radius`` (directly or through a chain) become one,
    at their mean. Returns [(x, y)] in the order of each group's first point."""
    pts = list(points)
    if radius <= 0 or len(pts) < 2:
        return pts
    parent = list(range(len(pts)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    cells = {}  # a grid of radius-sized cells: only neighbouring cells can hold a close pair
    for i, (x, y) in enumerate(pts):
        cells.setdefault((math.floor(x / radius), math.floor(y / radius)), []).append(i)
    for (cx, cy), members in cells.items():
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in cells.get((cx + dx, cy + dy), ()):
                    for i in members:
                        if i < j and math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) <= radius:
                            a, b = root(i), root(j)
                            if a != b:
                                parent[max(a, b)] = min(a, b)
    groups = {}
    for i, point in enumerate(pts):
        groups.setdefault(root(i), []).append(point)
    return [(sum(p[0] for p in g) / len(g), sum(p[1] for p in g) / len(g)) for g in groups.values()]


@dataclass(slots=True)
class _Contact:
    id: int
    x: float
    y: float
    removed_at: float | None = None  # set while pending


class TouchTracker:
    def __init__(self, floor_w, floor_h, debounce_ms=120, reacquire_px=28, merge_px=30, match_px=56,
                 flip_x=False, flip_y=False):
        self.floor_w = floor_w
        self.floor_h = floor_h
        self.debounce_ms = debounce_ms
        self.reacquire_px = reacquire_px
        self.merge_px = merge_px
        self.match_px = match_px
        self.flip_x = flip_x
        self.flip_y = flip_y
        self._live = {}        # contact id -> _Contact seen in the latest frame
        self._pending = {}     # contact id -> _Contact waiting out the debounce
        self._sessions = {}    # on_tuio only: TUIO session id -> fields
        self._next_id = 1

    def on_frame(self, points, now: float) -> list[tuple]:
        """One complete TUIO frame: the fields ({"x", "y"} normalised) of every cursor alive now.

        Returns the contact events [("down"|"move"|"up", contact_id, x_px, y_px), ...].
        """
        out = self._expire(now)
        feet = self._feet(points)

        # 1. live contacts carry on to the nearest foot within match_px, nearest pairs first
        pairs = sorted((d, c.id, i) for c in self._live.values() for i, (x, y) in enumerate(feet)
                       if (d := math.hypot(x - c.x, y - c.y)) <= self.match_px)
        foot_of = {}      # contact id -> foot index
        contact_of = {}   # foot index -> contact id
        for _, cid, i in pairs:
            if cid not in foot_of and i not in contact_of:
                foot_of[cid], contact_of[i] = i, cid
        for cid in sorted(foot_of):
            out += self._move(self._live[cid], *feet[foot_of[cid]])

        # 2. live contacts without a foot wait out the debounce
        for cid in [cid for cid in self._live if cid not in foot_of]:
            contact = self._live.pop(cid)
            contact.removed_at = now
            self._pending[cid] = contact

        # 3. other feet: back after a flicker (nearest pending contact within reacquire_px) or new
        rest = [i for i in range(len(feet)) if i not in contact_of]
        pairs = sorted((d, c.removed_at, c.id, i) for c in self._pending.values() for i in rest
                       if (d := math.hypot(feet[i][0] - c.x, feet[i][1] - c.y)) <= self.reacquire_px)
        for _, _, cid, i in pairs:
            if cid in self._pending and i not in contact_of:
                contact = self._pending.pop(cid)
                contact.removed_at = None
                self._live[cid] = contact
                contact_of[i] = cid
                out += self._move(contact, *feet[i])
        for i in rest:
            if i not in contact_of:
                x, y = feet[i]
                contact = _Contact(self._next_id, x, y)
                self._next_id += 1
                self._live[contact.id] = contact
                out.append(("down", contact.id, x, y))

        return out + self._expire(now)  # debounce_ms == 0 reports the ups straight away

    def on_tuio(self, event: str, session_id, fields: dict, now: float) -> list[tuple]:
        """Per-cursor input ("add" / "update" / "remove", as TuioState calls back), for tools and tests.

        Keeps its own table of live cursors and treats every change as a frame. The game server
        calls on_frame once per TUIO bundle instead, so a bundle is never seen half applied.
        """
        if event == "remove":
            if self._sessions.pop(session_id, None) is None:
                return self._expire(now)
        elif event in ("add", "update") and self._to_px(fields) is not None:
            self._sessions[session_id] = dict(fields)
        else:
            return self._expire(now)
        return self.on_frame(list(self._sessions.values()), now)

    def tick(self, now: float) -> list[tuple]:
        """Report "up" for pending contacts whose debounce time has run out."""
        return self._expire(now)

    def contacts(self) -> dict[int, tuple[float, float]]:
        """Live and pending contacts: id -> (x_px, y_px)."""
        both = list(self._live.values()) + list(self._pending.values())
        return {c.id: (c.x, c.y) for c in sorted(both, key=lambda c: c.id)}

    # ------------------------------------------------------------ internals

    @staticmethod
    def _move(contact, x, y):
        if (x, y) == (contact.x, contact.y):
            return []
        contact.x, contact.y = x, y
        return [("move", contact.id, x, y)]

    def _feet(self, points):
        """Cursor positions in floor px, merged into feet."""
        pts = []
        for fields in points:
            pos = self._to_px(fields)
            if pos is not None:
                pts.append(pos)
                if len(pts) >= MAX_POINTS:
                    break
        return merge_points(pts, self.merge_px)

    def _to_px(self, fields):
        x, y = fields.get("x"), fields.get("y")
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                   for v in (x, y)):
            return None
        if self.flip_x:
            x = 1.0 - x
        if self.flip_y:
            y = 1.0 - y
        return x * self.floor_w, y * self.floor_h

    def _expire(self, now):
        done = [c for c in self._pending.values() if now - c.removed_at >= self.debounce_ms]
        done.sort(key=lambda c: (c.removed_at, c.id))
        for contact in done:
            del self._pending[contact.id]
        return [("up", c.id, c.x, c.y) for c in done]
