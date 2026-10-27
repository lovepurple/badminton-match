/*
 * 玩法：双循环积分赛
 * 每对/每位选手跟其他选手各对阵两次（主客场式）。
 */
(function () {
  "use strict";
  const fmt =
    typeof require === "function" && typeof module !== "undefined"
      ? require("../formats.js")
      : globalThis.BA.formats;

  const play = {
    id: "doubleLoop",
    name: "双循环积分赛",
    group: "doubles",
    min: 2,
    max: 10,
    intro: "每对选手跟其他选手各对阵2次",
    tags: ["循环赛", "双打"],
    rules: {
      people: "2 - 10 人，双打（按搭档方式分组）",
      how: "每对组合与其他组合各打两场",
      groups: "先排一遍单循环，再排一遍顺序相反的对位",
      end: "所有组合两两交手两次后结束",
      score: "默认三局两胜、每局 21 分、需领先 2 分、30 分封顶"
    },
    defaults: { rounds: 3, balls: 21, rankMode: "pointFirst", partnerMode: "random" },
    schedule(race) {
      const entities = fmt.makePairs(race.players || [], race.partnerMode);
      return fmt.roundRobinMatches(entities, true);
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = play;
  else (globalThis.BA.playsQueue = globalThis.BA.playsQueue || []).push(play);
})();
