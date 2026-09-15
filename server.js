'use strict';
// 词语领地服务器：HTTP 静态文件 + WebSocket 实时同步 + 磁盘持久化。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const game = require('./game');
const seasonLib = require('./season');
const tournamentLib = require('./tournament');
const sharesLib = require('./public/shares');
const plazaLib = require('./public/plaza');

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
// 测试可用 WT_DATA_FILE 指定独立存档，避免污染开发用的 data/rooms.json
const DATA_FILE = process.env.WT_DATA_FILE
  ? path.resolve(process.env.WT_DATA_FILE)
  : path.join(DATA_DIR, 'rooms.json');
// 赛季战绩单独落盘（与房间存档解耦）；测试可用 WT_SEASON_FILE 指向临时文件
const SEASON_FILE = process.env.WT_SEASON_FILE
  ? path.resolve(process.env.WT_SEASON_FILE)
  : path.join(DATA_DIR, 'season.json');
// 词包分享码单独落盘：{ [分享码]: { code,pid,packId,pack 快照,updatedAt } }。
// 与房间/赛季解耦——分享不依赖任何对局存在，作者取消后码立即作废；
// 测试可用 WT_SHARES_FILE 指向临时文件。
const SHARES_FILE = process.env.WT_SHARES_FILE
  ? path.resolve(process.env.WT_SHARES_FILE)
  : path.join(DATA_DIR, 'shares.json');
// 交流广场单独落盘：{ [广场id]: { id,pid,packId,author,pack 快照,subs,publishedAt,updatedAt } }。
// 与房间/赛季/分享码解耦——广场条目不依赖任何对局存在，作者下架后立即从广场消失；
// 测试可用 WT_PLAZA_FILE 指向临时文件。
const PLAZA_FILE = process.env.WT_PLAZA_FILE
  ? path.resolve(process.env.WT_PLAZA_FILE)
  : path.join(DATA_DIR, 'plaza.json');
// 跨房间赛事单独落盘：{ tournaments: { [tm_id]: 赛事状态机 } }。与房间/赛季解耦——
// 赛事只引用对局房间码与公开 pid，对局战绩仍走赛季自己的逐局索引；赛事完赛/取消
// 超保留期后单独清理，删赛事不影响赛季榜单。测试可用 WT_TOURNAMENT_FILE 指向临时文件。
const TOURNAMENT_FILE = process.env.WT_TOURNAMENT_FILE
  ? path.resolve(process.env.WT_TOURNAMENT_FILE)
  : path.join(DATA_DIR, 'tournaments.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 原子落盘 ----------
// 结算链路的核心不变量是"逐局计入索引 recordedRooms 与玩家汇总同档共存"：索引在，
// 战绩就在；文件若在一次写盘途中被截断（进程被杀/磁盘写满），重启后会读到半个 JSON，
// loadSeason 兜底成空赛季会让全部结束房"漏记"——保留期内补记回来但保留期外的局直接丢，
// 且索引丢失会让还在保留期内的局被再算一遍（重复计分）。所有存档因此一律走
// "临时文件 + fsync + rename"：同目录下 rename 在 POSIX/Windows 上都是原子的，
// 任何时刻磁盘上要么是完整旧文件、要么是完整新文件，不会留下半个 JSON。
// 写盘失败会抛出，调用方（删房/冻结前的同步 flush）据此中止后续动作，绝不"先删后记"。
function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  let ok = false;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd); // 内容先落盘，rename 后崩溃也不会只剩一个空壳新文件
    try { fs.closeSync(fd); } catch { /* 关闭错误不影响 rename */ }
    fd = undefined;
    fs.renameSync(tmp, file);
    ok = true;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 已落盘则忽略关闭错误 */ } }
    // rename 失败（磁盘满/权限）时主动清掉临时文件：防抖重试与周期重试会反复创建，
    // 不清会在故障期间堆积一串 .tmp。rename 已成功（ok）时文件已不存在，rm 忽略即可。
    if (!ok) { try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略清理错误 */ } }
  }
}

// 读取并解析一份 JSON 存档。文件不存在返回 null（首次启动）；内容损坏（原子写之后仍可能
// 因人工编辑/磁盘故障损坏）时不静默吞掉——把坏档改名留证（.corrupt-时间戳）并返回 null，
// 避免"看似首次启动"地拿空内存覆盖，导致房间/赛季整份丢失且无据可查。
function readJsonOrQuarantine(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`${label}读取失败：`, e.message);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, backup); } catch { /* 改名失败也不阻塞启动 */ }
    console.error(`${label}已损坏，已备份到 ${backup}，本次按空存档启动`);
    return null;
  }
}

// ---------- 赛季战绩存储 ----------

let season = seasonLib.emptySeason();
// 加载的赛季档案是否为没有逐局索引的旧版（v1）。旧档里的结束房视为"早已计入"，
// 只用于加载时给房间补标记；新产生的对局一律以索引为准。
let seasonLegacy = true;
// 已计入【内存】索引、但尚未确认落进磁盘赛季文件的房间 key 集合。
// 这是区分"内存里计过"与"已持久化"的唯一凭据：recordRoom 一改动内存就把 key 放进来，
// 只有 flushSeason 成功才整体清空；写盘失败时这些 key 继续挂着。房间清理绝不能只凭
// 内存索引（isRoomRecorded）就认定一局已安全落盘——启动对账补记后若 flush 失败，
// 紧接着的过期清理会把这些"只在内存里"的超期房误删，榜单因此永久缺场。
// 任何删房路径必须先确认这里为空（必要时强制 flush 并等待成功），否则整轮中止重试。
const seasonPendingRooms = new Set();

function loadSeason() {
  const raw = readJsonOrQuarantine(SEASON_FILE, '赛季战绩');
  seasonPendingRooms.clear(); // 重新以磁盘为准：磁盘里的索引条目都算已持久化，内存挂起集合清空
  if (raw === null) {
    seasonLegacy = false; // 文件不存在（首次启动）或已隔离的坏档：没有可信的"已计入"旧局
    return;
  }
  const prevVersion = Math.trunc(Number(raw && raw.version)) || 1;
  const { season: loaded, legacy } = seasonLib.normalizeSeason(raw);
  season = loaded;
  seasonLegacy = legacy;
  console.log(`已恢复赛季战绩：第 ${season.season} 赛季、` +
    `${Object.keys(season.players).length} 名玩家、${season.history.length} 个历史赛季`);
  // 旧档（v1/v2）在内存里完成了结构迁移（v3：赛季号/history），立即落盘固化：
  // 否则要等下一次战绩变化才写盘，期间若触发赛季切换，磁盘会从旧结构直接跳到
  // "已归档"状态，迁移态（老档案整体作为第 1 赛季）从未被持久化。
  if (prevVersion < seasonLib.ARCHIVE_VERSION) flushSeason();
}

// 赛季到期切换：先把【已结束但还没补记】的房间补进即将冻结的老赛季（例如跨赛季边界
// 仍在保留期内、却一直没人重连看结算的局——不能让它被算到新赛季），再冻结归档、开新赛季。
// 全局逐局索引（recordedRooms）原样保留，任何一局都不可能在两个赛季各算一遍。
// 冻结与开新赛季在同一档案里原子完成，立即同步落盘，避免"已冻结但没落盘"时进程退出。
// 任一步落盘失败都回滚内存到切换前状态并返回 false：对外仍是上一个赛季，下个周期/请求
// 会惰性重试——绝不能"内存里已开新赛季、磁盘上还是旧赛季"，否则重启会整榜重复计分。
function rolloverIfDue(now = Date.now()) {
  if (!seasonLib.seasonDue(season, SEASON_MS, now)) return false;
  let dirty = false;
  for (const room of rooms.values()) {
    if (room.phase === 'ended' && !seasonLib.isRoomRecorded(season, room)) {
      const { changed } = recordRoomPending(room, now);
      if (changed) dirty = true;
    }
  }
  // 补记先落盘（且必须成功——成功会清空待持久化集合），再冻结；写盘失败则本轮不切换、
  // 内存与挂起集合原样保留，下个周期/请求惰性重试。
  if (dirty && !flushSeason()) return false;
  // 冻结前没有挂起的 key（上一步要么没补记、要么 flush 成功清空了集合）。
  // 若冻结落盘失败需回滚内存，同时恢复挂起集合快照，保证内存=磁盘、不误删任何房间。
  const before = {
    season: season.season, startedAt: season.startedAt,
    players: season.players, history: season.history,
    pending: new Set(seasonPendingRooms),
  };
  const { rolledOver, frozen } = seasonLib.rolloverSeason(season, SEASON_MS, now);
  if (rolledOver && !flushSeason()) {
    // 冻结已在内存发生却没进磁盘：回滚，保持内存=磁盘，等待下次惰性重试。
    // 上面补记的局已成功落盘（在老赛季里），回滚不影响其正确性。
    season.season = before.season;
    season.startedAt = before.startedAt;
    season.players = before.players;
    season.history = before.history;
    seasonPendingRooms.clear();
    for (const k of before.pending) seasonPendingRooms.add(k);
    return false;
  }
  if (rolledOver) {
    if (frozen) {
      console.log(`第 ${frozen.season} 赛季已冻结归档（${Object.keys(frozen.players).length} 名玩家），` +
        `第 ${season.season} 赛季开始重新累计`);
    } else {
      console.log(`空赛季跳过归档，第 ${season.season} 赛季开始`);
    }
  }
  return rolledOver;
}

let seasonSaveTimer = null;
// 防抖落盘失败后的有限重试（指数退避）：磁盘短暂打满/瞬时 IO 错误能在几秒内自愈，
// 不必等下一小时的周期任务；连续失败到上限后停止，挂起的 key 仍留在 seasonPendingRooms，
// 由周期任务/下一次写入/删房前的强制 flush 兜底，绝不在失败时把待持久化集合清空。
let seasonSaveRetries = 0;
function scheduleSeasonWrite(delay) {
  if (shuttingDown) return;
  clearTimeout(seasonSaveTimer);
  seasonSaveTimer = setTimeout(() => {
    if (flushSeason()) {
      seasonSaveRetries = 0;
      return;
    }
    if (seasonSaveRetries < 5) {
      seasonSaveRetries += 1;
      scheduleSeasonWrite(Math.min(30000, 300 * 2 ** seasonSaveRetries));
    } else {
      seasonSaveRetries = 0; // 交给周期任务/删房前强制 flush 兜底重试
    }
  }, delay);
}
function saveSeason() {
  if (shuttingDown) return;
  seasonSaveRetries = 0;
  scheduleSeasonWrite(300);
}

