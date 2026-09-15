'use strict';
// 交流广场纯逻辑测试：发布/更新/下架/订阅计数、列表排序与筛选、
// 存档恢复清洗、客户端本机映射的归一化与对账。
const test = require('node:test');
const assert = require('node:assert');
const P = require('../public/plaza.js');

const PID_A = 'a'.repeat(64);
const PID_B = 'b'.repeat(64);
const PID_C = 'c'.repeat(64);

const validPack = (over = {}) => ({
  name: '海洋奇缘', theme: '与海有关', words: ['海浪', '贝壳', '灯塔'], ...over,
});

let idSeq = 0;
const makeGenerate = () => () => `pz_${String(++idSeq).padStart(12, '0')}`.replace(/[^a-f0-9]/g, '0');
// 直接给定 id 序列的生成器（便于断言）
const genFrom = (ids) => {
  let i = 0;
  return () => ids[i++];
};

test('isValidPlazaId / isValidPid：格式校验', () => {
  assert.ok(P.isValidPlazaId('pz_0123456789ab'));
  assert.ok(!P.isValidPlazaId('pz_0123456789abc')); // 13 位
  assert.ok(!P.isValidPlazaId('pz_0123456789'));    // 11 位
  assert.ok(!P.isValidPlazaId('pz_0123456789AB'));  // 大写不行
  assert.ok(!P.isValidPlazaId('ABCD-EFGH'));
  assert.ok(!P.isValidPlazaId(''));
  assert.ok(P.isValidPid(PID_A));
  assert.ok(!P.isValidPid('zz'));
});

test('cleanPack：清洗 trim/去重/空词，非法结构返回 null', () => {
  const r = P.cleanPack({ name: ' 包 ', theme: ' 主题 ', words: [' 甲 ', '甲', '乙', '丙', ''] });
  assert.deepStrictEqual(r, { name: '包', theme: '主题', words: ['甲', '乙', '丙'] });
  assert.strictEqual(P.cleanPack(null), null);
  assert.strictEqual(P.cleanPack({ name: '', words: ['甲', '乙', '丙'] }), null);
  assert.strictEqual(P.cleanPack({ name: '长'.repeat(13), words: ['甲', '乙', '丙'] }), null);
  assert.strictEqual(P.cleanPack({ name: 'n', theme: '长'.repeat(61), words: ['甲', '乙', '丙'] }), null);
  assert.strictEqual(P.cleanPack({ name: 'n', words: ['甲', '乙'] }), null, '不足 3 词');
  assert.strictEqual(P.cleanPack({ name: 'n', words: ['甲', '乙', '很长的词'.repeat(4)] }), null, '单词超 12 字');
  assert.strictEqual(
    P.cleanPack({ name: 'n', words: Array.from({ length: 61 }, (_, i) => `词${i}`) }),
    null, '超过 60 词');
});

test('publish：新建发布；同一作者同一 packId 沿用原条目更新，订阅数保留', () => {
  const store = P.emptyPlaza();
  const r1 = P.publish(store, {
    pid: PID_A, packId: 'pk_1', pack: validPack(), author: '小词',
    now: 100, generate: genFrom(['pz_aaaaaaaaaaa1']),
  });
  assert.strictEqual(r1.error, null);
  assert.strictEqual(r1.id, 'pz_aaaaaaaaaaa1');
  assert.strictEqual(r1.republished, false);

  // 别人订阅两次（不同身份）→ 热度 2
  P.subscribe(store, r1.id, PID_B, 200);
  P.subscribe(store, r1.id, PID_C, 201);
  assert.strictEqual(P.subscriberCount(P.getEntry(store, r1.id)), 2);

  // 同一 packId 再发布：沿用原 id、快照更新、订阅数与发布时间保留
  const r2 = P.publish(store, {
    pid: PID_A, packId: 'pk_1', pack: validPack({ theme: '新主题', words: ['海浪', '贝壳', '灯塔', '鲸鱼'] }),
    author: '小词2', now: 300, generate: genFrom(['pz_bbbbbbbbbbb2']),
  });
  assert.strictEqual(r2.id, r1.id, '沿用原条目');
  assert.strictEqual(r2.republished, true);
  const e = P.getEntry(store, r1.id);
  assert.strictEqual(e.pack.theme, '新主题');
  assert.strictEqual(e.author, '小词2');
  assert.strictEqual(e.publishedAt, 100, '发布时间不变');
  assert.strictEqual(e.updatedAt, 300);
  assert.strictEqual(P.subscriberCount(e), 2, '订阅数保留');

  // 不同 packId → 新条目
  const r3 = P.publish(store, {
    pid: PID_A, packId: 'pk_2', pack: validPack({ name: '校园' }),
    now: 400, generate: genFrom(['pz_ccccccccccc3']),
  });
  assert.strictEqual(r3.republished, false);
  assert.notStrictEqual(r3.id, r1.id);
  assert.strictEqual(P.countByOwner(store, PID_A), 2);
});

