'use strict';
// 回归测试：启动对账补记后"赛季落盘失败"时，绝不能继续清理超期房间。
//
// 缺陷场景（修复前）：loadRooms 先 reconcileRecordedRooms() 再 pruneExpiredRooms()。
// 对账把漏记局放进【内存】索引（isRoomRecorded 变真、room.seasonRecorded=true），却忽略
// flushSeason() 的成败；若此刻落盘失败，紧随其后的过期清理只查内存索引，误把这局当作
// "已持久化"而直接删房——磁盘赛季文件里从没有它，进程一旦退出，榜单永久缺场。
//
// 忠实复现要点（同一进程内内存赛季会掩盖问题，必须模拟"带故障停机后重启"）：
//  - 只让【赛季文件】的原子 rename 失败（房间文件照写），使启动对账的补记只停在内存；
//  - 让旧逻辑的删房决定真正落进房间存档（等过 300ms 防抖），随后在"赛季仍写不进"时
//    停服（等价于故障中进程被杀）；
//  - 解除故障后全新启动：若删房时未持久化的局已被删，重启再也找不到它 → 永久缺场。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const stamp = `${process.pid}-${Date.now()}`;
const DATA_FILE = path.join(os.tmpdir(), `wt-recon-rooms-${stamp}.json`);
const SEASON_FILE = path.join(os.tmpdir(), `wt-recon-season-${stamp}.json`);
process.env.WT_DATA_FILE = DATA_FILE;
process.env.WT_SEASON_FILE = SEASON_FILE;
process.env.WT_ROOM_TTL_MS = String(5000);          // 保留期 5 秒：两个房都已超期
process.env.WT_ROOM_PRUNE_INTERVAL_MS = String(150); // 短周期
process.env.WT_SEASON_MS = '0';                     // 关闭自动切赛季

const game = require('../game');
const seasonLib = require('../season');

const SECRET_A = 'e'.repeat(64);
const SECRET_B = 'f'.repeat(64);
const PID_A = seasonLib.resolvePid({ pidSecret: SECRET_A }).pid;
const PID_B = seasonLib.resolvePid({ pidSecret: SECRET_B }).pid;

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  room.endedAt = Date.now() - 10000; // 明显超过保留期
  return room;
}

function readSeason() { return JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
function endedCodesOnDisk() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    .rooms.filter(r => r.phase === 'ended').map(r => r.code);
}

// 只让赛季文件的 rename 失败（原子写最后一步），其他存档照常落盘。
// writeJsonAtomic 把 tmp rename 到目标路径，目标为 SEASON_FILE 时抛 ENOSPC。
function installSeasonRenameFault() {
  const realRename = fs.renameSync;
  fs.renameSync = function (tmp, target) {
    if (String(target) === SEASON_FILE) {
      throw Object.assign(new Error('simulated ENOSPC (season rename)'), { code: 'ENOSPC' });
    }
    return realRename.call(this, tmp, target);
  };
  return () => { fs.renameSync = realRename; };
}

async function main() {
  const unrec = buildEndedRoom('UNRC'); // 漏记局：磁盘赛季索引里没有
  const recd = buildEndedRoom('RECD');  // 对照局：磁盘赛季里已计入（真正持久化）

  const season = seasonLib.emptySeason();
  seasonLib.recordRoom(season, recd);
  fs.mkdirSync(path.dirname(SEASON_FILE), { recursive: true });
  fs.writeFileSync(SEASON_FILE, JSON.stringify(season));
  fs.writeFileSync(DATA_FILE, JSON.stringify({ rooms: [unrec, recd], tokens: {} }));

  const restore = installSeasonRenameFault(); // 赛季写盘全程失败（本阶段 + 停服）
  const { startServer, stopServer } = require('../server');
  const srv = await startServer(0);
  await sleep(450); // 等过 300ms 房间防抖落盘

  // ---------- 故障期间：未持久化的超期房绝不能从房间存档消失，赛季档也不被改写 ----------
  const codesDuringFault = endedCodesOnDisk();
  check('赛季落盘失败：漏记超期房 UNRC 被保留在房间存档', codesDuringFault.includes('UNRC'));
  const seasonDuringFault = readSeason();
  check('故障期间漏记局未进赛季文件（索引仍只有 RECD）',
    Object.keys(seasonDuringFault.recordedRooms).length === 1 &&
    !Object.prototype.hasOwnProperty.call(seasonDuringFault.recordedRooms, game.roomKey(unrec)));
  check('故障期间玩家场次仍为 1（漏记局未落盘）',
    seasonDuringFault.players[PID_A].games === 1 &&
    seasonDuringFault.players[PID_B].games === 1);

  // 在"赛季仍写不进"时停服（等价于故障中进程被杀）：stopServer 的赛季 flush 也失败，
  // 磁盘赛季保持只有 1 局；房间存档的去留完全由前面的清理是否安全决定。
  await stopServer();
  restore(); // 进程已停，解除故障

  // ---------- 全新启动（健康磁盘）：安全实现应找回漏记局，永久缺场则暴露缺陷 ----------
  await startServer(srv.port);
  await sleep(400); // 启动对账补记落盘 → 随后清理才删超期房

  const seasonAfter = readSeason();
  check('重启后漏记局被找回：逐局索引恰为 2 条（不丢、不重）',
    Object.keys(seasonAfter.recordedRooms).length === 2 &&
    Object.prototype.hasOwnProperty.call(seasonAfter.recordedRooms, game.roomKey(unrec)) &&
    Object.prototype.hasOwnProperty.call(seasonAfter.recordedRooms, game.roomKey(recd)));
  check('重启后两局各计一次：甲乙各 2 场（榜单不永久缺场、不重复计分）',
    seasonAfter.players[PID_A].games === 2 && seasonAfter.players[PID_B].games === 2);
  // 健康落盘后，超期房才允许被清理（此时两局战绩都已确认持久化）
  const codesAfter = endedCodesOnDisk();
  check('战绩落盘后超期房才被删除', codesAfter.length === 0);

  await stopServer();
}

(async () => {
  let exitCode = 0;
  try {
    await main();
    if (failures !== 0) exitCode = 1;
  } catch (e) {
    console.error('启动对账落盘失败回归测试异常:', e.stack || e.message);
    exitCode = 1;
  } finally {
    for (const f of [DATA_FILE, SEASON_FILE]) {
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