// 立即落盘（停服前/删房前/冻结前调用）。原子写（临时文件 + fsync + rename），
// 返回是否成功。只有写盘【成功】才清空 seasonPendingRooms——这是"内存索引已落进磁盘"
// 的唯一确认点；失败时挂起的房间 key 原样保留，调用方（删房/切赛季）必须中止，
// 杜绝"房间删了/赛季切了，战绩却没进文件"。
function flushSeason() {
  clearTimeout(seasonSaveTimer);
  try {
    writeJsonAtomic(SEASON_FILE, season);
    seasonPendingRooms.clear();
    seasonSaveRetries = 0;
    return true;
  } catch (e) {
    console.error('赛季战绩保存失败', e);
    return false;
  }
}

// 把一局计入赛季（当前赛季），并登记到"待持久化"集合。changed=true 表示内存里新增了
// 索引条目——在 flushSeason 成功前，该 key 始终视为未落盘，房间清理必须绕开它。
// 返回 seasonLib.recordRoom 的原始结果（{ changed, recorded }）。
function recordRoomPending(room, now = Date.now()) {
  const before = game.roomKey(room);
  const res = seasonLib.recordRoom(season, room, now);
  if (res.changed) seasonPendingRooms.add(before);
  return res;
}

// 仅把一局登记进全局索引、不累计战绩（旧版 v1 档案启动对账用），同样登记待持久化集合。
function markRoomRecordedPending(room, now = Date.now()) {
  const key = game.roomKey(room);
  const changed = seasonLib.markRoomRecorded(season, room, now);
  if (changed) seasonPendingRooms.add(key);
  return changed;
}

// ---------- 词包分享码存储 ----------
// 分享与房间/赛季完全解耦：作者把本机词包快照发布到这里拿到 8 位码，
// 朋友凭码导入；作者（同一 pidSecret 派生出的 pid）可取消，码立即作废。
let shareStore = sharesLib.emptyShares();

function loadShares() {
  try {
    shareStore = sharesLib.normalizeShares(
      JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8')));
    console.log(`已恢复词包分享：${Object.keys(shareStore.shares).length} 个分享码`);
  } catch { /* 首次启动或数据损坏，从空表开始 */ }
}

let sharesSaveTimer = null;
function saveShares() {
  if (shuttingDown) return;
  clearTimeout(sharesSaveTimer);
  sharesSaveTimer = setTimeout(() => {
    try {
      writeJsonAtomic(SHARES_FILE, shareStore);
    } catch (e) { console.error('词包分享保存失败', e); }
  }, 300);
}

// 停服前立即落盘（与赛季一致，避免最后一个分享还在防抖队列里）
function flushShares() {
  clearTimeout(sharesSaveTimer);
  try {
    writeJsonAtomic(SHARES_FILE, shareStore);
  } catch (e) { console.error('词包分享保存失败', e); }
}

// ---------- 交流广场存储 ----------
// 广场与房间/赛季/分享码完全解耦：作者把本机词包快照发布到这里，
// 任何人浏览/搜索/订阅；作者（同一 pidSecret 派生出的 pid）可随时下架。
let plazaStore = plazaLib.emptyPlaza();

function loadPlaza() {
  try {
    plazaStore = plazaLib.normalizePlaza(
      JSON.parse(fs.readFileSync(PLAZA_FILE, 'utf8')));
    console.log(`已恢复交流广场：${Object.keys(plazaStore.packs).length} 个词包`);
  } catch { /* 首次启动或数据损坏，从空广场开始 */ }
}

let plazaSaveTimer = null;
function savePlaza() {
  if (shuttingDown) return;
  clearTimeout(plazaSaveTimer);
  plazaSaveTimer = setTimeout(() => {
    try {
      writeJsonAtomic(PLAZA_FILE, plazaStore);
    } catch (e) { console.error('交流广场保存失败', e); }
  }, 300);
}

// 停服前立即落盘（避免最后一次发布/订阅还在防抖队列里）
function flushPlaza() {
  clearTimeout(plazaSaveTimer);
  try {
    writeJsonAtomic(PLAZA_FILE, plazaStore);
  } catch (e) { console.error('交流广场保存失败', e); }
}

// ---------- 跨房间赛事存储 ----------
// 赛事是与房间/赛季解耦的独立状态机：它只持有赛程、报名者（公开 pid）、对阵树与
// 每场对阵对应的房间码。每场对局都是普通游戏房间，赛季战绩由既有"对局结束→逐局索引"
// 链路自动回写，本层不重复记账。赛事与房间的一致性在房间结束/删除/重启三个接缝处对账。
let tournamentStore = tournamentLib.emptyStore();

function loadTournaments() {
  try {
    tournamentStore = tournamentLib.normalizeStore(
      JSON.parse(fs.readFileSync(TOURNAMENT_FILE, 'utf8')));
    reconcileTournamentRooms('启动对账');
    console.log(`已恢复跨房间赛事：${Object.keys(tournamentStore.tournaments).length} 场`);
  } catch { /* 首次启动或数据损坏，从空表开始 */ }
}

let tournamentSaveTimer = null;
function saveTournaments() {
  if (shuttingDown) return;
  clearTimeout(tournamentSaveTimer);
  tournamentSaveTimer = setTimeout(() => {
    try {
      writeJsonAtomic(TOURNAMENT_FILE, tournamentStore);
    } catch (e) { console.error('赛事保存失败', e); }
  }, 300);
}

function flushTournaments() {
  clearTimeout(tournamentSaveTimer);
  try {
    writeJsonAtomic(TOURNAMENT_FILE, tournamentStore);
  } catch (e) { console.error('赛事保存失败', e); }
}

// ---------- 房间存储 ----------

/** rooms: Map<code, room>; tokens: Map<token, {roomCode, playerId, spectator?}> */
const rooms = new Map();
const tokens = new Map();
/** sockets: Map<playerId, Set<ws>>（玩家与观战者共用，id 不冲突：观战者带 sp_ 前缀） */
const sockets = new Map();
/**
 * 赛事对局房间反查索引：roomCode -> { tournamentId, matchId, settled }。
 * 房间结束/删除/重启对账时据此把结果回写赛事；一个房间码只可能属于一场对阵（含重赛后
 * 已废弃的旧房——旧场被 rematch 标 void 时对应房间也随之失效，不会再回写）。
 */
const matchRooms = new Map();
/** 观战者断线宽限期：id -> setTimeout，超过后从房间清出（覆盖刷新页面的短暂离线） */
const spectatorPruneTimers = new Map();
const SPECTATOR_TTL_MS = Number(process.env.SPECTATOR_TTL_MS) || 60 * 1000;
// 已结束房间保留期：结束超过此时长的房间连同整份回放日志一并删除，对应 token 全部作废。
// 赛季战绩在对局结束时已单独累计进 season.json，删房不影响排行榜与个人页。
const ROOM_RETENTION_MS = Number(process.env.WT_ROOM_TTL_MS) || 7 * 24 * 60 * 60 * 1000;
// 保留期清理的周期检查间隔（长期不重启也能自动收敛存档）
const ROOM_PRUNE_INTERVAL_MS = Number(process.env.WT_ROOM_PRUNE_INTERVAL_MS) || 60 * 60 * 1000;
// 单个赛季时长（毫秒）：到期把当前榜单冻结进赛季历史、开新赛季重新累计。
// 默认 30 天；显式设为 0/负数表示永不自动切换（仅保留单赛季）。
// 不能用 `Number(...) || 默认值`：0 是合法值（禁用切换），会被 || 误当假值回退。
const SEASON_MS = (() => {
  const v = process.env.WT_SEASON_MS;
  if (v == null || v === '') return 30 * 24 * 60 * 60 * 1000; // 未配置：默认 30 天
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0; // 0/负数/非数均视为禁用自动切换
})();
// 一场对阵等待两名选手入场的时长（毫秒）：到期只来一人判到场者胜，两人都没到则种子
// 靠前者兜底晋级，保证对阵树不中断。默认 10 分钟；测试可用 WT_MATCH_WAIT_MS 压短。
const MATCH_WAIT_MS = (() => {
  const n = Number(process.env.WT_MATCH_WAIT_MS);
  return Number.isFinite(n) && n >= 60 * 1000 ? n : 10 * 60 * 1000;
})();
// 完赛/取消赛事的保留期：超期连同对阵树一起清除（对局战绩早已独立计入赛季，删赛事不影响榜单）。
const TOURNAMENT_TTL_MS = Number(process.env.WT_TOURNAMENT_TTL_MS)
  || tournamentLib.FINISHED_TTL_MS;

function loadRooms() {
  try {
    // 同一进程内 stop→start（测试场景）时内存状态必须以磁盘为准：先清空上一轮残留的
    // 房间/token/计时句柄，否则旧房间会与磁盘读出的房间并存（日志会出现"磁盘 1 间、
    // 恢复 3 间"），还可能让早已停服的对局参与赛季对账。
    rooms.clear();
    tokens.clear();
    matchRooms.clear();
    for (const t of turnTimers.values()) clearTimeout(t);
    turnTimers.clear();
    for (const t of spectatorPruneTimers.values()) clearTimeout(t);
    spectatorPruneTimers.clear();
    const raw = readJsonOrQuarantine(DATA_FILE, '房间存档');
    if (raw === null) return; // 文件不存在或坏档已隔离：内存保持清空，等新房间
    const loadedRoomCodes = new Set();
    for (const room of raw.rooms) {
      // 旧存档没有 id 字段：补一个稳定唯一 id 并随下次落盘固化（赛季逐局去重要用）
      game.ensureRoomId(room);
      // 旧存档没有 spectators 字段时补空
      if (!Array.isArray(room.spectators)) room.spectators = [];
      // 旧存档没有主题词包字段：补 null（使用默认词池）
      if (!('wordPack' in room)) room.wordPack = null;
      // 重启后不存在任何活动连接。玩家保留座位、置离线，凭 token 重连恢复；
      // 观战者是临时只读身份，立即清出——不能让他们在大厅/对局名单里挂到延迟清理才消失，
      // 也不能虚占在线名额让新观战者撞上"已满"。想继续看的人重新输入房间码即可。
      game.resetConnectionsAfterRestart(room);
      game.removeAllSpectators(room);
      // 托管是"本次在线会话"的临时处置（掉线即托管、重连即收回），不落盘、不跨重启：
      // 重启后所有玩家一律按普通离线处理，凭 token 重连恢复；残留的 autoPilot 标记清掉。
      room.players.forEach(p => { p.autoPilot = false; });
      // 赛季是否已计入，只认赛季档案自己的逐局索引：
      //  - 索引里有：说明玩家汇总确实已落盘，补上内存标记，重连结算房时不重复累计；
      //  - 索引里没有：这局可能是"内存计过但赛季没落盘"（如防抖窗口内被杀），
      //    绝不补标记——保留期清理会在删房前把它补记回赛季。
      // 旧版（v1）赛季档没有索引：加载后统一对账（见下方 legacy 对账），对账前先按索引标。
      if (room.phase === 'ended') room.seasonRecorded = seasonLib.isRoomRecorded(season, room);
      rooms.set(room.code, room);
      loadedRoomCodes.add(room.code);
      // 重启后回合计时重新挂上。关键：必须保留暂停点的剩余时间，不能把暂停中的
      // 回合重置成完整倒计时——否则质疑裁定结束（或托管玩家重连）后，本应用剩余时间
      // 继续的回合会凭空多出一整段时间；反过来旧 deadline 是重启前的绝对时间戳，
      // 直接挂表又会立刻超时。这里按状态分别处理：
      if (room.phase === 'playing' && room.turn) {
        const t = room.turn;
        if (room.pendingChallenge) {
          // 质疑暂停中：保留/折算 pausedRemaining，不挂倒计时。
          // 正常情况 challenge 时已停表（deadline=null）；损坏档若残留旧 deadline，
          // 把它折算成剩余时间（过期则兜底一整回合），避免裁定一结束就立即超时。
          if (t.deadline) {
            const left = t.deadline - Date.now();
            t.pausedRemaining = left > 1000 ? left : turnMs(room);
            t.deadline = null;
          }
          t.pausedReason = 'challenge';
        } else if (!t.deadline && t.pausedRemaining != null) {
          // 托管（行动玩家掉线）暂停中：保留暂停点剩余时间、继续停表，等其重连收回。
          t.pausedReason = t.pausedReason === 'challenge' ? 'challenge' : 'autopilot';
        } else if (!t.deadline) {
          // 无 deadline 也无剩余时间的损坏/旧档：给完整回合兜底，避免对局永久停住。
          t.deadline = Date.now() + turnMs(room);
          t.pausedRemaining = null;
          t.pausedReason = null;
        } else {
          // 有 deadline：那是重启前的绝对时间戳，统一按完整回合重新挂表
          // （正常进行中的回合，重启只损失"距上次落盘"的少量时间，可接受）。
          t.deadline = Date.now() + turnMs(room);
        }
        scheduleTurnTimer(room);
      }
    }
    // 只恢复玩家 token；旧观战身份已随重启作废，其 token 一并丢弃，避免残留膨胀
    for (const [token, ref] of Object.entries(raw.tokens || {})) {
      if (ref && !ref.spectator && loadedRoomCodes.has(ref.roomCode)) tokens.set(token, ref);
    }
    // 旧版（v1）赛季档没有逐局索引：把现存所有结束房只登记进索引、不重算战绩
    // （它们的玩家汇总早已在档案里）。登记后 v1 与 v2 统一"只认索引"，否则一旦有
    // 新对局触发赛季写盘，旧局会在索引里缺失，清理时被当成漏记局而重复累计一遍。
    if (seasonLegacy) {
      let dirty = false;
      for (const room of rooms.values()) {
        if (room.phase === 'ended' && markRoomRecordedPending(room)) dirty = true;
      }
      // flush 失败也不致命（旧局战绩本就在文件里），但挂起集合保留，下面的清理会绕开它们。
      if (dirty) flushSeason();
      seasonLegacy = false; // 进程此后只认索引
    }
    // 启动对账：把"已结束但索引里没有"的房间（典型：300ms 防抖窗口内被杀，战绩没落盘）
    // 在任何请求到达前补记进赛季并同步落盘。必须早于下面的删房清理与 startServer 里的
    // 赛季切换——保留期内、没人回看的漏记局也立即回到榜单；跨赛季边界时先补老赛季再冻结。
    // 注意：即使这里 flush 失败，补记的 key 仍挂在 seasonPendingRooms 里，下面的
    // pruneExpiredRooms 会强制再 flush 并在失败时整轮中止，绝不删除未持久化的超期房。
    reconcileRecordedRooms();
    // 启动即清一次超期的已结束房间（连同 token 与回放日志），旧存档里的积压在这一步收敛。
    // 清理对"索引里没有 / 待持久化"的局会先补记战绩并【确认落盘】，再删房间。
    const expired = pruneExpiredRooms();
    if (raw.rooms.length || expired.length) saveRooms(); // 落盘清出观战者/删除超期房后的干净状态
    console.log(`已恢复 ${rooms.size} 个房间`);
  } catch { /* 首次启动或数据损坏，忽略 */ }
}

let saveTimer = null;
// 停机守卫：stopServer 清掉防抖定时器后，仍在途中的广播/回调若再触发 saveRooms，
// 会重新挂一个定时器并在进程退出后把内存房间写回磁盘——测试里这会覆盖停服后手工
// 准备的存档。停机后一律不再重新挂防抖（最终状态已由 flush 同步落盘）。
let shuttingDown = false;
function saveRooms() {
  if (shuttingDown) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      flushRooms();
    } catch (e) { console.error('保存失败', e); }
  }, 300);
}

