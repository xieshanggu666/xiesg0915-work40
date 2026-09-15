'use strict';
// 词语领地 —— 纯逻辑状态机。服务端与测试共用，不做任何 IO。

const RELATION_TYPES = [
  { id: 'synonym',  name: '同义/近义',   example: '快乐 → 开心' },
  { id: 'antonym',  name: '反义/对立',   example: '白天 → 黑夜' },
  { id: 'hypernym', name: '上下位',      example: '苹果 → 水果' },
  { id: 'part',     name: '部分-整体',   example: '轮子 → 汽车' },
  { id: 'cause',    name: '因果',        example: '下雨 → 路滑' },
  { id: 'tool',     name: '工具-用途',   example: '钥匙 → 开锁' },
  { id: 'scene',    name: '场景共现',    example: '沙滩 → 贝壳' },
  { id: 'derive',   name: '词形/谐音衍生', example: '猫 → 猫腻' },
];

const START_WORD_POOL = [
  '火', '海', '时间', '桥', '镜子', '种子', '风', '地图',
  '灯', '雨', '山', '钥匙', '歌', '路', '梦', '石头',
];

const DEFAULT_RULESET = {
  allowedRelations: RELATION_TYPES.map(r => r.id),
  allowProperNouns: false,   // 是否允许专有名词（人名/地名/品牌）
  minReasonLen: 4,           // 关系解释最少字数（服务端可校验）
  turnSeconds: 90,
  apPerTurn: 3,
  rounds: 4,                 // 每名玩家的回合数
  startWordCount: 3,
  challengeTokens: 3,        // 每人整局的质疑次数
};

const PLAYER_COLORS = ['#e0533d', '#2e86de', '#27ae60', '#8e44ad', '#d4a017', '#16a085'];

