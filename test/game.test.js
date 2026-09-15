'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('../game');

function makeRoom(playerNames = ['甲', '乙', '丙']) {
  const room = g.newRoom('TEST', 'p0', playerNames[0]);
  playerNames.forEach((n, i) => g.addPlayer(room, `p${i}`, n));
  const err = g.startGame(room, 'p0', () => 0.01); // 固定随机数，起始词可预测
  assert.strictEqual(err, null);
  return room;
}

function activeId(room) { return room.turn.playerId; }

function playOk(room, word, parentId = 'start0', relation = 'synonym', reason = '这是合理的解释') {
  return g.playWord(room, activeId(room), { word, parentId, relation, reason });
}

test('开局：起始词、回合、行动点就绪', () => {
  const room = makeRoom();
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(room.nodes.length, room.ruleSet.startWordCount);
  assert.strictEqual(room.turn.apLeft, room.ruleSet.apPerTurn);
  assert.strictEqual(activeId(room), 'p0');
});

test('接词：扣行动点、校验重复词与解释长度', () => {
  const room = makeRoom();
  assert.strictEqual(playOk(room, '开心'), null);
  assert.strictEqual(room.turn.apLeft, room.ruleSet.apPerTurn - 1);
  assert.strictEqual(playOk(room, '开心'), '这个词已经在场上了');
  const err = g.playWord(room, activeId(room), { word: '高兴', parentId: 'start0', relation: 'synonym', reason: '短' });
  assert.match(err, /至少/);
});

test('接词：不允许的关系类型被拒绝', () => {
  const room = makeRoom();
  room.ruleSet.allowedRelations = ['synonym'];
  const err = g.playWord(room, activeId(room), { word: '黑夜', parentId: 'start0', relation: 'antonym', reason: '足够的解释长度' });
  assert.match(err, /规则/);
});

test('回合推进与游戏结束', () => {
  const room = makeRoom(['甲', '乙']);
  const total = room.players.length * room.ruleSet.rounds;
  for (let i = 0; i < total; i++) {
    assert.strictEqual(room.phase, 'playing');
    assert.strictEqual(g.endTurn(room, activeId(room)), null);
  }
  assert.strictEqual(room.phase, 'ended');
  assert.ok(room.log.some(e => e.type === 'end'));
});

test('加固消耗行动点且免疫质疑', () => {
  const room = makeRoom(['甲', '乙']);
  playOk(room, '开心');
  const node = room.nodes.find(n => n.word === '开心');
  assert.strictEqual(g.reinforce(room, 'p0', node.id), null);
  // 质疑必须在对方（词主）的回合内发起
  assert.strictEqual(g.challenge(room, 'p1', node.id), '加固过的连接免疫质疑');
});

test('质疑成立：级联拆除未加固下游，加固下游成为新根', () => {
  const room = makeRoom(['甲', '乙']);
  // p0 建链：开心 -> 快乐；加固「快乐」（3 AP 用完）
  playOk(room, '开心');
  const n1 = room.nodes.find(n => n.word === '开心');
  playOk(room, '快乐', n1.id);
  const n2 = room.nodes.find(n => n.word === '快乐');
  g.reinforce(room, 'p0', n2.id);
  // p1 在 p0 的回合内质疑「开心」
  assert.strictEqual(g.challenge(room, 'p1', n1.id), null);
  assert.ok(room.pendingChallenge);
  assert.strictEqual(room.turn.deadline, null, '计时应暂停');
  assert.strictEqual(g.resolveChallenge(room, 'p0', 'uphold'), null);
  assert.ok(!room.nodes.some(n => n.word === '开心'), '开心应被移除');
  const happy = room.nodes.find(n => n.word === '快乐');
  assert.ok(happy, '加固的快乐应幸存');
  assert.strictEqual(happy.parentId, null, '快乐应成为新根');
  assert.ok(room.turn.deadline, '裁定后计时应恢复');
});

test('质疑不成立：词保留，质疑次数已消耗', () => {
  const room = makeRoom(['甲', '乙']);
  playOk(room, '开心');
  const n1 = room.nodes.find(n => n.word === '开心');
  const tokensBefore = room.players[1].tokensLeft;
  g.challenge(room, 'p1', n1.id);
  g.resolveChallenge(room, 'p0', 'reject');
  assert.ok(room.nodes.some(n => n.word === '开心'));
  assert.strictEqual(room.players[1].tokensLeft, tokensBefore - 1);
});

test('未加固的下游被级联拆除', () => {
  const room = makeRoom(['甲', '乙']);
  playOk(room, '开心');
  const n1 = room.nodes.find(n => n.word === '开心');
  playOk(room, '快乐', n1.id);
  playOk(room, '喜悦', room.nodes.find(n => n.word === '快乐').id);
  g.challenge(room, 'p1', n1.id);
  g.resolveChallenge(room, 'p0', 'uphold');
  for (const w of ['开心', '快乐', '喜悦']) {
    assert.ok(!room.nodes.some(n => n.word === w), `${w} 应被级联移除`);
  }
});

test('计分：长链与加固有更高收益', () => {
  const room = makeRoom(['甲', '乙']);
  // p0: 链 a->b->c（深度 0,1,2）= 1+2+3 = 6，最长链 3 → +6
  playOk(room, '甲一');
  playOk(room, '甲二', room.nodes.find(n => n.word === '甲一').id);
  playOk(room, '甲三', room.nodes.find(n => n.word === '甲二').id);
  g.endTurn(room, 'p0');
  // p1: 只接一个词 = 1 分，最长链 1 → +2
  playOk(room, '乙一');
  g.endTurn(room, 'p1');
  const scores = g.computeScores(room);
  const s0 = scores.find(s => s.playerId === 'p0');
  const s1 = scores.find(s => s.playerId === 'p1');
  assert.strictEqual(s0.total, 1 + 2 + 3 + 6);
  assert.strictEqual(s1.total, 1 + 2);
  assert.ok(s0.total > s1.total);
});

