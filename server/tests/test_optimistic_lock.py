"""乐观锁：rev 版本号 + 并发写冲突、状态机护栏。

覆盖：
- 每场比赛文档有 rev，写一次 +1
- put_match：同场并发只成功一次，另一个 409；不同场互不干扰
- put_race（整文档覆盖）：rev 落后 409；禁止把 playing/done 回滚成 draft
- match 没有 rev 基线时服务端补 0
"""

import threading

from fastapi.testclient import TestClient

from app.main import app


def login(client, device):
    res = client.post("/api/auth/login", json={"deviceId": device})
    return {"Authorization": "Bearer " + res.json()["token"]}


def base_race(rid="lock_race"):
    return {
        "id": rid,
        "name": "乐观锁测试",
        "mode": "singlesRound",
        "group": "singles",
        "rounds": 1,
        "balls": 11,
        "players": [],
        "teams": [],
        "matches": [],
    }


def make_mid(rid, mid, side1="dev_a", side2="dev_b"):
    return {
        "id": mid,
        "round": 1,
        "court": 1,
        "side1": [side1],
        "side2": [side2],
        "scores": [],
        "scoreAll": None,
        "status": "pending",
    }


def start_race(client, owner, rid, matches):
    payload = {"players": [
        {"id": "dev_a", "name": "甲", "gender": "M", "level": 1},
        {"id": "dev_b", "name": "乙", "gender": "M", "level": 2},
        {"id": "dev_c", "name": "丙", "gender": "M", "level": 3},
        {"id": "dev_d", "name": "丁", "gender": "M", "level": 4},
    ], "matches": matches}
    r = client.post(f"/api/races/{rid}/start", json=payload, headers=owner)
    assert r.status_code == 200, r.text


def setup_playing(client, rid="lock_race"):
    owner = login(client, "lock-owner")
    client.post("/api/races", json=base_race(rid), headers=owner)
    client.post(f"/api/races/{rid}/open", json={"maxPlayers": 8}, headers=owner)
    start_race(client, owner, rid, [make_mid(rid, "m1")])
    return owner


def test_doc_rev_increments_with_each_save():
    with TestClient(app) as client:
        owner = setup_playing(client, "rev_inc")
        doc = client.get("/api/races/rev_inc", headers=owner).json()
        assert doc["rev"] == 3  # create + open + start 各 +1
        assert doc["matches"][0]["rev"] == 0

        # 记一局后比赛 rev 与 match rev 各自 +1
        m = doc["matches"][0]
        m.update({"scores": [[11, 5]], "scoreAll": [1, 0], "status": "done"})
        r = client.put("/api/races/rev_inc/matches/m1", json=m, headers=owner)
        assert r.status_code == 200
        after = client.get("/api/races/rev_inc", headers=owner).json()
        assert after["rev"] == 4
        assert after["matches"][0]["rev"] == 1


def test_put_race_rejects_stale_rev():
    with TestClient(app) as client:
        owner = setup_playing(client, "stale_race")
        doc = client.get("/api/races/stale_race", headers=owner).json()

        # 模拟：A 拿到 rev=2，B 先改了一笔，A 再拿 rev=2 覆盖 → 409
        m = doc["matches"][0]
        m.update({"scores": [[11, 4]], "scoreAll": [1, 0], "status": "done"})
        assert client.put("/api/races/stale_race/matches/m1", json=m, headers=owner).status_code == 200

        stale = dict(doc, rev=2)  # A 的旧视图
        stale["players"] = doc["players"] + [{"id": "dev_x", "name": "插队者", "gender": "M", "level": 9}]
        r = client.put("/api/races/stale_race", json=stale, headers=owner)
        assert r.status_code == 409, r.text
        assert "rev" in r.json()["detail"]
        # 服务端状态没被旧文档污染
        now = client.get("/api/races/stale_race", headers=owner).json()
        assert len(now["players"]) == 4


def test_put_race_cannot_rollback_playing_to_draft():
    with TestClient(app) as client:
        owner = setup_playing(client, "rb_race")
        doc = client.get("/api/races/rb_race", headers=owner).json()
        doc["status"] = "draft"  # 恶意/离线重放旧文档
        r = client.put("/api/races/rb_race", json=doc, headers=owner)
        assert r.status_code == 409, r.text
        assert client.get("/api/races/rb_race", headers=owner).json()["status"] == "playing"


def test_same_match_concurrent_only_one_wins():
    with TestClient(app) as client:
        owner = setup_playing(client, "cc_race")
        doc = client.get("/api/races/cc_race", headers=owner).json()
        base = doc["matches"][0]

        results = []
        barrier = threading.Barrier(2)

        def submit(tag, scores):
            m = dict(base)
            m.update({"scores": scores, "scoreAll": [1, 0], "status": "done"})
            barrier.wait()
            with TestClient(app) as cc:
                r = cc.put("/api/races/cc_race/matches/m1", json=m, headers=owner)
                results.append((tag, r.status_code))

        ts = [
            threading.Thread(target=submit, args=("A", [[11, 5]])),
            threading.Thread(target=submit, args=("B", [[5, 11]])),
        ]
        [t.start() for t in ts]
        [t.join() for t in ts]

        codes = sorted(x[1] for x in results)
        assert codes == [200, 409], results
        final = client.get("/api/races/cc_race", headers=owner).json()["matches"][0]
        assert final["rev"] == 1  # 只成功写了一次


def test_different_matches_do_not_conflict():
    with TestClient(app) as client:
        owner = login(client, "dm-owner")
        client.post("/api/races", json=base_race("dm_race"), headers=owner)
        client.post("/api/races/dm_race/open", json={"maxPlayers": 8}, headers=owner)
        start_race(client, owner, "dm_race", [
            make_mid("dm_race", "m1", "dev_a", "dev_b"),
            make_mid("dm_race", "m2", "dev_c", "dev_d"),
        ])
        doc = client.get("/api/races/dm_race", headers=owner).json()

        results = []
        barrier = threading.Barrier(2)

        def submit(mid):
            m = next(x for x in doc["matches"] if x["id"] == mid)
            m.update({"scores": [[11, 3]], "scoreAll": [1, 0], "status": "done"})
            barrier.wait()
            with TestClient(app) as cc:
                r = cc.put(f"/api/races/dm_race/matches/{mid}", json=m, headers=owner)
                results.append((mid, r.status_code))

        ts = [threading.Thread(target=submit, args=("m1",)), threading.Thread(target=submit, args=("m2",))]
        [t.start() for t in ts]
        [t.join() for t in ts]
        assert all(x[1] == 200 for x in results), results


def test_start_sets_match_rev_zero_when_missing():
    with TestClient(app) as client:
        owner = login(client, "rev0-owner")
        client.post("/api/races", json=base_race("r0_race"), headers=owner)
        client.post("/api/races/r0_race/open", json={"maxPlayers": 8}, headers=owner)
        m = make_mid("r0_race", "m1")  # 老客户端发的 match 不含 rev
        payload = {"players": [
            {"id": "dev_a", "name": "甲", "gender": "M", "level": 1},
            {"id": "dev_b", "name": "乙", "gender": "M", "level": 2},
        ], "matches": [m]}
        r = client.post("/api/races/r0_race/start", json=payload, headers=owner)
        assert r.status_code == 200, r.text
        assert r.json()["matches"][0]["rev"] == 0