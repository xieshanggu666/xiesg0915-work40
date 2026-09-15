'use strict';
// 赛季战绩纯逻辑单测：对局汇总、幂等、平局、跨房聚合、排行榜排序与个人页汇总。
const test = require('node:test');
const assert = require('node:assert');
const g = require('../game');
const s = require('../season');

// 公开 pid 是 64 位十六进制（sha256 摘要形状）；这里直接用重复字符模拟其形状
const PID_A = 'a'.repeat(64);
const PID_B = 'b'.repeat(64);
const PID_C = 'c'.repeat(64);
// 三把玩家密钥（64 位十六进制），由服务端 derivePid 派生出各自公开 pid
const SECRET_A = '1'.repeat(64);
const SECRET_B = '2'.repeat(64);

// 造一局并打完：players 为 [{name, pid}]；moves 给每名玩家在其回合接的词（接到 start0 下）。
// 返回时房间已 ended，且每个玩家至少有一个词，分数可预测。
function playGame(names, { rounds = 1, chains = {}, tag = '' } = {}) {
  const players = names.map((name, i) => ({ name, pid: ['a', 'b', 'c'][i].repeat(64) }));
  const room = g.newRoom('CODE' + tag + Math.floor(Math.random() * 1e9), 'p0', players[0].name);
  players.forEach((p, i) => g.addPlayer(room, `p${i}`, p.name, p.pid));
  const err = g.setRuleSet(room, 'p0', { rounds, startWordCount: 1 });
  assert.strictEqual(err, null);
  assert.strictEqual(g.startGame(room, 'p0', () => 0.01), null);
  // 每个玩家回合内接一个词到 start0，避免互相接词导致被质疑拆除的复杂局面
  const used = new Set();
  let guard = 0;
  while (room.phase === 'playing' && guard++ < 100) {
    const idx = room.players.findIndex(p => p.id === room.turn.playerId);
    let word = `词${idx}-${room.turn.turnNumber}`;
    let n = 1;
    while (used.has(word)) word = `词${idx}-${room.turn.turnNumber}-${n++}`;
    used.add(word);
    g.playWord(room, room.turn.playerId, {
      word, parentId: 'start0', relation: 'synonym', reason: '足够长的关系解释',
    });
    g.endTurn(room, room.turn.playerId);
  }
  assert.strictEqual(room.phase, 'ended');
  return room;
}

test('pid 形状校验：只认 64 位十六进制（sha256 摘要形状）', () => {
  assert.strictEqual(s.isValidPid(PID_A), true);
  assert.strictEqual(s.isValidPid('a'.repeat(64)), true);
  for (const bad of ['', 'xyz', 'a'.repeat(16), 'a'.repeat(32), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), null, 123]) {
    assert.strictEqual(s.isValidPid(bad), false);
  }
});

test('密钥校验：只认 64 位十六进制', () => {
  assert.strictEqual(s.isValidPidSecret(SECRET_A), true);
  for (const bad of ['', 'xyz', '1'.repeat(63), '1'.repeat(65), 'g'.repeat(64), null]) {
    assert.strictEqual(s.isValidPidSecret(bad), false);
  }
});

test('derivePid：合法密钥派生 64 位 pid，非法密钥返回 null，且确定/可区分', () => {
  const pidA = s.derivePid(SECRET_A);
  assert.ok(s.isValidPid(pidA));
  assert.strictEqual(pidA, s.derivePid(SECRET_A), '同一密钥派生结果确定');
  assert.notStrictEqual(pidA, s.derivePid(SECRET_B), '不同密钥派生不同 pid');
  assert.notStrictEqual(pidA, SECRET_A, 'pid 不应等于密钥本身');
  assert.strictEqual(s.derivePid('nope'), null);
});

