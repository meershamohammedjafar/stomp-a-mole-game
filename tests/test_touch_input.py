"""TouchTracker: TUIO cursors in, clean down / move / up contacts out, with flicker debounce."""

import pytest

from stomp_the_mole.touch_input import MAX_POINTS, TouchTracker, merge_points

W, H = 560, 448


def tuio(x_px, y_px):
    """TUIO fields for a floor pixel position."""
    return {"x": x_px / W, "y": y_px / H, "vx": 0.0, "vy": 0.0, "accel": 0.0}


@pytest.fixture
def tracker():
    return TouchTracker(W, H, debounce_ms=120, reacquire_px=28)


def test_add_reports_down_in_floor_pixels(tracker):
    assert tracker.on_tuio("add", 5, {"x": 0.5, "y": 0.25}, 0) == [("down", 1, 280.0, 112.0)]
    assert tracker.contacts() == {1: (280.0, 112.0)}


def test_update_reports_move_only_when_position_changes(tracker):
    tracker.on_tuio("add", 5, tuio(100, 100), 0)
    assert tracker.on_tuio("update", 5, tuio(100, 100), 10) == []
    assert tracker.on_tuio("update", 5, tuio(110, 105), 20) == [("move", 1, pytest.approx(110), pytest.approx(105))]


def test_remove_is_held_back_until_debounce_runs_out(tracker):
    tracker.on_tuio("add", 5, tuio(100, 100), 0)
    assert tracker.on_tuio("remove", 5, {}, 1000) == []
    assert 1 in tracker.contacts()  # pending contacts still count as present
    assert tracker.tick(1119) == []
    ups = tracker.tick(1120)
    assert len(ups) == 1 and ups[0][:2] == ("up", 1)
    assert ups[0][2:] == (pytest.approx(100), pytest.approx(100))
    assert tracker.contacts() == {}
    assert tracker.tick(2000) == []  # reported once only


def test_flicker_nearby_continues_the_same_contact_without_a_new_down(tracker):
    tracker.on_tuio("add", 5, tuio(200, 200), 0)
    tracker.on_tuio("remove", 5, {}, 500)
    events = tracker.on_tuio("add", 6, tuio(210, 205), 560)  # new session, 11 px away, 60 ms later
    assert events == [("move", 1, pytest.approx(210), pytest.approx(205))]
    assert tracker.tick(1000) == []  # the old pending is gone, so no up either
    # the new session id now drives contact 1
    assert tracker.on_tuio("update", 6, tuio(220, 205), 1010)[0][:2] == ("move", 1)
    tracker.on_tuio("remove", 6, {}, 1100)
    assert [e[:2] for e in tracker.tick(1300)] == [("up", 1)]


def test_flicker_at_the_same_spot_reports_nothing(tracker):
    tracker.on_tuio("add", 5, tuio(200, 200), 0)
    tracker.on_tuio("remove", 5, {}, 500)
    assert tracker.on_tuio("add", 6, tuio(200, 200), 600) == []


def test_readd_far_away_is_a_new_down(tracker):
    tracker.on_tuio("add", 5, tuio(200, 200), 0)
    tracker.on_tuio("remove", 5, {}, 500)
    events = tracker.on_tuio("add", 6, tuio(240, 200), 520)  # 40 px > reacquire_px
    assert events == [("down", 2, pytest.approx(240), pytest.approx(200))]
    assert set(tracker.contacts()) == {1, 2}
    assert [e[:2] for e in tracker.tick(620)] == [("up", 1)]


def test_readd_after_debounce_is_up_then_new_down_even_without_tick(tracker):
    tracker.on_tuio("add", 5, tuio(200, 200), 0)
    tracker.on_tuio("remove", 5, {}, 500)
    events = tracker.on_tuio("add", 6, tuio(200, 200), 621)
    assert [e[:2] for e in events] == [("up", 1), ("down", 2)]


def test_nearest_pending_contact_wins(tracker):
    tracker.on_tuio("add", 1, tuio(100, 100), 0)
    tracker.on_tuio("add", 2, tuio(135, 100), 0)  # 35 px apart: two feet (more than merge_px)
    tracker.on_tuio("remove", 1, {}, 100)
    tracker.on_tuio("remove", 2, {}, 100)
    events = tracker.on_tuio("add", 3, tuio(122, 100), 150)  # 22 px from #1, 13 px from #2
    assert events == [("move", 2, pytest.approx(122), pytest.approx(100))]
    assert [e[:2] for e in tracker.tick(300)] == [("up", 1)]


