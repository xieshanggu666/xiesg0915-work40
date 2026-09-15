'use strict';
// 交流广场界面接线回归：用 DOM/WebSocket 桩加载真实 client.js，模拟
// 「进入广场 → 浏览/搜索/筛选/排序 → 订阅到本机」与「词包页发布 → 更新 → 下架」的完整点击流。
const test = require('node:test');
const assert = require('node:assert');

// ---------- DOM / 环境桩 ----------

function makeEl(id) {
  const el = {
    id: id || '', children: [], _cls: new Set(),
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {}, onclick: null, open: false,
    _listeners: {},
    addEventListener(ev, fn) { (el._listeners[ev] ||= []).push(fn); },
    dispatch(ev, arg) { (el._listeners[ev] || []).forEach(fn => fn(arg || { target: el })); },
    showModal() { this.open = true; },
    close() { this.open = false; },
    appendChild(c) { el.children.push(c); return c; },
    remove() {},
    focus() {},
    select() {},
    get offsetWidth() { return 0; },
    closest() { return el; },
  };
  el.classList = {
    add: (...c) => c.forEach(x => el._cls.add(x)),
    remove: (...c) => c.forEach(x => el._cls.delete(x)),
    toggle: (c, force) => { (force ?? !el._cls.has(c)) ? el._cls.add(c) : el._cls.delete(c); },
    contains: (c) => el._cls.has(c),
  };
  el.querySelectorAll = () => [];
  el.querySelector = () => null;
  return el;
}

const els = new Map();
// 列表的操作按钮：桩不解析 DOM，从 innerHTML 中按 data-* 属性提取 id 并缓存按钮，
// 让 client 绑定的 onclick 与测试点击的是同一个对象
const btnCache = new Map();
function datasetKey(attr) {
  return attr.split('-').map((w, i) => i ? w[0].toUpperCase() + w.slice(1) : w).join('');
}
function dataListQuery(listId, attrs, innerHtml) {
  return (sel) => {
    const m = sel.match(/^\[data-([a-z-]+)\]$/);
    if (!m || !attrs.includes(m[1])) return [];
    const attr = m[1];
    const ids = [...innerHtml().matchAll(new RegExp(`data-${attr}="([^"]+)"`, 'g'))]
      .map(x => x[1]);
    return ids.map(id => {
      const key = `${listId}:${attr}:${id}`;
      if (!btnCache.has(key)) {
        const btn = makeEl();
        btn.dataset[datasetKey(attr)] = id;
        btnCache.set(key, btn);
      }
      return btnCache.get(key);
    });
  };
}

const $id = (id) => {
  if (!els.has(id)) {
    const el = makeEl(id);
    if (id === 'pack-list') {
      el.querySelectorAll = dataListQuery('pack-list',
        ['pack-edit', 'pack-del', 'pack-share', 'pack-pub', 'pack-unpub'],
        () => $('pack-list').innerHTML);
    }
    if (id === 'plaza-list') {
      el.querySelectorAll = dataListQuery('plaza-list',
        ['plaza-sub', 'plaza-unpub'], () => $('plaza-list').innerHTML);
    }
    if (id === 'plaza-orphan-list') {
      el.querySelectorAll = dataListQuery('plaza-orphan',
        ['plaza-orphan-unpub'], () => $('plaza-orphan-list').innerHTML);
    }
    els.set(id, el);
  }
  return els.get(id);
};
const $ = $id;

global.document = {
  getElementById: $id,
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  body: makeEl('body'),
};
const storage = {};
global.localStorage = {
  getItem: (k) => (k in storage ? storage[k] : null),
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: (k) => { delete storage[k]; },
};
global.location = { protocol: 'http:', host: 'test', reload() {} };
global.confirm = () => true;
global.navigator = {};

const sockets = [];
const sentMsgs = [];
global.WebSocket = class {
  constructor() { this.readyState = 0; sockets.push(this); }
  send(s) { if (this.readyState === 1) sentMsgs.push(JSON.parse(s)); }
  close() {}
};