test('publish：无身份/坏词包被拒；超过每人上限被拒；generate 撞 id 会重试', () => {
  const store = P.emptyPlaza();
  assert.match(P.publish(store, { pid: 'bad', packId: 'pk', pack: validPack() }).error, /身份/);
  assert.match(P.publish(store, { pid: PID_A, packId: 'pk', pack: { name: 'x', words: [] } }).error, /词包/);

  // 撞 id：第一个候选已被占用时取下一个
  P.publish(store, { pid: PID_A, packId: 'pk_a', pack: validPack(), now: 1, generate: genFrom(['pz_00000000000a']) });
  const r = P.publish(store, {
    pid: PID_B, packId: 'pk_b', pack: validPack(), now: 2,
    generate: genFrom(['pz_00000000000a', 'pz_00000000000b']),
  });
  assert.strictEqual(r.id, 'pz_00000000000b');

  // 每人上限
  const full = P.emptyPlaza();
  let n = 0;
  const gen = () => `pz_${String(++n).padStart(12, '0')}`;
  for (let i = 0; i < P.MAX_PLAZA_PER_OWNER; i++) {
    const ok = P.publish(full, { pid: PID_A, packId: `pk_${i}`, pack: validPack(), now: i, generate: gen });
    assert.strictEqual(ok.error, null);
  }
  const over = P.publish(full, { pid: PID_A, packId: 'pk_over', pack: validPack(), now: 999, generate: gen });
  assert.match(over.error, /最多同时/);
  // 但更新已发布的条目不受上限影响
  const upd = P.publish(full, { pid: PID_A, packId: 'pk_0', pack: validPack({ name: '更新' }), now: 1000, generate: gen });
  assert.strictEqual(upd.error, null);
  assert.strictEqual(upd.republished, true);
});

test('unpublish：只有作者本人能下架', () => {
  const store = P.emptyPlaza();
  const r = P.publish(store, { pid: PID_A, packId: 'pk_1', pack: validPack(), now: 1, generate: genFrom(['pz_aaaaaaaaaaa1']) });
  assert.strictEqual(P.unpublish(store, r.id, PID_B), false, '非作者不能下架');
  assert.ok(P.getEntry(store, r.id), '条目仍在');
  assert.strictEqual(P.unpublish(store, r.id, PID_A), true);
  assert.strictEqual(P.getEntry(store, r.id), null, '下架后消失');
  assert.strictEqual(P.unpublish(store, r.id, PID_A), false, '重复下架失败');
});

test('subscribe：同一身份只计一次热度；无身份不计数也能拿词包；下架后订阅报错', () => {
  const store = P.emptyPlaza();
  const r = P.publish(store, {
    pid: PID_A, packId: 'pk_1', pack: validPack(), now: 1, generate: genFrom(['pz_aaaaaaaaaaa1']),
  });
  const s1 = P.subscribe(store, r.id, PID_B, 10);
  assert.strictEqual(s1.error, null);
  assert.strictEqual(s1.counted, true);
  assert.strictEqual(s1.subscribers, 1);
  assert.deepStrictEqual(s1.pack, validPack());
  assert.strictEqual(s1.packId, 'pk_1');

  const s2 = P.subscribe(store, r.id, PID_B, 20);
  assert.strictEqual(s2.counted, false, '重复订阅不再计数');
  assert.strictEqual(s2.subscribers, 1);

  const s3 = P.subscribe(store, r.id, null, 30);
  assert.strictEqual(s3.counted, false, '无身份不计数');
  assert.strictEqual(s3.subscribers, 1);
  assert.ok(s3.pack.words.length >= 3, '仍能拿到词包');

  P.unpublish(store, r.id, PID_A);
  assert.match(P.subscribe(store, r.id, PID_C, 40).error, /下架/);
});

