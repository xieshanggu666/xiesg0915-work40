'use strict';
// 词包分享码纯逻辑测试：码的格式化/校验、服务端分享存储的发布/覆盖/取消/查询、
// 客户端本机映射的归一化与对账。
const test = require('node:test');
const assert = require('node:assert');
const S = require('../public/shares.js');

const PID_A = 'a'.repeat(64);
const PID_B = 'b'.repeat(64);
const validPack = (over = {}) => ({
  name: '海洋奇缘', theme: '与海有关', words: ['海浪', '贝壳', '灯塔'], ...over,
});

const validCode = (c) => S.isValidCode(c);

test('normalizeCode / isValidCode / formatCode：大写化、去空格短横', () => {
  assert.strictEqual(S.normalizeCode('abcd-efgh'), 'ABCDEFGH');
  assert.strictEqual(S.normalizeCode(' abcd efgh '), 'ABCDEFGH');
  assert.ok(validCode('ABCDEFGH'));
  assert.ok(validCode('K2MNP3QZ'));
  // 易混字母（I/O/0/1）不属于合法码
  assert.ok(!validCode('ABCDEFG0'));
  assert.ok(!validCode('1BCDEFGH'));
  assert.ok(!validCode('IBCODE1'));
  // 长度必须恰好 8 位
  assert.ok(!validCode('ABC'));
  assert.ok(!validCode('ABCDEFGHI'));
  assert.ok(!validCode(''));
  assert.strictEqual(S.formatCode('abcdefgh'), 'ABCD-EFGH');
  assert.strictEqual(S.formatCode('ABCD-EFGH'), 'ABCD-EFGH');
  // 非 8 位输入格式化时不硬插短横
  assert.strictEqual(S.formatCode('ZZ'), 'ZZ');
});

test('isValidPid：只接受 64 位十六进制', () => {
  assert.ok(S.isValidPid(PID_A));
  assert.ok(!S.isValidPid('abc'));
  assert.ok(!S.isValidPid('z'.repeat(64)));
});

test('cleanSharedPack：清洗 trim/去重/空词，非法结构返回 null', () => {
  const r = S.cleanSharedPack({ name: ' 包 ', theme: ' 主题 ', words: [' 甲 ', '甲', '乙', '丙', ''] });
  assert.deepStrictEqual(r, { name: '包', theme: '主题', words: ['甲', '乙', '丙'] });
  assert.strictEqual(S.cleanSharedPack(null), null);
  assert.strictEqual(S.cleanSharedPack({ name: '', words: ['甲', '乙', '丙'] }), null);
  assert.strictEqual(S.cleanSharedPack({ name: '长'.repeat(13), words: ['甲', '乙', '丙'] }), null);
  assert.strictEqual(S.cleanSharedPack({ name: 'n', theme: '长'.repeat(61), words: ['甲', '乙', '丙'] }), null);
  assert.strictEqual(S.cleanSharedPack({ name: 'n', words: ['甲', '乙'] }), null, '不足 3 词');
  assert.strictEqual(S.cleanSharedPack({ name: 'n', words: ['甲', '乙', '很长的词'.repeat(4)] }), null, '单词超 12 字');
  assert.strictEqual(
    S.cleanSharedPack({ name: 'n', words: Array.from({ length: 61 }, (_, i) => `词${i}`) }),
    null, '超过 60 词');
});

test('normalizeShares：损坏/被手改的存档逐条丢弃，合法条目保留', () => {
  const raw = {
    version: 1,
    shares: {
      GHJK2345: { code: 'GHJK2345', pid: PID_A, packId: 'pk_1', pack: validPack(), updatedAt: 10 },
      BADCODE1: { code: 'BADCODE1', pid: PID_A, packId: 'pk_2', pack: validPack() },
      // pid 不合法
      XXXXXXXX: { code: 'XXXXXXXX', pid: 'nope', packId: 'pk_3', pack: validPack() },
      // 词包快照损坏
      YYYYYYYY: { code: 'YYYYYYYY', pid: PID_A, packId: 'pk_4', pack: { name: 'x', words: ['1'] } },
      // 缺 packId
      ZZZZZZZZ: { code: 'ZZZZZZZZ', pid: PID_A, packId: '', pack: validPack() },
      // 非对象
      WWWWWWWW: null,
    },
  };
  const store = S.normalizeShares(raw);
  assert.deepStrictEqual(Object.keys(store.shares), ['GHJK2345']);
  assert.strictEqual(store.shares.GHJK2345.updatedAt, 10);
  assert.deepStrictEqual(S.normalizeShares(null).shares, {});
});