global.WTTips = require('../public/tips.js');
global.WTRules = require('../public/rules.js');
global.WTPractice = require('../public/practice.js');
global.WTFav = require('../public/favorites.js');
global.WTPacks = require('../public/packs.js');
global.WTShares = require('../public/shares.js');
global.WTPlaza = require('../public/plaza.js');

require('../public/client.js');

const ws = sockets.at(-1);
ws.readyState = 1;
ws.onopen();

const recvMsg = (msg) => ws.onmessage({ data: JSON.stringify(msg) });
const storedPacks = () => JSON.parse(storage.wt_packs || '[]');
const storedPlazaMine = () => JSON.parse(storage.wt_plaza_mine || '[]');

const PLAZA_LIST = [
  { id: 'pz_aaaaaaaaaaa1', name: '海洋奇缘', theme: '与海有关', wordCount: 10,
    words: ['海浪', '贝壳', '灯塔', '海鸥', '帆船', '珊瑚', '沙滩', '潮汐', '水母', '鲸鱼'],
    author: '小词', subscribers: 5, publishedAt: 100, updatedAt: 200, mine: false },
  { id: 'pz_bbbbbbbbbbb2', name: '校园日常', theme: '学校生活', wordCount: 3,
    words: ['操场', '粉笔', '课桌'], author: '同桌', subscribers: 2,
    publishedAt: 300, updatedAt: 400, mine: false },
  { id: 'pz_ccccccccccc3', name: '山野漫步', theme: '', wordCount: 3,
    words: ['山峰', '山谷', '溪流'], author: '', subscribers: 0,
    publishedAt: 500, updatedAt: 600, mine: false },
];

test('广场：进入即拉取列表，渲染热度/作者/预览，支持排序、搜索与主题筛选', () => {
  $('btn-plaza-home').onclick();
  assert.ok(!$('screen-plaza')._cls.has('hidden'), '进入广场页');
  const req = sentMsgs.filter(m => m.type === 'plazaList');
  assert.strictEqual(req.length, 1, '进入广场即拉取列表');
  assert.strictEqual(req[0].sort, 'hot', '默认按热度');
  assert.ok(/^[a-f0-9]{64}$/.test(req[0].pidSecret), '随带本机身份密钥');
  assert.ok($('plaza-list').innerHTML.includes('加载中'), '未回包前显示加载中');

  recvMsg({ type: 'plazaList', sort: 'hot', packs: PLAZA_LIST });
  const html = $('plaza-list').innerHTML;
  assert.ok(html.includes('海洋奇缘') && html.includes('🔥 5 人订阅'), '展示名称与热度');
  assert.ok(html.includes('10 词'), '展示词数');
  assert.ok(html.includes('发布者：小词'), '展示发布者');
  assert.ok(html.includes('海浪、贝壳、灯塔、海鸥'), '展示候选词预览');
  assert.ok(html.includes('沙滩、潮汐 …'), '预览只展示前 8 个词并带省略标记');
  assert.ok(!html.includes('水母'), '第 8 个之后的候选词不直接展示');
  assert.ok(html.includes('（无主题说明）'), '无主题兜底');
  assert.ok(html.indexOf('海洋奇缘') < html.indexOf('校园日常'), '按热度排序（订阅多的在前）');
  assert.ok($('plaza-stats').textContent.includes('共 3 个词包'));
  assert.ok($('plaza-empty')._cls.has('hidden'));

  // 主题下拉：从广场数据汇总（无主题的不进选项）
  const themeSel = $('plaza-theme-filter');
  assert.ok(themeSel.innerHTML.includes('全部主题'));
  assert.ok(themeSel.innerHTML.includes('与海有关') && themeSel.innerHTML.includes('学校生活'));

  // 主题筛选
  themeSel.value = '与海有关';
  themeSel.onchange({ target: themeSel });
  assert.ok($('plaza-list').innerHTML.includes('海洋奇缘'));
  assert.ok(!$('plaza-list').innerHTML.includes('校园日常'), '主题筛选生效');
  assert.ok($('plaza-stats').textContent.includes('筛选出 1 个'));
  themeSel.value = '';
  themeSel.onchange({ target: themeSel });

  // 搜索：命中预览词；也能命中第 8 个之后的候选词（回归：搜索覆盖全部候选词）
  $('plaza-search').value = '粉笔';
  $('plaza-search').dispatch('input');
  assert.ok($('plaza-list').innerHTML.includes('校园日常'));
  assert.ok(!$('plaza-list').innerHTML.includes('海洋奇缘'));
  $('plaza-search').value = '水母';
  $('plaza-search').dispatch('input');
  assert.ok($('plaza-list').innerHTML.includes('海洋奇缘'), '第 9 个候选词也能搜到');
  assert.ok(!$('plaza-list').innerHTML.includes('校园日常'));
  $('plaza-search').value = '不存在的词';
  $('plaza-search').dispatch('input');
  assert.ok($('plaza-list').innerHTML.includes('没有符合条件的词包'));
  assert.ok($('plaza-list').innerHTML.includes('不存在的词'), '回显搜索词');
  $('plaza-search').value = '';
  $('plaza-search').dispatch('input');

  // 切换排序：按最新（updatedAt 大的在前），纯前端重排不重发请求
  const before = sentMsgs.filter(m => m.type === 'plazaList').length;
  $('btn-plaza-sort-new').onclick();
  assert.strictEqual(sentMsgs.filter(m => m.type === 'plazaList').length, before, '不重发请求');
  assert.ok($('plaza-list').innerHTML.indexOf('山野漫步') < $('plaza-list').innerHTML.indexOf('海洋奇缘'),
    '最新发布的在前');
  assert.ok($('btn-plaza-sort-new')._cls.has('primary'), '当前排序高亮');
  $('btn-plaza-sort-hot').onclick();
  assert.ok($('plaza-list').innerHTML.indexOf('海洋奇缘') < $('plaza-list').innerHTML.indexOf('山野漫步'));
});