test('resolvePid：只凭密钥认领 pid；自报他人 pid 一律拒绝（防冒用核心）', () => {
  // 正常：提交自己的密钥，派生出对应 pid
  assert.strictEqual(s.resolvePid({ pidSecret: SECRET_A }).pid, s.derivePid(SECRET_A));
  // 攻击：不提供密钥，直接提交从排行榜看到的受害者 pid —— 必须得到 null
  assert.strictEqual(s.resolvePid({ pid: PID_A }).pid, null);
  // 攻击：密钥非法，却同时塞一个受害者 pid —— 仍必须得到 null（pid 被忽略）
  assert.strictEqual(s.resolvePid({ pid: PID_A, pidSecret: 'forged' }).pid, null);
  assert.strictEqual(s.resolvePid({}).pid, null);
  assert.strictEqual(s.resolvePid().pid, null);
  // 即使提交的"密钥"恰好是别人的 pid（64 位十六进制），也只会派生出另一个无关 pid
  const spoof = s.resolvePid({ pidSecret: PID_A }).pid;
  assert.ok(s.isValidPid(spoof));
  assert.notStrictEqual(spoof, PID_A, '拿别人 pid 当密钥也无法认领该 pid');
});

test('一局结束：每名玩家计入一场，分数/最长链/胜者汇总正确且幂等', () => {
  const room = playGame(['甲', '乙']);
  const scores = g.computeScores(room);
  const winnerId = room.winner;
  const season = s.emptySeason(1000);
  const r1 = s.recordRoom(season, room, 5000);
  assert.strictEqual(r1.recorded, 2);
  assert.strictEqual(r1.changed, true);
  assert.strictEqual(room.seasonRecorded, true);
  for (const sc of scores) {
    const pid = room.players.find(p => p.id === sc.playerId).pid;
    const row = season.players[pid];
    assert.strictEqual(row.games, 1);
    assert.strictEqual(row.wins, winnerId === sc.playerId ? 1 : 0);
    assert.strictEqual(row.totalScore, sc.total);
    assert.strictEqual(row.bestChain, sc.longestChain);
    assert.strictEqual(row.lastAt, room.endedAt);
  }
  // 同一房间再计一次：幂等，不重复累计
  const r2 = s.recordRoom(season, room, 6000);
  assert.strictEqual(r2.recorded, 0);
  assert.strictEqual(r2.changed, false);
  assert.strictEqual(season.players[PID_A].games, 1);
});

test('未结束/空房间不计入；无 pid 的玩家跳过但房间照常标记', () => {
  const season = s.emptySeason();
  const playing = g.newRoom('X1', 'p0', '甲');
  g.addPlayer(playing, 'p0', '甲', PID_A);
  g.addPlayer(playing, 'p1', '乙', PID_B);
  assert.strictEqual(s.recordRoom(season, playing).changed, false);
  assert.ok(!playing.seasonRecorded);

  const room = playGame(['甲', '乙']);
  // 抹掉乙的 pid（模拟旧客户端）
  room.players[1].pid = null;
  room.seasonRecorded = false;
  const r = s.recordRoom(season, room);
  assert.strictEqual(r.recorded, 1);
  assert.strictEqual(season.players[PID_A].games, 1);
  assert.strictEqual(season.players[PID_B], undefined);
  assert.strictEqual(room.seasonRecorded, true);
});

test('跨房间聚合同一 pid：场次累加、平均得分、最高连锁取最大、昵称更新', () => {
  const season = s.emptySeason();
  const r1 = playGame(['甲', '乙']); s.recordRoom(season, r1);
  const r2 = playGame(['甲', '乙']); s.recordRoom(season, r2);
  const sa = season.players[PID_A];
  const sc1 = g.computeScores(r1).find(x => x.playerId === 'p0');
  const sc2 = g.computeScores(r2).find(x => x.playerId === 'p0');
  assert.strictEqual(sa.games, 2);
  assert.strictEqual(sa.totalScore, sc1.total + sc2.total);
  const prof = s.getProfile(season, PID_A);
  assert.strictEqual(prof.avgScore, Math.round((sc1.total + sc2.total) / 2 * 10) / 10);
  assert.ok(prof.bestChain >= 1);
});

