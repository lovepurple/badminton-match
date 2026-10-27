"""接口端到端测试：登录 → 建比赛 → 记分 → 排名 → 战绩 → 删除。"""

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def race_payload(race_id="race_1"):
    return {
        "id": race_id,
        "name": "周六八人转",
        "mode": "eight",
        "group": "doubles",
        "rounds": 3,
        "balls": 21,
        "wheelMode": "isolate",
        "partnerMode": "random",
        "rankMode": "pointFirst",
        "players": [
            {"id": "p0", "name": "阿豪", "gender": "M", "level": 3},
            {"id": "p1", "name": "小林", "gender": "F", "level": 2},
            {"id": "p2", "name": "老王", "gender": "M", "level": 4},
            {"id": "p3", "name": "阿杰", "gender": "M", "level": 1},
        ],
        "teams": [],
        "matches": [
            {
                "id": "m1",
                "round": 1,
                "court": 1,
                "side1": ["p0", "p1"],
                "side2": ["p2", "p3"],
                "scores": [],
                "scoreAll": None,
                "status": "pending",
            }
        ],
    }


def auth_headers(client, device="device-a"):
    res = client.post("/api/auth/login", json={"deviceId": device})
    assert res.status_code == 200, res.text
    return {"Authorization": "Bearer " + res.json()["token"]}


def test_health():
    with TestClient(app) as client:
        res = client.get("/api/health")
        assert res.status_code == 200
        assert res.json()["ok"] is True


def test_login_and_race_flow():
    with TestClient(app) as client:
        headers = auth_headers(client)

        created = client.post("/api/races", json=race_payload(), headers=headers)
        assert created.status_code == 200, created.text
        assert created.json()["name"] == "周六八人转"

        listed = client.get("/api/races", headers=headers).json()["races"]
        assert len(listed) == 1
        assert listed[0]["players"] == 4
        assert listed[0]["matches"] == 1

        fetched = client.get("/api/races/race_1", headers=headers)
        assert fetched.status_code == 200
        assert fetched.json()["mode"] == "eight"

        match = {
            "id": "m1",
            "round": 1,
            "court": 1,
            "side1": ["p0", "p1"],
            "side2": ["p2", "p3"],
            "scores": [[21, 15], [21, 18]],
            "scoreAll": [2, 0],
            "status": "done",
        }
        updated = client.put("/api/races/race_1/matches/m1", json=match, headers=headers)
        assert updated.status_code == 200, updated.text
        assert updated.json()["matches"][0]["scoreAll"] == [2, 0]

        rank = client.get("/api/races/race_1/rank", headers=headers).json()
        assert rank["kind"] == "player"
        assert rank["rows"][0]["name"] == "阿豪"
        assert rank["rows"][0]["point"] == 2

        stats = client.get("/api/stats", params={"name": "阿豪"}, headers=headers).json()
        assert stats["total"]["alls"] == 1
        assert stats["total"]["wins"] == 1

        deleted = client.delete("/api/races/race_1", headers=headers)
        assert deleted.status_code == 200
        assert client.get("/api/races", headers=headers).json()["races"] == []


def test_requires_auth():
    with TestClient(app) as client:
        assert client.get("/api/races").status_code == 401
        assert client.get("/api/races", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_owner_only_write():
    with TestClient(app) as client:
        owner = auth_headers(client, "device-owner")
        other = auth_headers(client, "device-other")
        client.post("/api/races", json=race_payload("race_2"), headers=owner)

        # 他人可读，不可写
        assert client.get("/api/races/race_2", headers=other).status_code == 200
        assert client.put("/api/races/race_2", json=race_payload("race_2"), headers=other).status_code == 403
        assert client.delete("/api/races/race_2", headers=other).status_code == 404

        # 创建者可以改
        payload = race_payload("race_2")
        payload["name"] = "改名了"
        assert client.put("/api/races/race_2", json=payload, headers=owner).status_code == 200
        assert client.get("/api/races/race_2", headers=owner).json()["name"] == "改名了"
