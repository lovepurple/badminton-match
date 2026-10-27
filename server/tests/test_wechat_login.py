"""微信网页授权登录链路（不触网：exchange 由 monkeypatch 替换）。"""

from urllib.parse import parse_qs, urlparse

import app.main as main
from fastapi.testclient import TestClient


def test_start_requires_config(monkeypatch):
    monkeypatch.setattr(main, "WECHAT_APPID", "")
    monkeypatch.setattr(main, "WECHAT_SECRET", "")
    monkeypatch.setattr(main, "OAUTH_CALLBACK", "")
    with TestClient(main.app) as client:
        res = client.get("/api/auth/wechat/start", follow_redirects=False)
        assert res.status_code == 400
        assert "未配置" in res.json()["detail"]


def test_oauth_flow_returns_token_and_restores_hash(monkeypatch):
    monkeypatch.setattr(main, "WECHAT_APPID", "wx_test_appid")
    monkeypatch.setattr(main, "WECHAT_SECRET", "wx_test_secret")
    monkeypatch.setattr(main, "OAUTH_CALLBACK", "https://example.com/api/auth/wechat/callback")
    monkeypatch.setattr(main, "_oauth_openid", lambda code: "openid_demo_1")

    with TestClient(main.app) as client:
        # 1. 跳转授权页
        target = "/h5/%23/join/ABC123"
        res = client.get("/api/auth/wechat/start?redirect=" + target, follow_redirects=False)
        assert res.status_code in (302, 307), res.text
        location = res.headers["location"]
        assert location.startswith("https://open.weixin.qq.com/connect/oauth2/authorize?")
        assert location.endswith("#wechat_redirect")

        query = parse_qs(urlparse(location).query)
        assert query["appid"] == ["wx_test_appid"]
        assert query["scope"] == ["snsapi_base"]
        assert query["redirect_uri"] == ["https://example.com/api/auth/wechat/callback"]
        state = query["state"][0]

        # 2. 微信回调 → 带 token 回到原页面（hash 保留）
        cb = client.get(
            "/api/auth/wechat/callback?code=CODE123&state=" + state, follow_redirects=False
        )
        assert cb.status_code in (302, 307), cb.text
        back = cb.headers["location"]
        assert back.startswith("/h5/?token=")
        assert back.endswith("#/join/ABC123")

        token = parse_qs(urlparse(back).query)["token"][0]

        # 3. token 可用，用户是微信身份
        me = client.get("/api/me", headers={"Authorization": "Bearer " + token}).json()
        assert me["id"] == "wx_openid_demo_1"
        assert me["role"] in ("admin", "user")

        # 4. 同一个 state 不能复用
        again = client.get(
            "/api/auth/wechat/callback?code=CODE123&state=" + state, follow_redirects=False
        )
        assert again.status_code == 400


def test_callback_rejects_unknown_state(monkeypatch):
    monkeypatch.setattr(main, "WECHAT_APPID", "wx_test_appid")
    monkeypatch.setattr(main, "WECHAT_SECRET", "wx_test_secret")
    with TestClient(main.app) as client:
        res = client.get("/api/auth/wechat/callback?code=X&state=nope", follow_redirects=False)
        assert res.status_code == 400
        assert "失效" in res.json()["detail"]


def test_callback_rejects_expired_state(monkeypatch):
    monkeypatch.setattr(main, "WECHAT_APPID", "wx_test_appid")
    monkeypatch.setattr(main, "WECHAT_SECRET", "wx_test_secret")
    monkeypatch.setattr(main, "_oauth_openid", lambda code: "openid_demo_2")
    with TestClient(main.app) as client:
        main.OAUTH_STATES["old_state"] = ("/h5/", 0)  # 1970 年，必然超时
        res = client.get("/api/auth/wechat/callback?code=X&state=old_state", follow_redirects=False)
        assert res.status_code == 400
        assert "超时" in res.json()["detail"]


def test_health_reports_wechat_features(monkeypatch):
    monkeypatch.setattr(main, "WECHAT_APPID", "wx_test_appid")
    monkeypatch.setattr(main, "WECHAT_SECRET", "wx_test_secret")
    monkeypatch.setattr(main, "OAUTH_CALLBACK", "https://example.com/cb")
    with TestClient(main.app) as client:
        features = client.get("/api/health").json()["features"]
        assert features["wechatOAuth"] is True
        assert features["wechatJssdk"] is True

    monkeypatch.setattr(main, "WECHAT_APPID", "")
    with TestClient(main.app) as client:
        features = client.get("/api/health").json()["features"]
        assert features["wechatOAuth"] is False
        assert features["wechatJssdk"] is False