let uidCounter = 0;
function uid(prefix) {
  uidCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${uidCounter}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// ---------- 房间与玩家 ----------

const MAX_SPECTATORS = 20;

function newRoom(code, hostId, hostName) {
  return {
    // 房间稳定唯一标识：房间码 4 位会复用，不能作为"某一局是否计入赛季"的去重键；
    // id 在建房时生成、随房间落盘，用于赛季档案逐局记账（旧档无 id 时回退房间码，见 roomKey）。
    id: uid('room'),
    code,
    hostId,
    phase: 'lobby', // lobby | playing | ended
    ruleSet: { ...DEFAULT_RULESET },
    players: [],    // {id,name,color,connected,tokensLeft,autoPilot}
    spectators: [], // {id,name,connected} 只读观战者，不参与对局
    // 主题词包快照：房主在大厅从自己的本机词包中选用，内容随房间状态广播，
    // 所有玩家开局前都能看到主题与候选词；null 表示使用内置默认词池。
    wordPack: null, // {id,name,theme,words[]}
    startWords: [],
    nodes: [],      // {id,word,ownerId,parentId,relation,reason,reinforced,turnCreated,survivedAsRoot}
    log: [],        // 回放事件日志
    turn: null,     // {playerId,turnNumber,apLeft,deadline,pausedRemaining}
    pendingChallenge: null, // {id,nodeId,challengerId,adjudicatorId}
    winner: null,
    createdAt: Date.now(),
  };
}

// pid：由服务端从玩家密钥派生的公开标识（sha256，64 位十六进制），用于把同一玩家
// 不同房间里的对局汇总成赛季战绩；缺失/非法时为 null（无凭据的客户端，对局不进赛季榜）。
// 这里只做形状校验；pid 的"是否确实为该玩家所拥有"由服务端凭据解析保证，见 season.resolvePid。
function addPlayer(room, id, name, pid = null) {
  if (room.players.length >= 6) return '房间已满（最多 6 人）';
  if (room.phase !== 'lobby') return '游戏已开始，无法加入';
  const color = PLAYER_COLORS[room.players.length % PLAYER_COLORS.length];
  room.players.push({
    id, name: String(name || '玩家').slice(0, 12), color,
    connected: true, tokensLeft: room.ruleSet.challengeTokens,
    autoPilot: false, // 掉线/超时后进入托管：不发起质疑、不接受裁定指派，重连立即收回
    pid: /^[a-f0-9]{64}$/.test(pid) ? pid : null,
  });
  logEvent(room, 'join', { playerId: id, name });
  return null;
}

// ---------- 观战 ----------

// 观战者是只读身份：任意阶段（大厅/对局中/结束）都能进入，但不占玩家名额、
// 不进入回合顺序、不能发起任何行动。id 由服务器生成（带 sp_ 前缀以便辨认）。
function addSpectator(room, id, name) {
  if (!Array.isArray(room.spectators)) room.spectators = [];
  if (room.spectators.filter(s => s.connected).length >= MAX_SPECTATORS) {
    return '观战人数已满';
  }
  room.spectators.push({
    id, name: String(name || '观战者').slice(0, 12), connected: true,
  });
  logEvent(room, 'spectate', { spectatorId: id, name });
  return null;
}

function isSpectator(room, id) {
  return Array.isArray(room.spectators) && room.spectators.some(s => s.id === id);
}

// 观战者断线超过 ttlMs（默认 60 秒，覆盖页面刷新的短暂离线）后清出房间
function removeSpectator(room, id) {
  if (!Array.isArray(room.spectators)) return;
  const before = room.spectators.length;
  room.spectators = room.spectators.filter(s => s.id !== id);
  if (room.spectators.length !== before) logEvent(room, 'leave', { spectatorId: id });
}

// 服务器重启会销毁全部连接。观战者是临时只读身份、不占座位、没有需要保留的局面状态，
// 因此恢复房间时立即清出，而不是标成离线再等延迟清理——否则大厅/对局名单会在
// 重启后的一段时间内仍展示"已无连接的观战者"，名额也被虚占。想继续看的人重新输入房间码即可。
function removeAllSpectators(room) {
  if (Array.isArray(room.spectators)) room.spectators = [];
}

// 服务器重启后内存中的 WebSocket 全部消失，持久化的玩家 connected 标记已失真：
// 玩家先标记离线（保留座位/分数/颜色，凭 token 重连即恢复）。
// 观战者不在此处理——服务器恢复房间时会用 removeAllSpectators 立即清出。
function resetConnectionsAfterRestart(room) {
  room.players.forEach(p => { p.connected = false; });
  (room.spectators || []).forEach(s => { s.connected = false; });
}

// 所有行动的统一守门：观战者一律只读
function assertPlayer(room, id) {
  if (isSpectator(room, id)) return '观战者不能参与对局';
  return null;
}

function setRuleSet(room, playerId, patch) {
  if (isSpectator(room, playerId)) return '观战者不能修改规则';
  if (playerId !== room.hostId) return '只有房主可以修改规则';
  if (room.phase !== 'lobby') return '游戏开始后不能修改规则';
  const r = room.ruleSet;
  if (Array.isArray(patch.allowedRelations)) {
    const valid = patch.allowedRelations.filter(x => RELATION_TYPES.some(t => t.id === x));
    if (valid.length === 0) return '至少保留一种关系类型';
    r.allowedRelations = valid;
  }
  if (typeof patch.allowProperNouns === 'boolean') r.allowProperNouns = patch.allowProperNouns;
  if (Number.isInteger(patch.minReasonLen)) r.minReasonLen = clamp(patch.minReasonLen, 0, 50);
  if (Number.isInteger(patch.turnSeconds)) r.turnSeconds = clamp(patch.turnSeconds, 30, 300);
  if (Number.isInteger(patch.apPerTurn)) r.apPerTurn = clamp(patch.apPerTurn, 1, 6);
  if (Number.isInteger(patch.rounds)) r.rounds = clamp(patch.rounds, 1, 10);
  if (Number.isInteger(patch.challengeTokens)) r.challengeTokens = clamp(patch.challengeTokens, 0, 9);
  logEvent(room, 'rules', { ruleSet: r });
  return null;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------- 主题词包 ----------

// 服务端不采信客户端词包原文：只保留白名单字段并逐个清洗（与客户端 packs.js 校验口径一致），
// 词数/长度超限直接拒绝。id 只是客户端用来对照"当前选中的是本机哪个词包"的回显，不做校验。
function sanitizeWordPack(pack) {
  if (!pack || typeof pack !== 'object') return '词包数据无效';
  const name = String(pack.name || '').trim();
  if (!name || name.length > 12) return '词包名称需为 1~12 个字';
  const theme = String(pack.theme || '').trim();
  if (theme.length > 60) return '主题说明最多 60 个字';
  const words = [];
  for (const w of Array.isArray(pack.words) ? pack.words : []) {
    const word = String(w == null ? '' : w).trim();
    if (!word || word.length > 12 || /\s/.test(word)) continue;
    if (!words.includes(word)) words.push(word);
  }
  if (words.length < 3) return '词包至少需要 3 个有效候选词';
  if (words.length > 60) return '词包最多 60 个候选词';
  return { id: String(pack.id || '').slice(0, 40), name, theme, words };
}

// 房主在大厅选择/更换/清除主题词包；pack 为 null 表示改回默认词池
function setWordPack(room, playerId, pack) {
  if (isSpectator(room, playerId)) return '观战者不能选择词包';
  if (playerId !== room.hostId) return '只有房主可以选择词包';
  if (room.phase !== 'lobby') return '游戏开始后不能更换词包';
  if (pack === null || pack === undefined) {
    room.wordPack = null;
    logEvent(room, 'wordpack', { wordPack: null });
    return null;
  }
  const cleaned = sanitizeWordPack(pack);
  if (typeof cleaned === 'string') return cleaned;
  room.wordPack = cleaned;
  logEvent(room, 'wordpack', { wordPack: cleaned });
  return null;
}

// ---------- 开局 ----------

function startGame(room, playerId, rng = Math.random) {
  // internal=true 仅供服务器为"无个人房主"的赛事对阵房间在两名选手到齐时自动开局：
  // 规则在创建赛事时已定稿并随房间快照，不允许任何选手修改。
  const internal = playerId === '__tournament__';
  if (isSpectator(room, playerId) && !internal) return '观战者不能开始游戏';
  if (!internal && playerId !== room.hostId) return '只有房主可以开始游戏';
  if (room.phase !== 'lobby') return '游戏已开始';
  if (room.players.length < 2) return '至少需要 2 名玩家';
  // 起始词来源：房主选定的主题词包优先，否则用内置默认词池；均不重复抽取。
  // 词包候选词不足 startWordCount 时有多少抽多少。
  const source = room.wordPack && room.wordPack.words.length ? room.wordPack.words : START_WORD_POOL;
  const pool = [...source];
  room.startWords = [];
  const count = Math.min(room.ruleSet.startWordCount, pool.length);
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rng() * pool.length);
    room.startWords.push(pool.splice(idx, 1)[0]);
  }
  room.nodes = room.startWords.map((w, i) => ({
    id: `start${i}`, word: w, ownerId: null, parentId: null,
    relation: null, reason: '起始词', reinforced: true, turnCreated: 0,
  }));
  room.players.forEach(p => { p.tokensLeft = room.ruleSet.challengeTokens; });
  room.phase = 'playing';
  logEvent(room, 'start', { startWords: room.startWords, ruleSet: room.ruleSet,
    wordPack: room.wordPack ? room.wordPack.name : null,
    order: room.players.map(p => p.id) });
  beginTurn(room, 0);
  return null;
}

