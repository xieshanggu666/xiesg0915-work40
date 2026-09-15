'use strict';
// 赛季排行榜 / 个人页界面接线回归：用 DOM/WebSocket 桩加载真实 client.js，
// 模拟"打开排行榜 → 切换排序 → 点玩家行进个人页 → 打开我的战绩"的完整点击流。
const test = require('node:test');
const assert = require('node:assert');

function makeEl(id) {
  const el = {
    id: id || '', children: [], _cls: new Set(),
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {}, onclick: null, open: false, _listeners: {},
    addEventListener(ev, fn) { (el._listeners[ev] ||= []).push(fn); },
    showModal() { this.open = true; },
    close() { this.open = false; },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    get offsetWidth() { return 0; },
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

// 排行榜动态行：client 渲染后给每行绑 onclick；按 pid 缓存同一元素，
// 否则桩的 querySelectorAll 每次都返回新元素，绑定的 onclick 会丢。
const rowEls = new Map();
function rankRowEl(pid) {
  if (!rowEls.has(pid)) {
    const el = makeEl();
    el.dataset.pid = pid;
    // 记录 scrollIntoView 调用：置顶条点击定位用（带 block/behavior 参数）
    el.scrollCalls = [];
    el.scrollIntoView = function (opts) { this.scrollCalls.push(opts || null); };
    rowEls.set(pid, el);
  }
  return rowEls.get(pid);
}
let rankPids = [];

// 仿真浏览器 NodeList：有 length/下标/forEach，但没有 find/map 等数组方法。
// 曾出过"对 querySelectorAll 结果直接 .find"的线上 bug（桩返回真数组没测出来），
// 这里刻意与真实 DOM 对齐，防止同类问题复发。
function nodeList(arr) {
  const nl = { length: arr.length };
  arr.forEach((v, i) => { nl[i] = v; });
  nl.forEach = (fn) => arr.forEach(fn);
  return nl;
}

const SCREENS = ['screen-home', 'screen-lobby', 'screen-game', 'screen-end',
  'screen-practice', 'screen-practice-game', 'screen-fav', 'screen-review',
  'screen-rank', 'screen-profile'];
global.document = {
  getElementById: $id,
  querySelectorAll: (sel) => sel === '.screen' ? SCREENS.map($id) : [],
  createElement: () => makeEl('div'),
};
// 真实 HTML 里只有首页默认可见，其余 section 带 hidden
SCREENS.slice(1).forEach(id => $id(id).classList.add('hidden'));
const mem = {};
global.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};
global.location = { protocol: 'http:', host: 'test', reload() {} };

const sentMsgs = [];
let clientWs = null;
global.WebSocket = class {
  constructor() { this.readyState = 1; clientWs = this; }
  send(s) { sentMsgs.push(JSON.parse(s)); }
};
global.WTTips = require('../public/tips.js');
global.WTRules = require('../public/rules.js');
global.WTPractice = require('../public/practice.js');
global.WTFav = require('../public/favorites.js');
global.WTAchievements = require('../public/achievements.js');
// 无 WebCrypto 环境：client 应回退到 Math.random 生成密钥；测试结束后恢复，
// 避免影响同一 node --test 进程里后续加载的其他客户端测试。
// Node 的 globalThis.crypto 在原型上，delete 不生效，直接覆盖为 undefined 模拟缺失。
const savedCrypto = globalThis.crypto;
Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });

require('../public/client.js');

const recv = (msg) => clientWs.onmessage({ data: JSON.stringify(msg) });
const lastSent = (type) => sentMsgs.filter(m => m.type === type).at(-1);

// 排行榜容器：按当前响应里出现的 pid 暴露动态行（NodeList 仿真，无 find）
$id('rank-list').querySelectorAll = (sel) =>
  sel === '.rank-row' ? nodeList(rankPids.map(pid => rankRowEl(pid))) : nodeList([]);

const setRows = (pids) => { rankPids = pids; };

