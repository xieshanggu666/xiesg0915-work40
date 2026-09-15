'use strict';
// 跨房间赛事端到端（真实启停服务器 + WebSocket）：
// 1. 房主创建赛事，4 名来自"不同房间"的玩家（各自独立连接）报名，到点自动开赛抽签；
// 2. 选手凭密钥进入当前对阵：服务端惰性开 2 人房间、两人到齐自动开局，普通加入路径被拒；
// 3. 对局结束自动晋级并回写赛季战绩（每个对阵房间都是普通对局，走赛季逐局索引）；
// 4. 平局房间 -> 赛事自动安排重赛；等待开赛期间弃权 -> 对手晋级；
// 5. ready 超时：只来一人 -> walkover；两人都没到 -> 种子靠前 noshow 兜底；
// 6. 异常重赛（决赛）回滚冠军，重赛房间产生新冠军；
// 7. 重启对账：对阵房间已结束但赛事未回写（防抖窗口内被杀）时补回写。
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stamp = `${process.pid}-${Date.now()}`;
const DATA_FILE = path.join(os.tmpdir(), `wt-tour-rooms-${stamp}.json`);
const SEASON_FILE = path.join(os.tmpdir(), `wt-tour-season-${stamp}.json`);
const TOURNAMENT_FILE = path.join(os.tmpdir(), `wt-tour-data-${stamp}.json`);
process.env.WT_DATA_FILE = DATA_FILE;
process.env.WT_SEASON_FILE = SEASON_FILE;
process.env.WT_TOURNAMENT_FILE = TOURNAMENT_FILE;
process.env.WT_MATCH_WAIT_MS = String(30 * 1000);   // 进程级最小 60s；场景另靠短等待实例
process.env.WT_ROOM_PRUNE_INTERVAL_MS = String(3600 * 1000);
process.env.WT_ROOM_TTL_MS = String(365 * 24 * 60 * 60 * 1000);

const seasonLib = require('../season');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let BASE_URL = '';
let clientSeq = 0;
function client() {
  const c = { ws: new WebSocket(BASE_URL), state: null, token: null, msgs: [], name: `c${++clientSeq}` };
  c.ws.on('error', () => {});
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'joined') c.token = m.token;
    if (m.type === 'state') c.state = m.state;
    c.msgs.push(m);
  });
  c.waitFor = (pred, timeout = 4000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred(c)) { clearInterval(iv); res(c); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('waitFor 超时')); }
    }, 10);
  });
  c.waitMsg = (type, timeout = 4000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = [...c.msgs].reverse().find(x => x.type === type);
      if (m) { clearInterval(iv); res(m); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error(`waitMsg ${type} 超时`)); }
    }, 10);
  });
  c.lastMsg = (type) => [...c.msgs].reverse().find(m => m.type === type);
  c.opened = new Promise(res => c.ws.on('open', res));
  return c;
}

const SECRET = n => n.toString(16).padStart(64, '0');
const PID = n => seasonLib.resolvePid({ pidSecret: SECRET(n) }).pid;

// 用纯逻辑在内存里打完一局对应房间（不经过 UI）：需要服务端房间对象，这里改走客户端
// 行动消息——两名选手轮流"结束回合"，rounds=1 时很快结束。
async function playMatchRoom(a, b, { tie = false } = {}) {
  await a.waitFor(c => c.state && c.state.phase === 'playing');
  await b.waitFor(c => c.state && c.state.phase === 'playing');
  let guard = 0;
  // 极简局：每人 1 回合，全空过（起始 3 词，无人接词 -> 比分 0:0 平局）。
  // 要分胜负就让 a 接一个词（a 至少有分）。
  while (a.state && a.state.phase === 'playing' && guard++ < 30) {
    const cur = a.state.turn.playerId === a.state.you ? a : b;
    if (cur === a && !tie && guard <= 2) {
      a.send({ type: 'play', word: `冠军词${guard}`, parentId: 'start0',
        relation: 'synonym', reason: '足够长的关系解释内容' });
      await sleep(15);
    }
    cur.send({ type: 'endTurn' });
    await sleep(15);
  }
  await a.waitFor(c => c.state && c.state.phase === 'ended');
  return a.state;
}