test('广场订阅：词包写入本机并标记来源；重复订阅不产生副本；热度就地刷新', () => {
  recvMsg({ type: 'plazaList', sort: 'hot', packs: PLAZA_LIST });
  const subBtn = $('plaza-list').querySelectorAll('[data-plaza-sub]')
    .find(b => b.dataset.plazaSub === 'pz_aaaaaaaaaaa1');
  assert.ok(subBtn, '有订阅按钮');
  subBtn.onclick();
  const req = sentMsgs.filter(m => m.type === 'plazaSubscribe');
  assert.strictEqual(req.length, 1);
  assert.strictEqual(req[0].id, 'pz_aaaaaaaaaaa1');
  assert.ok(/^[a-f0-9]{64}$/.test(req[0].pidSecret));

  // 服务端返回快照：写入本机词包（带来源标记），按钮变"已订阅"，热度就地更新
  recvMsg({ type: 'plazaPack', id: 'pz_aaaaaaaaaaa1', subscribers: 6,
    pack: { id: 'pk_friend_9', name: '海洋奇缘', theme: '与海有关',
      words: ['海浪', '贝壳', '灯塔', '海鸥'] } });
  const mine = storedPacks().find(p => p.plazaId === 'pz_aaaaaaaaaaa1');
  assert.ok(mine, '订阅的词包进入本机列表并标记广场来源');
  assert.notStrictEqual(mine.id, 'pk_friend_9', '生成本机新 id');
  assert.deepStrictEqual(mine.words, ['海浪', '贝壳', '灯塔', '海鸥']);
  assert.ok($('plaza-list').innerHTML.includes('已订阅'), '按钮变为已订阅');
  assert.ok($('plaza-list').innerHTML.includes('🔥 6 人订阅'), '热度就地刷新');

  // 同一广场词包再收到一次订阅响应：不产生重复副本
  recvMsg({ type: 'plazaPack', id: 'pz_aaaaaaaaaaa1', subscribers: 6,
    pack: { id: 'pk_friend_9', name: '海洋奇缘', theme: '与海有关',
      words: ['海浪', '贝壳', '灯塔', '海鸥'] } });
  assert.strictEqual(storedPacks().filter(p => p.plazaId === 'pz_aaaaaaaaaaa1').length, 1);

  // 内容完全相同的词包（别的广场条目）也不重复订阅
  const before = storedPacks().length;
  recvMsg({ type: 'plazaPack', id: 'pz_ddddddddddd4', subscribers: 1,
    pack: { id: 'pk_other', name: '海洋奇缘', theme: '与海有关',
      words: ['海浪', '贝壳', '灯塔', '海鸥'] } });
  assert.strictEqual(storedPacks().length, before, '内容判重不新增');
});