def test_several_ups_come_out_in_removal_order(tracker):
    for sid, x in ((1, 100), (2, 300), (3, 500)):
        tracker.on_tuio("add", sid, tuio(x, 100), 0)
    tracker.on_tuio("remove", 3, {}, 10)
    tracker.on_tuio("remove", 1, {}, 20)
    tracker.on_tuio("remove", 2, {}, 30)
    assert [e[1] for e in tracker.tick(1000)] == [3, 1, 2]


def test_contact_ids_are_tracker_ids_not_session_ids(tracker):
    assert tracker.on_tuio("add", 9001, tuio(100, 100), 0)[0][1] == 1
    assert tracker.on_tuio("add", 42, tuio(400, 300), 0)[0][1] == 2


def test_update_for_an_unknown_session_acts_like_add(tracker):
    assert [e[0] for e in tracker.on_tuio("update", 7, tuio(100, 100), 0)] == ["down"]


def test_remove_of_unknown_session_and_bad_fields_are_ignored(tracker):
    assert tracker.on_tuio("remove", 99, {}, 0) == []
    assert tracker.on_tuio("add", 1, {"x": "?", "y": 0.5}, 0) == []
    assert tracker.on_tuio("add", 1, {}, 0) == []
    assert tracker.on_tuio("refresh", 1, tuio(1, 1), 0) == []
    assert tracker.contacts() == {}


def test_zero_debounce_reports_up_immediately():
    tracker = TouchTracker(W, H, debounce_ms=0, reacquire_px=28)
    tracker.on_tuio("add", 1, tuio(100, 100), 0)
    assert [e[:2] for e in tracker.on_tuio("remove", 1, {}, 50)] == [("up", 1)]
    assert [e[0] for e in tracker.on_tuio("add", 2, tuio(100, 100), 50)] == ["down"]


@pytest.mark.parametrize("flip_x, flip_y, expected", [
    (False, False, (140.0, 112.0)),
    (True, False, (420.0, 112.0)),
    (False, True, (140.0, 336.0)),
    (True, True, (420.0, 336.0)),
])
def test_flips(flip_x, flip_y, expected):
    tracker = TouchTracker(W, H, flip_x=flip_x, flip_y=flip_y)
    _, _, x, y = tracker.on_tuio("add", 1, {"x": 0.25, "y": 0.25}, 0)[0]
    assert (x, y) == pytest.approx(expected)


def test_works_with_tuio_receiver_callbacks():
    """End to end with the real decoder: TuioState callbacks feed the tracker unchanged."""
    import tuio_receiver

    tracker = TouchTracker(W, H)
    out, clock = [], [0.0]

    def on_event(event, address, sid, touch):
        if address == "/tuio/2Dcur":
            out.extend(tracker.on_tuio(event, sid, touch.fields, clock[0]))

    state = tuio_receiver.TuioState(on_event)
    state.handle("/tuio/2Dcur", ["set", 11, 0.5, 0.5, 0.0, 0.0, 0.0])
    state.handle("/tuio/2Dcur", ["alive", 11])
    clock[0] = 30
    state.handle("/tuio/2Dcur", ["alive"])  # flicker: gone for one frame ...
    clock[0] = 60
    state.handle("/tuio/2Dcur", ["set", 12, 0.5, 0.5, 0.0, 0.0, 0.0])  # ... back under a new id
    state.handle("/tuio/2Dcur", ["alive", 12])
    clock[0] = 90
    state.handle("/tuio/2Dcur", ["alive"])
    assert out == [("down", 1, 280.0, 224.0)]
    assert tracker.tick(300) == [("up", 1, 280.0, 224.0)]


# ---------------------------------------------------------------- whole frames (what the server uses)


def frame(*points_px):
    return [tuio(x, y) for x, y in points_px]


def cells(x, y):
    """A foot as a floor that reports every pressed cell sends it: 2 x 4 cells of 14 px."""
    return [(x + dx, y + dy) for dx in (-7, 7) for dy in (-21, -7, 7, 21)]


def test_merge_points_is_single_linkage_at_the_mean():
    assert merge_points([], 30) == []
    assert merge_points([(0, 0)], 30) == [(0, 0)]
    # a chain of points 20 px apart is one group even though its ends are 60 px apart
    assert merge_points([(0, 0), (20, 0), (40, 0), (60, 0)], 30) == [(30, 0)]
    # groups come out in the order of their first point; exactly radius apart still merges
    assert merge_points([(100, 0), (0, 0), (130, 0), (10, 0)], 30) == [(115, 0), (5, 0)]
    assert merge_points([(0, 0), (31, 0)], 30) == [(0, 0), (31, 0)]
    assert merge_points([(0, 0), (0, 0)], 0) == [(0, 0), (0, 0)]  # 0 turns merging off
    # negative and large coordinates (cursors outside 0..1) work too
    assert merge_points([(-20, -20), (-5, -20), (900, 900)], 30) == [(-12.5, -20), (900, 900)]


