'use strict';
// 跨房间赛事纯逻辑单测：创建/报名/截止、抽签轮空、晋级传播、
// 平局重赛与种子破平、弃权、超时未到（单方/双方）、异常重赛（含决赛回滚）、名次与损坏档恢复。
const test = require('node:test');
const assert = require('node:assert');
const T = require('../tournament');

const pid = n => n.toString(16).padStart(64, '0');
const NAMES = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];

function makeStore(n, opts = {}) {
  const store = T.emptyStore();
  const id = 'tm_' + (opts.tag || 'a').repeat(12);
  const cr = T.createTournament(store, {
    id, hostPid: pid(1), hostName: '房主', name: opts.name || '测试杯',
    registerMs: opts.registerMs === undefined ? 0 : opts.registerMs,
    matchWaitMs: opts.matchWaitMs || 60000,
    now: opts.now || 1000,
    generate: () => id,
  });
  assert.strictEqual(cr.error, null);
  for (let i = 1; i <= n; i++) {
    const rr = T.register(store, id, { pid: pid(i), name: NAMES[i - 1] || `P${i}`, now: 1000 + i });
    assert.strictEqual(rr.error, null, `报名 ${i} 不应失败`);
  }
  const st = T.startBracket(store, id, { hostPid: pid(1), rng: opts.rng || Math.random, now: 2000 });
  assert.strictEqual(st.error, null);
  return { store, t: st.tournament, id };
}

// 由 eid 找其在某轮的场次
function matchOf(t, round, eid) {
  return t.matchOrder.map(mid => t.matches[mid])
    .find(m => m.round === round && (m.eidA === eid || m.eidB === eid) && m.status !== 'void');
}
// 绑定 store 的便捷上报
function play(store, t, mid, winnerEid, now) {
  const m = t.matches[mid];
  const winner = t.entrants.find(e => e.eid === winnerEid);
  return T.reportMatchResult(store, t.id, mid, {
    roomCode: m.roomCode, roomKey: `k-${mid}`,
    roomWinnerPid: winner ? winner.pid : null,
    scores: winner ? [{ pid: winner.pid, name: winner.name, total: 5 }] : [],
    now,
  });
}

test('创建校验：非法身份/空名称/重复 id 处理', () => {
  const store = T.emptyStore();
  assert.ok(T.createTournament(store, { hostPid: 'bad', name: 'X' }).error);
  assert.ok(T.createTournament(store, { hostPid: pid(1), name: '' }).error);
  let n = 0;
  const r = T.createTournament(store, { hostPid: pid(1), name: 'X', now: 1,
    generate: () => (n++ === 0 ? 'tm_' + '1'.repeat(12) : 'tm_' + '2'.repeat(12)) });
  assert.strictEqual(r.error, null);
  // 同一 generate 再次返回已占用 id 时仍能重试成功
  let n2 = 0;
  const r2 = T.createTournament(store, { hostPid: pid(2), name: 'Y', now: 2,
    generate: () => (n2++ === 0 ? 'tm_' + '1'.repeat(12) : 'tm_' + '3'.repeat(12)) });
  assert.strictEqual(r2.error, null);
  assert.strictEqual(r2.tournament.id, 'tm_' + '3'.repeat(12));
});

test('报名：同 pid 唯一、非法身份拒绝、截止后拒绝、退出', () => {
  const store = T.emptyStore();
  const id = 'tm_' + 'b'.repeat(12);
  T.createTournament(store, { hostPid: pid(1), name: 'X', registerMs: 60000, now: 0, generate: () => id });
  assert.strictEqual(T.register(store, id, { pid: 'bad', name: 'A', now: 1 }).error, '需要有效的本机身份才能报名');
  assert.strictEqual(T.register(store, id, { pid: pid(1), name: 'A', now: 1 }).error, null);
  assert.ok(T.register(store, id, { pid: pid(1), name: 'A2', now: 2 }).error);
  assert.strictEqual(T.register(store, id, { pid: pid(2), name: 'B', now: 3 }).error, null);
  assert.strictEqual(T.withdraw(store, id, pid(2), 4).error, null);
  assert.strictEqual(T.register(store, id, { pid: pid(2), name: 'B', now: 5 }).error, null);
  assert.ok(T.withdraw(store, id, pid(9), 6).error); // 没报名
  // 截止
  T.sweep(store, 60001); // 2 人 -> 自动开赛
  assert.strictEqual(store.tournaments[id].phase, 'running');
  assert.ok(T.register(store, id, { pid: pid(3), name: 'C', now: 60002 }).error);
  assert.ok(T.withdraw(store, id, pid(1), 60002).error);
});