test('平局：人人算平、无人算负，胜率按胜场/场次', () => {
  const season = s.emptySeason();
  const room = playGame(['甲', '乙']);
  room.winner = null; // 强制并列
  room.seasonRecorded = false;
  s.recordRoom(season, room);
  const prof = s.getProfile(season, PID_A);
  assert.strictEqual(prof.games, 1);
  assert.strictEqual(prof.wins, 0);
  assert.strictEqual(prof.ties, 1);
  assert.strictEqual(prof.losses, 0);
  assert.strictEqual(prof.winRate, 0);
});

test('排行榜：总分/胜场/胜率三种排序与名次，空赛季返回空表', () => {
  const season = s.emptySeason();
  // 手工造记录：A 总分高但只打 1 场；B 胜场多胜率稳；C 场次多
  season.players[PID_A] = { pid: PID_A, name: '阿强', games: 1, wins: 1, ties: 0, totalScore: 100, bestChain: 5, lastAt: 1 };
  season.players[PID_B] = { pid: PID_B, name: '阿花', games: 4, wins: 3, ties: 1, totalScore: 80, bestChain: 4, lastAt: 2 };
  season.players[PID_C] = { pid: PID_C, name: '阿伟', games: 10, wins: 2, ties: 0, totalScore: 60, bestChain: 3, lastAt: 3 };

  const byTotal = s.leaderboard(season, { sort: 'total' });
  assert.deepStrictEqual(byTotal.map(r => r.pid), [PID_A, PID_B, PID_C]);
  assert.deepStrictEqual(byTotal.map(r => r.rank), [1, 2, 3]);

  const byWins = s.leaderboard(season, { sort: 'wins' });
  assert.deepStrictEqual(byWins.map(r => r.pid), [PID_B, PID_C, PID_A]);

  const byRate = s.leaderboard(season, { sort: 'rate' });
  assert.deepStrictEqual(byRate.map(r => r.pid), [PID_A, PID_B, PID_C]);
  // A 胜率 1.0（1/1），B 0.75（3/4），C 0.2
  assert.strictEqual(byRate[0].winRate, 1);
  assert.strictEqual(byRate[1].winRate, 0.75);

  // 非法/缺省排序回退总分
  assert.deepStrictEqual(s.leaderboard(season, { sort: 'hack' }).map(r => r.pid), [PID_A, PID_B, PID_C]);
  assert.deepStrictEqual(s.leaderboard(season).map(r => r.pid), [PID_A, PID_B, PID_C]);
  assert.deepStrictEqual(s.leaderboard(s.emptySeason()), []);
});

test('排行榜行含派生字段：平均得分、胜率、负场', () => {
  const season = s.emptySeason();
  season.players[PID_B] = { pid: PID_B, name: '阿花', games: 4, wins: 3, ties: 1, totalScore: 80, bestChain: 4, lastAt: 2 };
  const row = s.leaderboard(season, { sort: 'wins' })[0];
  assert.strictEqual(row.avgScore, 20);
  assert.strictEqual(row.losses, 0);
  assert.strictEqual(row.winRate, 0.75);
});

test('个人页：无记录/非法 pid 返回 null；有记录附带总分榜名次', () => {
  assert.strictEqual(s.getProfile(s.emptySeason(), PID_A), null);
  assert.strictEqual(s.getProfile(s.emptySeason(), 'nope'), null);
  const season = s.emptySeason();
  season.players[PID_A] = { pid: PID_A, name: '阿强', games: 1, wins: 1, ties: 0, totalScore: 100, bestChain: 5, lastAt: 1 };
  const prof = s.getProfile(season, PID_A);
  assert.strictEqual(prof.rank, 1);
  assert.strictEqual(prof.name, '阿强');
});

