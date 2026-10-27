/*
 * 玩法：固搭转
 * 固定搭档，每对组合打 N 场。
 */
(function () {
  "use strict";
  const fmt =
    typeof require === "function" && typeof module !== "undefined"
      ? require("../formats.js")
      : globalThis.BA.formats;

  const play = {
    id: "fixedRound",
    name: "固搭转",
    group: "doubles",
    min: 4,
    max: 40,
    intro: "4 - 40人，每对组合比赛N次",
    tags: ["双打", "固定搭档"],
    rules: {
      people: "4 - 40 人，双打（两两固定搭档）",
      how: "搭档固定不变，只换对手",
      groups: "搭档对之间用轮转法排，「每对比赛次数」到量即停",
      end: "每对组合打满设定次数",
      score: "默认三局两胜、每局 21 分、需领先 2 分、30 分封顶"
    },
    defaults: { rounds: 3, balls: 21, rankMode: "pointFirst", matchesPerEntity: 3 },
    schedule(race) {
      const pairs =
        race.teams && race.teams.length
          ? race.teams.map((t) => t.players.slice())
          : fmt.makePairs(race.players || [], race.partnerMode);
      return fmt.fixedCountMatches(pairs, race.matchesPerEntity);
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = play;
  else (globalThis.BA.playsQueue = globalThis.BA.playsQueue || []).push(play);
})();
