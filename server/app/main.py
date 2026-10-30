"""猩球 · 羽球局 服务端：比赛文档、记分提交、排名与战绩。

启动：
    cd server && python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

鉴权：Authorization: Bearer <token>（POST /api/auth/login 获取）。
小程序端在 utils/config.js 里把 apiBase 指向本服务即可。
"""

import hashlib
import json
import os
import secrets
import time
import urllib.parse
import urllib.request
import uuid
from contextlib import asynccontextmanager

from pathlib import Path

# 可选：从 server/.env 读取配置（没装 python-dotenv 也能跑，只用系统环境变量）
try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
except Exception:  # pragma: no cover - 仅影响便捷性
    pass

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from . import amap, db, rules

WECHAT_APPID = os.environ.get("GORILLA_WECHAT_APPID", "")
WECHAT_SECRET = os.environ.get("GORILLA_WECHAT_SECRET", "")
OAUTH_CALLBACK = os.environ.get("GORILLA_OAUTH_CALLBACK", "")
PUBLIC_BASE = os.environ.get("GORILLA_PUBLIC_BASE", "")
ADMIN_DEVICES = {d.strip() for d in os.environ.get("GORILLA_ADMIN_DEVICES", "").split(",") if d.strip()}
ADMIN_CODE = os.environ.get("GORILLA_ADMIN_CODE", "")

# 网页授权 state -> 回跳地址（单进程内存，重启失效；生产可换 Redis）
OAUTH_STATES: dict[str, tuple[str, int]] = {}

@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init()
    yield