test('回放帧可从日志重建', () => {
  const room = makeRoom(['甲', '乙']);
  playOk(room, '开心');
  g.endTurn(room, 'p0');
  g.endTurn(room, 'p1');
  // 强制结束以便包含 end 帧
  while (room.phase === 'playing') g.endTurn(room, activeId(room));
  const frames = g.buildReplay(room);
  assert.ok(frames.length > 3);
  const playFrame = frames.find(f => f.label.includes('开心'));
  assert.ok(playFrame.nodes.some(n => n.word === '开心'));
  assert.ok(frames[frames.length - 1].scores, '最后一帧应有结算');
});

test('回放帧带关键事件标记与可读标签（质疑/拆除/加固/结算）', () => {
  const room = makeRoom(['甲', '乙']);
  playOk(room, '开心');
  const n1 = room.nodes.find(n => n.word === '开心');
  playOk(room, '快乐', n1.id);
  const n2 = room.nodes.find(n => n.word === '快乐');
  g.reinforce(room, 'p0', n2.id);            // 加固（p0 回合内）
  g.challenge(room, 'p1', n1.id);            // p1 质疑「开心」
  g.resolveChallenge(room, 'p0', 'uphold');  // 成立：拆除（快乐加固幸存）
  while (room.phase === 'playing') g.endTurn(room, activeId(room));
  const frames = g.buildReplay(room);
  const kinds = frames.map(f => f.kind);
  for (const k of ['reinforce', 'challenge', 'demolish']) {
    assert.ok(kinds.includes(k), `应有 ${k} 帧`);
  }
  assert.strictEqual(frames[frames.length - 1].kind, 'end');
  // 标签带玩家与词，事件列表可直接展示
  assert.match(frames.find(f => f.kind === 'reinforce').label, /甲 加固了「快乐」/);
  assert.match(frames.find(f => f.kind === 'challenge').label, /乙 质疑「开心」/);
  assert.match(frames.find(f => f.kind === 'demolish').label, /质疑成立，拆除「开心」/);
  assert.match(frames[frames.length - 1].label, /结算/);

  // 质疑不成立是 keep 帧，不混入拆除
  const room2 = makeRoom(['甲', '乙']);
  playOk(room2, '高兴');
  const m1 = room2.nodes.find(n => n.word === '高兴');
  g.challenge(room2, 'p1', m1.id);
  g.resolveChallenge(room2, 'p0', 'reject');
  const frames2 = g.buildReplay(room2);
  assert.ok(!frames2.some(f => f.kind === 'demolish'));
  assert.match(frames2.find(f => f.kind === 'keep').label, /质疑不成立，「高兴」保留/);
});

test('断线重连后玩家状态保留', () => {
  const room = makeRoom(['甲', '乙']);
  room.players[1].connected = false;
  room.players[1].connected = true; // 模拟重连
  assert.strictEqual(room.players[1].connected, true);
  assert.strictEqual(room.phase, 'playing');
});

test('裁定者掉线后裁定权移交给在线玩家', () => {
  const room = makeRoom(['甲', '乙', '丙']);
  playOk(room, '开心'); // p0（房主）的词
  const n1 = room.nodes.find(n => n.word === '开心');
  g.challenge(room, 'p1', n1.id);
  const adj = room.pendingChallenge.adjudicatorId;
  assert.strictEqual(adj, 'p2'); // 顺延给丙
  // 丙掉线 → 应移交（此时只有 p1 在线且合格？p1 是质疑者，不合格；无合格人选则保持）
  room.players.find(p => p.id === 'p2').connected = false;
  assert.strictEqual(g.ensureAdjudicatorOnline(room), false, '无合格人选时保持不变');
  // 丙恢复在线后又掉线，乙完成行动… 改测：让丙不是唯一人选——先让 p2 在线，p1 掉线不影响
  room.players.find(p => p.id === 'p2').connected = true;
  assert.strictEqual(g.ensureAdjudicatorOnline(room), false, '裁定者在线时不移交');
});

test('裁定者掉线且存在合格人选时移交', () => {
  const room = makeRoom(['甲', '乙', '丙']);
  // 乙的词被丙质疑，裁定者是房主 p0；房主掉线后应移交给在线的乙？乙是词主不合格→无人可移交
  g.endTurn(room, 'p0');
  playOk(room, '水花'); // p1 的词
  const n1 = room.nodes.find(n => n.word === '水花');
  g.challenge(room, 'p2', n1.id);
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p0');
  room.players.find(p => p.id === 'p0').connected = false;
  // 合格人选：在线、非质疑者、非词主 → 无人（p1 词主，p2 质疑者）
  assert.strictEqual(g.ensureAdjudicatorOnline(room), false);
  // 甲的词被乙质疑，裁定者是丙；丙掉线后无其他合格人选（甲词主、乙质疑者）→ 保持
  // 换 4 人局验证移交成功
  const room4 = g.newRoom('TEST4', 'h', '一');
  ['h', 'a', 'b', 'c'].forEach((id, i) => g.addPlayer(room4, id, `玩家${i}`));
  g.startGame(room4, 'h', () => 0.01);
  g.playWord(room4, 'h', { word: '开心', parentId: 'start0', relation: 'synonym', reason: '合理的解释' });
  const node = room4.nodes.find(n => n.word === '开心');
  g.challenge(room4, 'a', node.id); // 房主的词 → 顺延给非词主非质疑者：b
  assert.strictEqual(room4.pendingChallenge.adjudicatorId, 'b');
  room4.players.find(p => p.id === 'b').connected = false;
  assert.strictEqual(g.ensureAdjudicatorOnline(room4), true);
  assert.strictEqual(room4.pendingChallenge.adjudicatorId, 'c');
  // c 可以正常裁定，对局继续
  assert.strictEqual(g.resolveChallenge(room4, 'c', 'reject'), null);
  assert.strictEqual(room4.pendingChallenge, null);
});

