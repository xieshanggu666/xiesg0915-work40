'use strict';
// 主题词包四地（本机 / 分享码 / 广场 / 建房快照）数据同步的端到端回归：
//  1. 跨设备更新分享：同一身份在设备 2 导入自己分享的词包后，带码提示更新沿用原码、不分裂；
//  2. 码提示防劫持：别人不能借提示覆盖不属于自己的分享；
//  3. 跨设备更新广场发布：带条目 id 提示沿用原条目、订阅数保留；
//  4. 作者本人订阅自己的发布不抬高热度；
//  5. 取消分享/下架的权限只认真实作者 pid；
//  6. 建房快照与分享/广场彼此独立：取消分享、下架不影响已建房的词包快照。
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stamp = `${process.pid}-${Date.now()}`;
const DATA_FILE = path.join(os.tmpdir(), `wt-packsync-${stamp}.json`);
const SEASON_FILE = path.join(os.tmpdir(), `wt-packsync-season-${stamp}.json`);
const SHARES_FILE = path.join(os.tmpdir(), `wt-packsync-shares-${stamp}.json`);
const PLAZA_FILE = path.join(os.tmpdir(), `wt-packsync-plaza-${stamp}.json`);
process.env.WT_DATA_FILE = DATA_FILE;
process.env.WT_SEASON_FILE = SEASON_FILE;
process.env.WT_SHARES_FILE = SHARES_FILE;
process.env.WT_PLAZA_FILE = PLAZA_FILE;
const { startServer, stopServer } = require('../server');

const SECRET_A = '8'.repeat(64);
const SECRET_B = '9'.repeat(64);

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let BASE_URL = '';

function client() {
  const c = { ws: new WebSocket(BASE_URL), state: null, msgs: [] };
  c.ws.on('error', () => {});
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'state') c.state = msg.state;
    c.msgs.push(msg);
  });
  c.waitFor = (pred, timeout = 3000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred(c)) { clearInterval(iv); res(c); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('waitFor 超时')); }
    }, 10);
  });
  c.last = (type) => c.msgs.filter(m => m.type === type).at(-1);
  c.opened = new Promise(res => c.ws.on('open', res));
  return c;
}

const PACK = { id: 'pk_origin_dev1', name: '跨设备同包', theme: '设备1写的主题',
  words: ['海浪', '贝壳', '灯塔', '海鸥'] };

