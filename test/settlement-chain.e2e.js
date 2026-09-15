'use strict';
// 可恢复结算链路端到端测试（不依赖运行期周期任务，全部用"造存档→真正启停服务器"验证）：
// 1. 重启补记：一局结束后、赛季防抖落盘前被杀（房间在、赛季索引没有），重启时启动对账
//    立即把它补记进赛季并原子落盘——不需要等房间过期，也不需要任何人重连看结算；
// 2. 重复计分防护：同一局经历 重连广播 / 多次重启 / 赛季切换 后，玩家场次与索引条数始终为 1；
// 3. 跨赛季切换的补记归属：跨赛季边界后重启，漏记的老对局先进老赛季并随冻结归档，
//    新赛季从零累计，绝不把老局算进新赛季；
// 4. 房间生命周期不破坏榜单：保留期内的房间被删（清理）后，赛季战绩一行不少；
// 5. 原子落盘：磁盘上的赛季/房间文件始终是完整 JSON，临时文件不留痕。
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stamp = `${process.pid}-${Date.now()}`;
const DATA_FILE = path.join(os.tmpdir(), `wt-settle-rooms-${stamp}.json`);
const SEASON_FILE = path.join(os.tmpdir(), `wt-settle-season-${stamp}.json`);
// 场景 4 的短保留期独立实例文件（在 main 内赋值，finally 清理时引用）
let SHORT_DATA = '';
let SHORT_SEASON = '';
process.env.WT_DATA_FILE = DATA_FILE;
process.env.WT_SEASON_FILE = SEASON_FILE;
process.env.WT_ROOM_TTL_MS = String(365 * 24 * 60 * 60 * 1000); // 长期保留；删房场景另走专用实例
process.env.WT_ROOM_PRUNE_INTERVAL_MS = String(3600 * 1000);    // 不依赖周期任务
process.env.WT_SEASON_MS = String(1000);                        // 赛季 1 秒，便于跨边界

const game = require('../game');
const seasonLib = require('../season');
const crypto = require('crypto');

const SECRET_A = 'c'.repeat(64);
const SECRET_B = 'd'.repeat(64);
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

// 离线用纯逻辑状态机打完一局（2 人、1 回合/人、轮流空过）
function buildEndedRoom(code) {
  const p0 = crypto.randomBytes(8).toString('hex');
  const p1 = crypto.randomBytes(8).toString('hex');
  const room = game.newRoom(code, p0, '甲');
  game.addPlayer(room, p0, '甲', PID_A);
  game.addPlayer(room, p1, '乙', PID_B);
  game.setRuleSet(room, p0, { rounds: 1, turnSeconds: 300 });
  game.startGame(room, p0, () => 0.5);
  game.endTurn(room, room.turn.playerId);
  game.endTurn(room, room.turn.playerId);
  if (room.phase !== 'ended') throw new Error('测试房未正常结束');
  return { room, p0, p1 };
}
function makeToken(roomCode, playerId) {
  return { tok: crypto.randomBytes(16).toString('hex'), ref: { roomCode, playerId } };
}
function writeArchive(rooms, tokens) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify({ rooms, tokens }));
}
function readSeason() { return JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
function gamesOf(seasonRaw, pid) {
  return seasonRaw.players[pid] ? seasonRaw.players[pid].games : 0;
}

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
  return { code: host.state.code, host, mate };
}