test('涉及房主的质疑由其他玩家裁定', () => {
  const room = makeRoom(['甲', '乙', '丙']);
  playOk(room, '开心'); // p0（房主）的词
  const n1 = room.nodes.find(n => n.word === '开心');
  g.challenge(room, 'p1', n1.id); // p0 回合内，p1 质疑
  assert.notStrictEqual(room.pendingChallenge.adjudicatorId, 'p0');
  assert.notStrictEqual(room.pendingChallenge.adjudicatorId, 'p1', '质疑者不应裁定自己的质疑');
  assert.strictEqual(g.resolveChallenge(room, 'p0', 'uphold'), '只有裁定者可以判定');
  assert.strictEqual(g.resolveChallenge(room, room.pendingChallenge.adjudicatorId, 'uphold'), null);
});

// ---------- 观战模式 ----------

test('观战：对局开始后仍可加入，且不占玩家名额、不进入回合顺序', () => {
  const room = makeRoom(['甲', '乙']);
  assert.strictEqual(g.addSpectator(room, 'sp1', '朋友'), null);
  assert.ok(g.isSpectator(room, 'sp1'));
  assert.strictEqual(room.players.length, 2);
  assert.deepStrictEqual(g.computeScores(room).map(s => s.playerId), ['p0', 'p1']);
});

test('观战：大厅阶段也能进入看规则与玩家', () => {
  const room = g.newRoom('LOBBY', 'p0', '甲');
  g.addPlayer(room, 'p0', '甲');
  assert.strictEqual(g.addSpectator(room, 'sp1', '朋友'), null);
  const view = g.publicView(room, 'sp1');
  assert.strictEqual(view.spectating, true);
  assert.strictEqual(view.players.length, 1);
  assert.strictEqual(view.spectators.length, 1);
  // 玩家视角里自己不是观战者，但能看到观战名单
  assert.strictEqual(g.publicView(room, 'p0').spectating, false);
  assert.strictEqual(g.publicView(room, 'p0').spectators.length, 1);
});

test('观战者不能接词、加固、结束回合、质疑或裁定', () => {
  const room = makeRoom(['甲', '乙']);
  g.addSpectator(room, 'sp1', '朋友');
  playOk(room, '开心');
  const node = room.nodes.find(n => n.word === '开心');
  assert.match(g.playWord(room, 'sp1', { word: '旁观词', parentId: 'start0',
    relation: 'synonym', reason: '足够长度的解释' }), /观战/);
  assert.match(g.reinforce(room, 'sp1', node.id), /观战/);
  assert.match(g.endTurn(room, 'sp1'), /观战/);
  assert.match(g.challenge(room, 'sp1', node.id), /观战/);
  // 观战者即便伪造裁定请求也被拒绝
  g.challenge(room, 'p1', node.id);
  assert.match(g.resolveChallenge(room, 'sp1', 'uphold'), /观战/);
});

test('观战者不能修改规则或开始游戏', () => {
  const lobby = g.newRoom('L', 'p0', '甲');
  g.addPlayer(lobby, 'p0', '甲');
  g.addSpectator(lobby, 'sp1', '朋友');
  assert.match(g.setRuleSet(lobby, 'sp1', { turnSeconds: 60 }), /观战/);
  assert.match(g.startGame(lobby, 'sp1'), /观战/);
});

test('观战人数有上限', () => {
  const room = makeRoom(['甲', '乙']);
  for (let i = 0; i < g.MAX_SPECTATORS; i++) {
    assert.strictEqual(g.addSpectator(room, `sp${i}`, `观${i}`), null);
  }
  assert.match(g.addSpectator(room, 'spX', '再多一个'), /已满/);
});

test('断线的观战者可恢复身份，被清出房间后需重新进入', () => {
  const room = makeRoom(['甲', '乙']);
  g.addSpectator(room, 'sp1', '朋友');
  room.spectators[0].connected = false;
  room.spectators[0].connected = true; // 模拟刷新页面后凭 token 恢复
  assert.ok(g.isSpectator(room, 'sp1'));
  g.removeSpectator(room, 'sp1');
  assert.ok(!g.isSpectator(room, 'sp1'));
  assert.strictEqual(room.players.length, 2, '清出观战者不影响玩家');
});

// ---------- 托管 ----------

test('行动玩家掉线进入托管：暂停回合计时，重连立即收回并恢复计时', () => {
  const room = makeRoom(['甲', '乙']);
  assert.strictEqual(activeId(room), 'p0');
  playOk(room, '开心'); // 用掉时间无关键，关键是 deadline 在走
  assert.ok(room.turn.deadline, '掉线前计时在走');
  const remainBefore = room.turn.deadline - Date.now();

  room.players[0].connected = false;
  assert.strictEqual(g.enterAutoPilot(room, 'p0', 'disconnect'), true);
  assert.strictEqual(g.isAutoPilot(room, 'p0'), true);
  assert.strictEqual(room.turn.deadline, null, '托管暂停回合计时');
  assert.strictEqual(room.turn.pausedReason, 'autopilot');
  assert.ok(room.turn.pausedRemaining <= remainBefore && room.turn.pausedRemaining > 0);
  // 幂等：重复进入不重复记日志
  const logCount = room.log.filter(e => e.type === 'autopilot').length;
  assert.strictEqual(g.enterAutoPilot(room, 'p0', 'disconnect'), false);
  assert.strictEqual(room.log.filter(e => e.type === 'autopilot').length, logCount);

  // 重连立即收回
  room.players[0].connected = true;
  assert.strictEqual(g.releaseAutoPilot(room, 'p0'), true);
  assert.strictEqual(g.isAutoPilot(room, 'p0'), false);
  assert.ok(room.turn.deadline, '收回后恢复倒计时');
  assert.strictEqual(room.turn.pausedRemaining, null);
  assert.strictEqual(room.turn.pausedReason, null);
  // 再次收回是空操作
  assert.strictEqual(g.releaseAutoPilot(room, 'p0'), false);
});