app = FastAPI(title="猩球 · 羽球局 API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------- 模型

class LoginIn(BaseModel):
    deviceId: str | None = None
    nickname: str | None = None
    avatar: str | None = None


class Player(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    name: str
    gender: str = "M"
    level: int = 0


class Team(BaseModel):
    model_config = ConfigDict(extra="allow")
    name: str
    players: list[str] = Field(default_factory=list)


class Match(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    round: int = 1
    court: int = 1
    side1: list[str] = Field(default_factory=list)
    side2: list[str] = Field(default_factory=list)
    teamA: int | None = None
    teamB: int | None = None
    scores: list[list[int]] = Field(default_factory=list)
    scoreAll: list[int] | None = None
    status: str = "pending"
    # 乐观锁：提交校验用，来自客户端看到的比赛 rev
    rev: int | None = None


class AdminClaimIn(BaseModel):
    code: str


class VenueIn(BaseModel):
    id: str | None = None
    name: str
    address: str = ""
    lat: float | None = None
    lng: float | None = None
    coordType: str = "gcj02"
    note: str = ""


class FormatOverrideIn(BaseModel):
    enabled: bool = True
    name: str | None = None
    intro: str | None = None
    defaults: dict | None = None
    rules: dict | None = None
    note: str = ""


class ResolveIn(BaseModel):
    url: str


class PresetIn(BaseModel):
    name: str
    data: dict


class PresetIdIn(BaseModel):
    id: str


class OpenIn(BaseModel):
    maxPlayers: int = 0
    deadline: str | None = None


class JoinIn(BaseModel):
    name: str
    avatar: str | None = None
    gender: str = "M"
    level: int = 0


class StartIn(BaseModel):
    players: list[Player] = Field(default_factory=list)
    matches: list[Match] = Field(default_factory=list)


class RaceIn(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    name: str = "未命名比赛"
    mode: str
    group: str = "doubles"
    rounds: int = 3
    balls: int = 21
    wheelMode: str = "isolate"
    partnerMode: str = "random"
    rankMode: str = "pointFirst"
    matchesPerEntity: int = 3
    arenaKings: int = 1
    groupSize: int = 4
    groupsValid: int = 3
    date: str | None = None
    signupDeadline: str | None = None
    courts: int = 0
    playName: str | None = None
    playRules: dict | None = None
    venueId: str | None = None
    venue: dict | None = None
    players: list[Player] = Field(default_factory=list)
    teams: list[Team] = Field(default_factory=list)
    matches: list[Match] = Field(default_factory=list)
    createdAt: int | None = None


# ---------------------------------------------------------------- 鉴权

def _is_admin(user_id: str) -> bool:
    user = db.get_user(user_id)
    return bool(user and user.get("role") == "admin")


def current_user(authorization: str | None = Header(default=None)) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="缺少登录令牌")
    user_id = db.user_by_token(authorization[7:].strip())
    if not user_id:
        raise HTTPException(status_code=401, detail="令牌无效或已过期")
    return user_id


def require_admin(user_id: str = Depends(current_user)) -> str:
    user = db.get_user(user_id)
    if not user or user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user_id


def _participant_ids(race: dict) -> set:
    """已报名（或已是比赛选手）的用户 id 集合。"""
    return set()


def race_access(race: dict | None, user_id: str) -> tuple[str, bool]:
    """返回 (role, can_view_race)。

    role ∈ creator | participant | guest | none
    - creator：race._ownerId == user_id（或管理员）
    - participant：报过名（participants 表）或在对阵选手里
    - guest：其他登录用户（能看比赛信息，但看不到比分/对阵）
    - none：比赛不存在/已删除
    """
    if not race:
        return ("none", False)
    if user_id == race.get("_ownerId"):
        return ("creator", True)
    parts = db.list_participants(race["id"])
    if any(p["user_id"] == user_id for p in parts):
        return ("participant", True)
    for m in race.get("matches") or []:
        if user_id in (m.get("side1") or []) or user_id in (m.get("side2") or []):
            return ("participant", True)
    return ("guest", False)


def can_view_scores(race: dict | None, user_id: str) -> bool:
    """是否能看到对阵/比分：creator 或 participant。"""
    role, _ = race_access(race, user_id)
    return role in ("creator", "participant")


def _assign_role(user_id: str, device_id: str | None) -> None:
    if device_id and device_id in ADMIN_DEVICES:
        db.set_role(user_id, "admin")
        return
    if not db.has_admin():
        # 首次部署还没有管理员时，第一个登录的用户成为管理员
        db.set_role(user_id, "admin")


def _oauth_openid(code: str) -> str:
    """用网页授权的 code 换 openid（snsapi_base 静默授权）。"""
    if not (WECHAT_APPID and WECHAT_SECRET):
        raise HTTPException(status_code=400, detail="服务端未配置微信网页授权")
    query = urllib.parse.urlencode(
        {
            "appid": WECHAT_APPID,
            "secret": WECHAT_SECRET,
            "code": code,
            "grant_type": "authorization_code",
        }
    )
    try:
        with urllib.request.urlopen(
            "https://api.weixin.qq.com/sns/oauth2/access_token?" + query, timeout=5
        ) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=502, detail="微信授权服务不可用")
    openid = payload.get("openid")
    if not openid:
        raise HTTPException(status_code=401, detail=payload.get("errmsg") or "微信授权失败")
    return openid


def _with_token(target: str, token: str) -> str:
    """把 token 插到 hash 之前：/h5/#/join/X -> /h5/?token=..#/join/X"""
    path, _, frag = target.partition("#")
    sep = "&" if "?" in path else "?"
    url = path + sep + "token=" + token
    return url + ("#" + frag if frag else "")


# ---------------------------------------------------------------- 接口

@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "service": "gorilla-badminton",
        "version": app.version,
        "features": {
            "wechatOAuth": bool(WECHAT_APPID and WECHAT_SECRET and OAUTH_CALLBACK),
            "wechatJssdk": bool(WECHAT_APPID and WECHAT_SECRET),
            "adminCode": bool(ADMIN_CODE),
        },
    }


@app.get("/api/auth/wechat/start")
def wechat_start(redirect: str = "/h5/") -> RedirectResponse:
    """跳转到微信网页授权（需认证服务号 + 网页授权域名）。"""
    if not (WECHAT_APPID and WECHAT_SECRET and OAUTH_CALLBACK):
        raise HTTPException(status_code=400, detail="服务端未配置微信网页授权")
    target = redirect if redirect.startswith("/") else "/h5/"
    state = secrets.token_urlsafe(12)
    OAUTH_STATES[state] = (target, db.now())
    query = urllib.parse.urlencode(
        {
            "appid": WECHAT_APPID,
            "redirect_uri": OAUTH_CALLBACK,
            "response_type": "code",
            "scope": "snsapi_base",
            "state": state,
        }
    )
    return RedirectResponse("https://open.weixin.qq.com/connect/oauth2/authorize?" + query + "#wechat_redirect")


@app.get("/api/auth/wechat/callback")
def wechat_callback(code: str, state: str) -> RedirectResponse:
    entry = OAUTH_STATES.pop(state, None)
    if not entry:
        raise HTTPException(status_code=400, detail="授权状态失效，请重新进入")
    target, created = entry
    if db.now() - created > 10 * 60 * 1000:
        raise HTTPException(status_code=400, detail="授权超时，请重新进入")
    openid = _oauth_openid(code)
    user_id = "wx_" + openid
    db.upsert_user(user_id)
    token = secrets.token_urlsafe(24)
    db.create_token(token, user_id)
    return RedirectResponse(_with_token(target, token))


@app.post("/api/auth/login")
def login(body: LoginIn) -> dict:
    # 设备号登录：非微信环境，或微信授权不可用时的兜底
    user_id = "dev_" + (body.deviceId or uuid.uuid4().hex[:12])
    db.upsert_user(user_id, body.nickname, body.avatar)
    _assign_role(user_id, body.deviceId)
    token = secrets.token_urlsafe(24)
    db.create_token(token, user_id)
    user = db.get_user(user_id) or {}
    return {
        "token": token,
        "user": {"id": user_id, "nickname": body.nickname or "", "role": user.get("role", "user")},
    }


@app.post("/api/auth/admin-claim")
def claim_admin(body: AdminClaimIn, user_id: str = Depends(current_user)) -> dict:
    """输入管理员口令后把当前用户提升为管理员（内部使用免去配置 deviceId）。"""
    if not ADMIN_CODE:
        raise HTTPException(status_code=403, detail="服务端未配置管理员口令（GORILLA_ADMIN_CODE）")
    if not secrets.compare_digest(body.code.strip(), ADMIN_CODE):
        raise HTTPException(status_code=403, detail="口令错误")
    db.set_role(user_id, "admin")
    return {"role": "admin"}


@app.get("/api/me")
def me(user_id: str = Depends(current_user)) -> dict:
    user = db.get_user(user_id) or {}
    return {
        "id": user_id,
        "nickname": user.get("nickname") or "",
        "avatar": user.get("avatar"),
        "role": user.get("role", "user"),
    }


class ProfileIn(BaseModel):
    nickname: str | None = None
    avatar: str | None = None


@app.put("/api/me")
def update_me(body: ProfileIn, user_id: str = Depends(current_user)) -> dict:
    if body.avatar and len(body.avatar) > 300 * 1024:
        raise HTTPException(status_code=400, detail="头像图片过大（上限 300KB）")
    if body.nickname:
        body.nickname = body.nickname.strip()[:20] or None
    db.save_profile(user_id, body.nickname, body.avatar)
    return me(user_id)


# ---------------------------------------------------------------- 场馆

@app.get("/api/venues")
def venues(user_id: str = Depends(current_user)) -> dict:
    return {"venues": db.list_venues()}


@app.post("/api/venues/resolve")
def resolve_venue(body: ResolveIn, user_id: str = Depends(require_admin)) -> dict:
    """解析高德分享链接，返回可直接填进表单的场馆信息。"""
    info = amap.resolve(body.url.strip())
    if not info:
        raise HTTPException(status_code=400, detail="没能识别这个链接，请确认是高德 App 分享的链接")
    return info


@app.post("/api/venues")
def create_venue(body: VenueIn, user_id: str = Depends(require_admin)) -> dict:
    venue = body.model_dump()
    venue["id"] = venue.get("id") or "v_" + uuid.uuid4().hex[:10]
    return db.save_venue(venue, user_id)


@app.put("/api/venues/{venue_id}")
def update_venue(venue_id: str, body: VenueIn, user_id: str = Depends(require_admin)) -> dict:
    venue = body.model_dump()
    venue["id"] = venue_id
    return db.save_venue(venue, user_id)


@app.delete("/api/venues/{venue_id}")
def remove_venue(venue_id: str, user_id: str = Depends(require_admin)) -> dict:
    if not db.delete_venue(venue_id):
        raise HTTPException(status_code=404, detail="场馆不存在")
    return {"ok": True}


@app.get("/api/races")
def list_races(full: bool = False, user_id: str = Depends(current_user)) -> dict:
    summaries = db.list_races(user_id)
    if (_is_admin(user_id)):
        # 管理员：全量（自己 + 别人）
        all_races = db.list_races_all()
        mine = {r["id"] for r in summaries}
        for r in all_races:
            if r["id"] not in mine:
                summaries.append(
                    {
                        "id": r["id"],
                        "name": r.get("name") or "未命名比赛",
                        "mode": r.get("mode") or "",
                        "group": r.get("group") or "",
                        "rounds": r.get("rounds"),
                        "balls": r.get("balls"),
                        "players": len(r.get("players") or []),
                        "matches": len(r.get("matches") or []),
                        "updatedAt": r.get("_updatedAt"),
                        "status": r.get("status"),
                        "joinCode": r.get("joinCode"),
                        "maxPlayers": r.get("maxPlayers") or 0,
                        "mine": r.get("_ownerId") == user_id,
                        "ownerId": r.get("_ownerId"),
                        "ownerName": (db.get_user(r.get("_ownerId") or "") or {}).get("nickname")
                        or (r.get("_ownerId") or "")[:10],
                    }
                )
    if not full:
        return {"races": summaries}
    return {"races": [db.get_race(item["id"]) for item in summaries]}


@app.post("/api/races")
def create_race(race: RaceIn, user_id: str = Depends(current_user)) -> dict:
    doc = race.model_dump()
    existing = db.get_race(doc["id"])
    if existing and existing.get("_ownerId") != user_id:
        raise HTTPException(status_code=409, detail="比赛 ID 已被占用")
    doc.setdefault("createdAt", db.now())
    return db.save_race(user_id, doc)


CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _new_join_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))