// 创建一个测试用词包并返回它
function createTestPack(name, words) {
  $('btn-packs-home').onclick();
  $('btn-pack-new').onclick();
  $('pack-name').value = name;
  $('pack-theme').value = '测试主题';
  $('pack-words').value = words.join('\n');
  $('btn-pack-save').onclick();
  return storedPacks().find(p => p.name === name);
}

test('词包页发布到广场：一键发布、徽标与更新/下架按钮、下架后恢复', () => {
  const pack = createTestPack('广场发布包', ['甲', '乙', '丙', '丁']);
  // 进入词包页会同时拉取我的分享与我的广场发布
  assert.ok(sentMsgs.some(m => m.type === 'myPlaza'), '进词包页拉取我的广场发布');

  // 点「发布到广场」：发送 plazaPublish（带身份密钥、昵称与词包快照）
  const pubBtn = $('pack-list').querySelectorAll('[data-pack-pub]')
    .find(b => b.dataset.packPub === pack.id);
  assert.ok(pubBtn, '词包行有发布按钮');
  pubBtn.onclick();
  const req = sentMsgs.filter(m => m.type === 'plazaPublish');
  assert.strictEqual(req.length, 1);
  assert.strictEqual(req[0].pack.id, pack.id);
  assert.deepStrictEqual(req[0].pack.words, ['甲', '乙', '丙', '丁']);
  assert.ok(/^[a-f0-9]{64}$/.test(req[0].pidSecret));

  // 服务端确认：本机映射落盘、列表出现"已发布"徽标与更新/下架按钮
  recvMsg({ type: 'plazaPublished', id: 'pz_eeeeeeeeeee5', packId: pack.id,
    name: '广场发布包', updatedAt: 1234, republished: false });
  assert.strictEqual(storedPlazaMine().length, 1);
  assert.strictEqual(storedPlazaMine()[0].id, 'pz_eeeeeeeeeee5');
  assert.strictEqual(storedPlazaMine()[0].packId, pack.id);
  assert.ok($('pack-list').innerHTML.includes('已发布到广场'), '出现已发布徽标');
  assert.ok($('pack-list').innerHTML.includes('更新发布'), '按钮变为更新发布');

  // 再点「更新发布」：重新发布当前内容，服务端回 republished
  $('pack-list').querySelectorAll('[data-pack-pub]')
    .find(b => b.dataset.packPub === pack.id).onclick();
  assert.strictEqual(sentMsgs.filter(m => m.type === 'plazaPublish').length, 2);
  recvMsg({ type: 'plazaPublished', id: 'pz_eeeeeeeeeee5', packId: pack.id,
    name: '广场发布包', updatedAt: 5678, republished: true });
  assert.strictEqual(storedPlazaMine().length, 1, '更新沿用原条目，不产生新映射');
  assert.strictEqual(storedPlazaMine()[0].updatedAt, 5678);

  // 点「下架」：确认后发 plazaUnpublish，成功后映射清除、徽标消失
  $('pack-list').querySelectorAll('[data-pack-unpub]')[0].onclick();
  const un = sentMsgs.filter(m => m.type === 'plazaUnpublish');
  assert.strictEqual(un.length, 1);
  assert.strictEqual(un[0].id, 'pz_eeeeeeeeeee5');
  recvMsg({ type: 'plazaUnpublished', id: 'pz_eeeeeeeeeee5' });
  assert.strictEqual(storedPlazaMine().length, 0, '本机映射移除');
  assert.ok(!$('pack-list').innerHTML.includes('已发布到广场'), '徽标消失');
  assert.ok($('pack-list').innerHTML.includes('发布到广场'), '按钮恢复为发布');
});