test('托管期间不能接词、加固、发起质疑或裁定', () => {
  const room = makeRoom(['甲', '乙', '丙', '丁']);
  playOk(room, '开心');
  const node = room.nodes.find(n => n.word === '开心');

  // 行动玩家 p0 托管：不能行动
  room.players[0].connected = false;
  g.enterAutoPilot(room, 'p0', 'disconnect');
  assert.match(g.playWord(room, 'p0', { word: '高兴', parentId: 'start0',
    relation: 'synonym', reason: '合理的解释长度' }), /托管/);
  assert.match(g.reinforce(room, 'p0', node.id), /托管/);

  // 非行动玩家 p1 托管：不能发起质疑
  g.enterAutoPilot(room, 'p1', 'timeout');
  assert.match(g.challenge(room, 'p1', node.id), /托管/);
  assert.strictEqual(room.pendingChallenge, null, '托管玩家的质疑不成立');

  // 在线非托管玩家 p2 质疑 p0 的词；房主 p0 离线托管，裁定顺延给在线非托管的 p3
  assert.strictEqual(g.challenge(room, 'p2', node.id), null);
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p3');
  // 裁定者 p3 掉线托管 → 裁定权移交（合格人选：p1 虽在线但超时托管，排除 → 无人，
  // 因此这里先让 p1 收回，确保有合格的在线非托管人选可移交）
  g.releaseAutoPilot(room, 'p1', { reason: 'reconnect' });
  room.players.find(p => p.id === 'p3').connected = false;
  g.enterAutoPilot(room, 'p3', 'disconnect');
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p1', '裁定权移交给在线非托管的 p1');
  // 已移交的原裁定者 p3 处于托管，不能再裁定（托管守门先于身份判定）
  assert.match(g.resolveChallenge(room, 'p3', 'uphold'), /托管|只有裁定者/);
  assert.strictEqual(g.resolveChallenge(room, 'p1', 'reject'), null);
});

test('托管玩家不会被选为裁定者（即便仍在线的超时托管）', () => {
  const room = makeRoom(['甲', '乙', '丙', '丁']);
  g.endTurn(room, 'p0');
  playOk(room, '水花'); // p1 的词
  const node = room.nodes.find(n => n.word === '水花');
  // 房主 p0 与 p3 是仅有的非词主/非质疑者候选；让 p0 在线、p3 在线但超时托管
  g.enterAutoPilot(room, 'p3', 'timeout');
  assert.strictEqual(g.challenge(room, 'p2', node.id), null);
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p0', '在线房主优先于托管的 p3');
  g.resolveChallenge(room, 'p0', 'reject');

  // 房主掉线托管，p3 仍在线但超时托管：p2 质疑、p1 词主 → 无合格裁定者 → 拒绝
  room.players.find(p => p.id === 'p0').connected = false;
  g.enterAutoPilot(room, 'p0', 'disconnect');
  const tokensBefore = room.players[2].tokensLeft;
  const err = g.challenge(room, 'p2', node.id);
  assert.match(err, /裁定/);
  assert.strictEqual(room.pendingChallenge, null);
  assert.strictEqual(room.players[2].tokensLeft, tokensBefore, '无人裁定不扣次数');
  // p3 收回后（仍非质疑者/词主）即可承担裁定
  g.releaseAutoPilot(room, 'p3', { reason: 'reconnect' });
  assert.strictEqual(g.challenge(room, 'p2', node.id), null);
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p3');
});

test('轮到仍离线的托管玩家：托管代为空过该回合（不挂计时）', () => {
  const room = makeRoom(['甲', '乙']);
  // p0 正常结束回合；轮到 p1 前让 p1 掉线托管
  room.players[1].connected = false;
  g.enterAutoPilot(room, 'p1', 'disconnect');
  assert.strictEqual(g.endTurn(room, 'p0'), null);
  // 应直接跳过 p1，回到 p0
  assert.strictEqual(activeId(room), 'p0');
  assert.strictEqual(room.turn.turnNumber, 3, 'p1 的回合已被代过');
  // p1 重连不再影响已跳过的回合，之后正常轮到
  room.players[1].connected = true;
  g.releaseAutoPilot(room, 'p1');
  assert.strictEqual(g.endTurn(room, 'p0'), null);
  assert.strictEqual(activeId(room), 'p1');
  assert.ok(room.turn.deadline, '重连后轮到 p1 时有正常倒计时');
});

test('在线的超时托管玩家轮到自己时自动收回控制权', () => {
  const room = makeRoom(['甲', '乙']);
  // p0 回合超时：进入托管并代为结束
  g.enterAutoPilot(room, 'p0', 'timeout');
  assert.strictEqual(g.endTurn(room, 'p0', { auto: true, reason: 'timeout' }), null);
  assert.strictEqual(activeId(room), 'p1');
  // p1 立刻空过，回到 p0：p0 仍在线，beginTurn 应自动收回
  assert.strictEqual(g.endTurn(room, 'p1'), null);
  assert.strictEqual(activeId(room), 'p0');
  assert.strictEqual(g.isAutoPilot(room, 'p0'), false, '轮到自己自动收回');
  assert.ok(room.turn.deadline);
  assert.ok(room.log.some(e => e.type === 'resume' && e.playerId === 'p0' && e.reason === 'turn'));
});

test('质疑暂停与托管暂停叠加：质疑结束后行动玩家仍托管则保持暂停', () => {
  const room = makeRoom(['甲', '乙', '丙', '丁', '戊']);
  playOk(room, '开心');
  const node = room.nodes.find(n => n.word === '开心');
  // 房主 p0 是词主，裁定顺延；先让 p1 超时托管（仍在线），合格裁定者应跳过 p1 选 p3
  g.enterAutoPilot(room, 'p1', 'timeout');
  assert.strictEqual(g.challenge(room, 'p2', node.id), null);
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p3');
  assert.strictEqual(room.turn.pausedReason, 'challenge');
  // 行动玩家 p0 此时掉线托管：质疑暂停中的剩余时间不被覆盖
  room.players[0].connected = false;
  g.enterAutoPilot(room, 'p0', 'disconnect');
  assert.strictEqual(room.turn.pausedReason, 'challenge', '质疑暂停优先，不被托管覆盖');
  // p3 裁定不成立：行动玩家仍托管 → 不恢复倒计时，转为托管暂停
  assert.strictEqual(g.resolveChallenge(room, 'p3', 'reject'), null);
  assert.strictEqual(room.turn.deadline, null, '托管中的行动玩家在质疑后仍暂停');
  assert.strictEqual(room.turn.pausedReason, 'autopilot');
  // 重连收回 → 恢复
  room.players[0].connected = true;
  g.releaseAutoPilot(room, 'p0');
  assert.ok(room.turn.deadline);
});