test('个人页附带成就徽章：读时派生、按累计数据点亮并给出未达成进度', () => {
  const achievements = require('../public/achievements');
  const season = s.emptySeason();
  season.players[PID_A] = { pid: PID_A, name: '阿强', games: 1, wins: 1, ties: 0, totalScore: 100, bestChain: 5, lastAt: 1 };
  const prof = s.getProfile(season, PID_A);
  assert.ok(Array.isArray(prof.badges));
  assert.strictEqual(prof.badges.length, achievements.BADGES.length);
  // 1 场 1 胜、最高连锁 5：场次1/胜场1/连锁3与5 点亮，其他待解锁
  assert.strictEqual(prof.badges.find(b => b.id === 'games-1').earned, true);
  assert.strictEqual(prof.badges.find(b => b.id === 'games-10').earned, false);
  assert.strictEqual(prof.badges.find(b => b.id === 'games-10').current, 1);
  assert.strictEqual(prof.badges.find(b => b.id === 'wins-1').earned, true);
  assert.strictEqual(prof.badges.find(b => b.id === 'chain-5').earned, true);
  assert.strictEqual(prof.badges.find(b => b.id === 'chain-8').earned, false);
  assert.strictEqual(prof.badges.find(b => b.id === 'chain-8').current, 5);
});

test('normalizeSeason：补零缺字段、丢弃非法 pid/脏条目，保留有效记录', () => {
  const raw = {
    version: 3,
    season: 1,
    startedAt: 123,
    players: {
      [PID_A]: { pid: PID_A, name: '甲', games: 3, wins: 2, ties: 0, totalScore: 30, bestChain: 4, lastAt: 9 },
      badshort: { pid: 'badshort', name: '脏', games: 9 },
      [PID_B]: { name: '乙' }, // 字段全缺：补零，仍是有效 pid
    },
    recordedRooms: { room_ok: 5000, bad: 0, bad2: 'x' },
  };
  const { season, legacy } = s.normalizeSeason(raw);
  assert.strictEqual(legacy, false, 'v3 档案不是旧版');
  assert.strictEqual(season.version, 3);
  assert.strictEqual(season.season, 1);
  assert.strictEqual(season.startedAt, 123);
  assert.deepStrictEqual(season.history, []);
  assert.strictEqual(season.players[PID_A].games, 3);
  assert.strictEqual(season.players['badshort'], undefined);
  const b = season.players[PID_B];
  assert.strictEqual(b.games, 0);
  assert.strictEqual(b.name, '乙');
  // 逐局索引：合法条目保留，非法条目丢弃
  assert.deepStrictEqual(season.recordedRooms, { room_ok: 5000 });
  // 损坏输入不抛错，得到空赛季
  assert.deepStrictEqual(s.normalizeSeason(null).season.players, {});
  assert.deepStrictEqual(s.normalizeSeason('x').season.players, {});
});

test('normalizeSeason：无 version/version 1/2 的档案标记为旧版（legacy），平滑升级为第 1 赛季', () => {
  const { season: v1, legacy } = s.normalizeSeason({ startedAt: 1, players: {} });
  assert.strictEqual(legacy, true);
  assert.deepStrictEqual(v1.recordedRooms, {});
  assert.strictEqual(s.normalizeSeason({ version: 1, players: {} }).legacy, true);
  assert.strictEqual(s.normalizeSeason({ version: 2, players: {} }).legacy, false);
  assert.strictEqual(s.normalizeSeason({ version: 3, players: {} }).legacy, false);
  // 首次启动（无文件）走 catch，emptySeason 自身是 v3 的第 1 赛季
  const fresh = s.emptySeason();
  assert.strictEqual(fresh.version, 3);
  assert.strictEqual(fresh.season, 1);
  assert.deepStrictEqual(fresh.recordedRooms, {});
  assert.deepStrictEqual(fresh.history, []);
});

test('normalizeSeason：v2 档案整体迁移为第 1 赛季，战绩与索引原样保留、不重算', () => {
  const room = playGame(['甲', '乙']);
  const v2 = s.emptySeason(1000);
  v2.version = 2;
  s.recordRoom(v2, room);
  const { season, legacy } = s.normalizeSeason(JSON.parse(JSON.stringify(v2)));
  assert.strictEqual(legacy, false, 'v2 有索引，不需要旧版对账');
  assert.strictEqual(season.version, 3);
  assert.strictEqual(season.season, 1);
  assert.strictEqual(season.players[PID_A].games, 1, '迁移不重算战绩');
  assert.strictEqual(s.isRoomRecorded(season, room), true, '全局索引随迁，旧局不会被再计一遍');
  // 迁移后再对同一房间 recordRoom：被索引挡住
  assert.strictEqual(s.recordRoom(season, room).changed, false);
  assert.strictEqual(season.players[PID_A].games, 1);
});

