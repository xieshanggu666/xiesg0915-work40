'use strict';
// 回放关键事件跳转的界面接线回归：用 DOM/WS 桩加载真实 client.js，
// 验证"关键事件列表（质疑/拆除/加固/结算）点击跳帧 + 进度条跳帧 + 当前事件高亮"。
const test = require('node:test');
const assert = require('node:assert');

function makeEl(id) {
  const el = {
    id: id || '', children: [], _cls: new Set(),
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {}, onclick: null, oninput: null, open: false,
    _listeners: {},
    addEventListener(ev, fn) { (el._listeners[ev] ||= []).push(fn); },
    dispatch(ev, arg) { (el._listeners[ev] || []).forEach(fn => fn(arg || { target: el })); },
    showModal() { this.open = true; },
    close() { this.open = false; },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
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
const $id = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };

// ---------- 测试数据 ----------

const ENDED_STATE = {
  code: 'JUMP', phase: 'ended', hostId: 'p1', you: 'p1', spectating: false,
  ruleSet: { allowedRelations: ['scene', 'synonym'] },
  players: [
    { id: 'p1', name: '甲', color: '#e0533d', connected: true, tokensLeft: 3 },
    { id: 'p2', name: '乙', color: '#2e86de', connected: true, tokensLeft: 3 },
  ],
  spectators: [], startWords: ['火'], turn: null, pendingChallenge: null,
  winner: 'p1', scores: [],
  relationTypes: [
    { id: 'scene', name: '场景共现', example: '' },
    { id: 'synonym', name: '同义/近义', example: '' },
  ],
  nodes: [],
};
const FIRE = { id: 'start0', word: '火', ownerId: null, parentId: null,
  relation: null, reason: '起始词', reinforced: true };
const GOUHUO = { id: 'w1', word: '篝火', ownerId: 'p1', parentId: 'start0',
  relation: 'scene', reason: '篝火晚会上点起火', reinforced: false };
const GOUHUO_R = { ...GOUHUO, reinforced: true };
const KUAILE = { id: 'w2', word: '快乐', ownerId: 'p2', parentId: 'w1',
  relation: 'synonym', reason: '围炉夜话很快乐', reinforced: false };
// 与 game.js buildReplay 的输出结构一致（含 kind）
const FRAMES = [
  { kind: 'create', label: '房间创建', nodes: [], turn: null },
  { kind: 'start', label: '开局，起始词：火', nodes: [FIRE], turn: null },
  { kind: 'play', label: '接出「篝火」', nodes: [FIRE, GOUHUO], turn: { playerId: 'p1', turnNumber: 1 } },
  { kind: 'reinforce', label: '甲 加固了「篝火」的连接', nodes: [FIRE, GOUHUO_R], turn: { playerId: 'p1', turnNumber: 1 } },
  { kind: 'play', label: '接出「快乐」', nodes: [FIRE, GOUHUO_R, KUAILE], turn: { playerId: 'p2', turnNumber: 2 } },
  { kind: 'challenge', label: '乙 质疑「快乐」', nodes: [FIRE, GOUHUO_R, KUAILE], turn: { playerId: 'p2', turnNumber: 2 } },
  { kind: 'demolish', label: '质疑成立，拆除「快乐」', nodes: [FIRE, GOUHUO_R], turn: { playerId: 'p2', turnNumber: 2 } },
  { kind: 'end', label: '游戏结束，结算', nodes: [FIRE, GOUHUO_R], turn: null,
    scores: [{ playerId: 'p1', total: 5 }] },
];

// ---------- 环境桩 ----------

global.document = {
  getElementById: $id,
  querySelectorAll: (sel) => sel === '.screen'
    ? ['screen-home', 'screen-lobby', 'screen-game', 'screen-end',
      'screen-practice', 'screen-practice-game', 'screen-fav', 'screen-review'].map($id)
    : [],
  createElement: () => makeEl(),
};
const mem = {};
global.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};
global.location = { protocol: 'http:', host: 'test', reload() {} };
global.confirm = () => true;

let clientWs = null;
global.WebSocket = class {
  constructor() { this.readyState = 1; clientWs = this; }
  send() {}
};
global.WTTips = require('../public/tips.js');
global.WTRules = require('../public/rules.js');
global.WTPractice = require('../public/practice.js');
global.WTFav = require('../public/favorites.js');
global.WTPacks = require('../public/packs.js');

// 关键事件列表：client 写入 innerHTML 时解析出 li 桩（真实浏览器会从 HTML 建节点），
// 借此断言 client 过滤出了哪些帧、以及点击接线是否正确。
let eventItems = [];
const eventsEl = $id('replay-events');
Object.defineProperty(eventsEl, 'innerHTML', {
  get() { return eventsEl._html || ''; },
  set(html) {
    eventsEl._html = html;
    eventItems = [...html.matchAll(/data-idx="(\d+)"/g)].map(m => {
      const li = makeEl();
      li.dataset.idx = m[1];
      return li;
    });
  },
});
eventsEl.querySelectorAll = (sel) => sel === '.ev-item' ? eventItems : [];

require('../public/client.js');

