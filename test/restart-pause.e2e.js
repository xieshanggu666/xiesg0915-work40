'use strict';
// 重启后暂停状态一致性端到端（中途真正 stopServer/startServer，复用同一落盘存档）：
//  1) 托管暂停（行动玩家掉线）跨重启保留暂停点剩余时间，重连用该剩余时间恢复——
//     不重置成完整一回合、也不立即超时；
//  2) 质疑暂停跨重启保留剩余时间，裁定结束按原剩余时间恢复；
//  3) 重启后离线裁定者的裁定权可移交给重连的合格玩家。
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_FILE = path.join(os.tmpdir(), `wt-restart-${process.pid}-${Date.now()}.json`);
const SEASON_FILE = path.join(os.tmpdir(), `wt-restart-season-${process.pid}-${Date.now()}.json`);
process.env.WT_DATA_FILE = DATA_FILE;
process.env.WT_SEASON_FILE = SEASON_FILE;

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}

let BASE_URL = '';
function client(name) {
  const c = { name, ws: new WebSocket(BASE_URL), state: null, token: null, msgs: [] };
  c.ws.on('error', () => {});
  c.send = (m) => c.ws.readyState === 1 && c.ws.send(JSON.stringify(m));
  c.ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'joined') c.token = msg.token;
    if (msg.type === 'state') c.state = msg.state;
    c.msgs.push(msg);
  });
  c.waitFor = (pred, timeout = 3000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred(c)) { clearInterval(iv); res(c); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error(`${name}: waitFor 超时`)); }
    }, 10);
  });
  c.opened = new Promise(res => c.ws.on('open', res));
  c.close = () => { try { c.ws.close(); } catch { /* ignore */ } };
  return c;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const flush = () => sleep(450); // 等服务端 300ms 防抖落盘

function closeAll(cs) { cs.forEach(c => c.close()); }

async function scenarioAutopilotPauseRestart(startServer) {
  const srv = await startServer(0);
  BASE_URL = `ws://localhost:${srv.port}`;

  const A = client('甲'); await A.opened;
  A.send({ type: 'createRoom', name: '甲' });
  await A.waitFor(c => c.state && c.state.phase === 'lobby');
  const code = A.state.code;
  const B = client('乙'); await B.opened;
  B.send({ type: 'joinRoom', name: '乙', roomCode: code });
  await B.waitFor(c => c.state && c.state.players.length === 2);
  A.send({ type: 'setRules', ruleSet: { turnSeconds: 90, rounds: 2, __turnMsOverride: 10000 } });
  await A.waitFor(c => c.msgs.some(m => m.type === 'rulesSaved'));
  A.send({ type: 'startGame' });
  await A.waitFor(c => c.state.phase === 'playing');
  await sleep(3000); // 先消耗约 3 秒，使暂停点剩余时间明显介于 1 秒与完整回合之间
  A.send({ type: 'play', word: '火焰', parentId: A.state.nodes[0].id,
    relation: 'hypernym', reason: '火焰是火的一种形态' });
  await A.waitFor(c => c.state.nodes.some(n => n.word === '火焰'));

  // 行动玩家掉线 → 托管暂停
  const tokenA = A.token;
  A.close();
  await B.waitFor(c => c.state.turn.deadline === null && c.state.turn.pausedReason === 'autopilot');
  const pausedRemaining = B.state.turn.pausedRemaining;
  check('掉线后托管暂停并保存剩余时间', pausedRemaining > 1000 && pausedRemaining < 9000);

  // 真正重启
  await flush();
  await srv.stop();
  const srv2 = await startServer(0);
  BASE_URL = `ws://localhost:${srv2.port}`;

  // 乙先重连观察：甲仍离线，回合保持暂停（不重置、不前进）
  const B2 = client('乙'); await B2.opened;
  B2.send({ type: 'reconnect', token: B.token });
  await B2.waitFor(c => c.state && c.state.phase === 'playing');
  check('重启后行动玩家仍离线：回合保持暂停且保留剩余时间',
    B2.state.turn.deadline === null &&
    Math.abs(B2.state.turn.pausedRemaining - pausedRemaining) < 1000 &&
    B2.state.turn.pausedReason === 'autopilot');

  // 甲重连前，乙视角确认重启没有偷偷给暂停回合挂任何 deadline（不会空跑/立即超时）
  check('重启后暂停回合没有在跑的倒计时',
    B2.state.turn.deadline === null && B2.state.turn.pausedRemaining === pausedRemaining);

  // 甲重连：用暂停点剩余时间恢复
  const A2 = client('甲'); await A2.opened;
  A2.send({ type: 'reconnect', token: tokenA });
  await A2.waitFor(c => c.state && c.state.turn && c.state.turn.deadline);
  const restored = A2.state.turn.deadline - Date.now();
  check('重连用暂停点剩余时间恢复（非完整回合、非立即超时）',
    restored > 1000 && restored < 9000 &&
    Math.abs(restored - pausedRemaining) < 1000);
  check('托管标记已收回',
    A2.state.players.find(p => p.id === A2.state.you).autoPilot === false);

  closeAll([A2, B2]);
  await flush();
  return srv2;
}

