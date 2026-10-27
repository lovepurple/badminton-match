(function () {
  "use strict";
  const rules =
    typeof require === "function" && typeof module !== "undefined"
      ? require("./rules.js")
      : globalThis.BA.rules;

  /*
   * 对阵生成：服务端算法未随包下发（云函数 preview/start_*），
   * 这里按小程序对每种赛制的定义重新实现，语义与包内文案一致。
   */

  /* 轮转法：n 个实体，返回 n-1 轮，每轮 n/2 组对位（含轮空则少一组） */
  function circleRounds(n) {
    var ids = [];
    for (var i = 1; i <= n; i++) ids.push(i);
    if (n % 2 !== 0) ids.push(null);
    var m = ids.length,
      rounds = [],
      arr = ids.slice();
    for (var r = 0; r < m - 1; r++) {
      var pairs = [];
      for (var k = 0; k < m / 2; k++) {
        var a = arr[k],
          b = arr[m - 1 - k];
        if (a != null && b != null) pairs.push([a, b]);
      }
      rounds.push(pairs);
      arr = [arr[0], arr[m - 1]].concat(arr.slice(1, m - 1));
    }
    return rounds;
  }

  function chunk(list, size) {
    var out = [];
    for (var i = 0; i < list.length; i += size)
      out.push(list.slice(i, i + size));
    return out;
  }

  /* 双打配对：fixed 用已有搭档，random 随机，bylevel 强弱互补 */
  function makePairs(players, partnerMode) {
    var list = players.slice();
    if (partnerMode === "random") {
      for (var i = list.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = list[i];
        list[i] = list[j];
        list[j] = t;
      }
    } else if (partnerMode === "bylevel") {
      list.sort(function (a, b) {
        return (b.level || 0) - (a.level || 0);
      });
      var head = list.slice(0, Math.floor(list.length / 2));
      var tail = list.slice(Math.floor(list.length / 2)).reverse();
      var mixed = [];
      for (var k = 0; k < head.length; k++) {
        mixed.push(head[k]);
        if (tail[k]) mixed.push(tail[k]);
      }
      list = mixed;
    }
    var pairs = [];
    for (var p = 0; p + 1 < list.length; p += 2)
      pairs.push([list[p].id, list[p + 1].id]);
    return pairs;
  }

  /* 把「搭档」贪心排进每轮：同一轮里选手不重复，4 人一场 */
  function greedyCourts(partnerships, playerCount) {
    var perRound = Math.max(1, Math.floor(playerCount / 4));
    var used = partnerships.map(function () {
      return false;
    });
    var out = [],
      round = 1;
    var remaining = partnerships.length;
    while (remaining > 0) {
      var busy = {},
        courts = [];
      for (
        var i = 0;
        i < partnerships.length && courts.length < perRound;
        i++
      ) {
        if (used[i]) continue;
        var ps = partnerships[i];
        if (busy[ps[0]] || busy[ps[1]]) continue;
        /* 找到同一轮里另一个可用搭档组成一场 */
        for (var j = i + 1; j < partnerships.length; j++) {
          if (used[j]) continue;
          var qs = partnerships[j];
          if (
            busy[qs[0]] ||
            busy[qs[1]] ||
            qs[0] === ps[0] ||
            qs[0] === ps[1] ||
            qs[1] === ps[0] ||
            qs[1] === ps[1]
          )
            continue;
          used[i] = used[j] = true;
          busy[ps[0]] = busy[ps[1]] = busy[qs[0]] = busy[qs[1]] = true;
          courts.push({
            side1: ps,
            side2: qs,
          });
          remaining -= 2;
          break;
        }
      }
      if (!courts.length) break;
      for (var c = 0; c < courts.length; c++) {
        out.push({
          round: round,
          court: c + 1,
          side1: courts[c].side1,
          side2: courts[c].side2,
        });
      }
      round++;
    }
    return out;
  }

  function roundRobinMatches(entities, doubleLoop) {
    var rounds = circleRounds(entities.length),
      out = [];
    for (var r = 0; r < rounds.length; r++) {
      for (var i = 0; i < rounds[r].length; i++) {
        var pr = rounds[r][i];
        out.push({
          round: r + 1,
          court: i + 1,
          side1: entities[pr[0] - 1],
          side2: entities[pr[1] - 1],
        });
      }
    }
    if (doubleLoop) {
      var legs = rounds.length;
      for (var r2 = 0; r2 < rounds.length; r2++) {
        for (var j = 0; j < rounds[r2].length; j++) {
          var pr2 = rounds[r2][j];
          out.push({
            round: legs + r2 + 1,
            court: j + 1,
            side1: entities[pr2[1] - 1],
            side2: entities[pr2[0] - 1],
          });
        }
      }
    }
    return out;
  }

  function eightMatches(players) {
    var rounds = circleRounds(players.length),
      out = [];
    for (var r = 0; r < rounds.length; r++) {
      var pairs = rounds[r].map(function (pr) {
        return [players[pr[0] - 1].id, players[pr[1] - 1].id];
      });
      var courts = chunk(pairs, 2);
      for (var c = 0; c < courts.length; c++) {
        if (courts[c].length < 2) continue;
        out.push({
          round: r + 1,
          court: c + 1,
          side1: courts[c][0],
          side2: courts[c][1],
        });
      }
    }
    return out;
  }

  function fixedCountMatches(entities, cap) {
    var rounds = circleRounds(entities.length),
      out = [],
      played = entities.map(function () {
        return 0;
      });
    var limit = cap || entities.length - 1;
    for (var r = 0; r < rounds.length; r++) {
      var any = false;
      for (var i = 0; i < rounds[r].length; i++) {
        var pr = rounds[r][i];
        if (played[pr[0] - 1] >= limit || played[pr[1] - 1] >= limit) continue;
        played[pr[0] - 1]++;
        played[pr[1] - 1]++;
        any = true;
        out.push({
          round: r + 1,
          court: i + 1,
          side1: entities[pr[0] - 1],
          side2: entities[pr[1] - 1],
        });
      }
      if (!any) break;
    }
    return out;
  }

  function arenaMatches(entities, kings) {
    var k = Math.max(1, Math.min(kings || 1, entities.length - 1));
    var holders = entities.slice(0, k),
      challengers = entities.slice(k);
    var out = [],
      round = 1;
    for (var i = 0; i < challengers.length; i++) {
      for (var j = 0; j < holders.length; j++) {
        out.push({
          round:
            round +
            Math.floor(
              (i * holders.length + j) /
                Math.max(1, Math.floor(entities.length / 4)),
            ),
          court: (j % 2) + 1,
          side1: holders[j],
          side2: challengers[i],
        });
      }
    }
    return out;
  }

  function teamPairList(team, mode) {
    if (mode === "singles")
      return team.players.map(function (id) {
        return [id];
      });
    var pairs = [];
    for (var i = 0; i + 1 < team.players.length; i += 2)
      pairs.push([team.players[i], team.players[i + 1]]);
    return pairs;
  }

  function crossMatches(a, b) {
    var out = [],
      round = 1;
    for (var i = 0; i < a.length; i++) {
      for (var j = 0; j < b.length; j++) {
        out.push({
          round: round,
          court: (j % 2) + 1,
          side1: a[i],
          side2: b[j],
        });
        if (j % 2 === 1) round++;
      }
    }
    return out;
  }

  function rotationCross(teamA, teamB, singles) {
    var ra = circleRounds(teamA.players.length),
      rb = circleRounds(teamB.players.length);
    var out = [],
      rounds = Math.min(ra.length, rb.length);
    for (var r = 0; r < rounds; r++) {
      var pa = singles
        ? ra[r].map(function (p) {
            return [teamA.players[p[0] - 1]];
          })
        : ra[r].map(function (p) {
            return [teamA.players[p[0] - 1], teamA.players[p[1] - 1]];
          });
      var pb = singles
        ? rb[r].map(function (p) {
            return [teamB.players[p[0] - 1]];
          })
        : rb[r].map(function (p) {
            return [teamB.players[p[0] - 1], teamB.players[p[1] - 1]];
          });
      for (var i = 0; i < Math.min(pa.length, pb.length); i++) {
        out.push({
          round: r + 1,
          court: i + 1,
          side1: pa[i],
          side2: pb[i],
        });
      }
    }
    return out;
  }

  /* 团体赛：队队循环，每场对抗拆成 N 个单项 */
  function teamsMatches(race, mode) {
    var teams = race.teams || [];
    var out = [],
      round = 1;
    for (var i = 0; i < teams.length; i++) {
      for (var j = i + 1; j < teams.length; j++) {
        var a = teams[i],
          b = teams[j];
        var list;
        if (mode === "singlesTeams")
          list = crossMatches(
            teamPairList(a, "singles"),
            teamPairList(b, "singles"),
          );
        else if (mode === "wheelTeams") list = rotationCross(a, b, false);
        else
          list = crossMatches(
            teamPairList(a, "doubles"),
            teamPairList(b, "doubles"),
          );
        for (var k = 0; k < list.length; k++) {
          out.push({
            round: round,
            court: list[k].court,
            side1: list[k].side1,
            side2: list[k].side2,
            teamA: i,
            teamB: j,
          });
        }
        round += Math.max(1, Math.ceil(list.length / 2));
      }
    }
    return out;
  }

  function promoteGroups(players, groupSize) {
    var sorted = players.slice();
    var groups = [],
      size = groupSize || 4;
    for (var i = 0; i < sorted.length; i += size)
      groups.push(sorted.slice(i, i + size));
    return groups;
  }

  function generate(race) {
    var players = race.players || [];
    var mode = race.mode;
    var base = mode;
    if (mode === "singlesLoop") base = "loop";
    if (mode === "singlesArena") base = "arena";
    if (mode === "singlesDoubleLoop") base = "doubleLoop";
    if (mode === "freeRoundSingles") base = "freeRound";

    var singles =
      mode.indexOf("singles") === 0 ||
      mode === "singlesRound" ||
      mode === "singlesMatch";

    switch (base) {
      case "eight":
        return eightMatches(players);
      case "mixRound": {
        var males = players.filter(function (p) {
          return p.gender !== "F";
        });
        var females = players.filter(function (p) {
          return p.gender === "F";
        });
        var ps = [];
        males.forEach(function (m) {
          females.forEach(function (f) {
            ps.push([m.id, f.id]);
          });
        });
        return greedyCourts(ps, players.length);
      }
      case "weakStrong": {
        var sorted = players.slice().sort(function (a, b) {
          return (b.level || 0) - (a.level || 0);
        });
        var half = Math.ceil(sorted.length / 2);
        var front = sorted.slice(0, half),
          back = sorted.slice(half);
        var ws = [];
        front.forEach(function (f) {
          back.forEach(function (b) {
            ws.push([f.id, b.id]);
          });
        });
        return greedyCourts(ws, players.length);
      }
      case "fixedRound": {
        var pairs =
          race.teams && race.teams.length
            ? race.teams.map(function (t) {
                return t.players.slice();
              })
            : makePairs(players, race.partnerMode);
        return fixedCountMatches(pairs, race.matchesPerEntity);
      }
      case "singlesRound": {
        var ents = players.map(function (p) {
          return [p.id];
        });
        return fixedCountMatches(ents, race.matchesPerEntity);
      }
      case "loop": {
        var entities = singles
          ? players.map(function (p) {
              return [p.id];
            })
          : makePairs(players, race.partnerMode);
        return roundRobinMatches(entities, false);
      }
      case "doubleLoop": {
        var entities2 = singles
          ? players.map(function (p) {
              return [p.id];
            })
          : makePairs(players, race.partnerMode);
        return roundRobinMatches(entities2, true);
      }
      case "arena": {
        var ents3 = singles
          ? players.map(function (p) {
              return [p.id];
            })
          : makePairs(players, race.partnerMode);
        return arenaMatches(ents3, race.arenaKings || 1);
      }
      case "freeRound":
        return [];
      case "fixedMatch": {
        var t = race.teams || [];
        if (t.length < 2) return [];
        return crossMatches(
          teamPairList(t[0], "doubles"),
          teamPairList(t[1], "doubles"),
        );
      }
      case "singlesMatch": {
        var t2 = race.teams || [];
        if (t2.length < 2) return [];
        return crossMatches(
          teamPairList(t2[0], "singles"),
          teamPairList(t2[1], "singles"),
        );
      }
      case "wheelMatch":
      case "teamRound": {
        var t3 = race.teams || [];
        if (t3.length < 2) return [];
        return rotationCross(t3[0], t3[1], false);
      }
      case "relayMatch": {
        var t4 = race.teams || [];
        if (t4.length < 2) return [];
        var list = rotationCross(t4[0], t4[1], false);
        list.forEach(function (m, i) {
          m.round = i + 1;
        });
        return list;
      }
      case "freeMatch":
        return [];
      case "fixedTeams":
      case "singlesTeams":
      case "wheelTeams":
        return teamsMatches(race, base);
      case "promote": {
        var groups = promoteGroups(players, race.groupSize || 4);
        var out = [],
          round = 1;
        groups.forEach(function (g) {
          var ents4 = singles
            ? g.map(function (p) {
                return [p.id];
              })
            : makePairs(g, race.partnerMode);
          var ms = roundRobinMatches(ents4, false);
          ms.forEach(function (m) {
            m.group = groups.indexOf(g);
            m.round = round + m.round - 1;
            out.push(m);
          });
          round += circleRounds(ents4.length).length;
        });
        return out;
      }
      default:
        return [];
    }
  }

  /* 排名主体：个人赛按人，对抗/团体按队 */
  function entityKind(mode) {
    var m = rules.MODES[mode];
    if (!m) return "player";
    if (m.group === "match" || m.group === "teams") return "team";
    return "player";
  }

  /* 玩法模块可复用的底层原语（新玩法优先组合这些，而不是重写轮转算法） */
  const formatsApi = {
    generate: generate,
    entityKind: entityKind,
    circleRounds: circleRounds,
    chunk: chunk,
    makePairs: makePairs,
    greedyCourts: greedyCourts,
    roundRobinMatches: roundRobinMatches,
    eightMatches: eightMatches,
    fixedCountMatches: fixedCountMatches,
    arenaMatches: arenaMatches,
    crossMatches: crossMatches,
    rotationCross: rotationCross,
    teamPairList: teamPairList,
    teamsMatches: teamsMatches,
    promoteGroups: promoteGroups,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = formatsApi;
  } else {
    (globalThis.BA = globalThis.BA || {}).formats = formatsApi;
  }
})();