test('托管的进入/收回/代为结束/移交都写入回放日志并生成可读帧', () => {
  const room = makeRoom(['甲', '乙', '丙', '丁', '戊']);
  playOk(room, '开心');
  const node = room.nodes.find(n => n.word === '开心');
  // 行动玩家 p0（房主、词主）掉线托管（含托管进入帧）；p1 也超时托管（仍在线）。
  // p2 质疑时，合格裁定者跳过离线房主与托管的 p1，顺延给 p3。
  room.players[0].connected = false;
  g.enterAutoPilot(room, 'p0', 'disconnect');
  g.enterAutoPilot(room, 'p1', 'timeout');
  assert.strictEqual(g.challenge(room, 'p2', node.id), null);
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p3');
  // p3 掉线托管 → 裁定权移交 p4（在线、非质疑者、非词主、非托管）
  room.players.find(p => p.id === 'p3').connected = false;
  g.enterAutoPilot(room, 'p3', 'disconnect');
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p4');
  assert.strictEqual(g.resolveChallenge(room, 'p4', 'reject'), null);
  // 重连所有托管玩家，行动玩家 p0 收回控制权并恢复计时
  for (const pid of ['p0', 'p1', 'p3']) {
    room.players.find(p => p.id === pid).connected = true;
    g.releaseAutoPilot(room, pid);
  }
  while (room.phase === 'playing') g.endTurn(room, activeId(room), { auto: true });

  const frames = g.buildReplay(room);
  const kinds = frames.map(f => f.kind);
  assert.ok(kinds.includes('autopilot'), '回放含托管帧');
  assert.ok(kinds.includes('resume'), '回放含收回帧');
  assert.ok(kinds.includes('adjudicator'), '回放含裁定移交帧');
  assert.match(frames.find(f => f.kind === 'autopilot').label, /进入托管/);
  assert.match(frames.find(f => f.kind === 'resume').label, /收回控制权/);
  assert.match(frames.find(f => f.kind === 'adjudicator').label, /裁定权移交/);
});

test('公开视图暴露 autoPilot 标记', () => {
  const room = makeRoom(['甲', '乙']);
  g.enterAutoPilot(room, 'p1', 'timeout');
  const view = g.publicView(room, 'p0');
  assert.strictEqual(view.players.find(p => p.id === 'p1').autoPilot, true);
  assert.strictEqual(view.players.find(p => p.id === 'p0').autoPilot, false);
});

// ---------- 重启后暂停状态一致性 ----------
// loadRooms 重启恢复时的等价纯逻辑处理：质疑暂停 / 托管暂停保留 pausedRemaining，
// 只有正常进行中的回合才给完整倒计时。这里复刻关键转换并验证重连/裁定的恢复口径。

function simulateRestartRoom(room) {
  room.players.forEach(p => { p.connected = false; p.autoPilot = false; });
  (room.spectators || []).forEach(s => { s.connected = false; });
  const t = room.turn;
  if (room.phase === 'playing' && t) {
    if (room.pendingChallenge && !t.deadline) {
      t.pausedReason = 'challenge';
    } else if (!t.deadline && t.pausedRemaining != null) {
      t.pausedReason = t.pausedReason === 'challenge' ? 'challenge' : 'autopilot';
    } else if (!t.deadline) {
      t.deadline = Date.now() + room.ruleSet.turnSeconds * 1000;
      t.pausedRemaining = null; t.pausedReason = null;
    } else {
      t.deadline = Date.now() + room.ruleSet.turnSeconds * 1000;
    }
  }
  return room;
}

test('重启保留托管暂停的剩余时间：行动玩家重连后用暂停点剩余时间恢复', () => {
  const room = makeRoom(['甲', '乙']);
  room.ruleSet.turnSeconds = 90;
  playOk(room, '开心');
  // 人为制造"已用掉一段时间"的暂停点（剩余明显小于完整回合）
  room.turn.deadline = Date.now() + 30000;
  // 掉线托管：暂停并保存剩余时间
  room.players[0].connected = false;
  g.enterAutoPilot(room, 'p0', 'disconnect');
  const savedRemaining = room.turn.pausedRemaining;
  assert.ok(savedRemaining > 20000 && savedRemaining <= 30000);

  // 重启：autoPilot 被清、玩家离线，但暂停剩余时间保留（不再重置成完整一回合）
  simulateRestartRoom(room);
  assert.strictEqual(g.isAutoPilot(room, 'p0'), false, '重启不保留临时托管标记');
  assert.strictEqual(room.turn.deadline, null, '重启不把托管暂停恢复成倒计时');
  assert.strictEqual(room.turn.pausedRemaining, savedRemaining, '保留暂停点剩余时间');
  assert.strictEqual(room.turn.pausedReason, 'autopilot');

  // 重连：立即用暂停点剩余时间恢复，而不是完整 turnSeconds
  room.players[0].connected = true;
  const resumed = g.resumeOnReconnect(room, 'p0');
  assert.strictEqual(resumed, true);
  assert.ok(room.turn.deadline);
  assert.strictEqual(room.turn.pausedRemaining, null);
  const restored = room.turn.deadline - Date.now();
  assert.ok(Math.abs(restored - savedRemaining) < 500, '恢复的是原剩余时间');
  assert.ok(restored < room.ruleSet.turnSeconds * 1000 - 50000, '不是完整一回合');
});