// 本机玩家（甲）密钥固定为 64 个 a，pid 取其 sha256；排行榜行用真实 pid 才能对上 myPid
const PID_ME = require('node:crypto').createHash('sha256').update('a'.repeat(64)).digest('hex');
const LB_MY_ROWS = [
  { rank: 1, pid: PID_ME, name: '甲', games: 2, wins: 2, ties: 0, losses: 0,
    totalScore: 20, avgScore: 10, bestChain: 4, winRate: 1, lastAt: 5 },
  { rank: 2, pid: 'pidB', name: '乙', games: 2, wins: 0, ties: 0, losses: 2,
    totalScore: 6, avgScore: 3, bestChain: 2, winRate: 0, lastAt: 5 },
];

test.after(() => { globalThis.crypto = savedCrypto; });

test('从首页直接进我的战绩再返回排行榜：无缓存时补拉，不卡在加载中', () => {
  // 全新客户端尚未拉取过排行榜（rankRows=null）
  assert.strictEqual(sentMsgs.filter(m => m.type === 'leaderboard').length, 0);

  // 首页直接打开"我的战绩"（不经过排行榜），再点"返回排行榜"
  $id('btn-my-profile').onclick();
  assert.strictEqual($id('screen-profile').classList.contains('hidden'), false);
  recv({ type: 'profile', profile: null });
  $id('btn-profile-back-rank').onclick();

  // 关键回归：返回时必须主动发起排行榜请求，否则 rankRows 一直为 null、永远显示加载中
  assert.strictEqual(sentMsgs.filter(m => m.type === 'leaderboard').length, 1);
  assert.strictEqual($id('screen-rank').classList.contains('hidden'), false);
  assert.match($id('rank-list').innerHTML, /加载中/);

  // 请求返回后正常渲染、退出加载态
  setRows(['pidA']);
  recv({ type: 'leaderboard', sort: 'total', startedAt: 1000, rows: [
    { rank: 1, pid: 'pidA', name: '甲', games: 1, wins: 1, ties: 0, losses: 0,
      totalScore: 10, avgScore: 10, bestChain: 3, winRate: 1, lastAt: 5 }] });
  assert.doesNotMatch($id('rank-list').innerHTML, /加载中/);
  assert.match($id('rank-list').innerHTML, /甲/);
});

test('从排行榜点行进个人页再返回：已有缓存直接展示，不重复请求', () => {
  // 上一测已加载排行榜；点某行进个人页
  setRows(['pidA']);
  $id('rank-list').querySelectorAll('.rank-row')[0].onclick();
  assert.strictEqual($id('screen-profile').classList.contains('hidden'), false);
  recv({ type: 'profile', profile: {
    pid: 'pidA', name: '甲', rank: 1, games: 1, wins: 1, ties: 0, losses: 0,
    totalScore: 10, avgScore: 10, bestChain: 3, winRate: 1, lastAt: 5 } });

  const before = sentMsgs.filter(m => m.type === 'leaderboard').length;
  $id('btn-profile-back-rank').onclick();
  assert.strictEqual($id('screen-rank').classList.contains('hidden'), false);
  assert.strictEqual(sentMsgs.filter(m => m.type === 'leaderboard').length, before,
    '已有排行榜数据时返回不应重复请求');
  assert.doesNotMatch($id('rank-list').innerHTML, /加载中/);
  assert.match($id('rank-list').innerHTML, /甲/);
});

