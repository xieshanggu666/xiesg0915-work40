'use strict';
// 跨房间赛事界面接线回归：用 DOM/通信桩加载真实 public/tournament.js，验证
// 列表渲染、报名/进入/弃权等点击会发出正确 WS 消息，以及 tournament 推送后对阵表/名次更新。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeEl(id) {
  const el = {
    id: id || '', children: [], _cls: new Set(),
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {}, onclick: null, _listeners: {},
  };
  el.classList = {
    add: (...c) => c.forEach(x => el._cls.add(x)),
    remove: (...c) => c.forEach(x => el._cls.delete(x)),
    toggle: (c, force) => { (force ?? !el._cls.has(c)) ? el._cls.add(c) : el._cls.delete(c); },
    contains: (c) => el._cls.has(c),
  };
  el.addEventListener = (ev, fn) => { (el._listeners[ev] ||= []).push(fn); };
  el.querySelectorAll = () => [];
  el.querySelector = () => null;
  return el;
}

function loadTourUI() {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const sent = [];
  const shown = [];
  const sandbox = {
    console,
    document: {
      readyState: 'complete',
      getElementById: $,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    globalThis: {},
    confirm: () => true,
  };
  sandbox.globalThis = sandbox;
  sandbox.WTMessages = {
    send: (m) => sent.push(m),
    secret: 'a'.repeat(64),
    displayName: '我',
    showScreen: (n) => shown.push(n),
    toast: () => {},
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'tournament.js'), 'utf8');
  vm.runInContext(code, sandbox);
  return { Tour: sandbox.WTTournament, $, els, sent, shown, el: (id) => els.get(id) };
}

const PID_A = 'a'.repeat(64);
const PID_B = 'b'.repeat(64);

function listPayload() {
  return {
    type: 'tournamentList', myPid: PID_A,
    tournaments: [
      { id: 'tm_111111111111', name: '进行杯', phase: 'running', hostName: '房主',
        entrants: 4, size: 4, registerDeadline: null, createdAt: 2,
        championName: null, myEid: 'e1', myStatus: 'alive' },
      { id: 'tm_222222222222', name: '报名杯', phase: 'registering', hostName: '房主',
        entrants: 2, size: 64, registerDeadline: Date.now() + 3600000, createdAt: 1,
        championName: null, myEid: null, myStatus: null },
      { id: 'tm_333333333333', name: '完赛杯', phase: 'finished', hostName: '房主',
        entrants: 4, size: 4, registerDeadline: null, createdAt: 0,
        championName: '玩家1', myEid: 'e1', myStatus: 'champion' },
    ],
  };
}

test('列表：三种状态渲染，点查看进入详情并发 tournamentWatch', () => {
  const { Tour, $, sent, shown } = loadTourUI();
  Tour.onList(listPayload());
  const html = $('tour-list').innerHTML;
  assert.ok(html.includes('进行杯') && html.includes('报名杯') && html.includes('完赛杯'));
  assert.ok(html.includes('冠军'));
  // data-tour 按钮：桩不解析模板，直接调用 openDetail 验证消息
  Tour.openDetail('tm_222222222222');
  assert.deepStrictEqual(shown.slice(-1), ['tour-detail']);
  const watch = sent.find(m => m.type === 'tournamentWatch');
  assert.strictEqual(watch.tournamentId, 'tm_222222222222');
  assert.strictEqual(watch.pidSecret, 'a'.repeat(64));
});

test('报名中：未报名显示报名按钮，点击发 tournamentRegister', () => {
  const { Tour, $, sent } = loadTourUI();
  Tour.openDetail('tm_222222222222');
  Tour.onTournament({
    id: 'tm_222222222222', name: '报名杯', phase: 'registering', hostPid: PID_B,
    hostName: '房主', entrants: [{ eid: 'e9', pid: PID_B, name: '房主', seed: 0, status: 'registered' }],
    size: 0, rounds: 0, bracket: [[]], myEid: null, finalStandings: [],
  });
  assert.ok($('tour-actions').innerHTML.includes('btn-tour-register'));
  $('btn-tour-register').onclick();
  const m = sent.find(x => x.type === 'tournamentRegister');
  assert.strictEqual(m.tournamentId, 'tm_222222222222');
  assert.strictEqual(m.name, '我');
});

