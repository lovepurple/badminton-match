/*
 * 玩法：混双转
 * 每名男选手与每名女选手各搭档一次；男女分别排名。
 */
(function () {
  "use strict";
  const fmt =
    typeof require === "function" && typeof module !== "undefined"
      ? require("../formats.js")
      : globalThis.BA.formats;

  const play = {
    id: "mixRound",
    name: "混双转",
    group: "doubles",
    min: 4,
    max: 36,
    intro: "4 - 36人，每男跟每女各搭档1次",
    tags: ["轮转", "混双"],
    rules: {
      people: "4 - 36 人，男女混双",
      how: "每名男选手与每名女选手各搭档一次",
      groups: "先生成全部「男×女」搭档组合，再贪心排轮：同一轮选手不重复，4 人一场",
      end: "所有男女搭档组合都打过一次后结束",
      score: "默认三局两胜、每局 21 分、需领先 2 分、30 分封顶"
    },
    defaults: { rounds: 3, balls: 21, rankMode: "pointFirst" },
    schedule(race) {
      const players = race.players || [];
      const males = players.filter((p) => p.gender !== "F");
      const females = players.filter((p) => p.gender === "F");
      const pairs = [];
      males.forEach((m) =>
        females.forEach((f) => pairs.push([m.id, f.id]))
      );
      return fmt.greedyCourts(pairs, players.length);
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = play;
  else (globalThis.BA.playsQueue = globalThis.BA.playsQueue || []).push(play);
})();
