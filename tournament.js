'use strict';
// 跨房间赛事 —— 纯逻辑状态机（无任何 IO），服务端与测试共用。
//
// 一场赛事把【不同房间】里的玩家拉进同一张淘汰表：
//   registering（报名中）→ running（对阵中）→ finished（完赛）/ cancelled（取消）
// - 房主（持密钥派生出 pid 的创作者）创建赛程，设定报名截止与每轮对局规则；
// - 任何玩家凭自己的 pidSecret 报名（同一 pid 只能报一次，防冒用靠赛季同款凭据）；
// - 截止（到点自动/房主提前）后随机抽签、按 2 的幂补轮空（bye），生成完整单败对阵树；
// - 每场对阵在两名选手都"进入"后由服务端开一个普通游戏房间；对局结束按房间胜者晋级，
//   负者淘汰，胜者写入下一轮，直到决赛出冠军；每一场对局都是普通房间，因此【自动】走
//   赛季战绩那套"逐局索引 + 防抖落盘 + 启动补记"链路回写赛季，本模块不重复记账。
//
// 异常状态：
// - 弃权（forfeit）：对阵在等待开赛（ready）期间，选手主动认输，对手直接晋级；
// - 超时未到（noshow/walkover）：ready 倒计时跑完仍没人/只来了一人 ——
//   一人到则到场者晋级，两人都没到则种子靠前者兜底晋级（保证对阵树不中断）；
// - 平局（tie）：词语领地可能平分。自动安排一场重赛（旧局记为 void 但仍是已结束的真实
//   对局，照常进赛季）；连续平局到上限（第 3 场仍平）则种子靠前者按 tiebreak 晋级；
// - 异常重赛（replay）：房主在"下一轮还没开打"时可宣布某场作废重赛，胜者沿新房间重新
//   产生，对阵树里父节点的进料引用改指向新场次；决赛重赛会回滚冠军与完赛状态。
//
// 身份与赛季同源：选手公开标识 pid = sha256(pidSecret)，由服务端派生（见 season.resolvePid）。
// 赛事只存公开 pid 与昵称；进入对局房间时服务端核验"该 pid 必须是这场对阵的选手"，
// 别人无法凭房间码（加入路径对赛房关闭）冒名占座。

const crypto = require('crypto');

// ---------- 常量与形状 ----------

const TOURNAMENT_ID_RE = /^tm_[a-f0-9]{12}$/;
// 场次 id：r{轮次}-{轮内序号}，重赛追加 #rep{n}（如 r2-1#rep1）
const MATCH_ID_RE = /^r(\d+)-(\d+)(?:#rep(\d+))?$/;
const PID_RE = /^[a-f0-9]{64}$/;

const PHASES = new Set(['registering', 'running', 'finished', 'cancelled']);
// 选手状态：报名中 registered / 开赛后 alive / 淘汰 eliminated / 弃权 forfeit /
// 超时未到 noshow / 冠军 champion / 报名截止前退出 withdrawn
const ENTRANT_STATUSES = new Set([
  'registered', 'alive', 'eliminated', 'forfeit', 'noshow', 'champion', 'withdrawn',
]);
// 场次状态：pending 待选手决出 / ready 等待选手入场（有倒计时）/ live 房间已开赛 /
// finished 已决出胜者 / bye 轮空直接晋级 / void 作废（异常或平局重赛）
const MATCH_STATUSES = new Set(['pending', 'ready', 'live', 'finished', 'bye', 'void']);
// 决出方式：played 正常对局 / bye 轮空 / forfeit 弃权 / walkover 对手超时 /
// noshow 双方都没到的兜底 / tiebreak 连平后种子靠前 / tie 平局（该场随即 void 重赛）
const RESULT_TYPES = new Set(['played', 'bye', 'forfeit', 'walkover', 'noshow', 'tiebreak', 'tie']);

const STORE_VERSION = 1;
const MIN_ENTRANTS = 2;
const MAX_ENTRANTS = 64;            // 最大签表（2^6）
const MAX_NAME_LEN = 12;
const MAX_TOURNAMENT_NAME_LEN = 24;
const MAX_TIE_REPLAYS = 2;          // 平局最多重赛 2 次（第 3 场仍平按种子破平）
const MAX_HOST_REMATCH = 3;         // 房主对同一条场次链最多宣布 3 次异常重赛

// 默认值（服务端可用环境变量覆盖，纯逻辑只在 create 时由调用方传入具体毫秒数）
const DEFAULT_MATCH_WAIT_MS = 10 * 60 * 1000;   // 一场对阵等待两名选手入场的时长
const DEFAULT_REGISTER_MS = 60 * 60 * 1000;     // 报名窗口默认 1 小时
const FINISHED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isValidPid(pid) { return typeof pid === 'string' && PID_RE.test(pid); }
function isValidTournamentId(id) { return typeof id === 'string' && TOURNAMENT_ID_RE.test(id); }
function cleanName(name) { return String(name == null ? '' : name).trim().slice(0, MAX_NAME_LEN); }

function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return Math.min(p, MAX_ENTRANTS);
}

let idCounter = 0;
function makeTournamentId(rng = crypto.randomBytes.bind(crypto)) {
  // 碰撞由服务端 generate 注入重试；这里给出默认实现（12 位十六进制）
  return `tm_${crypto.randomBytes(6).toString('hex')}`;
}

// ---------- 存档 ----------

function emptyStore() {
  return { version: STORE_VERSION, tournaments: {} };
}

function normalizeEntrant(raw, idx) {
  if (!raw || typeof raw !== 'object') return null;
  const pid = String(raw.pid || '');
  if (!isValidPid(pid)) return null;
  const eid = String(raw.eid || `e${idx + 1}`);
  const status = ENTRANT_STATUSES.has(raw.status) ? raw.status : 'registered';
  return {
    eid, pid,
    name: cleanName(raw.name) || '玩家',
    seed: Math.max(0, Math.trunc(Number(raw.seed) || 0)),
    status,
    registeredAt: Math.max(0, Math.trunc(Number(raw.registeredAt) || 0)),
  };
}

