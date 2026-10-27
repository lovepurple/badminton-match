/*
 * 玩法：追分赛（LLM 新增玩法的示范）
 *
 * 说明：这是「玩法由代码实现 + 通用引擎执行」的最小示例。
 * - 分组/排程：单人轮转对位（每人打 N 场）
 * - 计分：连续追分（整场累计，不分局数），由 scoring.mode = "chase" 交给通用引擎
 * - 结束：一方先到「分制」分且领先 2 分（30 分封顶规则同通用判定）
 */
(function () {
  "use strict";
  const fmt =
    typeof require === "function" && typeof module !== "undefined"
      ? require("../formats.js")
      : globalThis.BA.formats;

  const play = {
    id: "chase",
    name: "追分赛",
    group: "singles",
    min: 2,
    max: 8,
    intro: "2 - 8人，单打连续追分",
    tags: ["单打", "追分"],
    scoring: { mode: "chase" },
    rules: {
      people: "2 - 8 人，单打",
      how: "两人对打，每球得分，整场累计追分，不分局数",
      groups: "轮转法排单打对位，每人打「每人比赛次数」场",
      end: "一方累计到设定分数且领先 2 分（30 分封顶）",
      score: "默认每场 30 分、一局定胜负；整场累计，比分不清零"
    },
    defaults: { rounds: 1, balls: 30, rankMode: "totalFirst", matchesPerEntity: 3 },
    schedule(race) {
      const entities = (race.players || []).map((p) => [p.id]);
      return fmt.fixedCountMatches(entities, race.matchesPerEntity || 3);
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = play;
  else (globalThis.BA.playsQueue = globalThis.BA.playsQueue || []).push(play);
})();