test('publish / publishForPack：新分享发码、同包重发沿用原码并覆盖快照', () => {
  const store = S.emptyShares();
  let seq = 0;
  const gen = () => ['PACK2222', 'PACK3333', 'PACK4444'][seq++];

  let r = S.publishForPack(store, { pid: PID_A, packId: 'pk_1', pack: validPack(), generate: gen, now: 100 });
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.code, 'PACK2222');
  assert.strictEqual(r.updated, false);
  assert.strictEqual(S.getShare(store, 'PACK2222').pack.name, '海洋奇缘');

  // 同一词包再次发布（内容更新）：沿用原码、不调用新码
  r = S.publishForPack(store, { pid: PID_A, packId: 'pk_1',
    pack: validPack({ name: '海洋·改', words: ['海', '浪', '贝'] }), generate: gen, now: 200 });
  assert.strictEqual(r.code, 'PACK2222');
  assert.strictEqual(r.updated, true);
  assert.strictEqual(S.getShare(store, 'PACK2222').pack.name, '海洋·改');
  assert.deepStrictEqual(S.getShare(store, 'PACK2222').pack.words, ['海', '浪', '贝']);
  assert.strictEqual(S.getShare(store, 'PACK2222').updatedAt, 200);

  // 另一个词包：发下一个码
  r = S.publishForPack(store, { pid: PID_A, packId: 'pk_2', pack: validPack({ name: '校园' }), generate: gen });
  assert.strictEqual(r.code, 'PACK3333');
  assert.strictEqual(S.countByOwner(store, PID_A), 2);
  assert.strictEqual(S.countByOwner(store, PID_B), 0);
});

test('publishForPack：不同作者同一 packId 各自独立成码', () => {
  const store = S.emptyShares();
  let seq = 0;
  const gen = () => ['AAAA2222', 'BBBB3333'][seq++];
  S.publishForPack(store, { pid: PID_A, packId: 'pk_same', pack: validPack(), generate: gen });
  const r = S.publishForPack(store, { pid: PID_B, packId: 'pk_same', pack: validPack(), generate: gen });
  assert.strictEqual(r.code, 'BBBB3333');
  assert.strictEqual(S.countByOwner(store, PID_A), 1);
  assert.strictEqual(S.countByOwner(store, PID_B), 1);
});

test('publishForPack：带本人有效码提示时覆盖同一条分享、保留原 packId，不分裂出第二个码', () => {
  const store = S.emptyShares();
  let seq = 0;
  const gen = () => ['PACK2222', 'PACK3333'][seq++];
  // 设备 1：用 pk_orig 分享，拿到码 PACK2222
  const first = S.publishForPack(store, { pid: PID_A, packId: 'pk_orig', pack: validPack(), generate: gen });
  assert.strictEqual(first.code, 'PACK2222');
  // 设备 2：本机副本 id 为 pk_copy（导入自己分享后的新 id），带上原码更新
  const r = S.publishForPack(store, {
    pid: PID_A, packId: 'pk_copy', code: 'PACK2222',
    pack: validPack({ name: '跨设备更新' }), generate: gen,
  });
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.code, 'PACK2222', '沿用提示码，不生成新码');
  assert.strictEqual(r.updated, true);
  assert.strictEqual(r.packId, 'pk_orig', '返回服务端实际条目 packId');
  assert.strictEqual(S.countByOwner(store, PID_A), 1, '仍只有一条分享');
  const e = S.getShare(store, 'PACK2222');
  assert.strictEqual(e.packId, 'pk_orig', '条目保留原作者 packId');
  assert.strictEqual(e.pack.name, '跨设备更新', '快照被覆盖');
});

