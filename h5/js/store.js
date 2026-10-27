(function (global) {
  const BA = (global.BA = global.BA || {});
  const api = BA.api;
  const BASE_KEY = 'gorilla-badminton/h5/v1';

  /*
   * 同一台设备模拟多个用户（演示/测试用）：
   * 打开 ?device=demo1 / ?device=demo2 各自成为独立用户，
   * 身份存在 sessionStorage（标签页级），不会影响正常用户的 localStorage 身份。
   */
  function deviceOverride() {
    try {
      const fromUrl = new URLSearchParams(location.search).get('device');
      if (fromUrl) {
        sessionStorage.setItem('gorilla_device_override', fromUrl);
        return fromUrl;
      }
      return sessionStorage.getItem('gorilla_device_override') || '';
    } catch (e) {
      return '';
    }
  }

  const OVERRIDE = deviceOverride();
  const KEY = BASE_KEY + (OVERRIDE ? '@' + OVERRIDE : '');

  function blank() {
    return { races: [], me: '', avatar: '', token: '', userId: '', deviceId: '', pending: [] };
  }

  function load() {
    try {
      const raw = global.localStorage.getItem(KEY);
      if (!raw) return blank();
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.races)) return blank();
      data.pending = data.pending || [];
      return data;
    } catch (e) {
      return blank();
    }
  }

  const state = load();