function normalizeMatch(raw) {
  if (!raw || typeof raw !== 'object' || !MATCH_ID_RE.test(String(raw.id || ''))) return null;
  const id = raw.id;
  const round = Math.max(1, Math.trunc(Number(raw.round) || 1));
  const order = Math.max(0, Math.trunc(Number(raw.order) || 0));
  const status = MATCH_STATUSES.has(raw.status) ? raw.status : 'pending';
  const feed = (f) => {
    if (!f || typeof f !== 'object') return null;
    if (f.kind === 'match') {
      return MATCH_ID_RE.test(String(f.mid || '')) ? { kind: 'match', mid: f.mid } : null;
    }
    // 种子槽：eid 为 null 表示该侧轮空
    return { kind: 'seed', eid: typeof f.eid === 'string' ? f.eid : null };
  };
  const feedA = feed(raw.feedA);
  const feedB = feed(raw.feedB);
  if (!feedA || !feedB) return null;
  const m = {
    id, round, order, feedA, feedB,
    eidA: typeof raw.eidA === 'string' ? raw.eidA : null,
    eidB: typeof raw.eidB === 'string' ? raw.eidB : null,
    winnerEid: typeof raw.winnerEid === 'string' ? raw.winnerEid : null,
    loserEid: typeof raw.loserEid === 'string' ? raw.loserEid : null,
    status,
    roomCode: typeof raw.roomCode === 'string' ? raw.roomCode : null,
    checkedEids: Array.isArray(raw.checkedEids)
      ? [...new Set(raw.checkedEids.filter(x => typeof x === 'string'))] : [],
    readyAt: Math.max(0, Math.trunc(Number(raw.readyAt) || 0)),
    deadline: Number.isFinite(raw.deadline) && raw.deadline > 0
      ? Math.trunc(raw.deadline) : null,
    parentMid: typeof raw.parentMid === 'string' ? raw.parentMid : null,
    rematchOf: typeof raw.rematchOf === 'string' ? raw.rematchOf : null,
    note: typeof raw.note === 'string' ? raw.note : null,
    result: null,
  };
  if (raw.result && typeof raw.result === 'object' && RESULT_TYPES.has(raw.result.type)) {
    m.result = {
      type: raw.result.type,
      winnerPid: isValidPid(raw.result.winnerPid) ? raw.result.winnerPid : null,
      winnerName: String(raw.result.winnerName || ''),
      roomKey: typeof raw.result.roomKey === 'string' ? raw.result.roomKey : null,
      roomCode: typeof raw.result.roomCode === 'string' ? raw.result.roomCode : null,
      scores: Array.isArray(raw.result.scores) ? raw.result.scores.slice(0, 8).map(s => ({
        pid: isValidPid(s && s.pid) ? s.pid : null,
        name: String((s && s.name) || ''),
        total: Math.max(0, Math.trunc(Number(s && s.total) || 0)),
      })) : [],
      bothNoShow: !!raw.result.bothNoShow,
      at: Math.max(0, Math.trunc(Number(raw.result.at) || 0)),
    };
  }
  return m;
}

function normalizeRules(raw) {
  // 只保留游戏规则白名单字段（与 game.setRuleSet 口径一致），损坏/缺失走默认值
  const d = {
    allowedRelations: null,
    allowProperNouns: false,
    minReasonLen: 4,
    turnSeconds: 90,
    apPerTurn: 3,
    rounds: 4,
    startWordCount: 3,
    challengeTokens: 3,
  };
  const r = raw && typeof raw === 'object' ? raw : {};
  if (Array.isArray(r.allowedRelations)) {
    const valid = r.allowedRelations.filter(x =>
      ['synonym', 'antonym', 'hypernym', 'part', 'cause', 'tool', 'scene', 'derive'].includes(x));
    if (valid.length) d.allowedRelations = [...new Set(valid)];
  }
  if (typeof r.allowProperNouns === 'boolean') d.allowProperNouns = r.allowProperNouns;
  const clampInt = (v, lo, hi, def) => {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) return def;
    return Math.max(lo, Math.min(hi, n));
  };
  d.minReasonLen = clampInt(r.minReasonLen, 0, 50, d.minReasonLen);
  d.turnSeconds = clampInt(r.turnSeconds, 30, 300, d.turnSeconds);
  d.apPerTurn = clampInt(r.apPerTurn, 1, 6, d.apPerTurn);
  d.rounds = clampInt(r.rounds, 1, 10, d.rounds);
  d.startWordCount = clampInt(r.startWordCount, 1, 16, d.startWordCount);
  d.challengeTokens = clampInt(r.challengeTokens, 0, 9, d.challengeTokens);
  return d;
}

function normalizeTournament(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || !isValidTournamentId(raw.id)) return null;
  const phase = PHASES.has(raw.phase) ? raw.phase : 'registering';
  const t = {
    id: raw.id,
    name: String(raw.name || '赛事').slice(0, MAX_TOURNAMENT_NAME_LEN) || '赛事',
    hostPid: isValidPid(raw.hostPid) ? raw.hostPid : null,
    hostName: cleanName(raw.hostName) || '房主',
    phase,
    createdAt: Math.max(0, Math.trunc(Number(raw.createdAt) || now)),
    registerDeadline: Number.isFinite(raw.registerDeadline) && raw.registerDeadline > 0
      ? Math.trunc(raw.registerDeadline) : null,
    matchWaitMs: Math.max(60 * 1000, Math.trunc(Number(raw.matchWaitMs) || DEFAULT_MATCH_WAIT_MS)),
    rules: normalizeRules(raw.rules),
    packName: typeof raw.packName === 'string' ? raw.packName.slice(0, 24) : null,
    entrants: [],
    size: 0,
    rounds: 0,
    matches: {},
    matchOrder: [],
    championEid: typeof raw.championEid === 'string' ? raw.championEid : null,
    finalStandings: [],
    finishedAt: Math.max(0, Math.trunc(Number(raw.finishedAt) || 0)),
    cancelReason: typeof raw.cancelReason === 'string' ? raw.cancelReason : null,
    log: [],
  };
  if (!t.hostPid) return null;
  const eids = new Set();
  for (const [i, eraw] of Array.isArray(raw.entrants) ? raw.entrants.entries() : []) {
    const e = normalizeEntrant(eraw, i);
    if (!e || eids.has(e.eid)) continue; // pid 重复的脏数据只保留第一条
    eids.add(e.eid);
    t.entrants.push(e);
  }
  if (Array.isArray(raw.matchOrder)) {
    for (const mid of raw.matchOrder) {
      const m = normalizeMatch(raw.matches && raw.matches[mid]);
      if (m && m.id === mid) { t.matches[m.id] = m; t.matchOrder.push(m.id); }
    }
  }
  if (Array.isArray(raw.finalStandings)) {
    for (const s of raw.finalStandings) {
      if (s && typeof s === 'object' && eids.has(String(s.eid))) {
        t.finalStandings.push({
          eid: String(s.eid),
          rank: Math.max(1, Math.trunc(Number(s.rank) || 0)),
          reason: String(s.reason || 'eliminated'),
        });
      }
    }
  }
  return t;
}

