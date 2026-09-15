'use strict';
// 词包分享码端到端测试：两名不同身份的玩家通过服务器完成
// 分享（同包更新沿用原码）→ 凭码导入 → 非作者取消被拒 → 作者取消后码作废 → 重启恢复/清理 → 落盘。
// 自包含：require 服务器后在临时端口与临时存档上启动，跑完即停，不污染 data/。
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_FILE = path.join(os.tmpdir(), `wt-share-${process.pid}-${Date.now()}.json`);
const SEASON_FILE = path.join(os.tmpdir(), `wt-share-season-${process.pid}-${Date.now()}.json`);
const SHARES_FILE = path.join(os.tmpdir(), `wt-share-shares-${process.pid}-${Date.now()}.json`);
process.env.WT_DATA_FILE = DATA_FILE;
process.env.WT_SEASON_FILE = SEASON_FILE;
process.env.WT_SHARES_FILE = SHARES_FILE;
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
  c.opened = new Promise(res => c.ws.on('open', res));
  return c;
}

const PACK = { id: 'pk_share_e2e', name: '海洋奇缘', theme: '一切都与大海有关',
  words: ['海浪', '贝壳', '灯塔', '海鸥', '帆船', '珊瑚'] };
const PACK_UPDATED = { ...PACK, theme: '更新后的主题说明', words: ['海浪', '贝壳', '灯塔', '鲸鱼'] };

