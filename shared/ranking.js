(function () {
  "use strict";
  const rules =
    typeof require === "function" && typeof module !== "undefined"
      ? require("./rules.js")
      : globalThis.BA.rules;
  function playApi() {
    if (typeof require === "function" && typeof module !== "undefined") {
      return require("./plays/index.js");
    }
    return globalThis.BA.plays;
  }

  /*
   * 排名：字段与排序链取自 packageC 的 rank.js / 4931CD57...js。
   * 统计口径：_wins/_fail/_even 按场，_winball/_netball/_net 按局，_point 为净胜局积分。
   */

  function emptyStats() {
    return {
      alls: 0,
      wins: 0,
      even: 0,
      fail: 0,
      allRound: 0,
      winRound: 0,
      failRound: 0,
      net: 0,
      allBalls: 0,
      winball: 0,
      failball: 0,
      netball: 0,
      point: 0,
      rate: {
        alls: 0,
        net: 0,
        netball: 0,
      },
    };
  }

  function applySide(stats, sets, wins, fails) {
    stats.alls++;
    if (wins > fails) stats.wins++;
    else if (wins < fails) stats.fail++;
    else stats.even++;

    for (let i = 0; i < sets.length; i++) {
      const a = sets[i][0],
        b = sets[i][1];
      stats.netball += a - b;
      stats.winball += a;
      stats.failball += b;
      stats.allBalls += a + b;
      stats.allRound++;
      if (a > b) {
        stats.winRound++;
        stats.net++;
      } else if (a < b) {
        stats.failRound++;
        stats.net--;
      }
    }
    const pts = rules.matchPoints(sets);
    stats.point += pts[0];
  }

  function finalize(stats) {
    stats.rate.alls = stats.alls ? stats.wins / stats.alls : 0;
    stats.rate.net = stats.allRound ? stats.winRound / stats.allRound : 0;
    stats.rate.netball = stats.allBalls ? stats.winball / stats.allBalls : 0;
    return stats;
  }

  /* 排序链：后一次 sort 为主键（原实现依赖稳定排序，这里直接写成优先级链） */
  var CHAINS = {
    pointFirst: [
      "point",
      "wins",
      "netball",
      "rateAlls",
      "rateNet",
      "rateNetball",
    ],
    ballFirst: [
      "netball",
      "wins",
      "winball",
      "point",
      "rateAlls",
      "rateNet",
      "rateNetball",
    ],
    totalFirst: [
      "winball",
      "netball",
      "wins",
      "point",
      "rateAlls",
      "rateNet",
      "rateNetball",
    ],
    winsFirst: [
      "wins",
      "winsMinusFail",
      "net",
      "point",
      "netball",
      "winball",
      "rateAlls",
      "rateNet",
      "rateNetball",
    ],
  };

  function keyValue(row, key) {
    switch (key) {
      case "rateAlls":
        return row.rate.alls;
      case "rateNet":
        return row.rate.net;
      case "rateNetball":
        return row.rate.netball;
      case "winsMinusFail":
        return row.wins - row.fail;
      default:
        return row[key] || 0;
    }
  }

  function sortRows(rows, rankMode) {
    var chain = CHAINS[rankMode] || CHAINS.pointFirst;
    return rows.slice().sort(function (a, b) {
      for (var i = 0; i < chain.length; i++) {
        var d = keyValue(b, chain[i]) - keyValue(a, chain[i]);
        if (d) return d;
      }
      return 0;
    });
  }

  function teamIndexOf(race, match, side) {
    if (match.teamA != null) return side === 0 ? match.teamA : match.teamB;
    var id = side === 0 ? match.side1[0] : match.side2[0];
    var teams = race.teams || [];
    for (var i = 0; i < teams.length; i++) {
      if (teams[i].players.indexOf(id) >= 0) return i;
    }
    return 0;
  }

  /* 返回 {kind, rows:[{key,name,stats...}]} */
  function compute(race) {
    var kind = playApi().entityKind(race.mode);
    var rows = [],
      index = {};
    var i;

    if (kind === "team") {
      var teams = race.teams || [];
      for (i = 0; i < teams.length; i++) {
        rows.push(
          Object.assign(
            {
              key: "t" + i,
              name: teams[i].name || i + 1 + "队",
            },
            emptyStats(),
          ),
        );
        index["t" + i] = rows.length - 1;
      }
    } else {
      var players = race.players || [];
      for (i = 0; i < players.length; i++) {
        rows.push(
          Object.assign(
            {
              key: players[i].id,
              name: players[i].name,
            },
            emptyStats(),
          ),
        );
        index[players[i].id] = rows.length - 1;
      }
    }

    (race.matches || []).forEach(function (m) {
      if (!m.scoreAll || !m.scores || !m.scores.length) return;
      if (kind === "team") {
        var a = index["t" + teamIndexOf(race, m, 0)];
        var b = index["t" + teamIndexOf(race, m, 1)];
        if (a == null || b == null) return;
        applySide(rows[a], m.scores, m.scoreAll[0], m.scoreAll[1]);
        applySide(
          rows[b],
          m.scores.map(function (s) {
            return [s[1], s[0]];
          }),
          m.scoreAll[1],
          m.scoreAll[0],
        );
      } else {
        m.side1.forEach(function (id) {
          var r = index[id];
          if (r != null)
            applySide(rows[r], m.scores, m.scoreAll[0], m.scoreAll[1]);
        });
        var flipped = m.scores.map(function (s) {
          return [s[1], s[0]];
        });
        m.side2.forEach(function (id) {
          var r = index[id];
          if (r != null)
            applySide(rows[r], flipped, m.scoreAll[1], m.scoreAll[0]);
        });
      }
    });

    rows.forEach(finalize);
    return {
      kind: kind,
      rows: sortRows(rows, race.rankMode),
    };
  }

  /* 个人战绩：跨比赛统计某人的场次/胜率
   *
   * 与 server/app/rules.py 的 personal_stats 保持一致：
   * 优先按 userId 匹配（报名即身份，选手 id 就是用户 id），没有再回退按名字匹配，
   * 这样改昵称后历史战绩不会丢。 */
  function personalStats(races, name, userId) {
    var out = {
      total: {
        alls: 0,
        wins: 0,
        fail: 0,
        even: 0,
      },
      singles: {
        alls: 0,
        wins: 0,
        fail: 0,
        even: 0,
      },
      doubles: {
        alls: 0,
        wins: 0,
        fail: 0,
        even: 0,
      },
      rounds: 0,
    };
    races.forEach(function (race) {
      var singles =
        playApi().entityKind(race.mode) === "player" &&
        (race.mode.indexOf("singles") === 0 || race.mode === "singlesRound");
      (race.matches || []).forEach(function (m) {
        if (!m.scoreAll || !m.scores || !m.scores.length) return;
        var ids = m.side1.concat(m.side2);
        var mine = -1;
        (race.players || []).forEach(function (p) {
          if (ids.indexOf(p.id) < 0) return;
          var hit = (userId && p.id === userId) || (name && p.name === name);
          if (hit) mine = m.side1.indexOf(p.id) >= 0 ? 0 : 1;
        });
        if (mine < 0) return;
        var bucket = singles ? out.singles : out.doubles;
        out.total.alls++;
        bucket.alls++;
        var w =
          m.scoreAll[0] > m.scoreAll[1]
            ? 0
            : m.scoreAll[0] < m.scoreAll[1]
              ? 1
              : -1;
        if (w === -1) {
          out.total.even++;
          bucket.even++;
        } else if (w === mine) {
          out.total.wins++;
          bucket.wins++;
        } else {
          out.total.fail++;
          bucket.fail++;
        }
        out.rounds += (m.scores || []).length;
      });
    });
    out.name = name || "";
    out.userId = userId || null;
    return out;
  }

  const rankingApi = {
    compute: compute,
    sortRows: sortRows,
    personalStats: personalStats,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = rankingApi;
  } else {
    (globalThis.BA = globalThis.BA || {}).ranking = rankingApi;
  }
})();