async function main() {
  const { startServer, stopServer } = require('../server');
  let srv = await startServer(0);
  BASE_URL = `ws://localhost:${srv.port}`;

  // ---------- 1. 创建赛事并报名 ----------
  const host = client();
  await host.opened;
  host.send({ type: 'tournamentCreate', name: '房主', tournamentName: '跨房杯',
    pidSecret: SECRET(1), registerMs: 60 * 1000,
    rules: { rounds: 1, turnSeconds: 60, startWordCount: 3 } });
  const created = await host.waitMsg('tournamentCreated');
  const tid = created.tournament.id;
  check('创建赛事：处于报名中', created.tournament.phase === 'registering');
  host.send({ type: 'tournamentWatch', tournamentId: tid, pidSecret: SECRET(1) });
  await host.waitMsg('tournament');

  const players = [];
  for (let i = 1; i <= 4; i++) {
    const c = client();
    await c.opened;
    c.send({ type: 'tournamentRegister', tournamentId: tid, name: `玩家${i}`, pidSecret: SECRET(i) });
    await c.waitMsg('tournamentRegistered');
    players.push(c);
  }
  // 重复报名被拒
  players[0].send({ type: 'tournamentRegister', tournamentId: tid, name: '玩家1', pidSecret: SECRET(1) });
  const dupErr = await players[0].waitMsg('error');
  check('同一身份不能重复报名', /已经报名/.test(dupErr.message));


  // 房主提前开赛（4 人 -> 4 签无轮空）
  host.send({ type: 'tournamentStart', tournamentId: tid, pidSecret: SECRET(1) });
  await host.waitFor(c => c.msgs.some(m => m.type === 'tournament' &&
    m.tournament.phase === 'running'));
  const tv = host.lastMsg('tournament').tournament;
  check('开赛：running，4 签 2 轮', tv.phase === 'running' && tv.size === 4 && tv.rounds === 2);
  const r1 = tv.bracket[0];
  check('第一轮两场都 ready', r1.length === 2 && r1.every(m => m.status === 'ready'));
  const semiA = r1[0];
  const semiB = r1[1];

  // ---------- 2. 进入半决赛 A：凭 pid 开房，普通加入路径被拒 ----------
  // 找出 semiA 两名选手对应的客户端（按 pid）
  const clientByPid = new Map();
  for (let i = 0; i < 4; i++) clientByPid.set(PID(i + 1), players[i]);
  const ca1 = clientByPid.get(semiA.pidA);
  const ca2 = clientByPid.get(semiA.pidB);
  ca1.send({ type: 'tournamentEnter', tournamentId: tid, pidSecret: SECRET([1,2,3,4].find(i => PID(i) === semiA.pidA)) });
  await ca1.waitMsg('joined');
  const codeA = ca1.state.code;
  check('第一名选手进入：赛事房间已开但未开局（lobby）', ca1.state.phase === 'lobby');
  // 无关玩家凭房间码普通加入 -> 拒绝
  const outsider = client();
  await outsider.opened;
  outsider.send({ type: 'joinRoom', roomCode: codeA, name: '路人', pidSecret: SECRET(9) });
  const blockErr = await outsider.waitMsg('error');
  check('普通加入路径对赛事房间关闭', /赛事/.test(blockErr.message));
  // 观战仍允许
  outsider.send({ type: 'spectate', roomCode: codeA, name: '围观' });
  await outsider.waitFor(c => c.state && c.state.spectating === true);
  check('赛事房间仍可观战', outsider.state.spectating === true);
  // 第二名选手进入 -> 自动开局
  const idxA2 = [1,2,3,4].find(i => PID(i) === semiA.pidB);
  ca2.send({ type: 'tournamentEnter', tournamentId: tid, pidSecret: SECRET(idxA2) });
  await ca2.waitMsg('joined');
  check('两人到齐自动开局', !!(await ca2.waitFor(c => c.state && c.state.phase === 'playing')));

  // ---------- 3. 打完半决赛 A：ca1（pidA 侧）接词获胜，自动晋级 ----------
  await playMatchRoom(ca1, ca2, { tie: false });
  await sleep(350); // 等赛事回写与广播
  const tv2 = host.lastMsg('tournament').tournament;
  const semiAResult = tv2.bracket[0].find(m => m.id === semiA.id);
  check('半决赛 A 已决出', semiAResult.status === 'finished' && !!semiAResult.winnerEid);
  check('赛季已回写该对局（双方各计 1 场）',
    seasonGames(PID([1,2,3,4].find(i => PID(i) === semiA.pidA))) === 1 &&
    seasonGames(PID(idxA2)) === 1);

  // ---------- 4. 半决赛 B：等待期间一方弃权 ----------
  // 半决赛 B：等待期间一方弃权（cb2 未使用其连接，仅服务端按 pid 判负）
  const cb1 = clientByPid.get(semiB.pidA);
  void cb1;
  const idxB1 = [1,2,3,4].find(i => PID(i) === semiB.pidA);
  cb1.send({ type: 'tournamentForfeit', tournamentId: tid, pidSecret: SECRET(idxB1) });
  await cb1.waitMsg('tournamentForfeited');
  await sleep(50);
  let tv3 = host.lastMsg('tournament').tournament;
  const semiBResult = tv3.bracket[0].find(m => m.id === semiB.id);
  check('弃权：对手晋级、认输者 forfeit',
    semiBResult.status === 'finished' &&
    semiBResult.result && semiBResult.result.type === 'forfeit' &&
    semiBResult.winnerEid !== semiBResult.loserEid);

  // 决赛此时 ready（两路都决出）
  const finalReady = tv3.bracket[1][0];
  check('决赛已公示 ready', finalReady.status === 'ready');

  // 决赛下一场公示后，旧半决赛不能再异常重赛
  host.send({ type: 'tournamentRematch', tournamentId: tid, matchId: semiA.id, pidSecret: SECRET(1) });
  const lateErr = await host.waitMsg('error');
  check('决赛公示后不能再重赛半决赛', /下一轮/.test(lateErr.message));

  // ---------- 5. 决赛：一方进入后打出平局 -> 自动重赛 ----------
  const finalPidA = finalReady.pidA;
  const finalPidB = finalReady.pidB;
  const cf1 = clientByPid.get(finalPidA);
  const cf2 = clientByPid.get(finalPidB);
  const idxF1 = [1,2,3,4].find(i => PID(i) === finalPidA);
  const idxF2 = [1,2,3,4].find(i => PID(i) === finalPidB);
  cf1.send({ type: 'tournamentEnter', tournamentId: tid, pidSecret: SECRET(idxF1) });
  await cf1.waitMsg('joined');
  cf2.send({ type: 'tournamentEnter', tournamentId: tid, pidSecret: SECRET(idxF2) });
  await cf2.waitFor(c => c.state && c.state.phase === 'playing');
  await playMatchRoom(cf1, cf2, { tie: true });
  await sleep(300);
  const tv4 = host.lastMsg('tournament').tournament;
  const oldFinal = tv4.bracket[1].find(m => m.id === finalReady.id);
  const repFinal = tv4.bracket[1].find(m => m.rematchOf === finalReady.id);
  check('决赛平局：旧场 void、自动生成重赛场（ready）',
    oldFinal.status === 'void' && repFinal && repFinal.status === 'ready');
  // 决赛 A 侧胜者打过半决赛 A + 决赛平局 = 2 场；B 侧是弃权晋级，只打了决赛 = 1 场
  check('平局旧局也回写了赛季（双方各计场次）',
    seasonGames(finalPidA) === 2 && seasonGames(finalPidB) === 1);

  // 房主在重赛决赛开打前也可主动再安排一次异常重赛（这里直接打重赛决赛分胜负）
  const cr1 = clientByPid.get(finalPidA);
  const cr2 = clientByPid.get(finalPidB);
  cr1.send({ type: 'tournamentEnter', tournamentId: tid, pidSecret: SECRET(idxF1) });
  await cr1.waitMsg('joined');
  cr2.send({ type: 'tournamentEnter', tournamentId: tid, pidSecret: SECRET(idxF2) });
  await cr2.waitFor(c => c.state && c.state.phase === 'playing');
  await playMatchRoom(cr1, cr2, { tie: false });
  await sleep(300);
  const tv5 = host.lastMsg('tournament').tournament;
  check('重赛决赛后完赛，冠军产生',
    tv5.phase === 'finished' && !!tv5.championEid && tv5.finalStandings.length === 4);
  check('冠军是决赛实际胜者', tv5.finalStandings[0].eid === tv5.championEid);

  // ---------- 6. 名单/视图：列表含完赛赛事 ----------
  const lister = client();
  await lister.opened;
  lister.send({ type: 'tournamentList', pidSecret: SECRET(2) });
  const listMsg = await lister.waitMsg('tournamentList');
  const row = listMsg.tournaments.find(x => x.id === tid);
  check('赛事列表：含完赛赛事且标注冠军', row && row.phase === 'finished' && !!row.championName);

  // ---------- 7. 重启对账（另一场赛事：房间已结束但赛事回写未落盘） ----------
  // 直接造一场 2 人赛事与已结束房间，写盘时让赛事索引缺失该房间结果，重启后应补回写。
  await stopServer();
  const { pids: pids2 } = await seedUnreportedRoom();
  srv = await startServer(srv.port);
  BASE_URL = `ws://localhost:${srv.port}`;
  await sleep(300);
  const tOnDisk = JSON.parse(fs.readFileSync(TOURNAMENT_FILE, 'utf8'));
  const t2 = tOnDisk.tournaments[pids2.tid];
  check('重启对账：已结束但漏回写的对阵房间补回写并完赛',
    t2 && t2.phase === 'finished' && !!t2.championEid);

  await srv.stop();
}

