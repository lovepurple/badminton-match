# AGENTS.md

给后续维护者（人或 AI）的项目说明。先读这一页，再动代码。

## 1. 项目是什么

**猩球 · 羽球局**：朋友局的羽毛球比赛工具，H5 客户端 + Python 服务端。
规则（计分、让分、积分、排名链、赛制）来自对原小程序的反编译还原，
出处见 `docs/逆向分析.md`、`docs/规则还原.md`。

命名约定：

- 展示名固定为 **猩球 · 羽球局**（不要写成「羽球助手」，那是被逆向的原产品）。
- 代码、包名、存储键、环境变量统一用 **gorilla**（例：`gorilla-badminton/h5/v1`、`GORILLA_DB`），
  不要用 `xingqiu` 或 `badminton-assist`。

## 2. 分层

```
h5/                 视图层（原生 JS + DOM，无构建）
  js/api.js         fetch 封装、令牌、base
  js/store.js       本地缓存 + 服务端同步 + 离线队列
  js/app.js         路由与各页面渲染
shared/             纯逻辑，浏览器与 Node 通用
  rules.js          常量、单局/追分/局数判定、让分表、积分
  formats.js        排程原语（轮转/循环/擂台/跨队…）+ 未迁移赛制的兜底生成
  plays/            玩法模块（每个玩法一个文件 + registry.json）
  ranking.js        统计与 4 条排序链、个人战绩
server/             FastAPI
  app/main.py       路由、鉴权、微信授权
  app/db.py         唯一持久化入口（SQLite）
  app/rules.py      ranking.js 的服务端等价实现
```

依赖方向：`h5 → shared`，`server/app/rules.py` 独立实现（不跨语言调用）。
**禁止** `shared` 里出现 DOM / fetch / wx 调用；**禁止**把业务规则写进 `app.js` 或 WXML/HTML 模板。

## 3. 不变量（改动前确认）

1. **判定顺序**：`0:0 → 平局 → 未满分 → 分差<2 → 结束`（`rules.judgeSet`），顺序变了会改变提示时机。
2. **30 分封顶**是原实现硬编码，与分制无关。
3. **让分表**四组数值来自源码，不要“按更合理的方式”重算。
4. **排名排序链**：`ballFirst` / `totalFirst` 的第二关键字按原实现实际行为取“胜场数”，不是“胜场差”。
5. **积分**：净胜局；单局赛制胜 2 分、平 1 分（`rules.matchPoints`）。
6. **追分模式**：累计比分，本场满分 `balls × rounds`（团体赛 `× groupsValid`），单场记录“新增比分”，不得为负。
7. **两端排名必须一致**：改 `shared/ranking.js` 必须同步 `server/app/rules.py`，并跑 `tests/e2e.test.js` 的对比用例。
8. **对阵生成在客户端**（管理员浏览器），服务端只校验与存储；不要在两个地方各实现一套算法。
9. **场馆用快照**：创建比赛时把 `{name,address,lat,lng,coordType}` 写进 `race.venue`，之后改场馆不影响历史比赛。
10. **坐标是 gcj02**（高德/腾讯）；不要按 WGS84 处理，否则国内会偏移。
11. **导航顺序**：微信内 JS-SDK `wx.openLocation` → 高德 URI → 复制地址。不要直接跳 Google Maps。

## 3.5 权限模型

```
管理员(role=admin) > 创建者(race._ownerId) > 成员(participants/对阵选手) > 访客(其他登录用户)
```

- 管理员：可见全部比赛与实时比分、可强制结束/删除任意比赛、可管理成员角色（`/api/users`）。
- 创建者：本场比赛全权（开放报名/开始/记分/结束/改配置/删除）。
- 成员：看自己报名比赛的对阵、实时比分、汇总。
- 访客：仅能看到时间、场馆、玩法规则（`_viewer: "guest"`，`matches/players/teams/joinCode` 已裁剪）；
  `live` / `summary` 返回 403。

实现集中在这几处：`race_access()` / `can_view_scores()` / `_to_view()`（`server/app/main.py`）。
改权限时三处一起改，并补 `server/tests/test_permissions.py`。

## 4. 状态机

```
draft ──open──▶ open ──start──▶ playing ──finish──▶ done
```

- `draft`：仅创建者可见操作（开放报名）；`signup=true` 创建时不带选手/对阵，开始时按报名名单生成
- `open`：任何人可报名；满员（`maxPlayers`）或开始后拒绝
- `playing`：只能创建者记分；成员只读 + 轮询
- `done`：只读汇总

