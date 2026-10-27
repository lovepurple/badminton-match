/*
 * 玩法：单循环积分赛
 * 每对/每位选手跟其他选手各对阵一次。
 */
(function () {
  "use strict";
  const fmt =
    typeof require === "function" && typeof module !== "undefined"
      ? require("../formats.js")
      : globalThis.BA.formats;

  const play = {
    id: "loop",
    name: "单循环积分赛",
    group: "doubles",
    min: 2,
    max: 20,
    intro: "每对选手跟其他选手各对阵1次",
    tags: ["循环赛", "双打"],
    rules: {
      people: "2 - 20 人，双打（按搭档方式分组）",
      how: "每对组合与其他组合各打一场",
      groups: "轮转法排出全部对位（人数为奇数时自动轮空）",
      end: "所有组合两两交手一次后结束",
      score: "默认三局两胜、每局 21 分、需领先 2 分、30 分封顶"
    },
    defaults: { rounds: 3, balls: 21, rankMode: "pointFirst", partnerMode: "random" },
    schedule(race) {
      const entities = fmt.makePairs(race.players || [], race.partnerMode);
      return fmt.roundRobinMatches(entities, false);
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = play;
  else (globalThis.BA.playsQueue = globalThis.BA.playsQueue || []).push(play);
})();
