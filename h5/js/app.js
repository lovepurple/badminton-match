(function (global) {
  const R = BA.rules;
  const F = BA.formats;
  const K = BA.ranking;
  const S = BA.store;

  const view = document.getElementById('view');
  const topbar = document.getElementById('topbar');
  const tabbar = document.getElementById('tabbar');

  const CHASE_MODES = ['wheelMatch', 'relayMatch', 'fixedTeams', 'singlesTeams', 'wheelTeams'];
  const FREE_MODES = ['freeRound', 'freeRoundSingles', 'freeMatch'];

  let draft = null;
  let serverOk = false;
  let myRole = "user";
  let PLAYS = [];
  let PLAY_MAP = {};
  let PRESETS = [];
  let VENUE_CACHE = null;

  /* ---------------- 基础 ---------------- */

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, c => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  let modalInput = null;

  function modal(text, actions, opts) {
    opts = opts || {};
    document.getElementById('modal-text').textContent = text;

    let input = null;
    if (opts.input) {
      input = document.createElement('input');
      input.type = opts.input.type || 'text';
      input.id = 'modal-input';
      input.value = opts.input.value == null ? '' : opts.input.value;
      input.placeholder = opts.input.placeholder || '';
      const p = document.getElementById('modal-text');
      p.insertAdjacentElement('afterend', input);
      modalInput = input;
    }

    const box = document.getElementById('modal-actions');
    box.innerHTML = '';
    (actions || [{ label: '知道了', primary: true }]).forEach(action => {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      if (action.primary) btn.className = 'primary';
      btn.onclick = () => {
        const value = input ? input.value.trim() : undefined;
        closeModal();
        if (action.fn) action.fn(value);
        else if (action.primary && opts.onConfirm) opts.onConfirm(value);
      };
      box.appendChild(btn);
    });
    document.getElementById('modal').hidden = false;
  }

  function closeModal() {
    const stale = document.getElementById('modal-input');
    if (stale) stale.remove();
    modalInput = null;
    document.getElementById('modal').hidden = true;
  }

  function askText(title, value, placeholder) {
    return new Promise(resolve => {
      let settled = false;
      modal(title, [
        { label: '取消', fn: () => { if (!settled) { settled = true; resolve(null); } } },
        {
          label: '确定',
          primary: true,
          fn: v => { if (!settled) { settled = true; resolve(v == null ? '' : v); } }
        }
      ], { input: { value: value == null ? '' : value, placeholder: placeholder || '' } });
    });
  }

  function askNumber(title, value) {
    return askText(title, value == null ? 0 : value, '').then(raw => {
      if (raw === null) return null;
      const n = parseInt(raw, 10);
      return isNaN(n) || n < 0 ? 0 : n;
    });
  }

  function go(hash) {
    location.hash = hash;
  }

  function topbarHTML(opts) {
    return (
      (opts.brand ? '<img class="brand-logo" src="assets/logo-96.png" alt="">' : '') +
      (opts.back ? '<button class="back" data-back>‹</button>' : '') +
      '<span>' + esc(opts.title || '') + '</span><span class="spacer"></span>' +
      (opts.action ? '<button class="action" data-action>' + esc(opts.action) + '</button>' : '') +
      (opts.ghost ? '<button class="ghost" data-ghost>' + esc(opts.ghost) + '</button>' : '')
    );
  }

  function wireTopbar(opts) {
    const back = topbar.querySelector('[data-back]');
    if (back) back.onclick = () => history.back();
    const action = topbar.querySelector('[data-action]');
    if (action && opts.onAction) action.onclick = opts.onAction;
    const ghost = topbar.querySelector('[data-ghost]');
    if (ghost && opts.onGhost) ghost.onclick = opts.onGhost;
  }

  function sideName(race, ids) {
    return ids
      .map(id => {
        const p = R.findPlayer(race.players, id);
        return p ? p.name : '?';
      })
      .join(' / ');
  }

  function isChase(race) {
    return CHASE_MODES.indexOf(race.mode) >= 0 && race.wheelMode === 'chase';
  }

  function chaseCap(race) {
    if (['fixedTeams', 'singlesTeams', 'wheelTeams'].indexOf(race.mode) >= 0) {
      return race.balls * (race.groupsValid || 3);
    }
    return race.balls * race.rounds;
  }

  function chaseBase(race, match) {
    const base = [0, 0];
    const teamMode = ['fixedTeams', 'singlesTeams', 'wheelTeams'].indexOf(race.mode) >= 0;
    for (const m of race.matches) {
      if (m === match) break;
      if (teamMode && m.round !== match.round) continue;
      (m.scores || []).forEach(s => {
        base[0] += s[0];
        base[1] += s[1];
      });
    }
    return base;
  }

  function pushUndo(match, snapshot) {
    match.history = match.history || [];
    match.history.push(snapshot);
    if (match.history.length > 60) match.history.shift();
  }

  function undoScore(race, match) {
    const history = match.history || [];
    if (!history.length) return false;
    const prev = history.pop();
    match.crt = prev.crt.slice();
    match.scores = prev.scores.map((s) => s.slice());
    match.scoreAll = prev.scoreAll ? prev.scoreAll.slice() : null;
    match.status = prev.status;
    S.cache(race);
    return true;
  }

  function snapshotOf(match) {
    return {
      crt: match.crt.slice(),
      scores: (match.scores || []).map((s) => s.slice()),
      scoreAll: match.scoreAll ? match.scoreAll.slice() : null,
      status: match.status
    };
  }

  function countAll(sets) {
    let a = 0;
    let b = 0;
    sets.forEach(s => {
      if (s[0] > s[1]) a++;
      else if (s[0] < s[1]) b++;
      else {
        a++;
        b++;
      }
    });
    return [a, b];
  }

  async function loadPlays() {
    let overrides = {};
    try {
      const res = await S.formatOverrides();
      overrides = (res && res.overrides) || {};
    } catch (e) {
      overrides = {};
    }
    const base = (BA.plays && BA.plays.list ? BA.plays.list() : []);
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
    return PLAYS;
  }

  function playOf(id) {
    return (
      PLAY_MAP[id] || {
        id,
        name: id,
        group: "doubles",
        min: 2,
        max: 50,
        intro: "",
        rules: {},
        defaults: {}
      }
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

  function readAvatar(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const size = 96;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, size, size);
        const r = Math.min(size / img.width, size / img.height);
        const w = img.width * r;
        const h = img.height * r;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => reject(new Error("图片读取失败"));
      img.src = url;
    });
  }

  function formatDate(value) {
    if (!value) return '';
    const text = String(value).replace("T", " ");
    return text.length > 16 ? text.slice(0, 16) : text;
  }

  function venueLine(venue) {
    if (!venue) return "";
    const parts = [venue.name, venue.address].filter(Boolean);
    return parts.map(esc).join(" · ");
  }

  async function openVenueNav(venue) {
    if (!venue) return modal("还没有设置场馆");
    const res = await BA.nav.openLocation(venue, { nav: true });
    if (res.via === "address") {
      modal("已复制场馆地址，可粘贴到地图 App 搜索", [{ label: "好的", primary: true }]);
    } else if (!res.ok) {
      modal("该场馆还没有坐标，请先在「场馆」里补全");
    }
  }

  function goAdmin() {
    const device = new URLSearchParams(location.search).get("device");
    location.href = "admin.html" + (device ? "?device=" + encodeURIComponent(device) : "");
  }

  /* ---------------- 路由 ---------------- */

  function parseQuery(hash) {
    const i = hash.indexOf('?');
    const out = {};
    if (i < 0) return out;
    hash.slice(i + 1).split('&').forEach(pair => {
      if (!pair) return;
      const k = pair.split('=')[0];
      const v = pair.slice(k.length + 1);
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    });
    return out;
  }

  async function route() {
    const hash = location.hash.replace(/^#/, '') || '/';
    const query = parseQuery(hash);
    const parts = hash.split('?')[0].split('/').filter(Boolean);
    tabbar.querySelectorAll('a').forEach(a => {
      a.classList.toggle(
        'active',
        (parts[0] === 'stats' && a.dataset.tab === 'stats') ||
          (parts[0] !== 'stats' && a.dataset.tab === 'races')
      );
    });

    if (!parts.length) return renderRaces();
    stopPolling();
    if (parts[0] === 'stats') return renderStats(query);
    if (parts[0] === 'me') return renderMe();
    if (parts[0] === 'create') return renderCreate();
    if (parts[0] === 'join') return renderJoin(parts[1]);
    if (parts[0] === "venues" || parts[0] === "formats") return goAdmin();
    if (parts[0] === 'race') {
      let race = S.getRace(parts[1]);
      if (!race) {
        // 直接打开链接 / 刚报名还没拉过列表：回源取一次
        try {
          race = await S.fetchRace(parts[1]);
        } catch (e) {
          race = null;
        }
      }
      if (!race) return renderRaces();
      if (parts[2] === 'match') return renderMatch(race, parts[3]);
      return renderRace(race, parts[2] || 'matches');
    }
    renderRaces();
  }

  /* ---------------- 比赛列表 ---------------- */

  async function renderRaces() {
    topbar.innerHTML = topbarHTML({
      title: '猩球 · 羽球局',
      action: '新建',
      brand: true,
      ghost: myRole === 'admin' ? '后台' : ''
    });
    wireTopbar({
      onAction: () => {
        draft = null;
        go('#/create');
      },
      onGhost: goAdmin
    });

    const races = S.races();
    const status = serverOk ? '已连接服务器' : '离线 · 仅本地缓存';
    if (!races.length) {
      view.innerHTML =
        '<div class="empty">' +
        '<img class="logo" src="assets/logo-192.png" alt="猩球 · 羽球局">' +
        '<div>还没有比赛</div><div>点右上角「新建」创建一场</div></div>' +
        '<div class="hint center">' + esc(status) + '</div>';
      return;
    }

    view.innerHTML =
      races
        .map(race => {
          const done = race.matches.filter(m => m.status === 'done').length;
          return (
            '<div class="card" data-race="' + esc(race.id) + '">' +
            '<h3>' + esc(race.name) + '</h3>' +
            '<div class="meta">' + esc(playOf(race.mode).name) + ' · ' +
            esc(R.roundsName(race.rounds)) + ' · ' + esc(R.ballsName(race.balls)) + '</div>' +
            (race.date || (race.venue && race.venue.name)
              ? '<div class="meta">' + esc(formatDate(race.date)) +
                (race.venue && race.venue.name ? ' · ' + esc(race.venue.name) : '') + '</div>'
              : '') +
            '<div class="meta" style="margin-top:6px">' +
            '<span class="badge">' + race.players.length + ' 人</span> ' +
            '<span class="badge">' + done + '/' + race.matches.length + ' 场</span> ' +
            '<span class="badge">' + esc(R.rankName(race.rankMode)) + '</span>' +
            '</div></div>'
          );
        })
        .join('') +
      '<div class="hint center">' + esc(status) + '</div>';

    view.querySelectorAll('[data-race]').forEach(node => {
      node.onclick = () => go('#/race/' + node.dataset.race);
    });
  }

  /* ---------------- 比赛详情 ---------------- */

  let pollTimer = null;
  let pollRaceId = null;
  const lastStamp = {};

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    pollRaceId = null;
  }

  function joinLink(race) {
    if (!race.joinCode) return '';
    return location.origin + location.pathname + "#/join/" + race.joinCode;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return modal("链接已复制", [{ label: "好的", primary: true }]);
    } catch (e) {
      /* 非 https / 旧浏览器：走 execCommand 兜底 */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "readonly");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) return modal("链接已复制", [{ label: "好的", primary: true }]);
    } catch (e) {
      /* 继续降级 */
    }
    modal(text, [{ label: "长按上面的链接可复制", primary: true }]);
  }

  const STATUS_TEXT = { draft: "未开放", open: "报名中", playing: "进行中", done: "已结束", cancel: "已取消" };

  async function renderRace(race, tab) {
    stopPolling();
    let info = null;
    try {
      info = await S.participants(race.id);
    } catch (e) {
      info = null;
    }
    const participants = info ? info.participants : [];
    const isOwner = info ? info.isOwner : false;
    const status = race.status || "draft";

    topbar.innerHTML = topbarHTML({ title: race.name, back: true, ghost: isOwner ? "删除" : "" });
    wireTopbar({
      onGhost: () => {
        if (!isOwner) return;
        modal("删除「" + race.name + "」？", [
          { label: "取消" },
          {
            label: "删除",
            primary: true,
            fn: async () => {
              await S.removeRace(race.id);
              go("#/");
            }
          }
        ]);
      }
    });

    let html =
      '<div class="card">' +
      '<h3>' + esc(playOf(race.mode).name) +
      ' <span class="badge">' + esc(STATUS_TEXT[status] || status) + "</span></h3>" +
      '<div class="meta">' + esc(R.roundsName(race.rounds)) + " · " +
      esc(R.ballsName(race.balls)) + (isChase(race) ? " · 连续追分" : "") + "</div>" +
      '<div class="meta" style="margin-top:4px">排名：' + esc(R.rankName(race.rankMode)) + " · " +
      (BA.plays.entityKind(race.mode) === "team" ? "按队伍" : "按个人") + "</div>" +
      (race.courts && race.courts > 1 ? '<div class="meta" style="margin-top:6px">场地：' + race.courts + " 块并行</div>" : "") +
      (race.date ? '<div class="meta" style="margin-top:6px">时间：' + esc(formatDate(race.date)) + "</div>" : "") +
      (race.venue && race.venue.name
        ? '<div class="meta">场馆：' + venueLine(race.venue) +
          ' <button class="mini-link" id="nav-venue">导航</button></div>'
        : "") +
      (race.joinCode ? '<div class="meta" style="margin-top:6px">报名码：' + esc(race.joinCode) + "</div>" : "") +
      "</div>";

    if (race.playRules) {
      html += '<details class="card"><summary>玩法规则</summary>' +
        playRulesHTML({ rules: race.playRules }) + "</details>";
    }

    let actions = "";
    if (status === "draft" && isOwner) {
      actions += '<button class="btn" id="open-signup">开放报名</button>';
    }
    if (status === "open" && isOwner) {
      actions += '<button class="btn secondary" id="copy-link">复制报名链接</button>';
      actions += '<button class="btn" id="start-race">开始比赛</button>';
    }
    if (status === "playing" && isOwner) {
      actions += '<button class="btn" id="finish-race">结束比赛</button>';
    }
    if ((status === "draft" || status === "open") && (isOwner || myRole === "admin")) {
      actions += '<button class="btn danger" id="cancel-race">取消比赛</button>';
    }
    if (status === "done" && (isOwner || myRole === "admin")) {
      actions += '<button class="btn secondary" id="reopen-race">重新打开改分</button>';
    }
    if (actions) html += '<div class="card">' + actions + "</div>";

    if (status === "open" || status === "playing") {
      const active = participants.filter((p) => !p.waitlisted);
      const waiting = participants.filter((p) => p.waitlisted);
      html +=
        '<div class="card"><div class="field-label">报名（' + active.length +
        (race.maxPlayers ? "/" + race.maxPlayers : "") + "）" +
        (waiting.length ? " · 候补 " + waiting.length : "") + "</div>" +
        (participants.length
          ? active
              .map(
                (p) =>
                  '<div class="player-row"><span class="name">' + esc(p.name) + "</span>" +
                  '<span class="tag">' + (p.gender === "F" ? "女" : "男") + " · " + p.level + "级</span>" +
                  (isOwner || myRole === "admin"
                    ? '<button class="del" data-kick="' + esc(p.user_id) + '">×</button>'
                    : "") +
                  "</div>"
              )
              .join("") +
            (waiting.length
              ? '<div class="field-label" style="margin-top:10px">候补（' + waiting.length + "）</div>" +
                waiting
                  .map(
                    (p) =>
                      '<div class="player-row"><span class="name">' + esc(p.name) + "</span>" +
                      '<span class="tag">候补</span></div>'
                  )
                  .join("")
              : "")
          : '<div class="meta">还没有人报名</div>') +
        "</div>";
    }

    if (status === "playing" && race.matches.length) {
      html +=
        '<div class="tabs">' +
        '<button data-tab="matches" class="' + (tab === "matches" ? "on" : "") + '">对阵</button>' +
        '<button data-tab="rank" class="' + (tab === "rank" ? "on" : "") + '">排名</button>' +
        "</div>" +
        (tab === "rank" ? rankHTML(race) : matchesHTML(race));
    } else if (status !== "done") {
      html += '<div class="empty">' +
        (status === "draft" ? "开放报名后，等人齐再开始比赛" : "人齐后由组织者开始比赛") +
        "</div>";
    }

    if (status === "done") html += '<div id="summary"></div>';

    view.innerHTML = html;

    view.querySelectorAll("[data-tab]").forEach(btn => {
      btn.onclick = () => go("#/race/" + race.id + "/" + btn.dataset.tab);
    });
    view.querySelectorAll("[data-match]").forEach(node => {
      node.onclick = () => go("#/race/" + race.id + "/match/" + node.dataset.match);
    });
    const add = view.querySelector("[data-addmatch]");
    if (add) add.onclick = () => addFreeMatch(race);

    const navBtn = view.querySelector("#nav-venue");
    if (navBtn) navBtn.onclick = () => openVenueNav(race.venue);

    const openBtn = view.querySelector("#open-signup");
    if (openBtn) {
      openBtn.onclick = () => {
        askNumber("报名人数上限（0 = 不限，满员自动进候补）", race.maxPlayers || 0).then(limit => {
          if (limit === null) return;
          askText("报名截止（留空 = 不截止）", "", "例：2026-11-01 20:00").then(raw => {
            let deadline = null;
            if (raw && raw.trim()) {
              const d = new Date(raw.trim().replace(" ", "T"));
              if (isNaN(d.getTime())) return modal("时间格式看不懂，例：2026-11-01 20:00");
              deadline = d.toISOString();
            }
            S.openSignup(race, limit, deadline)
              .then(() => renderRace(S.getRace(race.id), tab))
              .catch(e => modal((e && e.detail) || "开放报名失败"));
          });
        });
      };
    }

    const reopenBtn = view.querySelector("#reopen-race");
    if (reopenBtn) {
      reopenBtn.onclick = () =>
        modal("重新打开后可以改比分，改完再结束一次即可。", [
          { label: "取消" },
          {
            label: "重新打开",
            primary: true,
            fn: async () => {
              try {
                await S.reopenRace(race.id);
                const fresh = await S.fetchRace(race.id);
                renderRace(fresh, tab);
              } catch (e) {
                modal((e && e.detail) || "操作失败");
              }
            }
          }
        ]);
    }

    const copyBtn = view.querySelector("#copy-link");
    if (copyBtn) copyBtn.onclick = () => copyText(joinLink(race));

    const startBtn = view.querySelector("#start-race");
    if (startBtn) {
      startBtn.onclick = () => {
        const min = (R.MODES[race.mode] && R.MODES[race.mode].min) || 2;
        if (participants.length < min) return modal("至少需要 " + min + " 人才能开始");
        modal("用当前 " + participants.length + " 人开始比赛？", [
          { label: "取消" },
          {
            label: "开始",
            primary: true,
            fn: async () => {
              const players = participants.map(p => ({
                id: p.user_id,
                name: p.name,
                gender: p.gender,
                level: p.level
              }));
              const next = Object.assign({}, race, { players, teams: [] });
              const matches = F.generate(next).map(m => ({
                id: S.uid("m"),
                round: m.round,
                court: m.court,
                side1: m.side1,
                side2: m.side2,
                teamA: m.teamA,
                teamB: m.teamB,
                scores: [],
                scoreAll: null,
                crt: [0, 0],
                status: "pending"
              }));
              if (!matches.length) return modal("当前人数无法生成对阵");
              try {
                await S.startRace(race.id, players, matches);
                renderRace(S.getRace(race.id), "matches");
              } catch (e) {
                modal((e && e.detail) || "开始比赛失败");
              }
            }
          }
        ]);
      };
    }

    const cancelBtn = view.querySelector("#cancel-race");
    if (cancelBtn) {
      cancelBtn.onclick = () =>
        modal("取消这场比赛？已报名的人会看到「已取消」。", [
          { label: "不取消" },
          {
            label: "取消比赛",
            primary: true,
            fn: async () => {
              try {
                await S.cancelRace(race.id);
                await S.pull();
                renderRace(S.getRace(race.id), tab);
              } catch (e) {
                modal((e && e.detail) || "取消失败");
              }
            }
          }
        ]);
    }

    view.querySelectorAll("[data-kick]").forEach((btn) => {
      btn.onclick = () =>
        modal("移出这位成员？若有候补会自动递补。", [
          { label: "取消" },
          {
            label: "移出",
            primary: true,
            fn: async () => {
              try {
                await S.kickParticipant(race.id, btn.dataset.kick);
                renderRace(S.getRace(race.id), tab);
              } catch (e) {
                modal((e && e.detail) || "操作失败");
              }
            }
          }
        ]);
    });

    const finishBtn = view.querySelector("#finish-race");
    if (finishBtn) {
      finishBtn.onclick = () =>
        modal("结束比赛并汇总成绩？", [
          { label: "取消" },
          {
            label: "结束",
            primary: true,
            fn: async () => {
              try {
                await S.finishRace(race.id);
                await S.pull();
                renderRace(S.getRace(race.id), tab);
              } catch (e) {
                modal((e && e.detail) || "结束比赛失败");
              }
            }
          }
        ]);
    }

    if (status === "done") loadSummary(race);
    startPolling(race, status, tab);
  }

  function startPolling(race, status, tab) {
    if (status !== "open" && status !== "playing") return;
    const raceId = race.id;
    pollRaceId = raceId;
    pollTimer = setInterval(async () => {
      if (pollRaceId !== raceId) return;
      if (location.hash.indexOf("/race/" + raceId) < 0) return stopPolling();
      try {
        if (status === "open") {
          const info = await S.participants(raceId);
          const fresh = S.getRace(raceId);
          if (fresh && !fresh.matches.length && info.status === "open") renderRace(fresh, tab);
        } else {
          const res = await S.live(raceId, lastStamp[raceId] || 0);
          if (res.changed && res.race) {
            lastStamp[raceId] = res.updatedAt;
            S.cache(res.race);
            renderRace(S.getRace(raceId), tab);
          }
        }
      } catch (e) {
        /* 单次失败忽略 */
      }
    }, 4000);
  }

  async function loadSummary(race) {
    const box = document.getElementById("summary");
    if (!box) return;
    try {
      const data = await S.summary(race.id);
      const rows = data.ranking.rows
        .map(
          (r, i) =>
            "<tr><td class=\"num\">" + (i + 1) + "</td>" +
            "<td class=\"name\">" + esc(r.name) + "</td>" +
            "<td class=\"num\">" + r.wins + "-" + r.fail + "</td>" +
            "<td class=\"num\">" + r.point + "</td>" +
            "<td class=\"num\">" + (r.netball > 0 ? "+" : "") + r.netball + "</td></tr>"
        )
        .join("");
      const played = (data.matches || []).filter(m => m.scoreAll && m.scores.length);
      box.innerHTML =
        '<div class="card"><h3>最终排名</h3>' +
        '<table class="rank-table"><thead><tr><th>#</th>' +
        '<th style="text-align:left">' + (data.ranking.kind === "team" ? "队伍" : "选手") + "</th>" +
        "<th>胜-负</th><th>积分</th><th>净胜分</th></tr></thead><tbody>" + rows + "</tbody></table></div>" +
        '<div class="card"><h3>已结束的场次</h3>' +
        (played.length
          ? played
              .map(
                m =>
                  '<div class="row" style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed var(--border)">' +
                  "<span>" + esc(sideName(race, m.side1)) + " vs " + esc(sideName(race, m.side2)) + "</span>" +
                  "<span>" + m.scores.map(x => x[0] + "-" + x[1]).join(" ") + "</span></div>"
              )
              .join("")
          : '<div class="meta">还没有完成的对阵</div>') +
        "</div>";
    } catch (e) {
      box.innerHTML = "";
    }
  }

  /* ---------------- 报名页 ---------------- */

  async function fillFriends() {
    const box = document.getElementById("j-friends");
    if (!box) return;
    let people = [];
    try {
      people = await S.acquaintances();
    } catch (e) {
      return;
    }
    if (!people.length) return;
    box.className = "field";
    box.innerHTML =
      '<label>常用球友（点一下自动填）</label><div class="chips">' +
      people
        .map(
          (p, i) =>
            '<button class="chip" data-friend="' + i + '">' + esc(p.name) +
            (p.level ? '<span class="tag">' + p.level + "级</span>" : "") + "</button>"
        )
        .join("") +
      "</div>";
    box.querySelectorAll("[data-friend]").forEach(btn => {
      btn.onclick = () => {
        const p = people[Number(btn.dataset.friend)];
        const name = document.getElementById("jname");
        if (name) {
          name.value = p.name;
          name.dispatchEvent(new Event("input", { bubbles: true }));
        }
        document.querySelectorAll("[data-gender]").forEach(b => {
          b.classList.toggle("on", b.dataset.gender === (p.gender || "M"));
        });
        const lv = document.getElementById("jlevel");
        if (lv && p.level != null) lv.value = String(p.level);
      };
    });
  }

  async function renderJoin(code) {
    topbar.innerHTML = topbarHTML({ title: "报名", back: true });
    wireTopbar({});
    view.innerHTML = '<div class="empty">加载中…</div>';

    let info;
    try {
      info = await S.joinInfo(code);
    } catch (e) {
      view.innerHTML = '<div class="empty">' + esc((e && e.detail) || "报名链接无效") + "</div>";
      return;
    }

    const race = info.race;
    const status = race.status;
    let html =
      '<div class="card"><h3>' + esc(race.name) + "</h3>" +
      '<div class="meta">' + esc(playOf(race.mode).name) + " · " +
      esc(R.roundsName(race.rounds)) + " · " + esc(R.ballsName(race.balls)) + "</div>" +
      (race.date ? '<div class="meta" style="margin-top:4px">时间：' + esc(formatDate(race.date)) + "</div>" : "") +
      (race.venue && race.venue.name
        ? '<div class="meta">场馆：' + venueLine(race.venue) +
          ' <button class="mini-link" id="nav-venue">导航</button></div>'
        : "") +
      '<div class="meta" style="margin-top:4px">' +
      (race.maxPlayers ? "限 " + race.maxPlayers + " 人" : "不限人数") + " · 已报名 " +
      info.participants.length + " 人</div></div>";

    if (status !== "open") {
      html += '<div class="card"><div class="meta">' +
        (status === "playing" ? "比赛已开始，可以查看实时比分" : "报名未开放或已结束") + "</div></div>";
      html += info.participants.length
        ? '<div class="card"><div class="field-label">报名名单</div>' +
          info.participants.map(p => '<div class="player-row"><span class="name">' + esc(p.name) + "</span></div>").join("") +
          "</div>"
        : "";
      if (status === "playing") html += '<button class="btn" id="watch">查看实时比分</button>';
      view.innerHTML = html;
      const navBtn = document.getElementById("nav-venue");
      if (navBtn) navBtn.onclick = () => openVenueNav(race.venue);
      const watch = document.getElementById("watch");
      if (watch) watch.onclick = () => go("#/race/" + race.id);
      return;
    }

    if (info.joined) {
      html +=
        '<div class="card"><div class="meta">你已报名</div>' +
        '<div class="field-label" style="margin-top:10px">报名名单</div>' +
        info.participants
          .map(
            (p) =>
              '<div class="player-row"><span class="name">' + esc(p.name) + "</span>" +
              (p.waitlisted ? '<span class="tag">候补</span>' : "") +
              "</div>"
          )
          .join("") +
        "</div>" +
        '<button class="btn" id="enter">进入比赛</button>' +
        '<button class="btn danger" id="leave">退出报名</button>';
      view.innerHTML = html;
      const navBtn = document.getElementById("nav-venue");
      if (navBtn) navBtn.onclick = () => openVenueNav(race.venue);
      document.getElementById("enter").onclick = () => go("#/race/" + race.id);
      document.getElementById("leave").onclick = async () => {
        try {
          await S.leaveRace(race.id);
          renderJoin(code);
        } catch (e) {
          modal((e && e.detail) || "退出失败");
        }
      };
      return;
    }

    html +=
      '<div class="card">' +
      '<div class="field"><label>你的名字</label>' +
      '<input type="text" id="jname" value="' + esc(S.me()) + '" placeholder="例如：阿豪"></div>' +
      '<div id="j-friends"></div>' +
      '<div class="field"><label>头像（可跳过，报名后自动带上）</label>' +
      avatarHTML(S.avatar(), "small") +
      '<input type="file" id="j-avatar" accept="image/*" style="display:none">' +
      '<button class="btn secondary" id="j-pick">选头像</button></div>' +
      '<div class="field"><label>性别</label><div class="segmented">' +
      '<button data-gender="M" class="on">男</button><button data-gender="F">女</button></div></div>' +
      '<div class="field"><label>水平</label><select id="jlevel">' +
      levelOptions() +
      "</select></div>" +
      '<button class="btn" id="join">确认报名</button>' +
      "</div>";

    view.innerHTML = html;
    const navBtn = document.getElementById("nav-venue");
    if (navBtn) navBtn.onclick = () => openVenueNav(race.venue);

    let pickedAvatar = S.avatar();
    const pick = view.querySelector("#j-pick");
    if (pick) {
      pick.onclick = () => view.querySelector("#j-avatar").click();
      view.querySelector("#j-avatar").onchange = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        pickedAvatar = await readAvatar(file);
        const imgs = view.querySelectorAll(".avatar");
        if (imgs[1]) imgs[1].src = pickedAvatar;
      };
    }

    let gender = "M";
    view.querySelectorAll("[data-gender]").forEach(btn => {
      btn.onclick = () => {
        gender = btn.dataset.gender;
        view.querySelectorAll("[data-gender]").forEach(b => b.classList.toggle("on", b === btn));
      };
    });

    fillFriends();

    document.getElementById("join").onclick = async () => {
      const name = document.getElementById("jname").value.trim();
      if (!name) return modal("请填写名字");
      try {
        await S.joinRace(race.id, {
          name,
          avatar: pickedAvatar || undefined,
          gender,
          level: Number(document.getElementById("jlevel").value)
        });
        S.setMe(name);
        S.pull();
        renderJoin(code);
      } catch (err) {
        const detail = (err && err.detail) || "报名失败";
        if (detail.indexOf("满") >= 0) {
          return modal("已满员，进入候补队列？有人退出会自动递补。", [
            { label: "取消" },
            {
              label: "进候补",
              primary: true,
              fn: async () => {
                try {
                  await S.joinWaitlist(race.id, {
                    name,
                    avatar: pickedAvatar || undefined,
                    gender,
                    level: Number(document.getElementById("jlevel").value)
                  });
                  S.setMe(name);
                  S.pull();
                  renderJoin(code);
                } catch (e2) {
                  modal((e2 && e2.detail) || "候补失败");
                }
              }
            }
          ]);
        }
        modal(detail);
      }
    };
  }

  function matchesHTML(race) {
    if (!race.matches.length) {
      return (
        '<div class="empty">还没有对阵' +
        (FREE_MODES.indexOf(race.mode) >= 0
          ? '<br><button class="btn secondary" data-addmatch style="margin-top:16px">添加对阵</button>'
          : '') +
        '</div>'
      );
    }
    let out = '';
    let lastRound = null;
    race.matches.forEach(m => {
      if (m.round !== lastRound) {
        out += '<div class="round-title">第 ' + m.round + ' 轮</div>';
        lastRound = m.round;
      }
      const win1 = m.scoreAll && m.scoreAll[0] > m.scoreAll[1];
      const win2 = m.scoreAll && m.scoreAll[1] > m.scoreAll[0];
      const sets = (m.scores || []).map(s => s[0] + '-' + s[1]).join(' ');
      const sub = [race.courts && race.courts > 1 ? m.court + "号场" : "", sets].filter(Boolean).join(" · ");
      out +=
        '<div class="match" data-match="' + esc(m.id) + '">' +
        '<div class="side' + (win1 ? ' win' : '') + '">' + esc(sideName(race, m.side1)) + '</div>' +
        '<div class="score">' + (m.scoreAll ? m.scoreAll[0] + ':' + m.scoreAll[1] : '未开始') +
        (sub ? '<span class="sub">' + esc(sub) + '</span>' : '') + '</div>' +
        '<div class="side right' + (win2 ? ' win' : '') + '">' + esc(sideName(race, m.side2)) + '</div>' +
        '</div>';
    });
    if (FREE_MODES.indexOf(race.mode) >= 0) {
      out += '<button class="btn secondary" data-addmatch style="margin-top:12px">添加对阵</button>';
    }
    return out;
  }

  function rankHTML(race) {
    const result = K.compute(race);
    if (!result.rows.length) return '<div class="empty">还没有可排名的数据</div>';
    const rows = result.rows
      .map(
        (r, i) =>
          '<tr><td class="num">' + (i + 1) + '</td>' +
          '<td class="name">' + esc(r.name) + '</td>' +
          '<td class="num">' + r.wins + '-' + r.fail + '</td>' +
          '<td class="num">' + r.point + '</td>' +
          '<td class="num">' + (r.netball > 0 ? '+' : '') + r.netball + '</td>' +
          '<td class="num">' + Math.round(r.rate.alls * 100) + '%</td></tr>'
      )
      .join('');
    return (
      '<table class="rank-table"><thead><tr><th>#</th>' +
      '<th style="text-align:left">' + (result.kind === 'team' ? '队伍' : '选手') + '</th>' +
      '<th>胜-负</th><th>积分</th><th>净胜分</th><th>胜率</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>'
    );
  }

  async function addFreeMatch(race) {
    const size = race.mode === 'freeRoundSingles' || race.mode === 'singlesMatch' ? 1 : 2;
    if (race.players.length < size * 2) return modal('选手不足，先补充选手');
    const picked = [];
    const pick = () => {
      if (picked.length === size * 2) return finish();
      const options = race.players.filter(p => picked.indexOf(p.id) < 0);
      modal('选择第 ' + (picked.length + 1) + ' 位选手', options.map(p => ({
        label: p.name,
        fn: () => {
          picked.push(p.id);
          pick();
        }
      })));
    };
    const finish = async () => {
      const last = race.matches[race.matches.length - 1];
      race.matches.push({
        id: S.uid('m'),
        round: last ? last.round + 1 : 1,
        court: 1,
        side1: picked.slice(0, size),
        side2: picked.slice(size),
        scores: [],
        scoreAll: null,
        crt: [0, 0],
        status: 'pending'
      });
      await S.updateRace(race);
      route();
    };
    pick();
  }

  /* ---------------- 记分 ---------------- */

  async function renderMatch(race, mid) {
    const match = race.matches.find(m => m.id === mid);
    if (!match) return go('#/race/' + race.id);

    const chase = isChase(race);
    if (!match.crt) match.crt = chase ? chaseBase(race, match) : [0, 0];
    if (!match.scoreAll && match.scores.length) match.scoreAll = countAll(match.scores);

    topbar.innerHTML = topbarHTML({ title: '第 ' + (match.scores.length + 1) + ' 局', back: true });
    wireTopbar({});

    const base = chase ? chaseBase(race, match) : [0, 0];
    const quick = R.quickScores(race.balls, race.rounds, chase);
    const chips = [];
    [0, 1].forEach(side => {
      quick.forEach(v => {
        const value = chase ? base[side] + v : v;
        chips.push({ side, value, label: (side === 0 ? '左 ' : '右 ') + value });
      });
    });

    view.innerHTML =
      '<div class="scoreboard">' +
      '<div class="sb-head"><span>' + esc(playOf(race.mode).name) + '</span>' +
      '<span>局分 ' + (match.scoreAll ? match.scoreAll[0] : 0) + ' : ' +
      (match.scoreAll ? match.scoreAll[1] : 0) + (chase ? ' · 累计' : '') + '</span></div>' +
      '<div class="sb-body">' +
      sbSide(race, match, 0, match.crt[0]) +
      sbSide(race, match, 1, match.crt[1]) +
      '</div>' +
      '<div class="chips">' +
      chips.map((c, i) => '<button data-quick="' + i + '">' + esc(c.label) + '</button>').join('') +
      '</div>' +
      '<div class="segmented" style="margin-top:12px">' +
      '<button id="undo" ' + ((match.history || []).length ? "" : "disabled") + '>↶ 撤销</button>' +
      '<button id="cede">让分</button>' +
      "</div>" +
      '<button class="btn" id="commit" style="margin-top:12px">' +
      (chase ? '完成本场' : '完成本局') + '</button>' +
      (match.status === 'done' ? '<button class="btn danger" id="reset" style="margin-top:10px">重置本场</button>' : '') +
      '</div>' +
      setsHTML(match);

    view.querySelectorAll("[data-plus]").forEach(btn => {
      btn.onclick = () => {
        const side = Number(btn.dataset.plus);
        pushUndo(match, snapshotOf(match));
        match.crt[side] = Math.min(9999, match.crt[side] + 1);
        S.cache(race);
        renderMatch(race, mid);
      };
    });
    view.querySelectorAll("[data-minus]").forEach(btn => {
      btn.onclick = () => {
        const side = Number(btn.dataset.minus);
        pushUndo(match, snapshotOf(match));
        match.crt[side] = Math.max(0, match.crt[side] - 1);
        S.cache(race);
        renderMatch(race, mid);
      };
    });
    view.querySelectorAll('[data-quick]').forEach(btn => {
      btn.onclick = () => {
        const chip = chips[Number(btn.dataset.quick)];
        match.crt[chip.side] = chip.value;
        S.cache(race);
        renderMatch(race, mid);
      };
    });

    const undoBtn = document.getElementById("undo");
    if (undoBtn) {
      undoBtn.onclick = async () => {
        if (!undoScore(race, match)) return modal("没有可撤销的操作");
        await S.updateMatch(race.id, match);
        renderMatch(race, mid);
      };
    }

    document.getElementById("cede").onclick = () => {
      pushUndo(match, snapshotOf(match));
      const cp = R.cedePoint(match.side1, match.side2, race.players, race.balls);
      if (!cp) return modal('对阵双方性别相同，或当前分制没有默认让分');
      const b = chase ? chaseBase(race, match) : [0, 0];
      match.crt = [b[0], b[1]];
      match.crt[cp.side] += cp.points;
      S.cache(race);
      renderMatch(race, mid);
    };

    document.getElementById('commit').onclick = () => commitSet(race, match);

    const reset = document.getElementById('reset');
    if (reset) {
      reset.onclick = () =>
        modal('重置本场比分？', [
          { label: '取消' },
          {
            label: '重置',
            primary: true,
            fn: async () => {
              match.scores = [];
              match.scoreAll = null;
              match.status = 'pending';
              match.crt = chase ? chaseBase(race, match) : [0, 0];
              await S.updateMatch(race.id, match);
              renderMatch(race, mid);
            }
          }
        ]);
    }
  }

  function sbSide(race, match, side, pts) {
    return (
      '<div class="sb-side">' +
      '<div class="who">' + esc(sideName(race, side === 0 ? match.side1 : match.side2)) + '</div>' +
      '<div class="pts">' + pts + '</div>' +
      '<div class="btns">' +
      '<button data-minus="' + side + '">−</button>' +
      '<button class="plus" data-plus="' + side + '">+</button>' +
      '</div></div>'
    );
  }

  function setsHTML(match) {
    if (!match.scores.length) return '';
    const rows = match.scores
      .map((s, i) => '<div class="row"><span>第 ' + (i + 1) + ' 局</span><span>' + s[0] + ' : ' + s[1] + '</span></div>')
      .join('');
    return '<div class="card set-list"><div class="meta" style="margin-bottom:6px">已记比分</div>' + rows + '</div>';
  }

  async function commitSet(race, match) {
    if (isChase(race)) return commitChase(race, match);

    const verdict = R.judgeSet(match.crt, race.balls);
    if (verdict.kind === 'invalid') return modal(verdict.reason);
    if (verdict.kind === 'warn') {
      return modal(verdict.reason, [
        { label: '继续记分' },
        {
          label: '下一局',
          primary: true,
          fn: () => {
            match.scores.push(match.crt.slice());
            match.scoreAll = countAll(match.scores);
            match.crt = [0, 0];
            afterSet(race, match);
          }
        }
      ]);
    }
    match.scores.push(match.crt.slice());
    match.scoreAll = countAll(match.scores);
    match.crt = [0, 0];
    afterSet(race, match);
  }

  async function afterSet(race, match) {
    const done = R.judgeMatch(match.scores, match.scoreAll, race.rounds);
    S.cache(race);
    if (done.done) {
      modal(done.reason, [
        { label: '下一局' },
        {
          label: '完成记分',
          primary: true,
          fn: async () => {
            match.status = 'done';
            await S.updateMatch(race.id, match);
            go('#/race/' + race.id);
          }
        }
      ]);
      renderMatch(race, match.id);
      return;
    }
    await S.updateMatch(race.id, match);
    renderMatch(race, match.id);
  }

  async function commitChase(race, match) {
    const verdict = R.judgeChase(match.crt, chaseCap(race));
    if (verdict.kind !== 'ok') return modal(verdict.reason);

    const base = chaseBase(race, match);
    const delta = [match.crt[0] - base[0], match.crt[1] - base[1]];
    if (delta[0] < 0 || delta[1] < 0) return modal('本局新增比分不能小于0哦');

    match.scores = [delta];
    match.scoreAll = delta[0] > delta[1] ? [1, 0] : [0, 1];
    match.status = 'done';
    await S.updateMatch(race.id, match);
    go('#/race/' + race.id);
  }

  /* ---------------- 新建 ---------------- */

  function blankDraft() {
    return {
      name: '周末羽球',
      date: '',
      venueId: '',
      courts: 0,
      signup: true,
      group: 'doubles',
      mode: 'eight',
      rounds: 3,
      balls: 21,
      wheelMode: 'isolate',
      partnerMode: 'random',
      rankMode: 'pointFirst',
      matchesPerEntity: 3,
      arenaKings: 1,
      groupSize: 4,
      players: [],
      teams: [
        { name: 'A 队', players: [] },
        { name: 'B 队', players: [] }
      ]
    };
  }

  async function renderCreate() {
    if (!draft) draft = blankDraft();
    try {
      PRESETS = await S.presets();
    } catch (e) {
      PRESETS = [];
    }
    topbar.innerHTML = topbarHTML({ title: '新建比赛', back: true });
    wireTopbar({});

    if (VENUE_CACHE === null) {
      try {
        VENUE_CACHE = await S.venues();
      } catch (e) {
        VENUE_CACHE = [];
      }
    }
    const venues = VENUE_CACHE;

    const modes = PLAYS.filter(
      (play) => play.group === draft.group && play.enabled !== false
    );
    const isTeam = draft.group === 'match' || draft.group === 'teams';

    let html = "";
    if (PRESETS.length) {
      html +=
        '<div class="card"><div class="field-label">常用模板</div><div class="segmented">' +
        PRESETS
          .map(
            (p) =>
              '<button data-preset="' + esc(p.id) + '">' + esc(p.name) + "</button>"
          )
          .join("") +
        '</div><div class="hint">点一下套用，可再改</div></div>';
    }

    html +=
      '<div class="card">' +
      '<div class="field"><label>比赛名称</label>' +
      '<input type="text" id="race-name" value="' + esc(draft.name) + '"></div>' +
      '<div class="field"><label>比赛时间</label>' +
      '<input type="datetime-local" id="race-date" value="' + esc(draft.date) + '"></div>' +
      '<div class="field"><label>场馆</label>' +
      '<select id="race-venue"><option value="">不指定</option>' +
      venues.map(v =>
        '<option value="' + esc(v.id) + '"' + (draft.venueId === v.id ? ' selected' : '') + '>' +
        esc(v.name) + (v.address ? " · " + esc(v.address) : "") + "</option>"
      ).join("") +
      '</select>' +
      (myRole === "admin" ? '<div class="hint">没有合适的场馆？<a href="admin.html">去后台维护</a></div>' : "") +
      '</div>' +
      '<div class="field"><label>场地数</label><div class="segmented">' +
      '<button data-court="0" class="' + (draft.courts === 0 ? "on" : "") + '">自动</button>' +
      [1, 2, 3, 4, 5, 6].map((n) => '<button data-court="' + n + '" class="' + (draft.courts === n ? "on" : "") + '">' + n + "</button>").join("") +
      '</div><div class="hint">选 1 = 一场一场打；选 2 = 每次两场并行。自动按人数算出够用场地。</div></div>' +
      '<div class="field"><label>报名方式</label><div class="segmented">' +
      '<button data-signup="1" class="' + (draft.signup ? "on" : "") + '">报名制（生成链接）</button>' +
      '<button data-signup="0" class="' + (!draft.signup ? "on" : "") + '">直接开打</button>' +
      "</div></div>" +
      '<div class="field"><label>规则</label>' + playRulesHTML(playOf(draft.mode)) + '</div>' +
      '<div class="field"><label>类型</label><div class="segmented">' +
      R.GROUPS.map(
        g =>
          '<button data-group="' + g.key + '" class="' + (draft.group === g.key ? 'on' : '') + '">' +
          g.name + '</button>'
      ).join('') +
      '</div></div>' +
      '<div class="field"><label>赛制</label><div class="mode-list">' +
      modes.map(play => {
        return (
          '<button data-mode="' + esc(play.id) + '" class="' + (draft.mode === play.id ? 'on' : '') + '">' +
          '<div class="n">' + esc(play.name) + '</div>' +
          '<div class="i">' + esc(play.intro) + '</div></button>'
        );
      }).join('') +
      '</div></div></div>';

    html +=
      '<div class="card">' +
      '<div class="field"><label>局数</label><div class="segmented">' +
      R.ROUNDS.map(
        o =>
          '<button data-rounds="' + o.value + '" class="' + (draft.rounds === o.value ? 'on' : '') + '">' +
          o.name + '</button>'
      ).join('') +
      '</div></div>' +
      '<div class="field"><label>分制</label><select id="balls">' +
      R.BALLS.map(
        b => '<option value="' + b + '"' + (draft.balls === b ? ' selected' : '') + '>' + R.ballsName(b) + '</option>'
      ).join('') +
      '</select></div>';

    if (CHASE_MODES.indexOf(draft.mode) >= 0) {
      html +=
        '<div class="field"><label>记分方式</label><div class="segmented">' +
        R.WHEEL_MODES.map(
          o =>
            '<button data-wheel="' + o.value + '" class="' + (draft.wheelMode === o.value ? 'on' : '') + '">' +
            o.name + '</button>'
        ).join('') +
        '</div></div>';
    }
    if (['loop', 'doubleLoop', 'promote'].indexOf(draft.mode) >= 0) {
      html +=
        '<div class="field"><label>搭档方式</label><div class="segmented">' +
        R.PARTNER_MODES.map(
          o =>
            '<button data-partner="' + o.value + '" class="' + (draft.partnerMode === o.value ? 'on' : '') + '">' +
            o.name + '</button>'
        ).join('') +
        '</div></div>';
    }
    if (draft.mode === 'fixedRound' || draft.mode === 'singlesRound') {
      html +=
        '<div class="field"><label>每人 / 每对比赛次数</label>' +
        '<input type="number" id="per" min="1" max="30" value="' + draft.matchesPerEntity + '"></div>';
    }
    if (draft.mode === 'arena' || draft.mode === 'singlesArena') {
      html +=
        '<div class="field"><label>擂主人数</label>' +
        '<input type="number" id="kings" min="1" max="10" value="' + draft.arenaKings + '"></div>';
    }
    if (draft.mode === 'promote') {
      html +=
        '<div class="field"><label>小组人数</label>' +
        '<input type="number" id="groupsize" min="2" max="8" value="' + draft.groupSize + '"></div>';
    }
    html +=
      '<div class="field"><label>排名方式</label><select id="rankmode">' +
      R.RANK_MODES.map(
        o =>
          '<option value="' + o.value + '"' + (draft.rankMode === o.value ? ' selected' : '') + '>' +
          o.name + '</option>'
      ).join('') +
      '</select></div></div>';

    html += draft.signup && !isTeam
      ? '<div class="card"><div class="meta">报名制：选手通过报名链接加入，人齐后由你开始比赛并自动生成对阵。</div></div>'
      : isTeam ? teamsForm() : playersForm();
    html +=
      '<button class="btn secondary" id="save-preset">存为常用模板</button>' +
      '<button class="btn" id="create">生成对阵</button>';
    view.innerHTML = html;
    wireCreate();
  }

  async function fillCreateFriends() {
    const box = document.getElementById("create-friends");
    if (!box) return;
    let people = [];
    try {
      people = await S.acquaintances();
    } catch (e) {
      return;
    }
    const existing = new Set(draft.players.map(p => p.name));
    const fresh = people.filter(p => !existing.has(p.name));
    if (!fresh.length) return;
    box.innerHTML =
      '<div class="hint" style="margin-top:10px">常用球友（点一下加入）</div><div class="chips">' +
      fresh
        .map((p, i) => '<button class="chip" data-cfriend="' + i + '">' + esc(p.name) + "</button>")
        .join("") +
      "</div>";
    box.querySelectorAll("[data-cfriend]").forEach(btn => {
      btn.onclick = () => {
        const p = fresh[Number(btn.dataset.cfriend)];
        draft.players.push({
          id: S.uid(),
          name: p.name,
          gender: p.gender || "M",
          level: p.level || 0
        });
        renderCreate();
      };
    });
  }

  function playersForm() {
    return (
      '<div class="card"><div class="field"><label>选手（' + draft.players.length + ' 人）</label>' +
      '<div class="players">' +
      draft.players.map(
        (p, i) =>
          '<div class="player-row"><span class="name">' + esc(p.name) + '</span>' +
          '<span class="tag">' + (p.gender === 'F' ? '女' : '男') + ' · ' + p.level + '级</span>' +
          '<button class="del" data-del="' + i + '">×</button></div>'
      ).join('') +
      '</div>' +
      '<div class="player-add">' +
      '<input type="text" id="pname" placeholder="姓名，可逗号批量">' +
      '<select id="pgender"><option value="M">男</option><option value="F">女</option></select>' +
      '<select id="plevel">' + levelOptions() + '</select>' +
      '<button class="ghost" id="padd">添加</button></div>' +
      '<div class="hint">批量：张三,李四,王五（按当前性别 / 等级添加）</div>' +
      '<div id="create-friends"></div></div></div>'
    );
  }

  function levelOptions() {
    let out = '';
    for (let i = 0; i <= 10; i++) out += '<option value="' + i + '">' + i + '级</option>';
    return out;
  }

  function teamsForm() {
    let html = '<div class="card"><div class="field"><label>队伍</label>';
    draft.teams.forEach((team, ti) => {
      html +=
        '<div style="margin-bottom:12px">' +
        '<input type="text" data-teamname="' + ti + '" value="' + esc(team.name) + '" style="margin-bottom:6px">' +
        '<div class="players">' +
        team.players
          .map(
            (p, pi) =>
              '<div class="player-row"><span class="name">' + esc(p.name) + '</span>' +
              '<span class="tag">' + (p.gender === 'F' ? '女' : '男') + '</span>' +
              '<button class="del" data-delteam="' + ti + '" data-pi="' + pi + '">×</button></div>'
          )
          .join('') +
        '</div>' +
        '<div class="player-add">' +
        '<input type="text" data-tname="' + ti + '" placeholder="姓名">' +
        '<select data-tgender="' + ti + '"><option value="M">男</option><option value="F">女</option></select>' +
        '<button class="ghost" data-tadd="' + ti + '">加入</button></div></div>';
    });
    if (draft.group === 'teams') {
      html += '<button class="btn secondary" id="addteam">增加队伍</button>';
    }
    return html + '</div></div>';
  }

  function wireCreate() {
    view.querySelector('#race-name').oninput = e => {
      draft.name = e.target.value;
    };
    view.querySelectorAll("[data-court]").forEach(btn => {
      btn.onclick = () => {
        const next = Number(btn.dataset.court);
        if (draft.courts === next) return;
        draft.courts = next;
        renderCreate();
      };
    });
    view.querySelectorAll("[data-signup]").forEach(btn => {
      btn.onclick = () => {
        const next = btn.dataset.signup === "1";
        if (draft.signup === next) return;
        draft.signup = next;
        renderCreate();
      };
    });
    view.querySelectorAll("[data-group]").forEach(btn => {
      btn.onclick = () => {
        if (draft.group === btn.dataset.group) return;
        draft.group = btn.dataset.group;
        draft.mode = Object.keys(R.MODES).filter(k => R.MODES[k].group === draft.group)[0];
        renderCreate();
      };
    });
    view.querySelectorAll("[data-mode]").forEach(btn => {
      btn.onclick = () => {
        draft.mode = btn.dataset.mode;
        const d = playOf(draft.mode).defaults || {};
        if (d.rounds) draft.rounds = d.rounds;
        if (d.balls) draft.balls = d.balls;
        if (d.rankMode) draft.rankMode = d.rankMode;
        if (d.matchesPerEntity) draft.matchesPerEntity = d.matchesPerEntity;
        if (d.arenaKings) draft.arenaKings = d.arenaKings;
        if (d.partnerMode) draft.partnerMode = d.partnerMode;
        renderCreate();
      };
    });
    view.querySelectorAll("[data-rounds]").forEach(btn => {
      btn.onclick = () => {
        const next = Number(btn.dataset.rounds);
        if (draft.rounds === next) return;
        draft.rounds = next;
        renderCreate();
      };
    });
    view.querySelectorAll('[data-wheel]').forEach(btn => {
      btn.onclick = () => {
        draft.wheelMode = btn.dataset.wheel;
        renderCreate();
      };
    });
    view.querySelectorAll('[data-partner]').forEach(btn => {
      btn.onclick = () => {
        draft.partnerMode = btn.dataset.partner;
        renderCreate();
      };
    });

    const dateInput = view.querySelector("#race-date");
    if (dateInput) dateInput.oninput = () => { draft.date = dateInput.value; };
    const venueSelect = view.querySelector("#race-venue");
    if (venueSelect) venueSelect.onchange = () => { draft.venueId = venueSelect.value; };

    const balls = view.querySelector('#balls');
    if (balls) balls.onchange = () => {
      draft.balls = Number(balls.value);
      renderCreate();
    };
    const rankmode = view.querySelector('#rankmode');
    if (rankmode) rankmode.onchange = () => {
      draft.rankMode = rankmode.value;
    };
    const per = view.querySelector('#per');
    if (per) per.onchange = () => {
      draft.matchesPerEntity = Number(per.value) || 1;
    };
    const kings = view.querySelector('#kings');
    if (kings) kings.onchange = () => {
      draft.arenaKings = Number(kings.value) || 1;
    };
    const groupsize = view.querySelector('#groupsize');
    if (groupsize) groupsize.onchange = () => {
      draft.groupSize = Number(groupsize.value) || 4;
    };

    const add = view.querySelector('#padd');
    if (add) add.onclick = () => {
      const raw = view.querySelector('#pname').value.trim();
      if (!raw) return;
      raw.split(/[,，\s]+/).filter(Boolean).forEach(name => {
        draft.players.push({
          id: S.uid('p'),
          name,
          gender: view.querySelector('#pgender').value,
          level: Number(view.querySelector('#plevel').value)
        });
      });
      renderCreate();
    };
    fillCreateFriends();

    view.querySelectorAll('[data-del]').forEach(btn => {
      btn.onclick = () => {
        draft.players.splice(Number(btn.dataset.del), 1);
        renderCreate();
      };
    });

    view.querySelectorAll('[data-teamname]').forEach(input => {
      input.oninput = () => {
        draft.teams[Number(input.dataset.teamname)].name = input.value;
      };
    });
    view.querySelectorAll('[data-tadd]').forEach(btn => {
      btn.onclick = () => {
        const ti = Number(btn.dataset.tadd);
        const raw = view.querySelector('[data-tname="' + ti + '"]').value.trim();
        if (!raw) return;
        raw.split(/[,，\s]+/).filter(Boolean).forEach(name => {
          draft.teams[ti].players.push({
            id: S.uid('p'),
            name,
            gender: view.querySelector('[data-tgender="' + ti + '"]').value,
            level: 0
          });
        });
        renderCreate();
      };
    });
    view.querySelectorAll('[data-delteam]').forEach(btn => {
      btn.onclick = () => {
        draft.teams[Number(btn.dataset.delteam)].players.splice(Number(btn.dataset.pi), 1);
        renderCreate();
      };
    });
    const addteam = view.querySelector('#addteam');
    if (addteam) addteam.onclick = () => {
      if (draft.teams.length >= 12) return modal('最多 12 支队伍');
      draft.teams.push({ name: String.fromCharCode(65 + draft.teams.length) + ' 队', players: [] });
      renderCreate();
    };

    view.querySelectorAll("[data-preset]").forEach((btn) => {
      btn.onclick = () => {
        const preset = PRESETS.find((p) => p.id === btn.dataset.preset);
        if (!preset) return;
        draft = Object.assign(blankDraft(), {
          name: preset.name || draft.name,
          group: preset.group || draft.group,
          mode: preset.mode || draft.mode,
          rounds: preset.rounds || draft.rounds,
          balls: preset.balls || draft.balls,
          courts: preset.courts || 0,
          signup: preset.signup !== false,
          partnerMode: preset.partnerMode || draft.partnerMode,
          wheelMode: preset.wheelMode || draft.wheelMode,
          rankMode: preset.rankMode || draft.rankMode,
          matchesPerEntity: preset.matchesPerEntity || draft.matchesPerEntity,
          arenaKings: preset.arenaKings || draft.arenaKings,
          groupSize: preset.groupSize || draft.groupSize,
          venueId: preset.venueId || ""
        });
        renderCreate();
      };
    });

    const savePresetBtn = view.querySelector("#save-preset");
    if (savePresetBtn) {
      savePresetBtn.onclick = () => {
        const name = (draft.name || "模板").trim();
        S.savePreset(name, {
          name,
          group: draft.group,
          mode: draft.mode,
          rounds: draft.rounds,
          balls: draft.balls,
          courts: draft.courts,
          signup: draft.signup,
          partnerMode: draft.partnerMode,
          wheelMode: draft.wheelMode,
          rankMode: draft.rankMode,
          matchesPerEntity: draft.matchesPerEntity,
          arenaKings: draft.arenaKings,
          groupSize: draft.groupSize,
          venueId: draft.venueId
        })
          .then(() => modal("已存为模板", [{ label: "好的", primary: true }]))
          .catch((e) => modal((e && e.detail) || "保存失败"));
      };
    }

    view.querySelector('#create').onclick = createRace;
  }

  async function createRace() {
    const play = playOf(draft.mode);
    const isTeam = draft.group === 'match' || draft.group === 'teams';
    let players = draft.players.slice();
    let teams = draft.teams.map((t, i) => ({
      name: t.name || i + 1 + '队',
      players: t.players.map(p => p.id)
    }));

    if (isTeam) {
      if (teams.length < 2) return modal('至少需要 2 支队伍');
      if (draft.group === 'teams' && teams.length < 3) return modal('团体赛至少需要 3 支队伍');
      const need = draft.mode === 'singlesMatch' || draft.mode === 'fixedMatch' ? 1 : 2;
      for (const team of teams) {
        if (team.players.length < need) return modal('「' + team.name + '」至少需要 ' + need + ' 名选手');
      }
      players = [];
      draft.teams.forEach(t => t.players.forEach(p => players.push(p)));
    } else if (!draft.signup && players.length < (play.min || 2)) {
      return modal('至少需要 ' + (play.min || 2) + ' 名选手');
    }

    let venue = null;
    if (draft.venueId) {
      venue = (VENUE_CACHE || []).find((v) => v.id === draft.venueId) || null;
    }

    const race = {
      id: S.uid('race'),
      name: draft.name || '未命名比赛',
      playName: play.name,
      playRules: play.rules || {},
      courts: draft.courts || 0,
      date: draft.date || null,
      venueId: venue ? venue.id : null,
      venue: venue
        ? {
            name: venue.name,
            address: venue.address,
            lat: venue.lat,
            lng: venue.lng,
            coordType: venue.coord_type || 'gcj02'
          }
        : null,
      mode: draft.mode,
      group: draft.group,
      rounds: draft.rounds,
      balls: draft.balls,
      wheelMode: draft.wheelMode,
      partnerMode: draft.partnerMode,
      rankMode: draft.rankMode,
      matchesPerEntity: draft.matchesPerEntity,
      arenaKings: draft.arenaKings,
      groupSize: draft.groupSize,
      groupsValid: 3,
      players,
      teams,
      matches: [],
      createdAt: Date.now()
    };
    // 报名制：等报名结束再开始；直接开打：创建即进行中
    race.status = draft.signup ? "draft" : "playing";

    const generated = draft.signup ? [] : BA.plays.generate(race);
    race.matches = generated.map(m => ({
      id: S.uid('m'),
      round: m.round,
      court: m.court,
      side1: m.side1,
      side2: m.side2,
      teamA: m.teamA,
      teamB: m.teamB,
      scores: [],
      scoreAll: null,
      crt: [0, 0],
      status: 'pending'
    }));

    await S.createRace(race);
    draft = null;
    go('#/race/' + race.id);
  }

  /* ---------------- 我的（资料） ---------------- */

  function avatarHTML(dataUrl, cls) {
    if (dataUrl) return '<img class="avatar ' + (cls || "") + '" src="' + esc(dataUrl) + '" alt="">';
    return '<div class="avatar avatar-empty ' + (cls || "") + '">?</div>';
  }

  async function renderMe() {
    topbar.innerHTML = topbarHTML({ title: '我的', back: true });
    wireTopbar({});

    const name = S.me();
    const av = S.avatar();
    view.innerHTML =
      '<div class="card">' +
      avatarHTML(av, "big") +
      '<div class="field"><label>昵称</label>' +
      '<input type="text" id="me-name" value="' + esc(name) + '" placeholder="你的昵称"></div>' +
      '<div class="field"><label>头像</label>' +
      '<input type="file" id="me-avatar" accept="image/*" style="display:none">' +
      '<button class="btn secondary" id="me-pick">选择头像</button></div>' +
      '<button class="btn" id="me-save">保存</button>' +
      '<div class="hint">昵称/头像用于报名与历史记录，只影响之后的报名。</div></div>';

    let pickedAvatar = av;
    document.getElementById("me-pick").onclick = () => document.getElementById("me-avatar").click();
    document.getElementById("me-avatar").onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const dataUrl = await readAvatar(file);
      pickedAvatar = dataUrl;
      view.querySelector(".avatar").src = dataUrl;
    };
    document.getElementById("me-save").onclick = async () => {
      const nickname = view.querySelector("#me-name").value.trim();
      if (!nickname && !pickedAvatar) return;
      try {
        await S.updateProfile({
          nickname: nickname || undefined,
          avatar: pickedAvatar || undefined,
        });
        S.setMe(nickname);
        modal("已保存", [{ label: "好的", primary: true }]);
      } catch (err) {
        modal((err && err.detail) || "保存失败");
      }
    };
  }

  /* ---------------- 战绩 ---------------- */

  async function renderStats(query) {
    topbar.innerHTML = topbarHTML({ title: '战绩', brand: true });
    wireTopbar({});

    const who = (query && query.name) || '';
    let stats = null;
    let err = '';
    try {
      stats = who ? await S.statsOf(who) : await S.myStats();
    } catch (e) {
      err = (e && e.detail) || '统计加载失败';
    }

    const pct = v => (v.alls ? Math.round((v.wins / v.alls) * 100) + '%' : '—');
    const title = who ? who + ' 的战绩' : (S.me() || '我') + ' 的战绩';

    if (!stats) {
      view.innerHTML = '<div class="card"><div class="meta">' + esc(err) + '</div></div>';
      return;
    }

    view.innerHTML =
      '<div class="card"><div class="row-between"><h3>' + esc(title) + '</h3>' +
      '<button class="ghost" id="search-other">查别人</button></div>' +
      '<div class="meta">' + (who ? '按名字匹配' : '按你的账号身份匹配，改昵称也不丢') + '</div></div>' +
      '<div class="stat-grid">' +
      statCard('总场次', stats.total.alls) +
      statCard('胜率', pct(stats.total)) +
      statCard('单打胜率', pct(stats.singles)) +
      statCard('双打胜率', pct(stats.doubles)) +
      '</div>' +
      '<div class="card" style="margin-top:12px"><h3>' + esc(stats.name || title) + '</h3>' +
      '<div class="meta">' + stats.total.wins + ' 胜 / ' + stats.total.fail + ' 负' +
      (stats.total.even ? ' / ' + stats.total.even + ' 平' : '') +
      ' · 共 ' + stats.rounds + ' 局</div>' +
      (stats.total.alls === 0
        ? '<div class="meta">还没有打完的比赛，去开一局吧。</div>'
        : '') +
      '</div>';

    view.querySelector('#search-other').onclick = () => {
      modal('输入要查的名字', [{ label: '取消' }], {
        input: { value: who, placeholder: '选手昵称' },
        onConfirm: name => {
          if (!name) return;
          location.hash = '#/stats?name=' + encodeURIComponent(name);
        }
      });
    };
  }

  function statCard(label, value) {
    return '<div class="stat"><div class="k">' + esc(label) + '</div><div class="v">' + esc(value) + '</div></div>';
  }

  /* ---------------- 启动 ---------------- */

  global.addEventListener('hashchange', route);

  function wxTried() {
    try {
      return sessionStorage.getItem("gorilla_wx_tried") === "1";
    } catch (e) {
      return false;
    }
  }

  function markWxTried() {
    try {
      sessionStorage.setItem("gorilla_wx_tried", "1");
    } catch (e) {
      /* 忽略 */
    }
  }

  async function serverFeatures() {
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      return data.features || {};
    } catch (e) {
      return {};
    }
  }

  (async () => {
    const params = new URLSearchParams(location.search);
    const token = params.get("token");
    if (token) {
      S.adoptToken(token);
      params.delete("token");
      const query = params.toString();
      history.replaceState(null, "", location.pathname + (query ? "?" + query : "") + location.hash);
    } else if (!S.hasToken() && BA.nav.isWechat() && !wxTried()) {
      // 微信内且服务端配置了公众号：静默走网页授权
      const features = await serverFeatures();
      if (features.wechatOAuth) {
        markWxTried();
        const back = location.pathname + location.hash;
        location.replace("/api/auth/wechat/start?redirect=" + encodeURIComponent(back));
        return;
      }
    }

    serverOk = await S.init();
    try {
      myRole = (await S.meInfo()).role || "user";
    } catch (e) {
      myRole = "user";
    }
    if (BA.plays && BA.plays.ready) {
      try {
        await BA.plays.ready;
      } catch (e) {
        /* 玩法模块加载失败时回退到内置赛制 */
      }
    }
    await loadPlays();
    try {
      VENUE_CACHE = await S.venues();
    } catch (e) {
      VENUE_CACHE = [];
    }
    await S.pull();
    route();
  })();
})(window);