function beginTurn(room, playerIdx) {
  const player = room.players[playerIdx];
  room.turn = {
    playerId: player.id,
    turnNumber: (room.turn ? room.turn.turnNumber : 0) + 1,
    apLeft: room.ruleSet.apPerTurn,
    deadline: Date.now() + room.ruleSet.turnSeconds * 1000,
    pausedRemaining: null,
    pausedReason: null, // 'challenge' | 'autopilot'，区分质疑暂停与托管暂停
  };
  logEvent(room, 'turn', { playerId: player.id, turnNumber: room.turn.turnNumber,
    apLeft: room.turn.apLeft });
  // 在线（但上一回合超时挂起）的玩家轮到自己时自动收回控制权；仍离线的托管玩家
  // 由托管代为空过本回合（不挂倒计时），避免无人在线的对局空等一个完整回合计时。
  // 有待裁定质疑时计时本就暂停，不跳过回合（理论上质疑解决后才会推进到下一回合）。
  if (player.autoPilot && !room.pendingChallenge) {
    if (player.connected) {
      releaseAutoPilot(room, player.id, { reason: 'turn' });
    } else {
      logEvent(room, 'endTurn', { playerId: player.id, auto: true, reason: 'autopilot' });
      advanceTurn(room);
    }
  }
}

// ---------- 托管 ----------

function isAutoPilot(room, playerId) {
  const p = room.players.find(x => x.id === playerId);
  return !!(p && p.autoPilot);
}

// 玩家进入托管：掉线（reason:'disconnect'）或回合超时（reason:'timeout'）。
// - 若正好是行动玩家：暂停回合计时（质疑暂停优先，不覆盖质疑剩余时间），等其重连；
// - 若是当前待裁定质疑的裁定者：立即把裁定权移交给在线的合格玩家；
// - 托管期间不发起质疑、也不被指派为裁定者（见 challenge / pickAdjudicator）。
// 幂等：重复进入（同一玩家多连接逐个断开）不重复记日志、不重复移交。
function enterAutoPilot(room, playerId, reason = 'disconnect') {
  if (room.phase !== 'playing') return false;
  const p = room.players.find(x => x.id === playerId);
  if (!p) return false;
  const wasAuto = !!p.autoPilot;
  p.autoPilot = true;
  if (!wasAuto) {
    logEvent(room, 'autopilot', { playerId, reason });
  }
  // 行动玩家：暂停本回合倒计时（质疑暂停中的剩余时间归质疑所有，不动）
  if (room.turn && room.turn.playerId === playerId && room.turn.deadline) {
    room.turn.pausedRemaining = Math.max(0, room.turn.deadline - Date.now());
    room.turn.deadline = null;
    room.turn.pausedReason = 'autopilot';
  }
  // 裁定者：移交裁定权（内部仅在该玩家确为裁定者且离线/无资格时才换）
  ensureAdjudicatorOnline(room);
  return !wasAuto;
}

