'use strict';
// 托管端到端：
//  1) 行动玩家掉线立即进入托管并暂停回合计时；托管期间无人裁定时质疑被拒；
//     重连立即收回控制权并恢复倒计时（剩余时间来自暂停点）；掉线/收回进入回放。
//  2) 在线玩家回合超时：进入托管并由系统代为结束回合，回放可见。
// 自包含：在系统分配的临时端口与临时存档上启动服务器，跑完即停。
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_FILE = path.join(os.tmpdir(), `wt-pilot-${process.pid}-${Date.now()}.json`);
const SEASON_FILE = path.join(os.tmpdir(), `wt-pilot-season-${process.pid}-${Date.now()}.json`);
process.env.WT_DATA_FILE = DATA_FILE;
process.env.WT_SEASON_FILE = SEASON_FILE;
const { startServer, stopServer } = require('../server');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}

let BASE_URL = '';
function client(name) {
  const c = { name, ws: new WebSocket(BASE_URL), state: null, token: null, msgs: [] };
  c.ws.on('error', () => {});
  c.send = (m) => c.ws.send(JSON.stringify(m));
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
  return c;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function disconnectPilot() {
  const A = client('甲');
  await A.opened;
  A.send({ type: 'createRoom', name: '甲' });
  await A.waitFor(c => c.state && c.state.phase === 'lobby');
  const code = A.state.code;

  const B = client('乙');
  await B.opened;
  B.send({ type: 'joinRoom', name: '乙', roomCode: code });
  await B.waitFor(c => c.state && c.state.players.length === 2);

  // 长回合计时 + 测试覆盖（仅服务端内部，用于其它路径；此处主要验证掉线暂停而非超时）
  A.send({ type: 'setRules', ruleSet: { turnSeconds: 120, rounds: 2 } });
  await A.waitFor(c => c.msgs.some(m => m.type === 'rulesSaved'));
  A.send({ type: 'startGame' });
  await A.waitFor(c => c.state.phase === 'playing');
  check('开局轮到房主甲', A.state.turn.playerId === A.state.you);

  const start0 = A.state.nodes[0].id;
  A.send({ type: 'play', word: '火焰', parentId: start0, relation: 'hypernym', reason: '火焰是火的一种形态' });
  await A.waitFor(c => c.state.nodes.some(n => n.word === '火焰'));
  const node = A.state.nodes.find(n => n.word === '火焰');

  // 行动玩家甲掉线 → 立即托管、暂停计时
  const tokenA = A.token;
  A.ws.close();
  await B.waitFor(c => {
    const act = c.state.players.find(p => p.id === c.state.turn.playerId);
    return act && act.autoPilot && c.state.turn.deadline === null &&
      c.state.turn.pausedReason === 'autopilot';
  });
  check('行动玩家掉线进入托管且回合计时暂停',
    B.state.turn.deadline === null && B.state.turn.pausedReason === 'autopilot');

  // 暂停期间回合不会被超时跳过
  await sleep(300);
  check('托管暂停期间回合不前进', B.state.turn.playerId === A.state.you && B.state.turn.deadline === null);

  // 托管期间乙质疑甲的词：房主离线托管、无在线裁定者 → 拒绝（不产生待裁定）
  B.send({ type: 'challenge', nodeId: node.id });
  await B.waitFor(c => c.msgs.some(m => m.type === 'error'));
  check('无在线非托管裁定时质疑被拒',
    B.msgs.some(m => m.type === 'error' && /裁定/.test(m.message)) && !B.state.pendingChallenge);

  // 甲重连 → 立即收回、恢复倒计时（剩余时间少于全新 120 秒）
  const A1 = client('甲');
  await A1.opened;
  A1.send({ type: 'reconnect', token: tokenA });
  await A1.waitFor(c => c.state && c.state.turn && c.state.turn.deadline);
  const me = A1.state.players.find(p => p.id === A1.state.you);
  check('重连立即收回托管并恢复倒计时', me.autoPilot === false && !!A1.state.turn.deadline);
  check('恢复的是暂停点剩余时间而非整回合重置', A1.state.turn.deadline - Date.now() < 120000);
  await B.waitFor(c => !c.state.players.some(p => p.autoPilot));
  check('其他玩家看到托管解除', true);

  // 收回后可正常接词
  A1.send({ type: 'play', word: '篝火', parentId: node.id, relation: 'scene', reason: '篝火晚会场景中出现' });
  await A1.waitFor(c => c.state.nodes.some(n => n.word === '篝火'));
  check('收回控制权后可正常接词', true);

  A1.send({ type: 'endTurn' });
  await B.waitFor(c => c.state.turn && c.state.turn.playerId === c.state.you);
  B.send({ type: 'endTurn' });
  await A1.waitFor(c => c.state.turn && c.state.turn.playerId === A1.state.you);

  // 结束整局以便取回放（rounds=2：再各空过一次）
  A1.send({ type: 'endTurn' });
  await B.waitFor(c => c.state.turn && c.state.turn.playerId === c.state.you);
  B.send({ type: 'endTurn' });
  await A1.waitFor(c => c.state.phase === 'ended');
  check('游戏结束', A1.state.phase === 'ended');

  A1.send({ type: 'replay' });
  await A1.waitFor(c => c.msgs.some(m => m.type === 'replay'));
  const frames = A1.msgs.find(m => m.type === 'replay').frames;
  check('回放可见掉线进入托管帧', frames.some(f => f.kind === 'autopilot' && /掉线，进入托管/.test(f.label)));
  check('回放可见重连收回控制权帧', frames.some(f => f.kind === 'resume' && /收回控制权/.test(f.label)));

  A1.ws.close(); B.ws.close();
}

async function timeoutPilot() {
  const C = client('丙');
  await C.opened;
  C.send({ type: 'createRoom', name: '丙' });
  await C.waitFor(c => c.state && c.state.phase === 'lobby');
  const code = C.state.code;
  const D = client('丁');
  await D.opened;
  D.send({ type: 'joinRoom', name: '丁', roomCode: code });
  await D.waitFor(c => c.state && c.state.players.length === 2);

  // 测试用内部短计时 120ms，让在线超时托管快速发生（不进入 ruleSet、不影响界面）
  C.send({ type: 'setRules', ruleSet: { turnSeconds: 30, rounds: 1, __turnMsOverride: 400 } });
  await C.waitFor(c => c.msgs.some(m => m.type === 'rulesSaved'));
  C.send({ type: 'startGame' });
  await C.waitFor(c => c.state.phase === 'playing');

  // 房主挂机不操作 → 超时进入托管并代为结束，轮到丁
  await D.waitFor(c => c.state.turn && c.state.turn.playerId === D.state.you);
  const host = D.state.players.find(p => p.id !== D.state.you);
  check('在线玩家超时后进入托管', host.autoPilot === true);
  // 丁也挂机 → 丁超时托管代过；rounds=1 共 2 回合，游戏结束
  await C.waitFor(c => c.state.phase === 'ended');
  check('两名玩家先后超时托管，对局正常结束', C.state.phase === 'ended');

  C.send({ type: 'replay' });
  await C.waitFor(c => c.msgs.some(m => m.type === 'replay'));
  const frames = C.msgs.find(m => m.type === 'replay').frames;
  check('回放可见超时进入托管帧', frames.some(f => /回合超时，进入托管/.test(f.label)));
  check('回放含两次托管帧', frames.filter(f => f.kind === 'autopilot').length >= 2);

  C.ws.close(); D.ws.close();
}

(async () => {
  let exitCode = 0;
  try {
    const { port } = await startServer(0);
    BASE_URL = `ws://localhost:${port}`;
    await disconnectPilot();
    await timeoutPilot();
  } catch (e) {
    console.error('托管冒烟测试异常:', e.stack || e.message);
    exitCode = 1;
  } finally {
    await stopServer();
    try { fs.rmSync(DATA_FILE, { force: true }); } catch { /* 忽略 */ }
    try { fs.rmSync(SEASON_FILE, { force: true }); } catch { /* 忽略 */ }
  }
  console.log(failures === 0 && exitCode === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(exitCode === 0 && failures === 0 ? 0 : 1);
})();