test('myPlaza 对账：其他设备发布的出现在专区并可下架；服务端已下架的自动清除', () => {
  $('btn-packs-home').onclick();
  // 服务端返回两条，packId 在本机词包里都不存在 → 都进入跨设备区
  recvMsg({ type: 'myPlaza', packs: [
    { id: 'pz_fffffffffff6', packId: 'pk_dev_a', name: '另一台设备的发布', subscribers: 3, updatedAt: 100 },
    { id: 'pz_000000000007', packId: 'pk_dev_b', name: '老设备遗留发布', subscribers: 0, updatedAt: 50 },
  ] });
  assert.deepStrictEqual(storedPlazaMine().map(m => m.id), ['pz_fffffffffff6', 'pz_000000000007']);
  assert.ok(!$('plaza-orphans')._cls.has('hidden'), '跨设备区显示');
  assert.ok($('plaza-orphan-list').innerHTML.includes('另一台设备的发布'));
  assert.ok($('plaza-orphan-list').innerHTML.includes('老设备遗留发布'));

  // 在跨设备区下架
  $('plaza-orphan-list').querySelectorAll('[data-plaza-orphan-unpub]')[0].onclick();
  const un = sentMsgs.filter(m => m.type === 'plazaUnpublish');
  assert.strictEqual(un.at(-1).id, 'pz_fffffffffff6');
  recvMsg({ type: 'plazaUnpublished', id: 'pz_fffffffffff6' });
  assert.ok(!$('plaza-orphan-list').innerHTML.includes('另一台设备的发布'));
  assert.ok($('plaza-orphan-list').innerHTML.includes('老设备遗留发布'));

  // 下次对账时服务端列表只剩一条：本机多余映射被清掉
  recvMsg({ type: 'myPlaza', packs: [
    { id: 'pz_000000000007', packId: 'pk_dev_b', name: '老设备遗留发布', subscribers: 0, updatedAt: 50 },
  ] });
  assert.deepStrictEqual(storedPlazaMine().map(m => m.id), ['pz_000000000007']);
});

test('广场页内作者视角：自己的条目显示下架按钮，点击后从列表移除', () => {
  $('btn-plaza-home').onclick();
  recvMsg({ type: 'plazaList', sort: 'hot', packs: [
    { ...PLAZA_LIST[0], id: 'pz_888888888888', mine: true, name: '我的发布' },
    PLAZA_LIST[1],
  ] });
  const unpubBtn = $('plaza-list').querySelectorAll('[data-plaza-unpub]')
    .find(b => b.dataset.plazaUnpub === 'pz_888888888888');
  assert.ok(unpubBtn, '我发布的条目有下架按钮');
  assert.ok($('plaza-list').innerHTML.includes('我发布的'));
  unpubBtn.onclick();
  const un = sentMsgs.filter(m => m.type === 'plazaUnpublish');
  assert.strictEqual(un.at(-1).id, 'pz_888888888888');
  recvMsg({ type: 'plazaUnpublished', id: 'pz_888888888888' });
  assert.ok(!$('plaza-list').innerHTML.includes('我的发布'), '下架后从广场列表消失');
  assert.ok($('plaza-list').innerHTML.includes('校园日常'), '其他条目不受影响');
});
