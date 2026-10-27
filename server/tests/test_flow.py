"""报名 → 开始 → 记分 → 实时 → 汇总 的完整流程测试。"""

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def login(client, device):
    res = client.post("/api/auth/login", json={"deviceId": device})
    return {"Authorization": "Bearer " + res.json()["token"]}


def base_race(race_id="flow_race"):
    return {
        "id": race_id,
        "name": "周五羽球",
        "mode": "singlesRound",
        "group": "singles",
        "rounds": 3,
        "balls": 21,
        "wheelMode": "isolate",
        "partnerMode": "random",
        "rankMode": "pointFirst",
        "players": [],
        "teams": [],
        "matches": [],
    }


def test_signup_to_summary():
    with TestClient(app) as client:
        admin = login(client, "admin-1")
        alice = login(client, "alice-1")
        bob = login(client, "bob-1")

        assert client.post("/api/races", json=base_race(), headers=admin).status_code == 200

        # 开放报名
        opened = client.post("/api/races/flow_race/open", json={"maxPlayers": 4}, headers=admin)
        assert opened.status_code == 200, opened.text
        code = opened.json()["joinCode"]
        assert len(code) == 6
        assert opened.json()["status"] == "open"

        # 未开放时报名的错误路径由 open 之后的状态覆盖，这里校验链接可读
        info = client.get("/api/join/" + code, headers=alice).json()
        assert info["race"]["name"] == "周五羽球"
        assert info["joined"] is False

        # 成员报名
        joined = client.post(
            "/api/races/flow_race/join",
            json={"name": "阿豪", "gender": "M", "level": 3},
            headers=alice,
        )
        assert joined.status_code == 200, joined.text
        assert [p["name"] for p in joined.json()["participants"]] == ["阿豪"]

        client.post(
            "/api/races/flow_race/join",
            json={"name": "小林", "gender": "F", "level": 2},
            headers=bob,
        )
        assert client.get("/api/join/" + code, headers=alice).json()["joined"] is True

        # 非创建者不能开始
        start_body = {
            "players": [
                {"id": "p1", "name": "阿豪", "gender": "M", "level": 3},
                {"id": "p2", "name": "小林", "gender": "F", "level": 2},
            ],
            "matches": [
                {
                    "id": "m1",
                    "round": 1,
                    "court": 1,
                    "side1": ["p1"],
                    "side2": ["p2"],
                    "scores": [],
                    "scoreAll": None,
                    "status": "pending",
                }
            ],
        }
        assert client.post("/api/races/flow_race/start", json=start_body, headers=alice).status_code == 403

        # 创建者开始比赛
        started = client.post("/api/races/flow_race/start", json=start_body, headers=admin)
        assert started.status_code == 200, started.text
        assert started.json()["status"] == "playing"

        # 开始后不能再报名
        late = client.post(
            "/api/races/flow_race/join", json={"name": "路人"}, headers=bob
        )
        assert late.status_code == 409

        # 记分（仅创建者）
        match = {
            "id": "m1",
            "round": 1,
            "court": 1,
            "side1": ["p1"],
            "side2": ["p2"],
            "scores": [[21, 12], [21, 15]],
            "scoreAll": [2, 0],
            "status": "done",
        }
        assert client.put(
            "/api/races/flow_race/matches/m1", json=match, headers=alice
        ).status_code == 403
        assert client.put(
            "/api/races/flow_race/matches/m1", json=match, headers=admin
        ).status_code == 200

        # 队员轮询实时比分
        live = client.get("/api/races/flow_race/live", params={"since": 0}, headers=bob)
        assert live.status_code == 200
        assert live.json()["changed"] is True
        assert live.json()["race"]["matches"][0]["scoreAll"] == [2, 0]

        # 无变化时不返回整份文档
        stamp = live.json()["updatedAt"]
        same = client.get("/api/races/flow_race/live", params={"since": stamp}, headers=bob)
        assert same.json()["changed"] is False
        assert same.json()["race"] is None

        # 结束并汇总
        summary = client.post("/api/races/flow_race/finish", headers=admin)
        assert summary.status_code == 200, summary.text
        body = summary.json()
        assert body["race"]["status"] == "done"
        assert body["ranking"]["rows"][0]["name"] == "阿豪"
        assert body["ranking"]["rows"][0]["point"] == 2
        assert body["finishedAt"]

        # 队员也能看到汇总
        member_view = client.get("/api/races/flow_race/summary", headers=bob)
        assert member_view.status_code == 200
        assert member_view.json()["ranking"]["rows"][0]["name"] == "阿豪"


def test_join_guards():
    with TestClient(app) as client:
        admin = login(client, "admin-2")
        guest = login(client, "guest-2")

        payload = base_race("guard_race")
        client.post("/api/races", json=payload, headers=admin)

        # 未开放报名
        blocked = client.post("/api/races/guard_race/join", json={"name": "甲"}, headers=guest)
        assert blocked.status_code == 409

        # 无效链接
        assert client.get("/api/join/NOPE00", headers=guest).status_code == 404

        # 满员
        client.post("/api/races/guard_race/open", json={"maxPlayers": 1}, headers=admin)
        assert client.post(
            "/api/races/guard_race/join", json={"name": "乙"}, headers=guest
        ).status_code == 200
        third = login(client, "third-2")
        full = client.post("/api/races/guard_race/join", json={"name": "丙"}, headers=third)
        assert full.status_code == 409
        assert "满" in full.json()["detail"]
