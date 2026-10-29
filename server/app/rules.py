"""排名与积分：shared/ranking.js 的服务端等价实现。

保持与客户端完全一致的统计口径与排序链，避免两端名次不同。
"""

TEAM_GROUPS = {"match", "teams"}

# 模式 -> 分组（用于判断按人还是按队排名）
MODE_GROUP = {
    "eight": "doubles",
    "mixRound": "doubles",
    "fixedRound": "doubles",
    "freeRound": "doubles",
    "loop": "doubles",
    "weakStrong": "doubles",
    "doubleLoop": "doubles",
    "arena": "doubles",
    "singlesRound": "singles",
    "freeRoundSingles": "singles",
    "singlesLoop": "singles",
    "singlesArena": "singles",
    "singlesDoubleLoop": "singles",
    "promote": "doubles",
    "teamRound": "match",
    "wheelMatch": "match",
    "freeMatch": "match",
    "fixedMatch": "match",
    "relayMatch": "match",
    "singlesMatch": "match",
    "fixedTeams": "teams",
    "wheelTeams": "teams",
    "singlesTeams": "teams",
}

CHAINS = {
    "pointFirst": ["point", "wins", "netball", "rate_alls", "rate_net", "rate_netball"],
    "ballFirst": ["netball", "wins", "winball", "point", "rate_alls", "rate_net", "rate_netball"],
    "totalFirst": ["winball", "netball", "wins", "point", "rate_alls", "rate_net", "rate_netball"],
    "winsFirst": [
        "wins",
        "wins_minus_fail",
        "net",
        "point",
        "netball",
        "winball",
        "rate_alls",
        "rate_net",
        "rate_netball",
    ],
}


def entity_kind(mode: str) -> str:
    return "team" if MODE_GROUP.get(mode) in TEAM_GROUPS else "player"


def match_points(sets: list[list[int]]) -> list[int]:
    wins = sum(1 for s in sets if s[0] > s[1])
    losses = sum(1 for s in sets if s[0] < s[1])
    diff = wins - losses
    if len(sets) == 1:
        if diff > 0:
            return [2, 0]
        if diff < 0:
            return [0, 2]
        return [1, 1]
    if diff > 0:
        return [diff, 0]
    if diff < 0:
        return [0, -diff]
    return [1, 1]


def _empty() -> dict:
    return {
        "alls": 0,
        "wins": 0,
        "even": 0,
        "fail": 0,
        "allRound": 0,
        "winRound": 0,
        "failRound": 0,
        "net": 0,
        "allBalls": 0,
        "winball": 0,
        "failball": 0,
        "netball": 0,
        "point": 0,
        "rate_alls": 0.0,
        "rate_net": 0.0,
        "rate_netball": 0.0,
    }


def _apply(stats: dict, sets: list[list[int]], wins: int, fails: int) -> None:
    stats["alls"] += 1
    if wins > fails:
        stats["wins"] += 1
    elif wins < fails:
        stats["fail"] += 1
    else:
        stats["even"] += 1

    for a, b in sets:
        stats["netball"] += a - b
        stats["winball"] += a
        stats["failball"] += b
        stats["allBalls"] += a + b
        stats["allRound"] += 1
        if a > b:
            stats["winRound"] += 1
            stats["net"] += 1
        elif a < b:
            stats["failRound"] += 1
            stats["net"] -= 1

    stats["point"] += match_points(sets)[0]


def _finalize(stats: dict) -> dict:
    stats["rate_alls"] = stats["wins"] / stats["alls"] if stats["alls"] else 0.0
    stats["rate_net"] = stats["winRound"] / stats["allRound"] if stats["allRound"] else 0.0
    stats["rate_netball"] = stats["winball"] / stats["allBalls"] if stats["allBalls"] else 0.0
    stats["wins_minus_fail"] = stats["wins"] - stats["fail"]
    return stats


def _team_index(race: dict, match: dict, side: int) -> int:
    if match.get("teamA") is not None:
        return match["teamA"] if side == 0 else match["teamB"]
    player_id = (match["side1"] if side == 0 else match["side2"])[0]
    for i, team in enumerate(race.get("teams") or []):
        if player_id in team.get("players", []):
            return i
    return 0


def compute(race: dict) -> dict:
    """返回 {kind, rows:[{key,name,...统计字段}]}，rows 已按 rankMode 排序。"""
    kind = entity_kind(race.get("mode", ""))
    rows: list[dict] = []
    index: dict[str, int] = {}

    if kind == "team":
        for i, team in enumerate(race.get("teams") or []):
            row = {"key": f"t{i}", "name": team.get("name") or f"{i + 1}队", **_empty()}
            index[f"t{i}"] = len(rows)
            rows.append(row)
    else:
        for p in race.get("players") or []:
            row = {"key": p.get("id"), "name": p.get("name"), **_empty()}
            index[p["id"]] = len(rows)
            rows.append(row)

    for m in race.get("matches") or []:
        sets = m.get("scores") or []
        score_all = m.get("scoreAll")
        if not score_all or not sets:
            continue
        if kind == "team":
            a = index.get(f"t{_team_index(race, m, 0)}")
            b = index.get(f"t{_team_index(race, m, 1)}")
            if a is None or b is None:
                continue
            _apply(rows[a], sets, score_all[0], score_all[1])
            _apply(rows[b], [[s[1], s[0]] for s in sets], score_all[1], score_all[0])
        else:
            flipped = [[s[1], s[0]] for s in sets]
            for pid in m.get("side1") or []:
                if pid in index:
                    _apply(rows[index[pid]], sets, score_all[0], score_all[1])
            for pid in m.get("side2") or []:
                if pid in index:
                    _apply(rows[index[pid]], flipped, score_all[1], score_all[0])

    for row in rows:
        _finalize(row)

    chain = CHAINS.get(race.get("rankMode") or "pointFirst", CHAINS["pointFirst"])
    order = sorted(
        range(len(rows)),
        key=lambda i: (tuple(-rows[i][k] for k in chain), i),
    )
    return {"kind": kind, "rows": [rows[i] for i in order]}


