"""高德链接解析：离线用例（不联网）。"""

from app import amap


def test_payload_with_p_param():
    info = amap.parse(
        "https://www.amap.com/?p=B0KUNLUWR5,39.926193,116.581813,%E8%8F%81%E8%8B%B1%E6%A2%A6%E8%B0%B7,"
        "%E6%9C%9D%E9%98%B3%E5%8C%97%E8%B7%AF"
    )
    assert info["poiId"] == "B0KUNLUWR5"
    assert info["lat"] == 39.926193
    assert info["lng"] == 116.581813
    assert info["name"] == "菁英梦谷"
    assert info["address"] == "朝阳北路"


def test_callapp_double_encoded():
    raw = (
        "https://m.amap.com/callAPP?ios=multiPointShow%3FsourceApplication%3Dfrom_wb"
        "%26q%3D39.93061776779187%252C116.55953943729398%252C"
        "%25E8%25B6%2585%25E7%25BA%25A7%25E9%25B9%25B0%2528268%25E5%25BA%2597%2529%252C"
        "%25E5%25B9%25BA%25E5%25AE%25B6%25E5%25BA%2597%25E8%25B7%25AF%252CB0L0FU596D"
    )
    info = amap.parse(raw)
    assert info["poiId"] == "B0L0FU596D"
    assert info["lat"] == 39.93061776779187
    assert info["name"].startswith("超级鹰")
    assert info["address"].startswith("幺家店路")


def test_detail_only_returns_poi_id():
    info = amap.parse("https://www.amap.com/detail/B0KUNLUWR5")
    assert info["poiId"] == "B0KUNLUWR5"
    assert info["lat"] is None


def test_unrelated_text():
    assert amap.parse("天气不错") is None
    assert amap.parse("") is None
