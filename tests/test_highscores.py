"""HighScores: today's top table in a JSON file, atomic writes, daily reset, never crashes the game."""

import datetime
import json
import logging
import os

import pytest

from stomp_the_mole.highscores import HighScores

DAY = datetime.date(2026, 10, 10)


class Clock:
    def __init__(self):
        self.day = DAY
        self.time = "12:00"

    def today(self):
        return self.day

    def hhmm(self):
        return self.time


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def path(tmp_path):
    return tmp_path / "data" / "highscores.json"  # the folder does not exist yet


def make(path, clock, size=10):
    return HighScores(path, size=size, today=clock.today, clock=clock.hhmm)


def test_missing_file_starts_empty_and_is_logged(path, clock, caplog):
    with caplog.at_level(logging.INFO, logger="stomp_the_mole.highscores"):
        table = make(path, clock)
    assert table.top() == []
    assert "No high score file" in caplog.text
    assert not path.exists()  # nothing written until a score is submitted


def test_submit_ranks_and_writes_the_file(path, clock):
    table = make(path, clock)
    assert table.submit(10, 4) == 1
    clock.time = "12:05"
    assert table.submit(25, 7) == 1
    assert table.submit(15, 3) == 2
    assert [e["score"] for e in table.top()] == [25, 15, 10]
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data == {"date": "2026-10-10", "scores": [
        {"score": 25, "best_combo": 7, "time": "12:05"},
        {"score": 15, "best_combo": 3, "time": "12:05"},
        {"score": 10, "best_combo": 4, "time": "12:00"},
    ]}


def test_ties_keep_the_earlier_entry_first(path, clock):
    table = make(path, clock)
    clock.time = "10:00"
    assert table.submit(12, 1) == 1
    clock.time = "11:00"
    assert table.submit(12, 9) == 2
    assert [e["time"] for e in table.top()] == ["10:00", "11:00"]


def test_zero_scores_are_not_recorded(path, clock):
    table = make(path, clock)
    assert table.submit(0, 0) is None
    assert table.top() == []
    assert not path.exists()


def test_table_is_capped_and_low_scores_get_no_rank(path, clock):
    table = make(path, clock, size=3)
    for score in (5, 9, 7):
        table.submit(score, 1)
    assert table.submit(5, 1) is None  # ties the last entry, which was there first
    assert table.submit(6, 1) == 3
    assert [e["score"] for e in table.top()] == [9, 7, 6]
    assert table.submit(100, 1) == 1
    assert [e["score"] for e in table.top()] == [100, 9, 7]


def test_table_survives_a_restart(path, clock):
    make(path, clock).submit(8, 2)
    again = make(path, clock)
    assert again.top() == [{"score": 8, "best_combo": 2, "time": "12:00"}]
    assert again.submit(3, 1) == 2


def test_new_day_starts_an_empty_table(path, clock):
    table = make(path, clock)
    table.submit(30, 5)
    clock.day = DAY + datetime.timedelta(days=1)
    assert table.top() == []  # in the running game
    assert make(path, clock).top() == []  # and after a restart
    assert table.submit(4, 1) == 1
    assert json.loads(path.read_text(encoding="utf-8"))["date"] == "2026-10-11"


@pytest.mark.parametrize("content", [
    "{not json",
    "[]",
    '{"date": "2026-10-10"}',
    '{"date": 20261010, "scores": []}',
    "\xff\xfe garbage",
])
def test_corrupt_file_starts_empty_logs_and_recovers(path, clock, caplog, content):
    path.parent.mkdir(parents=True)
    path.write_bytes(content.encode("latin-1"))
    with caplog.at_level(logging.WARNING, logger="stomp_the_mole.highscores"):
        table = make(path, clock)
    assert table.top() == []
    assert caplog.records, "the problem should be logged"
    assert "highscores.json.bad" in caplog.text
    assert table.submit(6, 2) == 1
    assert json.loads(path.read_text(encoding="utf-8"))["scores"][0]["score"] == 6
    # the unusable file was kept, not overwritten by the save
    assert path.with_name("highscores.json.bad").read_bytes() == content.encode("latin-1")


