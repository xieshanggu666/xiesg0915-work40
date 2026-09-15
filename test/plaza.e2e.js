'use strict';
// 交流广场端到端测试：两名不同身份的玩家通过服务器完成
// 发布（同包更新沿用原条目）→ 列表浏览（热度排序/我发布的标记）→ 订阅（热度计数与去重）
// → 非作者下架被拒 → 作者下架后从广场消失 → 重启恢复 → 落盘。
// 自包含：require 服务器后在临时端口与临时存档上启动，跑完即停，不污染 data/。
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_FILE = path.join(os.tmpdir(), `wt-plaza-${process.pid}-${Date.now()}.json`);
const SEASON_FILE = path.join(os.tmpdir(), `wt-plaza-season-${process.pid}-${Date.now()}.json`);
const SHARES_FILE = path.join(os.tmpdir(), `wt-plaza-shares-${process.pid}-${Date.now()}.json`);
const PLAZA_FILE = path.join(os.tmpdir(), `wt-plaza-plaza-${process.pid}-${Date.now()}.json`);
process.env.WT_DATA_FILE = DATA_FILE;
process.env.WT_SEASON_FILE = SEASON_FILE;
process.env.WT_SHARES_FILE = SHARES_FILE;
process.env.WT_PLAZA_FILE = PLAZA_FILE;
const { startServer, stopServer } = require('../server');

const SECRET_A = '8'.repeat(64);
const SECRET_B = '9'.repeat(64);
const SECRET_C = '7'.repeat(64);

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

const PACK = { id: 'pk_plaza_e2e', name: '海洋奇缘', theme: '一切都与大海有关',
  words: ['海浪', '贝壳', '灯塔', '海鸥', '帆船', '珊瑚'] };
// 更新后的词包有 10 个候选词（超过预览个数 8），用于验证列表接口下发完整候选词
const PACK_UPDATED = { ...PACK, theme: '更新后的主题说明',
  words: ['海浪', '贝壳', '灯塔', '鲸鱼', '珊瑚', '海鸥', '帆船', '沙滩', '潮汐', '水母'] };
const PACK2 = { id: 'pk_plaza_e2e_2', name: '校园日常', theme: '学校生活',
  words: ['操场', '粉笔', '课桌', '铃声'] };