test('排行榜：打开即请求，切换三种排序，点玩家行进其个人页', () => {
  // 打开排行榜：切到 rank 屏并发出默认按总分的请求
  $id('btn-rank-home').onclick();
  assert.strictEqual($id('screen-rank').classList.contains('hidden'), false);
  assert.strictEqual(lastSent('leaderboard').sort, 'total');
  assert.match($id('rank-list').innerHTML, /加载中/);

  // 服务端返回两名玩家：渲染表格，第一名高亮主排序按钮
  setRows(['pidA', 'pidB']);
  recv({ type: 'leaderboard', sort: 'total', startedAt: 1000, rows: [
    { rank: 1, pid: 'pidA', name: '甲', games: 2, wins: 2, ties: 0, losses: 0,
      totalScore: 20, avgScore: 10, bestChain: 4, winRate: 1, lastAt: 5 },
    { rank: 2, pid: 'pidB', name: '乙', games: 2, wins: 0, ties: 0, losses: 2,
      totalScore: 6, avgScore: 3, bestChain: 2, winRate: 0, lastAt: 5 },
  ] });
  assert.match($id('rank-list').innerHTML, /甲/);
  assert.match($id('rank-list').innerHTML, /100%/);
  assert.ok($id('btn-sort-total').classList.contains('primary'));

  // 切到按胜场：发请求，响应后高亮对应按钮
  $id('btn-sort-wins').onclick();
  assert.strictEqual(lastSent('leaderboard').sort, 'wins');
  recv({ type: 'leaderboard', sort: 'wins', startedAt: 1000, rows: [
    { rank: 1, pid: 'pidA', name: '甲', games: 2, wins: 2, ties: 0, losses: 0,
      totalScore: 20, avgScore: 10, bestChain: 4, winRate: 1, lastAt: 5 },
  ] });
  assert.ok($id('btn-sort-wins').classList.contains('primary'));
  assert.ok(!$id('btn-sort-total').classList.contains('primary'));

  // 切到按胜率
  $id('btn-sort-rate').onclick();
  assert.strictEqual(lastSent('leaderboard').sort, 'rate');

  // 点某玩家行：请求该 pid 的个人页
  setRows(['pidB']);
  recv({ type: 'leaderboard', sort: 'rate', startedAt: 1000, rows: [
    { rank: 1, pid: 'pidA', name: '甲', games: 2, wins: 2, ties: 0, losses: 0,
      totalScore: 20, avgScore: 10, bestChain: 4, winRate: 1, lastAt: 5 },
    { rank: 2, pid: 'pidB', name: '乙', games: 2, wins: 0, ties: 0, losses: 2,
      totalScore: 6, avgScore: 3, bestChain: 2, winRate: 0, lastAt: 5 },
  ] });
  const rowB = Array.from($id('rank-list').querySelectorAll('.rank-row'))
    .find(r => r.dataset.pid === 'pidB');
  rowB.onclick();
  assert.strictEqual(lastSent('profile').pid, 'pidB');
  assert.strictEqual(lastSent('profile').pidSecret, undefined);
  assert.strictEqual($id('screen-profile').classList.contains('hidden'), false);
  assert.match($id('profile-body').innerHTML, /加载中/);

  recv({ type: 'profile', profile: {
    pid: 'pidB', name: '乙', rank: 2, games: 2, wins: 0, ties: 0, losses: 2,
    totalScore: 6, avgScore: 3, bestChain: 2, winRate: 0, lastAt: 5 } });
  const html = $id('profile-body').innerHTML;
  assert.match(html, /乙/);
  assert.match(html, /最高连锁/);
  assert.match(html, />2</); // bestChain 值
  assert.match(html, /平均得分/);
});

test('个人页：我的战绩凭本机密钥查询；无记录玩家显示空态', () => {
  // 从首页打开"我的战绩"（首次访问时才惰性生成本机密钥）
  $id('btn-profile-back-home').onclick();
  assert.strictEqual($id('screen-home').classList.contains('hidden'), false);
  $id('btn-my-profile').onclick();
  const mySecret = mem.wt_pid_secret;
  assert.ok(/^[a-f0-9]{64}$/.test(mySecret), '无 crypto 时应回退生成 64 位十六进制密钥');
  // 只把密钥发给服务器，公开 pid 由服务端派生
  assert.strictEqual(lastSent('profile').pidSecret, mySecret);
  assert.strictEqual(lastSent('profile').pid, undefined);
  assert.strictEqual($id('screen-profile').classList.contains('hidden'), false);

  // 服务器表示本机玩家还没有已结束对局
  recv({ type: 'profile', profile: null });
  assert.match($id('profile-body').innerHTML, /还没有已结束的对局/);
});

test('空赛季排行榜显示空态；返回排行榜按钮不重新请求', () => {
  $id('btn-rank-home').onclick();
  recv({ type: 'leaderboard', sort: 'total', season: 1, startedAt: 1000,
    seasons: [{ season: 1, current: true, startedAt: 1000, endedAt: null, players: 0 }], rows: [] });
  assert.match($id('rank-list').innerHTML, /还没有人完成对局/);
});

