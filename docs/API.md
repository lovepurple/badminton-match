# API

Base：`http://<host>:18000`（端口可改）。除 `POST /api/auth/login` 与 `GET /api/health` 外，
所有接口都需要 `Authorization: Bearer <token>`。

## 鉴权

`POST /api/auth/login`

```json
{ "code": "<wx.login 的 code，可空>", "deviceId": "web-xxx", "nickname": "阿豪" }
```

- 配置了 `GORILLA_WECHAT_APPID` / `GORILLA_WECHAT_SECRET` 且带 `code` 时，服务端调用
  `jscode2session` 换取 openid 作为用户标识。
- 否则用 `deviceId` 生成 `dev_<deviceId>` 用户，便于本地联调。

响应：

```json
{ "token": "...", "user": { "id": "dev_web-xxx", "nickname": "阿豪" } }
```

## 比赛

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/races` | 当前用户的比赛摘要列表 |
| GET | `/api/races?full=1` | 返回完整文档（含 players/teams/matches），客户端同步用 |
| POST | `/api/races` | 新建比赛（整份文档） |
| GET | `/api/races/{id}` | 读取比赛（任何登录用户可读，便于朋友围观） |
| PUT | `/api/races/{id}` | 覆盖整份文档（仅创建者） |
| DELETE | `/api/races/{id}` | 删除（仅创建者） |
| PUT | `/api/races/{id}/matches/{mid}` | 提交单个对阵的比分（仅创建者） |
| GET | `/api/races/{id}/rank` | 服务端计算排名 |

比赛文档字段与客户端 `race` 一致：

```json
{
  "id": "race_xxx",
  "name": "周六八人转",
  "mode": "eight",
  "group": "doubles",
  "rounds": 3,
  "balls": 21,
  "wheelMode": "isolate",
  "partnerMode": "random",
  "rankMode": "pointFirst",
  "matchesPerEntity": 3,
  "arenaKings": 1,
  "groupSize": 4,
  "groupsValid": 3,
  "players": [{ "id": "p1", "name": "阿豪", "gender": "M", "level": 3 }],
  "teams": [{ "name": "A 队", "players": ["p1", "p2"] }],
  "matches": [{
    "id": "m1", "round": 1, "court": 1,
    "side1": ["p1", "p2"], "side2": ["p3", "p4"],
    "scores": [[21, 19], [21, 15]],
    "scoreAll": [2, 0],
    "status": "done"
  }]
}
```

`GET /api/races/{id}/rank` 响应：

```json
{
  "kind": "player",
  "rows": [
    { "key": "p1", "name": "阿豪", "alls": 1, "wins": 1, "fail": 0, "even": 0,
      "allRound": 2, "winRound": 2, "failRound": 0, "net": 2,
      "allBalls": 72, "winball": 42, "failball": 30, "netball": 12,
      "point": 2, "rate_alls": 1.0, "rate_net": 1.0, "rate_netball": 0.583,
      "wins_minus_fail": 1 }
  ]
}
```

排序链与客户端 `utils/ranking.js` 完全一致（`pointFirst` / `ballFirst` / `totalFirst` / `winsFirst`）。

## 战绩

`GET /api/stats?name=阿豪`

```json
{
  "total":   { "alls": 3, "wins": 2, "fail": 1, "even": 0 },
  "singles": { "alls": 1, "wins": 1, "fail": 0, "even": 0 },
  "doubles": { "alls": 2, "wins": 1, "fail": 1, "even": 0 },
  "rounds": 7
}
```

## 报名与比赛流程

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/races/{id}/open` | 开放报名，body `{"maxPlayers": 8}`（0 = 不限），返回 `joinCode` |
| GET | `/api/join/{code}` | 报名页信息：比赛摘要 + 报名名单 + 是否已报名 |
| POST | `/api/races/{id}/join` | 报名，body `{"name","gender","level"}`；已满/非报名阶段返回 409 |
| DELETE | `/api/races/{id}/join` | 退出报名（进行中不可退） |
| GET | `/api/races/{id}/participants` | 报名名单 + `isOwner` + `status` + `joinCode` |
| POST | `/api/races/{id}/start` | 开始比赛，body `{"players":[...],"matches":[...]}`（对阵由客户端生成） |
| POST | `/api/races/{id}/finish` | 结束比赛，返回汇总 |
| GET | `/api/races/{id}/live?since=<updatedAt>` | 实时轮询；无变化时 `changed=false` 且不返回 `race` |
| GET | `/api/races/{id}/summary` | 汇总：最终排名 + 全部对阵 |

`GET /api/races` 返回「自己创建的 + 自己报名过的」比赛，摘要里带 `status`、`joinCode`、`maxPlayers`、`mine`。

## 场馆与管理员

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/me` | 当前用户（`role`: `admin` / `user`） |
| POST | `/api/auth/admin-claim` | 输入管理员口令把自己提升为管理员（`GORILLA_ADMIN_CODE`） |
| GET | `/api/venues` | 场馆列表（所有登录用户可读；空库时自动种入默认场馆） |
| POST | `/api/venues` | 新增场馆（管理员） |
| POST | `/api/venues/resolve` | 解析高德分享链接 → `{name,address,lat,lng,poiId}`（管理员） |
| PUT | `/api/venues/{id}` | 修改场馆（管理员） |
| DELETE | `/api/venues/{id}` | 删除场馆（管理员） |

场馆字段：

```json
{ "id": "v_xxx", "name": "城东体育馆", "address": "杭州市上城区体育场路 1 号",
  "lat": 30.2741, "lng": 120.1551, "coord_type": "gcj02", "note": "3 号场地" }
```

管理员产生方式：`GORILLA_ADMIN_DEVICES`（逗号分隔的 deviceId）命中即管理员；
否则数据库中还没有管理员时，第一个登录的用户成为管理员。

比赛文档新增 `date`（`YYYY-MM-DDTHH:mm`）、`venueId`、`venue`（创建时的场馆快照，
含 `name/address/lat/lng/coordType`），报名页 `GET /api/join/{code}` 也会返回这三项。

## 微信网页授权

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/auth/wechat/start?redirect=/h5/...` | 302 到微信授权页（需配置公众号） |
| GET | `/api/auth/wechat/callback?code=&state=` | 微信回调，签发本站 token 后 302 回前端 |
| GET | `/api/wechat/jssdk?url=<当前页>` | JS-SDK 签名，用于 `wx.openLocation` 调起内置地图 |

未配置 `GORILLA_WECHAT_APPID` / `SECRET` / `OAUTH_CALLBACK` 时 `/api/health` 的
`features.wechatOAuth` 为 `false`，前端只用设备号登录。

## 其他

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/` | 302 到 `/h5/` |
| GET | `/h5/` | H5 客户端 |
| GET | `/shared/...` | 共享逻辑（rules/formats/ranking），供 H5 引用 |

## 错误

统一返回 `{"detail": "..."}`：`401` 未登录/令牌无效，`403` 非创建者，`404` 不存在，`409` ID 冲突。
