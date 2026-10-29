"""候补 / 取消 / 模板 / 记分撤销 相关测试。"""

from fastapi.testclient import TestClient

from app.main import app


def login(client, device):
    res = client.post("/api/auth/login", json={"deviceId": device})
    return {"Authorization": "Bearer " + res.json()["token"]}


def race(client, admin, rid="wl_race", max_players=1):
    payload = {
        "id": rid,
        "name": "候补测试",
        "mode": "singlesRound",
        "group": "singles",
        "rounds": 1,
        "balls": 11,
        "players": [],
        "teams": [],
        "matches": [],
    }
    assert client.post("/api/races", json=payload, headers=admin).status_code == 200
    opened = client.post(f"/api/races/{rid}/open", json={"maxPlayers": max_players}, headers=admin)
    assert opened.status_code == 200
    return opened.json()


def test_waitlist_overflow_and_promotion():
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        a = login(client, "wl-a")
        b = login(client, "wl-b")
        race(client, admin, "wl_race_1", max_players=1)

        assert client.post("/api/races/wl_race_1/join", json={"name": "甲"}, headers=a).status_code == 200
        # 满员再报名 → 409
        full = client.post("/api/races/wl_race_1/join", json={"name": "乙"}, headers=b)
        assert full.status_code == 409
        assert "满" in full.json()["detail"]

        # 进候补
        wl = client.post("/api/races/wl_race_1/waitlist", json={"name": "乙"}, headers=b)
        assert wl.status_code == 200
        assert wl.json()["waitlisted"] is True
        parts = client.get("/api/races/wl_race_1/participants", headers=admin).json()["participants"]
        assert [p["name"] for p in parts if not p["waitlisted"]] == ["甲"]
        assert [p["name"] for p in parts if p["waitlisted"]] == ["乙"]

        # 甲退出 → 乙自动递补
        left = client.delete("/api/races/wl_race_1/join", headers=a)
        assert left.status_code == 200
        assert left.json()["promoted"] == "dev_wl-b"
        parts = client.get("/api/races/wl_race_1/participants", headers=admin).json()["participants"]
        assert [p["name"] for p in parts if not p["waitlisted"]] == ["乙"]


def test_owner_kick_promotes_waitlist():
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        a = login(client, "kick-a")
        b = login(client, "kick-b")
        race(client, admin, "wl_race_2", max_players=1)
        client.post("/api/races/wl_race_2/join", json={"name": "甲"}, headers=a)
        client.post("/api/races/wl_race_2/waitlist", json={"name": "乙"}, headers=b)

        # 非创建者不能移除
        assert client.delete("/api/races/wl_race_2/participants/dev_kick-a", headers=b).status_code == 403
        # 创建者移除 → 递补
        res = client.delete("/api/races/wl_race_2/participants/dev_kick-a", headers=admin)
        assert res.status_code == 200
        assert res.json()["promoted"] == "dev_kick-b"


def test_cancel_race():
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        other = login(client, "cancel-other")
        race(client, admin, "cancel_race_1", max_players=8)

        assert client.post("/api/races/cancel_race_1/cancel", headers=other).status_code == 403
        assert client.post("/api/races/cancel_race_1/cancel", headers=admin).status_code == 200
        doc = client.get("/api/races/cancel_race_1", headers=admin).json()
        assert doc["status"] == "cancel"

        # 取消后不能再报名
        assert client.post(
            "/api/races/cancel_race_1/join", json={"name": "丙"}, headers=other
        ).status_code == 409


def test_presets_crud():
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        data = {
            "mode": "eight",
            "rounds": 3,
            "balls": 21,
            "courts": 2,
            "signup": True,
            "name": "周五八人转",
        }
        created = client.post("/api/presets", json={"name": "周五八人转", "data": data}, headers=admin)
        assert created.status_code == 200
        preset_id = created.json()["id"]
        assert preset_id.startswith("p_")

        listed = client.get("/api/presets", headers=admin).json()["presets"]
        assert any(p["id"] == preset_id and p["courts"] == 2 for p in listed)

        assert client.delete("/api/presets/" + preset_id, headers=admin).status_code == 200
        assert not any(
            p["id"] == preset_id for p in client.get("/api/presets", headers=admin).json()["presets"]
        )