def personal_stats(races: list[dict], name: str, user_id: str | None = None) -> dict:
    """跨比赛统计某人的场次与单/双打胜率。

    优先按 user_id 匹配（报名即身份，选手 id 就是用户 id），没有再退回按名字匹配，
    这样改昵称后历史战绩不会丢。
    """
    total = {"alls": 0, "wins": 0, "fail": 0, "even": 0}
    singles = {"alls": 0, "wins": 0, "fail": 0, "even": 0}
    doubles = {"alls": 0, "wins": 0, "fail": 0, "even": 0}
    rounds = 0

    for race in races:
        is_singles = entity_kind(race.get("mode", "")) == "player" and (
            str(race.get("mode", "")).startswith("singles")
        )
        for m in race.get("matches") or []:
            sets = m.get("scores") or []
            score_all = m.get("scoreAll")
            if not score_all or not sets:
                continue
            ids = (m.get("side1") or []) + (m.get("side2") or [])
            mine = -1
            for p in race.get("players") or []:
                if p.get("id") not in ids:
                    continue
                hit = (user_id and p.get("id") == user_id) or (name and p.get("name") == name)
                if hit:
                    mine = 0 if p["id"] in (m.get("side1") or []) else 1
            if mine < 0:
                continue

            bucket = singles if is_singles else doubles
            total["alls"] += 1
            bucket["alls"] += 1
            if score_all[0] > score_all[1]:
                winner = 0
            elif score_all[0] < score_all[1]:
                winner = 1
            else:
                winner = -1

            if winner == -1:
                total["even"] += 1
                bucket["even"] += 1
            elif winner == mine:
                total["wins"] += 1
                bucket["wins"] += 1
            else:
                total["fail"] += 1
                bucket["fail"] += 1
            rounds += len(sets)

    return {
        "total": total,
        "singles": singles,
        "doubles": doubles,
        "rounds": rounds,
        "name": name,
        "userId": user_id,
    }


def person_stats(races: list[dict], participants_fn) -> list[dict]:
    """人员统计（后台用）：报名次数 + 实际开赛的场次/胜负/积分/净胜分 + 单场排名历史。

    只统计 status 为 playing/done 的比赛（实际开赛才算「参加过」）；
    draft/open 只计入 signups。用户身份来自报名（participants.user_id 同时是对阵里的选手 id）。
    """
    from collections import defaultdict

    users: dict[str, dict] = {}

    for race in races:
        status = race.get("status")
        started = status in ("playing", "done")
        parts = participants_fn(race["id"])
        if not parts:
            continue

        rank_by_id = {}
        if started and race.get("matches"):
            result = compute(race)
            for pos, row in enumerate(result["rows"], start=1):
                rank_by_id[row["key"]] = (pos, row)

        for p in parts:
            uid = p["user_id"]
            user = users.get(uid)
            if user is None:
                user = {
                    "id": uid,
                    "name": p.get("name") or "",
                    "avatar": p.get("avatar"),
                    "signups": 0,
                    "alls": 0,
                    "wins": 0,
                    "fail": 0,
                    "point": 0,
                    "netball": 0,
                    "races": [],
                }
                users[uid] = user
            user["signups"] += 1
            if not started:
                continue

            entry = {
                "raceId": race["id"],
                "raceName": race.get("name") or "未命名比赛",
                "date": race.get("date"),
                "status": status,
                "mode": race.get("mode"),
                "rank": None,
                "wins": 0,
                "fail": 0,
                "point": 0,
                "netball": 0,
            }
            hit = rank_by_id.get(uid)
            if hit is not None:
                pos, row = hit
                user["alls"] += 1
                user["wins"] += row["wins"]
                user["fail"] += row["fail"]
                user["point"] += row["point"]
                user["netball"] += row["netball"]
                entry.update(
                    {
                        "rank": pos,
                        "wins": row["wins"],
                        "fail": row["fail"],
                        "point": row["point"],
                        "netball": row["netball"],
                    }
                )
            user["races"].append(entry)

    people = list(users.values())
    for u in people:
        u["rate"] = round(u["wins"] / u["alls"], 4) if u["alls"] else None
    people.sort(key=lambda u: (-u["alls"], u["name"]))
    return people


def acquaintances(races: list[dict], user_id: str, participants_fn) -> list[dict]:
    """当前用户报名过的比赛里，别的参赛者的最新档案（一键选球友）。

    participants_fn(race_id) -> participants。去重取最新一次报名资料，最多 20 人。
    """
    seen: dict[str, dict] = {}
    ordered: list[str] = []
    for race in races:
        if race.get("status") == "draft":
            continue
        parts = participants_fn(race["id"])
        mine = any(p["user_id"] == user_id for p in parts)
        if not mine:
            continue
        for p in parts:
            if p["user_id"] == user_id:
                continue
            if p["user_id"] not in seen:
                seen[p["user_id"]] = {
                    "id": p["user_id"],
                    "name": p.get("name") or "",
                    "avatar": p.get("avatar"),
                    "gender": p.get("gender") or "M",
                    "level": p.get("level") or 0,
                }
                ordered.append(p["user_id"])
    return [seen[uid] for uid in ordered[-20:]]
