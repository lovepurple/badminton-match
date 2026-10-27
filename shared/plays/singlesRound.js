/*
 * 玩法：单打转
 * 每位选手打 N 场单打。
 */
(function () {
  "use strict";
  const fmt =
    typeof require === "function" && typeof module !== "undefined"
      ? require("../formats.js")
      : globalThis.BA.formats;

  const play = {
    id: "singlesRound",
    name: "单打转",
    group: "singles",
    min: 2,
    max: 20,
    intro: "2 - 20人，每位选手比赛N次",
    tags: ["单打"],
    rules: {
      people: "2 - 20 人，单打",
      how: "每位选手与不同对手比赛",
      groups: "轮转法排单打对位，「每人比赛次数」到量即停",
      end: "每位选手打满设定次数",
      score: "默认三局两胜、每局 21 分、需领先 2 分、30 分封顶"
    },
    defaults: { rounds: 3, balls: 21, rankMode: "pointFirst", matchesPerEntity: 3 },
    schedule(race) {
      const ents = (race.players || []).map((p) => [p.id]);
      return fmt.fixedCountMatches(ents, race.matchesPerEntity);
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = play;
  else (globalThis.BA.playsQueue = globalThis.BA.playsQueue || []).push(play);
})();