// 立即、原子地把房间存档写盘（停服前调用）。返回是否成功；原子写保证任何时刻磁盘上
// 都是完整的一份存档，不会被半途崩溃截断成半个 JSON（那会让重启丢光所有房间）。
function flushRooms() {
  // 结束的房间只保留回放/结算所需的玩家与日志，不持久化观战者；
  // 观战是临时身份，重启后本就不可恢复，避免旧观战记录残留在线名单。
  const persistedRooms = [...rooms.values()].map(r =>
    r.phase === 'ended' ? { ...r, spectators: [] } : r);
  const liveCodes = new Set(persistedRooms.map(r => r.code));
  const persistedTokens = {};
  for (const [tok, ref] of tokens) {
    if (!liveCodes.has(ref.roomCode)) continue;
    if (ref.spectator && rooms.get(ref.roomCode).phase === 'ended') continue;
    persistedTokens[tok] = ref;
  }
  writeJsonAtomic(DATA_FILE, { rooms: persistedRooms, tokens: persistedTokens });
}

// ---------- 已结束房间保留期清理 ----------

// 启动/对账：把内存里【已结束但赛季逐局索引里没有】的房间全部补记进当前赛季文件。
// 这是结算链路"可恢复"的关键一环：对局结束走的是 300ms 防抖落盘，若进程在窗口内被杀
// （正常 kill -9、部署重启、掉电），战绩可能只停留在内存——重启后这些房间既没到保留期、
// 也没人重连触发广播，光靠删房前补记会让榜单一直缺场次（极端情况下直到房间过期）。
// 启动时统一扫一遍，把漏记的局立即、同步地补记落盘，排行榜与个人页在任何请求到达前
// 就已是完整一致的。recordRoom 以跨赛季全局索引幂等，重复扫描/标记残留都不会双计。
// 必须在 rolloverIfDue【之前】调用：这样跨赛季边界后重启时，漏记的老对局先进老赛季
// 并随冻结归档，不会被错误累计进全新赛季。
//
// 返回 { backfilled, durable }：backfilled 为补记的局数；durable 表示这些补记（连同任何
// 此前挂起的待持久化局）是否都已确认落盘。durable=false 时补记的 key 仍挂在
// seasonPendingRooms 中，调用方（启动清理/切赛季）必须据此中止删房并稍后重试，
// 绝不能让"只在内存里"的超期房被当成已持久化而删除。
function reconcileRecordedRooms(now = Date.now()) {
  let backfilled = 0;
  for (const room of rooms.values()) {
    if (room.phase !== 'ended' || seasonLib.isRoomRecorded(season, room)) continue;
    const { changed } = recordRoomPending(room, now);
    if (changed) backfilled += 1;
  }
  if (!backfilled) {
    // 即便本轮没补记，也可能有此前挂起的待持久化局；不空转 flush（无挂起时直接成功）。
    return { backfilled, durable: seasonPendingRooms.size === 0 || flushSeason() };
  }
  const durable = flushSeason();
  if (durable) {
    console.log(`启动对账：补记 ${backfilled} 个已结束但漏记的对局到赛季战绩`);
  } else {
    console.error(`启动对账：补记 ${backfilled} 个漏记对局，但赛季落盘失败；` +
      '这些房间在落盘成功前不会被清理，将随周期任务重试');
  }
  return { backfilled, durable };
}