test('summaries：摘要不含全文、带预览与 mine 标记；hot/new 排序；MAX_LIST 截断', () => {
  const store = P.emptyPlaza();
  const hot = P.publish(store, {
    pid: PID_A, packId: 'pk_hot', pack: validPack({ name: '热门包', theme: '海' }),
    author: '甲', now: 100, generate: genFrom(['pz_0000000000h0'.replace('h', 'a')]),
  });
  const cold = P.publish(store, {
    pid: PID_B, packId: 'pk_cold', pack: validPack({ name: '冷门包', theme: '山', words: ['山峰', '山谷', '山顶', '山洞'] }),
    author: '', now: 200, generate: genFrom(['pz_0000000000c0'.replace('c', 'b')]),
  });
  P.subscribe(store, hot.id, PID_B, 300);
  P.subscribe(store, hot.id, PID_C, 301);

  const list = P.summaries(store, { myPid: PID_B, sort: 'hot' });
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, hot.id, '订阅多的排前');
  assert.strictEqual(list[0].subscribers, 2);
  assert.strictEqual(list[0].mine, false);
  assert.strictEqual(list[1].mine, true, 'myPid 标出自己的发布');
  assert.deepStrictEqual(list[0].words, ['海浪', '贝壳', '灯塔'], '列表带完整候选词');
  assert.strictEqual(list[1].wordCount, 4);
  assert.ok(!('pid' in list[0]), '摘要不暴露作者身份');

  const byNew = P.summaries(store, { sort: 'new' });
  assert.strictEqual(byNew[0].id, cold.id, '最新发布在前');

  // 候选词全文随列表下发（搜索要覆盖全部候选词，不只前几个预览词）
  const many = P.emptyPlaza();
  P.publish(many, {
    pid: PID_A, packId: 'pk_many',
    pack: validPack({ words: Array.from({ length: 20 }, (_, i) => `词${i}`) }),
    now: 1, generate: genFrom(['pz_aaaaaaaaaaa9']),
  });
  const manyList = P.summaries(many, {});
  assert.strictEqual(manyList[0].words.length, 20, '超过预览个数的候选词也完整下发');
  assert.strictEqual(manyList[0].wordCount, 20);

  // MAX_LIST 截断（用不同发布者绕过每人上限）
  const big = P.emptyPlaza();
  let n = 0;
  const gen = () => `pz_${String(++n).padStart(12, '0')}`;
  for (let i = 0; i < P.MAX_LIST + 5; i++) {
    const pid = i.toString(16).padStart(64, '0');
    P.publish(big, { pid, packId: `pk_${i}`, pack: validPack(), now: i, generate: gen });
  }
  assert.strictEqual(P.summaries(big, {}).length, P.MAX_LIST);
});

test('sortPacks / filterPacks / themesOf：热度排序、关键词与主题筛选、主题列表', () => {
  const list = [
    { id: 'pz_000000000001', name: '海洋', theme: '与海有关', author: '甲',
      words: ['海浪', '贝壳', '灯塔', '海鸥', '帆船', '珊瑚', '沙滩', '潮汐', '水母', '鲸鱼'],
      subscribers: 5, updatedAt: 100 },
    { id: 'pz_000000000002', name: '校园', theme: '学校生活', author: '乙', words: ['操场'], subscribers: 6, updatedAt: 300 },
    { id: 'pz_000000000003', name: '山野', theme: '', author: '丙', words: ['山峰'], subscribers: 1, updatedAt: 200 },
  ];
  // hot：同热度按更新时间
  assert.deepStrictEqual(P.sortPacks(list, 'hot').map(x => x.id),
    ['pz_000000000002', 'pz_000000000001', 'pz_000000000003']);
  // new：更新时间优先
  assert.deepStrictEqual(P.sortPacks(list, 'new').map(x => x.id),
    ['pz_000000000002', 'pz_000000000003', 'pz_000000000001']);
  // 原数组不被改写
  assert.strictEqual(list[0].id, 'pz_000000000001');

  // 关键词：命中名称/主题/候选词，大小写不敏感
  assert.strictEqual(P.filterPacks(list, { keyword: '海洋' }).length, 1);
  assert.strictEqual(P.filterPacks(list, { keyword: '学校' }).length, 1);
  assert.strictEqual(P.filterPacks(list, { keyword: '山峰' }).length, 1);
  // 回归：候选词搜索覆盖全部词，不只前几个预览词（第 9、10 个词也要命中）
  assert.deepStrictEqual(P.filterPacks(list, { keyword: '水母' }).map(x => x.id), ['pz_000000000001']);
  assert.deepStrictEqual(P.filterPacks(list, { keyword: '鲸鱼' }).map(x => x.id), ['pz_000000000001']);
  assert.strictEqual(P.filterPacks(list, { keyword: '不存在' }).length, 0);
  assert.strictEqual(P.filterPacks(list, { keyword: '  ' }).length, 3, '空白关键词不过滤');
  // 主题筛选：精确匹配；与关键词可叠加
  assert.strictEqual(P.filterPacks(list, { theme: '与海有关' }).length, 1);
  assert.strictEqual(P.filterPacks(list, { theme: '与海有关', keyword: '校园' }).length, 0);
  assert.strictEqual(P.filterPacks(list, { theme: '' }).length, 3, '空主题=全部');

  // 主题列表：按累计订阅数排序，空主题不进列表
  assert.deepStrictEqual(P.themesOf(list), ['学校生活', '与海有关']);
});