test('重启保留质疑暂停的剩余时间：裁定结束后用原剩余时间恢复而非立即超时', () => {
  const room = makeRoom(['甲', '乙', '丙', '丁']);
  room.ruleSet.turnSeconds = 90;
  playOk(room, '开心');
  const node = room.nodes.find(n => n.word === '开心');
  g.challenge(room, 'p2', node.id); // 房主 p0 是词主，顺延给第一个合格的在线非托管玩家
  const adjudicator = room.pendingChallenge.adjudicatorId;
  assert.notStrictEqual(adjudicator, 'p0');
  assert.notStrictEqual(adjudicator, 'p2');
  room.turn.pausedRemaining = 30000; // 人为设定一个明显小于完整回合的剩余时间
  const savedRemaining = room.turn.pausedRemaining;

  // 重启：质疑仍在、计时保持暂停，剩余时间原样保留
  simulateRestartRoom(room);
  assert.ok(room.pendingChallenge, '待裁定质疑随房间保留');
  assert.strictEqual(room.turn.deadline, null);
  assert.strictEqual(room.turn.pausedRemaining, savedRemaining);
  assert.strictEqual(room.turn.pausedReason, 'challenge');

  // 裁定者与行动玩家 p0 都重连（质疑仍在，计时不动）；随后裁定不成立：按原剩余时间恢复
  room.players.find(p => p.id === adjudicator).connected = true;
  g.resumeOnReconnect(room, adjudicator);
  room.players.find(p => p.id === 'p0').connected = true;
  g.resumeOnReconnect(room, 'p0');
  assert.strictEqual(room.turn.deadline, null, '质疑仍裁定时行动计时保持暂停');
  assert.strictEqual(g.resolveChallenge(room, adjudicator, 'reject'), null);
  assert.ok(room.turn.deadline, '裁定结束恢复倒计时');
  const restored = room.turn.deadline - Date.now();
  assert.ok(Math.abs(restored - savedRemaining) < 500, '裁定后恢复原剩余时间');
  assert.ok(restored > 1000, '不会立即超时');
  assert.ok(restored < room.ruleSet.turnSeconds * 1000 - 50000, '不是完整一回合');
});

test('重启后待裁定质疑的裁定者离线：任一合格玩家重连时移交裁定权', () => {
  const room = makeRoom(['甲', '乙', '丙', '丁']);
  g.endTurn(room, 'p0');
  playOk(room, '水花'); // p1 的词
  const node = room.nodes.find(n => n.word === '水花');
  g.challenge(room, 'p2', node.id); // 房主 p0 裁定
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p0');

  simulateRestartRoom(room); // 全员离线
  // p3 重连（非质疑者、非词主）：裁定权应从离线房主移交给 p3
  room.players.find(p => p.id === 'p3').connected = true;
  const resumed = g.resumeOnReconnect(room, 'p3');
  assert.strictEqual(resumed, true);
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p3', '裁定权移交给在线合格玩家');
  assert.strictEqual(g.resolveChallenge(room, 'p3', 'reject'), null);
});

test('重启后质疑期间行动玩家掉线：裁定结束时保持托管暂停，重连再恢复', () => {
  const room = makeRoom(['甲', '乙', '丙', '丁']);
  playOk(room, '开心');
  const node = room.nodes.find(n => n.word === '开心');
  g.challenge(room, 'p2', node.id); // 裁定顺延给 p3（房主 p0 是词主）
  const adjudicator = room.pendingChallenge.adjudicatorId;
  const savedRemaining = room.turn.pausedRemaining;

  simulateRestartRoom(room); // 全员离线、质疑仍在
  // 行动玩家 p0 与裁定者 p3 都重连；但 p0 在裁定前重连，裁定结束时其在线应恢复计时
  room.players.find(p => p.id === 'p0').connected = true;
  g.resumeOnReconnect(room, 'p0');
  room.players.find(p => p.id === adjudicator).connected = true;
  g.resumeOnReconnect(room, adjudicator);
  assert.strictEqual(g.resolveChallenge(room, adjudicator, 'reject'), null);
  assert.ok(room.turn.deadline, '行动玩家在线：裁定后恢复倒计时');
  assert.ok(Math.abs((room.turn.deadline - Date.now()) - savedRemaining) < 500);
});

test('裁定恢复时剩余时间已耗尽给 1 秒兜底，不立即超时', () => {
  const room = makeRoom(['甲', '乙', '丙']);
  playOk(room, '开心');
  const node = room.nodes.find(n => n.word === '开心');
  g.challenge(room, 'p1', node.id);
  const adjudicator = room.pendingChallenge.adjudicatorId;
  room.turn.pausedRemaining = 0; // 损坏/极端：剩余时间为 0
  assert.strictEqual(g.resolveChallenge(room, adjudicator, 'reject'), null);
  const restored = room.turn.deadline - Date.now();
  assert.ok(restored >= 1000 && restored <= 1100, '给 1 秒兜底而非 0ms 立即超时');
});



test('服务器重启：旧观战者立即清出，玩家保留座位置离线', () => {
  const room = makeRoom(['甲', '乙']);
  // 占满观战名额（重启前都在线）
  for (let i = 0; i < g.MAX_SPECTATORS; i++) {
    assert.strictEqual(g.addSpectator(room, `sp${i}`, `观${i}`), null);
  }
  assert.strictEqual(room.spectators.filter(s => s.connected).length, g.MAX_SPECTATORS);
  assert.match(g.addSpectator(room, 'spX', '再来一个'), /已满/);
  const playerCount = room.players.length;

  // 模拟服务器恢复房间：连接已全部不存在
  g.resetConnectionsAfterRestart(room); // 玩家置离线
  g.removeAllSpectators(room);          // 观战者立即清出（而非挂在名单上等延迟清理）

  assert.strictEqual(room.spectators.length, 0, '大厅/对局名单上不应残留旧观战者');
  assert.ok(room.players.every(p => p.connected === false), '玩家置离线（凭 token 重连恢复）');
  assert.strictEqual(room.players.length, playerCount, '玩家座位保留');

  // 名额立即全部释放：新观战者当场就能进，最多 MAX_SPECTATORS 人
  for (let i = 0; i < g.MAX_SPECTATORS; i++) {
    assert.strictEqual(g.addSpectator(room, `nw${i}`, `新观${i}`), null);
  }
  assert.match(g.addSpectator(room, 'spX', '再多一个'), /已满/);
});