// 行动玩家在托管中且当前回合正因托管暂停而停表时，用暂停点剩余时间恢复倒计时。
// 质疑仍在裁定（pendingChallenge）时不动——计时归质疑暂停所有，等裁定结束再恢复。
// 返回是否实际恢复了计时。供重连收回（releaseAutoPilot / resumeOnReconnect）共用，
// 保证"掉线→重连"和"掉线→重启→重连"两条路径恢复口径完全一致。
function resumePausedTurn(room, playerId) {
  const t = room.turn;
  if (!t || t.playerId !== playerId || room.pendingChallenge) return false;
  if (t.deadline || t.pausedRemaining == null) return false;
  t.deadline = Date.now() + Math.max(0, t.pausedRemaining);
  t.pausedRemaining = null;
  t.pausedReason = null;
  return true;
}

// 重连（或在线玩家轮到自己）时立即收回控制权：清托管标记；若当前是行动玩家且计时
// 正因"托管"暂停而停住，恢复倒计时。质疑暂停（pausedReason='challenge'）不恢复。
function releaseAutoPilot(room, playerId, { reason = 'reconnect' } = {}) {
  const p = room.players.find(x => x.id === playerId);
  if (!p || !p.autoPilot) return false;
  p.autoPilot = false;
  logEvent(room, 'resume', { playerId, reason });
  resumePausedTurn(room, playerId);
  return true;
}

// 服务器重启后的玩家重连：重启会清掉 autoPilot 临时标记、玩家统一按普通离线处理，
// 因此这里不能依赖 autoPilot。它做三件事，保证重启前后状态一致：
//  1) 若该玩家是行动玩家、其回合仍处于暂停（重启保留了 pausedRemaining，见 loadRooms），
//     用暂停点剩余时间恢复倒计时——重启不会把暂停态错误重置成完整一回合；
//  2) 若待裁定质疑的裁定者已不在线，把裁定权移交给重连回来的合格玩家（或其他人）；
//  3) 行动玩家此前在托管暂停中，重连即收回，记一条 resume 日志让回放可见。
function resumeOnReconnect(room, playerId) {
  let resumed = false;
  const p = room.players.find(x => x.id === playerId);
  if (p && p.autoPilot) {
    p.autoPilot = false;
    resumed = true;
  }
  // 行动玩家的暂停回合恢复计时（重启保留的质疑/托管暂停都可能走到这里；
  // 质疑仍在裁定时 resumePausedTurn 内部不会动）。
  const wasPaused = !!room.turn && room.turn.playerId === playerId &&
    !room.turn.deadline && room.turn.pausedRemaining != null && !room.pendingChallenge;
  if (resumePausedTurn(room, playerId)) resumed = true;
  // 重启后待裁定质疑的原裁定者可能已离线：重连时尝试把裁定权交给在线合格玩家。
  if (ensureAdjudicatorOnline(room)) resumed = true;
  if (resumed || wasPaused) logEvent(room, 'resume', { playerId, reason: 'reconnect' });
  return resumed || wasPaused;
}

// ---------- 行动 ----------

function isActivePlayer(room, playerId) {
  return room.phase === 'playing' && room.turn && room.turn.playerId === playerId;
}

function playWord(room, playerId, { word, parentId, relation, reason }) {
  if (isSpectator(room, playerId)) return '观战者不能参与对局';
  if (!isActivePlayer(room, playerId)) return '还没轮到你';
  if (isAutoPilot(room, playerId)) return '你正处于托管中，重连后即可操作';
  if (room.pendingChallenge) return '有质疑正在裁定，请稍候';
  if (room.turn.apLeft < 1) return '行动点不足';
  word = String(word || '').trim();
  reason = String(reason || '').trim();
  if (!word || word.length > 12) return '词语需为 1~12 个字';
  if (/\s/.test(word)) return '词语中不能有空格';
  if (room.nodes.some(n => n.word === word)) return '这个词已经在场上了';
  const parent = room.nodes.find(n => n.id === parentId);
  if (!parent) return '要连接的词不存在';
  if (!room.ruleSet.allowedRelations.includes(relation)) return '该关系类型不在本局规则内';
  if (reason.length < room.ruleSet.minReasonLen) {
    return `解释至少需要 ${room.ruleSet.minReasonLen} 个字`;
  }
  const node = {
    id: uid('w'), word, ownerId: playerId, parentId,
    relation, reason, reinforced: false, turnCreated: room.turn.turnNumber,
  };
  room.nodes.push(node);
  room.turn.apLeft -= 1;
  logEvent(room, 'play', { node: { ...node }, apLeft: room.turn.apLeft });
  return null;
}