async function main() {
  const { port } = await startServer(0);
  BASE_URL = `ws://localhost:${port}`;

  // ---------- 1. 分享码：跨设备带码提示更新不分裂 ----------
  const A = client();
  await A.opened;
  A.send({ type: 'sharePack', pidSecret: SECRET_A, pack: PACK });
  await A.waitFor(c => c.msgs.some(m => m.type === 'shared'));
  const shared = A.last('shared');
  const code = shared.code;
  check('设备1分享成功', /^[A-HJ-NP-Z2-9]{8}$/.test(code) && shared.packId === PACK.id);

  // 同一身份的设备2：凭码导入（拿到 id=pk_origin_dev1 的快照，客户端会生成新本机 id）
  const A2 = client();
  await A2.opened;
  A2.send({ type: 'importShare', code });
  await A2.waitFor(c => c.msgs.some(m => m.type === 'sharedPack'));
  check('设备2凭码导入快照', A2.last('sharedPack').pack.id === PACK.id);

  // 设备2编辑后带「码提示」重新分享：本机副本 id 与原 packId 不同
  A2.send({
    type: 'sharePack', pidSecret: SECRET_A, code,
    pack: { id: 'pk_copy_dev2', name: '跨设备同包', theme: '设备2改的主题',
      words: ['海浪', '贝壳', '鲸鱼', '海鸥'] },
  });
  await A2.waitFor(c => c.msgs.filter(m => m.type === 'shared').length >= 1
    && c.msgs.some(m => m.type === 'shared' && m.code === code && m.republished === true));
  const upd = A2.last('shared');
  check('带码提示更新沿用原码', upd.code === code && upd.republished === true);
  check('回包 packId 以服务端原条目为准', upd.packId === PACK.id);

  // 我的分享仍只有一条，且快照已是新版本
  A2.send({ type: 'myShares', pidSecret: SECRET_A });
  await A2.waitFor(c => c.msgs.some(m => m.type === 'myShares'));
  const mine = A2.last('myShares').shares;
  check('不分裂出第二个码', mine.length === 1 && mine[0].code === code && mine[0].packId === PACK.id);
  // 朋友此时导入的是更新后的快照
  const Friend = client();
  await Friend.opened;
  Friend.send({ type: 'importShare', code });
  await Friend.waitFor(c => c.msgs.some(m => m.type === 'sharedPack'));
  check('朋友此时导入的是更新后的快照',
    Friend.last('sharedPack').pack.theme === '设备2改的主题');
  Friend.ws.close();

  // ---------- 2. 码提示防劫持 ----------
  const B = client();
  await B.opened;
  B.send({
    type: 'sharePack', pidSecret: SECRET_B, code,
    pack: { id: 'pk_hacker', name: '攻击包', theme: 'h', words: ['甲', '乙', '丙'] },
  });
  await B.waitFor(c => c.msgs.some(m => m.type === 'shared'));
  const hack = B.last('shared');
  check('别人的码提示被忽略：B 拿到新码而不是覆盖 A 的码', hack.code !== code);
  // A 的码快照未被篡改
  const Chk = client();
  await Chk.opened;
  Chk.send({ type: 'importShare', code });
  await Chk.waitFor(c => c.msgs.some(m => m.type === 'sharedPack'));
  check('A 的分享快照未被 B 借提示篡改',
    Chk.last('sharedPack').pack.name === '跨设备同包' &&
    Chk.last('sharedPack').pack.theme === '设备2改的主题');

  // 取消分享权限：B 不能取消 A 的码
  B.send({ type: 'unsharePack', pidSecret: SECRET_B, code });
  await B.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'unsharePack'));
  Chk.send({ type: 'importShare', code });
  await Chk.waitFor(c => c.msgs.filter(m => m.type === 'sharedPack').length >= 2);
  check('非作者取消被拒后码仍有效', true);
  Chk.ws.close();

  // ---------- 3. 广场：跨设备带条目 id 提示更新不分裂、订阅数保留 ----------
  A.send({ type: 'plazaPublish', pidSecret: SECRET_A, author: '甲', pack: PACK });
  await A.waitFor(c => c.msgs.some(m => m.type === 'plazaPublished'));
  const pub = A.last('plazaPublished');
  const entryId = pub.id;
  check('设备1发布到广场', /^pz_[a-f0-9]{12}$/.test(entryId) && pub.packId === PACK.id);

  // B 订阅 → 热度 1
  B.send({ type: 'plazaSubscribe', id: entryId, pidSecret: SECRET_B });
  await B.waitFor(c => c.msgs.some(m => m.type === 'plazaPack' && m.subscribers === 1));
  check('朋友订阅热度 1', true);

  // 同一身份设备2订阅自己的发布（换连接但同一密钥）：不抬高热度、仍能拿到快照
  A2.send({ type: 'plazaSubscribe', id: entryId, pidSecret: SECRET_A });
  await A2.waitFor(c => c.msgs.some(m => m.type === 'plazaPack'));
  check('作者本人订阅不计热度', A2.last('plazaPack').subscribers === 1);

  // 设备2带条目 id 提示更新发布：本机副本 id 与作者 packId 不同
  A2.send({
    type: 'plazaPublish', pidSecret: SECRET_A, author: '甲', id: entryId,
    pack: { id: 'pk_copy_dev2', name: '跨设备同包·广场改', theme: '广场设备2改',
      words: ['海浪', '贝壳', '鲸鱼'] },
  });
  await A2.waitFor(c => c.msgs.some(m => m.type === 'plazaPublished'));
  const pubUpd = A2.last('plazaPublished');
  check('带条目 id 提示沿用原条目',
    pubUpd.id === entryId && pubUpd.republished === true && pubUpd.packId === PACK.id);
  A2.send({ type: 'myPlaza', pidSecret: SECRET_A });
  await A2.waitFor(c => c.msgs.some(m => m.type === 'myPlaza'));
  const myPlaza = A2.last('myPlaza').packs;
  check('广场不分裂出第二条，订阅数保留',
    myPlaza.length === 1 && myPlaza[0].id === entryId && myPlaza[0].subscribers === 1);

  // 条目 id 提示防劫持：B 不能借提示覆盖 A 的条目
  B.send({
    type: 'plazaPublish', pidSecret: SECRET_B, author: '乙', id: entryId,
    pack: { id: 'pk_hacker2', name: '攻击包2', theme: 'h', words: ['甲', '乙', '丙'] },
  });
  await B.waitFor(c => c.msgs.some(m => m.type === 'plazaPublished'));
  check('别人的条目 id 提示被忽略：B 新建了另一条', B.last('plazaPublished').id !== entryId);
  B.send({ type: 'plazaList', sort: 'hot', pidSecret: SECRET_B });
  await B.waitFor(c => c.msgs.some(m => m.type === 'plazaList'));
  const aEntry = B.last('plazaList').packs.find(p => p.id === entryId);
  check('A 的广场条目未被 B 借提示篡改',
    aEntry && aEntry.name === '跨设备同包·广场改' && aEntry.subscribers === 1);

  // B 不能下架 A 的条目
  B.send({ type: 'plazaUnpublish', pidSecret: SECRET_B, id: entryId });
  await B.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'plazaUnpublish'));
  B.send({ type: 'plazaSubscribe', id: entryId, pidSecret: SECRET_B });
  await B.waitFor(c => c.msgs.filter(m => m.type === 'plazaPack').length >= 2);
  check('非作者下架被拒后条目仍可订阅', true);

  // ---------- 4. 建房快照与分享/广场互不污染 ----------
  // 房主建房并选用该词包（快照进入房间）
  A.send({ type: 'createRoom', name: '房主甲', pidSecret: SECRET_A });
  await A.waitFor(c => c.state && c.state.phase === 'lobby');
  const roomCode = A.state.code;
  check('创建房间', !!roomCode);
  A.send({
    type: 'setWordPack',
    pack: { id: PACK.id, name: '跨设备同包', theme: '建房当时快照',
      words: ['海浪', '贝壳', '灯塔', '海鸥'] },
  });
  await A.waitFor(c => c.state && c.state.wordPack && c.state.wordPack.theme === '建房当时快照');
  const snapshotTheme = A.state.wordPack.theme;
  const snapshotWords = A.state.wordPack.words.slice();

  // 作者取消分享并下架广场：公开渠道失效……
  A2.send({ type: 'unsharePack', pidSecret: SECRET_A, code });
  await A2.waitFor(c => c.msgs.some(m => m.type === 'unshared'));
  A2.send({ type: 'plazaUnpublish', pidSecret: SECRET_A, id: entryId });
  await A2.waitFor(c => c.msgs.some(m => m.type === 'plazaUnpublished'));
  const X = client();
  await X.opened;
  X.send({ type: 'importShare', code });
  await X.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'importShare'));
  check('取消分享后码作废', /已被作者取消|无效/.test(X.msgs.filter(m => m.type === 'error').at(-1).message));
  X.send({ type: 'plazaSubscribe', id: entryId, pidSecret: SECRET_B });
  await X.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'plazaSubscribe'));
  check('下架后无法再订阅', /下架/.test(X.msgs.filter(m => m.type === 'error').at(-1).message));

  // ……但房间里的快照原样保留（不被取消分享/下架污染）
  A.send({ type: 'syncState' });
  await A.waitFor(c => c.state && c.state.wordPack && c.state.wordPack.theme === snapshotTheme);
  check('取消分享/下架不影响已建房的词包快照',
    A.state.wordPack.theme === '建房当时快照' &&
    JSON.stringify(A.state.wordPack.words) === JSON.stringify(snapshotWords));
  X.ws.close();

  // 观战者不能改房间快照（服务端双重拦截）
  const S = client();
  await S.opened;
  S.send({ type: 'spectate', name: '围观者', roomCode });
  await S.waitFor(c => c.state && c.state.spectating);
  S.send({ type: 'setWordPack', pack: { id: 'x', name: '黑', theme: '', words: ['甲', '乙', '丙'] } });
  await S.waitFor(c => c.msgs.some(m => m.type === 'error'));
  check('观战者不能修改房间词包快照', true);
  // 房主的快照未被改动
  check('房主的房间快照未被观战请求污染',
    A.state.wordPack && A.state.wordPack.theme === snapshotTheme &&
    JSON.stringify(A.state.wordPack.words) === JSON.stringify(snapshotWords));
  S.ws.close();

  A.ws.close(); A2.ws.close(); B.ws.close();
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  return failures;
}

(async () => {
  let exitCode = 0;
  try {
    failures = await main();
    if (failures !== 0) exitCode = 1;
  } catch (e) {
    console.error('词包同步冒烟测试异常:', e.stack || e.message);
    exitCode = 1;
  } finally {
    await stopServer().catch(() => {});
    for (const f of [DATA_FILE, SEASON_FILE, SHARES_FILE, PLAZA_FILE]) {
      try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ }
    }
  }
  process.exit(exitCode);
})();
