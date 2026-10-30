/*
 * 逻辑层回归测试：node tests/logic.test.js
 * 只覆盖不依赖 wx API 的规则 / 赛制 / 排名模块。
 */
const assert = require("assert");
const rules = require("../shared/rules.js");
const formats = require("../shared/formats.js");
const ranking = require("../shared/ranking.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok   " + name);
  } catch (e) {
    console.error("  FAIL " + name);
    console.error("       " + e.message);
    process.exitCode = 1;
  }
}

function players(n, genders) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: "p" + i,
      name: "P" + i,
      gender: genders ? genders[i % genders.length] : i % 2 ? "F" : "M",
      level: i,
    });
  }
  return out;
}

function pairsOf(matches) {
  const seen = {};
  matches.forEach((m) => {
    [m.side1, m.side2].forEach((side) => {
      const key = side.slice().sort().join("+");
      seen[key] = (seen[key] || 0) + 1;
    });
  });
  return seen;
}

console.log("规则常量");
test("局数选项为 1/3/5", () => {
  assert.deepStrictEqual(
    rules.ROUNDS.map((r) => r.value),
    [1, 3, 5],
  );
});
test("分制选项与源码一致", () => {
  assert.deepStrictEqual(
    rules.BALLS,
    [7, 10, 11, 15, 16, 18, 20, 21, 25, 30, 31, 35, 41, 42],
  );
});
test("30 分以上带换边提示", () => {
  assert.strictEqual(rules.ballsName(30), "每局30分（15分换边）");
  assert.strictEqual(rules.ballsName(21), "每局21分");
});
test("快捷比分为 0.5/0.77/满分 取偶", () => {
  assert.deepStrictEqual(rules.quickScores(21, 3, false), [12, 16, 21]);
  assert.deepStrictEqual(rules.quickScores(15, 3, false), [8, 12, 15]);
});
test("追分模式快捷比分叠加 (order-1)*balls", () => {
  assert.deepStrictEqual(rules.quickScores(21, 3, true), [54, 58, 63]);
});

console.log("单局判定");
test("0:0 非法", () => {
  assert.strictEqual(rules.judgeSet([0, 0], 21).kind, "invalid");
});
test("平局非法", () => {
  assert.strictEqual(rules.judgeSet([20, 20], 21).kind, "invalid");
});
test("未满分给出提示", () => {
  const r = rules.judgeSet([15, 12], 21);
  assert.strictEqual(r.kind, "warn");
  assert.ok(r.reason.indexOf("未满21分") >= 0);
});
test("分差不足 2 分给出提示", () => {
  assert.strictEqual(rules.judgeSet([21, 20], 21).kind, "warn");
  assert.strictEqual(rules.judgeSet([22, 20], 21).kind, "ok");
});
test("30 分封顶后不再要求 2 分差", () => {
  assert.strictEqual(rules.judgeSet([30, 29], 21).kind, "ok");
  assert.strictEqual(rules.judgeSet([29, 29], 21).kind, "invalid");
});
test("21:19 判定左侧胜", () => {
  assert.deepStrictEqual(rules.judgeSet([21, 19], 21), {
    kind: "ok",
    winner: 0,
  });
});

console.log("追分判定");
test("未满满分阻断", () => {
  assert.strictEqual(rules.judgeChase([30, 20], 63).kind, "blocked");
});
test("平局与 0:0 非法", () => {
  assert.strictEqual(rules.judgeChase([0, 0], 63).kind, "invalid");
  assert.strictEqual(rules.judgeChase([10, 10], 63).kind, "invalid");
});
test("达到满分判定胜负", () => {
  assert.deepStrictEqual(rules.judgeChase([63, 40], 63), {
    kind: "ok",
    winner: 0,
  });
});

console.log("局数判定");
test("三局两胜先到 2 局结束", () => {
  assert.strictEqual(
    rules.judgeMatch(
      [
        [21, 10],
        [21, 15],
      ],
      [2, 0],
      3,
    ).done,
    true,
  );
});
test("1:1 后继续", () => {
  assert.strictEqual(
    rules.judgeMatch(
      [
        [21, 10],
        [15, 21],
      ],
      [1, 1],
      3,
    ).done,
    false,
  );
});
test("打满约定局数结束", () => {
  assert.strictEqual(
    rules.judgeMatch(
      [
        [21, 10],
        [15, 21],
        [21, 19],
      ],
      [2, 1],
      3,
    ).done,
    true,
  );
});

