/*
 * 玩法：八人转 / 超八转
 * 规则来源：原小程序「羽毛球助手」的 eight 赛制。
 */
(function () {
  "use strict";
  const fmt =
    typeof require === "function" && typeof module !== "undefined"
      ? require("../formats.js")
      : globalThis.BA.formats;

  const play = {
    id: "eight",
    name: "八人转 / 超八转",
    group: "doubles",
    min: 4,
    max: 50,
    intro: "4 - 50人，轮换搭档",
    tags: ["轮转", "双打"],
    rules: {
      people: "4 - 50 人，双打（4 人一场）",
      how: "每人与其他人各搭档一次，每轮换搭档",
      groups: "轮转法排出「人数-1」轮，每轮 floor(人数/4) 场，落单自动轮空",
      end: "打完全部轮次",
      score: "默认三局两胜、每局 21 分、需领先 2 分、30 分封顶"
    },
    defaults: { rounds: 3, balls: 21, rankMode: "pointFirst" },
    schedule(race) {
      return fmt.eightMatches(race.players || []);
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = play;
  else (globalThis.BA.playsQueue = globalThis.BA.playsQueue || []).push(play);
})();