test('开赛：非房主不能提前开赛；不足 2 人到点取消', () => {
  const store = T.emptyStore();
  const id = 'tm_' + 'c'.repeat(12);
  T.createTournament(store, { hostPid: pid(1), name: 'X', registerMs: 0, now: 1, generate: () => id });
  T.register(store, id, { pid: pid(1), name: 'A' });
  assert.ok(T.startBracket(store, id, { hostPid: pid(2) }).error); // 非房主
  assert.ok(T.startBracket(store, id, { hostPid: pid(1) }).error);  // 只有 1 人
  const store2 = T.emptyStore();
  const id2 = 'tm_' + 'd'.repeat(12);
  T.createTournament(store2, { hostPid: pid(1), name: 'Y', registerMs: 60000, now: 0, generate: () => id2 });
  T.register(store2, id2, { pid: pid(1), name: 'A', now: 1 });
  const sw = T.sweep(store2, 60001);
  assert.deepStrictEqual(sw.cancelled, [id2]);
  assert.strictEqual(store2.tournaments[id2].phase, 'cancelled');
});

test('抽签轮空：6 人补成 8 签、2 个轮空且无"双轮空"幽灵场次，轮空者晋级第二轮', () => {
  const { t } = makeStore(6, { tag: 'e' });
  assert.strictEqual(t.size, 8);
  assert.strictEqual(t.rounds, 3);
  const r1 = t.matchOrder.map(m => t.matches[m]).filter(m => m.round === 1);
  const byes = r1.filter(m => m.status === 'bye');
  assert.strictEqual(byes.length, 2);
  // 每场至少一个真人
  for (const m of r1) assert.ok(m.eidA || m.eidB);
  assert.ok(!r1.some(m => !m.eidA && !m.eidB));
  // 轮空者已在第二轮进料
  for (const m of byes) {
    const parent = t.matches[m.parentMid];
    assert.ok(parent.eidA === m.winnerEid || parent.eidB === m.winnerEid);
  }
});

test('2 人赛事：一场决赛，打完即完赛出冠军', () => {
  const { store, t, id } = makeStore(2, { tag: 'f' });
  assert.strictEqual(t.size, 2);
  assert.strictEqual(t.rounds, 1);
  const final = t.matchOrder[0];
  assert.strictEqual(t.matches[final].status, 'ready');
  const r = play(store, t, final, 'e2', 3000);
  assert.strictEqual(r.error, null);
  assert.strictEqual(t.phase, 'finished');
  assert.strictEqual(t.championEid, 'e2');
  assert.deepStrictEqual(t.finalStandings.map(s => s.eid), ['e2', 'e1']);
});

test('正常晋级链：胜者一路进入后续轮次，负者 eliminated', () => {
  const { store, t } = makeStore(4, { tag: '1', rng: () => 0.5 });
  // r1-0, r1-1 都 ready；让 e1/e3 出线
  play(store, t, 'r1-0', 'e1', 3000);
  play(store, t, 'r1-1', 'e3', 3100);
  const finalMatch = t.matches['r2-0'];
  assert.strictEqual(finalMatch.status, 'ready');
  assert.ok(finalMatch.eidA && finalMatch.eidB);
  play(store, t, 'r2-0', 'e3', 4000);
  assert.strictEqual(t.phase, 'finished');
  assert.strictEqual(t.championEid, 'e3');
  assert.strictEqual(t.entrants.find(e => e.eid === 'e1').status, 'eliminated');
  assert.strictEqual(t.entrants.find(e => e.eid === 'e3').status, 'champion');
  // 首轮负者并列第 3
  const r1Losers = t.finalStandings.filter(s => s.rank === 3).map(s => s.eid).sort();
  assert.deepStrictEqual(r1Losers, ['e2', 'e4']);
});

test('checkIn：非参赛方拒绝；两人到场转 live，deadline 取消', () => {
  const { t } = makeStore(2, { tag: '2' });
  const m = t.matchOrder[0];
  assert.ok(T.checkIn(t, m, pid(9)).error);
  assert.strictEqual(T.checkIn(t, m, pid(1)).live, false);
  assert.strictEqual(t.matches[m].status, 'ready');
  const r2 = T.checkIn(t, m, pid(2));
  assert.strictEqual(r2.live, true);
  assert.strictEqual(t.matches[m].status, 'live');
  assert.strictEqual(t.matches[m].deadline, null);
  // 重复进入幂等
  assert.strictEqual(T.checkIn(t, m, pid(1)).status, 'live');
});

