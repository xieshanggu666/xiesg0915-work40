'use strict';
// 主题词包纯逻辑测试：候选词解析、词包校验、本机列表的新增/更新/删除。
const test = require('node:test');
const assert = require('node:assert');
const P = require('../public/packs.js');

test('parseWords：按换行/逗号/顿号/分号/空白切分，去空白并去重（保留顺序）', () => {
  assert.deepStrictEqual(
    P.parseWords('海浪\n贝壳，灯塔、海鸥; 帆船\n\n海浪  珊瑚，，'),
    ['海浪', '贝壳', '灯塔', '海鸥', '帆船', '珊瑚']);
  assert.deepStrictEqual(P.parseWords(''), []);
  assert.deepStrictEqual(P.parseWords(null), []);
});

test('validatePack：合法输入通过并清洗（trim、去重）', () => {
  const { errors, pack } = P.validatePack({
    name: ' 海洋奇缘 ', theme: ' 一切都与大海有关 ', wordsText: '海浪\n贝壳\n灯塔\n海浪',
  });
  assert.deepStrictEqual(errors, {});
  assert.strictEqual(pack.name, '海洋奇缘');
  assert.strictEqual(pack.theme, '一切都与大海有关');
  assert.deepStrictEqual(pack.words, ['海浪', '贝壳', '灯塔']);
});

test('validatePack：名称为空或过长被拒绝', () => {
  assert.ok(P.validatePack({ name: ' ', wordsText: '甲\n乙\n丙' }).errors.name);
  assert.ok(P.validatePack({ name: '这'.repeat(13), wordsText: '甲\n乙\n丙' }).errors.name);
  assert.ok(!P.validatePack({ name: '这'.repeat(12), wordsText: '甲\n乙\n丙' }).errors.name);
});

test('validatePack：主题说明超长被拒绝，留空可以', () => {
  assert.ok(P.validatePack({ name: 'n', theme: '长'.repeat(61), wordsText: '甲\n乙\n丙' }).errors.theme);
  assert.ok(!P.validatePack({ name: 'n', theme: '', wordsText: '甲\n乙\n丙' }).errors.theme);
});

test('validatePack：候选词至少 3 个、单词不超 12 字、总数不超上限', () => {
  assert.match(P.validatePack({ name: 'n', wordsText: '甲\n乙' }).errors.words, /至少需要 3/);
  assert.match(P.validatePack({ name: 'n', wordsText: `甲\n乙\n${'长'.repeat(13)}` }).errors.words, /超过 12 个字/);
  const many = Array.from({ length: 61 }, (_, i) => `词${i}`).join('\n');
  assert.match(P.validatePack({ name: 'n', wordsText: many }).errors.words, /最多 60/);
  const ok = Array.from({ length: 60 }, (_, i) => `词${i}`).join('\n');
  assert.deepStrictEqual(P.validatePack({ name: 'n', wordsText: ok }).errors, {});
});

test('validatePack：也接受 words 数组输入（与文本框解析结果一致）', () => {
  const { errors, pack } = P.validatePack({ name: 'n', theme: '', words: ['甲', '乙', '甲', '丙'] });
  assert.deepStrictEqual(errors, {});
  assert.deepStrictEqual(pack.words, ['甲', '乙', '丙']);
});

test('upsert：新建前插、按 id 更新、超出上限拒绝新建但不影响更新', () => {
  let packs = [];
  const a = { id: 'a', name: '甲包', theme: '', words: ['甲', '乙', '丙'] };
  ({ packs } = P.upsert(packs, a));
  assert.strictEqual(packs.length, 1);
  const b = { id: 'b', name: '乙包', theme: '', words: ['一', '二', '三'] };
  ({ packs } = P.upsert(packs, b));
  assert.deepStrictEqual(packs.map(p => p.id), ['b', 'a'], '新建的词包排在最前');
  // 更新：位置不变、内容替换
  const a2 = { ...a, name: '甲包·改' };
  const r = P.upsert(packs, a2);
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(r.packs.map(p => p.id), ['b', 'a']);
  assert.strictEqual(r.packs[1].name, '甲包·改');
  // 填满到上限
  for (let i = 0; i < P.MAX_PACKS - 2; i++) {
    ({ packs } = P.upsert(packs, { id: `x${i}`, name: `包${i}`, theme: '', words: ['甲', '乙', '丙'] }));
  }
  assert.strictEqual(packs.length, P.MAX_PACKS);
  const denied = P.upsert(packs, { id: 'overflow', name: '溢出', theme: '', words: ['甲', '乙', '丙'] });
  assert.match(denied.error, /最多保存/);
  assert.strictEqual(denied.packs.length, P.MAX_PACKS);
  // 已满时更新已有词包仍然可以
  assert.strictEqual(P.upsert(packs, { ...a2, theme: '新主题' }).error, null);
  // 缺 id 的数据无效
  assert.ok(P.upsert(packs, { name: '无 id' }).error);
});

