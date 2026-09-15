'use strict';
// 赛季战绩 —— 纯逻辑状态（无任何 IO），服务端与测试共用。
//
// 玩家完成对局后，服务端从已结束的房间里为每名玩家汇总一条"可公开展示"的赛季记录：
// 场次、胜场、平局、总得分、平均得分、最高连锁、最近对局时间。排行榜据此排序，
// 个人页据此展示汇总。
//
// 赛季归档与切换：
// - 一个赛季持续固定时长（服务端 WT_SEASON_MS，默认 30 天；0/负值表示不自动切换）。
//   到期时 rolloverSeason 把当前赛季冻结成快照推进 history（快照带冻结时刻的总分榜名次，
//   之后永不重排），并开一个 players 清零的新赛季重新累计；没有任何对局的空赛季不归档。
// - 逐局计入索引 recordedRooms 是【跨赛季全局】的：与玩家汇总同档但不属于任何一个赛季，
//   一个房间 key 一旦在索引里，无论何时都不可能再被计入第二遍——赛季切换只重置 players，
//   不清空索引，这是"已有战绩档案平滑迁移、不重复计分"的根本保证。
//
// 身份与防伪：公开的玩家标识 pid 不是客户端自报的，而是由服务端从客户端持有的
// 随机密钥派生——pid = sha256(pidSecret)。客户端在建房/加入时提交的是 pidSecret，
// 服务端据此算出 pid。这样只有持有某把密钥的人才能认领对应的 pid：排行榜公开的只是
// pid（密钥的单向哈希），别人看到 pid 也无法反推出密钥、更无法把自己的对局记到别人
// 名下，杜绝"冒用他人公开标识污染战绩"。观战是临时只读身份，从不参与对局，不进战绩。

const crypto = require('crypto');
const game = require('./game');
// 成就徽章定义与判定是浏览器/服务端共用的纯逻辑（见 public/achievements.js）：
// 徽章全部读时派生，赛季存档不增加字段。
const achievements = require('./public/achievements');

// pidSecret：32 字节随机数的十六进制串（64 位），只存在玩家自己浏览器里，永不上榜
const PID_SECRET_RE = /^[a-f0-9]{64}$/;
// pid：密钥的 sha256 十六进制摘要（64 位），可公开（排行榜/个人页/房间内）
const PID_RE = /^[a-f0-9]{64}$/;
const SORTS = new Set(['total', 'wins', 'rate']);

// 档案版本：
// 1 —— 最初版（无 version、无逐局索引，加载时一次性对账补索引）；
// 2 —— 引入逐局计入索引 recordedRooms；
// 3 —— 赛季归档：当前赛季 + history 冻结快照；recordedRooms 升级为跨赛季全局索引。
const ARCHIVE_VERSION = 3;

