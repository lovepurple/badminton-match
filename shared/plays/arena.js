/*
 * 玩法：擂台赛
 * 擂主与每一对攻擂者各打一场。
 */
(function () {
  "use strict";
  const fmt =
    typeof require === "function" && typeof module !== "undefined"
      ? require("../formats.js")
      : globalThis.BA.formats;

  const play = {
    id: "arena",
    name: "擂台赛",
    group: "doubles",
    min: 2,
    max: 30,
    intro: "擂主和每对攻擂选手各对阵1次",
    tags: ["擂台", "双打"],
    rules: {
      people: "2 - 30 人，双打",
      how: "擂主守擂，其余组合依次攻擂，各打一场",
      groups: "前「擂主人数」对当擂主，其余为攻擂方，逐场排位",
      end: "所有攻擂组合都挑战过擂主后结束",
      score: "默认三局两胜、每局 21 分、需领先 2 分、30 分封顶"
    },
    defaults: { rounds: 3, balls: 21, rankMode: "pointFirst", arenaKings: 1 },
    schedule(race) {
      const entities = fmt.makePairs(race.players || [], race.partnerMode);
      return fmt.arenaMatches(entities, race.arenaKings || 1);
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = play;
  else (globalThis.BA.playsQueue = globalThis.BA.playsQueue || []).push(play);
})();
