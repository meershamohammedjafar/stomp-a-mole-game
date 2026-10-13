"""The on-site TUIO tools: iter_messages' framing rule, tuio_receiver --record lines, tuio_replay."""

import json
import struct
import threading

import pytest

import tuio_receiver
import tuio_replay
from fake_floor import osc_bundle, osc_message, tuio_frame
from stomp_the_mole.netserver import osc_framing_ok

STEP = 1000 / 30  # ms between frames at 30 frames per second


def decode(data, timeout=2.0):
    """iter_messages in a thread, so a regression that loops forever fails instead of hanging."""
    result = {}

    def run():
        try:
            result["messages"] = list(tuio_receiver.iter_messages(data))
        except Exception as exc:  # noqa: BLE001 - the test looks at which error it was
            result["error"] = exc

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(timeout)
    assert not thread.is_alive(), "iter_messages never returned"
    return result


def nested(depth):
    data = osc_message("/tuio/2Dcur", "alive")
    for _ in range(depth):
        data = osc_bundle([data])
    return data


# ---------------------------------------------------------------- iter_messages


def test_negative_element_size_is_an_error_not_an_endless_loop():
    result = decode(b"#bundle\0" + struct.pack(">Q", 1) + struct.pack(">i", -4))
    assert isinstance(result.get("error"), ValueError)


def test_deep_nesting_is_an_error_not_a_crash():
    result = decode(nested(1500))  # used to end in RecursionError, which the tools do not catch
    assert isinstance(result.get("error"), ValueError)


def test_good_packets_still_decode():
    good = tuio_frame("x@y", [(1, 0.5, 0.25)], 7)
    for data in (good, good + b"\0\0\0", nested(8)):  # 1-3 trailing pad bytes are tolerated
        assert "error" not in decode(data)
    messages = decode(good)["messages"]
    assert [m[1][0] for m in messages] == ["source", "alive", "set", "fseq"]
    assert messages[2] == ("/tuio/2Dcur", ["set", 1, 0.5, 0.25, 0.0, 0.0, 0.0])


def test_the_tools_and_the_game_accept_exactly_the_same_packets():
    good = tuio_frame("x@y", [(1, 0.5, 0.5)], 1)
    packets = [good, good + b"\0\0\0", good[:-3], good[:-8], b"\x00garbage",
               b"#bundle\0" + struct.pack(">Q", 1) + struct.pack(">i", 1 << 20)]
    packets += [nested(depth) for depth in range(1, 13)]
    for data in packets:
        assert ("error" not in decode(data)) == osc_framing_ok(data), data[:40]


# ---------------------------------------------------------------- --record


def test_record_line_is_one_json_object_per_packet():
    messages = [("/tuio/2Dcur", ["set", 5, 0.5, 0.25, 0.0, 0.0, 0.0]),
                ("/tuio/_sxyb", [b"\x01\xff", float("nan"), None, True])]
    line = tuio_receiver.record_line(1234.56789, "192.168.123.228", messages)
    assert "\n" not in line
    assert json.loads(line) == {"t_ms": 1234.568, "from": "192.168.123.228", "msgs": [
        ["/tuio/2Dcur", "set", 5, 0.5, 0.25, 0.0, 0.0, 0.0], ["/tuio/_sxyb", "01ff", "nan", None, True]]}
    bad = json.loads(tuio_receiver.record_line(1.0, "10.0.0.9", [], error="bad bundle element size -4"))
    assert bad == {"t_ms": 1.0, "from": "10.0.0.9", "msgs": [], "error": "bad bundle element size -4"}


# ---------------------------------------------------------------- tuio_replay


def recording(frames, t0=5000.0):
    """--record lines for frames of [(session_id, x_px, y_px)], one packet per frame at 30 fps."""
    lines = []
    for n, cursors in enumerate(frames):
        msgs = [("/tuio/2Dcur", ["source", "floor@pc"]), ("/tuio/2Dcur", ["alive", *[c[0] for c in cursors]])]
        msgs += [("/tuio/2Dcur", ["set", sid, x / 560, y / 448, 0.0, 0.0, 0.0]) for sid, x, y in cursors]
        msgs.append(("/tuio/2Dcur", ["fseq", n + 1]))
        lines.append(tuio_receiver.record_line(t0 + n * STEP, "127.0.0.1", msgs))
    return lines


def standing_foot_with_a_dropout():
    """A foot standing in hole 4 for 2 s: lost for 4 frames after 1 s, and relabelled once."""
    frames = [[(1, 280, 244)]] * 30 + [[]] * 4 + [[(2, 280, 244)]] * 11 + [[(3, 280, 244)]] * 15
    return recording(frames)


def test_replay_measures_frames_dropouts_ids_and_the_stomps_the_game_would_see():
    records = tuio_replay.read_records(standing_foot_with_a_dropout() + ["", "{cut short"])
    s = tuio_replay.analyse(list(tuio_replay.frames(records)))
    assert s["frames"] == 60
    assert s["gap_median_ms"] == pytest.approx(STEP, abs=0.01)  # times are kept to 1 us
    assert s["cursors_per_frame"] == {0: 4, 1: 56}
    assert s["cursors_per_foot"] == pytest.approx(1.0)
    assert s["dropouts_ms"] == [pytest.approx(4 * STEP, abs=0.01)]  # gone for 4 frames
    assert (s["relabels"], s["jumps"]) == (1, 0)
    # 133 ms is longer than debounce_ms 120: the foot comes back as a new down, at the same spot
    assert [d["reland"] for d in s["downs"]] == [False, True]
    longer = tuio_replay.analyse(list(tuio_replay.frames(records)), debounce_ms=150)
    assert len(longer["downs"]) == 1
    text = tuio_replay.report(s, records[0][0], list_downs=True)
    assert "one cursor per foot" in text and "longest 133 ms" in text
    assert "Downs (stomps) the game would see: 2, of which 1 re-landed" in text


def test_replay_spots_one_cursor_per_pressed_cell():
    cells = [(10 + i, 280 + dx, 244 + dy) for i, (dx, dy) in
             enumerate((dx, dy) for dx in (-7, 7) for dy in (-21, -7, 7, 21))]
    s = tuio_replay.analyse(list(tuio_replay.frames(tuio_replay.read_records(recording([cells] * 10)))))
    assert s["cursors_per_foot"] == pytest.approx(8.0)
    assert s["neighbour_cells"] == {1: 80}  # every cursor's nearest neighbour is one cell away
    assert len(s["downs"]) == 1
    assert "SEVERAL cursors per foot" in tuio_replay.report(s)


def test_replay_command_line(tmp_path, capsys):
    path = tmp_path / "floor.jsonl"
    path.write_text("\n".join(standing_foot_with_a_dropout()) + "\n", encoding="utf-8")
    assert tuio_replay.main([str(path), "--list-downs"]) == 0
    out = capsys.readouterr().out
    assert "Recording" in out and "60 packets" in out and "down at (280, 244)" in out
    assert tuio_replay.main([str(path), "--start", "0", "--end", "0.9"]) == 0  # before the dropout
    assert "Downs (stomps) the game would see: 1," in capsys.readouterr().out
    assert tuio_replay.main([str(path), "--start", "30"]) == 1  # nothing that late
    assert tuio_replay.main([str(tmp_path / "missing.jsonl")]) == 1