权限：读 = 任何登录用户；写 = 仅 `race._ownerId`。

## 5. 常见改动

### 新增玩法

**先读 `docs/llm/玩法开发指南.md`**（含 5 要素提问清单与完整示例）。要点：

1. 在 `shared/plays/<id>.js` 写模块：`{ id, name, group, min, max, intro, tags, rules{people,how,groups,end,score}, defaults, schedule(race, fmt) }`；
   追分类玩法加 `scoring: { mode: "chase" }`。
2. `shared/plays/registry.json` 的 `plays` 加一行。
3. `tests/plays.test.js` 与 `tests/logic.test.js` 补断言。
4. `docs/llm/玩法开发指南.md` §7 表格补一行。
5. 只写 `schedule` + 元数据，**不要**改 `rules.js` 的判定或 `ranking.js` 的排序。

### 调整规则数值

只改 `shared/rules.js` 的常量（`ROUNDS` / `BALLS` / `SIDE_SWITCH` / `CEDE_*` / `RANK_MODES`），
同步 `docs/规则还原.md` 与测试；排名相关还要同步 `server/app/rules.py`。

### 加接口

1. `server/app/main.py` 加路由 + Pydantic 模型；持久化只经 `app/db.py`。
2. `server/tests/` 补用例（含权限失败路径）。
3. `h5/js/store.js` 加调用方法，`docs/API.md` 补一行。

### 改数据结构

- 客户端缓存键：`gorilla-badminton/h5/v1`。破坏性变更请升版本并在 `store.load()` 里迁移。
- 服务端：`db.init()` 里有 `COLUMNS` 迁移列表，加列时追加一项（`ALTER TABLE`）。

### 场馆与导航

- 数据：`server/app/db.py` 的 `venues` 表；接口在 `main.py`（写操作 `require_admin`）。
- 页面：独立后台 `h5/admin.html` + `h5/js/admin.js` + `h5/admin.css`（桌面优先、宽屏两列，窄屏单列）。
- 非管理员进入后台时显示口令框，调 `POST /api/auth/admin-claim`（`GORILLA_ADMIN_CODE`）提升角色。
- 管理员：`GORILLA_ADMIN_DEVICES` 命中，或库里没有管理员时首个登录用户。

### 微信登录

`server/app/main.py` 的 `/api/auth/wechat/*`；配置来自 `server/.env`（模板 `.env.example`），
申请与配置步骤见 `docs/开通微信登录.md`，技术流程见 `docs/微信登录与流程.md`。
未配置时自动降级设备号登录，本地开发不需要公众号。

## 6. 测试

```bash
npm test                              # 规则(35) + 数据层端到端(7)
cd server && python -m pytest -q      # 接口与流程(12)
```

- `tests/logic.test.js`：纯规则/赛制/排名断言，不依赖网络。
- `tests/plays.test.js`：玩法模块契约（字段完整、rules 五段、排程结构、关键场次数）。
- `tests/e2e.test.js`：起一个临时 uvicorn，用 `h5/js/store.js` 打真实接口，含离线队列与两端排名对比。
- `server/tests/test_flow.py`：报名 → 开始 → 记分 → 实时 → 汇总的完整流程与权限。
- `server/tests/test_venues.py`：场馆 CRUD、管理员权限、比赛日期/场馆快照。

改 `shared/*` 必跑 logic + e2e；改页面/接口必跑 e2e + pytest；
UI 改动在浏览器里实际点一遍（新建 → 开放报名 → 报名 → 开始 → 记分 → 汇总）。

## 7. 代码风格

- 原生 JS（ES2020 可用），无框架、无构建；`h5/js/*.js` 用 IIFE 挂到 `window.BA`。
- `shared/*.js` 必须同时支持 CommonJS 与浏览器：顶部 `typeof require` 判断，尾部 UMD 导出。
- Python：标准库 + FastAPI/Pydantic，无 ORM；SQL 集中在 `db.py`。
- 中文字符串直接写；规则数值只在 `shared/rules.js`。
- 不引入与需求无关的依赖；不复制原包代码/图片。

## 8. 提交前检查

1. `npm test` 与 `pytest` 全绿。
2. 浏览器走一遍完整流程（含成员视角的实时更新）。
3. 改了规则/赛制/接口，同步 `docs/` 与本文第 3 节。