function reinforce(room, playerId, nodeId) {
  if (isSpectator(room, playerId)) return '观战者不能参与对局';
  if (!isActivePlayer(room, playerId)) return '还没轮到你';
  if (isAutoPilot(room, playerId)) return '你正处于托管中，重连后即可操作';
  if (room.pendingChallenge) return '有质疑正在裁定，请稍候';
  if (room.turn.apLeft < 1) return '行动点不足';
  const node = room.nodes.find(n => n.id === nodeId);
  if (!node) return '目标词不存在';
  if (node.ownerId !== playerId) return '只能加固自己的词';
  if (!node.parentId) return '起始词无需加固';
  if (node.reinforced) return '这条连接已经加固过了';
  node.reinforced = true;
  room.turn.apLeft -= 1;
  logEvent(room, 'reinforce', { nodeId, playerId, apLeft: room.turn.apLeft });
  return null;
}

function endTurn(room, playerId, { auto = false, reason = null } = {}) {
  if (isSpectator(room, playerId)) return '观战者不能参与对局';
  if (!isActivePlayer(room, playerId)) return '还没轮到你';
  if (room.pendingChallenge) return '有质疑正在裁定';
  // 托管期间玩家不能手动结束回合；但托管代为结束（超时 auto，或轮到仍离线者由
  // beginTurn 内部跳过）必须放行，否则无人在线的对局无法推进。
  if (isAutoPilot(room, playerId) && !auto) return '你正处于托管中，重连后即可操作';
  logEvent(room, 'endTurn', { playerId, auto, reason });
  advanceTurn(room);
  return null;
}

function advanceTurn(room) {
  const idx = room.players.findIndex(p => p.id === room.turn.playerId);
  const totalTurns = room.players.length * room.ruleSet.rounds;
  if (room.turn.turnNumber >= totalTurns) {
    finishGame(room);
    return;
  }
  beginTurn(room, (idx + 1) % room.players.length);
}

function finishGame(room) {
  room.phase = 'ended';
  room.turn = null;
  room.endedAt = Date.now(); // 供历史战绩列表展示与排序
  const scores = computeScores(room);
  const best = Math.max(...scores.map(s => s.total));
  const winners = scores.filter(s => s.total === best).map(s => s.playerId);
  room.winner = winners.length === 1 ? winners[0] : null; // 平局则无唯一胜者
  logEvent(room, 'end', { scores, winner: room.winner });
}

// ---------- 质疑与裁定 ----------

// 挑选裁定者：房主优先，但必须在线且未托管——离线/托管的房主无法裁定，质疑会把对局卡住。
// 涉及房主的词、或房主离线/托管时，顺延给既不是词主也不是质疑者的在线、非托管玩家；
// 实在没有合格人选时兜底归房主（可能离线/托管，由调用方决定是否拒绝这次质疑）。
function pickAdjudicator(room, node, challengerId) {
  const eligible = p => p.connected && !p.autoPilot &&
    p.id !== node.ownerId && p.id !== challengerId;
  const host = room.players.find(p => p.id === room.hostId);
  if (host && eligible(host)) return room.hostId;
  const other = room.players.find(eligible);
  return other ? other.id : room.hostId;
}

function challenge(room, playerId, nodeId) {
  if (room.phase !== 'playing') return '游戏未在进行中';
  if (isSpectator(room, playerId)) return '观战者不能发起质疑';
  if (isAutoPilot(room, playerId)) return '你正处于托管中，重连后才能发起质疑';
  if (room.pendingChallenge) return '已有质疑正在裁定';
  if (isActivePlayer(room, playerId)) return '自己的回合不能发起质疑';
  const player = room.players.find(p => p.id === playerId);
  if (!player) return '你不在房间中';
  if (player.tokensLeft <= 0) return '你的质疑次数已用完';
  const node = room.nodes.find(n => n.id === nodeId);
  if (!node || !node.ownerId) return '只能质疑玩家接出的词';
  if (node.ownerId === playerId) return '不能质疑自己的词';
  if (node.reinforced) return '加固过的连接免疫质疑';
  const adjudicator = pickAdjudicator(room, node, playerId);
  // 没有在线、非托管裁定者时直接拒绝：不扣次数、不暂停计时——否则质疑无人裁定会卡住整局
  const adj = room.players.find(p => p.id === adjudicator);
  if (!adj || !adj.connected || adj.autoPilot) {
    return '暂时没有在线的玩家可以裁定，无法发起质疑';
  }
  player.tokensLeft -= 1;
  room.pendingChallenge = {
    id: uid('c'), nodeId, challengerId: playerId, adjudicatorId: adjudicator,
  };
  // 暂停回合计时（托管暂停已经把倒计时停住时不覆盖：质疑结束后仍归托管暂停）
  if (room.turn && room.turn.deadline) {
    room.turn.pausedRemaining = Math.max(0, room.turn.deadline - Date.now());
    room.turn.deadline = null;
    room.turn.pausedReason = 'challenge';
  }
  logEvent(room, 'challenge', { challengeId: room.pendingChallenge.id, nodeId,
    challengerId: playerId, adjudicatorId: adjudicator, tokensLeft: player.tokensLeft });
  return null;
}