test('publishForPack：码提示属于别人 / 不存在时忽略，按常规新分享处理（防劫持）', () => {
  const store = S.emptyShares();
  let seq = 0;
  const gen = () => ['AAAA2222', 'BBBB3333'][seq++];
  // A 已有一条分享
  S.publishForPack(store, { pid: PID_A, packId: 'pk_a', pack: validPack(), generate: gen });
  // B 试图用 A 的码作为提示：绝不允许覆盖 A 的分享
  const hack = S.publishForPack(store, {
    pid: PID_B, packId: 'pk_b', code: 'AAAA2222', pack: validPack({ name: '攻击包' }), generate: gen,
  });
  assert.strictEqual(hack.code, 'BBBB3333', '提示被忽略，B 走全新发码');
  assert.strictEqual(S.getShare(store, 'AAAA2222').pack.name, '海洋奇缘', 'A 的快照未被篡改');
  // 不存在的码提示同样被忽略
  let n = 0;
  const r = S.publishForPack(store, {
    pid: PID_B, packId: 'pk_b2', code: 'ZZZZ9999', pack: validPack(),
    generate: () => 'CCCC4444',
  });
  assert.strictEqual(r.code, 'CCCC4444');
  assert.strictEqual(n, 0);
});

test('publishForPack：每人分享数到上限拒绝新建，但更新已有分享不受限', () => {
  const store = S.emptyShares();
  let n = 0;
  const gen = () => {
    // 不重复的合法 8 位码：用字母表把序号编成 7 位串，前缀 K
    n += 1;
    let x = n, out = '';
    for (let i = 0; i < 7; i++) { out = S.CODE_ALPHABET[x % S.CODE_ALPHABET.length] + out; x = Math.floor(x / S.CODE_ALPHABET.length); }
    return 'K' + out;
  };
  for (let i = 0; i < S.MAX_SHARES_PER_OWNER; i++) {
    const r = S.publishForPack(store, { pid: PID_A, packId: `pk_${i}`, pack: validPack(), generate: gen });
    assert.strictEqual(r.error, null, `第 ${i + 1} 个分享应成功（${r.error || ''}）`);
  }
  const overflow = S.publishForPack(store, { pid: PID_A, packId: 'pk_new', pack: validPack(), generate: gen });
  assert.match(overflow.error, /最多同时分享/);
  // 更新已有的仍成功（沿用原码，不新增数量）
  const update = S.publishForPack(store, { pid: PID_A, packId: 'pk_0', pack: validPack({ name: '改名' }), generate: gen });
  assert.strictEqual(update.error, null);
  assert.strictEqual(update.updated, true);
});

test('publishForPack：无效 pid / packId / 词包拒绝；生成器始终给撞码时报错', () => {
  const store = S.emptyShares();
  assert.ok(S.publishForPack(store, { pid: 'bad', packId: 'pk_1', pack: validPack(), generate: () => 'AAAAAAAA' }).error);
  assert.ok(S.publishForPack(store, { pid: PID_A, packId: '', pack: validPack(), generate: () => 'AAAAAAAA' }).error);
  assert.ok(S.publishForPack(store, { pid: PID_A, packId: 'pk_1', pack: { name: 'x', words: ['1'] }, generate: () => 'AAAAAAAA' }).error);
  // 生成器产出的码全是已存在的：返回失败而不是死循环
  S.publish(store, { code: 'AAAAAAAA', pid: PID_A, packId: 'pk_old', pack: validPack() });
  const r = S.publishForPack(store, { pid: PID_B, packId: 'pk_new', pack: validPack(), generate: () => 'AAAAAAAA' });
  assert.match(r.error, /生成分享码失败/);
});

test('unpublish：只有作者本人能取消，取消后码立即作废', () => {
  const store = S.emptyShares();
  S.publish(store, { code: 'PACK2222', pid: PID_A, packId: 'pk_1', pack: validPack() });
  // 别人取消：失败，码仍有效
  assert.strictEqual(S.unpublish(store, 'PACK2222', PID_B), false);
  assert.ok(S.getShare(store, 'PACK2222'));
  // 码不存在（注意 0/1 不在合法字母表里，NOPE0000 本身就会归一化失败）
  assert.strictEqual(S.unpublish(store, 'ZZZZ9999', PID_A), false);
  // 作者取消：成功，再取为 null（朋友凭旧码导入会失败）
  assert.strictEqual(S.unpublish(store, 'pack2222', PID_A), true, '入参大小写容错');
  assert.strictEqual(S.getShare(store, 'PACK2222'), null);
});