test('normalizePlaza：损坏/被手改的存档逐条丢弃，合法条目保留', () => {
  const raw = {
    version: 1,
    packs: {
      pz_aaaaaaaaaaa1: {
        id: 'pz_aaaaaaaaaaa1', pid: PID_A, packId: 'pk_1', author: ' 小词 ',
        pack: validPack(), subs: { [PID_B]: 10, bad: 1 }, publishedAt: 5, updatedAt: 10,
      },
      BADID: { id: 'BADID', pid: PID_A, packId: 'pk_2', pack: validPack() },
      pz_bbbbbbbbbbb2: { id: 'pz_bbbbbbbbbbb2', pid: 'not-a-pid', packId: 'pk_3', pack: validPack() },
      pz_ccccccccccc3: { id: 'pz_ccccccccccc3', pid: PID_A, packId: 'pk_4', pack: { name: '', words: [] } },
    },
  };
  const store = P.normalizePlaza(raw);
  const ids = Object.keys(store.packs);
  assert.deepStrictEqual(ids, ['pz_aaaaaaaaaaa1']);
  const e = store.packs.pz_aaaaaaaaaaa1;
  assert.strictEqual(e.author, '小词', '作者名 trim');
  assert.strictEqual(P.subscriberCount(e), 1, '非法订阅者身份被丢弃');
  assert.strictEqual(P.normalizePlaza(null).version, 1);
  assert.deepStrictEqual(P.normalizePlaza({ packs: 'x' }).packs, {});
});

test('listByOwner：只回展示字段，按更新时间倒序', () => {
  const store = P.emptyPlaza();
  P.publish(store, { pid: PID_A, packId: 'pk_1', pack: validPack({ name: '一' }), now: 1, generate: genFrom(['pz_000000000001']) });
  P.publish(store, { pid: PID_A, packId: 'pk_2', pack: validPack({ name: '二' }), now: 2, generate: genFrom(['pz_000000000002']) });
  P.publish(store, { pid: PID_B, packId: 'pk_3', pack: validPack({ name: '三' }), now: 3, generate: genFrom(['pz_000000000003']) });
  P.subscribe(store, 'pz_000000000001', PID_C, 10);
  const mine = P.listByOwner(store, PID_A);
  assert.strictEqual(mine.length, 2);
  assert.strictEqual(mine[0].name, '二', '最新更新在前');
  assert.strictEqual(mine[1].subscribers, 1);
  assert.ok(!('pack' in mine[0]) && !('pid' in mine[0]), '不回全文与身份');
});

test('本机映射：normalize/upsert/remove/find/reconcile', () => {
  // normalize：非法 id 丢弃、按 id 去重
  const norm = P.normalizeLocal([
    { id: 'pz_aaaaaaaaaaa1', packId: 'pk_1', name: '一', updatedAt: 5 },
    { id: 'pz_aaaaaaaaaaa1', packId: 'pk_x', name: '重', updatedAt: 6 },
    { id: 'bad', packId: 'pk_2' },
    null,
  ]);
  assert.strictEqual(norm.length, 1);
  assert.strictEqual(norm[0].packId, 'pk_1');

  // upsert：新条目置顶，同 id 覆盖
  const up1 = P.upsertLocal(norm, { id: 'pz_bbbbbbbbbbb2', packId: 'pk_2', name: '二', updatedAt: 7 });
  assert.strictEqual(up1.length, 2);
  assert.strictEqual(up1[0].id, 'pz_bbbbbbbbbbb2');
  const up2 = P.upsertLocal(up1, { id: 'pz_aaaaaaaaaaa1', packId: 'pk_1', name: '一改', updatedAt: 9 });
  assert.strictEqual(up2.length, 2);
  assert.strictEqual(up2[0].name, '一改');

  // remove / find
  assert.strictEqual(P.removeLocal(up2, 'pz_aaaaaaaaaaa1').length, 1);
  assert.strictEqual(P.findLocalByPackId(up2, 'pk_1').id, 'pz_aaaaaaaaaaa1');
  assert.strictEqual(P.findLocalByPackId(up2, 'pk_none'), null);

  // reconcile：以服务端为准——服务端消失的丢弃、新出现的补上、字段用服务端的
  const rec = P.reconcileLocal(up2, [
    { id: 'pz_bbbbbbbbbbb2', packId: 'pk_2', name: '二（服务端名）', updatedAt: 77 },
    { id: 'pz_ccccccccccc3', packId: 'pk_3', name: '三', updatedAt: 88 },
  ]);
  assert.deepStrictEqual(rec.map(m => m.id), ['pz_bbbbbbbbbbb2', 'pz_ccccccccccc3']);
  assert.strictEqual(rec[0].name, '二（服务端名）');
  assert.strictEqual(rec[0].updatedAt, 77);
});