const recv = (msg) => clientWs.onmessage({ data: JSON.stringify(msg) });

test('回放：关键事件列表与进度条都能直接跳帧', () => {
  recv({ type: 'state', state: ENDED_STATE });
  recv({ type: 'replay', frames: FRAMES });
  assert.strictEqual($id('dlg-replay').open, true, '收到回放应打开回放弹窗');

  // 初始在第 1 帧，进度条范围覆盖全部帧
  assert.strictEqual($id('replay-pos').textContent, `1 / ${FRAMES.length}`);
  assert.strictEqual($id('replay-progress').max, FRAMES.length - 1);
  assert.strictEqual($id('replay-progress').value, 0);

  // 关键事件列表只含 质疑/拆除/加固/结算 四类帧，按帧号排序
  assert.deepStrictEqual(eventItems.map(li => li.dataset.idx), ['3', '5', '6', '7']);
  assert.strictEqual($id('replay-events-title')._cls.has('hidden'), false, '有事件时标题可见');
  // 条目必须是原生 <button>：Tab 可聚焦、回车/空格可触发（键盘可及的回归守护）
  assert.strictEqual((eventsEl.innerHTML.match(/<button/g) || []).length, 4,
    '每个事件条目都应是原生 button');

  // 点击「拆除」事件 → 直接跳到那一帧
  const demolishItem = eventItems.find(li => li.dataset.idx === '6');
  demolishItem.onclick();
  assert.strictEqual($id('replay-pos').textContent, `7 / ${FRAMES.length}`);
  assert.strictEqual($id('replay-label').textContent, '质疑成立，拆除「快乐」');
  assert.strictEqual($id('replay-progress').value, 6, '进度条跟随跳帧');
  assert.strictEqual(demolishItem._cls.has('current'), true, '当前事件高亮');
  assert.strictEqual(eventItems.find(li => li.dataset.idx === '3')._cls.has('current'), false);

  // 点击「结算」事件 → 跳到最后一帧
  eventItems.find(li => li.dataset.idx === '7').onclick();
  assert.strictEqual($id('replay-pos').textContent, `${FRAMES.length} / ${FRAMES.length}`);
  assert.strictEqual($id('replay-label').textContent, '游戏结束，结算');

  // 进度条跳到第 3 帧（value 是帧下标）
  $id('replay-progress').value = '2';
  $id('replay-progress').oninput({ target: $id('replay-progress') });
  assert.strictEqual($id('replay-pos').textContent, `3 / ${FRAMES.length}`);
  assert.strictEqual($id('replay-label').textContent, '接出「篝火」');

  // 上一步/下一步仍然逐帧走，且进度条与事件高亮同步
  $id('replay-next').onclick();
  assert.strictEqual($id('replay-pos').textContent, `4 / ${FRAMES.length}`);
  assert.strictEqual($id('replay-progress').value, 3);
  assert.strictEqual(eventItems.find(li => li.dataset.idx === '3')._cls.has('current'), true,
    '走到加固帧时对应事件应高亮');
  $id('replay-prev').onclick();
  assert.strictEqual($id('replay-pos').textContent, `3 / ${FRAMES.length}`);
});

test('回放：帧不带 kind 时事件列表留空并隐藏标题（兼容旧数据）', () => {
  recv({ type: 'replay', frames: [
    { label: '开局', nodes: [], turn: null },
    { label: '游戏结束，结算', nodes: [], turn: null, scores: [] },
  ] });
  assert.strictEqual(eventItems.length, 0);
  assert.strictEqual($id('replay-events-title')._cls.has('hidden'), true);
  // 逐帧浏览不受影响
  $id('replay-next').onclick();
  assert.strictEqual($id('replay-pos').textContent, '2 / 2');
});

test('回放：托管/收回/裁定移交也是可点击跳转的关键事件', () => {
  const frames = [
    { kind: 'create', label: '房间创建', nodes: [FIRE], turn: null },
    { kind: 'autopilot', label: '乙 掉线，进入托管', nodes: [FIRE], turn: { playerId: 'p1', turnNumber: 2 } },
    { kind: 'adjudicator', label: '裁定权移交给 甲', nodes: [FIRE], turn: { playerId: 'p1', turnNumber: 2 } },
    { kind: 'resume', label: '乙 重连，收回控制权', nodes: [FIRE], turn: { playerId: 'p1', turnNumber: 2 } },
  ];
  recv({ type: 'replay', frames });
  assert.deepStrictEqual(eventItems.map(li => li.dataset.idx), ['1', '2', '3']);
  // 点「收回」跳到对应帧并展示标签
  eventItems.find(li => li.dataset.idx === '3').onclick();
  assert.strictEqual($id('replay-label').textContent, '乙 重连，收回控制权');
  // 标签中文案来自 REPLAY_EVENT_KINDS（托管/收回/移交）
  const tags = eventsEl.innerHTML.match(/<span class="ev-tag">([^<]+)<\/span>/g) || [];
  assert.ok(tags.some(t => t.includes('托管')));
  assert.ok(tags.some(t => t.includes('收回')));
  assert.ok(tags.some(t => t.includes('移交')));
});
