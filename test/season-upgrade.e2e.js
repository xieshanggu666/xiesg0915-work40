'use strict';
// 旧版赛季档（v1，无逐局索引）升级测试：
// - 加载 v1 档案时给现存结束房补登索引，但玩家汇总一场都不能重复累计；
// - 之后的清理一律以索引为准：v1 时代的结束房到点删除时不再被"补记"第二遍；
// - 而 v1 存档里没有的、真正漏记的结束房（赛季写盘丢失场景）仍会在删房前被补回。
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_FILE = path.join(os.tmpdir(), `wt-upgrade-${process.pid}-${Date.now()}.json`);
const SEASON_FILE = path.join(os.tmpdir(), `wt-upgrade-season-${process.pid}-${Date.now()}.json`);
process.env.WT_DATA_FILE = DATA_FILE;
process.env.WT_SEASON_FILE = SEASON_FILE;
process.env.WT_ROOM_TTL_MS = String(60 * 60 * 1000); // 保留期 1 小时
process.env.WT_ROOM_PRUNE_INTERVAL_MS = String(3600 * 1000);
process.env.WT_SEASON_MS = '0'; // 关闭赛季自动切换：本文件只验证 v1→新版的索引对账

const game = require('../game');
const seasonLib = require('../season');
const crypto = require('crypto');

const SECRET_A = '6'.repeat(64);
const SECRET_B = '7'.repeat(64);
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
  // 两间超期旧局：都是 v1 时代结束、战绩已手工累计进玩家汇总的历史对局
  const now = Date.now();
  const r1 = buildEndedRoom('OLD1'); r1.room.endedAt = now - 2 * 3600 * 1000;
  const r2 = buildEndedRoom('OLD2'); r2.room.endedAt = now - 3 * 3600 * 1000;
  // 第三间同样超期，但故意不计入玩家汇总——模拟赛季写盘丢失（v1 档本身无法表达索引，
  // 对账只认"现存结束房"，这间也会被登记索引……要模拟漏记，需在升级后才让它出现：
  // 改由"升级完成后再写入房间档并第二次启动"覆盖，见下方第二步）。
  const fresh = buildEndedRoom('KEEP'); fresh.room.endedAt = now - 1000;

  const token = (room, pid) => [crypto.randomBytes(16).toString('hex'), { roomCode: room.code, playerId: pid }];
  const [t1, ref1] = token(r1.room, r1.p0);
  const [t2, ref2] = token(r2.room, r2.p0);
  const [tf, reff] = token(fresh.room, fresh.p0);
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    rooms: [r1.room, r2.room, fresh.room],
    tokens: { [t1]: ref1, [t2]: ref2, [tf]: reff },
  }));

  // v1 赛季档：玩家各有 2 场（OLD1+OLD2 已累计；KEEP 这局也已累计）。无 version、无索引。
  const v1season = {
    startedAt: now - 100 * 86400 * 1000,
    players: {
      [PID_A]: { pid: PID_A, name: '甲', games: 3, wins: 3, ties: 0, totalScore: 999, bestChain: 9, lastAt: now },
      [PID_B]: { pid: PID_B, name: '乙', games: 3, wins: 0, ties: 0, totalScore: 333, bestChain: 4, lastAt: now },
    },
  };
  fs.writeFileSync(SEASON_FILE, JSON.stringify(v1season));

  const { startServer, stopServer } = require('../server');
  const srv = await startServer(0);
  BASE_URL = `ws://localhost:${srv.port}`;
  await sleep(500); // 等对账落盘（flushSeason 同步，多等一轮房间防抖）

  // 赛季文件已升级到 v3：仍是第 1 赛季，三间现存结束房都在索引里，玩家汇总保持 3 场不重算
  const upgraded = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  check('赛季档升级为 v3（第 1 赛季）且建立逐局索引', upgraded.version === 3 &&
    upgraded.season === 1 &&
    Object.keys(upgraded.recordedRooms).length === 3);
  check('历史对局只登记索引、不重复累计战绩',
    upgraded.players[PID_A].games === 3 && upgraded.players[PID_A].totalScore === 999 &&
    upgraded.players[PID_B].games === 3 && upgraded.players[PID_B].totalScore === 333);
  check('超期旧局与保留局都在索引中',
    game.roomKey(r1.room) in upgraded.recordedRooms &&
    game.roomKey(r2.room) in upgraded.recordedRooms &&
    game.roomKey(fresh.room) in upgraded.recordedRooms);
  // 超期旧局本轮即被删除（保留期 1 小时）
  const roomsAfter = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  check('v1 时代的超期房照常清理',
    !roomsAfter.rooms.some(r => r.code === 'OLD1' || r.code === 'OLD2'));
  check('清理 v1 历史房没有把战绩再算一遍（仍各 3 场）',
    upgraded.players[PID_A].games === 3);

  // 排行榜确认
  const q = client();
  await q.opened;
  q.send({ type: 'leaderboard', sort: 'total' });
  await q.waitFor(c => c.msgs.some(m => m.type === 'leaderboard'));
  const rows = q.msgs.filter(m => m.type === 'leaderboard').at(-1).rows;
  check('排行榜仍是升级前的汇总',
    rows.find(r => r.pid === PID_A)?.games === 3 &&
    rows.find(r => r.pid === PID_A)?.totalScore === 999);
  q.ws.close();

  await stopServer();

  // 第二步：升级后的档案里再混入一间"标记残留、索引缺失"的超期房（真正的漏记局）。
  // 此时赛季档已是 v2，清理必须按索引发现它没计过 → 补记（各 +1 场）后再删。
  const lost = buildEndedRoom('LOST');
  lost.room.endedAt = Date.now() - 5 * 3600 * 1000;
  lost.room.seasonRecorded = true; // 内存标记残留为真
  const data2 = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  data2.rooms.push(lost.room);
  const [tl, refl] = token(lost.room, lost.p0);
  data2.tokens[tl] = refl;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data2));

  const srv2 = await startServer(0);
  BASE_URL = `ws://localhost:${srv2.port}`;
  await sleep(500);
  const recovered = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  check('漏记局删房前被补记（甲、乙各 4 场）',
    recovered.players[PID_A].games === 4 && recovered.players[PID_B].games === 4);
  check('漏记局在索引中留痕', game.roomKey(lost.room) in recovered.recordedRooms);
  const data2after = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  check('漏记局补记后房间照常删除',
    !data2after.rooms.some(r => r.code === 'LOST') &&
    !Object.values(data2after.tokens).some(t => t.roomCode === 'LOST'));
  await srv2.stop();
}

(async () => {
  let exitCode = 0;
  try {
    await main();
    if (failures !== 0) exitCode = 1;
  } catch (e) {
    console.error('升级测试异常:', e.stack || e.message);
    exitCode = 1;
  } finally {
    try { fs.rmSync(DATA_FILE, { force: true }); } catch { /* 忽略 */ }
    try { fs.rmSync(SEASON_FILE, { force: true }); } catch { /* 忽略 */ }
  }
  console.log(exitCode === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(exitCode);
})();