test('normalizeSeason：历史冻结赛季逐帧规范化、按序号倒序去重，脏帧丢弃', () => {
  const raw = {
    version: 3, season: 3, startedAt: 9000, players: {}, recordedRooms: {},
    history: [
      { season: 2, startedAt: 5000, endedAt: 9000, players: {
        [PID_A]: { pid: PID_A, name: '甲', games: 4, wins: 3, ties: 0, totalScore: 40, bestChain: 3, lastAt: 8, rank: 2 } } },
      // 序号重复帧丢弃；空帧/非法帧丢弃
      { season: 2, startedAt: 1, players: { [PID_B]: { pid: PID_B, name: '乙', games: 1 } } },
      { season: 'x', players: {} },
      null,
      { season: 1, startedAt: 1000, endedAt: 5000, players: {
        [PID_A]: { pid: PID_A, name: '甲旧名', games: 2, wins: 0, ties: 1, totalScore: 12, bestChain: 2, lastAt: 4 } } },
    ],
  };
  const { season } = s.normalizeSeason(raw);
  assert.strictEqual(season.season, 3);
  assert.deepStrictEqual(season.history.map(h => h.season), [2, 1], '最新冻结赛季在前');
  assert.strictEqual(season.history[0].players[PID_A].rank, 2, '冻结名次保留');
  // 第 1 赛季帧缺 rank：不报错，读时可重算
  assert.strictEqual(season.history[1].players[PID_A].rank, null);
  const prof = s.getProfile(season, PID_A);
  assert.ok(prof, '当前赛季无记录但历史有记录：个人页仍可打开');
  assert.strictEqual(prof.games, 0, '当前赛季汇总为零');
  assert.deepStrictEqual(prof.seasons.map(x => x.season), [2, 1]);
  assert.strictEqual(prof.seasons[0].rank, 2, '冻结名次进入各赛季列表');
});

test('逐局索引：计入后可查询，重复计入/标记残留都不会重复累计', () => {
  const season = s.emptySeason();
  const room = playGame(['甲', '乙']);
  assert.strictEqual(s.isRoomRecorded(season, room), false);
  s.recordRoom(season, room);
  assert.strictEqual(s.isRoomRecorded(season, room), true);
  assert.strictEqual(season.players[PID_A].games, 1);

  // 模拟 bug 场景：重启后房间标记残留为 true，但赛季文件里没有这局
  // （另一间同结构、同结束时间的新房/或赛季写盘丢失）。索引才是凭据：
  // 清掉索引条目后即使 seasonRecorded 为 true，也要能补记，且只补一次。
  delete season.recordedRooms[g.roomKey(room)];
  assert.strictEqual(s.isRoomRecorded(season, room), false, '只认索引，不认房间标记');
  assert.strictEqual(room.seasonRecorded, true);
  const redo = s.recordRoom(season, room);
  assert.strictEqual(redo.changed, true);
  assert.strictEqual(redo.recorded, 2);
  assert.strictEqual(season.players[PID_A].games, 2);
  assert.strictEqual(s.recordRoom(season, room).changed, false, '再次计入被索引挡住');
  assert.strictEqual(season.players[PID_A].games, 2);
});

test('没有可计入 pid 的对局也登记索引：清理时不会误删后重算', () => {
  const season = s.emptySeason();
  const room = playGame(['甲', '乙']);
  room.players.forEach(p => { p.pid = null; });
  const r = s.recordRoom(season, room);
  assert.strictEqual(r.recorded, 0);
  assert.strictEqual(r.changed, true, '索引条目本身是赛季变化，需要落盘');
  assert.strictEqual(s.isRoomRecorded(season, room), true);
  assert.strictEqual(s.recordRoom(season, room).changed, false);
});

