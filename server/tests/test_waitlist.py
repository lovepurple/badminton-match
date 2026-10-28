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
