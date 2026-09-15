'use strict';
// 赛季归档与切换端到端测试：
// 1. 赛季到期：排行榜/结算广播惰性触发切换——老赛季冻结归档（带名次快照），新赛季清零重新累计；
// 2. 跨赛季不重复计分：老对局在全局逐局索引里，重启/重连广播不会在新赛季再算一遍；
// 3. 已有战绩档案平滑迁移：v2 赛季档（有索引、无赛季概念）启动后整体成为第 1 赛季，
//    到期才归档，战绩一行不多；空赛季不产生归档帧；
// 4. 个人页返回各赛季名次（当前赛季实时名次 + 历史冻结名次）。
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_FILE = path.join(os.tmpdir(), `wt-rollover-${process.pid}-${Date.now()}.json`);
const SEASON_FILE = path.join(os.tmpdir(), `wt-rollover-season-${process.pid}-${Date.now()}.json`);
process.env.WT_DATA_FILE = DATA_FILE;
process.env.WT_SEASON_FILE = SEASON_FILE;
process.env.WT_ROOM_TTL_MS = String(365 * 24 * 60 * 60 * 1000); // 房间长期保留
process.env.WT_ROOM_PRUNE_INTERVAL_MS = String(3600 * 1000);    // 周期任务不干扰，靠惰性切换
process.env.WT_SEASON_MS = String(1000);                        // 赛季时长 1 秒，便于到期验证

const game = require('../game');
const seasonLib = require('../season');
const crypto = require('crypto');

const SECRET_A = '8'.repeat(64);
const SECRET_B = '9'.repeat(64);
const PID_A = seasonLib.resolvePid({ pidSecret: SECRET_A }).pid;
const PID_B = seasonLib.resolvePid({ pidSecret: SECRET_B }).pid;

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let BASE_URL = '';
function client() {
  const c = { ws: new WebSocket(BASE_URL), state: null, token: null, msgs: [] };
  c.ws.on('error', () => {});
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'joined') c.token = m.token;
    if (m.type === 'state') c.state = m.state;
    c.msgs.push(m);
  });
  c.waitFor = (pred, timeout = 3000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred(c)) { clearInterval(iv); res(c); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('waitFor 超时')); }
    }, 10);
  });
  c.opened = new Promise(res => c.ws.on('open', res));
  return c;
}

// 两名玩家联网打完一局（1 回合/人、轮流空过），结束后关闭连接，返回房间码
async function playLiveGame() {
  const host = client();
  await host.opened;
  host.send({ type: 'createRoom', name: '在线甲', pidSecret: SECRET_A });
  await host.waitFor(c => c.state && c.state.phase === 'lobby');
  const mate = client();
  await mate.opened;
  mate.send({ type: 'joinRoom', name: '在线乙', pidSecret: SECRET_B, roomCode: host.state.code });
  await mate.waitFor(c => c.state && c.state.players.length === 2);
  host.send({ type: 'setRules', ruleSet: { rounds: 1, turnSeconds: 300 } });
  await host.waitFor(c => c.msgs.some(m => m.type === 'rulesSaved'));
  host.send({ type: 'startGame' });
  await host.waitFor(c => c.state.phase === 'playing');
  let guard = 0;
  while (host.state.phase === 'playing' && guard++ < 20) {
    const cur = host.state.turn.playerId === host.state.you ? host : mate;
    cur.send({ type: 'endTurn' });
    await sleep(20);
  }
  await host.waitFor(c => c.state.phase === 'ended');
  const code = host.state.code;
  host.ws.close(); mate.ws.close();
  return code;
}

async function readSeason() {
  await sleep(400); // 等 300ms 防抖落盘
  return JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
}

// 离线构造一间已结束房（与保留期/升级测试同款），用于伪造 v2 时代的现存房间
function buildEndedRoom(code) {
  const p0 = crypto.randomBytes(8).toString('hex');
  const p1 = crypto.randomBytes(8).toString('hex');
  const room = game.newRoom(code, p0, '甲');
  game.addPlayer(room, p0, '甲', PID_A);
  game.addPlayer(room, p1, '乙', PID_B);
  game.setRuleSet(room, p0, { rounds: 1, turnSeconds: 300 });
  game.startGame(room, p0, () => 0.5);
  for (let i = 0; i < 2; i++) game.endTurn(room, room.turn.playerId);
  if (room.phase !== 'ended') throw new Error('测试房未正常结束');
  return { room, p0, p1 };
}