test('排行榜头部显示当前赛季序号与赛季总数', () => {
  $id('btn-rank-home').onclick();
  recv({ type: 'leaderboard', sort: 'total', season: 3, startedAt: 1000,
    seasons: [
      { season: 3, current: true, startedAt: 9000, endedAt: null, players: 1 },
      { season: 2, current: false, startedAt: 5000, endedAt: 9000, players: 2 },
      { season: 1, current: false, startedAt: 1000, endedAt: 5000, players: 2 },
    ], rows: [
      { rank: 1, pid: 'pidA', name: '甲', games: 1, wins: 1, ties: 0, losses: 0,
        totalScore: 10, avgScore: 10, bestChain: 3, winRate: 1, lastAt: 5 }] });
  const head = $id('rank-season').textContent;
  assert.match(head, /第 3 赛季/);
  assert.match(head, /共 3 个赛季/);

  // 只有一个赛季时不显示"共 N 个赛季"
  recv({ type: 'leaderboard', sort: 'total', season: 1, startedAt: 1000,
    seasons: [{ season: 1, current: true, startedAt: 1000, endedAt: null, players: 1 }], rows: [
      { rank: 1, pid: 'pidA', name: '甲', games: 1, wins: 1, ties: 0, losses: 0,
        totalScore: 10, avgScore: 10, bestChain: 3, winRate: 1, lastAt: 5 }] });
  assert.match($id('rank-season').textContent, /第 1 赛季/);
  assert.doesNotMatch($id('rank-season').textContent, /共/);
});

test('个人页：当前赛季汇总带赛季说明，并渲染各赛季名次（进行中 + 已归档）', () => {
  const profile = {
    pid: 'pidA', name: '甲', season: 2, rank: 1,
    games: 1, wins: 1, ties: 0, losses: 0, totalScore: 10, avgScore: 10,
    bestChain: 3, winRate: 1, lastAt: 9,
    seasons: [
      { season: 2, current: true, name: '甲', startedAt: 5000, endedAt: null,
        rank: 1, games: 1, wins: 1, ties: 0, losses: 0, totalScore: 10, avgScore: 10,
        bestChain: 3, winRate: 1, lastAt: 9 },
      { season: 1, current: false, name: '甲', startedAt: 1000, endedAt: 5000,
        rank: 2, games: 4, wins: 3, ties: 1, losses: 0, totalScore: 80, avgScore: 20,
        bestChain: 4, winRate: 0.75, lastAt: 4 },
    ],
  };
  askProfileByName(profile);
  const html = $id('profile-body').innerHTML;
  assert.match(html, /各赛季名次/);
  assert.match(html, /第 2 赛季/);
  assert.match(html, /第 1 赛季/);
  assert.match(html, /进行中/);
  assert.match(html, /已归档/);
  assert.match(html, /第 2 名/, '历史赛季冻结名次展示');
  assert.match(html, /第 2 赛季汇总|第 2 赛季/);
});

test('个人页：只在历史赛季有记录的玩家（新赛季未打）仍正常渲染历史名次', () => {
  const profile = {
    pid: 'pidOld', name: '老玩家', season: 2, rank: null,
    games: 0, wins: 0, ties: 0, losses: 0, totalScore: 0, avgScore: 0,
    bestChain: 0, winRate: 0, lastAt: 0,
    seasons: [
      { season: 1, current: false, name: '老玩家', startedAt: 1000, endedAt: 5000,
        rank: 3, games: 9, wins: 2, ties: 1, losses: 6, totalScore: 60, avgScore: 6.7,
        bestChain: 3, winRate: 0.22, lastAt: 4 },
    ],
  };
  askProfileByName(profile);
  const html = $id('profile-body').innerHTML;
  assert.match(html, /老玩家/);
  assert.match(html, /当前赛季暂无排名/);
  assert.match(html, /各赛季名次/);
  assert.match(html, /第 1 赛季/);
  assert.match(html, /第 3 名/);
});