test('弃权：ready 中认输，对手晋级、认输者 forfeit；live 后不能弃权', () => {
  const { store, t } = makeStore(4, { tag: '3', rng: () => 0.5 });
  const r = T.forfeit(store, t.id, pid(1), 3000);
  assert.strictEqual(r.error, null);
  const m = r.match;
  assert.strictEqual(m.result.type, 'forfeit');
  assert.strictEqual(t.entrants.find(e => e.eid === 'e1').status, 'forfeit');
  const opponent = m.eidA === 'e1' ? m.eidB : m.eidA;
  assert.strictEqual(m.winnerEid, opponent);
  // 另一场正常打完后进决赛；此时胜者在决赛 ready，可对决赛弃权
  const otherReady = t.matchOrder.map(x => t.matches[x]).find(x => x.status === 'ready' && x.round === 1);
  play(store, t, otherReady.id, otherReady.eidA, 3200);
  const final = t.matchOrder.map(x => t.matches[x]).find(x => x.round === 2);
  assert.strictEqual(final.status, 'ready');
  // 把一场打到 live：两个选手 check in 后不能弃权
  const { store: s2, t: t2 } = makeStore(2, { tag: '4' });
  const f2 = t2.matchOrder[0];
  T.checkIn(t2, f2, pid(1)); T.checkIn(t2, f2, pid(2));
  assert.strictEqual(t2.matches[f2].status, 'live');
  assert.ok(T.forfeit(s2, t2.id, pid(1), 3000).error);
});

test('超时未到：只来一人 -> 到场者 walkover；两人都没来 -> 种子靠前者 noshow 兜底', () => {
  const { store, t } = makeStore(4, { tag: '5', matchWaitMs: 60000, rng: () => 0.5 });
  const [m0, m1] = t.matchOrder.map(x => t.matches[x]).filter(x => x.round === 1);
  T.checkIn(t, m0.id, t.entrants.find(e => e.eid === m0.eidA).pid); // m0 只来 A 侧
  // 两场同一 now 进入 ready、deadline 相同：一次 sweep 同时处理
  const sw = T.sweep(store, m0.deadline + 1);
  assert.strictEqual(t.matches[m0.id].result.type, 'walkover');
  assert.strictEqual(t.matches[m0.id].winnerEid, m0.eidA);
  // m1 两人都没到 -> noshow，种子靠前者晋级
  assert.strictEqual(t.matches[m1.id].result.type, 'noshow');
  const seeds = [m1.eidA, m1.eidB].map(eid => t.entrants.find(e => e.eid === eid))
    .sort((a, b) => a.seed - b.seed);
  assert.strictEqual(t.matches[m1.id].winnerEid, seeds[0].eid);
  assert.strictEqual(sw.walkovers.length, 2);
});

test('平局：自动重赛（旧局 void 但保留 tie 结果）；第 3 场仍平按种子破平', () => {
  const { store, t } = makeStore(2, { tag: '6', rng: () => 0.1 });
  const first = t.matchOrder[0];
  const r1 = play(store, t, first, null, 3000); // 平局
  assert.strictEqual(r1.resolved, 'tie');
  assert.ok(r1.rematch);
  assert.strictEqual(t.matches[first].status, 'void');
  assert.strictEqual(t.matches[first].result.type, 'tie');
  const rep1 = r1.rematch.id;
  assert.strictEqual(t.matches[rep1].rematchOf, first);
  assert.strictEqual(t.matches[rep1].status, 'ready');
  const r2 = play(store, t, rep1, null, 3100);
  assert.strictEqual(r2.resolved, 'tie');
  const rep2 = r2.rematch.id;
  // 第三次仍平 -> tiebreak，种子靠前者夺冠
  const r3 = play(store, t, rep2, null, 3200);
  assert.strictEqual(r3.resolved, 'tiebreak');
  assert.strictEqual(t.phase, 'finished');
  const champSeed = Math.min(...t.entrants.map(e => e.seed));
  assert.strictEqual(t.entrants.find(e => e.eid === t.championEid).seed, champSeed);
  assert.strictEqual(t.matches[rep2].result.type, 'tiebreak');
});

