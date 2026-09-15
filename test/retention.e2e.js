'use strict';
// 已结束房间保留期的端到端测试（服务器单次启停；启动前直接构造存档模拟积压旧局）：
// 1. 启动清理：超过保留期的已结束房间连同回放日志、对应 token 在加载时被清掉；
//    保留期内的结束房、很旧的大厅房不受影响；
// 2. 首页历史凭 token 换摘要，失效条目按现有机制自动消失；旧 token 重连/观战均被拒；
// 3. 赛季战绩单独落盘（season.json）：删房前会先确认这局确实已计入——
//    赛季档里漏记的局先补记并落盘，再删房间（修复"刚结束就重启导致场次永久丢失"）；
// 4. 运行期周期清理：到点房间在还有连接看结算/回放时保留，全部断开后下一轮才删除。
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_FILE = path.join(os.tmpdir(), `wt-retention-${process.pid}-${Date.now()}.json`);
const SEASON_FILE = path.join(os.tmpdir(), `wt-retention-season-${process.pid}-${Date.now()}.json`);
process.env.WT_DATA_FILE = DATA_FILE;
process.env.WT_SEASON_FILE = SEASON_FILE;
process.env.WT_ROOM_TTL_MS = String(5000);        // 保留期 5 秒
process.env.WT_ROOM_PRUNE_INTERVAL_MS = String(100); // 运行期快速周期清理
process.env.WT_SEASON_MS = '0';                    // 关闭赛季自动切换：本文件只验证保留期语义

const game = require('../game');
const seasonLib = require('../season');
const crypto = require('crypto');

const SECRET_A = '4'.repeat(64);
const SECRET_B = '5'.repeat(64);
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
    const msg = JSON.parse(raw);
    if (msg.type === 'joined') c.token = msg.token;
    if (msg.type === 'state') c.state = msg.state;
    c.msgs.push(msg);
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

// 用纯逻辑状态机离线打完一局（2 人、1 回合/人、轮流空过），返回 { room, p0, p1 }
function buildEndedRoom(code, secretA, secretB) {
  const p0 = crypto.randomBytes(8).toString('hex');
  const p1 = crypto.randomBytes(8).toString('hex');
  const room = game.newRoom(code, p0, '甲');
  game.addPlayer(room, p0, '甲', seasonLib.resolvePid({ pidSecret: secretA }).pid);
  game.addPlayer(room, p1, '乙', seasonLib.resolvePid({ pidSecret: secretB }).pid);
  game.setRuleSet(room, p0, { rounds: 1, turnSeconds: 300 });
  game.startGame(room, p0, () => 0.5);
  const total = 2;
  for (let i = 0; i < total; i++) game.endTurn(room, room.turn.playerId);
  if (room.phase !== 'ended') throw new Error('测试房未正常结束');
  return { room, p0, p1 };
}

function makeToken(roomCode, playerId) {
  return { tok: crypto.randomBytes(16).toString('hex'), ref: { roomCode, playerId } };
}

async function prepareArchive() {
  const now = Date.now();
  // 超期旧局（打完一小时前）
  // 超期旧局（打完一小时前）——关键 bug 场景：这局在房间上残留"已计入"的内存痕迹，
  // 但赛季文件里根本没有它（模拟结束后 300ms 防抖窗口内进程被杀/赛季写盘失败）。
  // 清理删房前必须先把它补记进赛季并落盘，否则两名玩家的场次永久丢失。
  const stale = buildEndedRoom('STAL', SECRET_A, SECRET_B);
  stale.room.endedAt = now - 60 * 60 * 1000;
  stale.room.seasonRecorded = true; // 标记残留为真，但赛季索引里没有
  // 另一个普通的超期旧局：已正常计入赛季，删除时战绩不变
  const old2 = buildEndedRoom('OLD2', SECRET_A, SECRET_B);
  old2.room.endedAt = now - 2 * 60 * 60 * 1000;
  // 保留期内的结束房（1 秒前结束——TTL 为 5 秒，仍在保留期内）
  const fresh = buildEndedRoom('FRSH', SECRET_A, SECRET_B);
  fresh.room.endedAt = now - 1_000;
  // 很旧的大厅房（30 天前创建，永不清理）
  const lobbyP0 = crypto.randomBytes(8).toString('hex');
  const lobby = game.newRoom('LOBB', lobbyP0, '大厅房主');
  game.addPlayer(lobby, lobbyP0, '大厅房主', null);
  game.ensureRoomId(lobby);
  lobby.createdAt = now - 30 * 24 * 60 * 60 * 1000;

  const tStale0 = makeToken('STAL', stale.p0);
  const tStale1 = makeToken('STAL', stale.p1);
  const tOld2 = makeToken('OLD2', old2.p0);
  const tFresh0 = makeToken('FRSH', fresh.p0);
  const tLobby = makeToken('LOBB', lobbyP0);
  const archive = {
    rooms: [stale.room, old2.room, fresh.room, lobby],
    tokens: Object.fromEntries([
      [tStale0.tok, tStale0.ref], [tStale1.tok, tStale1.ref], [tOld2.tok, tOld2.ref],
      [tFresh0.tok, tFresh0.ref], [tLobby.tok, tLobby.ref],
    ]),
  };
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(archive));

  // 赛季档案（v2）：只累计 old2 与 fresh 两局，故意漏掉 stale。
  // 启动清理后，stale 必须被补记：排行榜变成 3 局且房间已删，索引里留着它的凭据。
  const season = seasonLib.emptySeason(now - 100 * 24 * 60 * 60 * 1000);
  seasonLib.recordRoom(season, old2.room, now);
  seasonLib.recordRoom(season, fresh.room, now);
  fs.writeFileSync(SEASON_FILE, JSON.stringify(season));

  return { stale, old2, fresh, lobby, tStale0, tStale1, tOld2, tFresh0, tLobby };
}

