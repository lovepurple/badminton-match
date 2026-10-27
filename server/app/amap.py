"""高德分享链接解析：把用户从 App 复制的地图链接还原成场馆信息。

支持的输入（都是高德 App「分享 → 复制链接」产生的）：

    1. https://surl.amap.com/xxxx          短链，需联网跟随跳转
    2. https://www.amap.com/?p=B0KUNLUWR5,39.926193,116.581813,名称,地址
    3. https://m.amap.com/callAPP?...&q=39.9306,116.5595,名称,地址,B0L0FU596D,
    4. 任意含上述参数的文本（用户可能把整段分享文案粘进来）

返回：{name, address, lat, lng, poiId, coordType}
"""

from __future__ import annotations

import re
import urllib.parse
import urllib.request

MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)

# ?p=<poiId>,<lat>,<lng>,<name>,<address>
P_PATTERN = re.compile(
    r"[?&]p=([A-Za-z0-9]{6,}),(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+),([^,&#]*),([^,&#]*)"
)
# ?q=<lat>,<lng>,<name>,<address>,<poiId>
Q_PATTERN = re.compile(
    r"[?&]q=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+),([^,&#]*)(?:,([^,&#]*))?(?:,([A-Za-z0-9]{6,}))?"
)
DETAIL_PATTERN = re.compile(r"/detail/([A-Za-z0-9]{6,})")


def _deep_unquote(text: str) -> str:
    for _ in range(3):
        decoded = urllib.parse.unquote(text)
        if decoded == text:
            break
        text = decoded
    return text


def parse(text: str) -> dict | None:
    """从任意文本里提取场馆信息；失败返回 None。"""
    if not text:
        return None
    raw = _deep_unquote(text)

    m = P_PATTERN.search(raw)
    if m:
        poi_id, lat, lng, name, address = m.groups()
        return {
            "poiId": poi_id,
            "lat": float(lat),
            "lng": float(lng),
            "name": name.strip(),
            "address": address.strip(),
            "coordType": "gcj02",
        }

    m = Q_PATTERN.search(raw)
    if m:
        lat, lng, name, address, poi_id = m.groups()
        return {
            "poiId": poi_id or "",
            "lat": float(lat),
            "lng": float(lng),
            "name": (name or "").strip(),
            "address": (address or "").strip(),
            "coordType": "gcj02",
        }

    m = DETAIL_PATTERN.search(raw)
    if m:
        # 只有 POI ID，没有坐标：交给前端提示手动补
        return {"poiId": m.group(1), "lat": None, "lng": None, "name": "", "address": "", "coordType": "gcj02"}

    return None


def resolve(url: str, timeout: float = 8.0) -> dict | None:
    """短链需要联网跟随跳转，再从最终 URL 里解析。"""
    if not url:
        return None

    parsed = parse(url)
    if parsed and parsed.get("lat") is not None:
        return parsed

    req = urllib.request.Request(url, headers={"User-Agent": MOBILE_UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            final_url = resp.geturl()
            body = ""
            try:
                body = resp.read(200000).decode("utf-8", "replace")
            except Exception:
                body = ""
    except Exception:
        final_url, body = url, ""

    return parse(final_url) or parse(_deep_unquote(final_url)) or parse(body) or parse(url)