console.log("让分表");
test("21 分制男单让女 5 分", () => {
  const ps = [
    { id: "m", name: "M", gender: "M" },
    { id: "f", name: "F", gender: "F" },
  ];
  assert.deepStrictEqual(rules.cedePoint(["f"], ["m"], ps, 21), {
    side: 0,
    points: 5,
  });
});
test("15 分制男双让混双 3 分", () => {
  const ps = [
    { id: "m1", gender: "M" },
    { id: "m2", gender: "M" },
    { id: "m3", gender: "M" },
    { id: "f1", gender: "F" },
  ];
  assert.deepStrictEqual(rules.cedePoint(["m1", "m2"], ["m3", "f1"], ps, 15), {
    side: 1,
    points: 3,
  });
});
test("性别相同无让分", () => {
  const ps = [
    { id: "a", gender: "M" },
    { id: "b", gender: "M" },
  ];
  assert.strictEqual(rules.cedePoint(["a"], ["b"], ps, 21), null);
});
test("未列入让分表的分制返回 null", () => {
  const ps = [
    { id: "a", gender: "M" },
    { id: "b", gender: "F" },
  ];
  assert.strictEqual(rules.cedePoint(["a"], ["b"], ps, 20), null);
});

console.log("赛制生成");
test("八人转：7 轮 14 场，搭档不重复", () => {
  const ms = formats.generate({
    mode: "eight",
    players: players(8),
    teams: [],
  });
  assert.strictEqual(ms.length, 14);
  assert.strictEqual(new Set(ms.map((m) => m.round)).size, 7);
  const seen = pairsOf(ms);
  assert.strictEqual(Object.keys(seen).length, 28); // C(8,2)
  Object.keys(seen).forEach((k) => assert.strictEqual(seen[k], 1, k));
});
test("单循环双打：4 对选手 6 场", () => {
  const ms = formats.generate({
    mode: "loop",
    players: players(8),
    partnerMode: "fixed",
    teams: [],
  });
  assert.strictEqual(ms.length, 6);
});
test("双循环双打：4 对选手 12 场", () => {
  const ms = formats.generate({
    mode: "doubleLoop",
    players: players(8),
    partnerMode: "fixed",
    teams: [],
  });
  assert.strictEqual(ms.length, 12);
});
test("混双转：每对男女搭档只出现一次", () => {
  const ps = players(8, ["M", "M", "M", "M", "F", "F", "F", "F"]);
  const ms = formats.generate({ mode: "mixRound", players: ps, teams: [] });
  const seen = pairsOf(ms);
  const maleIds = ps.filter((p) => p.gender === "M").map((p) => p.id);
  const femaleIds = ps.filter((p) => p.gender === "F").map((p) => p.id);
  maleIds.forEach((m) =>
    femaleIds.forEach((f) => {
      const key = [m, f].sort().join("+");
      assert.strictEqual(seen[key], 1, key);
    }),
  );
});
test("固搭转：每对组合出场次数不超过设定值", () => {
  const ms = formats.generate({
    mode: "fixedRound",
    players: players(8),
    partnerMode: "fixed",
    matchesPerEntity: 2,
    teams: [],
  });
  const counts = {};
  ms.forEach((m) =>
    [m.side1, m.side2].forEach((s) => {
      const k = s.slice().sort().join("+");
      counts[k] = (counts[k] || 0) + 1;
    }),
  );
  Object.keys(counts).forEach((k) =>
    assert.ok(counts[k] <= 2, k + "=" + counts[k]),
  );
});
test("单打转：每位选手出场次数不超过设定值", () => {
  const ms = formats.generate({
    mode: "singlesRound",
    players: players(5),
    matchesPerEntity: 2,
    teams: [],
  });
  const counts = {};
  ms.forEach((m) =>
    [m.side1[0], m.side2[0]].forEach((id) => {
      counts[id] = (counts[id] || 0) + 1;
    }),
  );
  Object.keys(counts).forEach((k) => assert.ok(counts[k] <= 2, k));
});
test("擂台赛：擂主对阵每位攻擂者", () => {
  const ps = players(5);
  const ms = formats.generate({
    mode: "singlesArena",
    players: ps,
    arenaKings: 1,
    teams: [],
  });
  assert.strictEqual(ms.length, 4);
  ms.forEach((m) => assert.ok(m.side1.indexOf("p0") >= 0));
});
test("固搭对抗赛：队间组合两两对阵", () => {
  const ps = players(4);
  const ms = formats.generate({
    mode: "fixedMatch",
    players: ps,
    teams: [
      { name: "A", players: ["p0", "p1"] },
      { name: "B", players: ["p2", "p3"] },
    ],
  });
  assert.strictEqual(ms.length, 1);
  assert.deepStrictEqual(ms[0].side1, ["p0", "p1"]);
  assert.deepStrictEqual(ms[0].side2, ["p2", "p3"]);
});
test("单打对抗赛：队间选手两两对阵", () => {
  const ps = players(4);
  const ms = formats.generate({
    mode: "singlesMatch",
    players: ps,
    teams: [
      { name: "A", players: ["p0", "p1"] },
      { name: "B", players: ["p2", "p3"] },
    ],
  });
  assert.strictEqual(ms.length, 4);
});
test("自由转不自动生成对阵", () => {
  assert.strictEqual(
    formats.generate({ mode: "freeRound", players: players(4), teams: [] })
      .length,
    0,
  );
});