async function main() {
  const { startServer, stopServer } = require('../server');

  // ---------- 1. 第 1 赛季打一局 ----------
  let srv = await startServer(0);
  BASE_URL = `ws://localhost:${srv.port}`;

  await playLiveGame();
  let raw = await readSeason();
  check('第 1 赛季累计首局（甲、乙各 1 场）',
    raw.version === 3 && raw.season === 1 &&
    raw.players[PID_A].games === 1 && raw.players[PID_B].games === 1);

  // 排行榜此刻仍是第 1 赛季
  let q = client();
  await q.opened;
  q.send({ type: 'leaderboard', sort: 'total', pidSecret: SECRET_A });
  await q.waitFor(c => c.msgs.some(m => m.type === 'leaderboard'));
  let lb = q.msgs.filter(m => m.type === 'leaderboard').at(-1);
  check('排行榜响应带赛季序号与赛季列表',
    lb.season === 1 && Array.isArray(lb.seasons) && lb.seasons.length === 1);
  check('本机密钥认领 myPid', lb.myPid === PID_A);
  q.ws.close();

  // ---------- 2. 赛季到期：排行榜请求惰性触发归档 ----------
  await sleep(1100); // 超过 1 秒赛季窗口
  q = client();
  await q.opened;
  q.send({ type: 'leaderboard', sort: 'total' });
  await q.waitFor(c => c.msgs.some(m => m.type === 'leaderboard' && m.season === 2));
  lb = q.msgs.filter(m => m.type === 'leaderboard').at(-1);
  check('到期后排行榜切到第 2 赛季且空榜', lb.season === 2 && lb.rows.length === 0);
  check('赛季列表含已归档的第 1 赛季与进行中的第 2 赛季',
    lb.seasons.length === 2 && lb.seasons[0].current === true && lb.seasons[0].season === 2 &&
    lb.seasons[1].season === 1 && lb.seasons[1].current === false && lb.seasons[1].players === 2);

  raw = await readSeason();
  check('档案已冻结第 1 赛季快照（含名次）并清零当前赛季',
    raw.season === 2 && raw.history.length === 1 && raw.history[0].season === 1 &&
    raw.history[0].players[PID_A].games === 1 && raw.history[0].players[PID_A].rank === 1 &&
    raw.history[0].players[PID_B].rank === 2 &&
    Object.keys(raw.players).length === 0);
  check('全局逐局索引在切换后保留（老局不会被再计一遍）',
    Object.keys(raw.recordedRooms).length === 1);
  q.ws.close();

  // ---------- 3. 新赛季再打一局：只计新赛季；个人页展示各赛季名次 ----------
  await playLiveGame();
  raw = await readSeason();
  check('第 2 赛季重新累计：甲、乙各 1 场；第 1 赛季快照仍是 1 场',
    raw.season === 2 && raw.players[PID_A].games === 1 && raw.players[PID_B].games === 1 &&
    raw.history[0].players[PID_A].games === 1);
  check('两局凭据都在全局索引中', Object.keys(raw.recordedRooms).length === 2);

  q = client();
  await q.opened;
  q.send({ type: 'profile', pid: PID_A });
  await q.waitFor(c => c.msgs.some(m => m.type === 'profile' && m.profile));
  const profMsg = q.msgs.filter(m => m.type === 'profile').at(-1);
  check('个人页响应带当前赛季序号（2）', profMsg.season === 2);
  const p = profMsg.profile;
  check('当前赛季汇总：1 场', p.games === 1);
  check('各赛季名次：第 2 赛季进行中第 1、第 1 赛季冻结第 1',
    p.seasons.length === 2 &&
    p.seasons[0].season === 2 && p.seasons[0].current === true && p.seasons[0].rank === 1 &&
    p.seasons[1].season === 1 && p.seasons[1].current === false && p.seasons[1].rank === 1 &&
    p.seasons[1].games === 1);
  q.ws.close();

  await stopServer();

  // ---------- 4. 重启：冻结赛季与索引都在，老局一场不重算 ----------
  let srv2 = await startServer(0);
  BASE_URL = `ws://localhost:${srv2.port}`;
  await sleep(300);
  raw = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  check('重启后仍是第 2 赛季、第 1 赛季归档仍在',
    raw.season === 2 && raw.history.length === 1 && raw.players[PID_A].games === 1);
  check('重启没有把两间老局重新累计（仍各 1 场、索引仍 2 条）',
    Object.keys(raw.recordedRooms).length === 2);
  await srv2.stop();

  // 等过启动恢复时 loadRooms 挂的 300ms 防抖存盘，再手工铺设 v2 旧档
  // （真实迁移场景里旧档本就在启动前存在；这里避免在防抖窗口内覆写被回滚）。
  await sleep(450);

  // ---------- 5. v2 旧档平滑迁移：整体成为第 1 赛季，到期归档时不重算 ----------
  const v2 = seasonLib.emptySeason(Date.now() - 100);
  v2.version = 2; // 模拟切换功能上线前的档案：有索引、无赛季概念
  // 手工塞一条玩家汇总与一条索引（与现存房间对应），迁移后必须原样保留
  v2.players[PID_A] = { pid: PID_A, name: '甲', games: 7, wins: 6, ties: 1,
    totalScore: 700, bestChain: 8, lastAt: Date.now() };
  const v2Built = buildEndedRoom('V2RM');
  v2.recordedRooms[game.roomKey(v2Built.room)] = v2Built.room.endedAt;
  const tok = crypto.randomBytes(16).toString('hex');
  // 只保留这一间房：前半程两间真实对局的房间档不应混进 v2 迁移场景
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    rooms: [v2Built.room],
    tokens: { [tok]: { roomCode: v2Built.room.code, playerId: v2Built.p0 } },
  }));
  fs.writeFileSync(SEASON_FILE, JSON.stringify(v2));

  srv2 = await startServer(0);
  BASE_URL = `ws://localhost:${srv2.port}`;
  await sleep(300);
  const onDiskData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  check('v2 迁移场景只恢复手工准备的一间房（无旧档防抖写回污染）',
    onDiskData.rooms.length === 1 && onDiskData.rooms[0].code === 'V2RM');
  raw = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  check('v2 档案迁移为 v3 第 1 赛季：7 场战绩与索引原样保留、不重算',
    raw.version === 3 && raw.season === 1 && raw.history.length === 0 &&
    raw.players[PID_A].games === 7 && raw.players[PID_A].totalScore === 700 &&
    Object.keys(raw.recordedRooms).length === 1);

  q = client();
  await q.opened;
  q.send({ type: 'leaderboard', sort: 'total' });
  await q.waitFor(c => c.msgs.some(m => m.type === 'leaderboard'));
  check('迁移后排行榜仍是老汇总（甲 7 场）',
    q.msgs.filter(m => m.type === 'leaderboard').at(-1).rows.find(r => r.pid === PID_A)?.games === 7);
  q.ws.close();

  await sleep(1100); // 赛季窗口仅 1 秒：下次请求触发归档
  q = client();
  await q.opened;
  q.send({ type: 'leaderboard', sort: 'total' });
  await q.waitFor(c => c.msgs.some(m => m.type === 'leaderboard' && m.season === 2));
  raw = await readSeason();
  check('迁移档案到期归档：第 1 赛季冻结为 7 场，第 2 赛季清零，索引仍只有 1 条',
    raw.season === 2 && raw.history.length === 1 &&
    raw.history[0].players[PID_A].games === 7 &&
    Object.keys(raw.players).length === 0 &&
    Object.keys(raw.recordedRooms).length === 1);

  // 空的第 2 赛季再到期：不产生空归档帧
  await sleep(1100);
  q.send({ type: 'leaderboard', sort: 'total' });
  await q.waitFor(c => c.msgs.some(m => m.type === 'leaderboard' && m.season === 3));
  raw = await readSeason();
  check('空赛季到期只开下一号、不归档（history 仍只有第 1 赛季）',
    raw.season === 3 && raw.history.length === 1 && raw.history[0].season === 1);
  q.ws.close();

  await srv2.stop();
}

(async () => {
  let exitCode = 0;
  try {
    await main();
    if (failures !== 0) exitCode = 1;
  } catch (e) {
    console.error('赛季切换测试异常:', e.stack || e.message);
    exitCode = 1;
  } finally {
    try { fs.rmSync(DATA_FILE, { force: true }); } catch { /* 忽略 */ }
    try { fs.rmSync(SEASON_FILE, { force: true }); } catch { /* 忽略 */ }
  }
  console.log(exitCode === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(exitCode);
})();