// 由玩家密钥派生公开标识：pid = sha256(secret)。非法密钥返回 null（调用方据此拒绝/匿名）
function derivePid(secret) {
  if (typeof secret !== 'string' || !PID_SECRET_RE.test(secret)) return null;
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function isValidPid(pid) { return typeof pid === 'string' && PID_RE.test(pid); }
function isValidPidSecret(secret) { return typeof secret === 'string' && PID_SECRET_RE.test(secret); }

// 统一解析身份凭据：优先认密钥（派生出 pid），密钥非法时不接受任何自报 pid，
// 避免"直接提交别人的 pid"这种冒用。返回 { pid } 或 { pid: null }（匿名/不进战绩）。
function resolvePid({ pid, pidSecret } = {}) {
  if (isValidPidSecret(pidSecret)) return { pid: derivePid(pidSecret) };
  return { pid: null };
}

function emptySeason(now = Date.now(), seasonNo = 1) {
  return {
    version: ARCHIVE_VERSION,
    // 当前赛季序号（从 1 起）与开始时间；归档后新赛季序号 +1
    season: Math.max(1, Math.trunc(seasonNo) || 1),
    startedAt: now,
    players: {},
    // 跨赛季全局逐局计入索引：{ [roomKey]: endedAt }。它是"某一局是否已计入赛季"的
    // 唯一凭据：房间上的 seasonRecorded 标记只证明当时内存里计过，不能证明已落进赛季
    // 文件（写盘有 300ms 防抖，进程被杀/写盘失败会丢）。清理房间前必须查这里而不是房间
    // 标记；切赛季也绝不清空它——否则同一局会在新赛季被再算一遍。
    recordedRooms: {},
    // 已冻结的历史赛季（最新在前）：
    // { season, startedAt, endedAt, players: { [pid]: { ...汇总, rank } } }
    // rank 是冻结瞬间按总分榜算出的名次，之后该赛季不再有新对局，名次永不变化。
    history: [],
  };
}

// 规范化一条玩家赛季汇总（当前赛季与冻结快照共用）：补零缺字段、丢弃非法 pid。
function normalizePlayer(pid, p) {
  if (!PID_RE.test(pid) || !p || typeof p !== 'object') return null;
  return {
    pid,
    name: String(p.name || '玩家').slice(0, 12),
    games: Math.max(0, Math.trunc(Number(p.games) || 0)),
    wins: Math.max(0, Math.trunc(Number(p.wins) || 0)),
    ties: Math.max(0, Math.trunc(Number(p.ties) || 0)),
    totalScore: Math.max(0, Math.trunc(Number(p.totalScore) || 0)),
    bestChain: Math.max(0, Math.trunc(Number(p.bestChain) || 0)),
    lastAt: Math.max(0, Math.trunc(Number(p.lastAt) || 0)),
  };
}

// 一帧冻结赛季快照的规范化（历史档可能损坏，任何一帧坏掉不影响其他赛季与当前赛季）。
function normalizeFrozen(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const season = Math.max(1, Math.trunc(Number(raw.season)) || 0);
  if (!season) return null;
  const players = {};
  const psrc = raw.players && typeof raw.players === 'object' ? raw.players : {};
  for (const [pid, p] of Object.entries(psrc)) {
    const row = normalizePlayer(pid, p);
    if (!row || row.games <= 0) continue; // 冻结快照里不该有空玩家，脏数据直接丢
    // 冻结名次：缺失/非法时读时用总分榜重算（旧档兼容），否则固化
    const rank = Math.trunc(Number(p.rank));
    row.rank = rank > 0 ? rank : null;
    players[pid] = row;
  }
  if (!Object.keys(players).length) return null;
  return {
    season,
    startedAt: Math.max(0, Math.trunc(Number(raw.startedAt)) || 0),
    endedAt: Math.max(0, Math.trunc(Number(raw.endedAt)) || 0),
    players,
  };
}

// 从（可能损坏的）赛季文件恢复。
// 返回 { season, legacy }：legacy=true 表示这是没有逐局索引的旧版（v1）档案——
// 升级前结束的房间本来就都已在该档案里，调用方据此做一次性对账（用 markRoomRecorded
// 只建索引、不重算战绩）。v2 起一律以索引为准（房间上的标记不再可信）。
//
// v3 迁移：v1/v2 档案没有赛季概念，整体平滑升级为"第 1 赛季"——players 与索引原样保留，
// 一场都不重算；已有的 history（若有）逐帧规范化，按赛季序号去重/排序。
function normalizeSeason(raw, now = Date.now()) {
  const srcSeason = Math.max(1, Math.trunc(Number(raw && raw.season)) || 1);
  const season = emptySeason(Number(raw && raw.startedAt) || now, srcSeason);
  let legacy = false;
  if (raw && typeof raw === 'object') {
    const version = Number(raw.version) || 1;
    legacy = version < 2;
    const index = raw.recordedRooms && typeof raw.recordedRooms === 'object'
      ? raw.recordedRooms : null;
    if (index) {
      for (const [key, at] of Object.entries(index)) {
        const t = Number(at);
        if (typeof key === 'string' && key && Number.isFinite(t) && t > 0) {
          season.recordedRooms[key] = Math.trunc(t);
        }
      }
    }
    const hist = Array.isArray(raw.history) ? raw.history : [];
    const seen = new Set();
    for (const h of hist) {
      const f = normalizeFrozen(h);
      // 序号重复/非法的脏帧丢弃，避免个人页出现两个"第 N 赛季"
      if (!f || seen.has(f.season)) continue;
      seen.add(f.season);
      season.history.push(f);
    }
    // 最新冻结的赛季在前；序号不得与当前赛季撞号
    season.history.sort((a, b) => b.season - a.season);
  }
  const entries = raw && typeof raw === 'object' && raw.players && typeof raw.players === 'object'
    ? Object.entries(raw.players) : [];
  for (const [pid, p] of entries) {
    const row = normalizePlayer(pid, p);
    if (row) season.players[pid] = row;
  }
  return { season, legacy };
}

// 由一名玩家的赛季原始记录派生展示用汇总（平均得分、胜率、负场均为派生值，不入库）
function aggregate(stat) {
  const games = stat.games;
  return {
    games,
    wins: stat.wins,
    ties: stat.ties,
    losses: Math.max(0, games - stat.wins - stat.ties),
    totalScore: stat.totalScore,
    avgScore: games ? Math.round((stat.totalScore / games) * 10) / 10 : 0,
    bestChain: stat.bestChain,
    winRate: games ? stat.wins / games : 0,
    lastAt: stat.lastAt,
  };
}

// 某一局是否已计入【任意】赛季——以全局逐局索引为准，而不是房间上的标记。
// 房间清理前必须先用它确认，防止"内存里计过、但赛季文件没落盘"的对局被直接删掉。
function isRoomRecorded(season, room) {
  if (!season || !season.recordedRooms || !room) return false;
  return Object.prototype.hasOwnProperty.call(season.recordedRooms, game.roomKey(room));
}

// 只把一局登记进全局索引、不累计任何玩家战绩。旧版（v1，无索引）赛季档升级时用：
// 那些历史对局的玩家汇总早已在档案里，重新算一遍会重复累计；登记索引后它们就与
// 新房享受同一套"只认索引"的规则。返回 true 表示索引新增了条目（需要落盘）。
function markRoomRecorded(season, room, now = Date.now()) {
  if (!season.recordedRooms) season.recordedRooms = {};
  if (!room || room.phase !== 'ended') return false;
  const key = game.roomKey(room);
  if (Object.prototype.hasOwnProperty.call(season.recordedRooms, key)) return false;
  season.recordedRooms[key] = room.endedAt || room.createdAt || now;
  room.seasonRecorded = true;
  return true;
}

// 把一个已结束房间计入【当前】赛季。每个房间只计一次：幂等凭据是跨赛季的全局逐局
// 索引（recordedRooms），不依赖房间上的 seasonRecorded 标记——标记可能在赛季写盘前
// 随重启残留/丢失，索引与玩家汇总同属一个文件，要么一起在、要么一起不在；切赛季只清
// players 不清索引，所以上一赛季计过的局也绝不可能在新赛季再计一遍。
// 返回 { changed, recorded }：recorded 为本次实际计入的玩家数；changed 表示赛季有变化
// （新登记一局，即使该局没有任何可计入的 pid 也算——索引条目本身需要落盘）。
function recordRoom(season, room, now = Date.now()) {
  if (!season.players) season.players = {};
  if (!season.recordedRooms) season.recordedRooms = {};
  if (!room || room.phase !== 'ended') return { changed: false, recorded: 0 };
  if (isRoomRecorded(season, room)) {
    room.seasonRecorded = true; // 索引里已有：内存标记与档案对齐
    return { changed: false, recorded: 0 };
  }
  const scores = game.computeScores(room);
  const scoreOf = new Map(scores.map(s => [s.playerId, s]));
  let recorded = 0;
  for (const p of room.players) {
    if (!isValidPid(p.pid)) continue;
    const row = scoreOf.get(p.id);
    if (!row) continue;
    const stat = season.players[p.pid] || {
      pid: p.pid, name: p.name, games: 0, wins: 0, ties: 0,
      totalScore: 0, bestChain: 0, lastAt: 0,
    };
    // 昵称以最近一局为准
    stat.name = p.name;
    stat.games += 1;
    if (room.winner === p.id) stat.wins += 1;
    else if (!room.winner) stat.ties += 1; // 平局（并列最高分）：人人算平、无人算负
    stat.totalScore += row.total;
    stat.bestChain = Math.max(stat.bestChain, row.longestChain || 0);
    stat.lastAt = room.endedAt || now;
    season.players[p.pid] = stat;
    recorded += 1;
  }
  season.recordedRooms[game.roomKey(room)] = room.endedAt || now;
  room.seasonRecorded = true;
  return { changed: true, recorded };
}

// 三种排序都有稳定的次级依据，同分同胜场时顺序不抖动：
// total 总分→胜场→场次→昵称→pid；wins 胜场→场次→总分→…；rate 胜率→场次→总分→…
function compareRows(a, b, sort) {
  const byName = () => a.name.localeCompare(b.name, 'zh-Hans-CN') || a.pid.localeCompare(b.pid);
  if (sort === 'wins') {
    return b.wins - a.wins || b.games - a.games || b.totalScore - a.totalScore || byName();
  }
  if (sort === 'rate') {
    return b.winRate - a.winRate || b.games - a.games || b.totalScore - a.totalScore || byName();
  }
  return b.totalScore - a.totalScore || b.wins - a.wins || b.games - a.games || byName();
}

// 排行榜：当前赛季内所有有已结束对局的玩家，按指定维度排序并附上名次。
function leaderboard(season, opts = {}) {
  const sort = SORTS.has(opts.sort) ? opts.sort : 'total';
  const rows = Object.values(season.players || {}).map(stat => ({
    pid: stat.pid, name: stat.name, ...aggregate(stat),
  }));
  rows.sort((a, b) => compareRows(a, b, sort));
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

// 冻结当前赛季：把当前 players 连同冻结瞬间的总分榜名次快照进 history，返回推入的帧。
// 调用方只应在 rolloverSeason 内调用；导出仅供测试直接构造历史档。
// 没有任何玩家完成过对局的赛季不产生快照（返回 null），避免个人页挂一串空赛季。
function freezeSeason(season, endedAt = Date.now()) {
  const ranks = new Map(leaderboard(season, { sort: 'total' }).map(r => [r.pid, r.rank]));
  const players = {};
  for (const stat of Object.values(season.players || {})) {
    if (stat.games <= 0) continue;
    players[stat.pid] = { ...stat, rank: ranks.get(stat.pid) ?? null };
  }
  if (!Object.keys(players).length) return null;
  return {
    season: season.season,
    startedAt: season.startedAt,
    endedAt: Math.trunc(endedAt),
    players,
  };
}

// 赛季是否已到切换时刻。seasonMs 为赛季时长（毫秒）：0/负值/非正数表示永不自动切换。
// 以当前赛季 startedAt 为边界（第 N 个赛季窗口 [startedAt, startedAt+seasonMs)），
// 不用 now 反推赛季序号——服务停机很久也只冻结一次、直接开"下一号"，不会凭空归档一串空赛季。
function seasonDue(season, seasonMs, now = Date.now()) {
  if (!(seasonMs > 0)) return false;
  return now >= season.startedAt + seasonMs;
}

// 到期切换：把当前赛季冻结进 history（空赛季不归档），开一个 players 清零的新赛季。
// 全局逐局计入索引原样保留——这是切赛季不重复计分的关键。
// 返回 { rolledOver, frozen }：rolledOver 为本次是否发生切换（frozen 为冻结帧或 null）。
function rolloverSeason(season, seasonMs, now = Date.now()) {
  if (!seasonDue(season, seasonMs, now)) return { rolledOver: false, frozen: null };
  const frozen = freezeSeason(season, now);
  if (frozen) season.history.unshift(frozen);
  const nextNo = (frozen ? frozen.season : season.season) + 1;
  season.season = nextNo;
  season.startedAt = Math.trunc(now);
  season.players = {};
  return { rolledOver: true, frozen };
}

// 某 pid 的各赛季名次列表（个人页用）：当前赛季在前（进行中，rank 为实时总分榜名次），
// 其后按赛季序号倒序排列已冻结赛季（rank 是冻结快照，永不变化）。
// 该 pid 在某赛季没有对局（games 为 0）的赛季不出现；无任何记录返回 []。
function playerSeasons(season, pid) {
  if (!isValidPid(pid)) return [];
  const out = [];
  const cur = (season.players || {})[pid];
  if (cur && cur.games > 0) {
    const ranked = leaderboard(season, { sort: 'total' }).find(r => r.pid === pid);
    out.push({
      season: season.season, current: true, name: cur.name,
      startedAt: season.startedAt, endedAt: null,
      rank: ranked ? ranked.rank : null, ...aggregate(cur),
    });
  }
  for (const h of season.history || []) {
    const row = h.players[pid];
    if (!row) continue;
    // 冻结名次缺失（旧档）时按该帧快照现算一次
    let rank = row.rank;
    if (rank == null) {
      const board = frozenLeaderboard(h, 'total');
      rank = (board.find(r => r.pid === pid) || {}).rank ?? null;
    }
    out.push({
      season: h.season, current: false, name: row.name,
      startedAt: h.startedAt, endedAt: h.endedAt,
      rank, ...aggregate(row),
    });
  }
  return out;
}

// 历史冻结赛季的榜单（个人页/未来的历史榜用）：rank 用冻结值，缺失时按快照重算补齐。
function frozenLeaderboard(frozen, sort = 'total') {
  const rows = Object.values(frozen.players || {}).map(stat => ({
    pid: stat.pid, name: stat.name, ...aggregate(stat),
  }));
  rows.sort((a, b) => compareRows(a, b, SORTS.has(sort) ? sort : 'total'));
  const totalRank = new Map(
    rows.slice().sort((a, b) => compareRows(a, b, 'total')).map((r, i) => [r.pid, i + 1]));
  return rows.map((r, i) => ({
    ...r, rank: sort === 'total' ? i + 1 : totalRank.get(r.pid),
  }));
}

// 个人页：单个玩家【当前赛季】的汇总，并附带其在总分榜上的名次。
// 玩家在当前赛季还没打、但历史赛季有记录时（赛季刚切换的常见情况）仍返回页面：
// 当前赛季各字段为零、rank 为 null，seasons 里保留其各历史赛季名次。
// 从未在任何赛季完成过对局/非法 pid 返回 null。
// badges 为读时派生的当前赛季成就徽章（已点亮 + 未达成进度），不落库。
// seasons 为该 pid 各赛季名次与汇总（当前赛季 + 历史冻结赛季），个人页"各赛季名次"用。
function getProfile(season, pid) {
  if (!isValidPid(pid)) return null;
  const stat = (season.players || {})[pid];
  const seasons = playerSeasons(season, pid);
  if (!stat) {
    if (!seasons.length) return null;
    // 只在历史赛季出现过：昵称取最近一个有记录的赛季，当前赛季汇总为空
    const empty = { pid, name: seasons[0].name,
      rank: null, games: 0, wins: 0, ties: 0, losses: 0, totalScore: 0,
      avgScore: 0, bestChain: 0, winRate: 0, lastAt: 0 };
    return { ...empty, badges: achievements.evaluate(empty), seasons };
  }
  const rank = leaderboard(season, { sort: 'total' }).find(r => r.pid === pid);
  const agg = { pid: stat.pid, name: stat.name, rank: rank ? rank.rank : null, ...aggregate(stat) };
  return { ...agg, badges: achievements.evaluate(agg), seasons };
}

module.exports = {
  ARCHIVE_VERSION, PID_RE, PID_SECRET_RE, SORTS,
  emptySeason, normalizeSeason, isValidPid, isValidPidSecret,
  derivePid, resolvePid,
  aggregate, recordRoom, isRoomRecorded, markRoomRecorded,
  leaderboard, frozenLeaderboard, freezeSeason, seasonDue, rolloverSeason,
  playerSeasons, getProfile,
};