test('个人页：旧服务端响应不带 seasons/season 字段时降级（不渲染赛季段、不报错）', () => {
  askProfileByName({ pid: 'pidZ', name: '旧', rank: 1, games: 1, wins: 1, ties: 0, losses: 0,
    totalScore: 5, avgScore: 5, bestChain: 1, winRate: 1, lastAt: 9 });
  const html = $id('profile-body').innerHTML;
  assert.match(html, /旧/);
  assert.doesNotMatch(html, /各赛季名次/);
  assert.match(html, /当前赛季/);
});

test('排行榜请求随带本机密钥，服务端回 myPid 后高亮我的行并置顶显示汇总', () => {
  // 预设本机密钥，使本机 myPid 恰好是 pidA（甲）；测试间共享 localStorage，后续用例沿用
  mem.wt_pid_secret = 'a'.repeat(64);
  const crypto = require('node:crypto');
  const myPid = crypto.createHash('sha256').update('a'.repeat(64)).digest('hex');

  $id('btn-rank-home').onclick();
  assert.ok(/^[a-f0-9]{64}$/.test(lastSent('leaderboard').pidSecret),
    '排行榜请求应随带本机密钥以认领 myPid');
  setRows([PID_ME, 'pidB']);
  recv({ type: 'leaderboard', sort: 'total', startedAt: 1000, myPid, rows: LB_MY_ROWS });

  // 自己那一行加 me 高亮类、昵称旁有"我"标记
  const html = $id('rank-list').innerHTML;
  assert.match(html, /class="rank-row me"/);
  assert.match(html, /<span class="me-tag-inline">我<\/span>/);

  // 顶部固定条：当前排序维度下的名次、总分、胜场、胜率
  const mine = $id('rank-mine').innerHTML;
  assert.ok(!$id('rank-mine').classList.contains('hidden'), '我的汇总条应显示');
  assert.match(mine, /第 1 名/);
  assert.match(mine, /20/); // 总分
  assert.match(mine, /胜场/);
  assert.match(mine, /100%/); // 胜率
});

test('我的汇总条随排序切换展示该维度名次；未上榜显示空态；点击定位到我的行', () => {
  const myPid = PID_ME;

  // 切到按胜场：我（甲）在该榜同样第 1
  $id('btn-sort-wins').onclick();
  recv({ type: 'leaderboard', sort: 'wins', startedAt: 1000, myPid, rows: [LB_MY_ROWS[0]] });
  assert.match($id('rank-mine').innerHTML, /按胜场榜/);
  assert.match($id('rank-mine').innerHTML, /第 1 名/);

  // 点汇总条：滚动定位到榜内自己那一行（NodeList 无 find，曾经因此抛错失效）
  setRows([PID_ME]);
  rankRowEl(PID_ME).scrollCalls = [];
  assert.doesNotThrow(() => $id('rank-mine').onclick());
  assert.strictEqual(rankRowEl(PID_ME).scrollCalls.length, 1, '应对我的行调用 scrollIntoView');
  assert.deepStrictEqual(rankRowEl(PID_ME).scrollCalls[0],
    { block: 'center', behavior: 'smooth' });

  // 搜索词把我的行过滤掉时点汇总条：先清词重渲染，再滚到我的行
  recv({ type: 'leaderboard', sort: 'total', startedAt: 1000, myPid, rows: LB_MY_ROWS });
  setRows([PID_ME, 'pidB']);
  const input = $id('rank-search-input');
  input.value = '乙';
  input.oninput({ target: input });
  rankRowEl(PID_ME).scrollCalls = [];
  assert.doesNotThrow(() => $id('rank-mine').onclick());
  assert.strictEqual(input.value, '', '点击置顶条应清掉昵称搜索词');
  // 清词后列表重建为完整榜单，我的行重新出现并被定位
  assert.strictEqual(rankRowEl(PID_ME).scrollCalls.length, 1);

  // 服务端未认领（密钥尚未有对局）：汇总条显示引导空态，不显示名次
  recv({ type: 'leaderboard', sort: 'total', startedAt: 1000, myPid: null, rows: LB_MY_ROWS });
  assert.ok(!$id('rank-mine').classList.contains('hidden'), '未上榜也保留汇总条');
  assert.match($id('rank-mine').innerHTML, /还没有完成对局/);
  assert.doesNotMatch($id('rank-mine').innerHTML, /第 \d+ 名/);
});