test('对阵中：我有 ready 对阵时显示进入与弃权；进入发 tournamentEnter', () => {
  const { Tour, $, sent } = loadTourUI();
  Tour.openDetail('tm_111111111111');
  Tour.onTournament({
    id: 'tm_111111111111', name: '进行杯', phase: 'running', hostPid: PID_B, hostName: '房主',
    entrants: [
      { eid: 'e1', pid: PID_A, name: '我', seed: 1, status: 'alive' },
      { eid: 'e2', pid: PID_B, name: '对手', seed: 2, status: 'alive' },
    ],
    size: 2, rounds: 1, myEid: 'e1', myMatchId: 'r1-0', myMatchStatus: 'ready', myMatchRoom: null,
    bracket: [[{
      id: 'r1-0', round: 1, order: 0, eidA: 'e1', eidB: 'e2', nameA: '我', nameB: '对手',
      pidA: PID_A, pidB: PID_B, seedA: 1, seedB: 2, status: 'ready', winnerEid: null,
      loserEid: null, roomCode: null, checked: 0, deadline: Date.now() + 60000, note: null,
      result: null,
    }]],
    finalStandings: [],
  });
  assert.ok($('tour-actions').innerHTML.includes('btn-tour-enter'));
  assert.ok($('tour-actions').innerHTML.includes('btn-tour-forfeit'));
  $('btn-tour-enter').onclick();
  assert.strictEqual(sent.find(m => m.type === 'tournamentEnter').tournamentId, 'tm_111111111111');
  $('btn-tour-forfeit').onclick();
  assert.ok(sent.some(m => m.type === 'tournamentForfeit'));
  // 对阵表渲染双方与可进入状态
  assert.ok($('tour-bracket').innerHTML.includes('对手'));
});

test('完赛：渲染最终名次与冠军；onError 写入详情错误位', () => {
  const { Tour, $ } = loadTourUI();
  Tour.openDetail('tm_333333333333');
  Tour.onTournament({
    id: 'tm_333333333333', name: '完赛杯', phase: 'finished', hostPid: PID_A, hostName: '我',
    entrants: [
      { eid: 'e1', pid: PID_A, name: '玩家1', seed: 1, status: 'champion' },
      { eid: 'e2', pid: PID_B, name: '玩家2', seed: 2, status: 'eliminated' },
    ],
    size: 2, rounds: 1, myEid: 'e1', myMatchId: null,
    bracket: [[{
      id: 'r1-0', round: 1, order: 0, eidA: 'e1', eidB: 'e2', nameA: '玩家1', nameB: '玩家2',
      pidA: PID_A, pidB: PID_B, seedA: 1, seedB: 2, status: 'finished', winnerEid: 'e1',
      loserEid: 'e2', roomCode: null, checked: 2, deadline: null, note: null,
      result: { type: 'played', winnerName: '玩家1', scores: [], bothNoShow: false, at: 9 },
    }]],
    finalStandings: [
      { eid: 'e1', rank: 1, reason: 'champion' },
      { eid: 'e2', rank: 2, reason: 'played' },
    ],
  });
  const standings = $('tour-standings').innerHTML;
  assert.ok(standings.includes('第 1 名') && standings.includes('玩家1'));
  Tour.onError('下一轮已经开始，不能再重赛');
  assert.strictEqual($('err-tour-detail').textContent, '下一轮已经开始，不能再重赛');
});

test('创建：空名称就地提示不发消息；合法提交发 tournamentCreate 并带规则白名单', () => {
  const { Tour, $, sent } = loadTourUI();
  void Tour;
  // init 已把提交绑到 btn-tour-create-submit；先切到创建屏（绑定在 init 时一次性完成）
  $('tour-name').value = '';
  $('btn-tour-create-submit').onclick();
  assert.strictEqual($('err-tour-name').textContent, '请填写赛事名称');
  assert.ok(!sent.some(m => m.type === 'tournamentCreate'));
  // 填合法名称与规则
  $('tour-name').value = '新年杯';
  $('tour-deadline').value = '3600000';
  $('tour-rule-seconds').value = '60';
  $('tour-rule-ap').value = '2';
  $('tour-rule-rounds').value = '3';
  $('tour-rule-words').value = '4';
  $('tour-rule-tokens').value = '1';
  $('btn-tour-create-submit').onclick();
  const m = sent.find(x => x.type === 'tournamentCreate');
  assert.ok(m, '应发出 tournamentCreate');
  assert.strictEqual(m.tournamentName, '新年杯');
  assert.strictEqual(m.registerMs, 3600000);
  assert.strictEqual(m.pidSecret, 'a'.repeat(64));
  assert.strictEqual(m.rules.turnSeconds, 60);
  assert.strictEqual(m.rules.apPerTurn, 2);
  assert.strictEqual(m.rules.rounds, 3);
  assert.strictEqual(m.rules.startWordCount, 4);
  assert.strictEqual(m.rules.challengeTokens, 1);
});

test('onCreated：创建确认后进入该赛事详情', () => {
  const { Tour, shown } = loadTourUI();
  Tour.onCreated({ id: 'tm_999999999999', phase: 'registering' });
  assert.deepStrictEqual(shown.slice(-1), ['tour-detail']);
});