async function main() {
  const { port } = await startServer(0);
  BASE_URL = `ws://localhost:${port}`;

  // 广场是公开端点：不需要创建/加入任何房间，任意连接即可
  const A = client();
  await A.opened;

  // 无有效身份（非法密钥）发布被拒，带 plazaPublish 上下文
  A.send({ type: 'plazaPublish', pidSecret: 'not-a-secret', pack: PACK, author: '甲' });
  await A.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'plazaPublish'));
  check('非法身份不能发布', /身份/.test(A.msgs.filter(m => m.type === 'error').at(-1).message));

  // 词包不合法（候选词不足）被拒
  A.send({ type: 'plazaPublish', pidSecret: SECRET_A, author: '甲',
    pack: { id: 'pk_bad', name: '坏包', theme: '', words: ['甲', '乙'] } });
  await A.waitFor(c =>
    c.msgs.filter(m => m.type === 'error' && m.context === 'plazaPublish').length >= 2);
  check('候选词不足的词包不能发布', true);

  // 合法发布：拿到 pz_ 开头的广场 id
  A.send({ type: 'plazaPublish', pidSecret: SECRET_A, pack: PACK, author: '甲' });
  await A.waitFor(c => c.msgs.some(m => m.type === 'plazaPublished'));
  const pubMsg = A.msgs.filter(m => m.type === 'plazaPublished').at(-1);
  const plazaId = pubMsg.id;
  check('发布成功返回广场 id（republished=false）',
    /^pz_[a-f0-9]{12}$/.test(plazaId) && pubMsg.packId === PACK.id && pubMsg.republished === false);

  // 同一词包再次发布：沿用原 id、republished=true、快照被更新
  A.send({ type: 'plazaPublish', pidSecret: SECRET_A, pack: PACK_UPDATED, author: '甲' });
  await A.waitFor(c => c.msgs.filter(m => m.type === 'plazaPublished').length >= 2 &&
    c.msgs.filter(m => m.type === 'plazaPublished').at(-1).republished === true);
  check('同包更新沿用原 id', A.msgs.filter(m => m.type === 'plazaPublished').at(-1).id === plazaId);

  // 再发一个冷门包（无人订阅），用于验证热度排序
  A.send({ type: 'plazaPublish', pidSecret: SECRET_A, pack: PACK2, author: '甲' });
  await A.waitFor(c => c.msgs.filter(m => m.type === 'plazaPublished').length >= 3);
  const coldId = A.msgs.filter(m => m.type === 'plazaPublished').at(-1).id;

  // B 订阅热门包 → 热度 1；重复订阅不再计数
  const B = client();
  await B.opened;
  B.send({ type: 'plazaSubscribe', id: plazaId, pidSecret: SECRET_B });
  await B.waitFor(c => c.msgs.some(m => m.type === 'plazaPack'));
  const sub1 = B.msgs.filter(m => m.type === 'plazaPack').at(-1);
  check('订阅返回词包快照与最新热度',
    sub1.id === plazaId && sub1.pack.id === PACK.id &&
    sub1.pack.theme === '更新后的主题说明' && sub1.pack.words.length === 10 &&
    sub1.subscribers === 1);
  B.send({ type: 'plazaSubscribe', id: plazaId, pidSecret: SECRET_B });
  await B.waitFor(c => c.msgs.filter(m => m.type === 'plazaPack').length >= 2);
  check('同一身份重复订阅热度不重复计数',
    B.msgs.filter(m => m.type === 'plazaPack').at(-1).subscribers === 1);

  // C 也订阅 → 热度 2
  const C = client();
  await C.opened;
  C.send({ type: 'plazaSubscribe', id: plazaId, pidSecret: SECRET_C });
  await C.waitFor(c => c.msgs.some(m => m.type === 'plazaPack' && m.subscribers === 2));
  check('第二名订阅者热度 +1', true);

  // 列表：按热度排序，摘要带预览/作者/订阅数，mine 标记按身份区分
  B.send({ type: 'plazaList', sort: 'hot', pidSecret: SECRET_B });
  await B.waitFor(c => c.msgs.some(m => m.type === 'plazaList'));
  const listB = B.msgs.filter(m => m.type === 'plazaList').at(-1).packs;
  check('广场列表按热度排序（2 人订阅的在前）',
    listB.length === 2 && listB[0].id === plazaId && listB[0].subscribers === 2 &&
    listB[1].id === coldId && listB[1].subscribers === 0);
  check('摘要含完整候选词/作者/词数，不含作者身份',
    listB[0].words.length === 10 && listB[0].wordCount === 10 &&
    listB[0].words[9] === '水母' && // 第 8 个之后的候选词也随列表下发（搜索可命中）
    listB[0].author === '甲' && !('pid' in listB[0]));
  check('别人的条目 mine=false', listB.every(p => p.mine === false));
  A.send({ type: 'plazaList', sort: 'hot', pidSecret: SECRET_A });
  await A.waitFor(c => c.msgs.some(m => m.type === 'plazaList'));
  check('作者视角 mine=true', A.msgs.filter(m => m.type === 'plazaList').at(-1).packs.every(p => p.mine === true));
  // 按最新排序：后发布的冷门包在前
  A.send({ type: 'plazaList', sort: 'new', pidSecret: SECRET_A });
  await A.waitFor(c => c.msgs.filter(m => m.type === 'plazaList').length >= 2);
  check('按最新排序后发布的在前',
    A.msgs.filter(m => m.type === 'plazaList').at(-1).packs[0].id === coldId);

  // myPlaza：作者能看到自己的发布（含订阅数），无身份为空
  A.send({ type: 'myPlaza', pidSecret: SECRET_A });
  await A.waitFor(c => c.msgs.some(m => m.type === 'myPlaza'));
  const mine = A.msgs.filter(m => m.type === 'myPlaza').at(-1).packs;
  check('myPlaza 返回作者的发布（含订阅数、不含全文）',
    mine.length === 2 && mine.some(p => p.id === plazaId && p.subscribers === 2) &&
    !('pack' in mine[0]));
  A.send({ type: 'myPlaza', pidSecret: 'bad' });
  await A.waitFor(c => c.msgs.filter(m => m.type === 'myPlaza').length >= 2);
  check('无有效身份时 myPlaza 为空',
    A.msgs.filter(m => m.type === 'myPlaza').at(-1).packs.length === 0);

  // 非作者下架：被拒，条目仍在
  B.send({ type: 'plazaUnpublish', pidSecret: SECRET_B, id: plazaId });
  await B.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'plazaUnpublish'));
  check('非作者不能下架', true);
  B.send({ type: 'plazaSubscribe', id: plazaId, pidSecret: SECRET_B });
  await B.waitFor(c => c.msgs.filter(m => m.type === 'plazaPack').length >= 3);
  check('被拒下架后条目仍可订阅', true);

  // 落盘后重启：广场恢复（含订阅数）
  await sleep(500); // 等 300ms 防抖落盘
  check('广场落盘到独立文件', (() => {
    const raw = JSON.parse(fs.readFileSync(PLAZA_FILE, 'utf8'));
    const e = raw.packs[plazaId];
    return !!e && e.pid && e.packId === PACK.id &&
      e.pack.theme === '更新后的主题说明' && Object.keys(e.subs).length === 2;
  })());

  await stopServer();
  A.ws.close(); B.ws.close(); C.ws.close();
  await sleep(200);

  // 重启恢复：列表与订阅数都在
  const started2 = await startServer(0);
  BASE_URL = `ws://localhost:${started2.port}`;
  const D = client();
  await D.opened;
  D.send({ type: 'plazaList', sort: 'hot', pidSecret: SECRET_C });
  await D.waitFor(c => c.msgs.some(m => m.type === 'plazaList'));
  const listD = D.msgs.filter(m => m.type === 'plazaList').at(-1).packs;
  check('服务器重启后广场恢复（含订阅数）',
    listD.length === 2 && listD[0].id === plazaId && listD[0].subscribers === 2);

  // 作者下架：条目立即从广场消失，再订阅报错
  const A2 = client();
  await A2.opened;
  A2.send({ type: 'plazaUnpublish', pidSecret: SECRET_A, id: plazaId });
  await A2.waitFor(c => c.msgs.some(m => m.type === 'plazaUnpublished'));
  check('作者下架收到确认', A2.msgs.filter(m => m.type === 'plazaUnpublished').at(-1).id === plazaId);
  A2.send({ type: 'plazaList', sort: 'hot', pidSecret: SECRET_A });
  await A2.waitFor(c => c.msgs.some(m => m.type === 'plazaList'));
  const listAfter = A2.msgs.filter(m => m.type === 'plazaList').at(-1).packs;
  check('下架后列表不再出现该词包',
    listAfter.length === 1 && listAfter[0].id === coldId);
  D.send({ type: 'plazaSubscribe', id: plazaId, pidSecret: SECRET_C });
  await D.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'plazaSubscribe'));
  check('下架后再订阅被拒', /下架/.test(D.msgs.filter(m => m.type === 'error').at(-1).message));
  A2.send({ type: 'plazaUnpublish', pidSecret: SECRET_A, id: plazaId });
  await A2.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'plazaUnpublish'));
  check('重复下架被拒', true);

  A2.ws.close(); D.ws.close();
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  return failures;
}

(async () => {
  let exitCode = 0;
  try {
    failures = await main();
    if (failures !== 0) exitCode = 1;
  } catch (e) {
    console.error('广场冒烟测试异常:', e.stack || e.message);
    exitCode = 1;
  } finally {
    await stopServer().catch(() => {});
    for (const f of [DATA_FILE, SEASON_FILE, SHARES_FILE, PLAZA_FILE]) {
      try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ }
    }
  }
  process.exit(exitCode);
})();