def _race_for_view(race: dict) -> dict:
    """对外的比赛视图：去掉服务端内部字段。"""
    doc = {k: v for k, v in race.items() if not k.startswith("_")}
    return doc


@app.post("/api/races/{race_id}/open")
def open_signup(
    race_id: str, body: OpenIn | None = None, user_id: str = Depends(current_user)
) -> dict:
    race = db.get_race(race_id)
    if not race:
        raise HTTPException(status_code=404, detail="比赛不存在")
    if race.get("_ownerId") != user_id:
        raise HTTPException(status_code=403, detail="只有创建者可以开放报名")
    if race.get("status") in ("playing", "done"):
        raise HTTPException(status_code=409, detail="比赛已开始或已结束")
    race["joinCode"] = race.get("joinCode") or _new_join_code()
    race["status"] = "open"
    if body:
        if body.maxPlayers:
            race["maxPlayers"] = body.maxPlayers
        if body.deadline:
            race["signupDeadline"] = body.deadline
    race.setdefault("maxPlayers", 0)
    return _race_for_view(db.save_race(user_id, race))


@app.get("/api/join/{code}")
def join_info(code: str, user_id: str = Depends(current_user)) -> dict:
    race = db.get_race_by_code(code)
    if not race:
        raise HTTPException(status_code=404, detail="报名链接无效或已关闭")
    participants = db.list_participants(race["id"])
    return {
        "race": {
            "id": race["id"],
            "name": race.get("name"),
            "mode": race.get("mode"),
            "rounds": race.get("rounds"),
            "balls": race.get("balls"),
            "status": race.get("status"),
            "maxPlayers": race.get("maxPlayers") or 0,
            "signupDeadline": race.get("signupDeadline"),
            "date": race.get("date"),
            "venue": race.get("venue"),
            "venueId": race.get("venueId"),
        },
        "participants": participants,
        "joined": any(p["user_id"] == user_id for p in participants),
        "isOwner": race.get("_ownerId") == user_id,
    }