async function main() {
  const { startServer, stopServer } = require('../server');

  // ---------- 场景 1：重启补记（防抖窗口内被杀，房间在但赛季索引没有） ----------
  const now = Date.now();
  const missed = buildEndedRoom('MISS');
  missed.room.endedAt = now - 1000;
  missed.room.seasonRecorded = true; // 内存痕迹残留为真，但赛季文件里没有这局
  const tm0 = makeToken('MISS', missed.p0);
  const tm1 = makeToken('MISS', missed.p1);
  writeArchive([missed.room], Object.fromEntries([[tm0.tok, tm0.ref], [tm1.tok, tm1.ref]]));
  // 空赛季档案（v3），刚开始（1 秒赛季窗口内），索引里故意没有 MISS
  fs.writeFileSync(SEASON_FILE, JSON.stringify(seasonLib.emptySeason(now)));

  let srv = await startServer(0);
  BASE_URL = `ws://localhost:${srv.port}`;
  await sleep(100);
  // 启动对账已同步落盘：无需任何连接、无需等过期，榜单立刻完整
  let sRaw = readSeason();
  check('重启补记：漏记的局在启动时即计入（甲乙各 1 场）',
    gamesOf(sRaw, PID_A) === 1 && gamesOf(sRaw, PID_B) === 1);
  check('重启补记：逐局索引登记了该局凭据',
    Object.prototype.hasOwnProperty.call(sRaw.recordedRooms, game.roomKey(missed.room)));

  // ---------- 场景 2：重连广播 / 多次重启 / 切赛季都不重复计分 ----------
  // 2a. 持 token 重连结算房会触发广播，recordRoom 必须按索引短路
  const rc = client();
  await rc.opened;
  rc.send({ type: 'reconnect', token: tm0.tok });
  await rc.waitFor(c => c.state && c.state.phase === 'ended');
  await sleep(400); // 等防抖（即便有写）落盘
  sRaw = readSeason();
  check('重连结算广播不重复计分（仍各 1 场，索引仍 1 条）',
    gamesOf(sRaw, PID_A) === 1 && gamesOf(sRaw, PID_B) === 1 &&
    Object.keys(sRaw.recordedRooms).length === 1);
  rc.ws.close();

  // 2b. 再重启一次（房间仍在保留期内）
  await stopServer();
  srv = await startServer(srv.port);
  await sleep(150);
  sRaw = readSeason();
  check('第二次重启不重复计分（各 1 场，索引 1 条）',
    gamesOf(sRaw, PID_A) === 1 && gamesOf(sRaw, PID_B) === 1 &&
    Object.keys(sRaw.recordedRooms).length === 1);

  // 2c. 等赛季到期后打开排行榜触发惰性切换，老对局随冻结归档、新赛季清零
  await sleep(1000);
  const lb = client();
  await lb.opened;
  lb.send({ type: 'leaderboard', sort: 'total' });
  await lb.waitFor(c => c.msgs.some(m => m.type === 'leaderboard' && m.season === 2));
  await sleep(100);
  sRaw = readSeason();
  check('赛季切换：当前为第 2 赛季且玩家汇总清零', sRaw.season === 2 && !sRaw.players[PID_A]);
  check('赛季切换：老对局冻结进历史第 1 赛季（各 1 场、带名次）',
    sRaw.history[0] && sRaw.history[0].season === 1 &&
    sRaw.history[0].players[PID_A] && sRaw.history[0].players[PID_A].games === 1 &&
    typeof sRaw.history[0].players[PID_A].rank === 'number');
  check('赛季切换：跨赛季全局索引原样保留（仍是 1 条，不清空）',
    Object.keys(sRaw.recordedRooms).length === 1);
  // 老房间重连一次：绝不能在新赛季再算一遍
  const rc2 = client();
  await rc2.opened;
  rc2.send({ type: 'reconnect', token: tm1.tok });
  await rc2.waitFor(c => c.state && c.state.phase === 'ended');
  await sleep(400);
  sRaw = readSeason();
  check('切换后重连老对局不在新赛季重复计分（新赛季无该玩家，索引仍 1 条）',
    !sRaw.players[PID_A] && Object.keys(sRaw.recordedRooms).length === 1);
  rc2.ws.close();
  lb.ws.close();

  // ---------- 场景 3：跨赛季边界后重启，漏记的老对局归属老赛季 ----------
  // 停服，造一个"上一赛季结束、但索引里漏记"的结束房（模拟在第 1 赛季窗口末尾打完、
  // 防抖未落盘就停机，跨过了切换时刻才重启）。
  await stopServer();
  const boundary = buildEndedRoom('BNDR');
  // 当前磁盘是"第 2 赛季进行中"，其 startedAt 即第 2 赛季窗口起点。
  const season2Start = readSeason().startedAt;
  // 第 2 赛季窗口内结束、却漏记的对局（窗口末尾打完、防抖未落盘就停机）。
  boundary.room.endedAt = season2Start + 500;
  const tb0 = makeToken('BNDR', boundary.p0);
  // 把第 2 赛季 startedAt 拨到很久以前，制造"停机跨过第 2 赛季切换时刻才重启"。
  const onDisk = readSeason();
  onDisk.startedAt = Date.now() - 5000; // 第 2 赛季窗口已结束 → 启动即应再切一次
  fs.writeFileSync(SEASON_FILE, JSON.stringify(onDisk));
  writeArchive([boundary.room], Object.fromEntries([[tb0.tok, tb0.ref]]));

  srv = await startServer(srv.port);
  await sleep(150);
  sRaw = readSeason();
  // 启动顺序"先补记、后切换"：BNDR 必须先补进即将冻结的第 2 赛季，再随冻结归档，
  // 绝不能被算到全新的第 3 赛季里。
  check('跨边界重启：当前已推进到第 3 赛季', sRaw.season === 3);
  const frozen2 = (sRaw.history || []).find(h => h.season === 2);
  check('跨边界重启：漏记局在冻结前补进第 2 赛季（甲乙各计 1 场）',
    frozen2 && frozen2.players[PID_A] && frozen2.players[PID_A].games === 1 &&
    frozen2.players[PID_B] && frozen2.players[PID_B].games === 1);
  check('跨边界重启：漏记局没有被算进全新的第 3 赛季',
    !sRaw.players[PID_A] && !sRaw.players[PID_B]);
  check('跨边界重启：全局索引含两局（MISS + BNDR），无任何一局双计',
    Object.keys(sRaw.recordedRooms).length === 2 &&
    Object.prototype.hasOwnProperty.call(sRaw.recordedRooms, game.roomKey(boundary.room)));

  // ---------- 场景 4：删房不影响榜单（保留期清理删房前已确认索引，删后战绩一行不少） ----------
  // 走一个短保留期的独立存档实例：先让服务器把两局计入，再停服把房间拨成超期，
  // 重启时启动清理删房（删房前必须先确认/补记赛季），验证删房不丢战绩。
  await stopServer();
  const shortStamp = `${process.pid}-${Date.now()}-short`;
  SHORT_DATA = path.join(os.tmpdir(), `wt-settle-short-rooms-${shortStamp}.json`);
  SHORT_SEASON = path.join(os.tmpdir(), `wt-settle-short-season-${shortStamp}.json`);
  process.env.WT_DATA_FILE = SHORT_DATA;
  process.env.WT_SEASON_FILE = SHORT_SEASON;
  delete require.cache[require.resolve('../server')];
  process.env.WT_ROOM_TTL_MS = String(50);
  const s2 = require('../server');
  const srvShort = await s2.startServer(0);
  BASE_URL = `ws://localhost:${srvShort.port}`;
  const live = await playLiveGame(); // 结束即计入（甲乙在这个空档里各 1 场）
  await sleep(400); // 等防抖落盘
  await s2.stopServer();
  // 把房间拨成超期，赛季档保持已计入
  const arch = JSON.parse(fs.readFileSync(SHORT_DATA, 'utf8'));
  const t = Date.now() - 60 * 60 * 1000;
  arch.rooms.forEach(r => { if (r.phase === 'ended') r.endedAt = t; });
  fs.writeFileSync(SHORT_DATA, JSON.stringify(arch));
  await s2.startServer(srvShort.port); // 启动清理：删超期房（索引已在，不应补记/双计）
  await sleep(300);
  const prunedRooms = JSON.parse(fs.readFileSync(SHORT_DATA, 'utf8')).rooms
    .filter(r => r.phase === 'ended');
  check('超期房间已被清理', !prunedRooms.some(r => r.code === live.code));
  const shortSeason = JSON.parse(fs.readFileSync(SHORT_SEASON, 'utf8'));
  check('删房后赛季战绩一行不少（甲乙各 1 场，索引 1 条）',
    gamesOf(shortSeason, PID_A) === 1 && gamesOf(shortSeason, PID_B) === 1 &&
    Object.keys(shortSeason.recordedRooms).length === 1);

  // 优雅停机：刚结束（防抖窗口内）就停服，stopServer 同步原子落盘房间与战绩
  const live2 = await playLiveGame();
  await s2.stopServer(); // 立即停，逼出 stop 内的 flush 路径（不等 300ms 防抖）
  const diskRooms = JSON.parse(fs.readFileSync(SHORT_DATA, 'utf8'));
  const diskSeason = JSON.parse(fs.readFileSync(SHORT_SEASON, 'utf8'));
  check('优雅停机：刚结束的对局房间已落盘', diskRooms.rooms.some(r => r.code === live2.code));
  check('优雅停机：刚结束的对局战绩已同步计入（索引 2 条）',
    Object.keys(diskSeason.recordedRooms).length === 2);
  // 再重启，确认不双计
  await s2.startServer(srvShort.port);
  await sleep(150);
  const reSeason = JSON.parse(fs.readFileSync(SHORT_SEASON, 'utf8'));
  check('停机后重启：两局各计一次、无重复计分（甲乙各 2 场，索引 2 条）',
    gamesOf(reSeason, PID_A) === 2 && gamesOf(reSeason, PID_B) === 2 &&
    Object.keys(reSeason.recordedRooms).length === 2);
  await s2.stopServer();

  // ---------- 场景 5：落盘文件始终是完整 JSON，无临时文件残留 ----------
  for (const f of [SEASON_FILE, DATA_FILE, SHORT_SEASON, SHORT_DATA]) {
    if (!fs.existsSync(f)) continue;
    let parsed = false;
    try { JSON.parse(fs.readFileSync(f, 'utf8')); parsed = true; } catch { /* */ }
    check(`原子落盘：${path.basename(f)} 是完整 JSON`, parsed);
    const leftovers = fs.readdirSync(path.dirname(f))
      .filter(n => n.startsWith(`.${path.basename(f)}.`) && n.endsWith('.tmp'));
    check(`原子落盘：${path.basename(f)} 无临时文件残留`, leftovers.length === 0);
  }
}

(async () => {
  let exitCode = 0;
  try {
    await main();
    if (failures !== 0) exitCode = 1;
  } catch (e) {
    console.error('结算链路测试异常:', e.stack || e.message);
    exitCode = 1;
  } finally {
    const files = [DATA_FILE, SEASON_FILE];
    try { files.push(SHORT_DATA, SHORT_SEASON); } catch { /* 未定义时忽略 */ }
    for (const f of files) {
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