def test_signup_deadline_blocks_joining():
    from datetime import datetime, timedelta
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        late = login(client, "dl-late")
        race(client, admin, "dl_race", max_players=8)
        past = (datetime.now() - timedelta(minutes=5)).replace(microsecond=0).isoformat()
        client.post(
            "/api/races/dl_race/open",
            json={"maxPlayers": 8, "deadline": past},
            headers=admin,
        )
        res = client.post("/api/races/dl_race/join", json={"name": "路人"}, headers=late)
        assert res.status_code == 409
        assert "截止" in res.json()["detail"]


def test_acquaintances_from_joined_races():
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        me = login(client, "aq-me")
        friend = login(client, "aq-friend")
        race(client, admin, "aq_race", max_players=8)
        client.post("/api/races/aq_race/join", json={"name": "我"}, headers=me)
        client.post("/api/races/aq_race/join", json={"name": "老友", "gender": "M", "level": 5}, headers=friend)

        people = client.get("/api/acquaintances", headers=me).json()["people"]
        hit = [p for p in people if p["id"] == "dev_aq-friend"]
        assert hit and hit[0]["name"] == "老友" and hit[0]["level"] == 5

        # 反向：只有一方报名不会出现
        alone = login(client, "aq-alone")
        race(client, admin, "aq_race2", max_players=8)
        client.post("/api/races/aq_race2/join", json={"name": "独行"}, headers=alone)
        people2 = client.get("/api/acquaintances", headers=me).json()["people"]
        assert not any(p["id"] == "dev_aq-alone" for p in people2)


def test_reopen_done_race():
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        owner = login(client, "reopen-owner")
        payload = {
            "id": "reopen_race",
            "name": "重开测试",
            "mode": "singlesRound",
            "group": "singles",
            "rounds": 3,
            "balls": 21,
            "players": [],
            "teams": [],
            "matches": [],
        }
        client.post("/api/races", json=payload, headers=owner)
        client.post("/api/races/reopen_race/open", headers=owner)
        start = {
            "players": [
                {"id": "dev_reopen-a", "name": "甲", "gender": "M", "level": 1},
                {"id": "dev_reopen-b", "name": "乙", "gender": "M", "level": 2},
            ],
            "matches": [
                {
                    "id": "reopen_m1",
                    "round": 1,
                    "court": 1,
                    "side1": ["dev_reopen-a"],
                    "side2": ["dev_reopen-b"],
                    "scores": [[21, 10]],
                    "scoreAll": [1, 0],
                    "status": "done",
                }
            ],
        }
        client.post("/api/races/reopen_race/start", json=start, headers=owner)
        client.post("/api/races/reopen_race/finish", headers=owner)
        assert client.post("/api/races/reopen_race/reopen", headers=owner).status_code == 200
        assert client.get("/api/races/reopen_race", headers=owner).json()["status"] == "playing"
        # 管理员也允许（重开是纠错通道）；而非创建者普通用户被拒


def test_stats_mine_survives_nickname_change():
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        me = login(client, "st-me-identity")
        rival = login(client, "st-rival")
        race(client, admin, "st_race", max_players=8)
        client.post("/api/races/st_race/join", json={"name": "老张"}, headers=me)
        client.post("/api/races/st_race/join", json={"name": "小李"}, headers=rival)

        start = {
            "players": [
                {"id": "dev_st-me-identity", "name": "老张", "gender": "M", "level": 3},
                {"id": "dev_st-rival", "name": "小李", "gender": "M", "level": 4},
            ],
            "matches": [
                {
                    "id": "st_m1",
                    "round": 1,
                    "court": 1,
                    "side1": ["dev_st-me-identity"],
                    "side2": ["dev_st-rival"],
                    "scores": [[21, 15]],
                    "scoreAll": [1, 0],
                    "status": "done",
                }
            ],
        }
        client.post("/api/races/st_race/start", json=start, headers=admin)

        before = client.get("/api/stats?mine=true", headers=me).json()
        assert before["total"]["wins"] == 1

        # 改昵称后按身份仍能查到历史战绩
        client.put("/api/me", json={"nickname": "改名了"}, headers=me)
        after = client.get("/api/stats?mine=true", headers=me).json()
        assert after["total"]["wins"] == 1 and after["total"]["alls"] == 1

        # 按名字查别人也仍然可用
        other = client.get("/api/stats?name=小李", headers=me).json()
        assert other["total"]["alls"] == 1