// 删除超期房间：房间记录、整份回放日志与该房全部 token 一并清掉。
// 首页历史是客户端持 token 换摘要：token 失效后对应条目会按现有机制自动消失。
//
// 关键安全约束：房间上的 seasonRecorded 标记不能作为"已计入赛季"的凭据——对局结束时
// 赛季文件是 300ms 防抖落盘的，若进程在落盘前退出/写盘失败，标记会随房间存档残留为真，
// 但赛季文件里根本没有这局。因此删房前必须查赛季档案自己的逐局索引；没查到就先补记，
// 并且把赛季文件同步刷到磁盘后再删房间，保证"房间消失"时战绩一定已经独立留存。
function pruneExpiredRooms(now = Date.now()) {
  if (!(ROOM_RETENTION_MS > 0)) return [];
  const candidates = [];
  for (const room of rooms.values()) {
    if (!game.isRoomExpired(room, ROOM_RETENTION_MS, now)) continue;
    // 正有人连着看结算/回放的房间先留着，等下一个周期连接都断开后再清
    const hasConnection = room.players.some(p => p.connected) ||
      (room.spectators || []).some(s => s.connected);
    if (hasConnection) continue;
    candidates.push(room);
  }
  if (!candidates.length) return [];

  // 先处理赛季：索引里没有的候选房补记一次（recordRoom 按索引幂等，标记残留也不影响）。
  // 用 recordRoomPending：补记的 key 立即进入"待持久化"集合，在 flush 成功前不得删除。
  for (const room of candidates) {
    if (!seasonLib.isRoomRecorded(season, room)) recordRoomPending(room, now);
  }
  // 关键防线：只要还有任何房间的计入只停留在内存、没确认落盘，就【绝不删房】。
  // 这里不能只看本轮补记（seasonDirty）：启动对账/重连结算可能在更早把 key 放进了
  // 内存索引、却在 flush 失败后保留下来——它们 isRoomRecorded 为真，但磁盘上并没有，
  // 只看内存索引会把这些超期房误判为"已持久化"而删成永久缺场。
  // 统一的判定是 seasonPendingRooms：强制同步 flush，成功（集合清空）才允许继续。
  if (seasonPendingRooms.size > 0) {
    const pendingCandidates = candidates.filter(r =>
      seasonPendingRooms.has(game.roomKey(r)));
    if (!flushSeason()) {
      // 落盘失败（磁盘满/权限）：整轮中止，房间原样保留，内存战绩与挂起集合都还在，
      // 由防抖有限重试 / 周期任务 / 下次删房前强制 flush 兜底，下个周期重新尝试。
      // 宁可房间多留一个保留期，也不能让"房间消失但战绩没进文件"。
      if (pendingCandidates.length) {
        console.error(`删房前的赛季落盘失败，${pendingCandidates.length} 个超期房间战绩尚未持久化，` +
          '本轮房间清理中止，下个周期重试');
      }
      return [];
    }
  }
  // 到达这里：所有候选房的计入都已确认在磁盘（pending 集合已清空），可以安全删除。
  // 二次断言，防止未来改动绕过上面的 flush 门禁。
  for (const room of candidates) {
    if (seasonPendingRooms.has(game.roomKey(room))) return [];
  }

  const removed = [];
  for (const room of candidates) {
    // 观战清理定时器只可能指向非结束房，这里顺手停掉以防残留句柄
    for (const s of room.spectators || []) {
      const t = spectatorPruneTimers.get(s.id);
      if (t) { clearTimeout(t); spectatorPruneTimers.delete(s.id); }
    }
    rooms.delete(room.code);
    for (const [tok, ref] of tokens) {
      if (ref.roomCode === room.code) tokens.delete(tok);
    }
    removed.push(room);
  }
  saveRooms();
  const span = ROOM_RETENTION_MS >= 86400000
    ? `${Math.round(ROOM_RETENTION_MS / 86400000)} 天`
    : ROOM_RETENTION_MS >= 3600000
      ? `${Math.round(ROOM_RETENTION_MS / 3600000)} 小时`
      : `${Math.round(ROOM_RETENTION_MS / 60000)} 分钟`;
  console.log(`已清理 ${removed.length} 个超过保留期（${span}）的已结束房间`);
  return removed;
}

let roomPruneTimer = null;
function scheduleRoomPruning() {
  if (!(ROOM_PRUNE_INTERVAL_MS > 0)) return;
  // 同一周期任务顺序：先做赛季切换（漏记的结束房在冻结前补进老赛季），
  // 再把任何仍挂起的赛季改动落盘（此前 flush 失败的重试），最后清超期房间——
  // 这样即使没有任何房间到期，待持久化的战绩也会在周期内被重新落盘，不依赖删房触发。
  roomPruneTimer = setInterval(() => {
    rolloverIfDue();
    if (seasonPendingRooms.size > 0) flushSeason();
    pruneExpiredRooms();
    sweepTournaments();
    pruneTournaments();
  }, ROOM_PRUNE_INTERVAL_MS);
  roomPruneTimer.unref?.(); // 测试/短进程中定时器不挂住退出
}

// ---------- 跨房间赛事：扫描 / 对局房间 / 结果回写 ----------

// 惰性扫描：报名截止自动开赛（人数不足则取消）、ready 对阵的超时未到。
// 任何会读赛事的请求与广播都调用，保证即使周期任务间隔很长也能及时推进。
// 超时产生的废弃房间（只来了一人、开了房却没打成）在出结果后清理。
function sweepTournaments(now = Date.now()) {
  const before = Object.keys(tournamentStore.tournaments).length;
  const out = tournamentLib.sweep(tournamentStore, now);
  if (before || out.started.length || out.cancelled.length || out.walkovers.length) {
    saveTournaments();
  }
  // 超时场次若已开过房间（只来一人），其房间已无意义：作废房间与 token
  for (const w of out.walkovers) {
    if (w.roomCode) retireMatchRoom(w.roomCode);
  }
  if (out.started.length || out.cancelled.length || out.finished.length || out.walkovers.length) {
    broadcastTournamentChanges([...new Set([
      ...out.started, ...out.cancelled, ...out.finished,
      ...out.walkovers.map(w => w.tournamentId)])]);
  }
  return out;
}

// 退役一场赛事对阵房间：从房间表删除并作废其 token（重赛/超时后旧房间不再可用）。
// 已结束且计入过赛季的房间不受影响——其战绩已独立落盘，这里只清内存与房间存档。
function retireMatchRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) { matchRooms.delete(roomCode); return; }
  rooms.delete(roomCode);
  for (const [tok, ref] of tokens) {
    if (ref.roomCode === roomCode) tokens.delete(tok);
  }
  matchRooms.delete(roomCode);
  saveRooms();
}

// 选手进入自己当前对阵：服务端为该场（必要时惰性）开一个普通 2 人游戏房间，
// 校验"持密钥者必须是本场参赛选手"，把选手作为房间玩家加入；两人到齐自动开局。
// 返回 { error } 或 { roomCode, token, playerId, live }。
function enterTournamentMatch(ws, ctx, msg) {
  const t = tournamentLib.getTournament(tournamentStore, String(msg.tournamentId || ''));
  if (!t) return sendErr(ws, '赛事不存在或已删除', 'tournament');
  const { pid } = seasonLib.resolvePid(msg);
  if (!pid) return sendErr(ws, '需要有效的本机身份才能进入赛事对局', 'tournament');
  const entrant = t.entrants.find(e => e.pid === pid);
  if (!entrant) return sendErr(ws, '你没有报名这场赛事', 'tournament');
  const m = tournamentLib.currentMatchFor(t, pid);
  if (!m) return sendErr(ws, '当前没有等待你进入的对阵', 'tournament');
  sweepTournaments(); // 入场前先推进超时，避免给一个其实已判负的场次开房
  if (m.status !== 'ready' && m.status !== 'live') {
    return sendErr(ws, '这场对阵当前不能进入', 'tournament');
  }
  // 已有房间：复用（刷新/短暂断网后凭新会话重新加入），否则惰性创建
  let room = m.roomCode ? rooms.get(m.roomCode) : null;
  if (!room && m.roomCode) {
    // 房间已被清理但赛事仍指向它（异常）：重建索引并按无房处理
    m.roomCode = null;
  }
  if (!room) {
    const code = makeRoomCode();
    room = game.newRoom(code, null, t.hostName);
    room.hostId = null; // 赛事房间没有个人房主：规则/词包随赛事快照，开赛由服务端在两人到齐时触发
    // 赛事规则直接按白名单快照写入（不经 setRuleSet 的房主校验——赛事房间没有个人房主，
    // 规则在建赛事时已清洗过，任何选手都不能改动）；缺省字段由 game 的默认规则补齐。
    room.ruleSet = { ...game.DEFAULT_RULESET,
      ...Object.fromEntries(Object.entries(t.rules).filter(([, v]) => v !== null)) };
    if (t.packName) room.tournamentPackLabel = t.packName;
    room.tournamentId = t.id;
    room.matchId = m.id;
    rooms.set(code, room);
    tournamentLib.assignRoom(t, m.id, code);
    matchRooms.set(code, { tournamentId: t.id, matchId: m.id, settled: false });
  }
  // 已是该房间玩家（重复进入）：直接发新 token 恢复，不再 addPlayer
  const existing = room.players.find(p => p.pid === pid);
  let playerId;
  if (existing) {
    playerId = existing.id;
    // 刷新/重连后凭赛事入口重新进入：恢复在线（首次进入时 addPlayer 已置 true，
    // 这里覆盖断线后被置 false 的情形），与普通房间 reconnect 路径口径一致。
    existing.connected = true;
  } else {
    playerId = crypto.randomBytes(8).toString('hex');
    const err = game.addPlayer(room, playerId, entrant.name, pid);
    if (err) return sendErr(ws, err, 'tournament');
  }
  const ci = tournamentLib.checkIn(t, m.id, pid);
  if (ci.error) return sendErr(ws, ci.error, 'tournament');
  const token = issueToken(room.code, playerId);
  ctx.playerId = playerId; ctx.roomCode = room.code;
  attachSocket(playerId, ws);
  // 两人到齐（live）且仍在大厅：服务端用赛事规则自动开局
  if (ci.live && room.phase === 'lobby') {
    const err = game.startGame(room, '__tournament__');
    if (err) return sendErr(ws, `赛事对局无法开始：${err}`, 'tournament');
    scheduleTurnTimer(room);
  }
  saveTournaments();
  saveRooms();
  ws.send(JSON.stringify({ type: 'joined', token, roomCode: room.code, playerId,
    tournamentId: t.id, matchId: m.id }));
  broadcast(room);
  broadcastTournament(t.id);
}