@app.delete("/api/races/{race_id}/join")
def leave_race(race_id: str, user_id: str = Depends(current_user)) -> dict:
    race = db.get_race(race_id)
    if not race:
        raise HTTPException(status_code=404, detail="比赛不存在")
    if race.get("status") == "playing":
        raise HTTPException(status_code=409, detail="比赛进行中，不能退出")
    before = {p["user_id"]: p for p in db.list_participants(race_id)}
    db.remove_participant(race_id, user_id)
    promoted = None
    if before.get(user_id) and not before[user_id]["waitlisted"]:
        promoted = db.promote_waitlist(race_id)
    return {"participants": db.list_participants(race_id), "joined": False, "promoted": promoted}


@app.post("/api/races/{race_id}/start")
def start_race(race_id: str, body: StartIn, user_id: str = Depends(current_user)) -> dict:
    race = db.get_race(race_id)
    if not race:
        raise HTTPException(status_code=404, detail="比赛不存在")
    if race.get("_ownerId") != user_id:
        raise HTTPException(status_code=403, detail="只有创建者可以开始比赛")
    if race.get("status") not in ("draft", "open"):
        raise HTTPException(status_code=409, detail="比赛已开始")
    if not body.players or not body.matches:
        raise HTTPException(status_code=400, detail="缺少选手或对阵")
    race["players"] = [p.model_dump() for p in body.players]
    # 每场对阵都要有 rev 基线，否则客户端首次记分时无法做乐观锁校验
    race["matches"] = []
    for m in body.matches:
        doc_m = m.model_dump()
        if doc_m.get("rev") is None:
            doc_m["rev"] = 0
        race["matches"].append(doc_m)
    race["status"] = "playing"
    return _race_for_view(db.save_race(user_id, race))


@app.post("/api/races/{race_id}/finish")
def finish_race(race_id: str, user_id: str = Depends(current_user)) -> dict:
    race = db.get_race(race_id)
    if not race:
        raise HTTPException(status_code=404, detail="比赛不存在")
    if race.get("_ownerId") != user_id:
        raise HTTPException(status_code=403, detail="只有创建者可以结束比赛")
    if race.get("status") != "playing":
        raise HTTPException(status_code=409, detail="比赛未在进行中")
    race["status"] = "done"
    db.save_race(user_id, race)
    return summary(race_id, user_id)


@app.get("/api/races/{race_id}/participants")
def race_participants(race_id: str, user_id: str = Depends(current_user)) -> dict:
    race = db.get_race(race_id)
    if not race:
        raise HTTPException(status_code=404, detail="比赛不存在")
    return {
        "participants": db.list_participants(race_id),
        "isOwner": race.get("_ownerId") == user_id,
        "status": race.get("status"),
        "maxPlayers": race.get("maxPlayers") or 0,
        "joinCode": race.get("joinCode"),
    }