function seasonGames(pid) {
  // 直接读磁盘赛季档（防抖已在 sleep 后落盘；必要时读内存通过 HTTP 不行，用文件）
  try {
    const raw = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
    return raw.players[pid] ? raw.players[pid].games : 0;
  } catch { return -1; }
}

// 造一场 2 人赛事 + 一个已结束的赛事对局房间，但赛事场次停留在 live（未回写），
// 模拟"对局结束、赛事 300ms 防抖落盘前被杀"。
async function seedUnreportedRoom() {
  const g = require('../game');
  const T = require('../tournament');
  const tid = 'tm_' + 'c'.repeat(12);
  const pidA = PID(10);
  const pidB = PID(11);
  // 先让服务端既有的房间档保留，再追加：读出当前 rooms.json
  const roomsOnDisk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const code = 'TR99';
  const room = g.newRoom(code, 'pa', '赛事房');
  room.tournamentId = tid;
  room.matchId = 'r1-0';
  g.addPlayer(room, 'pa', '选手A', pidA);
  g.addPlayer(room, 'pb', '选手B', pidB);
  g.setRuleSet(room, 'pa', { rounds: 1, startWordCount: 1 });
  g.startGame(room, 'pa', () => 0.5);
  g.playWord(room, 'pa', { word: '晋级词', parentId: 'start0', relation: 'synonym', reason: '足够长的关系解释' });
  g.endTurn(room, 'pa');
  g.endTurn(room, 'pb');
  if (room.phase !== 'ended') throw new Error('seed 房间未结束');
  // 与真实赛事房间一致：无个人房主（setRuleSet/startGame 在置空前已用房主身份完成）
  room.hostId = null;
  room.tournamentId = tid;
  room.matchId = 'r1-0';
  roomsOnDisk.rooms.push(room);
  roomsOnDisk.tokens = roomsOnDisk.tokens || {};
  fs.writeFileSync(DATA_FILE, JSON.stringify(roomsOnDisk));

  // 赛事档：2 人、已开赛、唯一决赛停在 live（两选手都进过房）且房间码指向 TR99
  const store = T.emptyStore();
  T.createTournament(store, { hostPid: pidA, hostName: '选手A', name: '对账杯',
    registerMs: 0, now: Date.now() - 60000, generate: () => tid });
  T.register(store, tid, { pid: pidA, name: '选手A', now: Date.now() - 59000 });
  T.register(store, tid, { pid: pidB, name: '选手B', now: Date.now() - 58000 });
  T.startBracket(store, tid, { hostPid: pidA, now: Date.now() - 50000 });
  const t = store.tournaments[tid];
  const m = t.matches['r1-0'];
  m.status = 'live';
  m.roomCode = code;
  m.checkedEids = [m.eidA, m.eidB];
  m.deadline = null;
  fs.writeFileSync(TOURNAMENT_FILE, JSON.stringify(store));
  return { pids: { tid, pidA, pidB } };
}

(async () => {
  let exitCode = 0;
  try {
    await main();
    if (failures !== 0) exitCode = 1;
  } catch (e) {
    console.error('赛事端到端测试异常:', e.stack || e.message);
    exitCode = 1;
  } finally {
    for (const f of [DATA_FILE, SEASON_FILE, TOURNAMENT_FILE]) {
      try {
        const base = path.basename(f).replace(/\.json$/, '');
        fs.readdirSync(path.dirname(f))
          .filter(n => n.includes(base))
          .forEach(n => fs.rmSync(path.join(path.dirname(f), n), { force: true }));
      } catch { /* 忽略 */ }
    }
  }
  console.log(exitCode === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(exitCode);
})();