// 房间结束：若是赛事对局房间，把房间胜者/分数回写对应场次，触发晋级（或平局重赛）。
// 幂等：matchRooms 索引上的 settled 与场次自身状态共同保证一局只回写一次。
function settleTournamentRoom(room) {
  if (!room || room.phase !== 'ended') return;
  const ref = matchRooms.get(room.code) ||
    (room.tournamentId ? { tournamentId: room.tournamentId, matchId: room.matchId, settled: false } : null);
  if (!ref || ref.settled) return;
  const t = tournamentLib.getTournament(tournamentStore, ref.tournamentId);
  if (!t) { matchRooms.delete(room.code); return; }
  const m = t.matches[ref.matchId];
  // 重赛后旧场已 void：其房间结果不再回写（旧局仍按普通对局计入赛季，只是不影响晋级）
  if (!m || m.status === 'void' || m.status === 'finished') {
    ref.settled = true;
    return;
  }
  const scores = game.computeScores(room).map(s => {
    const p = room.players.find(x => x.id === s.playerId);
    return { pid: p ? p.pid : null, name: s.name, total: s.total };
  });
  const winnerPlayer = room.winner ? room.players.find(p => p.id === room.winner) : null;
  const r = tournamentLib.reportMatchResult(tournamentStore, t.id, m.id, {
    roomCode: room.code, roomKey: game.roomKey(room),
    roomWinnerPid: winnerPlayer && winnerPlayer.pid ? winnerPlayer.pid : null,
    scores, now: room.endedAt || Date.now(),
  });
  if (r.error) {
    // 房间与场次不一致等异常：不静默吞，留给重启对账/人工处理（房间仍正常保留与计赛季）
    console.error(`赛事对局回写失败 ${t.id}/${m.id}：${r.error}`);
    return;
  }
  ref.settled = true;
  saveTournaments();
  // 平局自动重赛：旧房间作废（已计入赛季），新场次立即等待双方重新进入
  if (r.rematch && r.rematch.roomCode) {
    // 理论上新重赛场还没房间；若已存在则复用索引
    matchRooms.set(r.rematch.roomCode,
      { tournamentId: t.id, matchId: r.rematch.id, settled: false });
  }
  broadcastTournament(t.id);
}

// 重启对账：扫描赛事里 live/ready/finished 但房间状态异常的场次：
// - 房间已结束却没回写（防抖窗口内被杀）：补回写；
// - 房间已不存在且场次仍 ready/live：清掉悬挂房间码，ready 场次重新等待选手入场开房；
//   live（双方都进过房、已自动开局）的房间丢失（理论只发生在房间档损坏）时退回 ready，
//   让选手重新开房，避免对阵永久挂住。
function reconcileTournamentRooms(reason) {
  for (const t of Object.values(tournamentStore.tournaments)) {
    for (const mid of t.matchOrder) {
      const m = t.matches[mid];
      if (!m || !m.roomCode) continue;
      const room = rooms.get(m.roomCode);
      if (room && room.phase === 'ended') {
        matchRooms.set(room.code, { tournamentId: t.id, matchId: mid, settled: false });
        settleTournamentRoom(room);
        continue;
      }
      if (!room) {
        matchRooms.delete(m.roomCode);
        m.roomCode = null;
        if (m.status === 'live') {
          m.status = 'ready';
          m.checkedEids = [];
          m.readyAt = Date.now();
          m.deadline = Date.now() + t.matchWaitMs;
        } else if (m.status === 'ready') {
          m.checkedEids = [];
          m.readyAt = Date.now();
          m.deadline = Date.now() + t.matchWaitMs;
        }
      } else {
        matchRooms.set(room.code, { tournamentId: t.id, matchId: mid, settled: false });
      }
    }
  }
  void reason;
}

function pruneTournaments(now = Date.now()) {
  const removed = tournamentLib.pruneFinished(tournamentStore, TOURNAMENT_TTL_MS, now);
  if (removed.length) {
    saveTournaments();
    console.log(`已清理 ${removed.length} 个超过保留期的赛事`);
  }
  return removed;
}

// ---------- 赛事广播 ----------

// 赛事是"跨房间"对象：观众不一定在某个赛事房间里（首页赛事面板也要实时更新）。
// 用 pid 订阅：连接建在任意房间/首页均可，服务端维护 tournamentWatchers: pid -> Set<ws>。
const tournamentWatchers = new Map();

function watchTournament(ws, pid) {
  if (!tournamentWatchers.has(pid)) tournamentWatchers.set(pid, new Set());
  tournamentWatchers.get(pid).add(ws);
  ws._tournamentPid = ws._tournamentPid || new Set();
  ws._tournamentPid.add(pid);
}

function unwatchTournament(ws) {
  if (!ws._tournamentPid) return;
  for (const pid of ws._tournamentPid) {
    const set = tournamentWatchers.get(pid);
    if (set) { set.delete(ws); if (!set.size) tournamentWatchers.delete(pid); }
  }
  ws._tournamentPid = null;
}

function broadcastTournament(tournamentId) {
  sweepTournaments();
  const t = tournamentLib.getTournament(tournamentStore, tournamentId);
  if (!t) return;
  const pids = new Set(t.entrants.map(e => e.pid));
  pids.add(t.hostPid);
  for (const pid of pids) {
    const set = tournamentWatchers.get(pid);
    if (!set) continue;
    const view = JSON.stringify({ type: 'tournament', tournament: tournamentLib.tournamentView(t, pid) });
    for (const ws of set) if (ws.readyState === 1) ws.send(view);
  }
}

function broadcastTournamentChanges(ids) {
  for (const id of ids) broadcastTournament(id);
}

// ---------- 广播 ----------

// 全部赛季的轻量元信息（当前赛季 + 已冻结赛季，最新在前）：客户端排行榜头部展示
// "第 N 赛季/共 N 个赛季"用。玩家级数据不在这里，逐赛季名次走个人页 profile.seasons。
function seasonMeta(s) {
  const list = (s.history || []).map(h => ({
    season: h.season, startedAt: h.startedAt, endedAt: h.endedAt,
    players: Object.keys(h.players || {}).length, current: false,
  }));
  list.unshift({
    season: s.season, startedAt: s.startedAt, endedAt: null,
    players: Object.keys(s.players || {}).length, current: true,
  });
  return list;
}

function broadcast(room) {
  // 有对局活动时惰性检查赛季切换：哪怕周期任务间隔很长，赛季一到期产生的新结算
  // 也一定计入新赛季（切换前会先把所有漏记的结束房补进老赛季，见 rolloverIfDue）。
  rolloverIfDue();
  // 对局首次结束：为每名可识别玩家（带跨对局稳定 pid）累计一条公开赛季战绩。
  // 进程内用 seasonRecorded 做快速短路；真正的幂等凭据是跨赛季全局逐局索引——
  // 重连/重启后房间标记可能残留，但 recordRoom 内部只认索引，重复广播/跨赛季都不会重复累计。
  // recordRoomPending 同时把 key 挂入待持久化集合，防抖落盘成功后才摘除；即便 300ms 内
  // 被杀，重启启动对账/删房门禁也会把它识别为未落盘而补记，不会被误删。
  if (room.phase === 'ended' && !room.seasonRecorded) {
    const { changed } = recordRoomPending(room);
    if (changed) saveSeason();
  }
  // 赛事对局房间结束：把胜者/分数回写对阵树，触发晋级或平局重赛（幂等）
  if (room.phase === 'ended' && (room.tournamentId || matchRooms.has(room.code))) {
    settleTournamentRoom(room);
  }
  const recipients = [
    ...room.players.map(p => p.id),
    ...(room.spectators || []).map(s => s.id),
  ];
  for (const id of recipients) {
    const set = sockets.get(id);
    if (!set) continue;
    const view = JSON.stringify({ type: 'state', state: game.publicView(room, id) });
    for (const ws of set) if (ws.readyState === 1) ws.send(view);
  }
  saveRooms();
}

function sendTo(playerId, msg) {
  const set = sockets.get(playerId);
  if (!set) return;
  const s = JSON.stringify(msg);
  for (const ws of set) if (ws.readyState === 1) ws.send(s);
}

// ---------- 回合计时 ----------

// 当前房间一个回合的计时长度（毫秒）。默认取开局规则 turnSeconds；
// _turnMsOverride 仅供自包含冒烟测试压短超时（不随 ruleSet 广播、不落客户端规则）。
function turnMs(room) {
  return Number.isFinite(room._turnMsOverride) && room._turnMsOverride > 0
    ? room._turnMsOverride
    : room.ruleSet.turnSeconds * 1000;
}

const turnTimers = new Map();
function scheduleTurnTimer(room) {
  clearTimeout(turnTimers.get(room.code));
  if (room.phase !== 'playing' || !room.turn || !room.turn.deadline) return;
  const delay = Math.max(0, room.turn.deadline - Date.now());
  turnTimers.set(room.code, setTimeout(() => {
    if (room.phase !== 'playing' || !room.turn || room.pendingChallenge) return;
    const playerId = room.turn.playerId;
    // 超时：先进入托管（写入回放），再由托管代为结束回合（advanceTurn 会自动空过
    // 后续仍离线的托管玩家）。此时玩家通常仍连着线（挂机），托管持续到其重连或下个回合。
    game.enterAutoPilot(room, playerId, 'timeout');
    const err = game.endTurn(room, playerId, { auto: true, reason: 'timeout' });
    if (!err) {
      game.applyTurnMsOverride(room); // 新回合同样套用测试短计时（生产为空操作）
      scheduleTurnTimer(room);
      broadcast(room);
    }
  }, delay + 50));
}

// ---------- 消息处理 ----------

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// 词包分享码：8 位、与房间码同一套易读字母表（不含 0/1/I/O），不绑房间；
// 撞码由 sharesLib.publishForPack 检测后重试，这里只负责随机产出候选码。
function makeShareCode() {
  const { CODE_LEN, CODE_ALPHABET } = sharesLib;
  return Array.from({ length: CODE_LEN },
    () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
}

// 广场条目 id：pz_ + 12 位十六进制，撞 id 由 plazaLib.publish 检测后重试
function makePlazaId() {
  return `pz_${crypto.randomBytes(6).toString('hex')}`;
}

// 赛事 id：tm_ + 12 位十六进制，撞 id 由 tournamentLib.createTournament 检测后重试
function makeTournamentId() {
  return `tm_${crypto.randomBytes(6).toString('hex')}`;
}

function issueToken(roomCode, playerId, spectator = false) {
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { roomCode, playerId, spectator });
  return token;
}

function attachSocket(playerId, ws) {
  if (!sockets.has(playerId)) sockets.set(playerId, new Set());
  sockets.get(playerId).add(ws);
}

function cancelSpectatorPrune(spectatorId) {
  const t = spectatorPruneTimers.get(spectatorId);
  if (t) { clearTimeout(t); spectatorPruneTimers.delete(spectatorId); }
}