test('listByOwner：只列自己的分享，按最近更新倒序，只回展示所需字段', () => {
  const store = S.emptyShares();
  S.publish(store, { code: 'AAAA2222', pid: PID_A, packId: 'pk_1', pack: validPack({ name: '甲' }), now: 100 });
  S.publish(store, { code: 'BBBB3333', pid: PID_A, packId: 'pk_2', pack: validPack({ name: '乙' }), now: 200 });
  S.publish(store, { code: 'CCCC4444', pid: PID_B, packId: 'pk_3', pack: validPack({ name: '丙' }), now: 300 });
  const list = S.listByOwner(store, PID_A);
  assert.deepStrictEqual(list.map(s => s.code), ['BBBB3333', 'AAAA2222']);
  assert.strictEqual(list[0].name, '乙');
  assert.strictEqual(list[0].packId, 'pk_2');
  assert.ok(!('words' in list[0]), '不回词包全文');
  assert.deepStrictEqual(S.listByOwner(store, PID_B).map(s => s.code), ['CCCC4444']);
});

test('normalizeLocal / upsertLocal / removeLocal / findLocalByPackId', () => {
  let local = [];
  local = S.upsertLocal(local, { code: 'abcd-efgh', packId: 'pk_1', name: '甲', updatedAt: 5 });
  assert.deepStrictEqual(local, [{ code: 'ABCDEFGH', packId: 'pk_1', name: '甲', updatedAt: 5 }]);
  // 同码更新：替换并置顶
  local = S.upsertLocal(local, { code: 'ZZZZ5555', packId: 'pk_2', name: '乙', updatedAt: 9 });
  local = S.upsertLocal(local, { code: 'ABCDEFGH', packId: 'pk_1', name: '甲改', updatedAt: 6 });
  assert.deepStrictEqual(local.map(m => m.code), ['ABCDEFGH', 'ZZZZ5555']);
  assert.strictEqual(local[0].name, '甲改');
  // 坏码不进表
  local = S.upsertLocal(local, { code: 'BAD', packId: 'x' });
  assert.strictEqual(local.length, 2);
  // 归一化丢弃重复/损坏条目
  assert.strictEqual(S.normalizeLocal([
    { code: 'AAAA2222', packId: 'p' }, null, { code: 'aaaa2222', packId: 'p2' }, { code: 'X' },
  ]).length, 1);
  assert.strictEqual(S.findLocalByPackId(local, 'pk_2').code, 'ZZZZ5555');
  assert.strictEqual(S.findLocalByPackId(local, 'nope'), null);
  local = S.removeLocal(local, 'zzzz-5555');
  assert.deepStrictEqual(local.map(m => m.code), ['ABCDEFGH']);
});

test('reconcileLocal：以服务端列表为权威——新增、改名、清掉已取消的码', () => {
  const local = [
    { code: 'AAAA2222', packId: 'pk_old', name: '旧名', updatedAt: 1 }, // 服务端仍在但改名/改时间
    { code: 'BBBB3333', packId: 'pk_gone', name: '已取消', updatedAt: 2 }, // 服务端已取消
  ];
  const remote = [
    { code: 'aaaa2222', packId: 'pk_old', name: '新名', updatedAt: 99 },
    { code: 'CCCC4444', packId: 'pk_other_device', name: '另一台设备分享的', updatedAt: 50 },
  ];
  const out = S.reconcileLocal(local, remote);
  assert.deepStrictEqual(out.map(m => m.code), ['AAAA2222', 'CCCC4444'], '顺序以服务端为准');
  assert.strictEqual(out[0].name, '新名');
  assert.strictEqual(out[0].updatedAt, 99);
  assert.ok(!out.some(m => m.code === 'BBBB3333'), '已取消的码从本机映射清掉');
  // 服务端条目缺 packId/name 时用本机条目兜底
  const fallback = S.reconcileLocal(local, [{ code: 'AAAA2222' }]);
  assert.strictEqual(fallback[0].packId, 'pk_old');
  assert.strictEqual(fallback[0].name, '旧名');
  // 服务端空列表：本机映射清空
  assert.deepStrictEqual(S.reconcileLocal(local, []), []);
});