test('逐局去重键：新房用唯一 id；无 id 房间退回带前缀的房间码', () => {
  const room = playGame(['甲', '乙']);
  assert.match(g.roomKey(room), /^room_/);
  const old = g.newRoom('ABCD', 'p0', '甲');
  delete old.id;
  assert.strictEqual(g.roomKey(old), 'code:ABCD');
  const withId = { code: 'ABCD', id: 'room_x' };
  assert.strictEqual(g.roomKey(withId), 'room_x');
  // ensureRoomId 给旧档补 id，同一对象重复调用保持稳定
  delete old.id;
  g.ensureRoomId(old);
  const firstId = old.id;
  assert.match(firstId, /^room_/);
  g.ensureRoomId(old);
  assert.strictEqual(old.id, firstId);
});

// ---------- 赛季归档与切换 ----------

test('seasonDue：未到期/到期边界；seasonMs 非正数表示永不自动切换', () => {
  const season = s.emptySeason(1000);
  assert.strictEqual(s.seasonDue(season, 5000, 5999), false);
  assert.strictEqual(s.seasonDue(season, 5000, 6000), true);
  assert.strictEqual(s.seasonDue(season, 0, 99999999), false);
  assert.strictEqual(s.seasonDue(season, -1, 99999999), false);
});

test('rolloverSeason：冻结当前赛季快照（带总分榜名次），新赛季从零累计', () => {
  const season = s.emptySeason(0, 1);
  season.startedAt = 0;
  const r1 = playGame(['甲', '乙'], { tag: 'r1' }); s.recordRoom(season, r1, 1000);
  const r2 = playGame(['甲', '乙'], { tag: 'r2' }); s.recordRoom(season, r2, 2000);
  assert.strictEqual(season.players[PID_A].games, 2);

  const { rolledOver, frozen } = s.rolloverSeason(season, 5000, 5000);
  assert.strictEqual(rolledOver, true);
  assert.strictEqual(frozen.season, 1);
  assert.strictEqual(frozen.startedAt, 0);
  assert.strictEqual(frozen.endedAt, 5000);
  assert.strictEqual(season.season, 2, '新赛季序号 +1');
  assert.strictEqual(season.startedAt, 5000);
  assert.deepStrictEqual(season.players, {}, '新赛季从零累计');
  assert.strictEqual(season.history.length, 1);
  assert.strictEqual(season.history[0], frozen);

  // 冻结快照带总分榜名次（甲两局全胜应第 1）
  const ranks = Object.fromEntries(Object.values(frozen.players).map(p => [p.pid, p.rank]));
  assert.strictEqual(ranks[PID_A], 1);
  assert.strictEqual(ranks[PID_B], 2);
  assert.strictEqual(frozen.players[PID_A].games, 2, '快照保留老赛季汇总');

  // 未到期再调：幂等无变化
  assert.strictEqual(s.rolloverSeason(season, 5000, 6000).rolledOver, false);
  assert.strictEqual(season.season, 2);
  assert.strictEqual(season.history.length, 1);
});

test('rolloverSeason：空赛季不归档，只开下一号新赛季', () => {
  const season = s.emptySeason(0, 1);
  const { rolledOver, frozen } = s.rolloverSeason(season, 5000, 5000);
  assert.strictEqual(rolledOver, true);
  assert.strictEqual(frozen, null);
  assert.strictEqual(season.season, 2);
  assert.deepStrictEqual(season.history, []);
});