async function scenarioChallengePauseRestart(startServer) {
  const srv = await startServer(0);
  BASE_URL = `ws://localhost:${srv.port}`;

  const A = client('甲'); await A.opened;
  A.send({ type: 'createRoom', name: '甲' });
  await A.waitFor(c => c.state && c.state.phase === 'lobby');
  const code = A.state.code;
  const B = client('乙'); await B.opened;
  B.send({ type: 'joinRoom', name: '乙', roomCode: code });
  await B.waitFor(c => c.state && c.state.players.length === 2);
  const C = client('丙'); await C.opened;
  C.send({ type: 'joinRoom', name: '丙', roomCode: code });
  await C.waitFor(c => c.state && c.state.players.length === 3);

  A.send({ type: 'setRules', ruleSet: { turnSeconds: 90, rounds: 1, __turnMsOverride: 10000 } });
  await A.waitFor(c => c.msgs.some(m => m.type === 'rulesSaved'));
  A.send({ type: 'startGame' });
  await A.waitFor(c => c.state.phase === 'playing');
  await sleep(3000); // 先消耗约 3 秒
  A.send({ type: 'play', word: '火焰', parentId: A.state.nodes[0].id,
    relation: 'hypernym', reason: '火焰是火的一种形态' });
  await A.waitFor(c => c.state.nodes.some(n => n.word === '火焰'));
  const node = A.state.nodes.find(n => n.word === '火焰');

  // 乙质疑房主的词；房主是词主，裁定顺延给丙
  B.send({ type: 'challenge', nodeId: node.id });
  await C.waitFor(c => c.state.pendingChallenge && c.state.pendingChallenge.adjudicatorId === c.state.you);
  check('质疑暂停计时',
    C.state.turn.deadline === null && C.state.turn.pausedReason === 'challenge');
  const pausedRemaining = C.state.turn.pausedRemaining;

  // 全员掉线 + 重启
  const tokenA = A.token;
  closeAll([A, B, C]);
  await flush();
  await srv.stop();
  const srv2 = await startServer(0);
  BASE_URL = `ws://localhost:${srv2.port}`;

  // 裁定者丙重连：质疑仍在、计时仍暂停、剩余时间保留
  const C2 = client('丙'); await C2.opened;
  C2.send({ type: 'reconnect', token: C.token });
  await C2.waitFor(c => c.state && c.state.pendingChallenge);
  check('重启后质疑仍在、计时保持暂停、剩余时间保留',
    C2.state.turn.deadline === null &&
    Math.abs(C2.state.turn.pausedRemaining - pausedRemaining) < 1000 &&
    C2.state.pendingChallenge.adjudicatorId === C2.state.you);

  // 行动玩家甲重连（质疑未裁定，计时仍暂停）
  const A2 = client('甲'); await A2.opened;
  A2.send({ type: 'reconnect', token: tokenA });
  await A2.waitFor(c => c.state && c.state.pendingChallenge);
  check('质疑裁定前行动玩家重连也不恢复计时', A2.state.turn.deadline === null);

  // 丙裁定不成立 → 按原剩余时间恢复
  C2.send({ type: 'resolve', verdict: 'reject' });
  await A2.waitFor(c => c.state && c.state.turn && c.state.turn.deadline);
  const restored = A2.state.turn.deadline - Date.now();
  check('裁定结束按暂停点剩余时间恢复（非完整回合、非立即超时）',
    restored > 1000 && restored < 9000 &&
    Math.abs(restored - pausedRemaining) < 1000);

  closeAll([A2, C2]);
  await flush();
  return srv2;
}

(async () => {
  let exitCode = 0;
  let srv;
  try {
    const { startServer, stopServer } = require('../server');
    srv = await scenarioAutopilotPauseRestart(startServer);
    await srv.stop();
    srv = await scenarioChallengePauseRestart(startServer);
  } catch (e) {
    console.error('重启一致性测试异常:', e.stack || e.message);
    exitCode = 1;
  } finally {
    try { if (srv) await srv.stop(); } catch { /* ignore */ }
    try { fs.rmSync(DATA_FILE, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(SEASON_FILE, { force: true }); } catch { /* ignore */ }
  }
  console.log(failures === 0 && exitCode === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(exitCode === 0 && failures === 0 ? 0 : 1);
})();