test('remove / find：按 id 删除与查找', () => {
  const packs = [
    { id: 'a', name: '甲', theme: '', words: ['甲', '乙', '丙'] },
    { id: 'b', name: '乙', theme: '', words: ['一', '二', '三'] },
  ];
  assert.strictEqual(P.find(packs, 'b').name, '乙');
  assert.strictEqual(P.find(packs, 'zz'), null);
  const left = P.remove(packs, 'a');
  assert.deepStrictEqual(left.map(p => p.id), ['b']);
  assert.strictEqual(packs.length, 2, 'remove 不修改原数组');
});

test('withPreservedProvenance：编辑导入/订阅来的词包时保留来源标记，新建不继承', () => {
  const packs = [
    { id: 'a', name: '甲', theme: '', words: ['甲', '乙', '丙'],
      importedFrom: 'pk_orig', importedAt: 11 },
    { id: 'b', name: '乙', theme: '', words: ['一', '二', '三'],
      plazaId: 'pz_aaaaaaaaaaaa', subscribedAt: 22 },
  ];
  // 编辑导入副本：importedFrom/importedAt 必须保留（否则同一来源可被再次导入成重复副本）
  const editedA = P.withPreservedProvenance(packs,
    { id: 'a', name: '甲改', theme: '海', words: ['甲', '乙', '丁'], updatedAt: 33 });
  assert.strictEqual(editedA.importedFrom, 'pk_orig');
  assert.strictEqual(editedA.importedAt, 11);
  assert.strictEqual(editedA.name, '甲改');
  // 编辑订阅副本：plazaId/subscribedAt 保留
  const editedB = P.withPreservedProvenance(packs,
    { id: 'b', name: '乙改', theme: '', words: ['一', '二', '四'], updatedAt: 44 });
  assert.strictEqual(editedB.plazaId, 'pz_aaaaaaaaaaaa');
  assert.strictEqual(editedB.subscribedAt, 22);
  // 新建（旧列表里无此 id）：不继承任何来源标记
  const created = P.withPreservedProvenance(packs,
    { id: 'c', name: '丙', theme: '', words: ['X', 'Y', 'Z'] });
  assert.deepStrictEqual(Object.keys(created).sort(), ['id', 'name', 'theme', 'words']);
});

test('adoptRemotePack(share)：导入自己的分享后认领回稳定 packId，幂等且不覆盖真身', () => {
  // 本机副本带 importedFrom，指向作者原始 packId
  const packs = [
    { id: 'pk_local', name: '甲', theme: '', words: ['甲', '乙', '丙'],
      importedFrom: 'pk_orig', importedAt: 11 },
  ];
  const r1 = P.adoptRemotePack(packs, 'share', { matchId: 'pk_orig', targetId: 'pk_orig' });
  assert.strictEqual(r1.changed, true);
  assert.strictEqual(r1.adoptedId, 'pk_orig');
  const adopted = r1.packs[0];
  assert.strictEqual(adopted.id, 'pk_orig', '本机副本 id 改写为来源稳定 id');
  assert.ok(!('importedFrom' in adopted), '认领后不再是导入副本（对自己可重复导入去重）');
  assert.ok(!('importedAt' in adopted));
  // 幂等：再认领一次不变化
  const r2 = P.adoptRemotePack(r1.packs, 'share', { matchId: 'pk_orig', targetId: 'pk_orig' });
  assert.strictEqual(r2.changed, false);
  assert.strictEqual(r2.adoptedId, 'pk_orig');

  // 本机已存在 id===targetId 的真身时不改写（避免覆盖）
  const both = [
    { id: 'pk_orig', name: '真身', theme: '', words: ['甲', '乙', '丙'] },
    { id: 'pk_local', name: '副本', theme: '', words: ['甲', '乙', '丙'],
      importedFrom: 'pk_orig', importedAt: 11 },
  ];
  const r3 = P.adoptRemotePack(both, 'share', { matchId: 'pk_orig', targetId: 'pk_orig' });
  assert.strictEqual(r3.changed, false);
  assert.deepStrictEqual(r3.packs.map(p => p.id), ['pk_orig', 'pk_local'], '真身与副本并存时不改写');
  // 无匹配来源：不变化
  const r4 = P.adoptRemotePack(packs, 'share', { matchId: 'pk_none', targetId: 'pk_none' });
  assert.strictEqual(r4.changed, false);
  assert.strictEqual(r4.adoptedId, null);
});

test('adoptRemotePack(plaza)：按广场条目 id 匹配，id 改写为作者稳定 packId 并清订阅标记', () => {
  const packs = [
    { id: 'pk_local', name: '甲', theme: '', words: ['甲', '乙', '丙'],
      plazaId: 'pz_aaaaaaaaaaaa', subscribedAt: 55 },
  ];
  const r = P.adoptRemotePack(packs, 'plaza',
    { matchId: 'pz_aaaaaaaaaaaa', targetId: 'pk_author' });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.packs[0].id, 'pk_author', 'id 改写为作者 packId（与我的发布映射对上）');
  assert.ok(!('plazaId' in r.packs[0]), '订阅标记退场');
  assert.ok(!('subscribedAt' in r.packs[0]));
  // 幂等
  const r2 = P.adoptRemotePack(r.packs, 'plaza',
    { matchId: 'pz_aaaaaaaaaaaa', targetId: 'pk_author' });
  assert.strictEqual(r2.changed, false);
});