// 观战者最后一个连接断开：标记离线并给一个宽限期，超时再清出房间
// （页面刷新/短暂断网时 token 仍可恢复观战身份）
function scheduleSpectatorPrune(spectatorId) {
  cancelSpectatorPrune(spectatorId);
  spectatorPruneTimers.set(spectatorId, setTimeout(() => {
    spectatorPruneTimers.delete(spectatorId);
    for (const room of rooms.values()) {
      const s = (room.spectators || []).find(x => x.id === spectatorId);
      if (!s || sockets.has(spectatorId)) continue;
      game.removeSpectator(room, spectatorId);
      broadcast(room); // 让其他人名单中的旧观战者消失
    }
    // 清掉失效的观战 token，避免 token 表无限增长
    for (const [tok, ref] of tokens) {
      if (ref.spectator && ref.playerId === spectatorId) tokens.delete(tok);
    }
  }, SPECTATOR_TTL_MS));
}

function detachSocket(playerId, ws) {
  const set = sockets.get(playerId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    sockets.delete(playerId);
    for (const room of rooms.values()) {
      // 观战者：走离线宽限，不触发玩家断线/裁定移交逻辑
      const sp = (room.spectators || []).find(x => x.id === playerId);
      if (sp) {
        if (sp.connected) {
          sp.connected = false;
          broadcast(room);
        }
        scheduleSpectatorPrune(playerId);
        continue;
      }
      const p = room.players.find(x => x.id === playerId);
      if (p && p.connected) {
        p.connected = false;
        // 掉线即进入托管：行动玩家暂停回合计时、裁定者移交裁定权、托管期间不质疑不裁定。
        game.enterAutoPilot(room, playerId, 'disconnect');
        if (room.turn && room.turn.playerId === playerId && !room.turn.deadline) {
          clearTimeout(turnTimers.get(room.code)); // 行动玩家的倒计时已暂停
        }
        game.ensureAdjudicatorOnline(room);
        broadcast(room);
      }
    }
  }
}

