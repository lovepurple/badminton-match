"""玩法覆写接口：管理员改展示/默认值/开关，普通用户只读。"""

from fastapi.testclient import TestClient

from app.main import app


def login(client, device):
    res = client.post("/api/auth/login", json={"deviceId": device})
    return {"Authorization": "Bearer " + res.json()["token"]}


def test_admin_can_override_play_display_and_defaults():
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        guest = login(client, "format-guest")

        assert client.get("/api/formats", headers=admin).json() == {"overrides": {}}

        payload = {
            "enabled": True,
            "name": "八人转（周末版）",
            "intro": "8 人固定轮转",
            "defaults": {"rounds": 3, "balls": 15, "rankMode": "winsFirst"},
            "rules": {
                "people": "8 人",
                "how": "每人与其他人各搭档一次",
                "groups": "轮转法",
                "end": "打满 7 轮",
                "score": "三局两胜，每局 15 分",
            },
            "note": "群里常用",
        }
        put = client.put("/api/formats/eight", json=payload, headers=admin)
        assert put.status_code == 200, put.text
        assert put.json()["name"] == "八人转（周末版）"

        overrides = client.get("/api/formats", headers=admin).json()["overrides"]
        assert overrides["eight"]["defaults"]["balls"] == 15
        assert overrides["eight"]["rules"]["end"] == "打满 7 轮"

        # 普通用户可以读，不能改
        assert client.get("/api/formats", headers=guest).status_code == 200
        assert client.put("/api/formats/eight", json=payload, headers=guest).status_code == 403
        assert client.delete("/api/formats/eight", headers=guest).status_code == 403

        # 停用
        payload["enabled"] = False
        client.put("/api/formats/eight", json=payload, headers=admin)
        assert client.get("/api/formats", headers=admin).json()["overrides"]["eight"]["enabled"] is False

        # 恢复默认
        assert client.delete("/api/formats/eight", headers=admin).status_code == 200
        assert client.get("/api/formats", headers=admin).json()["overrides"] == {}


def test_race_keeps_play_snapshot():
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        payload = {
            "id": "play_snapshot_race",
            "name": "玩法快照",
            "mode": "eight",
            "group": "doubles",
            "rounds": 3,
            "balls": 21,
            "playName": "八人转 / 超八转",
            "playRules": {
                "people": "4 - 50 人",
                "how": "轮换搭档",
                "groups": "轮转法",
                "end": "打完全部轮次",
                "score": "三局两胜 21 分",
            },
            "players": [],
            "teams": [],
            "matches": [],
        }
        assert client.post("/api/races", json=payload, headers=admin).status_code == 200
        doc = client.get("/api/races/play_snapshot_race", headers=admin).json()
        assert doc["playName"] == "八人转 / 超八转"
        assert doc["playRules"]["end"] == "打完全部轮次"
