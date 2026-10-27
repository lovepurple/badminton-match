"""场馆维护与管理员权限。"""

from fastapi.testclient import TestClient

from app.main import app


def login(client, device):
    res = client.post("/api/auth/login", json={"deviceId": device})
    return res.json(), {"Authorization": "Bearer " + res.json()["token"]}


def test_admin_can_manage_venues():
    with TestClient(app) as client:
        _, admin = login(client, "venue-admin")
        assert client.get("/api/me", headers=admin).json()["role"] == "admin"

        created = client.post(
            "/api/venues",
            json={
                "name": "城东体育馆",
                "address": "杭州市江干区体育场路 1 号",
                "lat": 30.2741,
                "lng": 120.1551,
            },
            headers=admin,
        )
        assert created.status_code == 200, created.text
        venue = created.json()
        assert venue["id"].startswith("v_")
        assert venue["coordType"] == "gcj02"

        listed = client.get("/api/venues", headers=admin).json()["venues"]
        names = [v["name"] for v in listed]
        assert "城东体育馆" in names
        # 默认场馆（超级鹰 268 店）在空库时自动种入
        assert any("超级鹰" in n for n in names)

        updated = client.put(
            "/api/venues/" + venue["id"],
            json={"name": "城东体育馆（新馆）", "address": "新地址", "lat": 30.28, "lng": 120.16},
            headers=admin,
        )
        assert updated.status_code == 200
        assert updated.json()["name"] == "城东体育馆（新馆）"


def test_regular_user_cannot_manage_venues():
    with TestClient(app) as client:
        login(client, "venue-admin")
        _, guest = login(client, "venue-guest")
        assert client.get("/api/me", headers=guest).json()["role"] == "user"

        denied = client.post("/api/venues", json={"name": "偷建场馆"}, headers=guest)
        assert denied.status_code == 403

        # 普通用户仍可读取场馆列表（创建比赛时选择用）
        assert client.get("/api/venues", headers=guest).status_code == 200

        listed = client.get("/api/venues", headers=guest).json()["venues"]
        venue_id = listed[0]["id"]
        assert client.put(
            "/api/venues/" + venue_id, json={"name": "改名"}, headers=guest
        ).status_code == 403
        assert client.delete("/api/venues/" + venue_id, headers=guest).status_code == 403


def test_race_keeps_date_and_venue_snapshot():
    with TestClient(app) as client:
        _, admin = login(client, "venue-admin")
        venue = client.get("/api/venues", headers=admin).json()["venues"][0]

        payload = {
            "id": "venue_race",
            "name": "周末局",
            "mode": "eight",
            "group": "doubles",
            "rounds": 3,
            "balls": 21,
            "date": "2026-11-01T19:00",
            "venueId": venue["id"],
            "venue": {
                "name": venue["name"],
                "address": venue["address"],
                "lat": venue["lat"],
                "lng": venue["lng"],
                "coordType": "gcj02",
            },
            "players": [],
            "teams": [],
            "matches": [],
        }
        assert client.post("/api/races", json=payload, headers=admin).status_code == 200

        doc = client.get("/api/races/venue_race", headers=admin).json()
        assert doc["date"] == "2026-11-01T19:00"
        assert doc["venueId"] == venue["id"]
        assert doc["venue"]["name"] == venue["name"]
        assert doc["venue"]["lat"] == venue["lat"]

        # 报名页信息也带日期与场馆
        client.post("/api/races/venue_race/open", json={"maxPlayers": 8}, headers=admin)
        code = client.get("/api/races/venue_race", headers=admin).json()["joinCode"]
        info = client.get("/api/join/" + code, headers=admin).json()
        assert info["race"]["date"] == "2026-11-01T19:00"
        assert info["race"]["venue"]["address"] == venue["address"]