// 从（可能损坏的）赛事档恢复：逐个赛事校验，单个损坏不影响其他赛事。
function normalizeStore(raw) {
  const store = emptyStore();
  const entries = raw && typeof raw === 'object' &&
    raw.tournaments && typeof raw.tournaments === 'object' ? raw.tournaments : null;
  if (!entries) return store;
  for (const [id, t] of Object.entries(entries)) {
    const norm = normalizeTournament({ ...t, id });
    if (norm) store.tournaments[id] = norm;
  }
  return store;
}

// ---------- 创建 / 报名 / 退出 ----------

// 创建赛事。opts:
//   id 由服务端 generate 注入（碰撞重试）；hostPid 必须是合法公开 pid（服务端已从密钥派生）；
//   registerMs 为报名窗口毫秒（>0 表示到点自动截止开赛；传 0/null 表示只由房主手动开赛）；
//   matchWaitMs 为每轮等选手入场的时长。
function createTournament(store, opts = {}) {
  if (!(store && store.tournaments)) return { error: '赛事存储无效' };
  const hostPid = String(opts.hostPid || '');
  if (!isValidPid(hostPid)) return { error: '需要有效的本机身份才能创建赛事' };
  const name = String(opts.name || '').trim().slice(0, MAX_TOURNAMENT_NAME_LEN);
  if (!name) return { error: '请填写赛事名称' };
  const now = Math.trunc(Number.isFinite(opts.now) ? opts.now : Date.now());
  let registerDeadline = null;
  const registerMs = Number(opts.registerMs);
  if (Number.isFinite(registerMs) && registerMs > 0) {
    registerDeadline = now + Math.min(30 * 24 * 60 * 60 * 1000, Math.max(60 * 1000, registerMs));
  }
  const t = {
    id: '',
    name,
    hostPid,
    hostName: cleanName(opts.hostName) || '房主',
    phase: 'registering',
    createdAt: now,
    registerDeadline,
    matchWaitMs: Math.max(60 * 1000,
      Math.trunc(Number(opts.matchWaitMs) || DEFAULT_MATCH_WAIT_MS)),
    rules: normalizeRules(opts.rules),
    packName: typeof opts.packName === 'string' ? opts.packName.slice(0, 24) : null,
    entrants: [],
    size: 0,
    rounds: 0,
    matches: {},
    matchOrder: [],
    championEid: null,
    finalStandings: [],
    finishedAt: 0,
    cancelReason: null,
    log: [],
  };
  for (let i = 0; i < 10; i++) {
    const id = String(typeof opts.generate === 'function' ? opts.generate() : makeTournamentId());
    if (!isValidTournamentId(id) || store.tournaments[id]) continue;
    t.id = id;
    break;
  }
  if (!t.id) return { error: '创建失败，请重试' };
  store.tournaments[t.id] = t;
  tLog(t, 'create', { name, hostPid, registerDeadline });
  return { tournament: t, error: null };
}

function getTournament(store, id) {
  return (store && store.tournaments ? store.tournaments[String(id || '')] : null) || null;
}

function findEntrant(t, pid) {
  return t.entrants.find(e => e.pid === pid) || null;
}

// 报名：同一 pid 只能报一次；只在报名窗口内、人数未满时接受。
function register(store, id, opts = {}) {
  const t = getTournament(store, id);
  if (!t) return { error: '赛事不存在或已删除' };
  if (t.phase !== 'registering') return { error: '报名已截止' };
  const now = Math.trunc(Number.isFinite(opts.now) ? opts.now : Date.now());
  if (t.registerDeadline && now >= t.registerDeadline) return { error: '报名已截止' };
  const pid = String(opts.pid || '');
  if (!isValidPid(pid)) return { error: '需要有效的本机身份才能报名' };
  if (findEntrant(t, pid)) return { error: '你已经报名过这场赛事' };
  if (t.entrants.length >= MAX_ENTRANTS) return { error: `报名人数已达上限（${MAX_ENTRANTS} 人）` };
  const name = cleanName(opts.name);
  if (!name) return { error: '请填写昵称' };
  const entrant = {
    eid: `e${t.entrants.length + 1}`,
    pid, name, seed: 0, status: 'registered', registeredAt: now,
  };
  t.entrants.push(entrant);
  tLog(t, 'register', { eid: entrant.eid, pid });
  return { entrant, error: null };
}

// 报名截止前主动退出
function withdraw(store, id, pid, now = Date.now()) {
  const t = getTournament(store, id);
  if (!t) return { error: '赛事不存在或已删除' };
  if (t.phase !== 'registering') return { error: '报名已截止，不能退出' };
  const e = findEntrant(t, String(pid || ''));
  if (!e) return { error: '你没有报名这场赛事' };
  t.entrants = t.entrants.filter(x => x.eid !== e.eid);
  tLog(t, 'withdraw', { eid: e.eid, pid: e.pid });
  return { error: null };
}