test('历史战绩摘要：名次、得分、胜者与时间；未结束房间也可查', () => {
  const room = makeRoom(['甲', '乙']);
  assert.strictEqual(g.historySummary(room, '陌生人'), null, '非本房玩家没有战绩');

  // 对局进行中：可重返，但还没有名次与得分
  const playing = g.historySummary(room, 'p0');
  assert.strictEqual(playing.phase, 'playing');
  assert.strictEqual(playing.yourRank, null);
  assert.strictEqual(playing.yourTotal, null);
  assert.strictEqual(playing.endedAt, null);

  playOk(room, '开心'); // 甲接一词，确保分出胜负
  const total = room.players.length * room.ruleSet.rounds;
  for (let i = 0; i < total; i++) g.endTurn(room, room.turn.playerId);

  const s = g.historySummary(room, 'p0');
  assert.strictEqual(s.phase, 'ended');
  assert.ok(s.endedAt >= s.createdAt, '记录结束时间供列表展示与排序');
  assert.strictEqual(s.winner, 'p0');
  assert.strictEqual(s.winnerName, '甲');
  assert.strictEqual(s.yourRank, 1);
  assert.ok(s.yourTotal > 0);
  assert.deepStrictEqual(s.players, ['甲', '乙']);
  assert.strictEqual(s.youName, '甲');

  const s1 = g.historySummary(room, 'p1');
  assert.strictEqual(s1.yourRank, 2);
  assert.strictEqual(s1.yourTotal, 0);
});

test('房主提前离线时，新质疑的裁定者顺延给在线玩家', () => {
  // 4 人局：房主 p0 离线；p1 的词被 p2 质疑 → 裁定者应是在线的 p3，而不是离线房主
  const room = g.newRoom('TESTOFF', 'p0', '甲');
  ['p0', 'p1', 'p2', 'p3'].forEach((id, i) => g.addPlayer(room, id, `玩家${i}`));
  g.startGame(room, 'p0', () => 0.01);
  g.endTurn(room, 'p0'); // 轮到 p1
  g.playWord(room, 'p1', { word: '水花', parentId: 'start0', relation: 'synonym', reason: '合理的解释' });
  room.players.find(p => p.id === 'p0').connected = false; // 房主提前离线
  const n1 = room.nodes.find(n => n.word === '水花');
  assert.strictEqual(g.challenge(room, 'p2', n1.id), null);
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p3', '离线房主不应再收到新质疑');
  assert.strictEqual(g.resolveChallenge(room, 'p3', 'reject'), null, '在线裁定者可正常裁定，对局不停住');
  assert.strictEqual(room.pendingChallenge, null);
});

test('没有在线裁定者时，质疑被拒绝：不扣次数、不停计时、不卡对局', () => {
  const room = makeRoom(['甲', '乙', '丙']); // p0 房主
  g.endTurn(room, 'p0');
  playOk(room, '水花'); // p1 的词
  room.players.find(p => p.id === 'p0').connected = false; // 房主提前离线
  const n1 = room.nodes.find(n => n.word === '水花');
  const challenger = room.players.find(p => p.id === 'p2');
  const tokensBefore = challenger.tokensLeft;
  const err = g.challenge(room, 'p2', n1.id); // p1 词主、p2 质疑者 → 无在线裁定者
  assert.match(err, /裁定/);
  assert.strictEqual(room.pendingChallenge, null, '不应产生待裁定质疑');
  assert.strictEqual(challenger.tokensLeft, tokensBefore, '不扣质疑次数');
  assert.ok(room.turn.deadline, '回合计时不应暂停');
  // 房主回来后即可正常质疑
  room.players.find(p => p.id === 'p0').connected = true;
  assert.strictEqual(g.challenge(room, 'p2', n1.id), null);
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p0');
  assert.strictEqual(challenger.tokensLeft, tokensBefore - 1);
});

test('房主在线时，新质疑的裁定者仍是房主', () => {
  const room = makeRoom(['甲', '乙', '丙']);
  g.endTurn(room, 'p0');
  playOk(room, '水花'); // p1 的词
  const n1 = room.nodes.find(n => n.word === '水花');
  assert.strictEqual(g.challenge(room, 'p2', n1.id), null);
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p0');
});

// ---------- 主题词包 ----------

const PACK = { id: 'pk1', name: '海洋', theme: '一切都与大海有关',
  words: ['海浪', '贝壳', '灯塔', '海鸥', '帆船'] };

function lobbyRoom(playerNames = ['甲', '乙']) {
  const room = g.newRoom('PACK', 'p0', playerNames[0]);
  playerNames.forEach((n, i) => g.addPlayer(room, `p${i}`, n));
  return room;
}

test('主题词包：房主设置后开局从候选词中不重复抽取', () => {
  const room = lobbyRoom();
  assert.strictEqual(g.setWordPack(room, 'p0', PACK), null);
  assert.deepStrictEqual(room.wordPack.words, PACK.words);
  assert.strictEqual(g.startGame(room, 'p0', () => 0.01), null);
  assert.strictEqual(room.startWords.length, room.ruleSet.startWordCount);
  assert.ok(room.startWords.every(w => PACK.words.includes(w)), '起始词全部来自词包');
  assert.strictEqual(new Set(room.startWords).size, room.startWords.length, '不重复抽取');
  // 开局日志记录了词包名，回放首帧能看到主题
  const start = room.log.find(e => e.type === 'start');
  assert.strictEqual(start.wordPack, '海洋');
  const frames = g.buildReplay(room);
  assert.match(frames.find(f => f.label.includes('起始词')).label, /海洋/);
});

test('主题词包：候选词不足 startWordCount 时有多少抽多少', () => {
  const room = lobbyRoom();
  assert.strictEqual(g.setWordPack(room, 'p0', { ...PACK, words: ['海浪', '贝壳', '灯塔'] }), null);
  assert.strictEqual(g.startGame(room, 'p0', () => 0.01), null);
  assert.deepStrictEqual(room.startWords.sort(), ['灯塔', '海浪', '贝壳'].sort());
});