test('昵称搜索：输入即按昵称过滤，命中/无命中/清空三态', () => {
  const myPid = PID_ME;
  $id('btn-rank-home').onclick();
  setRows([PID_ME, 'pidB']);
  recv({ type: 'leaderboard', sort: 'total', startedAt: 1000, myPid, rows: LB_MY_ROWS });

  // 输入"乙"：只剩乙行，不重新请求服务器（纯前端过滤）
  const before = sentMsgs.filter(m => m.type === 'leaderboard').length;
  const input = $id('rank-search-input');
  input.value = '乙';
  input.oninput({ target: input });
  assert.strictEqual(sentMsgs.filter(m => m.type === 'leaderboard').length, before);
  let html = $id('rank-list').innerHTML;
  assert.match(html, /乙/);
  assert.doesNotMatch(html, /甲/);
  assert.doesNotMatch(html, /没有昵称包含/);

  // 输入无命中的词：显示无结果提示并回显搜索词
  input.value = '丙';
  input.oninput({ target: input });
  html = $id('rank-list').innerHTML;
  assert.match(html, /没有昵称包含/);
  assert.match(html, /丙/);

  // 清空：恢复全部行，我的高亮仍在
  input.value = '';
  input.oninput({ target: input });
  html = $id('rank-list').innerHTML;
  assert.match(html, /甲/);
  assert.match(html, /乙/);
  assert.match(html, /class="rank-row me"/);
});

test('个人页徽章：已获得/待解锁分区、点亮计数与未达成进度均渲染', () => {
  const ach = require('../public/achievements');
  // 直接用服务端同款纯逻辑生成徽章：10 场 3 胜、最高连锁 4
  const stat = { pid: 'pidX', name: '丁', rank: 3, games: 10, wins: 3, ties: 1, losses: 6,
    totalScore: 88, avgScore: 8.8, bestChain: 4, winRate: 0.3, lastAt: 9 };
  const profile = { ...stat, badges: ach.evaluate(stat) };

  $id('btn-rank-home').onclick();
  askProfileByName(profile);

  const html = $id('profile-body').innerHTML;
  // 标题计数：games-1/games-10、wins-1/wins-3、chain-3 = 5 枚点亮
  assert.match(html, /赛季成就/);
  assert.match(html, /（5\/9）/);
  // 已获得分区里有点亮的徽章名，待解锁分区存在
  assert.match(html, /赛场常客/);
  assert.match(html, /连战连捷/);
  assert.match(html, /已获得/);
  assert.match(html, /待解锁/);
  // chain-5 未达成：进度 4/5、80% 进度条；已点亮的徽章显示"已点亮"而非进度条
  assert.match(html, /最高连锁 4\/5/);
  assert.match(html, /width:80%/);
  assert.match(html, /已点亮/);
  assert.ok(html.indexOf('已点亮') < html.indexOf('待解锁'), '已点亮标记出现在待解锁分区之前');
});

test('个人页徽章：旧服务端响应不带 badges 时客户端按数据现算（降级不空白）', () => {
  // 模拟旧服务端：profile 无 badges 字段；全局 WTAchievements 已加载，应自动派生
  const oldStyle = { pid: 'pidY', name: '戊', rank: null, games: 1, wins: 0, ties: 1, losses: 0,
    totalScore: 5, avgScore: 5, bestChain: 1, winRate: 0, lastAt: 9 };
  askProfileByName(oldStyle);
  const html = $id('profile-body').innerHTML;
  assert.match(html, /赛季成就/);
  assert.match(html, /初来乍到/); // games-1 点亮
  assert.match(html, /待解锁/);
});

// 直接喂 profile 响应并进入个人页（绕过点行流程）
function askProfileByName(profile) {
  showProfileForTest();
  recv({ type: 'profile', profile });
}
function showProfileForTest() {
  $id('btn-my-profile').onclick(); // 切到 profile 屏并发出请求（内容随后被 recv 覆盖）
}