test('异常重赛：仅房主；下一轮公示后拒绝；普通场重赛重新等待入场并接回对阵树', () => {
  const { store, t } = makeStore(4, { tag: '7', rng: () => 0.5 });
  const [m0, m1] = t.matchOrder.map(x => t.matches[x]).filter(x => x.round === 1);
  play(store, t, m0.id, m0.eidA, 3000);
  // 另一场半决赛还没打：决赛（父）仍 pending，此时允许对 m0 重赛
  const finalBefore = t.matches['r2-0'];
  assert.strictEqual(finalBefore.status, 'pending');
  const m0Loser = m0.eidB;
  const m0Winner = m0.eidA;
  // 非房主不能重赛
  assert.ok(T.hostRematch(store, t.id, m0.id, pid(2), 3300).error);
  const r = T.hostRematch(store, t.id, m0.id, pid(1), 3400);
  assert.strictEqual(r.error, null);
  assert.strictEqual(t.matches[m0.id].status, 'void');
  assert.strictEqual(r.match.id, 'r1-0#rep1');
  assert.strictEqual(finalBefore.status, 'pending');
  // 旧负者恢复 alive
  assert.strictEqual(t.entrants.find(e => e.eid === m0Loser).status, 'alive');
  // 重赛场等入场；这次 B 侧赢
  assert.strictEqual(t.matches[r.match.id].status, 'ready');
  play(store, t, r.match.id, m0Loser, 3600);
  // 另一场半决赛打完 -> 决赛公示（ready）
  play(store, t, m1.id, m1.eidA, 3700);
  const final = t.matches['r2-0'];
  assert.strictEqual(final.status, 'ready');
  assert.ok(final.eidA === m0Loser || final.eidB === m0Loser);
  // 决赛已公示（选手可进入），旧场不能再重赛
  assert.ok(T.hostRematch(store, t.id, r.match.id, pid(1), 3800).error);
  void m0Winner;
  // 打完决赛 -> 完赛
  const other = final.eidA === m0Loser ? final.eidB : final.eidA;
  play(store, t, 'r2-0', other, 4000);
  assert.strictEqual(t.phase, 'finished');
});

test('异常重赛被拒：下一轮已经开赛（live）后不能再改', () => {
  const { store, t } = makeStore(4, { tag: '7', rng: () => 0.5 });
  const [m0, m1] = t.matchOrder.map(x => t.matches[x]).filter(x => x.round === 1);
  play(store, t, m0.id, m0.eidA, 3000);
  play(store, t, m1.id, m1.eidA, 3100);
  const final = t.matches['r2-0'];
  assert.strictEqual(final.status, 'ready');
  // 决赛两名选手都进入房间 -> live，此后旧场不能重赛
  T.checkIn(t, final.id, t.entrants.find(e => e.eid === final.eidA).pid);
  assert.strictEqual(final.status, 'ready'); // 一人到场仍 ready
  assert.ok(T.hostRematch(store, t.id, m0.id, pid(1), 3300).error, '决赛公示后即拒绝');
  T.checkIn(t, final.id, t.entrants.find(e => e.eid === final.eidB).pid);
  assert.strictEqual(final.status, 'live');
  assert.ok(T.hostRematch(store, t.id, m0.id, pid(1), 3400).error);
});

test('决赛异常重赛：回滚冠军/名次/完赛，重赛新冠军生效', () => {
  const { store, t } = makeStore(2, { tag: '8' });
  const final = t.matchOrder[0];
  play(store, t, final, 'e1', 3000);
  assert.strictEqual(t.phase, 'finished');
  assert.strictEqual(t.championEid, 'e1');
  const r = T.hostRematch(store, t.id, final, pid(1), 3200);
  assert.strictEqual(r.error, null);
  assert.strictEqual(t.phase, 'running');
  assert.strictEqual(t.championEid, null);
  assert.strictEqual(t.finalStandings.length, 0);
  assert.strictEqual(t.entrants.find(e => e.eid === 'e1').status, 'alive');
  assert.strictEqual(t.entrants.find(e => e.eid === 'e2').status, 'alive');
  play(store, t, r.match.id, 'e2', 3500);
  assert.strictEqual(t.phase, 'finished');
  assert.strictEqual(t.championEid, 'e2');
});

