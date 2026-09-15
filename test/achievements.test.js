'use strict';
// 赛季成就徽章纯逻辑单测：里程碑定义、按累计数据点亮、未达成进度、汇总统计。
const test = require('node:test');
const assert = require('node:assert');
const a = require('../public/achievements');

test('徽章定义：覆盖场次/胜场/最高连锁三类里程碑，id 唯一且目标为正数', () => {
  assert.ok(a.BADGES.length >= 6);
  for (const metric of ['games', 'wins', 'bestChain']) {
    assert.ok(a.BADGES.some(b => b.metric === metric), `应有 ${metric} 类徽章`);
  }
  const ids = a.BADGES.map(b => b.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'id 不重复');
  for (const b of a.BADGES) {
    assert.ok(b.target > 0);
    assert.ok(b.name && b.icon && b.desc);
  }
});

test('空数据：全部徽章未点亮、进度为 0', () => {
  const badges = a.evaluate({});
  assert.strictEqual(badges.length, a.BADGES.length);
  assert.ok(badges.every(b => b.earned === false));
  assert.ok(badges.every(b => b.current === 0 && b.percent === 0));
});

test('场次徽章随累计场次点亮，未达成显示当前进度', () => {
  const badges = a.evaluate({ games: 1, wins: 0, bestChain: 0 });
  const g1 = badges.find(b => b.id === 'games-1');
  const g10 = badges.find(b => b.id === 'games-10');
  assert.strictEqual(g1.earned, true);
  assert.strictEqual(g1.percent, 100);
  assert.strictEqual(g10.earned, false);
  assert.strictEqual(g10.current, 1);
  assert.strictEqual(g10.percent, 10);

  // 打到 5 场：games-10 进度 50%，games-1 保持点亮
  const mid = a.evaluate({ games: 5, wins: 0, bestChain: 0 });
  assert.strictEqual(mid.find(b => b.id === 'games-10').percent, 50);
  assert.strictEqual(mid.find(b => b.id === 'games-1').earned, true);
});

test('胜场徽章只看胜场（平局不点亮胜场徽章）', () => {
  // 5 场全是平局：场次有积累，但胜场徽章一枚不亮
  const badges = a.evaluate({ games: 5, wins: 0, ties: 5, bestChain: 0 });
  assert.ok(badges.filter(b => b.metric === 'wins').every(b => !b.earned));
  assert.strictEqual(badges.find(b => b.id === 'wins-1').current, 0);

  const won = a.evaluate({ games: 5, wins: 3, bestChain: 0 });
  assert.strictEqual(won.find(b => b.id === 'wins-1').earned, true);
  assert.strictEqual(won.find(b => b.id === 'wins-3').earned, true);
  assert.strictEqual(won.find(b => b.id === 'wins-10').earned, false);
  assert.strictEqual(won.find(b => b.id === 'wins-10').current, 3);
});

test('最高连锁徽章取历史最大值；超过目标后进度截顶在满格', () => {
  const badges = a.evaluate({ games: 1, wins: 1, bestChain: 4 });
  assert.strictEqual(badges.find(b => b.id === 'chain-3').earned, true);
  assert.strictEqual(badges.find(b => b.id === 'chain-5').earned, false);
  assert.strictEqual(badges.find(b => b.id === 'chain-5').current, 4);
  assert.strictEqual(badges.find(b => b.id === 'chain-5').percent, 80);

  // bestChain 远超最高档：current 截顶到 target、percent=100，不显示 12/8
  const over = a.evaluate({ games: 1, wins: 1, bestChain: 12 });
  for (const b of over.filter(x => x.metric === 'bestChain')) {
    assert.strictEqual(b.earned, true);
    assert.strictEqual(b.current, b.target);
    assert.strictEqual(b.percent, 100);
  }
});

test('徽章带指标中文名与定义透传（图标/名称/描述/目标）', () => {
  const [b] = a.evaluate({ games: 1 });
  assert.strictEqual(b.label, '场次');
  assert.strictEqual(b.target, a.BADGES[0].target);
  assert.strictEqual(b.name, a.BADGES[0].name);
  assert.strictEqual(a.metricLabel('wins'), '胜场');
  assert.strictEqual(a.metricLabel('bestChain'), '最高连锁');
});

test('脏输入不抛错：null/缺字段/非数字都当作 0', () => {
  assert.doesNotThrow(() => a.evaluate(null));
  const badges = a.evaluate({ games: 'x', wins: -3, bestChain: NaN });
  assert.ok(badges.every(b => !b.earned && b.current === 0));
});

test('summarize：统计已点亮数量与总数', () => {
  assert.deepStrictEqual(a.summarize(a.evaluate({ games: 10, wins: 1, bestChain: 3 })),
    { earned: 4, total: a.BADGES.length }); // games-1/10、wins-1、chain-3
  assert.deepStrictEqual(a.summarize([]), { earned: 0, total: 0 });
  assert.deepStrictEqual(a.summarize(null), { earned: 0, total: 0 });
});

test('全部达成：所有徽章点亮', () => {
  const badges = a.evaluate({ games: 50, wins: 10, bestChain: 8 });
  assert.ok(badges.every(b => b.earned));
  assert.deepStrictEqual(a.summarize(badges), { earned: badges.length, total: badges.length });
});