def test_a_file_saved_with_a_bom_keeps_its_scores(path, clock, caplog):
    """Notepad's "UTF-8 with BOM" (or PowerShell 5.1) must not wipe today's table."""
    path.parent.mkdir(parents=True)
    data = {"date": "2026-10-10", "scores": [{"score": 30, "best_combo": 5, "time": "09:00"}]}
    path.write_text("﻿" + json.dumps(data), encoding="utf-8")
    with caplog.at_level(logging.WARNING, logger="stomp_the_mole.highscores"):
        table = make(path, clock)
    assert table.top() == data["scores"] and not caplog.records
    assert table.submit(3, 1) == 2
    assert [e["score"] for e in json.loads(path.read_text(encoding="utf-8"))["scores"]] == [30, 3]
    assert not path.with_name("highscores.json.bad").exists()


def test_a_second_unusable_file_replaces_the_older_bad_copy(path, clock):
    path.parent.mkdir(parents=True)
    path.write_text("first", encoding="utf-8")
    make(path, clock)
    path.write_text("second", encoding="utf-8")
    make(path, clock)
    assert path.with_name("highscores.json.bad").read_text(encoding="utf-8") == "second"
    assert not path.exists()


def test_invalid_entries_are_dropped_and_the_rest_sorted(path, clock, caplog):
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"date": "2026-10-10", "scores": [
        {"score": 4, "best_combo": 1, "time": "09:00"},
        {"score": "lots", "best_combo": 1, "time": "09:01"},
        {"score": 9, "best_combo": 2, "time": "09:02"},
        {"score": True, "best_combo": 2, "time": "09:03"},
        {"score": 4, "best_combo": 3, "time": "09:04"},
        "nope",
    ]}), encoding="utf-8")
    with caplog.at_level(logging.WARNING, logger="stomp_the_mole.highscores"):
        table = make(path, clock)
    assert [(e["score"], e["time"]) for e in table.top()] == [(9, "09:02"), (4, "09:00"), (4, "09:04")]
    assert "invalid entries" in caplog.text


def test_write_is_atomic_and_leaves_no_temp_files(path, clock):
    table = make(path, clock)
    for score in range(1, 15):
        table.submit(score, 0)
    assert sorted(p.name for p in path.parent.iterdir()) == ["highscores.json"]


def test_failed_save_is_logged_and_keeps_the_old_file(path, clock, caplog, monkeypatch):
    table = make(path, clock)
    table.submit(5, 1)
    before = path.read_text(encoding="utf-8")

    def broken_replace(src, dst):
        raise PermissionError("file is locked")

    monkeypatch.setattr(os, "replace", broken_replace)
    with caplog.at_level(logging.ERROR, logger="stomp_the_mole.highscores"):
        assert table.submit(9, 3) == 1  # the game still gets its rank
    assert "Could not save" in caplog.text
    assert path.read_text(encoding="utf-8") == before
    assert sorted(p.name for p in path.parent.iterdir()) == ["highscores.json"]


def test_in_memory_table_needs_no_file(clock):
    table = HighScores(None, size=2, today=clock.today, clock=clock.hhmm)
    assert table.submit(3, 1) == 1
    assert table.top() == [{"score": 3, "best_combo": 1, "time": "12:00"}]


def test_top_returns_copies(path, clock):
    table = make(path, clock)
    table.submit(3, 1)
    table.top()[0]["score"] = 999
    assert table.top()[0]["score"] == 3


def test_default_clock_and_date_work(path):
    table = HighScores(path)
    assert table.submit(1, 0) == 1
    entry = table.top()[0]
    assert len(entry["time"]) == 5 and entry["time"][2] == ":"
    assert json.loads(path.read_text(encoding="utf-8"))["date"] == datetime.date.today().isoformat()