@app.get("/api/races/{race_id}/live")
def live_race(race_id: str, since: int = 0, user_id: str = Depends(current_user)) -> dict:
    race = db.get_race(race_id)
    if not race:
        raise HTTPException(status_code=404, detail="比赛不存在")
    if not can_view_scores(race, user_id) and not _is_admin(user_id):
        raise HTTPException(status_code=403, detail="报名后才能查看实时比分")
    updated = race.get("_updatedAt") or 0
    return {
        "changed": updated > since,
        "updatedAt": updated,
        "status": race.get("status"),
        "race": _to_view(race, user_id) if updated > since else None,
    }


@app.get("/api/races/{race_id}/summary")
def summary(race_id: str, user_id: str = Depends(current_user)) -> dict:
    race = db.get_race(race_id)
    if not race:
        raise HTTPException(status_code=404, detail="比赛不存在")
    if not can_view_scores(race, user_id) and not _is_admin(user_id):
        raise HTTPException(status_code=403, detail="报名后才能查看汇总")
    result = rules.compute(race)
    return {
        "race": {
            "id": race["id"],
            "name": race.get("name"),
            "mode": race.get("mode"),
            "rounds": race.get("rounds"),
            "balls": race.get("balls"),
            "status": race.get("status"),
        },
        "ranking": result,
        "matches": race.get("matches") or [],
        "finishedAt": race.get("_updatedAt") if race.get("status") == "done" else None,
        # 成绩被重开改过的次数与最后一次时间（前端提示「本场成绩有修订」）
        "reopenCount": len(race.get("reopenHistory") or []),
        "reopenedAt": (race.get("reopenHistory") or [{}])[-1].get("at"),
    }


def _to_view(race: dict, user_id: str) -> dict:
    """对外视图：去掉内部字段；非创建者/管理员不暴露 _ownerId；访客隐藏对阵与比分。"""
    doc = _race_for_view(race)  # 去掉 _ownerId / _updatedAt
    # 重开审计明细含操作者 user_id，只给创建者/管理员
    if not (user_id == race.get("_ownerId") or _is_admin(user_id)):
        doc.pop("reopenHistory", None)
    if _is_admin(user_id) or can_view_scores(race, user_id):
        if user_id == race.get("_ownerId") or _is_admin(user_id):
            doc["_mine"] = True
        if _is_admin(user_id):
            doc["_ownerName"] = ""
            owner = db.get_user(race.get("_ownerId") or "")
            if owner:
                doc["_ownerName"] = owner.get("nickname") or ""
        return doc
    # 访客：能看时间/场馆/玩法规则（宣传信息），隐藏对阵/比分/名单/报名码
    doc["_viewer"] = "guest"
    doc["matches"] = []
    doc["players"] = []
    doc["teams"] = []
    doc.pop("joinCode", None)
    return doc


@app.get("/api/races/{race_id}")
def get_race(race_id: str, user_id: str = Depends(current_user)) -> dict:
    race = db.get_race(race_id)
    if not race:
        raise HTTPException(status_code=404, detail="比赛不存在")
    return _to_view(race, user_id)


@app.put("/api/races/{race_id}")
def put_race(race_id: str, race: RaceIn, user_id: str = Depends(current_user)) -> dict:
    existing = db.get_race(race_id)
    if existing and existing.get("_ownerId") != user_id:
        raise HTTPException(status_code=403, detail="只有创建者可以修改")
    doc = race.model_dump()
    doc["id"] = race_id
    if existing:
        # 乐观锁：客户端必须携带它看到的 rev，落后则拒绝（防并发覆盖丢更新）
        body_rev = doc.get("rev")
        if body_rev is not None and body_rev != existing.get("rev"):
            raise HTTPException(
                status_code=409,
                detail=f"比赛已被其他人修改（rev {body_rev} → {existing.get('rev')}），请刷新后再试",
            )
        # 状态机护栏：不允许把已结束/进行中的比赛回滚成未开始（防离线队列重放旧文档）
        cur, want = existing.get("status"), doc.get("status")
        if cur in ("playing", "done") and want in ("draft", "open", None):
            raise HTTPException(status_code=409, detail=f"比赛已{ ('结束' if cur=='done' else '进行中') }，不能回退状态")
    try:
        return db.save_race(user_id, doc, expect_rev=existing.get("rev") if existing else None)
    except db.RaceConflict as e:
        raise HTTPException(status_code=409, detail=f"比赛已被其他人修改（rev {e.current_rev}），请刷新后再试")