function resolveChallenge(room, playerId, verdict) {
  const ch = room.pendingChallenge;
  if (!ch) return '没有待裁定的质疑';
  if (isSpectator(room, playerId)) return '观战者不能参与裁定';
  if (isAutoPilot(room, playerId)) return '你正处于托管中，不能代为裁定';
  if (ch.adjudicatorId !== playerId) return '只有裁定者可以判定';
  if (verdict !== 'uphold' && verdict !== 'reject') return '无效的裁定';
  const node = room.nodes.find(n => n.id === ch.nodeId);
  const removed = [];
  if (verdict === 'uphold' && node) {
    // 连接不成立：移除该词；未加固的下游级联移除，加固过的下游成为新根
    cascadeRemove(room, node.id, removed);
  }
  room.pendingChallenge = null;
  // 恢复计时：仅当行动玩家当前在线且未托管时才恢复——行动玩家可能在质疑期间掉线
  // （重启后按普通离线处理，或其 autoPilot 仍在），此时转为托管暂停继续停表，
  // 等其重连收回时再用暂停点剩余时间恢复，避免裁定结束立刻按一个已过期的 deadline 超时。
  const activePlayer = room.turn && room.players.find(p => p.id === room.turn.playerId);
  const activeAvailable = !!activePlayer && activePlayer.connected && !activePlayer.autoPilot;
  if (room.turn && room.turn.pausedRemaining != null) {
    if (activeAvailable) {
      // 兜底：暂停剩余时间已耗尽（如服务器在暂停中停留极久）时给 1 秒缓冲，
      // 而不是恢复一个 deadline≈now、定时器一挂就立即超时的回合。
      const remain = Math.max(1000, room.turn.pausedRemaining);
      room.turn.deadline = Date.now() + remain;
      room.turn.pausedRemaining = null;
      room.turn.pausedReason = null;
    } else {
      room.turn.pausedReason = 'autopilot'; // 行动玩家掉线/托管：继续停表等重连
    }
  }
  logEvent(room, 'resolve', { challengeId: ch.id, verdict,
    removed: removed.map(n => n.id) });
  return null;
}

function cascadeRemove(room, nodeId, removed) {
  const node = room.nodes.find(n => n.id === nodeId);
  if (!node) return;
  removed.push(node);
  room.nodes = room.nodes.filter(n => n.id !== nodeId);
  for (const child of room.nodes.filter(n => n.parentId === nodeId)) {
    if (child.reinforced) {
      child.parentId = null; // 加固连接撑住了，成为新的领地根
      child.survivedAsRoot = true;
    } else {
      cascadeRemove(room, child.id, removed);
    }
  }
}

// 裁定者掉线/进入托管时，把裁定权移交给在线且非托管的合格玩家，避免对局卡死。
// 托管（含超时挂起）期间不接受裁定指派，即便该玩家仍连着线也一样顺延。
function ensureAdjudicatorOnline(room) {
  const ch = room.pendingChallenge;
  if (!ch) return false;
  const adj = room.players.find(p => p.id === ch.adjudicatorId);
  if (adj && adj.connected && !adj.autoPilot) return false;
  const node = room.nodes.find(n => n.id === ch.nodeId);
  const candidate = room.players.find(p =>
    p.connected && !p.autoPilot &&
    p.id !== ch.challengerId && (!node || p.id !== node.ownerId));
  if (!candidate) return false;
  ch.adjudicatorId = candidate.id;
  logEvent(room, 'adjudicator', { challengeId: ch.id, adjudicatorId: candidate.id });
  return true;
}

// ---------- 计分 ----------

function depthOf(room, node) {
  // 深度 = 向上追溯到根经过的玩家词数；中立的起始词不计入
  let d = 0, cur = node, guard = 0;
  while (cur.parentId && guard < 1000) {
    const parent = room.nodes.find(n => n.id === cur.parentId);
    if (!parent || parent.ownerId === null) break;
    d += 1; cur = parent; guard += 1;
  }
  return d;
}

function computeScores(room) {
  return room.players.map(p => {
    const mine = room.nodes.filter(n => n.ownerId === p.id);
    let total = 0, longest = 0;
    for (const n of mine) {
      const depth = depthOf(room, n);
      total += 1 + depth;                 // 越深（链越长）的词分越高
      if (n.reinforced && n.parentId) total += 1; // 加固奖励
      longest = Math.max(longest, depth + 1);
    }
    total += longest * 2;                 // 最长链奖励
    return { playerId: p.id, name: p.name, color: p.color,
      words: mine.length, longestChain: longest, total };
  }).sort((a, b) => b.total - a.total);
}