async function main() {
  const { port } = await startServer(0);
  BASE_URL = `ws://localhost:${port}`;

  // 分享是公开端点：不需要创建/加入任何房间，任意连接即可
  const A = client();
  await A.opened;

  // 无有效身份（非法密钥）分享被拒，带 sharePack 上下文
  A.send({ type: 'sharePack', pidSecret: 'not-a-secret', pack: PACK });
  await A.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'sharePack'));
  check('非法身份不能分享', /身份/.test(A.msgs.filter(m => m.type === 'error').at(-1).message));

  // 词包不合法（候选词不足）被拒
  A.send({ type: 'sharePack', pidSecret: SECRET_A,
    pack: { id: 'pk_bad', name: '坏包', theme: '', words: ['甲', '乙'] } });
  await A.waitFor(c => {
    const es = c.msgs.filter(m => m.type === 'error' && m.context === 'sharePack');
    return es.length >= 2;
  });
  check('候选词不足的词包不能分享', true);

  // 合法分享：收到 8 位码
  A.send({ type: 'sharePack', pidSecret: SECRET_A, pack: PACK });
  await A.waitFor(c => c.msgs.some(m => m.type === 'shared'));
  const sharedMsg = A.msgs.filter(m => m.type === 'shared').at(-1);
  const code = sharedMsg.code;
  check('分享成功返回 8 位合法码（republished=false）',
    /^[A-HJ-NP-Z2-9]{8}$/.test(code) && sharedMsg.packId === PACK.id && sharedMsg.republished === false);

  // 同一词包再次分享：沿用原码、republished=true、快照被更新
  A.send({ type: 'sharePack', pidSecret: SECRET_A, pack: PACK_UPDATED });
  await A.waitFor(c => c.msgs.filter(m => m.type === 'shared').length >= 2 &&
    c.msgs.filter(m => m.type === 'shared').at(-1).republished === true);
  check('同包更新沿用原码', A.msgs.filter(m => m.type === 'shared').at(-1).code === code);

  // myShares：作者能看到自己的分享
  A.send({ type: 'myShares', pidSecret: SECRET_A });
  await A.waitFor(c => c.msgs.some(m => m.type === 'myShares'));
  const myList = A.msgs.filter(m => m.type === 'myShares').at(-1).shares;
  check('myShares 返回作者的分享（码、词包名、不含全文）',
    myList.length === 1 && myList[0].code === code && myList[0].name === PACK.name &&
    !('words' in myList[0]));
  // 非法/缺失身份的 myShares 返回空列表而不是报错
  A.send({ type: 'myShares', pidSecret: 'bad' });
  await A.waitFor(c => c.msgs.filter(m => m.type === 'myShares').length >= 2);
  check('无有效身份时 myShares 为空',
    A.msgs.filter(m => m.type === 'myShares').at(-1).shares.length === 0);

  // 朋友 B 凭码导入：拿到的是最新快照
  const B = client();
  await B.opened;
  // 坏码（格式不对）就地报错
  B.send({ type: 'importShare', code: 'ZZ' });
  await B.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'importShare'));
  check('格式错误的分享码被拒', /8 位/.test(B.msgs.filter(m => m.type === 'error').at(-1).message));
  // 不存在/已取消的码
  B.send({ type: 'importShare', code: 'ZZZZ9999' });
  await B.waitFor(c => c.msgs.filter(m => m.type === 'error' && m.context === 'importShare').length >= 2);
  check('不存在的分享码被拒', /已被作者取消|无效/.test(B.msgs.filter(m => m.type === 'error').at(-1).message));
  // 大小写、短横与空格容错
  const pretty = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
  B.send({ type: 'importShare', code: pretty });
  await B.waitFor(c => c.msgs.some(m => m.type === 'sharedPack'));
  const imp = B.msgs.filter(m => m.type === 'sharedPack').at(-1);
  check('凭码（小写带短横）导入拿到更新后的快照',
    imp.code === code && imp.pack.theme === '更新后的主题说明' &&
    imp.pack.words.length === 4 && imp.pack.id === PACK.id);

  // 非作者取消：被拒，码仍然有效
  B.send({ type: 'unsharePack', pidSecret: SECRET_B, code });
  await B.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'unsharePack'));
  check('非作者不能取消分享', true);
  B.send({ type: 'importShare', code });
  await B.waitFor(c => c.msgs.filter(m => m.type === 'sharedPack').length >= 2);
  check('被拒取消后码仍可导入', B.msgs.filter(m => m.type === 'sharedPack').at(-1).pack.id === PACK.id);

  // 无身份取消同样被拒
  A.send({ type: 'unsharePack', pidSecret: 'bad', code });
  await A.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'unsharePack'));
  check('无有效身份不能取消分享', true);

  // 落盘后重启：分享恢复，取消后作废
  await sleep(500); // 等 300ms 防抖落盘
  check('分享落盘到独立文件', (() => {
    const raw = JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8'));
    const e = raw.shares[code];
    return !!e && e.pid && e.packId === PACK.id && e.pack.theme === '更新后的主题说明';
  })());

  await stopServer();
  A.ws.close(); B.ws.close();
  await sleep(200);

  // 重启恢复：新连接凭同一码仍能导入
  const started2 = await startServer(0);
  BASE_URL = `ws://localhost:${started2.port}`;
  const B2 = client();
  await B2.opened;
  B2.send({ type: 'importShare', code });
  await B2.waitFor(c => c.msgs.some(m => m.type === 'sharedPack'));
  check('服务器重启后分享码仍有效', B2.msgs.filter(m => m.type === 'sharedPack').at(-1).pack.id === PACK.id);

  // 作者取消：码立即作废
  const A2 = client();
  await A2.opened;
  A2.send({ type: 'unsharePack', pidSecret: SECRET_A, code: code.toLowerCase() });
  await A2.waitFor(c => c.msgs.some(m => m.type === 'unshared'));
  check('作者取消收到确认（码大小写容错）', A2.msgs.filter(m => m.type === 'unshared').at(-1).code === code);
  A2.send({ type: 'myShares', pidSecret: SECRET_A });
  await A2.waitFor(c => {
    const lists = c.msgs.filter(m => m.type === 'myShares');
    return lists.length && lists.at(-1).shares.length === 0;
  });
  check('取消后 myShares 不再包含该码', true);
  B2.send({ type: 'importShare', code });
  await B2.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'importShare'));
  check('取消后朋友凭旧码导入被拒', /已被作者取消/.test(B2.msgs.filter(m => m.type === 'error').at(-1).message));
  // 重复取消：已不存在，拒绝
  A2.send({ type: 'unsharePack', pidSecret: SECRET_A, code });
  await A2.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'unsharePack'));
  check('重复取消被拒', true);

  A2.ws.close(); B2.ws.close();
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  return failures;
}

(async () => {
  let exitCode = 0;
  try {
    failures = await main();
    if (failures !== 0) exitCode = 1;
  } catch (e) {
    console.error('分享冒烟测试异常:', e.stack || e.message);
    exitCode = 1;
  } finally {
    await stopServer().catch(() => {});
    for (const f of [DATA_FILE, SEASON_FILE, SHARES_FILE]) {
      try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ }
    }
  }
  process.exit(exitCode);
})();