@app.delete("/api/races/{race_id}")
def delete_race(race_id: str, user_id: str = Depends(current_user)) -> dict:
    if not db.delete_race(race_id, user_id):
        raise HTTPException(status_code=404, detail="比赛不存在或无权删除")
    return {"ok": True}


@app.put("/api/races/{race_id}/matches/{match_id}")
def put_match(
    race_id: str, match_id: str, match: Match, user_id: str = Depends(current_user)
) -> dict:
    race = db.get_race(race_id)
    if not race:
        raise HTTPException(status_code=404, detail="比赛不存在")
    if race.get("_ownerId") != user_id:
        raise HTTPException(status_code=403, detail="只有创建者可以记分")
    payload = match.model_dump()
    payload["id"] = match_id
    # match 级乐观锁：同场并发记分只有一次成功；不同场次互不干扰
    expect = match.rev  # 客户端带上它看到的该场 rev
    try:
        saved = db.save_match(user_id, race_id, payload, expect_match_rev=expect)
    except db.RaceConflict as e:
        raise HTTPException(
            status_code=409,
            detail=f"这场的比分已被别人改过（当前 rev {e.current_rev}），刷新后再记",
        )
    if saved is None:
        raise HTTPException(status_code=404, detail="对阵不存在")
    return saved


@app.get("/api/races/{race_id}/rank")
def race_rank(race_id: str, user_id: str = Depends(current_user)) -> dict:
    race = db.get_race(race_id)
    if not race:
        raise HTTPException(status_code=404, detail="比赛不存在")
    return rules.compute(race)


@app.get("/")
def index() -> RedirectResponse:
    return RedirectResponse("/h5/")


@app.get("/api/stats")
def stats(
    name: str | None = Query(default=None),
    mine: bool = Query(default=False),
    user_id: str = Depends(current_user),
) -> dict:
    """战绩统计。mine=true 用当前登录身份匹配（改昵称不丢数据）；否则按名字查。"""
    if not mine and not (name and name.strip()):
        raise HTTPException(status_code=422, detail="需要 name 或 mine=true")
    races = [db.get_race(item["id"]) for item in db.list_races(user_id)]
    me = db.get_user(user_id) or {}
    target_name = (name or "").strip() or me.get("nickname") or ""
    return rules.personal_stats(
        [r for r in races if r],
        target_name,
        user_id if mine else None,
    )


class UserRoleIn(BaseModel):
    role: str  # admin | user


@app.get("/api/users")
def list_users(user_id: str = Depends(require_admin)) -> dict:
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT id, nickname, role, created_at FROM users ORDER BY created_at"
        ).fetchall()
    users = []
    for r in rows:
        parts = db.list_participants("") if False else []
        users.append(
            {
                "id": r["id"],
                "nickname": r["nickname"] or "",
                "role": r["role"],
                "createdAt": r["created_at"],
            }
        )
    return {"users": users}


@app.put("/api/users/{target_id}/role")
def set_user_role(
    target_id: str, body: UserRoleIn, user_id: str = Depends(require_admin)
) -> dict:
    if body.role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="角色只能是 admin/user")
    db.set_role(target_id, body.role)
    return {"id": target_id, "role": body.role}


@app.post("/api/races/{race_id}/cancel")
def cancel_race(race_id: str, user_id: str = Depends(current_user)) -> dict:
    """创建者（或管理员）取消比赛：状态置 cancel，报名保留。"""
    race = db.get_race(race_id)
    if not race:
        raise HTTPException(status_code=404, detail="比赛不存在")
    if race.get("_ownerId") != user_id and not _is_admin(user_id):
        raise HTTPException(status_code=403, detail="只有创建者可以取消比赛")
    if race.get("status") in ("playing", "done"):
        raise HTTPException(status_code=409, detail="比赛已开始或已结束，不能取消")
    race["status"] = "cancel"
    db.save_race(race.get("_ownerId") or user_id, race)
    return {"ok": True, "status": "cancel"}


# 候补
@app.post("/api/races/{race_id}/waitlist")
def join_waitlist(race_id: str, body: JoinIn, user_id: str = Depends(current_user)) -> dict:
    """满员时进入候补队列。"""
    race = db.get_race(race_id)
    if not race:
        raise HTTPException(status_code=404, detail="比赛不存在")
    if race.get("status") != "open":
        raise HTTPException(status_code=409, detail="当前不在报名阶段")
    if _deadline_passed(race):
        raise HTTPException(status_code=409, detail="报名已截止")
    participants = db.list_participants(race_id)
    limit = race.get("maxPlayers") or 0
    already = next((p for p in participants if p["user_id"] == user_id), None)
    if limit and len([p for p in participants if not p["waitlisted"]]) < limit:
        if already:
            return {"participants": db.list_participants(race_id), "waitlisted": False}
    if already:
        db.set_waitlisted(race_id, user_id, True)
        return {"participants": db.list_participants(race_id), "waitlisted": True}
    avatar = body.avatar if body.avatar and len(body.avatar) < 300 * 1024 else None
    db.add_participant(
        race_id, user_id, body.name.strip()[:20] or "球友", avatar, body.gender, body.level
    )
    db.set_waitlisted(race_id, user_id, True)
    return {"participants": db.list_participants(race_id), "waitlisted": True}