const handlers = {
  createRoom(ws, ctx, msg) {
    const code = makeRoomCode();
    const playerId = crypto.randomBytes(8).toString('hex');
    // 公开 pid 只能由服务端从玩家密钥派生，绝不采信客户端自报的 pid（否则可冒用他人身份）
    const { pid } = seasonLib.resolvePid(msg);
    const room = game.newRoom(code, playerId, msg.name);
    game.addPlayer(room, playerId, msg.name, pid);
    if (msg.ruleSet) game.setRuleSet(room, playerId, msg.ruleSet);
    rooms.set(code, room);
    const token = issueToken(code, playerId);
    ctx.playerId = playerId; ctx.roomCode = code;
    attachSocket(playerId, ws);
    ws.send(JSON.stringify({ type: 'joined', token, roomCode: code, playerId }));
    broadcast(room);
  },

  joinRoom(ws, ctx, msg) {
    const room = rooms.get(String(msg.roomCode || '').toUpperCase());
    if (!room) return sendErr(ws, '房间不存在，请检查房间码');
    // 赛事对阵房间只允许参赛选手从赛事面板凭密钥进入（enterTournamentMatch 会核验 pid），
    // 不能凭房间码直接加入——否则无关玩家可占掉仅有的两个座位、冒名顶替对阵结果。
    if (room.tournamentId) {
      return sendErr(ws, '这是赛事对局房间，请从赛事面板进入你的对阵');
    }
    const playerId = crypto.randomBytes(8).toString('hex');
    const { pid } = seasonLib.resolvePid(msg);
    const err = game.addPlayer(room, playerId, msg.name, pid);
    if (err) return sendErr(ws, err);
    const token = issueToken(room.code, playerId);
    ctx.playerId = playerId; ctx.roomCode = room.code;
    attachSocket(playerId, ws);
    ws.send(JSON.stringify({ type: 'joined', token, roomCode: room.code, playerId }));
    broadcast(room);
  },

  // 观战：凭房间码获得只读身份，任何阶段都可进入（大厅可看规则/玩家，对局中持续收推送）
  spectate(ws, ctx, msg) {
    const room = rooms.get(String(msg.roomCode || '').toUpperCase());
    if (!room) return sendErr(ws, '房间不存在，请检查房间码');
    const spectatorId = 'sp_' + crypto.randomBytes(8).toString('hex');
    const err = game.addSpectator(room, spectatorId, msg.name);
    if (err) return sendErr(ws, err);
    const token = issueToken(room.code, spectatorId, true);
    ctx.playerId = spectatorId; ctx.roomCode = room.code;
    attachSocket(spectatorId, ws);
    ws.send(JSON.stringify({ type: 'joined', token, roomCode: room.code,
      playerId: spectatorId, spectator: true }));
    broadcast(room);
  },

  // 断线重连：凭 token 恢复身份（玩家或观战者）。
  // 所有无法恢复的拒绝都带 context:'reconnect'，客户端据此停止自动恢复流程，
  // 展示"返回首页 / 重新输入房间码"入口，而不是无限重连或只弹一个会消失的 toast。
  reconnect(ws, ctx, msg) {
    const ref = tokens.get(msg.token);
    if (!ref) return sendErr(ws, '会话已失效，请重新加入', 'reconnect');
    const room = rooms.get(ref.roomCode);
    if (!room) return sendErr(ws, '房间已不存在', 'reconnect');
    if (ref.spectator) {
      const s = (room.spectators || []).find(x => x.id === ref.playerId);
      if (!s) return sendErr(ws, '观战会话已失效，请重新观战', 'reconnect');
      // 观战是临时只读会话：对局结束后不再凭 token 恢复。刷新页面应回到首页，
      // 想看结算/回放可重新输入房间码进入。移除记录并作废 token，避免旧会话残留。
      if (room.phase === 'ended') {
        cancelSpectatorPrune(s.id);
        game.removeSpectator(room, s.id);
        for (const [tok, r] of tokens) {
          if (r.spectator && r.playerId === s.id) tokens.delete(tok);
        }
        broadcast(room);
        return sendErr(ws, '对局已结束，观战会话已失效，请重新输入房间码观战', 'reconnect');
      }
      s.connected = true;
      cancelSpectatorPrune(s.id);
      ctx.playerId = s.id; ctx.roomCode = room.code;
      attachSocket(s.id, ws);
      ws.send(JSON.stringify({ type: 'joined', token: msg.token,
        roomCode: room.code, playerId: s.id, spectator: true }));
      broadcast(room);
      return;
    }
    const p = room.players.find(x => x.id === ref.playerId);
    if (!p) return sendErr(ws, '你不在该房间中', 'reconnect');
    p.connected = true;
    // 重连立即收回：兼容"直接掉线"（清 autoPilot、恢复托管暂停）与"掉线后服务器重启"
    // （autoPilot 已被清掉，但重启保留了 pausedRemaining）两条路径——统一恢复暂停点
    // 剩余时间、移交离线裁定者，并在需要时重新挂表。
    const resumed = game.resumeOnReconnect(room, ref.playerId);
    if (resumed && room.turn && room.turn.playerId === ref.playerId && room.turn.deadline) {
      game.applyTurnMsOverride(room, false);
      scheduleTurnTimer(room);
    }
    ctx.playerId = ref.playerId; ctx.roomCode = room.code;
    attachSocket(ref.playerId, ws);
    ws.send(JSON.stringify({ type: 'joined', token: msg.token,
      roomCode: room.code, playerId: ref.playerId }));
    broadcast(room);
  },

  // 重连成功后客户端显式拉取一次房间最新状态：断线期间可能错过多次广播，
  // 以这次同步作为"恢复完成"的确认信号，客户端收到后重新渲染并解除操作禁用。
  syncState(ws, ctx) {
    const room = ctxRoom(ctx);
    if (!room) return sendErr(ws, '房间已不存在', 'reconnect');
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'state', state: game.publicView(room, ctx.playerId) }));
    }
  },

    setRules(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    // 客户端会等待明确答复后才解除提交锁定，任何情况都要给出回应
    if (!room) return sendErr(ws, '房间已不存在', 'setRules');
    const err = game.setRuleSet(room, ctx.playerId, msg.ruleSet || {});
    if (err) return sendErr(ws, err, 'setRules');
    // 仅供自包含端到端冒烟使用的回合计时覆盖（毫秒）：不走 ruleSet、不影响界面规则，
    // 让"超时托管"用例如 80ms 完成，而不必等最短 30 秒。非有限正数一律忽略。
    const ov = msg.ruleSet && msg.ruleSet.__turnMsOverride;
    if (Number.isFinite(ov) && ov > 0) room._turnMsOverride = Math.max(20, Math.trunc(ov));
    // 明确告知保存方成功，客户端据此关闭编辑器并给出反馈
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'rulesSaved' }));
    broadcast(room);
  },

  // 主题词包：房主在大厅选用本机词包（内容作为快照进入房间状态，全员可见）；
  // 失败带上下文，客户端据此在词包选择处就地提示。
  setWordPack(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return sendErr(ws, '房间已不存在', 'setWordPack');
    const err = game.setWordPack(room, ctx.playerId, msg.pack ?? null);
    if (err) return sendErr(ws, err, 'setWordPack');
    broadcast(room);
  },

  // 词包分享：作者把本机词包快照存到服务端并拿到 8 位分享码（同一词包重复点分享沿用原码、
  // 更新快照）。身份与赛季同一道凭据：只认密钥派生出的 pid，取消分享时据此确认是作者本人。
  // msg.code 为可选的「更新本人已有码」提示：另一台设备导入了自己分享的词包后再更新，
  // 带上原码即可覆盖同一条分享而不是分裂出第二个码（库内再校验码确实属于本人）。
  sharePack(ws, ctx, msg) {
    const { pid } = seasonLib.resolvePid(msg);
    if (!pid) return sendErr(ws, '需要有效的本机身份才能分享词包', 'sharePack');
    const cleaned = game.sanitizeWordPack(msg.pack);
    if (typeof cleaned === 'string') return sendErr(ws, cleaned, 'sharePack');
    const result = sharesLib.publishForPack(shareStore, {
      pid, packId: cleaned.id, pack: cleaned, generate: makeShareCode,
      code: msg.code,
    });
    if (result.error) return sendErr(ws, result.error, 'sharePack');
    saveShares();
    if (ws.readyState === 1) {
      // 码提示更新时服务端保留了该码原 packId：回包里的 packId 以服务端实际条目为准，
      // 客户端据此把本机映射（而非请求里的新副本 id）记到正确的稳定 id 上。
      ws.send(JSON.stringify({
        type: 'shared', code: result.code, packId: result.packId || cleaned.id,
        name: cleaned.name, updatedAt: result.updatedAt, republished: result.updated,
      }));
    }
  },

  // 取消分享：只有码的作者（同一 pid）能作废；成功后码立即失效，朋友凭旧码无法再导入。
  unsharePack(ws, ctx, msg) {
    const { pid } = seasonLib.resolvePid(msg);
    if (!pid) return sendErr(ws, '需要有效的本机身份才能取消分享', 'unsharePack');
    const ok = sharesLib.unpublish(shareStore, msg.code, pid);
    if (!ok) return sendErr(ws, '分享码无效，或你不是这个分享的作者', 'unsharePack');
    saveShares();
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'unshared', code: sharesLib.normalizeCode(msg.code) }));
    }
  },

  // 朋友凭码导入：只读公开端点，无需加入任何房间；返回的词包不带作者信息、
  // 带服务端原始 packId，客户端据此生成本机副本并去重。
  importShare(ws, ctx, msg) {
    const code = sharesLib.normalizeCode(msg.code);
    if (!sharesLib.isValidCode(code)) {
      return sendErr(ws, '分享码应为 8 位字母数字，请检查后重试', 'importShare');
    }
    const entry = sharesLib.getShare(shareStore, code);
    if (!entry) return sendErr(ws, '分享码无效或已被作者取消', 'importShare');
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'sharedPack', code,
        pack: { id: entry.packId, ...entry.pack } }));
    }
  },

  // 我的分享列表（本机身份下全部有效码）：客户端进入「我的词包」时拉取并与本机映射对账，
  // 跨设备分享的词包也能看到/取消；服务端已取消的码不返回，客户端据此清掉本机残留。
  myShares(ws, ctx, msg) {
    const { pid } = seasonLib.resolvePid(msg);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'myShares', shares: pid ? sharesLib.listByOwner(shareStore, pid) : [] }));
    }
  },

  // ---------- 交流广场 ----------

  // 发布到广场：作者把本机词包快照公开到广场（同一词包重复发布沿用原条目、更新快照，
  // 订阅数保留）。身份与赛季/分享同一道凭据：只认密钥派生出的 pid。
  // msg.id 为可选的「更新本人已有条目」提示：另一台设备订阅了自己发布的词包后再更新，
  // 带上原条目 id 即覆盖同一条目而不是分裂出第二条（库内再校验条目确实属于本人）。
  plazaPublish(ws, ctx, msg) {
    const { pid } = seasonLib.resolvePid(msg);
    if (!pid) return sendErr(ws, '需要有效的本机身份才能发布到广场', 'plazaPublish');
    const cleaned = game.sanitizeWordPack(msg.pack);
    if (typeof cleaned === 'string') return sendErr(ws, cleaned, 'plazaPublish');
    const result = plazaLib.publish(plazaStore, {
      pid, packId: cleaned.id, pack: cleaned, author: msg.author, generate: makePlazaId,
      id: msg.id,
    });
    if (result.error) return sendErr(ws, result.error, 'plazaPublish');
    savePlaza();
    if (ws.readyState === 1) {
      // 条目 id 提示更新时服务端保留了该条目原 packId：回包以服务端实际条目为准，
      // 客户端据此把本机映射记到正确的稳定 id 上。
      ws.send(JSON.stringify({
        type: 'plazaPublished', id: result.id, packId: result.packId || cleaned.id,
        name: cleaned.name, updatedAt: result.updatedAt, republished: result.republished,
      }));
    }
  },

  // 下架：只有发布者本人（同一 pid）能撤下；成功后该词包立即从广场消失，
  // 已订阅到别人本机的副本不受影响。
  plazaUnpublish(ws, ctx, msg) {
    const { pid } = seasonLib.resolvePid(msg);
    if (!pid) return sendErr(ws, '需要有效的本机身份才能下架', 'plazaUnpublish');
    const ok = plazaLib.unpublish(plazaStore, msg.id, pid);
    if (!ok) return sendErr(ws, '广场上没有这个词包，或你不是发布者', 'plazaUnpublish');
    savePlaza();
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'plazaUnpublished', id: String(msg.id || '') }));
    }
  },

  // 广场列表（公开只读，无需加入任何房间）：按热度/最新排序的摘要（含候选词预览，
  // 不回全文）。客户端随请求带上本机密钥，服务端派生 myPid 用于标出"我发布的"，
  // 客户端据此在自己的条目上显示下架入口。
  plazaList(ws, ctx, msg) {
    const sort = msg.sort === 'new' ? 'new' : 'hot';
    const { pid } = seasonLib.resolvePid(msg);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'plazaList', sort,
        packs: plazaLib.summaries(plazaStore, { myPid: pid, sort }) }));
    }
  },

  // 订阅：公开端点；返回词包快照供客户端存进本机词包（建房时与自建词包一样选用）。
  // 同一身份只计一次热度；无有效身份也能拿到词包，只是不计数。
  plazaSubscribe(ws, ctx, msg) {
    const { pid } = seasonLib.resolvePid(msg);
    const result = plazaLib.subscribe(plazaStore, msg.id, pid, Date.now());
    if (result.error) return sendErr(ws, result.error, 'plazaSubscribe');
    if (result.counted) savePlaza();
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'plazaPack', id: result.id,
        pack: { id: result.packId, ...result.pack }, subscribers: result.subscribers }));
    }
  },

  // 我的广场发布列表：客户端进入「我的词包」时拉取并与本机映射对账，
  // 跨设备发布的词包也能看到/下架；服务端已下架的条目不返回，客户端据此清掉本机残留。
  myPlaza(ws, ctx, msg) {
    const { pid } = seasonLib.resolvePid(msg);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'myPlaza', packs: pid ? plazaLib.listByOwner(plazaStore, pid) : [] }));
    }
  },

  startGame(ws, ctx) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.startGame(room, ctx.playerId);
    if (err) return sendErr(ws, err);
    game.applyTurnMsOverride(room); // 测试用短计时覆盖（生产房间为空操作）
    scheduleTurnTimer(room);
    broadcast(room);
  },

  play(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.playWord(room, ctx.playerId, msg);
    if (err) return sendErr(ws, err);
    broadcast(room);
  },

  reinforce(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.reinforce(room, ctx.playerId, msg.nodeId);
    if (err) return sendErr(ws, err);
    broadcast(room);
  },

  endTurn(ws, ctx) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.endTurn(room, ctx.playerId);
    if (err) return sendErr(ws, err);
    game.applyTurnMsOverride(room);
    scheduleTurnTimer(room);
    broadcast(room);
  },

  challenge(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.challenge(room, ctx.playerId, msg.nodeId);
    if (err) return sendErr(ws, err);
    clearTimeout(turnTimers.get(room.code)); // 计时已暂停
    broadcast(room);
  },

  resolve(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.resolveChallenge(room, ctx.playerId, msg.verdict);
    if (err) return sendErr(ws, err);
    game.applyTurnMsOverride(room, false);
    scheduleTurnTimer(room); // 恢复计时
    broadcast(room);
  },

  replay(ws, ctx) {
    const room = ctxRoom(ctx);
    if (!room) return;
    if (room.phase !== 'ended') return sendErr(ws, '游戏结束后才能回放');
    sendTo(ctx.playerId, { type: 'replay', frames: game.buildReplay(room) });
  },

  // 历史与战绩：客户端凭本地保存的玩家 token 列表，换取每个房间的战绩摘要。
  // 观战 token 是临时只读身份，不纳入历史；失效 token（房间已删/数据已清）静默跳过，
  // 客户端按"只保留服务器认得的 token"顺势清理本地记录。
  history(ws, ctx, msg) {
    const list = Array.isArray(msg.tokens) ? msg.tokens.slice(0, 50) : [];
    const entries = [];
    for (const token of list) {
      const ref = tokens.get(token);
      if (!ref || ref.spectator) continue;
      const room = rooms.get(ref.roomCode);
      if (!room) continue;
      const summary = game.historySummary(room, ref.playerId);
      if (summary) entries.push({ token, ...summary });
    }
    entries.sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt));
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'history', entries }));
  },

  // 赛季排行榜（公开，只读，无需任何身份/房间）：支持按总分/胜场/胜率排序。
  // 任何已建立连接的客户端都能拉取——首页排行榜入口不依赖玩家是否在房间内。
  // 客户端可随请求带上本机密钥（与建房/个人页同一把，只在内存里单向派生、不落库），
  // 服务端在响应里回 myPid，用于客户端高亮"我"那一行、置顶显示我的汇总。
  leaderboard(ws, ctx, msg) {
    const sort = ['total', 'wins', 'rate'].includes(msg.sort) ? msg.sort : 'total';
    rolloverIfDue(); // 打开排行榜即感知新赛季（即便新赛季一局都还没打，空榜也属于新赛季）
    const rows = seasonLib.leaderboard(season, { sort });
    const { pid: myPid } = seasonLib.resolvePid(msg);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'leaderboard', sort,
        season: season.season, startedAt: season.startedAt,
        seasons: seasonMeta(season),
        rows, myPid: myPid || null }));
    }
  },

  // 个人页（公开，只读）：可凭公开 pid（点排行榜某行）或本人密钥（"我的战绩"）查看
  // 当前赛季的场次/胜场/平局/平均得分/最高连锁，以及各历史赛季的冻结名次（seasons）。
  // 密钥经单向哈希换成 pid 后再查，密钥本身不落库。
  profile(ws, ctx, msg) {
    rolloverIfDue();
    const { pid } = seasonLib.resolvePid(msg);
    const target = pid || (seasonLib.isValidPid(msg.pid) ? msg.pid : null);
    if (!target) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'profile', profile: null }));
      return;
    }
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'profile', season: season.season,
        profile: seasonLib.getProfile(season, target) }));
    }
  },

  // ---------- 跨房间赛事 ----------

  // 创建赛事（房主=创作者）。规则白名单随赛事快照，之后每个对阵房间都用同一份规则。
  tournamentCreate(ws, ctx, msg) {
    sweepTournaments();
    const { pid } = seasonLib.resolvePid(msg);
    if (!pid) return sendErr(ws, '需要有效的本机身份才能创建赛事', 'tournament');
    const result = tournamentLib.createTournament(tournamentStore, {
      hostPid: pid,
      hostName: seasonLib.isValidPid(pid) ? String(msg.name || '房主').slice(0, 12) : '房主',
      name: msg.tournamentName,
      registerMs: Number.isFinite(Number(msg.registerMs)) ? Number(msg.registerMs) : undefined,
      matchWaitMs: MATCH_WAIT_MS,
      rules: msg.rules || {},
      packName: typeof msg.packName === 'string' ? String(msg.packName).slice(0, 24) : null,
      generate: makeTournamentId,
    });
    if (result.error) return sendErr(ws, result.error, 'tournament');
    saveTournaments();
    const view = tournamentLib.tournamentView(result.tournament, pid);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'tournamentCreated', tournament: view }));
  },

  // 赛事列表（公开只读）。带上密钥时回 myPid 与我在每场赛事里的状态，用于高亮/进入。
  tournamentList(ws, ctx, msg) {
    sweepTournaments();
    const { pid } = seasonLib.resolvePid(msg);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'tournamentList',
        tournaments: tournamentLib.summaries(tournamentStore, pid, Date.now()),
        myPid: pid || null }));
    }
  },

  // 订阅某场赛事的实时推送（报名/对阵/晋级变化）。返回完整视图并把该连接登记为观众。
  tournamentWatch(ws, ctx, msg) {
    const id = String(msg.tournamentId || '');
    const { pid } = seasonLib.resolvePid(msg);
    const t = tournamentLib.getTournament(tournamentStore, id);
    if (!t) return sendErr(ws, '赛事不存在或已删除', 'tournament');
    if (pid) watchTournament(ws, pid);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'tournament',
        tournament: tournamentLib.tournamentView(t, pid) }));
    }
  },

  tournamentRegister(ws, ctx, msg) {
    sweepTournaments();
    const id = String(msg.tournamentId || '');
    const { pid } = seasonLib.resolvePid(msg);
    if (!pid) return sendErr(ws, '需要有效的本机身份才能报名', 'tournament');
    const r = tournamentLib.register(tournamentStore, id, {
      pid, name: msg.name, now: Date.now() });
    if (r.error) return sendErr(ws, r.error, 'tournament');
    saveTournaments();
    broadcastTournament(id);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'tournamentRegistered' }));
  },

  tournamentWithdraw(ws, ctx, msg) {
    const id = String(msg.tournamentId || '');
    const { pid } = seasonLib.resolvePid(msg);
    if (!pid) return sendErr(ws, '需要有效的本机身份', 'tournament');
    const r = tournamentLib.withdraw(tournamentStore, id, pid, Date.now());
    if (r.error) return sendErr(ws, r.error, 'tournament');
    saveTournaments();
    broadcastTournament(id);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'tournamentWithdrawn' }));
  },

  // 房主提前开赛（到点也会被 sweep 自动开赛）
  tournamentStart(ws, ctx, msg) {
    sweepTournaments();
    const id = String(msg.tournamentId || '');
    const { pid } = seasonLib.resolvePid(msg);
    const r = tournamentLib.startBracket(tournamentStore, id, {
      hostPid: pid, now: Date.now() });
    if (r.error) return sendErr(ws, r.error, 'tournament');
    saveTournaments();
    broadcastTournament(id);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'tournamentStarted' }));
  },

  tournamentCancel(ws, ctx, msg) {
    const id = String(msg.tournamentId || '');
    const { pid } = seasonLib.resolvePid(msg);
    const r = tournamentLib.cancel(tournamentStore, id, pid, Date.now());
    if (r.error) return sendErr(ws, r.error, 'tournament');
    saveTournaments();
    broadcastTournament(id);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'tournamentCancelled' }));
  },

  // 选手进入当前对阵（惰性开房、核验 pid、两人到齐自动开局，详见 enterTournamentMatch）
  tournamentEnter(ws, ctx, msg) {
    sweepTournaments();
    enterTournamentMatch(ws, ctx, msg);
  },

  // 选手在等待开赛期间弃权：对手直接晋级
  tournamentForfeit(ws, ctx, msg) {
    sweepTournaments();
    const id = String(msg.tournamentId || '');
    const { pid } = seasonLib.resolvePid(msg);
    if (!pid) return sendErr(ws, '需要有效的本机身份', 'tournament');
    const r = tournamentLib.forfeit(tournamentStore, id, pid, Date.now());
    if (r.error) return sendErr(ws, r.error, 'tournament');
    if (r.match && r.match.roomCode) retireMatchRoom(r.match.roomCode);
    saveTournaments();
    broadcastTournament(id);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'tournamentForfeited' }));
  },

  // 房主宣布异常重赛（下一轮公示/开打前）
  tournamentRematch(ws, ctx, msg) {
    sweepTournaments();
    const id = String(msg.tournamentId || '');
    const { pid } = seasonLib.resolvePid(msg);
    const r = tournamentLib.hostRematch(tournamentStore, id, msg.matchId, pid, Date.now());
    if (r.error) return sendErr(ws, r.error, 'tournament');
    // 旧场房间作废（已计入赛季的旧局战绩保留）
    if (r.oldMatch && r.oldMatch.roomCode) retireMatchRoom(r.oldMatch.roomCode);
    saveTournaments();
    broadcastTournament(id);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'tournamentRematch', matchId: r.match.id }));
  },
};

