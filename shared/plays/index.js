/*
 * 玩法注册表。
 *
 * 每个玩法是一个独立模块（shared/plays/<id>.js），导出：
 *   { id, name, group, min, max, intro, tags, rules{people,how,groups,end,score},
 *     defaults, schedule(race, fmt) -> matches[] }
 *
 * 新增玩法 = 加一个模块文件 + 在 registry.json 里加一行。
 * 未迁移的老赛制由 formats.generate 兜底，仍可正常使用。
 */
(function () {
  "use strict";
  const isNode = typeof module !== "undefined" && module.exports;
  const fmt = isNode ? require("../formats.js") : globalThis.BA.formats;
  const rules = isNode ? require("../rules.js") : globalThis.BA.rules;

  const modules = {};

  function register(play) {
    if (play && play.id) modules[play.id] = play;
  }

  function fallbackEntry(id) {
    const meta = rules.MODES[id];
    if (!meta) return null;
    return {
      id,
      name: meta.name,
      group: meta.group,
      min: meta.min,
      max: meta.max,
      intro: meta.intro,
      tags: [],
      legacy: true,
      rules: {
        people: meta.intro,
        how: meta.name,
        groups: "按内置赛制生成对阵",
        end: "打完全部对阵",
        score: "默认三局两胜、每局 21 分、需领先 2 分、30 分封顶"
      },
      defaults: {},
      schedule(race) {
        return fmt.generate(race);
      }
    };
  }

  function list() {
    const out = Object.keys(modules).map((k) => modules[k]);
    const known = new Set(out.map((p) => p.id));
    Object.keys(rules.MODES).forEach((id) => {
      if (known.has(id)) return;
      const entry = fallbackEntry(id);
      if (entry) out.push(entry);
    });
    return out;
  }

  function get(id) {
    return modules[id] || fallbackEntry(id) || null;
  }

  /*
   * 场地数封顶：默认对位已按轮次排好；当玩法需要把每轮并行场次压到
   * 指定场地数以内时，把多出的场次顺延到后续轮次（追分等连续计分的玩法跳过，
   * 因为轮次是比分续航的单位）。
   */
  function applyCourts(matches, courts) {
    if (!courts || courts < 1) return matches;
    const byRound = [];
    matches.forEach((m) => {
      const idx = (m.round || 1) - 1;
      (byRound[idx] = byRound[idx] || []).push(m);
    });
    const maxPerRound = Math.max(0, ...byRound.map((g) => (g ? g.length : 0)));
    if (courts >= maxPerRound) return matches; // 现有轮次本来就装得下

    const out = [];
    let placed = 0;
    matches.forEach((m) => {
      const round = Math.floor(placed / courts) + 1;
      out.push(Object.assign({}, m, { round, court: (placed % courts) + 1 }));
      placed++;
    });
    return out;
  }

  function isChaseRace(race, play) {
    if (play && play.scoring && play.scoring.mode === "chase") return true;
    return race.wheelMode === "chase";
  }

  function generate(race) {
    const play = modules[race.mode];
    const matches = play ? play.schedule(race, fmt) : fmt.generate(race);
    if (!isChaseRace(race, play)) return applyCourts(matches, race.courts);
    return matches;
  }

  function entityKind(mode) {
    const play = get(mode);
    if (play) {
      return play.group === "match" || play.group === "teams" ? "team" : "player";
    }
    return fmt.entityKind(mode);
  }

  const api = { list, get, generate, entityKind, register };

  if (isNode) {
    const fs = require("fs");
    const path = require("path");
    const registry = JSON.parse(
      fs.readFileSync(path.join(__dirname, "registry.json"), "utf8")
    );
    registry.plays.forEach((item) => register(require("./" + item.file)));
    module.exports = api;
  } else {
    globalThis.BA.plays = api;
    const base = String(globalThis.BA_PLAYS_BASE || "/shared/plays/").replace(
      /\/?$/,
      "/"
    );
    api.ready = (async () => {
      const registry = await fetch(base + "registry.json", { cache: "no-store" }).then(
        (r) => r.json()
      );
      for (const item of registry.plays) {
        await new Promise((resolve, reject) => {
          const el = document.createElement("script");
          el.src = base + item.file + "?v=" + Date.now();
          el.onload = resolve;
          el.onerror = () => reject(new Error("加载玩法失败：" + item.file));
          document.head.appendChild(el);
        });
      }
      (globalThis.BA.playsQueue || []).forEach(register);
      return api;
    })();
  }
})();