@app.delete("/api/races/{race_id}/participants/{target_id}")
def kick_participant(
    race_id: str, target_id: str, user_id: str = Depends(current_user)
) -> dict:
    """创建者移出名额（正式或候补）；若移除正式成员且存在候补，自动递补第一个候补。"""
    race = db.get_race(race_id)
    if not race:
        raise HTTPException(status_code=404, detail="比赛不存在")
    if race.get("_ownerId") != user_id and not _is_admin(user_id):
        raise HTTPException(status_code=403, detail="只有创建者可以移除成员")
    targets = [p for p in db.list_participants(race_id) if p["user_id"] == target_id]
    if not targets:
        raise HTTPException(status_code=404, detail="成员不存在")
    removed_was = targets[0]
    db.remove_participant(race_id, target_id)
    promoted = None
    if not removed_was["waitlisted"]:
        promoted = db.promote_waitlist(race_id)
    return {
        "participants": db.list_participants(race_id),
        "promoted": promoted,
    }


# 让报名直接复用加入逻辑但区分候补：改造 join
def _deadline_passed(race) -> bool:
    dl = race.get("signupDeadline")
    if not dl:
        return False
    try:
        from datetime import datetime
        dt = datetime.fromisoformat(dl.replace("Z", "+00:00"))
        return datetime.now(dt.tzinfo) > dt
    except Exception:
        return False


def _join_impl(race_id, body, user_id):
    race = db.get_race(race_id)
    if not race or race.get("status") != "open":
        raise HTTPException(status_code=409, detail="当前不在报名阶段")
    if _deadline_passed(race):
        raise HTTPException(status_code=409, detail="报名已截止")
    participants = db.list_participants(race_id)
    limit = race.get("maxPlayers") or 0
    already = next((p for p in participants if p["user_id"] == user_id), None)
    full = limit and len([p for p in participants if not p["waitlisted"]]) >= limit
    if full and not already:
        raise HTTPException(status_code=409, detail="报名已满，请进入候补队列")
    avatar = body.avatar if body.avatar and len(body.avatar) < 300 * 1024 else None
    if already:
        if already["waitlisted"] and not full:
            db.set_waitlisted(race_id, user_id, False)
        db.add_participant(race_id, user_id, body.name.strip()[:20] or "球友", avatar, body.gender, body.level)
    else:
        db.add_participant(race_id, user_id, body.name.strip()[:20] or "球友", avatar, body.gender, body.level)
    return db.list_participants(race_id)


@app.post("/api/races/{race_id}/join")
def join_race(race_id: str, body: JoinIn, user_id: str = Depends(current_user)) -> dict:
    participants = _join_impl(race_id, body, user_id)
    return {"participants": participants, "joined": True}


# 常用模板
@app.get("/api/presets")
def presets(user_id: str = Depends(current_user)) -> dict:
    return {"presets": db.list_presets(user_id)}


@app.post("/api/presets")
def create_preset(body: PresetIn, user_id: str = Depends(current_user)) -> dict:
    preset = db.save_preset("p_" + uuid.uuid4().hex[:10], user_id, body.name.strip()[:20] or "模板", body.data)
    return preset


@app.delete("/api/presets/{preset_id}")
def remove_preset(preset_id: str, user_id: str = Depends(current_user)) -> dict:
    if not db.delete_preset(preset_id, user_id):
        raise HTTPException(status_code=404, detail="模板不存在或无权删除")
    return {"ok": True}


# 管理员可强制结束任意比赛
@app.post("/api/admin/races/{race_id}/finish")
def admin_finish_race(race_id: str, user_id: str = Depends(require_admin)) -> dict:
    race = db.get_race(race_id)
    if not race:
        raise HTTPException(status_code=404, detail="比赛不存在")
    race["status"] = "done"
    db.save_race(race.get("_ownerId") or user_id, race)
    return summary(race_id, user_id)


@app.get("/api/acquaintances")
def acquaintances(user_id: str = Depends(current_user)) -> dict:
    """当前用户以往报名过的球友（用于一键选择）。"""
    return {"people": rules.acquaintances(db.list_races_all(), user_id, db.list_participants)}