function ctxRoom(ctx) {
  const room = rooms.get(ctx.roomCode);
  if (!room) return null;
  return room;
}

// 纵深防御：game.js 内已按身份拒绝所有写操作，这里在协议层统一拦截，
// 保证观战 token 即使伪造消息也无法接词、加固、质疑、改规则或开始游戏。
const SPECTATOR_FORBIDDEN = new Set([
  'setRules', 'setWordPack', 'startGame', 'play', 'reinforce', 'endTurn', 'challenge', 'resolve',
]);

function sendErr(ws, message, context) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message, context }));
}

// ---------- HTTP + WS ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wssRef = { current: null };
function attachWebSocketServer() {
  // 每次启动创建新的 WebSocketServer：ws 的 close() 会移除 http server 上的 upgrade
  // 监听器，若复用旧实例，进程内 stop→start 后新连接握手只会拿到 HTTP 200。
  const wss = new WebSocketServer({ server });
  wssRef.current = wss;
  wss.on('connection', (ws) => {
    const ctx = { playerId: null, roomCode: null };
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const h = handlers[msg.type];
      if (h) {
        if (SPECTATOR_FORBIDDEN.has(msg.type) && ctx.playerId) {
          const r0 = rooms.get(ctx.roomCode);
          if (r0 && game.isSpectator(r0, ctx.playerId)) {
            return sendErr(ws, '观战者为只读，不能参与对局');
          }
        }
        try { h(ws, ctx, msg); }
        catch (e) { console.error(e); sendErr(ws, '服务器开小差了，请重试'); }
      }
    });
    ws.on('close', () => {
      unwatchTournament(ws);
      if (ctx.playerId) detachSocket(ctx.playerId, ws);
    });
  });
}

// ---------- 启动 / 停止 ----------
// 默认直接运行时照常监听 8080；测试可 require 本模块后在临时端口上自启、跑完即停，
// 这样 `node --test`（会执行 test/ 下所有 .js，含 e2e.js）不再依赖外部先启动服务器。

function startServer(port = PORT) {
  return new Promise((resolve) => {
    shuttingDown = false; // 同一进程内 stop→start（测试场景）：恢复防抖写盘
    // 先恢复赛季战绩：恢复房间时若发现结束房漏记，清理前可兜底补记进赛季
    loadSeason();
    loadRooms();
    // 启动时若当前赛季窗口早已结束：漏记的结束房已随 loadRooms 对账/清理补进老赛季，
    // 此刻冻结归档、开新赛季（随后周期任务与各类请求还会惰性复查）。
    rolloverIfDue();
    loadShares();
    loadPlaza();
    loadTournaments();
    scheduleRoomPruning();
    attachWebSocketServer();
    server.listen(port, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : port, stop: stopServer });
    });
  });
}

function stopServer() {
  shuttingDown = true; // 此后在途广播/回调不再重新挂防抖写盘（最终状态下面立即 flush）
  // 停掉所有定时器，避免保存防抖/回合/观战清理等句柄让进程挂住
  clearTimeout(saveTimer);
  clearTimeout(seasonSaveTimer);
  clearTimeout(sharesSaveTimer);
  clearTimeout(plazaSaveTimer);
  clearTimeout(tournamentSaveTimer);
  for (const t of turnTimers.values()) clearTimeout(t);
  for (const t of spectatorPruneTimers.values()) clearTimeout(t);
  if (roomPruneTimer) clearInterval(roomPruneTimer);
  turnTimers.clear();
  spectatorPruneTimers.clear();
  tournamentWatchers.clear();
  flushRooms();  // 房间/回放/token 可能还在防抖队列里，停服前原子落盘
  flushSeason(); // 最后一局战绩可能还在防抖队列里，停服前立即落盘
  flushShares(); // 最后一个分享同理
  flushPlaza();  // 最后一次广场发布/订阅同理
  flushTournaments(); // 赛事对阵树/报名同理
  const wss = wssRef.current;
  wssRef.current = null;
  return new Promise((resolve) => {
      const done = () => server.close(() => resolve());
      if (wss) wss.close(done); else done();
      // wss.close 只等正常关闭；强制终结仍在打开的连接（e2e 里有 ws.close 竞态）
      if (wss) for (const client of wss.clients) {
        try { client.terminate(); } catch { /* 已关闭 */ }
      }
    });
}

module.exports = { startServer, stopServer };

// 仅在被直接执行时启动服务（被测试 require 时不自启、不占用 8080）
if (require.main === module) {
  startServer(PORT).then(({ port, stop }) => {
    console.log(`词语领地服务器已启动: http://localhost:${port}`);
    // 容器/部署的常规停机是 SIGTERM，Ctrl-C 是 SIGINT：走与测试一致的优雅停机，
    // 把 300ms 防抖窗口内未落盘的房间/赛季/分享/广场全部原子刷盘，再退出。
    // 这样即便刚结束一局就收到停机信号，战绩与房间也已同步在磁盘上，不依赖重启补记。
    let stopping = false;
    const shutdown = (sig) => {
      if (stopping) return;
      stopping = true;
      console.log(`收到 ${sig}，正在落盘并关闭…`);
      stop().then(() => process.exit(0), () => process.exit(1));
      // 兜底：落盘/关连异常卡住时不无限挂住（此时 stop 内已尝试同步 flush）
      setTimeout(() => process.exit(1), 5000).unref?.();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  });
}
