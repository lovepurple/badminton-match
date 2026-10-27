/*
 * 玩法注册表契约测试：node tests/plays.test.js
 * 校验每个玩法模块的字段完整性、排程结构与关键数量。
 */
const assert = require('assert');
const plays = require('../shared/plays/index.js');
const registry = require('../shared/plays/registry.json');

const REQUIRED_RULES = ['people', 'how', 'groups', 'end', 'score'];

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    console.error('  FAIL ' + name);
    console.error('       ' + (e && e.message));
    process.exitCode = 1;
  }
}

function players(n, genders) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: 'p' + i,
      name: 'P' + i,
      gender: genders ? genders[i % genders.length] : i % 2 ? 'F' : 'M',
      level: i
    });
  }
  return out;
}

function assertMatches(matches, playerIds) {
  assert.ok(Array.isArray(matches), 'schedule 必须返回数组');
  matches.forEach((m) => {
    assert.strictEqual(typeof m.round, 'number');
    assert.strictEqual(typeof m.court, 'number');
    assert.ok(Array.isArray(m.side1) && m.side1.length >= 1);
    assert.ok(Array.isArray(m.side2) && m.side2.length >= 1);
    m.side1.concat(m.side2).forEach((id) => {
      assert.ok(playerIds.indexOf(id) >= 0, '未知选手 ' + id);
    });
  });
}

console.log('注册表');
test('registry.json 里的玩法都已加载', () => {
  registry.plays.forEach((item) => {
    assert.ok(plays.get(item.id), '未加载：' + item.id);
  });
});
test('每个玩法字段完整（rules 五段齐全）', () => {
  plays.list().forEach((play) => {
    assert.ok(play.id && play.name && play.group, '缺基础字段：' + play.id);
    assert.ok(play.min >= 1 && play.max >= play.min, '人数范围异常：' + play.id);
    assert.strictEqual(typeof play.schedule, 'function', '缺 schedule：' + play.id);
    if (!play.legacy) {
      REQUIRED_RULES.forEach((key) => {
        assert.ok(
          play.rules && play.rules[key],
          play.id + ' 缺 rules.' + key
        );
      });
    }
  });
});
test('玩法 id 不重复且与 registry 一致', () => {
  const ids = plays.list().map((p) => p.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  registry.plays.forEach((item) => assert.ok(ids.indexOf(item.id) >= 0));
});

console.log('排程');
test('八人转：8 人 7 轮 14 场（搭档不重复）', () => {
  const ps = players(8);
  const ms = plays.generate({ mode: 'eight', players: ps });
  assert.strictEqual(ms.length, 14);
  assert.strictEqual(new Set(ms.map((m) => m.round)).size, 7);
  assertMatches(ms, ps.map((p) => p.id));
});
test('追分赛：8 人每人 3 场 → 12 场', () => {
  const ps = players(8);
  const ms = plays.generate({ mode: 'chase', players: ps, matchesPerEntity: 3 });
  assert.strictEqual(ms.length, 12);
  assertMatches(ms, ps.map((p) => p.id));
});
test('追分赛声明了 chase 计分模型', () => {
  assert.deepStrictEqual(plays.get('chase').scoring, { mode: 'chase' });
  assert.strictEqual(plays.get('chase').group, 'singles');
});
test('混双转：每对男女各搭档一次', () => {
  const ps = players(8, ['M', 'M', 'M', 'M', 'F', 'F', 'F', 'F']);
  const ms = plays.generate({ mode: 'mixRound', players: ps });
  assertMatches(ms, ps.map((p) => p.id));
  const seen = {};
  ms.forEach((m) => {
    [m.side1, m.side2].forEach((side) => {
      const key = side.slice().sort().join('+');
      seen[key] = (seen[key] || 0) + 1;
    });
  });
  Object.keys(seen).forEach((key) => assert.strictEqual(seen[key], 1, key));
});

console.log('排名主体');
test('个人玩法按人、团体玩法按队', () => {
  assert.strictEqual(plays.entityKind('eight'), 'player');
  assert.strictEqual(plays.entityKind('chase'), 'player');
  assert.strictEqual(plays.entityKind('fixedTeams'), 'team');
  assert.strictEqual(plays.entityKind('wheelMatch'), 'team');
});

console.log('兼容性');
test('未迁移玩法仍能生成（legacy 兜底）', () => {
  const ps = players(4);
  const ms = plays.generate({
    mode: 'singlesMatch',
    players: ps,
    teams: [
      { name: 'A', players: ['p0', 'p1'] },
      { name: 'B', players: ['p2', 'p3'] }
    ]
  });
  assert.strictEqual(ms.length, 4);
});

console.log('\n' + passed + ' passed');
