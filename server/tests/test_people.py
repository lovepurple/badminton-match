"""人员统计（后台）与档案接口测试。"""

from fastapi.testclient import TestClient

from app.main import app


def login(client, device):
    res = client.post("/api/auth/login", json={"deviceId": device})
    return {"Authorization": "Bearer " + res.json()["token"]}


def race_payload(race_id):
    return {
        "id": race_id,
        "name": "统计赛" + race_id,
        "mode": "singlesRound",
        "group": "singles",
        "rounds": 3,
        "balls": 21,
        "players": [],
        "teams": [],
        "matches": [],
    }


def test_profile_save_and_avatar_limit():
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        # 保存昵称 + 头像
        res = client.put(
            "/api/me", json={"nickname": "小豪", "avatar": "data:image/png;base64,AAAA"}, headers=admin
        )
        assert res.status_code == 200
        body = res.json()
        assert body["nickname"] == "小豪"
        assert body["avatar"] == "data:image/png;base64,AAAA"

        # 头像超限
        big = "x" * 320 * 1024
        res = client.put("/api/me", json={"avatar": big}, headers=admin)
        assert res.status_code == 400


def test_people_stats_only_started_races():
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        member = login(client, "person-m1")  # user_id = dev_person-m1

        # 未开始的报名（draft/open）只算 signups
        r1 = race_payload("pp_open_1")
        client.post("/api/races", json=r1, headers=admin)
        client.post("/api/races/pp_open_1/open", headers=admin)
        client.post(
            "/api/races/pp_open_1/join",
            json={"name": "甲", "gender": "M", "level": 3},
            headers=member,
        )

        # 开始的比赛：报名 → open → 用报名名单 start → playing
        r2 = race_payload("pp_start_2")
        client.post("/api/races", json=r2, headers=admin)
        assert client.post("/api/races/pp_start_2/open", headers=admin).status_code == 200
        client.post(
            "/api/races/pp_start_2/join",
            json={"name": "甲", "gender": "M", "level": 3},
            headers=member,
        )
        member2 = login(client, "person-m2")
        client.post(
            "/api/races/pp_open_1/join",
            json={"name": "乙", "gender": "M", "level": 2},
            headers=member2,
        )
        client.post(
            "/api/races/pp_start_2/join",
            json={"name": "乙", "gender": "M", "level": 2},
            headers=member2,
        )
        start = {
            "players": [
                {"id": "dev_person-m1", "name": "甲", "gender": "M", "level": 3},
                {"id": "dev_person-m2", "name": "乙", "gender": "M", "level": 2},
            ],
            "matches": [
                {
                    "id": "pp2_m1",
                    "round": 1,
                    "court": 1,
                    "side1": ["dev_person-m1"],
                    "side2": ["dev_person-m2"],
                    "scores": [[21, 10], [21, 12]],
                    "scoreAll": [2, 0],
                    "status": "done",
                }
            ],
        }
        client.post("/api/races/pp_start_2/start", json=start, headers=admin)

        # 乙也报名过 r1（凑 signups）
        member2 = login(client, "person-m2")  # user_id = dev_person-m2
        client.post(
            "/api/races/person_open_1/join",
            json={"name": "乙", "gender": "M", "level": 2},
            headers=member2,
        )

        people = client.get("/api/people", headers=admin).json()["people"]
        # 只过滤出本用例的两个用户，其余用例的数据不影响断言
        by_name = {
            p["name"]: p
            for p in people
            if p["id"] in ("dev_person-m1", "dev_person-m2")
        }
        assert "甲" in by_name and "乙" in by_name

        a = by_name["甲"]
        assert a["signups"] == 2  # open_1 + start_2 各报一次
        assert a["alls"] == 1  # 实际开赛才算
        assert a["wins"] == 1
        assert a["point"] == 2
        assert a["races"][0]["rank"] == 1
        assert a["races"][0]["raceName"] == "统计赛pp_start_2"

        b = by_name["乙"]
        assert b["signups"] == 2
        assert b["alls"] == 1
        assert b["fail"] == 1
        assert b["races"][0]["rank"] == 2

        # 非管理员不能看
        assert client.get("/api/people", headers=member).status_code == 403