/* 头像字段兼容：老缓存里没有 */
if (!state.avatar) state.avatar = "";

  function save() {
    try {
      global.localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      /* 隐私模式忽略 */
    }
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function deviceId() {
    if (OVERRIDE) return OVERRIDE;
    if (!state.deviceId) {
      state.deviceId = 'web-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      save();
    }
    return state.deviceId;
  }

  async function ensureAuth() {
    if (state.token) {
      api.setToken(state.token);
      return;
    }
    const res = await api.request('/api/auth/login', {
      method: 'POST',
      auth: false,
      data: { deviceId: deviceId() }
    });
    state.token = res.token;
    state.userId = res.user.id;
    save();
    api.setToken(state.token);
  }

  function strip(doc) {
    if (!doc) return doc;
    const copy = Object.assign({}, doc);
    delete copy._ownerId;
    delete copy._updatedAt;
    return copy;
  }

  function replaceLocal(race) {
    for (let i = 0; i < state.races.length; i++) {
      if (state.races[i].id === race.id) {
        state.races[i] = race;
        return;
      }
    }
    state.races.unshift(race);
  }

  function enqueue(op) {
    state.pending.push(op);
    save();
  }

  async function authed(path, options) {
    await ensureAuth();
    try {
      return await api.request(path, options);
    } catch (e) {
      if (e && e.status === 401) {
        // 令牌失效（服务端重置/过期）：清空后重登一次
        state.token = "";
        save();
        api.setToken("");
        await ensureAuth();
        return api.request(path, options);
      }
      throw e;
    }
  }

  async function flush() {
    if (!state.pending.length) return;
    const left = [];
    for (const op of state.pending) {
      try {
        if (op.op === 'race.post') {
          const doc = await authed('/api/races', { method: 'POST', data: op.race });
          replaceLocal(strip(doc));
        } else if (op.op === 'race.put') {
          await authed('/api/races/' + op.race.id, { method: 'PUT', data: op.race });
        } else if (op.op === 'race.delete') {
          await authed('/api/races/' + op.id, { method: 'DELETE' });
        } else if (op.op === 'match.put') {
          await authed('/api/races/' + op.raceId + '/matches/' + op.match.id, {
            method: 'PUT',
            data: op.match
          });
        }
      } catch (e) {
        if (e && e.offline) {
          left.push(op);
          continue;
        }
      }
    }
    state.pending = left;
    save();
  }

  async function init() {
    try {
      await ensureAuth();
      return true;
    } catch (e) {
      return false;
    }
  }

  async function pull() {
    try {
      await flush();
      const res = await authed('/api/races?full=1');
      state.races = (res.races || []).map(strip);
      save();
    } catch (e) {
      /* 离线：保留本地缓存 */
    }
    return state.races;
  }

  function races() {
    return state.races;
  }

  function getRace(id) {
    for (let i = 0; i < state.races.length; i++) {
      if (state.races[i].id === id) return state.races[i];
    }
    return null;
  }

  async function fetchRace(id) {
    const doc = await call('/api/races/' + id);
    const race = strip(doc);
    replaceLocal(race);
    save();
    return race;
  }

  function cache(race) {
    replaceLocal(race);
    save();
  }

  async function createRace(race) {
    if (!race.status) race.status = 'draft';
    replaceLocal(race);
    save();
    try {
      const doc = await authed('/api/races', { method: 'POST', data: race });
      replaceLocal(strip(doc));
      save();
    } catch (e) {
      enqueue({ op: 'race.post', race });
    }
    return race;
  }

  async function updateRace(race) {
    cache(race);
    try {
      await authed('/api/races/' + race.id, { method: 'PUT', data: race });
    } catch (e) {
      enqueue({ op: 'race.put', race });
    }
    return race;
  }

  async function updateMatch(raceId, match) {
    try {
      await authed('/api/races/' + raceId + '/matches/' + match.id, {
        method: 'PUT',
        data: match
      });
    } catch (e) {
      enqueue({ op: 'match.put', raceId, match });
    }
  }

  async function removeRace(id) {
    state.races = state.races.filter(r => r.id !== id);
    save();
    try {
      await authed('/api/races/' + id, { method: 'DELETE' });
    } catch (e) {
      enqueue({ op: 'race.delete', id });
    }
  }

  async function call(path, options) {
    return authed(path, options);
  }

  /* ---- 报名 / 比赛流程 ---- */

  async function openSignup(race, maxPlayers) {
    const doc = await call('/api/races/' + race.id + '/open', {
      method: 'POST',
      data: { maxPlayers: maxPlayers || 0 }
    });
    replaceLocal(strip(doc));
    save();
    return doc;
  }

  async function joinInfo(code) {
    return call('/api/join/' + encodeURIComponent(code));
  }

  async function joinRace(raceId, profile) {
    return call('/api/races/' + raceId + '/join', { method: 'POST', data: profile });
  }

  async function leaveRace(raceId) {
    return call('/api/races/' + raceId + '/join', { method: 'DELETE' });
  }

  async function participants(raceId) {
    return call('/api/races/' + raceId + '/participants');
  }

  async function startRace(raceId, players, matches) {
    const doc = await call('/api/races/' + raceId + '/start', {
      method: 'POST',
      data: { players, matches }
    });
    replaceLocal(strip(doc));
    save();
    return doc;
  }

  async function finishRace(raceId) {
    return call('/api/races/' + raceId + '/finish', { method: 'POST' });
  }

  async function live(raceId, since) {
    return call('/api/races/' + raceId + '/live?since=' + (since || 0));
  }

  async function summary(raceId) {
    return call('/api/races/' + raceId + '/summary');
  }

  async function venues() {
    const res = await call('/api/venues');
    return res.venues || [];
  }

  async function resolveVenue(url) {
    return call('/api/venues/resolve', { method: 'POST', data: { url } });
  }

  async function saveVenue(venue) {
    const path = venue.id ? '/api/venues/' + venue.id : '/api/venues';
    return call(path, { method: venue.id ? 'PUT' : 'POST', data: venue });
  }

  async function removeVenue(id) {
    return call('/api/venues/' + id, { method: 'DELETE' });
  }

  async function claimAdmin(code) {
    return call('/api/auth/admin-claim', { method: "POST", data: { code } });
  }

  async function formatOverrides() {
    return call('/api/formats');
  }

  async function saveFormat(id, data) {
    return call('/api/formats/' + encodeURIComponent(id), { method: 'PUT', data });
  }

  async function resetFormat(id) {
    return call('/api/formats/' + encodeURIComponent(id), { method: 'DELETE' });
  }

  async function meInfo() {
    return call('/api/me');
  }

  function adoptToken(value) {
    if (!value) return;
    state.token = value;
    save();
    api.setToken(value);
  }

  function hasToken() {
    return !!state.token;
  }

  function me() {
    return state.me || '';
  }

  function avatar() {
    return state.avatar || "";
  }

  async function updateProfile(profile) {
    const updated = await call('/api/me', { method: 'PUT', data: profile });
    if (profile.nickname) {
      state.me = profile.nickname;
    }
    if (profile.avatar) {
      state.avatar = profile.avatar;
    }
    save();
    return updated;
  }

  async function people() {
    return call('/api/people');
  }

  function setMe(name) {
    state.me = name;
    save();
  }

  BA.store = {
    init,
    pull,
    flush,
    uid,
    races,
    getRace,
    fetchRace,
    cache,
    createRace,
    updateRace,
    updateMatch,
    removeRace,
    claimAdmin,
    formatOverrides,
    saveFormat,
    resetFormat,
    venues,
    resolveVenue,
    saveVenue,
    removeVenue,
    meInfo,
    openSignup,
    joinInfo,
    joinRace,
    leaveRace,
    participants,
    startRace,
    finishRace,
    live,
    summary,
    adoptToken,
    hasToken,
    me,
    setMe,
    avatar,
    updateProfile,
    people
  };
})(window);
