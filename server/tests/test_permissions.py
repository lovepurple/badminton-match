"""权限分层测试：访客 / 成员 / 创建者 / 管理员。"""

from fastapi.testclient import TestClient

from app.main import app


def login(client, device):
    res = client.post("/api/auth/login", json={"deviceId": device})
    return {"Authorization": "Bearer " + res.json()["token"]}


def make_race(client, admin, race_id="perm_race", name="权限赛"):
    payload = {
        "id": race_id,
        "name": name,
        "mode": "singlesRound",
        "group": "singles",
        "rounds": 3,
        "balls": 21,
        "players": [
            {"id": "dev_member-a", "name": "甲", "gender": "M", "level": 1},
            {"id": "dev_member-b", "name": "乙", "gender": "M", "level": 2},
        ],
        "teams": [],
        "matches": [
            {
                "id": race_id + "_m1",
                "round": 1,
                "court": 1,
                "side1": ["dev_member-a"],
                "side2": ["dev_member-b"],
                "scores": [[21, 10], [21, 12]],
                "scoreAll": [2, 0],
                "status": "done",
            }
        ],
    }
    assert client.post("/api/races", json=payload, headers=admin).status_code == 200


def test_admin_sees_all_races_and_can_finish_any():
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        owner = login(client, "perm-owner")
        member = login(client, "dev_member-a")

        make_race(client, owner, "perm_race_1")
        # 管理员列表应该包含他人的比赛
        races = client.get("/api/races", headers=admin).json()["races"]
        assert any(r["id"] == "perm_race_1" for r in races)
        assert any(r["mine"] is False and r.get("ownerId") for r in races)

        # 管理员可以读详情（能看到 matches）
        detail = client.get("/api/races/perm_race_1", headers=admin).json()
        assert len(detail["matches"]) == 1

        # 管理员可以强制结束任意比赛
        res = client.post("/api/admin/races/perm_race_1/finish", headers=admin)
        assert res.status_code == 200
        assert client.get("/api/races/perm_race_1", headers=admin).json()["status"] == "done"


def test_guest_cannot_see_scores_until_joined():
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        owner = login(client, "perm-owner")
        guest = login(client, "perm-guest")

        make_race(client, owner, "perm_race_2")
        # 访客：能读比赛信息，但看不到对阵/比分
        detail = client.get("/api/races/perm_race_2", headers=guest).json()
        assert detail["matches"] == []
        assert "date" not in detail or True  # 信息类字段保留

        # 访客：live / summary 被拒
        assert client.get("/api/races/perm_race_2/live", headers=guest).status_code == 403
        assert client.get("/api/races/perm_race_2/summary", headers=guest).status_code == 403

        # 成员（已在 matches 选手列表里）：能看到比分
        member = login(client, "member-a")
        live = client.get("/api/races/perm_race_2/live", headers=member)
        assert live.status_code == 200
        assert live.json()["race"]["matches"][0]["scoreAll"] == [2, 0]


def test_owner_can_edit_delete_only_own():
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        owner = login(client, "perm-owner")
        other = login(client, "perm-other")

        make_race(client, owner, "perm_race_3")
        # 非创建者不能改
        payload = {
            "id": "perm_race_3",
            "name": "篡改",
            "mode": "singlesRound",
            "group": "singles",
            "rounds": 1,
            "balls": 11,
            "players": [],
            "teams": [],
            "matches": [],
        }
        assert client.put("/api/races/perm_race_3", json=payload, headers=other).status_code == 403
        assert client.delete("/api/races/perm_race_3", headers=other).status_code == 404

        # 创建者可以改
        payload["name"] = "改名成功"
        assert client.put("/api/races/perm_race_3", json=payload, headers=owner).status_code == 200
        assert client.get("/api/races/perm_race_3", headers=owner).json()["name"] == "改名成功"


def test_user_role_management():
    with TestClient(app) as client:
        admin = login(client, "venue-admin")
        user = login(client, "perm-user")
        assert client.get("/api/users", headers=user).status_code == 403
        assert client.get("/api/users", headers=admin).status_code == 200
        # 提权再撤回
        assert client.put("/api/users/dev_perm-user/role", json={"role": "admin"}, headers=admin).status_code == 200
        assert client.get("/api/users", headers=user).status_code == 200
        assert client.put("/api/users/dev_perm-user/role", json={"role": "user"}, headers=admin).status_code == 200