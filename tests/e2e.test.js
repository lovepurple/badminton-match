/*
 * 端到端测试：H5 数据层 ↔ Python 服务端。
 * 启动临时 uvicorn，用真实 HTTP 驱动 h5/js/store.js。
 *
 *   node tests/e2e.test.js
 */
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const PORT = 8011;
const BASE = 'http://127.0.0.1:' + PORT;
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gorilla-e2e-')), 'e2e.db');
const SERVER_DIR = path.join(__dirname, '..', 'server');

/* ---- 浏览器环境垫片 ---- */

const mem = {};
global.window = global;
global.localStorage = {
  getItem: key => (key in mem ? mem[key] : null),
  setItem: (key, value) => {
    mem[key] = String(value);
  },
  removeItem: key => {
    delete mem[key];
  },
  clear: () => {
    Object.keys(mem).forEach(key => delete mem[key]);
  }
};
global.BA_API_BASE = BASE;

require('../h5/js/api.js');
require('../h5/js/store.js');

const store = global.BA.store;
const formats = require('../shared/formats.js');
const ranking = require('../shared/ranking.js');

const KEY = 'gorilla-badminton/h5/v1';

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    console.error('  FAIL ' + name);
    console.error('       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e));
    process.exitCode = 1;
  }
}

function httpJson(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (token) headers.authorization = 'Bearer ' + token;
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path: urlPath, method, headers },
      res => {
        let buf = '';
        res.on('data', d => (buf += d));
        res.on('end', () => {
          let data = buf;
          try {
            data = JSON.parse(buf);
          } catch (e) {
            /* 原样返回 */
          }
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await httpJson('GET', '/api/health');
      if (res.status === 200) return;
    } catch (e) {
      /* 还没起来 */
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

function token() {
  return JSON.parse(mem[KEY]).token;
}

function buildRace() {
  const players = ['阿豪', '小林', '老王', '阿杰'].map((name, i) => ({
    id: 'p' + i,
    name,
    gender: i === 1 ? 'F' : 'M',
    level: i
  }));
  const race = {
    id: store.uid('race'),
    name: 'E2E 单打转',
    mode: 'singlesRound',
    group: 'singles',
    rounds: 3,
    balls: 21,
    wheelMode: 'isolate',
    partnerMode: 'random',
    rankMode: 'pointFirst',
    matchesPerEntity: 2,
    arenaKings: 1,
    groupSize: 4,
    groupsValid: 3,
    players,
    teams: [],
    matches: [],
    createdAt: Date.now()
  };
  race.matches = formats.generate(race).map(m => ({
    id: store.uid('m'),
    round: m.round,
    court: m.court,
    side1: m.side1,
    side2: m.side2,
    scores: [],
    scoreAll: null,
    crt: [0, 0],
    status: 'pending'
  }));
  return race;
}

(async () => {
  const proc = spawn('python', ['-m', 'uvicorn', 'app.main:app', '--port', String(PORT)], {
    cwd: SERVER_DIR,
    env: Object.assign({}, process.env, { GORILLA_DB: DB }),
    stdio: 'ignore'
  });

  try {
    await waitForServer();
    console.log('服务端已启动 ' + BASE);

    const race = buildRace();

    await step('登录并拉取空列表', async () => {
      assert.strictEqual(await store.init(), true);
      assert.deepStrictEqual(await store.pull(), []);
    });

    await step('创建比赛后写入服务端', async () => {
      await store.createRace(race);
      const res = await httpJson('GET', '/api/races/' + race.id, null, token());
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.name, 'E2E 单打转');
      assert.strictEqual(res.data.matches.length, race.matches.length);
    });

    await step('提交比分后服务端可见', async () => {
      const match = race.matches[0];
      match.scores = [[21, 15], [21, 18]];
      match.scoreAll = [2, 0];
      match.status = 'done';
      await store.updateMatch(race.id, match);

      const res = await httpJson('GET', '/api/races/' + race.id, null, token());
      const saved = res.data.matches.find(m => m.id === match.id);
      assert.deepStrictEqual(saved.scoreAll, [2, 0]);
      assert.deepStrictEqual(saved.scores, [[21, 15], [21, 18]]);
    });

    await step('服务端排名与客户端一致', async () => {
      const res = await httpJson('GET', '/api/races/' + race.id + '/rank', null, token());
      const local = ranking.compute(race);
      assert.strictEqual(res.data.kind, local.kind);
      assert.deepStrictEqual(
        res.data.rows.map(r => [r.name, r.point, r.wins, r.netball]),
        local.rows.map(r => [r.name, r.point, r.wins, r.netball])
      );
    });

    await step('离线创建进入待同步队列，恢复后自动补传', async () => {
      global.BA_API_BASE = 'http://127.0.0.1:9';
      const offlineRace = buildRace();
      offlineRace.name = '离线比赛';
      await store.createRace(offlineRace);
      assert.strictEqual(JSON.parse(mem[KEY]).pending.length, 1);

      global.BA_API_BASE = BASE;
      await store.pull();
      const res = await httpJson('GET', '/api/races/' + offlineRace.id, null, token());
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.name, '离线比赛');
      assert.strictEqual(JSON.parse(mem[KEY]).pending.length, 0);
    });

    await step('个人战绩接口可用', async () => {
      const res = await httpJson('GET', '/api/stats?name=' + encodeURIComponent('阿豪'), null, token());
      assert.strictEqual(res.status, 200);
      assert.ok(res.data.total.alls >= 1);
    });

    await step('删除比赛后服务端不可见', async () => {
      await store.removeRace(race.id);
      const res = await httpJson('GET', '/api/races/' + race.id, null, token());
      assert.strictEqual(res.status, 404);
    });
  } finally {
    proc.kill();
  }

  console.log('\n' + passed + ' passed');
})();