// 两名玩家联网快速打完一局（用于运行期清理场景），结束后保持连接返回
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
    await sleep(30);
  }
  await host.waitFor(c => c.state.phase === 'ended');
  return { code: host.state.code, host, mate, tokenHost: host.token, tokenMate: mate.token };
}

async function main() {
  const prep = await prepareArchive();
  const { startServer, stopServer } = require('../server');
  const srv = await startServer(0);
  BASE_URL = `ws://localhost:${srv.port}`;
  await sleep(500); // 等启动清理触发的 300ms 防抖落盘

  // ---------- 1. 启动清理 ----------
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  check('超期结束房已从存档删除（含整份回放日志）',
    !data.rooms.some(r => r.code === 'STAL' || r.code === 'OLD2'));
  check('保留期内的结束房仍在', data.rooms.some(r => r.code === 'FRSH'));
  check('大厅房即使创建很久也保留', data.rooms.some(r => r.code === 'LOBB'));
  check('被删房间的全部 token 一并清除',
    !Object.values(data.tokens || {}).some(t => t.roomCode === 'STAL' || t.roomCode === 'OLD2'));
  check('保留房间的 token 仍在',
    Object.values(data.tokens || {}).some(t => t.roomCode === 'FRSH') &&
    Object.values(data.tokens || {}).some(t => t.roomCode === 'LOBB'));

  // ---------- 2. 首页历史与失效 token ----------
  const q = client();
  await q.opened;
  q.send({ type: 'history', tokens: [prep.tStale0.tok, prep.tFresh0.tok, 'dead-token'] });
  await q.waitFor(c => c.msgs.some(m => m.type === 'history'));
  const entries = q.msgs.find(m => m.type === 'history').entries;
  check('历史只返回保留期内房间，失效条目静默消失',
    entries.length === 1 && entries[0].code === 'FRSH');

  const dead = client();
  await dead.opened;
  dead.send({ type: 'reconnect', token: prep.tStale1.tok });
  await dead.waitFor(c => c.msgs.some(m => m.type === 'error'));
  check('超期房间旧 token 重连被拒（带 reconnect 上下文）',
    dead.msgs.some(m => m.type === 'error' && m.context === 'reconnect'));
  dead.ws.close();

  const sp = client();
  await sp.opened;
  sp.send({ type: 'spectate', name: '路人', roomCode: 'STAL' });
  await sp.waitFor(c => c.msgs.some(m => m.type === 'error'));
  check('超期房间无法再观战',
    sp.msgs.some(m => m.type === 'error' && /房间不存在/.test(m.message)));
  sp.ws.close();

  const lb = client();
  await lb.opened;
  lb.send({ type: 'reconnect', token: prep.tLobby.tok });
  await lb.waitFor(c => c.state && c.state.phase === 'lobby');
  check('大厅房仍可凭 token 重返', lb.state.code === 'LOBB');
  lb.ws.close();

  const back = client();
  await back.opened;
  back.send({ type: 'reconnect', token: prep.tFresh0.tok });
  await back.waitFor(c => c.state && c.state.phase === 'ended');
  check('保留期内房间可凭 token 回看结算', !!back.state.scores);
  back.send({ type: 'replay' });
  await back.waitFor(c => c.msgs.some(m => m.type === 'replay'));
  check('保留期内房间回放日志完整',
    back.msgs.find(m => m.type === 'replay').frames.length >= 5);
  back.ws.close();

  // ---------- 3. 删房前确认赛季已计入：漏记的局先补记再删 ----------
  // 启动清理在删除房间前同步刷过赛季文件，此刻读取即可，无需再等防抖。
  const seasonRaw = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  check('【bug 回归】漏记赛季的超期局删房前已补记：两名玩家各 3 场（stale+old2+fresh）',
    seasonRaw.players[PID_A].games === 3 && seasonRaw.players[PID_B].games === 3);
  check('【bug 回归】被删的 stale 局在逐局索引里留下计入凭据',
    Object.prototype.hasOwnProperty.call(seasonRaw.recordedRooms, game.roomKey(prep.stale.room)));
  check('普通超期局 old2 与保留局 fresh 的索引也在',
    Object.prototype.hasOwnProperty.call(seasonRaw.recordedRooms, game.roomKey(prep.old2.room)) &&
    Object.prototype.hasOwnProperty.call(seasonRaw.recordedRooms, game.roomKey(prep.fresh.room)));
  check('大厅房不在逐局索引中',
    !Object.prototype.hasOwnProperty.call(seasonRaw.recordedRooms, game.roomKey(prep.lobby)));

  q.send({ type: 'leaderboard', sort: 'total' });
  await q.waitFor(c => c.msgs.some(m => m.type === 'leaderboard'));
  const rows = q.msgs.filter(m => m.type === 'leaderboard').at(-1).rows;
  const rowA = rows.find(r => r.pid === PID_A);
  const rowB = rows.find(r => r.pid === PID_B);
  check('排行榜与个人页包含补记的场次：两名玩家各 3 场',
    rowA && rowB && rowA.games === 3 && rowB.games === 3);
  // 三局总分精确等于离线重算（确认补记局的分数也在，而不只是场次 +1）
  const expectedA = [prep.stale, prep.old2, prep.fresh]
    .reduce((sum, b) => sum + game.computeScores(b.room).find(s => s.playerId === b.p0).total, 0);
  const expectedB = [prep.stale, prep.old2, prep.fresh]
    .reduce((sum, b) => sum + game.computeScores(b.room).find(s => s.playerId === b.p1).total, 0);
  check('补记局的得分精确计入总分',
    rowA.totalScore === expectedA && rowB.totalScore === expectedB);
  q.ws.close();

  // ---------- 4. 运行期周期清理 + 连接保护 ----------
  // 保留期仅 5 秒。打一局后保持两名玩家一直在线，等过保留期（跨多个 100ms 清理周期）：
  // 到点但仍有人看结算/回放的房间不得被强删；两人断开后，下一个周期才删除。
  const live = await playLiveGame();
  // 等到超过保留期，两名玩家的连接始终保持
  await sleep(5 * 1000 + 500);
  const peek = client();
  await peek.opened;
  peek.send({ type: 'history', tokens: [live.tokenHost] });
  await peek.waitFor(c => c.msgs.some(m => m.type === 'history'));
  check('到点房间仍有连接时保留（不打断看结算/回放的人）',
    peek.msgs.find(m => m.type === 'history').entries.some(e => e.code === live.code));
  peek.ws.close();

  // 所有人断开后，下一轮周期清理删除房间与 token
  live.host.ws.close();
  live.mate.ws.close();
  await sleep(1000); // 若干个 100ms 清理周期
  const after = client();
  await after.opened;
  after.send({ type: 'history', tokens: [live.tokenHost, live.tokenMate] });
  await after.waitFor(c => c.msgs.some(m => m.type === 'history'));
  check('断开后超过保留期的房间被运行期清理（历史条目消失）',
    after.msgs.find(m => m.type === 'history').entries.length === 0);
  const prunedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  check('运行期清理已落盘（存档中不再有该房间及其 token）',
    !prunedData.rooms.some(r => r.code === live.code) &&
    !Object.values(prunedData.tokens).some(t => t.roomCode === live.code));

  // 赛季战绩不受运行期删房影响：本局在结束时已计入（此前 3 场 + 本局 = 4 场）
  after.send({ type: 'leaderboard', sort: 'total' });
  await after.waitFor(c => c.msgs.some(m => m.type === 'leaderboard'));
  const rowsAfter = after.msgs.filter(m => m.type === 'leaderboard').at(-1).rows;
  check('运行期删房后赛季战绩仍保留（甲、乙各 4 场）',
    rowsAfter.find(r => r.pid === PID_A)?.games === 4 &&
    rowsAfter.find(r => r.pid === PID_B)?.games === 4);
  const seasonAfter = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  check('运行期删房后逐局索引仍完整（4 局凭据都在）',
    Object.keys(seasonAfter.recordedRooms).length === 4);
  after.ws.close();

  await stopServer();
}

(async () => {
  let exitCode = 0;
  try {
    await main();
    if (failures !== 0) exitCode = 1;
  } catch (e) {
    console.error('保留期测试异常:', e.stack || e.message);
    exitCode = 1;
  } finally {
    try { fs.rmSync(DATA_FILE, { force: true }); } catch { /* 忽略 */ }
    try { fs.rmSync(SEASON_FILE, { force: true }); } catch { /* 忽略 */ }
  }
  console.log(exitCode === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(exitCode);
})();
