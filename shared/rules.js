(function () {
  "use strict";
  /*
   * 规则层：全部数值取自反编译出的 app-service.js（wx5f3f808a2ea7f0a8）。
   * 证据位置见 docs/规则还原.md。
   */

  /* 局数：1/3/5 —— 原文 61301552...js 的 rounds.values / names */
  var ROUNDS = [
    {
      value: 1,
      name: "一局定胜负",
    },
    {
      value: 3,
      name: "三局两胜",
    },
    {
      value: 5,
      name: "五局三胜",
    },
  ];

  /* 分制：balls.values，names_2 里 30 分以上带换边提示 */
  var BALLS = [7, 10, 11, 15, 16, 18, 20, 21, 25, 30, 31, 35, 41, 42];
  var SIDE_SWITCH = {
    30: 15,
    31: 16,
    35: 18,
    41: 20,
    42: 21,
  };

  /* 追分模式：chase=连续追分，isolate=每局从零开始 */
  var WHEEL_MODES = [
    {
      value: "isolate",
      name: "每局从零开始",
    },
    {
      value: "chase",
      name: "连续追分",
    },
  ];

  /* 搭档模式（双打积分赛）：fixed/random/bylevel */
  var PARTNER_MODES = [
    {
      value: "fixed",
      name: "报名时固搭",
    },
    {
      value: "random",
      name: "随机抽签配对",
    },
    {
      value: "bylevel",
      name: "势均力敌抽签",
    },
  ];

  /* 排名方式：4 种排序，默认 pointFirst */
  var RANK_MODES = [
    {
      value: "pointFirst",
      name: "积分优先",
    },
    {
      value: "ballFirst",
      name: "净胜分优先",
    },
    {
      value: "totalFirst",
      name: "总得分优先",
    },
    {
      value: "winsFirst",
      name: "胜场优先",
    },
  ];

  /* 赛制：name/intro 取自 packageC 的 config 与 packageB 的 switchList */
  var MODES = {
    eight: {
      name: "八人转 / 超八转",
      intro: "4 - 50人，轮换搭档",
      group: "doubles",
      min: 4,
      max: 50,
    },
    mixRound: {
      name: "混双转",
      intro: "4 - 36人，每男跟每女各搭档1次",
      group: "doubles",
      min: 4,
      max: 36,
    },
    fixedRound: {
      name: "固搭转",
      intro: "4 - 40人，每对组合比赛N次",
      group: "doubles",
      min: 4,
      max: 40,
    },
    freeRound: {
      name: "自由转",
      intro: "2 - 50人，自由安排选手对阵",
      group: "doubles",
      min: 2,
      max: 50,
    },
    loop: {
      name: "单循环积分赛",
      intro: "每对选手跟其他选手各对阵1次",
      group: "doubles",
      min: 2,
      max: 20,
    },
    weakStrong: {
      name: "前后转",
      intro: "4 - 36人，前半和后半各对阵1次",
      group: "doubles",
      min: 4,
      max: 36,
    },
    doubleLoop: {
      name: "双循环积分赛",
      intro: "每对选手跟其他选手各对阵2次",
      group: "doubles",
      min: 2,
      max: 10,
    },
    arena: {
      name: "擂台赛",
      intro: "擂主和每对攻擂选手各对阵1次",
      group: "doubles",
      min: 2,
      max: 30,
    },
    singlesRound: {
      name: "单打转",
      intro: "2 - 20人，每位选手比赛N次",
      group: "singles",
      min: 2,
      max: 20,
    },
    freeRoundSingles: {
      name: "自由转",
      intro: "2 - 50人，自由安排选手对阵",
      group: "singles",
      min: 2,
      max: 50,
    },
    singlesLoop: {
      name: "单循环积分赛",
      intro: "每位选手和其他选手各比赛1次",
      group: "singles",
      min: 2,
      max: 20,
    },
    singlesArena: {
      name: "擂台赛",
      intro: "擂主和每位攻擂选手各比赛1次",
      group: "singles",
      min: 2,
      max: 30,
    },
    singlesDoubleLoop: {
      name: "双循环积分赛",
      intro: "每位选手和其他选手各比赛2次",
      group: "singles",
      min: 2,
      max: 10,
    },
    teamRound: {
      name: "小队转",
      intro: "每队2-20人，队内各搭档1次",
      group: "match",
      min: 2,
      max: 20,
    },
    wheelMatch: {
      name: "轮比转",
      intro: "每队2-16人，队内前后轮转搭档",
      group: "match",
      min: 2,
      max: 16,
    },
    freeMatch: {
      name: "自由对抗赛",
      intro: "每队2-18人，自由安排选手对阵",
      group: "match",
      min: 2,
      max: 25,
    },
    fixedMatch: {
      name: "固搭对抗赛",
      intro: "每队2-20人，队间固搭各对阵1次",
      group: "match",
      min: 1,
      max: 10,
    },
    relayMatch: {
      name: "接力赛",
      intro: "自由安排选手对阵，按顺序接力",
      group: "match",
      min: 2,
      max: 25,
    },
    singlesMatch: {
      name: "单打对抗赛",
      intro: "每队1-10人，队间选手各对阵1次",
      group: "match",
      min: 1,
      max: 10,
    },
    fixedTeams: {
      name: "固搭团体赛",
      intro: "每队固搭组合，按队伍排名",
      group: "teams",
      min: 3,
      max: 12,
    },
    wheelTeams: {
      name: "轮比团体赛",
      intro: "队内轮转搭档，按队伍排名",
      group: "teams",
      min: 3,
      max: 12,
    },
    singlesTeams: {
      name: "单打团体赛",
      intro: "队间单打，按队伍排名",
      group: "teams",
      min: 3,
      max: 12,
    },
  };

  var GROUPS = [
    {
      key: "doubles",
      name: "双打",
    },
    {
      key: "singles",
      name: "单打",
    },
    {
      key: "match",
      name: "对抗",
    },
    {
      key: "teams",
      name: "团体",
    },
  ];

  /* 默认让分表：源 balls 与四张映射表（record.js _dealCedePoints） */
  var CEDE_BALLS = [7, 11, 15, 16, 18, 21, 25, 31, 35, 42];
  var CEDE_TABLES = {
    singles: [1, 2, 3, 3, 4, 5, 7, 8, 9, 10], // 男 vs 女
    m2f3: [1, 2, 3, 3, 4, 5, 5, 6, 8, 10], // 男男 vs 男女
    m3f4: [2, 3, 4, 4, 5, 6, 7, 8, 10, 12], // 男女 vs 女女
    m2f4: [3, 4, 5, 6, 7, 8, 9, 10, 12, 15], // 男男 vs 女女
  };

  function ballsName(balls) {
    var sw = SIDE_SWITCH[balls];
    return "每局" + balls + "分" + (sw ? "（" + sw + "分换边）" : "");
  }

  function roundsName(rounds) {
    for (var i = 0; i < ROUNDS.length; i++)
      if (ROUNDS[i].value === rounds) return ROUNDS[i].name;
    return rounds + "局";
  }

  function rankName(v) {
    for (var i = 0; i < RANK_MODES.length; i++)
      if (RANK_MODES[i].value === v) return RANK_MODES[i].name;
    return v;
  }

  function modeName(v) {
    return (MODES[v] && MODES[v].name) || v;
  }

  /* 快捷比分：round(0.5*balls) 取偶、round(0.77*balls) 取偶、balls；追分模式叠加 (order-1)*balls */
  function quickScores(balls, order, chase) {
    var a = Math.round(0.5 * balls);
    if (a % 2 !== 0) a++;
    var c = Math.round(0.77 * balls);
    if (c % 2 !== 0) c++;
    var o = balls;
    if (chase) {
      var add = balls * ((order || 1) - 1);
      a += add;
      c += add;
      o += add;
    }
    return [a, c, o];
  }

  /* 单局判定，完全按 _judgeZero/_judgeEqual/_judgeBalls/_judgeDiffer 的顺序 */
  function judgeSet(score, balls) {
    var a = score[0],
      b = score[1];
    if (a === 0 && b === 0)
      return {
        kind: "invalid",
        reason: "羽毛球不支持0:0的比分哦",
      };
    if (a === b)
      return {
        kind: "invalid",
        reason: "羽毛球没有平局，请至少再打一球",
      };
    if (a < balls && b < balls) {
      return {
        kind: "warn",
        reason: "本局未满" + balls + "分，是否继续记分？",
      };
    }
    /* 30 分封顶为源码硬编码：t[0] < 30 && t[1] < 30 */
    if (a < 30 && b < 30 && Math.abs(a - b) < 2) {
      return {
        kind: "warn",
        reason: "分差未达2分，是否继续记分？",
      };
    }
    return {
      kind: "ok",
      winner: a > b ? 0 : 1,
    };
  }

  /* 追分模式判定：_dealForChase */
  function judgeChase(cum, cap) {
    var a = cum[0],
      b = cum[1];
    if (a === 0 && b === 0)
      return {
        kind: "invalid",
        reason: "羽毛球没有0:0的比分哦",
      };
    if (a === b)
      return {
        kind: "invalid",
        reason: "羽毛球没有平局哦，请修改比分",
      };
    if (a < cap && b < cap) {
      return {
        kind: "blocked",
        reason: "本场比赛为连续追分，本局未满" + cap + "分，请继续记分",
      };
    }
    return {
      kind: "ok",
      winner: a > b ? 0 : 1,
    };
  }

  /* 局数是否打完：_judgeRound */
  function judgeMatch(sets, scoreAll, rounds) {
    var played = sets.length;
    if (played >= rounds) {
      return {
        done: true,
        reason:
          played > rounds
            ? "已超约定局数，是否完成记分？"
            : "已到约定局数，是否完成记分？",
      };
    }
    if (
      played > 1 &&
      (scoreAll[0] >= rounds / 2 || scoreAll[1] >= rounds / 2)
    ) {
      return {
        done: true,
        reason: "已到约定局数，是否完成记分？",
      };
    }
    return {
      done: false,
    };
  }

  /* 让分：性别 1=男 2=女，双打用性别和 2=男男 3=男女 4=女女 */
  function genderSum(ids, players) {
    var sum = 0;
    for (var i = 0; i < ids.length; i++) {
      var p = findPlayer(players, ids[i]);
      sum += p && p.gender === "F" ? 2 : 1;
    }
    return sum;
  }

  function findPlayer(players, id) {
    for (var i = 0; i < players.length; i++)
      if (players[i].id === id) return players[i];
    return null;
  }

  function cedePoint(side1, side2, players, balls) {
    var idx = CEDE_BALLS.indexOf(balls);
    if (idx < 0) return null;
    var singles = side1.length === 1 && side2.length === 1;
    var g1 = genderSum(side1, players),
      g2 = genderSum(side2, players);
    if (g1 === g2) return null;
    var table = null,
      weakSide = -1;
    if (singles) {
      table = CEDE_TABLES.singles;
      weakSide = g1 === 1 ? 1 : 0;
    } else {
      var key = Math.min(g1, g2) + "-" + Math.max(g1, g2);
      var map = {
        "2-3": "m2f3",
        "3-4": "m3f4",
        "2-4": "m2f4",
      };
      if (!map[key]) return null;
      table = CEDE_TABLES[map[key]];
      weakSide = g1 < g2 ? 1 : 0;
    }
    return {
      side: weakSide,
      points: table[idx],
    };
  }

  /* 一场比赛的积分：净胜局数；单局赛制胜 2 分、平 1 分（rank.js 的 _point 计算） */
  function matchPoints(sets) {
    var wins = 0,
      losses = 0;
    for (var i = 0; i < sets.length; i++) {
      if (sets[i][0] > sets[i][1]) wins++;
      else if (sets[i][0] < sets[i][1]) losses++;
    }
    var s = wins - losses;
    if (sets.length === 1) {
      if (s > 0) return [2, 0];
      if (s < 0) return [0, 2];
      return [1, 1];
    }
    if (s > 0) return [s, 0];
    if (s < 0) return [0, -s];
    return [1, 1];
  }

  const rulesApi = {
    ROUNDS: ROUNDS,
    BALLS: BALLS,
    SIDE_SWITCH: SIDE_SWITCH,
    WHEEL_MODES: WHEEL_MODES,
    PARTNER_MODES: PARTNER_MODES,
    RANK_MODES: RANK_MODES,
    MODES: MODES,
    GROUPS: GROUPS,
    CEDE_BALLS: CEDE_BALLS,
    CEDE_TABLES: CEDE_TABLES,
    ballsName: ballsName,
    roundsName: roundsName,
    rankName: rankName,
    modeName: modeName,
    quickScores: quickScores,
    judgeSet: judgeSet,
    judgeChase: judgeChase,
    judgeMatch: judgeMatch,
    cedePoint: cedePoint,
    matchPoints: matchPoints,
    findPlayer: findPlayer,
    genderSum: genderSum,
  };

  /* 同时支持小程序 require 与浏览器 <script> 直接加载 */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = rulesApi;
  } else {
    (globalThis.BA = globalThis.BA || {}).rules = rulesApi;
  }
})();
