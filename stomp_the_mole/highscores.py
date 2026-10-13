"""Today's top scores, kept in a small JSON file. Scores only: no names, no personal data.

File format: {"date": "YYYY-MM-DD", "scores": [{"score": int, "best_combo": int, "time": "HH:MM"}]},
best score first; ties keep the earlier entry first. The table empties itself when the day
changes. Writes go to a temp file that then replaces the real one, so a power cut never leaves a
half-written file. A missing, unreadable or corrupt file is logged and starts an empty table (a
file that is there but unusable is first renamed to highscores.json.bad, so nothing is lost); a
failed save is logged and play carries on. The file is read once, at start: to clear the table,
stop the game, delete the file, and start the game again.
"""

import datetime
import json
import logging
import os
import tempfile
from pathlib import Path

log = logging.getLogger(__name__)


def _today():
    return datetime.date.today()


def _clock():
    return datetime.datetime.now().strftime("%H:%M")


class HighScores:
    def __init__(self, path, size=10, today=_today, clock=_clock):
        """``path=None`` keeps the table in memory only (handy for tests)."""
        self.path = Path(path) if path is not None else None
        self.size = size
        self._today = today
        self._clock = clock
        self._date, self._scores = self._load()

    def top(self) -> list[dict]:
        """Today's table, best first (copies; safe to send as-is)."""
        self._roll_day()
        return [dict(entry) for entry in self._scores]

    def submit(self, score: int, best_combo: int) -> int | None:
        """Record a finished round. Returns its 1-based rank, or None if it did not make the table."""
        score = int(score)
        if score <= 0:
            return None
        self._roll_day()
        rank = next((i for i, e in enumerate(self._scores) if e["score"] < score), len(self._scores))
        if rank >= self.size:
            return None
        self._scores.insert(rank, {"score": score, "best_combo": int(best_combo), "time": self._clock()})
        del self._scores[self.size:]
        self._save()
        return rank + 1

    def _date_text(self):
        day = self._today()
        return day if isinstance(day, str) else day.isoformat()

    def _roll_day(self):
        today = self._date_text()
        if self._date != today:
            self._date, self._scores = today, []

    def _load(self):
        today = self._date_text()
        if self.path is None:
            return today, []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8-sig"))  # -sig: Notepad may save a BOM
        except FileNotFoundError:
            log.info("No high score file at %s yet; starting an empty table", self.path)
            return today, []
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            log.warning("High score file %s could not be read (%s); %s", self.path, exc, self._set_aside())
            return today, []
        if not (isinstance(data, dict) and isinstance(data.get("date"), str)
                and isinstance(data.get("scores"), list)):
            log.warning("High score file %s is not in the expected format; %s", self.path, self._set_aside())
            return today, []
        scores = [_clean(entry) for entry in data["scores"]]
        if None in scores:
            log.warning("High score file %s has invalid entries; they were dropped", self.path)
        scores = [entry for entry in scores if entry is not None]
        scores.sort(key=lambda e: -e["score"])  # stable: equal scores keep their file order
        return data["date"], scores[:self.size]

    def _set_aside(self):
        """Move a file we cannot use out of the way, so the next save does not destroy it."""
        bad = self.path.with_name(self.path.name + ".bad")
        try:
            os.replace(self.path, bad)
        except OSError as exc:
            return f"starting an empty table (could not keep a copy: {exc})"
        return f"kept it as {bad.name} and started an empty table"

    def _save(self):
        if self.path is None:
            return
        data = {"date": self._date, "scores": self._scores}
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=self.path.name + ".", suffix=".tmp", dir=self.path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2)
                    f.write("\n")
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        except OSError as exc:
            log.error("Could not save high scores to %s: %s", self.path, exc)


def _clean(entry):
    """A valid table entry from the file, or None."""
    if not isinstance(entry, dict):
        return None
    score, combo, time = entry.get("score"), entry.get("best_combo"), entry.get("time")
    if (type(score) is not int or score <= 0 or type(combo) is not int or combo < 0
            or not isinstance(time, str)):
        return None
    return {"score": score, "best_combo": combo, "time": time}
