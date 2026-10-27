"""SQLite 持久化层：用户、令牌、比赛文档。

比赛整体以 JSON 文档存储（与小程序端数据模型一致），
另存少量冗余列用于列表查询。
"""

import json
import os
import sqlite3
import time

DEFAULT_DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data.db")


def db_path() -> str:
    return os.environ.get("GORILLA_DB", DEFAULT_DB)


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    nickname   TEXT,
    created_at INTEGER NOT NULL,
    role       TEXT NOT NULL DEFAULT 'user'
);

CREATE TABLE IF NOT EXISTS tokens (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS races (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL,
    name          TEXT NOT NULL,
    mode          TEXT NOT NULL,
    group_name    TEXT NOT NULL,
    rounds        INTEGER NOT NULL,
    balls         INTEGER NOT NULL,
    players_count INTEGER NOT NULL,
    matches_count INTEGER NOT NULL,
    data          TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    join_code     TEXT,
    status        TEXT NOT NULL DEFAULT 'draft',
    max_players   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_races_owner ON races(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS venues (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    address    TEXT NOT NULL DEFAULT '',
    lat        REAL,
    lng        REAL,
    coord_type TEXT NOT NULL DEFAULT 'gcj02',
    note       TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS format_overrides (
    id         TEXT PRIMARY KEY,
    enabled    INTEGER NOT NULL DEFAULT 1,
    name       TEXT,
    intro      TEXT,
    defaults   TEXT,
    rules      TEXT,
    note       TEXT,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
    race_id   TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    name      TEXT NOT NULL,
    gender    TEXT NOT NULL DEFAULT 'M',
    level     INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (race_id, user_id)
);
"""

# 旧库补列
COLUMNS = [
    ("races", "join_code", "TEXT"),
    ("races", "status", "TEXT NOT NULL DEFAULT 'draft'"),
    ("races", "max_players", "INTEGER NOT NULL DEFAULT 0"),
    ("users", "role", "TEXT NOT NULL DEFAULT 'user'"),
]


# 默认场馆：来自高德分享的真实 POI（B0L0FU596D），坐标为 gcj02
DEFAULT_VENUES = [
    {
        "id": "v_super_eagle_268",
        "name": "超级鹰羽毛球馆(268店)",
        "address": "幺家店路与定福庄路交叉口西 400 米",
        "lat": 39.93061776779187,
        "lng": 116.55953943729398,
        "coord_type": "gcj02",
        "note": "高德 POI B0L0FU596D · 约 ¥37/人",
    },
    {
        "id": "v_jingying_menggu",
        "name": "菁英梦谷·常营12号楼",
        "address": "朝阳北路甲27号菁英梦谷·常营",
        "lat": 39.926193,
        "lng": 116.581813,
        "coord_type": "gcj02",
        "note": "高德 POI B0KUNLUWR5 · 园区场地",
    },
]


def seed_venues() -> None:
    """首次启动时写入默认场馆（已存在同名/同 id 则跳过）。"""
    with connect() as conn:
        existing = conn.execute("SELECT COUNT(*) AS n FROM venues").fetchone()["n"]
    if existing:
        return
    for venue in DEFAULT_VENUES:
        save_venue(venue, "system")


def init() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
        for table, column, ddl in COLUMNS:
            existing = {row["name"] for row in conn.execute("PRAGMA table_info(%s)" % table)}
            if column not in existing:
                conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, ddl))
    seed_venues()


def now() -> int:
    return int(time.time() * 1000)


# ---- users / tokens -------------------------------------------------------

def upsert_user(user_id: str, nickname: str | None = None) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO users(id, nickname, created_at) VALUES(?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET nickname=COALESCE(excluded.nickname, users.nickname)",
            (user_id, nickname, now()),
        )


def get_user(user_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return dict(row) if row else None


def set_role(user_id: str, role: str) -> None:
    with connect() as conn:
        conn.execute("UPDATE users SET role=? WHERE id=?", (role, user_id))


def count_users() -> int:
    with connect() as conn:
        return conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]


def has_admin() -> bool:
    with connect() as conn:
        row = conn.execute("SELECT 1 FROM users WHERE role='admin' LIMIT 1").fetchone()
    return row is not None


def create_token(token: str, user_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO tokens(token, user_id, created_at) VALUES(?,?,?)",
            (token, user_id, now()),
        )


def user_by_token(token: str) -> str | None:
    with connect() as conn:
        row = conn.execute("SELECT user_id FROM tokens WHERE token=?", (token,)).fetchone()
    return row["user_id"] if row else None


# ---- races ----------------------------------------------------------------

def race_row_to_doc(row: sqlite3.Row) -> dict:
    return json.loads(row["data"])


def list_races(user_id: str) -> list[dict]:
    """自己创建的 + 自己报名过的比赛。"""
    with connect() as conn:
        rows = conn.execute(
            "SELECT r.*, (r.owner_id = ?) AS is_owner FROM races r"
            " LEFT JOIN participants p ON p.race_id = r.id AND p.user_id = ?"
            " WHERE r.owner_id = ? OR p.user_id IS NOT NULL"
            " GROUP BY r.id ORDER BY r.updated_at DESC",
            (user_id, user_id, user_id),
        ).fetchall()
    out = []
    for r in rows:
        doc = json.loads(r["data"]) if r["data"] else {}
        venue = doc.get("venue") or {}
        out.append({
            "id": r["id"],
            "name": r["name"],
            "mode": r["mode"],
            "group": r["group_name"],
            "rounds": r["rounds"],
            "balls": r["balls"],
            "players": r["players_count"],
            "matches": r["matches_count"],
            "updatedAt": r["updated_at"],
            "status": r["status"],
            "joinCode": r["join_code"],
            "maxPlayers": r["max_players"],
            "mine": bool(r["is_owner"]),
            "date": doc.get("date"),
            "venueName": venue.get("name") or "",
        })
    return out


def get_race(race_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM races WHERE id=?", (race_id,)).fetchone()
    if not row:
        return None
    doc = race_row_to_doc(row)
    doc["_ownerId"] = row["owner_id"]
    doc["_updatedAt"] = row["updated_at"]
    return doc


def save_race(owner_id: str, race: dict) -> dict:
    race_id = race["id"]
    stamp = now()
    payload = json.dumps(race, ensure_ascii=False, separators=(",", ":"))
    with connect() as conn:
        existing = conn.execute(
            "SELECT created_at, join_code, status, max_players FROM races WHERE id=?", (race_id,)
        ).fetchone()
        created = existing["created_at"] if existing else stamp
        join_code = race.get("joinCode") or (existing["join_code"] if existing else None)
        status = race.get("status") or (existing["status"] if existing else "draft")
        max_players = race.get("maxPlayers")
        if max_players is None:
            max_players = existing["max_players"] if existing else 0
        conn.execute(
            "INSERT INTO races(id, owner_id, name, mode, group_name, rounds, balls,"
            " players_count, matches_count, data, created_at, updated_at,"
            " join_code, status, max_players)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(id) DO UPDATE SET"
            " name=excluded.name, mode=excluded.mode, group_name=excluded.group_name,"
            " rounds=excluded.rounds, balls=excluded.balls,"
            " players_count=excluded.players_count, matches_count=excluded.matches_count,"
            " data=excluded.data, updated_at=excluded.updated_at,"
            " join_code=excluded.join_code, status=excluded.status,"
            " max_players=excluded.max_players",
            (
                race_id,
                owner_id,
                race.get("name") or "未命名比赛",
                race.get("mode") or "",
                race.get("group") or "",
                int(race.get("rounds") or 0),
                int(race.get("balls") or 0),
                len(race.get("players") or []),
                len(race.get("matches") or []),
                payload,
                created,
                stamp,
                join_code,
                status,
                int(max_players or 0),
            ),
        )
    race["_ownerId"] = owner_id
    race["_updatedAt"] = stamp
    race["status"] = status
    race["joinCode"] = join_code
    race["maxPlayers"] = int(max_players or 0)
    return race


def get_race_by_code(code: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM races WHERE join_code=?", (code,)).fetchone()
    if not row:
        return None
    doc = race_row_to_doc(row)
    doc["_ownerId"] = row["owner_id"]
    doc["_updatedAt"] = row["updated_at"]
    return doc


def set_status(race_id: str, status: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE races SET status=?, updated_at=? WHERE id=?", (status, now(), race_id)
        )


def add_participant(race_id: str, user_id: str, name: str, gender: str, level: int) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO participants(race_id, user_id, name, gender, level, joined_at)"
            " VALUES(?,?,?,?,?,?)"
            " ON CONFLICT(race_id, user_id) DO UPDATE SET"
            " name=excluded.name, gender=excluded.gender, level=excluded.level",
            (race_id, user_id, name, gender, level, now()),
        )


def remove_participant(race_id: str, user_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "DELETE FROM participants WHERE race_id=? AND user_id=?", (race_id, user_id)
        )


def list_participants(race_id: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT user_id, name, gender, level, joined_at FROM participants"
            " WHERE race_id=? ORDER BY joined_at",
            (race_id,),
        ).fetchall()
    return [dict(row) for row in rows]


# ---- venues ---------------------------------------------------------------

def list_venues() -> list[dict]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM venues ORDER BY updated_at DESC").fetchall()
    return [dict(row) for row in rows]


def get_venue(venue_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM venues WHERE id=?", (venue_id,)).fetchone()
    return dict(row) if row else None


def save_venue(venue: dict, user_id: str) -> dict:
    stamp = now()
    with connect() as conn:
        existing = conn.execute("SELECT created_at FROM venues WHERE id=?", (venue["id"],)).fetchone()
        created = existing["created_at"] if existing else stamp
        conn.execute(
            "INSERT INTO venues(id, name, address, lat, lng, coord_type, note,"
            " created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(id) DO UPDATE SET name=excluded.name, address=excluded.address,"
            " lat=excluded.lat, lng=excluded.lng, coord_type=excluded.coord_type,"
            " note=excluded.note, updated_at=excluded.updated_at",
            (
                venue["id"],
                venue.get("name") or "未命名场馆",
                venue.get("address") or "",
                venue.get("lat"),
                venue.get("lng"),
                venue.get("coordType") or "gcj02",
                venue.get("note") or "",
                user_id,
                created,
                stamp,
            ),
        )
    venue["updatedAt"] = stamp
    return venue


# ---- 玩法覆写（玩法实现是代码，这里只存管理员的展示/开关/默认值调整） ----

def list_format_overrides() -> dict:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM format_overrides").fetchall()
    out = {}
    for row in rows:
        out[row["id"]] = {
            "id": row["id"],
            "enabled": bool(row["enabled"]),
            "name": row["name"],
            "intro": row["intro"],
            "defaults": json.loads(row["defaults"]) if row["defaults"] else None,
            "rules": json.loads(row["rules"]) if row["rules"] else None,
            "note": row["note"] or "",
            "updatedAt": row["updated_at"],
        }
    return out


def save_format_override(play_id: str, data: dict) -> dict:
    stamp = now()
    payload = (
        play_id,
        1 if data.get("enabled", True) else 0,
        data.get("name"),
        data.get("intro"),
        json.dumps(data["defaults"], ensure_ascii=False) if data.get("defaults") else None,
        json.dumps(data["rules"], ensure_ascii=False) if data.get("rules") else None,
        data.get("note") or "",
        stamp,
    )
    with connect() as conn:
        conn.execute(
            "INSERT INTO format_overrides(id, enabled, name, intro, defaults, rules, note, updated_at)"
            " VALUES(?,?,?,?,?,?,?,?)"
            " ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, name=excluded.name,"
            " intro=excluded.intro, defaults=excluded.defaults, rules=excluded.rules,"
            " note=excluded.note, updated_at=excluded.updated_at",
            payload,
        )
    return {
        "id": play_id,
        "enabled": bool(payload[1]),
        "name": payload[2],
        "intro": payload[3],
        "defaults": data.get("defaults"),
        "rules": data.get("rules"),
        "note": payload[6],
        "updatedAt": stamp,
    }


def delete_format_override(play_id: str) -> bool:
    with connect() as conn:
        cur = conn.execute("DELETE FROM format_overrides WHERE id=?", (play_id,))
    return cur.rowcount > 0


def delete_venue(venue_id: str) -> bool:
    with connect() as conn:
        cur = conn.execute("DELETE FROM venues WHERE id=?", (venue_id,))
    return cur.rowcount > 0


def delete_race(race_id: str, owner_id: str) -> bool:
    with connect() as conn:
        cur = conn.execute("DELETE FROM races WHERE id=? AND owner_id=?", (race_id, owner_id))
    return cur.rowcount > 0