test('异常重赛次数上限：同一条场次链最多 3 次', () => {
  const { store, t } = makeStore(2, { tag: '9' });
  let cur = t.matchOrder[0];
  play(store, t, cur, 'e1', 3000);
  for (let i = 1; i <= 3; i++) {
    const r = T.hostRematch(store, t.id, cur, pid(1), 3100 + i);
    assert.strictEqual(r.error, null, `第 ${i} 次重赛应成功`);
    cur = r.match.id;
    play(store, t, cur, 'e1', 3200 + i);
  }
  // 第 4 次被拒
  const over = T.hostRematch(store, t.id, cur, pid(1), 4000);
  assert.ok(over.error);
});

test('上报校验：非对阵房间/非选手胜者/重复上报拒绝', () => {
  const { store, t } = makeStore(2, { tag: 'a' });
  const m = t.matchOrder[0];
  T.assignRoom(t, m, 'ROOM1');
  assert.ok(T.reportMatchResult(store, t.id, m, { roomCode: 'WRONG', roomWinnerPid: pid(1), now: 1 }).error);
  assert.ok(T.reportMatchResult(store, t.id, m, { roomCode: 'ROOM1', roomWinnerPid: pid(9), now: 1 }).error);
  assert.strictEqual(play(store, t, m, 'e1', 3000).error, null);
  // 已完赛场次不能再上报
  assert.ok(T.reportMatchResult(store, t.id, m, { roomWinnerPid: pid(2), now: 3001 }).error);
});

test('currentMatchFor / 视图 / 摘要', () => {
  const { t } = makeStore(4, { tag: 'b', rng: () => 0.5 });
  const cm = T.currentMatchFor(t, pid(1));
  assert.ok(cm && cm.round === 1);
  assert.strictEqual(T.currentMatchFor(t, pid(9)), null);
  const v = T.tournamentView(t, pid(1));
  assert.strictEqual(v.myEid, 'e1');
  assert.strictEqual(v.bracket.length, 2);
  assert.ok(v.entrants.length === 4);
  const store = T.emptyStore();
  const list = T.summaries(store, pid(1));
  assert.deepStrictEqual(list, []);
});

test('存档恢复：损坏赛事/脏选手/脏场次被丢弃，合法赛事 round-trip', () => {
  const { store, t, id } = makeStore(3, { tag: 'c' });
  const json = JSON.parse(JSON.stringify(store));
  // 注入坏赛事（无 hostPid）、坏选手（非法 pid）、坏场次（id 非法）
  json.tournaments['tm_' + 'f'.repeat(12)] = { id: 'tm_' + 'f'.repeat(12), name: '坏' };
  json.tournaments[id].entrants.push({ eid: 'bad', pid: 'xx', name: '脏' });
  json.tournaments[id].matches['nope'] = { id: 'nope' };
  json.tournaments[id].matchOrder.push('nope');
  const norm = T.normalizeStore(json);
  assert.ok(!norm.tournaments['tm_' + 'f'.repeat(12)]);
  assert.strictEqual(norm.tournaments[id].entrants.length, 3);
  assert.ok(!norm.tournaments[id].matches.nope);
  // 空/异常输入
  assert.deepStrictEqual(T.normalizeStore(null).tournaments, {});
  assert.strictEqual(T.normalizeTournament(null), null);
});

test('规则清洗：白名单字段与越界裁剪', () => {
  const r = T.normalizeRules({ turnSeconds: 99999, rounds: 0, evil: 'x',
    allowedRelations: ['synonym', 'nope'] });
  assert.strictEqual(r.turnSeconds, 300);
  assert.strictEqual(r.rounds, 1);
  assert.strictEqual(r.evil, undefined);
  assert.deepStrictEqual(r.allowedRelations, ['synonym']);
  // 关系全非法时回退 null（客户端按全部类型处理）
  assert.strictEqual(T.normalizeRules({ allowedRelations: ['x'] }).allowedRelations, null);
});

test('完赛保留期清理：未完赛不动，完赛/取消超期清除', () => {
  const { store, t } = makeStore(2, { tag: 'd' });
  play(store, t, t.matchOrder[0], 'e1', 3000);
  assert.strictEqual(t.phase, 'finished');
  assert.deepStrictEqual(T.pruneFinished(store, 99999, 3001), []);
  assert.deepStrictEqual(T.pruneFinished(store, 100, 3200), [t.id]);
});