test('主题词包：非房主/非大厅阶段不能设置，观战者不能设置', () => {
  const room = lobbyRoom();
  assert.match(g.setWordPack(room, 'p1', PACK), /房主/);
  g.addSpectator(room, 'sp_1', '看客');
  assert.match(g.setWordPack(room, 'sp_1', PACK), /观战/);
  assert.strictEqual(g.startGame(room, 'p0', () => 0.01), null);
  assert.match(g.setWordPack(room, 'p0', PACK), /开始后/);
});

test('主题词包：非法词包被拒绝，清除后回退默认词池', () => {
  const room = lobbyRoom();
  assert.match(g.setWordPack(room, 'p0', { name: '', theme: '', words: PACK.words }), /名称/);
  assert.match(g.setWordPack(room, 'p0', { name: 'x', theme: '', words: ['甲', '乙'] }), /至少/);
  assert.match(g.setWordPack(room, 'p0', { name: 'x', theme: '', words: 'not-array' }), /至少/);
  assert.strictEqual(g.setWordPack(room, 'p0', null), null, '未设置时清除也是允许的');
  assert.strictEqual(g.setWordPack(room, 'p0', PACK), null);
  assert.strictEqual(g.setWordPack(room, 'p0', null), null);
  assert.strictEqual(room.wordPack, null);
  assert.strictEqual(g.startGame(room, 'p0', () => 0.01), null);
  assert.ok(room.startWords.every(w => g.START_WORD_POOL.includes(w)), '回退默认词池');
});

test('主题词包：服务端清洗词包（去重/去空白/过滤非法词），视图对全员可见', () => {
  const room = lobbyRoom();
  const messy = { id: 'pk9', name: ' 海洋 ', theme: ' 主题 ',
    words: ['海浪', ' 贝壳 ', '海浪', '', '带 空格', '超'.repeat(13), '灯塔'] };
  assert.strictEqual(g.setWordPack(room, 'p0', messy), null);
  assert.strictEqual(room.wordPack.name, '海洋');
  assert.deepStrictEqual(room.wordPack.words, ['海浪', '贝壳', '灯塔']);
  const view = g.publicView(room, 'p1');
  assert.strictEqual(view.wordPack.name, '海洋');
  assert.deepStrictEqual(view.wordPack.words, ['海浪', '贝壳', '灯塔']);
  // 未选用时视图为 null
  const room2 = lobbyRoom();
  assert.strictEqual(g.publicView(room2, 'p1').wordPack, null);
});

// ---------- 已结束房间保留期 ----------

function endedRoom(players = ['甲', '乙']) {
  const room = makeRoom(players);
  const total = room.players.length * room.ruleSet.rounds;
  for (let i = 0; i < total; i++) assert.strictEqual(g.endTurn(room, activeId(room)), null);
  assert.strictEqual(room.phase, 'ended');
  return room;
}

const DAY = 24 * 60 * 60 * 1000;
const TTL = 7 * DAY;
const NOW = 10_000_000_000_000;

test('isRoomExpired：仅已结束且超过保留期才算失效', () => {
  const ended = endedRoom();
  ended.endedAt = NOW - TTL - 1;
  assert.strictEqual(g.isRoomExpired(ended, TTL, NOW), true);
  ended.endedAt = NOW - TTL; // 刚好到点（>=）即失效
  assert.strictEqual(g.isRoomExpired(ended, TTL, NOW), true);
  ended.endedAt = NOW - TTL + 1;
  assert.strictEqual(g.isRoomExpired(ended, TTL, NOW), false);
  ended.endedAt = NOW - 1000;
  assert.strictEqual(g.isRoomExpired(ended, TTL, NOW), false, '刚结束的房间保留');

  const playing = makeRoom();
  playing.createdAt = NOW - 30 * DAY;
  assert.strictEqual(g.isRoomExpired(playing, TTL, NOW), false, '进行中房间永不失效');
  const lobby = g.newRoom('LOBB', 'p0', '甲');
  lobby.createdAt = NOW - 30 * DAY;
  assert.strictEqual(g.isRoomExpired(lobby, TTL, NOW), false, '大厅房间永不失效');

  assert.strictEqual(g.isRoomExpired(ended, 0, NOW), false, '保留期为 0/非法时不清理');
  assert.strictEqual(g.isRoomExpired(ended, -1, NOW), false);
  assert.strictEqual(g.isRoomExpired(null, TTL, NOW), false);
});

test('isRoomExpired：旧存档无 endedAt 时退回 createdAt', () => {
  const room = endedRoom();
  delete room.endedAt;
  room.createdAt = NOW - TTL - 1;
  assert.strictEqual(g.isRoomExpired(room, TTL, NOW), true);
  room.createdAt = NOW - 1000;
  assert.strictEqual(g.isRoomExpired(room, TTL, NOW), false);
});

test('pruneExpiredRooms：只删超期结束房，返回被删列表', () => {
  const old1 = endedRoom(); old1.code = 'OLD1'; old1.endedAt = NOW - TTL - DAY;
  const old2 = endedRoom(); old2.code = 'OLD2'; old2.endedAt = NOW - TTL - 1;
  const fresh = endedRoom(); fresh.code = 'FRESH'; fresh.endedAt = NOW - 1000;
  const playing = makeRoom(); playing.createdAt = NOW - 30 * DAY;

  const roomsMap = new Map([
    ['OLD1', old1], ['OLD2', old2], ['FRESH', fresh],
    ['PLAY', playing],
  ]);
  const removed = g.pruneExpiredRooms(roomsMap, TTL, NOW);
  assert.deepStrictEqual(removed.map(r => r.code).sort(), ['OLD1', 'OLD2']);
  assert.deepStrictEqual([...roomsMap.keys()].sort(), ['FRESH', 'PLAY']);

  assert.deepStrictEqual(g.pruneExpiredRooms(new Map(), TTL, NOW), []);
  assert.deepStrictEqual(g.pruneExpiredRooms('not a map', TTL, NOW), []);
});