// 房主取消（仅报名中）
function cancel(store, id, pid, now = Date.now()) {
  const t = getTournament(store, id);
  if (!t) return { error: '赛事不存在或已删除' };
  if (String(pid || '') !== t.hostPid) return { error: '只有房主可以取消赛事' };
  if (t.phase !== 'registering') return { error: '开赛后不能取消赛事' };
  t.phase = 'cancelled';
  t.cancelReason = 'host_cancelled';
  t.finishedAt = Math.trunc(now);
  tLog(t, 'cancel', { reason: t.cancelReason });
  return { error: null };
}

// ---------- 抽签与对阵树 ----------

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor((rng ? rng() : Math.random()) * (i + 1));
    if (j <= i) [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function setReady(t, m, now) {
  m.status = 'ready';
  m.readyAt = Math.trunc(now);
  m.deadline = Math.trunc(now) + t.matchWaitMs;
  m.roomCode = null;
  m.checkedEids = [];
}

// 给一场非轮空场次下定胜者（正常/弃权/超时/破平均走这里；bye 在抽签时单独处理）。
// result: {type, winnerEid, winnerPid, winnerName, roomKey, roomCode, scores, bothNoShow, at}
function decideMatch(t, m, result, now) {
  m.status = 'finished';
  m.deadline = null;
  m.winnerEid = result.winnerEid;
  m.loserEid = m.eidA === result.winnerEid ? m.eidB
    : m.eidB === result.winnerEid ? m.eidA : null;
  m.result = {
    type: result.type,
    winnerPid: result.winnerPid || null,
    winnerName: result.winnerName || '',
    roomKey: result.roomKey || null,
    roomCode: result.roomCode || m.roomCode,
    scores: Array.isArray(result.scores) ? result.scores : [],
    bothNoShow: !!result.bothNoShow,
    at: Math.trunc(result.at || now),
  };
  // 选手状态：负者按决出方式落状态，胜者保持/回到 alive
  const winner = t.entrants.find(e => e.eid === m.winnerEid);
  const loser = t.entrants.find(e => e.eid === m.loserEid);
  if (winner && winner.status !== 'champion') winner.status = 'alive';
  if (loser) {
    loser.status = result.type === 'forfeit' ? 'forfeit'
      : (result.type === 'walkover' || result.type === 'noshow') ? 'noshow'
        : 'eliminated';
  }
  tLog(t, 'decide', { match: m.id, type: result.type, winnerEid: m.winnerEid, loserEid: m.loserEid });
  advanceParent(t, m, result.at || now);
}

// 胜者写入父场次；父场次双方到齐且赛事进行中则转为 ready 开始等选手入场。
function advanceParent(t, m, now) {
  if (!m.parentMid) {
    if (m.status === 'finished' && t.phase === 'running') finishTournament(t, now);
    return;
  }
  const parent = t.matches[m.parentMid];
  if (!parent) return;
  if (parent.feedA.kind === 'match' && parent.feedA.mid === m.id) parent.eidA = m.winnerEid;
  else if (parent.feedB.kind === 'match' && parent.feedB.mid === m.id) parent.eidB = m.winnerEid;
  if (parent.eidA && parent.eidB && parent.status === 'pending' && t.phase === 'running') {
    setReady(t, parent, now);
    tLog(t, 'nextReady', { match: parent.id });
  }
}

// 抽签并生成完整对阵树。轮空名额均匀撒在第一轮（保证每场至少一名真人，
// 不会出现"两个轮空"的幽灵场次——数学上 bye 数 = size-n < n，总能做到）。
function buildBracket(t, now, rng) {
  const n = t.entrants.length;
  const size = nextPow2(n);
  const rounds = Math.round(Math.log2(size));
  const drawn = shuffle(t.entrants, rng);
  drawn.forEach((e, i) => { e.seed = i + 1; e.status = 'alive'; });
  t.size = size;
  t.rounds = rounds;
  t.matches = {};
  t.matchOrder = [];

  const byes = size - n;
  const pairCount = size / 2;
  const byePairs = new Set();
  // 把轮空名额均匀映射到第一轮的某些"场次对"：每对至多一个轮空
  for (let k = 0; k < byes; k++) {
    byePairs.add(Math.floor(k * pairCount / Math.max(1, byes)));
  }
  const leaves = Array(size).fill(null);
  let ei = 0;
  for (let j = 0; j < pairCount; j++) {
    if (byePairs.has(j)) {
      leaves[2 * j] = drawn[ei++]; // 另一侧留 null（轮空）
    } else {
      leaves[2 * j] = drawn[ei++];
      leaves[2 * j + 1] = drawn[ei++];
    }
  }

  // 第一轮：选手直接做进料
  let levelIds = [];
  for (let j = 0; j < pairCount; j++) {
    const a = leaves[2 * j];
    const b = leaves[2 * j + 1];
    const m = {
      id: `r1-${j}`, round: 1, order: j,
      feedA: { kind: 'seed', eid: a ? a.eid : null },
      feedB: { kind: 'seed', eid: b ? b.eid : null },
      eidA: a ? a.eid : null, eidB: b ? b.eid : null,
      winnerEid: null, loserEid: null,
      status: 'pending', roomCode: null, checkedEids: [],
      readyAt: 0, deadline: null, parentMid: null, rematchOf: null, note: null, result: null,
    };
    t.matches[m.id] = m;
    t.matchOrder.push(m.id);
    levelIds.push(m.id);
  }
  // 后续轮：相邻两场为进料
  for (let r = 2; r <= rounds; r++) {
    const nextIds = [];
    for (let j = 0; j < levelIds.length / 2; j++) {
      const midA = levelIds[2 * j];
      const midB = levelIds[2 * j + 1];
      const m = {
        id: `r${r}-${j}`, round: r, order: j,
        feedA: { kind: 'match', mid: midA },
        feedB: { kind: 'match', mid: midB },
        eidA: null, eidB: null,
        winnerEid: null, loserEid: null,
        status: 'pending', roomCode: null, checkedEids: [],
        readyAt: 0, deadline: null, parentMid: null, rematchOf: null, note: null, result: null,
      };
      t.matches[midA].parentMid = m.id;
      t.matches[midB].parentMid = m.id;
      t.matches[m.id] = m;
      t.matchOrder.push(m.id);
      nextIds.push(m.id);
    }
    levelIds = nextIds;
  }

  // 先处理第一轮轮空（轮空者直接晋级并向上传播，可能把父场次提前喂饱一侧）
  for (const mid of t.matchOrder.slice()) {
    const m = t.matches[mid];
    if (m.round !== 1) continue;
    if (m.eidA && !m.eidB) {
      m.status = 'bye';
      m.winnerEid = m.eidA;
      m.result = { type: 'bye', winnerPid: null, winnerName: '', roomKey: null,
        roomCode: null, scores: [], bothNoShow: false, at: Math.trunc(now) };
      m.note = '轮空晋级';
      tLog(t, 'bye', { match: m.id, winnerEid: m.eidA });
      advanceParent(t, m, now);
    }
  }
}

// 截止报名并开赛（房主提前 / 到点自动 同一路径）。
function startBracket(store, id, opts = {}) {
  const t = getTournament(store, id);
  if (!t) return { error: '赛事不存在或已删除' };
  if (t.phase !== 'registering') return { error: '赛事已经开始或已结束' };
  if (opts.hostPid && String(opts.hostPid) !== t.hostPid) {
    return { error: '只有房主可以提前开赛' };
  }
  if (t.entrants.length < MIN_ENTRANTS) return { error: `至少需要 ${MIN_ENTRANTS} 人报名才能开赛` };
  const now = Math.trunc(opts.now || Date.now());
  buildBracket(t, now, opts.rng || Math.random);
  t.phase = 'running';
  // 双方已就位（非轮空）的第一轮场次开始等选手入场；轮空链喂饱的父场次同理
  for (const mid of t.matchOrder) {
    const m = t.matches[mid];
    if (m.status === 'pending' && m.eidA && m.eidB) setReady(t, m, now);
  }
  tLog(t, 'start', { entrants: t.entrants.length, size: t.size });
  return { tournament: t, error: null };
}

// ---------- 对阵房间联动（服务端在开房间/选手入场时调用） ----------

function entrantOfPid(t, pid) { return t.entrants.find(e => e.pid === pid) || null; }

// 某选手当前应进入的场次（ready/live 且其为参赛方）。
function currentMatchFor(t, pid) {
  if (!t || (t.phase !== 'running')) return null;
  const e = entrantOfPid(t, pid);
  if (!e) return null;
  for (const mid of t.matchOrder) {
    const m = t.matches[mid];
    if ((m.status === 'ready' || m.status === 'live') &&
        (m.eidA === e.eid || m.eidB === e.eid)) return m;
  }
  return null;
}

// 服务端为一场对阵开好（或复用）游戏房间后登记房间码。
function assignRoom(t, mid, roomCode) {
  const m = t.matches[mid];
  if (!m) return { error: '场次不存在' };
  if (m.status !== 'ready' && m.status !== 'live') return { error: '这场对阵当前不能进入' };
  if (!m.roomCode) m.roomCode = roomCode;
  return { error: null, roomCode: m.roomCode };
}

// 选手到场（进入对阵房间）。第二名选手到场后场次转 live、倒计时取消，服务端据此开局。
// 返回 {status, live}；非参赛方/重复进入有明确错误（幂等的本人重复进入返回 live 现状）。
function checkIn(t, mid, pid) {
  const m = t.matches && t.matches[mid];
  if (!m) return { error: '场次不存在' };
  if (m.status !== 'ready' && m.status !== 'live') return { error: '这场对阵还没到入场时间' };
  const e = entrantOfPid(t, pid);
  if (!e || (m.eidA !== e.eid && m.eidB !== e.eid)) return { error: '你不是这场对阵的参赛选手' };
  if (!m.checkedEids.includes(e.eid)) m.checkedEids.push(e.eid);
  if (m.checkedEids.length >= 2 && m.status === 'ready') {
    m.status = 'live';
    m.deadline = null;
  }
  return { status: m.status, live: m.status === 'live', error: null };
}

// ---------- 对局结果回写 ----------

// 一场对阵房间结束后由服务端上报。roomWinnerPid 为房间胜者的公开 pid（平局为 null）。
// scores 为 [{pid,name,total}]。正常结果直接晋级；平局走"重赛/种子破平"。
function reportMatchResult(store, id, mid, input = {}) {
  const t = getTournament(store, id);
  const m = t && t.matches[mid];
  if (!m) return { error: '场次不存在' };
  if (m.status !== 'ready' && m.status !== 'live') {
    return { error: '这场对阵不在等待结果的状态' };
  }
  if (m.roomCode && input.roomCode && input.roomCode !== m.roomCode) {
    return { error: '上报房间与当前对阵房间不一致' };
  }
  const now = Math.trunc(input.now || Date.now());
  const eA = t.entrants.find(e => e.eid === m.eidA);
  const eB = t.entrants.find(e => e.eid === m.eidB);
  const winnerPid = input.roomWinnerPid && isValidPid(input.roomWinnerPid) ? input.roomWinnerPid : null;
  const winnerE = winnerPid && [eA, eB].find(e => e && e.pid === winnerPid);
  if (winnerPid && !winnerE) return { error: '房间胜者不是这场对阵的参赛选手' };

  // 平局：先把这场记为 tie（房间是真实对局，赛季照常回写），再决定重赛还是种子破平。
  // 该场没有胜者，不做晋级传播：直接落 finished 状态（供 rematch 校验），随后由重赛作废。
  if (!winnerPid) {
    const priorTies = countChainResult(t, m, 'tie');
    m.status = 'finished';
    m.winnerEid = null;
    m.loserEid = null;
    m.deadline = null;
    m.result = {
      type: 'tie', winnerPid: null, winnerName: '',
      roomKey: input.roomKey || null, roomCode: input.roomCode || m.roomCode,
      scores: input.scores || [], bothNoShow: false, at: now,
    };
    tLog(t, 'tie', { match: m.id });
    if (priorTies >= MAX_TIE_REPLAYS) {
      // 第 3 场仍平：种子靠前者（seed 数字小）晋级
      const adv = [eA, eB].filter(Boolean).sort((a, b) => a.seed - b.seed)[0];
      tLog(t, 'tiebreak', { match: m.id, winnerEid: adv.eid });
      decideMatch(t, m, {
        type: 'tiebreak', winnerEid: adv.eid,
        winnerPid: adv.pid, winnerName: adv.name,
        roomKey: input.roomKey, scores: input.scores, at: now,
      });
      return { tournament: t, resolved: 'tiebreak', rematch: null, error: null };
    }
    const rep = rematch(t, m, 'tie', now);
    return { tournament: t, resolved: 'tie', rematch: rep.match, error: rep.error };
  }

  decideMatch(t, m, {
    type: 'played', winnerEid: winnerE.eid,
    winnerPid: winnerE.pid, winnerName: winnerE.name,
    roomKey: input.roomKey, roomCode: input.roomCode || m.roomCode,
    scores: input.scores, at: now,
  });
  return { tournament: t, resolved: 'played', rematch: null, error: null };
}

// ---------- 弃权 / 超时未到 ----------

// 选手在对阵开赛前（ready）主动认输；对手直接晋级。开赛（live）后不能弃权 ——
// 对局中的弃赛由回合超时托管/打完自然判定，避免强行改写一个正在进行的房间。
function forfeit(store, id, pid, now = Date.now()) {
  const t = getTournament(store, id);
  if (!t) return { error: '赛事不存在或已删除' };
  const e = entrantOfPid(t, String(pid || ''));
  if (!e) return { error: '你没有参加这场赛事' };
  const m = t.matchOrder.map(mid => t.matches[mid])
    .find(x => x.status === 'ready' && (x.eidA === e.eid || x.eidB === e.eid));
  if (!m) return { error: '你当前没有等待开赛的对阵可以弃权' };
  const winner = m.eidA === e.eid
    ? t.entrants.find(x => x.eid === m.eidB)
    : t.entrants.find(x => x.eid === m.eidA);
  if (!winner) return { error: '对阵缺少对手，无法判定' };
  tLog(t, 'forfeit', { match: m.id, loserEid: e.eid, winnerEid: winner.eid });
  decideMatch(t, m, {
    type: 'forfeit', winnerEid: winner.eid, winnerPid: winner.pid,
    winnerName: winner.name, at: now,
  });
  return { tournament: t, match: m, error: null };
}

// 扫描并处理所有到期事项：报名截止开赛/人数不足取消；ready 场次的超时未到。
// 服务端周期任务与各类请求都会惰性调用（幂等）。
// 返回 { started, cancelled, walkovers, finished } 便于服务端清理废弃房间/广播。
function sweep(store, nowInput = Date.now()) {
  const now = Math.trunc(nowInput);
  const out = { started: [], cancelled: [], walkovers: [], finished: [] };
  for (const t of Object.values(store.tournaments || {})) {
    if (t.phase === 'registering' && t.registerDeadline && now >= t.registerDeadline) {
      if (t.entrants.length >= MIN_ENTRANTS) {
        const r = startBracket(store, t.id, { now });
        if (!r.error) out.started.push(t.id);
      } else {
        t.phase = 'cancelled';
        t.cancelReason = 'not_enough_entrants';
        t.finishedAt = now;
        out.cancelled.push(t.id);
        tLog(t, 'cancel', { reason: t.cancelReason });
      }
    }
    if (t.phase !== 'running') continue;
    for (const mid of t.matchOrder) {
      const m = t.matches[mid];
      if (m.status !== 'ready' || !m.deadline || now < m.deadline) continue;
      settleTimeout(t, m, now, out);
    }
  }
  return out;
}

// 一场 ready 对阵等选手入场超时：
// - 来了一人：到场者 walkover 晋级，未到者 noshow；
// - 两人都没到：种子靠前者兜底晋级（保证对阵树不断），两人都标 noshow，结果记 noshow。
function settleTimeout(t, m, now, out) {
  const eA = t.entrants.find(e => e.eid === m.eidA);
  const eB = t.entrants.find(e => e.eid === m.eidB);
  const present = m.checkedEids.slice();
  let winner, loser, type, bothNoShow = false;
  if (present.length === 1) {
    winner = [eA, eB].find(e => e && e.eid === present[0]);
    loser = [eA, eB].find(e => e && e.eid !== present[0]);
    type = 'walkover';
  } else {
    // 两人都没到（理论上不会 >1 而仍 ready，容错按 0 处理）
    const sorted = [eA, eB].filter(Boolean).sort((a, b) => a.seed - b.seed);
    winner = sorted[0];
    loser = sorted[1];
    type = 'noshow';
    bothNoShow = true;
  }
  if (!winner) return;
  tLog(t, 'timeout', { match: m.id, type, winnerEid: winner.eid, loserEid: loser && loser.eid,
    checked: present.length });
  decideMatch(t, m, {
    type, winnerEid: winner.eid, winnerPid: winner.pid, winnerName: winner.name,
    bothNoShow, at: now,
  });
  out.walkovers.push({ tournamentId: t.id, matchId: m.id, roomCode: m.roomCode,
    bothNoShow, checked: present.length });
  if (t.phase === 'finished') out.finished.push(t.id);
}

// ---------- 异常重赛 / 平局重赛 ----------

function chainRootAndCount(t, m) {
  // 沿 rematchOf 回到链首，统计此前已作废（重赛）场次数与各类结果数
  let cur = m, depth = 0;
  const types = [];
  while (cur.rematchOf && t.matches[cur.rematchOf]) {
    cur = t.matches[cur.rematchOf];
    depth += 1;
    types.push(cur.result ? cur.result.type : null);
  }
  return { root: cur, depth, types };
}

function countChainResult(t, m, type) {
  // 当前场之前（沿链向上的所有旧场）某类结果的数量
  let cur = m, count = 0;
  while (cur.rematchOf && t.matches[cur.rematchOf]) {
    cur = t.matches[cur.rematchOf];
    if (cur.result && cur.result.type === type) count += 1;
  }
  return count;
}

// 把一场已决出的场次作废并新开同位置重赛场。reason: 'replay'（房主异常重赛）| 'tie'（平局自动）。
// 约束：下一轮（父场次）必须还没开赛——若已 live/finished，赛果已向后生效，不能改。
// 决赛重赛：回滚冠军/完赛状态，旧决赛负者恢复 alive，重赛场即刻重新等待入场。
function rematch(t, m, reason, now) {
  if (m.status !== 'finished') return { error: '这场对阵还没决出结果，不能重赛' };
  if (m.result && m.result.type === 'bye') return { error: '轮空场次不需要重赛' };
  const { depth } = chainRootAndCount(t, m);
  if (reason === 'replay' && depth >= MAX_HOST_REMATCH) {
    return { error: `同一场对阵最多重赛 ${MAX_HOST_REMATCH} 次` };
  }
  // 下一轮是否已实际开打：父场次已进入可入场/已决状态（ready 意味着对阵已公示、
  // 选手可能正在入场），或已有选手进入其房间（checked/live/finished/bye）。
  // 父场次仍是 pending（另一侧还没决出）时允许重赛：重赛结果稍后与另一侧共同喂入。
  if (m.parentMid) {
    const parent = t.matches[m.parentMid];
    if (parent.status === 'ready' || parent.status === 'live' ||
        parent.status === 'finished' || parent.status === 'bye' ||
        parent.checkedEids.length > 0) {
      return { error: '下一轮已经开始，不能再重赛' };
    }
  }
  const oldLoser = t.entrants.find(e => e.eid === m.loserEid);
  const oldWinner = t.entrants.find(e => e.eid === m.winnerEid);

  // 决赛重赛：先回滚完赛
  if (!m.parentMid && t.phase === 'finished') {
    t.phase = 'running';
    t.championEid = null;
    t.finalStandings = [];
    t.finishedAt = 0;
    if (oldWinner) oldWinner.status = 'alive';
    tLog(t, 'unfinish', { final: m.id });
  }

  // 旧场作废（保留 result 作为历史）
  m.status = 'void';
  m.deadline = null;
  m.note = reason === 'tie' ? '平局，重赛（旧局作废）' : '异常重赛（旧局作废）';

  // 创建重赛场（同轮次同位置，进料/选手与旧场一致）
  const repNo = depth + 1;
  const nm = {
    id: `r${m.round}-${m.order}#rep${repNo}`,
    round: m.round, order: m.order,
    feedA: JSON.parse(JSON.stringify(m.feedA)),
    feedB: JSON.parse(JSON.stringify(m.feedB)),
    eidA: m.eidA, eidB: m.eidB,
    winnerEid: null, loserEid: null,
    status: 'pending', roomCode: null, checkedEids: [],
    readyAt: 0, deadline: null,
    parentMid: m.parentMid, rematchOf: m.id, note: null, result: null,
  };
  // 防极端碰撞（理论不会）
  if (t.matches[nm.id]) return { error: '重赛场冲突，请重试' };
  t.matches[nm.id] = nm;
  t.matchOrder.push(nm.id);

  // 父场次改指向新场，并清掉旧场曾喂入的选手；ready 父场次退回 pending（其等候房间由服务端废弃）
  if (m.parentMid) {
    const parent = t.matches[m.parentMid];
    if (parent.feedA.kind === 'match' && parent.feedA.mid === m.id) parent.feedA.mid = nm.id;
    else if (parent.feedB.kind === 'match' && parent.feedB.mid === m.id) parent.feedB.mid = nm.id;
    if (parent.eidA === m.winnerEid) parent.eidA = null;
    if (parent.eidB === m.winnerEid) parent.eidB = null;
    if (parent.status === 'ready') {
      parent.status = 'pending';
      parent.deadline = null;
      parent.readyAt = 0;
      parent.roomCode = null;
      parent.checkedEids = [];
    }
  }

  // 选手状态：旧负者给回机会，双方都回到 alive
  if (oldLoser) oldLoser.status = 'alive';
  if (oldWinner && oldWinner.status !== 'alive') oldWinner.status = 'alive';

  if (t.phase === 'running' && nm.eidA && nm.eidB) setReady(t, nm, now);
  tLog(t, reason === 'tie' ? 'tieRematch' : 'rematch',
    { oldMatch: m.id, newMatch: nm.id, by: reason });
  return { match: nm, oldMatch: m, error: null };
}

// 房主宣布异常重赛
function hostRematch(store, id, mid, pid, now = Date.now()) {
  const t = getTournament(store, id);
  if (!t) return { error: '赛事不存在或已删除' };
  if (String(pid || '') !== t.hostPid) return { error: '只有房主可以安排异常重赛' };
  const m = t.matches[String(mid || '')];
  if (!m) return { error: '场次不存在' };
  const r = rematch(t, m, 'replay', Math.trunc(now));
  if (r.error) return r;
  return { tournament: t, ...r };
}

// ---------- 完赛与名次 ----------

// 第 r 轮（共 R 轮）负者的并列名次：决赛负者第 2、半决赛负者并列第 3、首轮负者并列 2^(R-1)+1。
function placementOf(round, totalRounds) {
  return Math.pow(2, totalRounds - round) + 1;
}

function finishTournament(t, now) {
  const final = t.matchOrder.map(mid => t.matches[mid])
    .find(m => !m.parentMid && m.status === 'finished');
  if (!final || !final.winnerEid) return;
  t.phase = 'finished';
  t.championEid = final.winnerEid;
  t.finishedAt = Math.trunc(now);
  const champ = t.entrants.find(e => e.eid === final.winnerEid);
  if (champ) champ.status = 'champion';
  // 名次：冠军 1；其余按其输掉的那场轮次定位（弃权/超时并列同名次）
  const rows = [];
  for (const e of t.entrants) {
    if (e.eid === t.championEid) { rows.push({ eid: e.eid, rank: 1, reason: 'champion' }); continue; }
    // 找到该选手输掉的那场（loserEid 命中、非 void）
    const lost = t.matchOrder.map(mid => t.matches[mid])
      .find(m => m.status === 'finished' && m.loserEid === e.eid);
    const rank = lost ? placementOf(lost.round, t.rounds) : t.entrants.length;
    rows.push({ eid: e.eid, rank, reason: lost ? lost.result.type : 'eliminated' });
  }
  rows.sort((a, b) => a.rank - b.rank ||
    (t.entrants.find(e => e.eid === a.eid).seed || 0) -
    (t.entrants.find(e => e.eid === b.eid).seed || 0));
  t.finalStandings = rows;
  tLog(t, 'finish', { championEid: t.championEid });
}

// 完赛/取消赛事的保留期清理，避免存档只增不减（赛季战绩早已独立留存，删赛事不影响榜单）。
function pruneFinished(store, ttlMs = FINISHED_TTL_MS, now = Date.now()) {
  if (!(ttlMs > 0) || !store || !store.tournaments) return [];
  const removed = [];
  for (const [id, t] of Object.entries(store.tournaments)) {
    if ((t.phase === 'finished' || t.phase === 'cancelled') &&
        t.finishedAt && now - t.finishedAt >= ttlMs) {
      delete store.tournaments[id];
      removed.push(id);
    }
  }
  return removed;
}

// ---------- 只读视图 ----------

function entrantView(t, e) {
  return { eid: e.eid, pid: e.pid, name: e.name, seed: e.seed, status: e.status };
}

function matchView(t, m) {
  const nameOf = (eid) => (t.entrants.find(e => e.eid === eid) || {}).name || null;
  const pidOf = (eid) => (t.entrants.find(e => e.eid === eid) || {}).pid || null;
  const seedOf = (eid) => (t.entrants.find(e => e.eid === eid) || {}).seed || null;
  return {
    id: m.id, round: m.round, order: m.order,
    eidA: m.eidA, eidB: m.eidB,
    nameA: nameOf(m.eidA), nameB: nameOf(m.eidB),
    pidA: pidOf(m.eidA), pidB: pidOf(m.eidB),
    seedA: seedOf(m.eidA), seedB: seedOf(m.eidB),
    status: m.status, winnerEid: m.winnerEid, loserEid: m.loserEid,
    roomCode: m.roomCode, checked: m.checkedEids.length,
    deadline: m.deadline, note: m.note,
    parentMid: m.parentMid, rematchOf: m.rematchOf,
    result: m.result ? {
      type: m.result.type, winnerName: m.result.winnerName,
      scores: m.result.scores, bothNoShow: m.result.bothNoShow, at: m.result.at,
    } : null,
  };
}

// 对外完整视图（赛事面板/对阵表）。myPid 时附带 myEid 与我当前场次，客户端据此高亮/入场。
function tournamentView(t, myPid = null) {
  if (!t) return null;
  const myE = isValidPid(myPid) ? findEntrant(t, myPid) : null;
  const rounds = [];
  for (let r = 1; r <= Math.max(1, t.rounds); r++) {
    rounds.push(t.matchOrder.filter(mid => t.matches[mid].round === r).map(mid => matchView(t, t.matches[mid])));
  }
  const cur = myE ? currentMatchFor(t, myE.pid) : null;
  return {
    id: t.id, name: t.name, phase: t.phase,
    hostPid: t.hostPid, hostName: t.hostName,
    createdAt: t.createdAt, registerDeadline: t.registerDeadline,
    matchWaitMs: t.matchWaitMs,
    rules: t.rules, packName: t.packName,
    entrants: t.entrants.map(e => entrantView(t, e)),
    size: t.size, rounds: t.rounds,
    bracket: rounds,
    championEid: t.championEid,
    finalStandings: t.finalStandings,
    finishedAt: t.finishedAt, cancelReason: t.cancelReason,
    myEid: myE ? myE.eid : null,
    myMatchId: cur ? cur.id : null,
    myMatchRoom: cur && cur.roomCode ? cur.roomCode : null,
    myMatchStatus: cur ? cur.status : null,
  };
}

// 列表摘要（首页赛事入口）：报名中的在前，再按创建时间倒序。
function summaries(store, myPid = null, now = Date.now()) {
  const list = Object.values(store.tournaments || {}).map(t => {
    const myE = isValidPid(myPid) ? findEntrant(t, myPid) : null;
    return {
      id: t.id, name: t.name, phase: t.phase,
      hostName: t.hostName,
      entrants: t.entrants.length,
      size: t.size || MAX_ENTRANTS,
      registerDeadline: t.registerDeadline,
      createdAt: t.createdAt,
      championName: t.championEid
        ? (t.entrants.find(e => e.eid === t.championEid) || {}).name || null : null,
      myEid: myE ? myE.eid : null,
      myStatus: myE ? myE.status : null,
    };
  });
  list.sort((a, b) => {
    const rank = (p) => p === 'registering' ? 0 : p === 'running' ? 1 : p === 'finished' ? 2 : 3;
    return rank(a.phase) - rank(b.phase) || b.createdAt - a.createdAt;
  });
  void now;
  return list;
}

function tLog(t, type, data) {
  t.log.push({ seq: t.log.length + 1, t: Date.now(), type, ...data });
}

module.exports = {
  STORE_VERSION, TOURNAMENT_ID_RE, MATCH_ID_RE, PID_RE,
  PHASES, ENTRANT_STATUSES, MATCH_STATUSES, RESULT_TYPES,
  MIN_ENTRANTS, MAX_ENTRANTS, MAX_NAME_LEN, MAX_TOURNAMENT_NAME_LEN,
  MAX_TIE_REPLAYS, MAX_HOST_REMATCH,
  DEFAULT_MATCH_WAIT_MS, DEFAULT_REGISTER_MS, FINISHED_TTL_MS,
  isValidPid, isValidTournamentId, cleanName,
  emptyStore, normalizeStore, normalizeTournament, normalizeRules,
  createTournament, getTournament, findEntrant, register, withdraw, cancel,
  startBracket, buildBracket,
  currentMatchFor, assignRoom, checkIn,
  reportMatchResult, forfeit, sweep, settleTimeout,
  hostRematch, rematch,
  pruneFinished, tournamentView, summaries,
  placementOf, shuffle,
};
