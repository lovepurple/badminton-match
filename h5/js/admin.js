/*
 * 后台管理页（独立于前台的 admin.html）。
 * 入口：http://host/h5/admin.html
 * 能力：玩法管理（展示/默认值/开关/LLM 新增引导）、场馆管理。
 */
(function () {
  const BA = (window.BA = window.BA || {});
  const R = BA.rules;
  const S = BA.store;

  const view = document.getElementById("view");
  const topbar = document.getElementById("topbar");

  let tab = "formats";
  let draftPlay = null;
  let draftVenue = null;
  let PLAYS = [];
  let PLAY_MAP = {};

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, (c) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function modal(text, actions) {
    document.getElementById("modal-text").textContent = text;
    const box = document.getElementById("modal-actions");
    box.innerHTML = "";
    (actions || [{ label: "知道了", primary: true }]).forEach((a) => {
      const b = document.createElement("button");
      b.textContent = a.label;
      if (a.primary) b.className = "primary";
      b.onclick = () => {
        document.getElementById("modal").hidden = true;
        if (a.fn) a.fn();
      };
      box.appendChild(b);
    });
    document.getElementById("modal").hidden = false;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return modal("已复制，可以直接发给 LLM", [{ label: "好的", primary: true }]);
    } catch (e) {
      /* 忽略 */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "readonly");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return modal("已复制，可以直接发给 LLM", [{ label: "好的", primary: true }]);
    } catch (e) {
      modal(text, [{ label: "关闭", primary: true }]);
    }
  }

  function topbarHTML(opts) {
    return (
      '<button class="back" data-back>‹</button><span>' + esc(opts.title || "") +
      '</span><span class="spacer"></span>' +
      (opts.action ? '<button class="action" data-action>' + esc(opts.action) + "</button>" : "")
    );
  }

  function playRulesHTML(play) {
    const r = play.rules || {};
    const rows = [
      ["参与人数", r.people],
      ["怎么玩", r.how],
      ["怎么分组", r.groups],
      ["怎么结束", r.end],
      ["怎么计分", r.score]
    ].filter((row) => row[1]);
    if (!rows.length) return "";
    return (
      '<div class="rules">' +
      rows
        .map(
          (row) =>
            '<div class="rule-row"><span class="rule-k">' + esc(row[0]) + "</span>" +
            '<span class="rule-v">' + esc(row[1]) + "</span></div>"
        )
        .join("") +
      "</div>"
    );
  }

  async function loadPlays() {
    let overrides = {};
    try {
      overrides = (await S.formatOverrides()).overrides || {};
    } catch (e) {
      overrides = {};
    }
    const base = BA.plays && BA.plays.list ? BA.plays.list() : [];
    PLAYS = base.map((play) => {
      const o = overrides[play.id] || {};
      return Object.assign({}, play, {
        name: o.name || play.name,
        intro: o.intro || play.intro,
        rules: Object.assign({}, play.rules || {}, o.rules || {}),
        defaults: Object.assign({}, play.defaults || {}, o.defaults || {}),
        enabled: o.enabled !== false,
        note: o.note || "",
        hasOverride: !!overrides[play.id]
      });
    });
    PLAY_MAP = {};
    PLAYS.forEach((play) => {
      PLAY_MAP[play.id] = play;
    });
  }

  const LLM_PROMPT = [
    "请在当前代码仓库新增一个羽毛球玩法（不要改其它玩法）：",
    "1. 新建 shared/plays/<id>.js，导出 { id, name, group, min, max, intro, tags, rules, defaults, schedule }；",
    "   group 取 doubles|singles|match|teams；rules 必须写全 people/how/groups/end/score 五段中文；",
    "   schedule(race, fmt) 返回 [{ round, court, side1:[playerId], side2:[playerId] }]，可复用 fmt 的轮转/循环/擂台等原语。",
    "2. 在 shared/plays/registry.json 的 plays 里加一行 { \"id\": \"<id>\", \"file\": \"<id>.js\" }。",
    "3. 在 tests/plays.test.js 补一条断言，跑 node tests/plays.test.js 全绿。",
    "4. 在 docs/llm/玩法开发指南.md §7 表格补一行。",
    "实现前先用五要素确认：参与人数？怎么玩？怎么分组？怎么结束？怎么计分（每局独立还是全场追分）？"
  ].join("\n");

  function showLlmGuide() {
    modal(LLM_PROMPT, [
      { label: "复制给 LLM", fn: () => copyText(LLM_PROMPT) },
      { label: "知道了", primary: true }
    ]);
  }

  function tabBar() {
    return (
      '<div class="admin-tabs">' +
      '<button data-atab="formats" class="' + (tab === "formats" ? "on" : "") + '">玩法管理</button>' +
      '<button data-atab="venues" class="' + (tab === "venues" ? "on" : "") + '">场馆管理</button>' +
      "</div>"
    );
  }

  /* ---------------- 玩法管理 ---------------- */

  async function renderFormats() {
    topbar.innerHTML = topbarHTML({ title: "玩法管理", action: "新增玩法" });
    wireTop();

    let html =
      tabBar() +
      '<div class="hint" style="margin-bottom:12px">玩法由代码实现（shared/plays/*.js）；' +
      "这里调整展示文案、默认规则与启用状态。新增玩法点「新增玩法」把提示词交给 LLM。</div>";

    html += '<div class="admin-grid">' + PLAYS.map((play) => {
      const badges =
        '<span class="badge">' + esc(play.group) + "</span>" +
        (play.enabled === false ? ' <span class="badge">已停用</span>' : "") +
        (play.legacy ? ' <span class="badge">内置</span>' : "") +
        (play.hasOverride ? ' <span class="badge">已改</span>' : "");
      return (
        '<div class="card"><h3>' + esc(play.name) + " " + badges + "</h3>" +
        '<div class="meta">' + esc(play.intro) + "</div>" +
        playRulesHTML(play) +
        (play.note ? '<div class="hint">备注：' + esc(play.note) + "</div>" : "") +
        '<div class="tabs" style="margin-top:10px">' +
        '<button data-play-edit="' + esc(play.id) + '">编辑</button>' +
        '<button data-play-toggle="' + esc(play.id) + '">' +
        (play.enabled === false ? "启用" : "停用") + "</button>" +
        (play.hasOverride
          ? '<button data-play-reset="' + esc(play.id) + '">恢复默认</button>'
          : "") +
        "</div></div>"
      );
    }).join("") + "</div>";

    if (draftPlay) {
      const d = draftPlay;
      html +=
        '<div class="card"><h3>编辑玩法：' + esc(d.name) + "</h3>" +
        '<div class="field"><label>名称</label><input type="text" id="p-name" value="' + esc(d.name) + '"></div>' +
        '<div class="field"><label>一句话简介</label><input type="text" id="p-intro" value="' + esc(d.intro) + '"></div>' +
        '<div class="field"><label>默认局数</label><select id="p-rounds">' +
        R.ROUNDS.map((o) => '<option value="' + o.value + '"' + (d.defaults.rounds === o.value ? " selected" : "") + ">" + o.name + "</option>").join("") +
        "</select></div>" +
        '<div class="field"><label>默认分制</label><select id="p-balls">' +
        R.BALLS.map((b) => '<option value="' + b + '"' + (d.defaults.balls === b ? " selected" : "") + ">" + R.ballsName(b) + "</option>").join("") +
        "</select></div>" +
        '<div class="field"><label>默认排名方式</label><select id="p-rank">' +
        R.RANK_MODES.map((o) => '<option value="' + o.value + '"' + (d.defaults.rankMode === o.value ? " selected" : "") + ">" + o.name + "</option>").join("") +
        "</select></div>" +
        [["people", "参与人数"], ["how", "怎么玩"], ["groups", "怎么分组"], ["end", "怎么结束"], ["score", "怎么计分"]]
          .map(([k, label]) =>
            '<div class="field"><label>' + label + '</label>' +
            '<input type="text" id="p-rule-' + k + '" value="' + esc((d.rules || {})[k] || "") + '"></div>'
          )
          .join("") +
        '<div class="field"><label>备注</label><input type="text" id="p-note" value="' + esc(d.note || "") + '"></div>' +
        '<button class="btn" id="p-save">保存</button>' +
        '<button class="btn secondary" id="p-cancel">取消</button></div>';
    }

    view.innerHTML = html;

    view.querySelectorAll("[data-atab]").forEach((btn) => {
      btn.onclick = () => {
        tab = btn.dataset.atab;
        render();
      };
    });
    view.querySelectorAll("[data-play-edit]").forEach((btn) => {
      btn.onclick = () => {
        const play = PLAYS.find((p) => p.id === btn.dataset.playEdit);
        draftPlay = Object.assign({}, play, {
          rules: Object.assign({}, play.rules || {}),
          defaults: Object.assign({}, play.defaults || {})
        });
        renderFormats();
      };
    });
    view.querySelectorAll("[data-play-toggle]").forEach((btn) => {
      btn.onclick = async () => {
        const play = PLAYS.find((p) => p.id === btn.dataset.playToggle);
        try {
          await S.saveFormat(play.id, {
            enabled: play.enabled === false,
            name: play.name,
            intro: play.intro,
            defaults: play.defaults,
            rules: play.rules,
            note: play.note
          });
          await loadPlays();
          renderFormats();
        } catch (e) {
          modal((e && e.detail) || "保存失败");
        }
      };
    });
    view.querySelectorAll("[data-play-reset]").forEach((btn) => {
      btn.onclick = () =>
        modal("恢复该玩法的默认展示与规则？", [
          { label: "取消" },
          {
            label: "恢复",
            primary: true,
            fn: async () => {
              try {
                await S.resetFormat(btn.dataset.playReset);
                await loadPlays();
                draftPlay = null;
                renderFormats();
              } catch (e) {
                modal((e && e.detail) || "恢复失败");
              }
            }
          }
        ]);
    });

    const save = view.querySelector("#p-save");
    if (save) {
      save.onclick = async () => {
        const payload = {
          enabled: draftPlay.enabled !== false,
          name: view.querySelector("#p-name").value.trim() || draftPlay.name,
          intro: view.querySelector("#p-intro").value.trim(),
          defaults: {
            rounds: Number(view.querySelector("#p-rounds").value),
            balls: Number(view.querySelector("#p-balls").value),
            rankMode: view.querySelector("#p-rank").value
          },
          rules: {
            people: view.querySelector("#p-rule-people").value.trim(),
            how: view.querySelector("#p-rule-how").value.trim(),
            groups: view.querySelector("#p-rule-groups").value.trim(),
            end: view.querySelector("#p-rule-end").value.trim(),
            score: view.querySelector("#p-rule-score").value.trim()
          },
          note: view.querySelector("#p-note").value.trim()
        };
        try {
          await S.saveFormat(draftPlay.id, payload);
          draftPlay = null;
          await loadPlays();
          renderFormats();
        } catch (e) {
          modal((e && e.detail) || "保存失败");
        }
      };
      view.querySelector("#p-cancel").onclick = () => {
        draftPlay = null;
        renderFormats();
      };
    }
  }

  /* ---------------- 场馆管理 ---------------- */

  async function renderVenues() {
    topbar.innerHTML = topbarHTML({ title: "场馆管理", action: "新增" });
    wireTop();

    let venues = [];
    try {
      venues = await S.venues();
    } catch (e) {
      venues = [];
    }

    let html =
      tabBar() +
      '<div class="hint" style="margin-bottom:12px">场馆用于比赛选择与一键导航；' +
      "坐标用高德/腾讯（gcj02），可在地图 App 里长按地点复制。</div>";

    html += venues.length
      ? venues
          .map(
            (item) =>
              '<div class="card"><h3>' + esc(item.name) + "</h3>" +
              '<div class="meta">' + esc(item.address || "未填写地址") + "</div>" +
              '<div class="meta" style="margin-top:4px">' +
              (item.lat != null && item.lng != null
                ? "坐标 " + item.lat + ", " + item.lng + "（" + esc(item.coord_type) + "）"
                : "无坐标（导航将复制地址）") +
              "</div>" +
              (item.note ? '<div class="meta">' + esc(item.note) + "</div>" : "") +
              '<div class="tabs" style="margin-top:10px">' +
              '<button data-edit="' + esc(item.id) + '">编辑</button>' +
              '<button data-del-venue="' + esc(item.id) + '">删除</button></div></div>'
          )
          .join("")
      : '<div class="empty">还没有场馆</div>';

    if (draftVenue) {
      const v = draftVenue;
      html +=
        '<div class="card"><h3>' + (v.id ? "编辑场馆" : "新增场馆") + "</h3>" +
        '<div class="field"><label>高德分享链接（粘贴后点解析，自动填下面几项）</label>' +
        '<div class="player-add" style="margin-top:0">' +
        '<input type="text" id="v-url" placeholder="https://surl.amap.com/xxxx">' +
        '<button class="mini-btn" id="v-resolve">解析</button></div>' +
        '<div class="hint">在高德 App 里长按地点 → 分享 → 复制链接</div></div>' +
        '<div class="field"><label>场馆名</label><input type="text" id="v-name" value="' + esc(v.name) + '"></div>' +
        '<div class="field"><label>地址</label><input type="text" id="v-address" value="' + esc(v.address) + '"></div>' +
        '<div class="field"><label>纬度 latitude</label><input type="text" id="v-lat" value="' + esc(v.lat) + '"></div>' +
        '<div class="field"><label>经度 longitude</label><input type="text" id="v-lng" value="' + esc(v.lng) + '"></div>' +
        '<div class="field"><label>备注</label><input type="text" id="v-note" value="' + esc(v.note) + '"></div>' +
        '<button class="btn" id="v-save">保存</button>' +
        '<button class="btn secondary" id="v-cancel">取消</button></div>';
    }

    view.innerHTML = html;

    view.querySelectorAll("[data-atab]").forEach((btn) => {
      btn.onclick = () => {
        tab = btn.dataset.atab;
        render();
      };
    });
    view.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.onclick = () => {
        const item = venues.find((x) => x.id === btn.dataset.edit);
        if (!item) return;
        draftVenue = {
          id: item.id,
          name: item.name,
          address: item.address || "",
          lat: item.lat != null ? item.lat : "",
          lng: item.lng != null ? item.lng : "",
          note: item.note || ""
        };
        renderVenues();
      };
    });
    view.querySelectorAll("[data-del-venue]").forEach((btn) => {
      btn.onclick = () =>
        modal("删除该场馆？", [
          { label: "取消" },
          {
            label: "删除",
            primary: true,
            fn: async () => {
              try {
                await S.removeVenue(btn.dataset.delVenue);
                if (draftVenue && draftVenue.id === btn.dataset.delVenue) draftVenue = null;
                renderVenues();
              } catch (e) {
                modal((e && e.detail) || "删除失败");
              }
            }
          }
        ]);
    });

    const resolveBtn = view.querySelector("#v-resolve");
    if (resolveBtn) {
      resolveBtn.onclick = async () => {
        const url = view.querySelector("#v-url").value.trim();
        if (!url) return modal("先粘贴高德分享链接");
        resolveBtn.textContent = "解析中…";
        try {
          const info = await S.resolveVenue(url);
          if (info.name) view.querySelector("#v-name").value = info.name;
          if (info.address) view.querySelector("#v-address").value = info.address;
          if (info.lat != null) view.querySelector("#v-lat").value = info.lat;
          if (info.lng != null) view.querySelector("#v-lng").value = info.lng;
          if (!info.lat) modal("只识别到 POI，坐标请手动补：https://www.amap.com/detail/" + info.poiId);
        } catch (e) {
          modal((e && e.detail) || "解析失败，请确认是高德分享链接");
        } finally {
          resolveBtn.textContent = "解析";
        }
      };
    }

    const save = view.querySelector("#v-save");
    if (save) {
      save.onclick = async () => {
        const payload = {
          id: draftVenue.id,
          name: view.querySelector("#v-name").value.trim(),
          address: view.querySelector("#v-address").value.trim(),
          lat: view.querySelector("#v-lat").value.trim() === "" ? null : Number(view.querySelector("#v-lat").value),
          lng: view.querySelector("#v-lng").value.trim() === "" ? null : Number(view.querySelector("#v-lng").value),
          note: view.querySelector("#v-note").value.trim()
        };
        if (!payload.name) return modal("请填写场馆名");
        if ((payload.lat == null) !== (payload.lng == null)) return modal("经纬度需要同时填写");
        try {
          await S.saveVenue(payload);
          draftVenue = null;
          renderVenues();
        } catch (e) {
          modal((e && e.detail) || "保存失败");
        }
      };
      view.querySelector("#v-cancel").onclick = () => {
        draftVenue = null;
        renderVenues();
      };
    }
  }

  /* ---------------- 启动 ---------------- */

  function wireTop() {
    topbar.querySelector("[data-back]").onclick = () => history.back();
    const action = topbar.querySelector("[data-action]");
    if (action) action.onclick = () => (tab === "formats" ? showLlmGuide() : (draftVenue = { name: "", address: "", lat: "", lng: "", note: "" }, renderVenues()));
  }

  async function render() {
    const want = location.hash.replace("#", "");
    if (want === "venues" || want === "formats") tab = want;
    if (tab === "venues") return renderVenues();
    return renderFormats();
  }

  (async () => {
    const params = new URLSearchParams(location.search);
    const token = params.get("token");
    if (token) {
      S.adoptToken(token);
      params.delete("token");
      const query = params.toString();
      history.replaceState(null, "", location.pathname + (query ? "?" + query : ""));
    }
    await S.init();
    let role = "user";
    try {
      role = (await S.meInfo()).role || "user";
    } catch (e) {
      role = "user";
    }
    if (role !== "admin") {
      view.innerHTML =
        '<div class="empty">需要管理员权限<br><br>' +
        '<div style="max-width:320px;margin:0 auto">' +
        '<div class="field"><label>管理员口令</label>' +
        '<input type="password" id="admin-code" placeholder="向服务器管理员要口令"></div>' +
        '<button class="btn" id="claim-admin">验证并进入</button>' +
        '<div class="hint">口令由服务端配置（GORILLA_ADMIN_CODE），验证一次永久生效。</div>' +
        '</div></div>';
      const claim = view.querySelector("#claim-admin");
      claim.onclick = async () => {
        const code = view.querySelector("#admin-code").value.trim();
        if (!code) return;
        try {
          const res = await S.claimAdmin(code);
          if (res && res.role === "admin") {
            role = "admin";
            myRole = "admin";
            if (BA.plays && BA.plays.ready) await BA.plays.ready;
            await loadPlays();
            render();
          }
        } catch (e) {
          const reason = e && e.offline
            ? "网络不可达：请确认访问的是 http://<电脑IP>:18000/h5/admin.html（不是旧端口）"
            : e && e.detail
              ? e.detail
              : "验证失败，请重试";
          modal(reason, [{ label: "好的", primary: true }]);
        }
      };
      return;
    }
    if (BA.plays && BA.plays.ready) {
      try {
        await BA.plays.ready;
      } catch (e) {
        /* 兜底 */
      }
    }
    await loadPlays();
    render();
    global.addEventListener("hashchange", () => render());
  })();
})(window);