def test_a_foot_reported_cell_by_cell_is_one_contact_at_its_centre(tracker):
    events = tracker.on_frame(frame(*cells(200, 200)), 0)
    assert events == [("down", 1, pytest.approx(200), pytest.approx(200))]
    assert tracker.on_frame(frame(*cells(200, 200)), 33) == []


def test_two_feet_apart_are_two_contacts_but_closer_than_merge_px_they_are_one(tracker):
    assert [e[:2] for e in tracker.on_frame(frame((100, 100), (160, 100)), 0)] == [("down", 1), ("down", 2)]
    t2 = TouchTracker(W, H)
    assert [e[:2] for e in t2.on_frame(frame((100, 100), (125, 100)), 0)] == [("down", 1)]


def test_a_cell_appearing_or_dropping_out_beside_a_standing_foot_is_a_move_not_a_down(tracker):
    foot = cells(200, 200)
    tracker.on_frame(frame(*foot), 0)
    events = tracker.on_frame(frame(*foot, (207, 235)), 33)  # a toe cell starts reading
    assert [e[:2] for e in events] == [("move", 1)]
    events = tracker.on_frame(frame(*foot[2:]), 66)  # heel cells drop out
    assert [e[:2] for e in events] == [("move", 1)]
    assert set(tracker.contacts()) == {1}


def test_a_foot_splitting_into_heel_and_toe_blobs_needs_a_bigger_merge_px():
    # heel and toe blobs 42 px apart (the arch cells released): two contacts at 30 px ...
    t30 = TouchTracker(W, H, merge_px=30)
    t30.on_frame(frame((200, 200)), 0)
    assert [e[0] for e in t30.on_frame(frame((200, 179), (200, 221)), 33)] == ["move", "down"]
    # ... one at 42 px, which is what the on-site recording decides
    t42 = TouchTracker(W, H, merge_px=42)
    t42.on_frame(frame((200, 200)), 0)
    assert t42.on_frame(frame((200, 179), (200, 221)), 33) == []


def test_session_ids_and_their_order_do_not_matter(tracker):
    """Feet are matched by position: ids swapping between feet, or a standing foot getting a new id
    with its set message before the alive message, are the same contacts."""
    import tuio_receiver

    out = []
    state = tuio_receiver.TuioState(lambda *event: None)

    def bundle(messages, now):
        for args in messages:
            state.handle("/tuio/2Dcur", args)
        fields = [t.fields for t in state.live["/tuio/2Dcur"].values()]
        out.extend(tracker.on_frame(fields, now))

    a, b = (280 / W, 244 / H), (355 / W, 244 / H)  # two still feet, 75 px apart
    bundle([["alive", 1, 2], ["set", 1, *a, 0, 0, 0], ["set", 2, *b, 0, 0, 0]], 0)
    assert [e[0] for e in out] == ["down", "down"]
    out.clear()
    for t in range(1, 30):  # ids are blob indexes in scan order: they swap every frame
        first, second = (a, b) if t % 2 else (b, a)
        bundle([["alive", 1, 2], ["set", 1, *first, 0, 0, 0], ["set", 2, *second, 0, 0, 0]], t * 33)
    # the sender relabels the foot at a with set before alive (not standard, but it happens)
    bundle([["set", 7, *a, 0, 0, 0], ["alive", 7, 2], ["set", 2, *b, 0, 0, 0]], 1000)
    assert out == [] and set(tracker.contacts()) == {1, 2}


def test_a_moving_foot_is_followed_within_match_px(tracker):
    tracker.on_frame(frame((100, 100)), 0)
    assert [e[:2] for e in tracker.on_frame(frame((150, 100)), 33)] == [("move", 1)]  # 50 px in a frame
    events = tracker.on_frame(frame((220, 100)), 66)  # 70 px: not the same foot
    assert [e[:2] for e in events] == [("down", 2)]
    assert [e[:2] for e in tracker.tick(66 + 120)] == [("up", 1)]


def test_frames_with_bad_fields_and_too_many_cursors():
    tracker = TouchTracker(W, H, merge_px=0)
    assert tracker.on_frame([{"x": float("nan"), "y": 0.5}, {"y": 0.5}, {"x": True, "y": 0.5}], 0) == []
    many = [tuio(i % 560, 10 + i // 560) for i in range(1000)]
    assert len(tracker.on_frame(many, 10)) == MAX_POINTS  # bounded work for a junk packet