// ---------- 日志 / 回放 ----------

// 历史与战绩摘要：供"我参与过的对局"列表使用。未结束的房间也返回（便于重返对局），
// 此时名次/得分/胜者为 null。非本房玩家返回 null。
function historySummary(room, playerId) {
  const me = room.players.find(p => p.id === playerId);
  if (!me) return null;
  const ended = room.phase === 'ended';
  const scores = ended ? computeScores(room) : null;
  const mine = scores ? scores.find(s => s.playerId === playerId) : null;
  const winnerPlayer = room.winner ? room.players.find(p => p.id === room.winner) : null;
  return {
    code: room.code,
    phase: room.phase,
    createdAt: room.createdAt,
    endedAt: room.endedAt || null,
    youId: me.id,
    youName: me.name,
    players: room.players.map(p => p.name),
    winner: room.winner,
    winnerName: winnerPlayer ? winnerPlayer.name : null,
    yourRank: scores ? scores.findIndex(s => s.playerId === playerId) + 1 : null,
    yourTotal: mine ? mine.total : null,
  };
}

function logEvent(room, type, data) {
  room.log.push({ seq: room.log.length + 1, t: Date.now(), type, ...data });
}

// ---------- 已结束房间的保留期 ----------
// 结束的房间（连同整份回放日志）只在保留期内落盘，超期清除，避免存档只增不减。
// 赛季战绩在结束那一刻已单独累计进 season.json，删房不影响排行榜与个人页。

// 某一局在赛季档案里的逐局去重键：优先用建房时生成的唯一 id（加载旧档时由
// ensureRoomId 补上并随存档固化，重启后仍稳定）；都拿不到时才退回带前缀的房间码。
function roomKey(room) {
  return room && typeof room.id === 'string' && room.id ? room.id : `code:${room && room.code}`;
}

// 旧版本存档里的结束房间没有 id：加载时补一个，之后同一局（含重启）始终用同一个键。
function ensureRoomId(room) {
  if (!room) return room;
  if (typeof room.id !== 'string' || !room.id) room.id = uid('room');
  return room;
}

// 旧存档没有 endedAt 时退回 createdAt（最多差一局时长，不影响大局）。
function isRoomExpired(room, ttlMs, now = Date.now()) {
  if (!room || room.phase !== 'ended' || !(ttlMs > 0)) return false;
  const endedAt = room.endedAt || room.createdAt || 0;
  return endedAt > 0 && now - endedAt >= ttlMs;
}

// 从房间集合中批量移除超期房间。rooms 为 Map<code, room>，与服务端内存结构一致；
// 返回被清掉的房间列表，调用方据此删除对应 token 并落盘。赛季记录不在此处处理。
function pruneExpiredRooms(rooms, ttlMs, now = Date.now()) {
  if (!(ttlMs > 0) || !(rooms instanceof Map)) return [];
  const removed = [];
  for (const [code, room] of rooms) {
    if (isRoomExpired(room, ttlMs, now)) {
      rooms.delete(code);
      removed.push(room);
    }
  }
  return removed;
}

// 仅供自包含端到端冒烟使用：用房间上的 _turnMsOverride 校正当前新回合的 deadline。
// fresh=true 仅在新回合（开局/结束回合/超时推进）时把 deadline 重置为覆盖时长；
// fresh=false（重连/裁定后恢复计时）保留暂停点的剩余时间，只在没有 deadline 时兜底。
// 生产房间没有该字段，函数为空操作（仍以 ruleSet.turnSeconds 为准）。
function applyTurnMsOverride(room, fresh = true) {
  const ms = room && room._turnMsOverride;
  if (room.phase !== 'playing' || !room.turn || !(Number.isFinite(ms) && ms > 0)) return;
  if (fresh || !room.turn.deadline) {
    room.turn.deadline = Date.now() + Math.max(20, Math.trunc(ms));
  }
}