test('切换不重复计分：老局被全局索引挡住，新局计入新赛季；多赛季并存', () => {
  const season = s.emptySeason(0, 1);
  const oldRoom = playGame(['甲', '乙'], { tag: 'old' }); s.recordRoom(season, oldRoom, 1000);
  s.rolloverSeason(season, 5000, 5000);

  // 旧房间（重启后广播重入/清理补记路径）再 record：索引挡住，新赛季一场不多
  oldRoom.seasonRecorded = false; // 模拟房间标记丢失
  assert.strictEqual(s.recordRoom(season, oldRoom, 6000).changed, false);
  assert.deepStrictEqual(season.players, {});

  // 新房间计入第 2 赛季
  const newRoom = playGame(['甲', '乙'], { tag: 'new' });
  const r = s.recordRoom(season, newRoom, 7000);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(season.players[PID_A].games, 1, '新赛季只有新局');
  assert.strictEqual(season.history[0].players[PID_A].games, 1, '老赛季快照不受影响');
  assert.strictEqual(Object.keys(season.recordedRooms).length, 2, '全局索引跨赛季累计两局凭据');

  // 再切一次：第 2 赛季（1 场）冻结，进入第 3 赛季
  season.startedAt = 5000;
  s.rolloverSeason(season, 5000, 10000);
  assert.strictEqual(season.season, 3);
  assert.deepStrictEqual(season.history.map(h => h.season), [2, 1], '最新在前');
  assert.strictEqual(season.history[0].players[PID_A].games, 1);
  assert.strictEqual(season.history[1].players[PID_A].games, 1);
  assert.deepStrictEqual(season.players, {});
  // 三次启动路径都不会重算：两间房仍在全局索引中
  assert.strictEqual(s.recordRoom(season, oldRoom).changed, false);
  assert.strictEqual(s.recordRoom(season, newRoom).changed, false);
});

test('playerSeasons / getProfile：个人页展示各赛季名次与当前赛季汇总', () => {
  const season = s.emptySeason(0, 1);
  const r1 = playGame(['甲', '乙']); s.recordRoom(season, r1, 1000);
  s.rolloverSeason(season, 5000, 5000);
  const r2 = playGame(['甲', '乙']); s.recordRoom(season, r2, 6000);

  const prof = s.getProfile(season, PID_A);
  assert.strictEqual(prof.seasons.length, 2);
  const [cur, old] = prof.seasons;
  assert.strictEqual(cur.season, 2);
  assert.strictEqual(cur.current, true);
  assert.strictEqual(cur.endedAt, null);
  assert.strictEqual(cur.games, 1, '当前赛季汇总只算新赛季');
  assert.strictEqual(cur.rank, 1);
  assert.strictEqual(old.season, 1);
  assert.strictEqual(old.current, false);
  assert.strictEqual(old.games, 1);
  assert.strictEqual(old.rank, 1, '冻结名次');
  assert.strictEqual(old.endedAt, 5000);
  assert.strictEqual(prof.games, 1, '顶层为当前赛季汇总');

  // 乙第 2 赛季没打、只在第 1 赛季有记录：个人页仍可打开
  // （本 helper 两局两人都打了，改用只含甲的冻结帧构造）
  const season2 = s.emptySeason(0, 2);
  season2.history = [{
    season: 1, startedAt: 0, endedAt: 5000,
    players: { [PID_C]: { pid: PID_C, name: '丙', games: 3, wins: 1, ties: 0,
      totalScore: 20, bestChain: 2, lastAt: 4000, rank: 1 } },
  }];
  const profC = s.getProfile(season2, PID_C);
  assert.ok(profC, '只在历史赛季出现的玩家也有个人页');
  assert.strictEqual(profC.games, 0);
  assert.strictEqual(profC.rank, null);
  assert.strictEqual(profC.name, '丙');
  assert.strictEqual(profC.seasons.length, 1);
  assert.strictEqual(profC.seasons[0].season, 1);
  // 从没出现过的玩家仍返回 null
  assert.strictEqual(s.getProfile(season2, PID_B), null);
});

test('freezeSeason：空赛季不产生快照；快照含派生名次且不改动当前 players', () => {
  const empty = s.emptySeason();
  assert.strictEqual(s.freezeSeason(empty), null);

  const season = s.emptySeason(0, 7);
  s.recordRoom(season, playGame(['甲', '乙']), 1000);
  const playersBefore = JSON.stringify(season.players);
  const frozen = s.freezeSeason(season, 2000);
  assert.strictEqual(frozen.season, 7);
  assert.strictEqual(JSON.stringify(season.players), playersBefore, '冻结不破坏当前汇总');
  assert.strictEqual(frozen.players[PID_A].rank, 1);
});
