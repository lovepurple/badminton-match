/*
 * 玩法：前后转
 * 按水平把选手分前后半区，前区与后区各对阵一次；前后分别排名。
 */
(function () {
  "use strict";
  const fmt =
    typeof require === "function" && typeof module !== "undefined"
      ? require("../formats.js")
      : globalThis.BA.formats;

  const play = {
    id: "weakStrong",
    name: "前后转",
    group: "doubles",
    min: 4,
    max: 36,
    intro: "4 - 36人，前半和后半各对阵1次",
    tags: ["轮转", "双打", "强弱搭配"],
    rules: {
      people: "4 - 36 人，双打",
      how: "按水平排序，前一半与后一半各搭档一次（强弱互补）",
      groups: "先生成全部「前区×后区」搭档组合，再贪心排轮，4 人一场",
      end: "所有前后搭档组合都打过一次后结束",
      score: "默认三局两胜、每局 21 分、需领先 2 分、30 分封顶"
    },
    defaults: { rounds: 3, balls: 21, rankMode: "pointFirst" },
    schedule(race) {
      const players = (race.players || []).slice().sort(
        (a, b) => (b.level || 0) - (a.level || 0)
      );
      const half = Math.ceil(players.length / 2);
      const front = players.slice(0, half);
      const back = players.slice(half);
      const pairs = [];
      front.forEach((f) => back.forEach((b) => pairs.push([f.id, b.id])));
      return fmt.greedyCourts(pairs, players.length);
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = play;
  else (globalThis.BA.playsQueue = globalThis.BA.playsQueue || []).push(play);
})();