# 补录比分：已结束的比赛 reopen 后改分
@app.post("/api/races/{race_id}/reopen")
def reopen_race(race_id: str, user_id: str = Depends(current_user)) -> dict:
    race = db.get_race(race_id)
    if not race:
        raise HTTPException(status_code=404, detail="比赛不存在")
    if race.get("_ownerId") != user_id and not _is_admin(user_id):
        raise HTTPException(status_code=403, detail="只有创建者可以重新打开")
    if race.get("status") != "done":
        raise HTTPException(status_code=409, detail="只有已结束的比赛可以重新打开")
    # 留痕：已公布的排名被改写，事后要能追溯谁在什么时候重开了几次。
    # 注意用非 _ 前缀：save_race 会剥掉所有 _ 开头字段，这里必须能持久化。
    # 对外视图只给创建者/管理员看，见 _to_view。
    history = race.get("reopenHistory") or []
    history.append({"at": int(time.time() * 1000), "by": user_id})
    race["reopenHistory"] = history[-20:]
    race["status"] = "playing"
    db.save_race(race.get("_ownerId") or user_id, race)
    return {"ok": True, "status": "playing", "reopened": len(race["reopenHistory"])}


@app.get("/api/people")
def people_stats(user_id: str = Depends(require_admin)) -> dict:
    """人员统计：报名/参赛/单场排名历史。只统计实际开赛（playing/done）的比赛。"""
    return {"people": rules.person_stats(db.list_races_all(), db.list_participants)}


# ---------------------------------------------------------------- 玩法

@app.get("/api/formats")
def formats(user_id: str = Depends(current_user)) -> dict:
    """玩法实现代码在仓库里（shared/plays），这里只下发管理员的覆写。"""
    return {"overrides": db.list_format_overrides()}


@app.put("/api/formats/{play_id}")
def put_format(
    play_id: str, body: FormatOverrideIn, user_id: str = Depends(require_admin)
) -> dict:
    return db.save_format_override(play_id, body.model_dump())


@app.delete("/api/formats/{play_id}")
def reset_format(play_id: str, user_id: str = Depends(require_admin)) -> dict:
    db.delete_format_override(play_id)
    return {"ok": True}


# ---------------------------------------------------------------- 微信 JS-SDK

_ACCESS_TOKEN = {"value": None, "exp": 0}
_JSAPI_TICKET = {"value": None, "exp": 0}


def _wechat_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _access_token() -> str:
    if _ACCESS_TOKEN["value"] and _ACCESS_TOKEN["exp"] > time.time():
        return _ACCESS_TOKEN["value"]
    data = _wechat_json(
        "https://api.weixin.qq.com/cgi-bin/token?"
        + urllib.parse.urlencode(
            {"grant_type": "client_credential", "appid": WECHAT_APPID, "secret": WECHAT_SECRET}
        )
    )
    token = data.get("access_token")
    if not token:
        raise HTTPException(status_code=502, detail=data.get("errmsg") or "获取 access_token 失败")
    _ACCESS_TOKEN["value"] = token
    _ACCESS_TOKEN["exp"] = time.time() + int(data.get("expires_in", 7200)) - 300
    return token


def _jsapi_ticket() -> str:
    if _JSAPI_TICKET["value"] and _JSAPI_TICKET["exp"] > time.time():
        return _JSAPI_TICKET["value"]
    data = _wechat_json(
        "https://api.weixin.qq.com/cgi-bin/ticket/getticket?"
        + urllib.parse.urlencode({"access_token": _access_token(), "type": "jsapi"})
    )
    ticket = data.get("ticket")
    if not ticket:
        raise HTTPException(status_code=502, detail=data.get("errmsg") or "获取 jsapi_ticket 失败")
    _JSAPI_TICKET["value"] = ticket
    _JSAPI_TICKET["exp"] = time.time() + int(data.get("expires_in", 7200)) - 300
    return ticket


@app.get("/api/wechat/jssdk")
def wechat_jssdk(url: str) -> dict:
    """微信 JS-SDK 签名，用于 wx.openLocation 调起内置地图。"""
    if not (WECHAT_APPID and WECHAT_SECRET):
        raise HTTPException(status_code=501, detail="服务端未配置公众号，无法使用微信内置地图")
    ticket = _jsapi_ticket()
    nonce = secrets.token_hex(8)
    stamp = int(time.time())
    plain = "jsapi_ticket=%s&noncestr=%s&timestamp=%s&url=%s" % (
        ticket,
        nonce,
        stamp,
        url.split("#")[0],
    )
    return {
        "appId": WECHAT_APPID,
        "timestamp": stamp,
        "nonceStr": nonce,
        "signature": hashlib.sha1(plain.encode("utf-8")).hexdigest(),
    }


# ---------------------------------------------------------------- 静态资源

ROOT = Path(__file__).resolve().parents[2]
app.mount("/h5", StaticFiles(directory=ROOT / "h5", html=True), name="h5")
app.mount("/shared", StaticFiles(directory=ROOT / "shared"), name="shared")
