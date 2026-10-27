"""排名计算与客户端一致性测试。"""

from app import rules


def make_race(mode="loop", rank_mode="pointFirst", players=None, matches=None):
    return {
        "mode": mode,
        "rankMode": rank_mode,
        "players": players
        or [
            {"id": "p0", "name": "P0", "gender": "M", "level": 0},
            {"id": "p1", "name": "P1", "gender": "F", "level": 1},
            {"id": "p2", "name": "P2", "gender": "M", "level": 2},
        ],
        "teams": [],
        "matches": matches or [],
    }


def test_match_points():
    assert rules.match_points([[21, 10]]) == [2, 0]
    assert rules.match_points([[21, 10], [21, 15]]) == [2, 0]
    assert rules.match_points([[21, 10], [15, 21], [21, 19]]) == [1, 0]
    assert rules.match_points([[21, 10], [15, 21]]) == [1, 1]


def test_entity_kind():
    assert rules.entity_kind("eight") == "player"
    assert rules.entity_kind("singlesLoop") == "player"
    assert rules.entity_kind("fixedTeams") == "team"
    assert rules.entity_kind("wheelMatch") == "team"


def test_point_first_order():
    race = make_race(
        matches=[
            {"side1": ["p0"], "side2": ["p1"], "scores": [[21, 10], [21, 10]], "scoreAll": [2, 0]},
            {"side1": ["p0"], "side2": ["p2"], "scores": [[21, 10], [21, 10]], "scoreAll": [2, 0]},
            {"side1": ["p1"], "side2": ["p2"], "scores": [[21, 10], [15, 21], [21, 19]], "scoreAll": [2, 1]},
        ]
    )
    rows = rules.compute(race)["rows"]
    assert rows[0]["name"] == "P0"
    assert rows[0]["point"] == 4
    assert rows[0]["wins"] == 2
    assert rows[0]["netball"] == 44


def test_wins_first_order():
    race = make_race(
        rank_mode="winsFirst",
        matches=[
            {"side1": ["p0"], "side2": ["p1"], "scores": [[21, 19], [21, 19]], "scoreAll": [2, 0]},
            {"side1": ["p2"], "side2": ["p1"], "scores": [[21, 10], [21, 10]], "scoreAll": [2, 0]},
        ],
    )
    rows = rules.compute(race)["rows"]
    assert rows[0]["wins"] == 1
    assert rows[-1]["name"] == "P1"


def test_team_ranking():
    race = {
        "mode": "fixedTeams",
        "rankMode": "pointFirst",
        "players": [
            {"id": "a1", "name": "A1"},
            {"id": "a2", "name": "A2"},
            {"id": "b1", "name": "B1"},
            {"id": "b2", "name": "B2"},
        ],
        "teams": [
            {"name": "A 队", "players": ["a1", "a2"]},
            {"name": "B 队", "players": ["b1", "b2"]},
        ],
        "matches": [
            {
                "side1": ["a1", "a2"],
                "side2": ["b1", "b2"],
                "teamA": 0,
                "teamB": 1,
                "scores": [[21, 15]],
                "scoreAll": [1, 0],
            }
        ],
    }
    result = rules.compute(race)
    assert result["kind"] == "team"
    assert result["rows"][0]["name"] == "A 队"
    assert result["rows"][0]["point"] == 2
    assert result["rows"][1]["point"] == 0


def test_personal_stats():
    race = make_race(
        matches=[
            {"side1": ["p0"], "side2": ["p1"], "scores": [[21, 10], [21, 10]], "scoreAll": [2, 0]},
            {"side1": ["p1"], "side2": ["p0"], "scores": [[21, 10], [21, 10]], "scoreAll": [2, 0]},
        ]
    )
    stats = rules.personal_stats([race], "P0")
    assert stats["total"]["alls"] == 2
    assert stats["total"]["wins"] == 1
    assert stats["total"]["fail"] == 1
    assert stats["rounds"] == 4