// 由事件日志重建每一步的盘面快照，供回放使用。
// 每帧带语义化的 kind，客户端据此把关键事件（质疑/拆除/加固/结算）标出来供跳转。
function buildReplay(room) {
  const frames = [];
  const snap = { nodes: [], turn: null, scores: null };
  const clone = o => JSON.parse(JSON.stringify(o));
  const playerName = (pid) => (room.players.find(p => p.id === pid) || {}).name || '玩家';
  const wordOf = (nodeId) => (snap.nodes.find(n => n.id === nodeId) || {}).word;
  const challenges = new Map(); // challengeId → 被质疑的 nodeId，裁定帧取词用
  frames.push({ kind: 'create', label: '房间创建', nodes: [], turn: null });
  for (const ev of room.log) {
    let label = null, kind = ev.type;
    switch (ev.type) {
      case 'start':
        snap.nodes = ev.startWords.map((w, i) => ({ id: `start${i}`, word: w,
          ownerId: null, parentId: null, reinforced: true, relation: null, reason: '起始词' }));
        label = `${ev.wordPack ? `主题词包「${ev.wordPack}」` : ''}开局，起始词：${ev.startWords.join('、')}`;
        break;
      case 'turn':
        snap.turn = { playerId: ev.playerId, turnNumber: ev.turnNumber };
        label = `第 ${ev.turnNumber} 回合开始`;
        break;
      case 'play':
        snap.nodes.push(clone(ev.node));
        label = `接出「${ev.node.word}」`;
        break;
      case 'reinforce': {
        const n = snap.nodes.find(x => x.id === ev.nodeId);
        if (n) n.reinforced = true;
        label = `${playerName(ev.playerId)} 加固了「${wordOf(ev.nodeId) || '?'}」的连接`;
        break;
      }
      case 'challenge':
        challenges.set(ev.challengeId, ev.nodeId);
        label = `${playerName(ev.challengerId)} 质疑「${wordOf(ev.nodeId) || '?'}」`;
        break;
      case 'resolve': {
        // 先取被拆词的名字，再从快照移除
        const removedWords = (ev.removed || []).map(wordOf).filter(Boolean);
        if (ev.removed && ev.removed.length) {
          snap.nodes = snap.nodes.filter(n => !ev.removed.includes(n.id));
          // 级联后幸存子节点成为根
          for (const n of snap.nodes) {
            if (n.parentId && !snap.nodes.some(p => p.id === n.parentId)) n.parentId = null;
          }
        }
        if (ev.verdict === 'uphold') {
          kind = 'demolish';
          label = removedWords.length === 0 ? '质疑成立，连接被拆除'
            : removedWords.length === 1 ? `质疑成立，拆除「${removedWords[0]}」`
            : `质疑成立，拆除「${removedWords[0]}」等 ${removedWords.length} 个词`;
        } else {
          kind = 'keep';
          label = `质疑不成立，「${wordOf(challenges.get(ev.challengeId)) || '?'}」保留`;
        }
        break;
      }
      case 'endTurn':
        // 托管代为空过单独成帧（含离线轮到自己与超时代结），普通手动结束回合不打断回放
        if (ev.auto && ev.reason === 'autopilot') {
          kind = 'autopilot';
          label = `${playerName(ev.playerId)} 离线托管，代为结束回合`;
        } else {
          label = null;
        }
        break;
      case 'autopilot': {
        kind = 'autopilot';
        const why = ev.reason === 'timeout' ? '回合超时' : '掉线';
        label = `${playerName(ev.playerId)} ${why}，进入托管`;
        break;
      }
      case 'resume': {
        kind = 'resume';
        const how = ev.reason === 'turn' ? '轮到自己' : '重连';
        label = `${playerName(ev.playerId)} ${how}，收回控制权`;
        break;
      }
      case 'adjudicator':
        label = `裁定权移交给 ${playerName(ev.adjudicatorId)}`;
        break;
      case 'end':
        snap.scores = ev.scores;
        label = '游戏结束，结算';
        break;
      default:
        break;
    }
    if (label) frames.push({ kind, label, nodes: clone(snap.nodes), turn: clone(snap.turn),
      scores: snap.scores ? clone(snap.scores) : null });
  }
  return frames;
}

// 发给客户端的个性化视图（目前所有信息都是公开的，直接整体发）
function publicView(room, forPlayerId) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    you: forPlayerId,
    spectating: isSpectator(room, forPlayerId),
    ruleSet: room.ruleSet,
    wordPack: room.wordPack || null,
    players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color,
      connected: p.connected, autoPilot: !!p.autoPilot, tokensLeft: p.tokensLeft })),
    spectators: (room.spectators || []).map(s => ({ id: s.id, name: s.name,
      connected: s.connected })),
    startWords: room.startWords,
    nodes: room.nodes,
    turn: room.turn,
    pendingChallenge: room.pendingChallenge,
    winner: room.winner,
    scores: room.phase === 'ended' ? computeScores(room) : null,
    relationTypes: RELATION_TYPES,
  };
}

module.exports = {
  RELATION_TYPES, DEFAULT_RULESET, START_WORD_POOL, MAX_SPECTATORS,
  newRoom, addPlayer, addSpectator, isSpectator, removeSpectator, removeAllSpectators,
  resetConnectionsAfterRestart,
  setRuleSet, setWordPack, sanitizeWordPack, startGame,
  playWord, reinforce, endTurn, challenge, resolveChallenge, ensureAdjudicatorOnline,
  isAutoPilot, enterAutoPilot, releaseAutoPilot, resumeOnReconnect, applyTurnMsOverride,
  computeScores, buildReplay, publicView, cascadeRemove, historySummary,
  isRoomExpired, pruneExpiredRooms, roomKey, ensureRoomId,
};