console.log("积分与排名");
test("单局赛制胜 2 分，多局按净胜局", () => {
  assert.deepStrictEqual(rules.matchPoints([[21, 10]]), [2, 0]);
  assert.deepStrictEqual(
    rules.matchPoints([
      [21, 10],
      [21, 15],
    ]),
    [2, 0],
  );
  assert.deepStrictEqual(
    rules.matchPoints([
      [21, 10],
      [15, 21],
      [21, 19],
    ]),
    [1, 0],
  );
  assert.deepStrictEqual(
    rules.matchPoints([
      [21, 10],
      [15, 21],
    ]),
    [1, 1],
  );
});
test("积分优先排序：积分 > 胜场 > 净胜分", () => {
  const race = {
    mode: "loop",
    partnerMode: "fixed",
    rankMode: "pointFirst",
    players: players(4),
    teams: [],
    matches: [
      {
        side1: ["p0"],
        side2: ["p1"],
        scores: [
          [21, 10],
          [21, 10],
        ],
        scoreAll: [2, 0],
      },
      {
        side1: ["p0"],
        side2: ["p2"],
        scores: [
          [21, 10],
          [21, 10],
        ],
        scoreAll: [2, 0],
      },
      {
        side1: ["p1"],
        side2: ["p2"],
        scores: [
          [21, 10],
          [15, 21],
          [21, 19],
        ],
        scoreAll: [2, 1],
      },
    ],
  };
  const rows = ranking.compute(race).rows;
  assert.strictEqual(rows[0].name, "P0");
  assert.strictEqual(rows[0].point, 4);
  assert.strictEqual(rows[0].wins, 2);
});
test("胜场优先：胜场数决定名次", () => {
  const race = {
    mode: "loop",
    partnerMode: "fixed",
    rankMode: "winsFirst",
    players: players(3),
    teams: [],
    matches: [
      {
        side1: ["p0"],
        side2: ["p1"],
        scores: [
          [21, 19],
          [21, 19],
        ],
        scoreAll: [2, 0],
      },
      {
        side1: ["p2"],
        side2: ["p1"],
        scores: [
          [21, 10],
          [21, 10],
        ],
        scoreAll: [2, 0],
      },
    ],
  };
  const rows = ranking.compute(race).rows;
  assert.strictEqual(rows[0].wins, 1);
  assert.strictEqual(rows[rows.length - 1].name, "P1");
});
test("个人战绩按名字统计", () => {
  const races = [
    {
      mode: "loop",
      partnerMode: "fixed",
      players: [
        { id: "a", name: "阿豪" },
        { id: "b", name: "小林" },
      ],
      matches: [
        {
          side1: ["a"],
          side2: ["b"],
          scores: [
            [21, 10],
            [21, 10],
          ],
          scoreAll: [2, 0],
        },
        {
          side1: ["b"],
          side2: ["a"],
          scores: [
            [21, 10],
            [21, 10],
          ],
          scoreAll: [2, 0],
        },
      ],
    },
  ];
  const s = ranking.personalStats(races, "阿豪");
  assert.strictEqual(s.total.alls, 2);
  assert.strictEqual(s.total.wins, 1);
  assert.strictEqual(s.total.fail, 1);
  assert.strictEqual(s.rounds, 4);
});

test("个人战绩按 userId 统计（改昵称不丢历史）", () => {
  const races = [
    {
      mode: "loop",
      partnerMode: "fixed",
      players: [
        { id: "u1", name: "老张" },
        { id: "u2", name: "小李" },
      ],
      matches: [
        {
          side1: ["u1"],
          side2: ["u2"],
          scores: [[21, 15]],
          scoreAll: [1, 0],
        },
      ],
    },
  ];
  // 按 userId 匹配：即使名字完全对不上也能统计到
  const byId = ranking.personalStats(races, "改过的昵称", "u1");
  assert.strictEqual(byId.total.alls, 1);
  assert.strictEqual(byId.total.wins, 1);
  assert.strictEqual(byId.userId, "u1");

  // 名字对不上且不给 userId：统计不到
  const miss = ranking.personalStats(races, "改过的昵称");
  assert.strictEqual(miss.total.alls, 0);

  // 旧用法（只给名字）仍然可用
  const byName = ranking.personalStats(races, "老张");
  assert.strictEqual(byName.total.wins, 1);
});

console.log("\n" + passed + " passed");
