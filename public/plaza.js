'use strict';
/* 交流广场：纯逻辑模块，浏览器（window.WTPlaza）与 Node（服务端/测试）共用。
   玩家在「我的词包」把自建词包一键发布到广场；其他人按主题浏览、搜索、按热度排序，
   喜欢的词包订阅到本机（与自建/导入词包一样，建房时在大厅选用）；发布者可随时下架。

   - 广场条目：{ id, pid, packId, author, pack:{name,theme,words}, subs:{[pid]:时间戳},
     publishedAt, updatedAt }。id 形如 pz_ + 12 位十六进制（随机源由服务端注入）；
     pid 由发布者密钥在服务端单向派生（同赛季/分享身份），下架时据此校验只有作者本人能操作；
   - 热度 = 订阅人数（subs 的大小）：同一身份重复订阅不重复计数，无有效身份不计数；
   - 作者用同一 packId 再次发布：沿用原条目覆盖快照，订阅数与发布时间保留；
   - 客户端另在本机 localStorage 维护"我发布过的"映射（wt_plaza_mine，id→packId），
     进词包页时用服务端 myPlaza 列表对账（别的设备发布的也能看到/下架）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WTPlaza = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const PLAZA_ID_RE = /^pz_[a-f0-9]{12}$/;
  const PID_RE = /^[a-f0-9]{64}$/;
  const MAX_PLAZA_PER_OWNER = 50;   // 每名发布者同时在广场上的词包数上限
  const MAX_PACK_ID_LEN = 60;
  const MAX_AUTHOR_LEN = 12;
  const MAX_LIST = 200;             // 列表一次最多返回的条目（按热度截断）
  const MAX_SUBS_TRACKED = 5000;    // 单包最多记录的订阅者身份数，防止存档无限膨胀
  const PREVIEW_WORDS = 8;          // 列表里展示的候选词预览个数

  const MIN_WORDS = 3;
  const MAX_WORDS = 60;
  const MAX_NAME_LEN = 12;
  const MAX_THEME_LEN = 60;
  const MAX_WORD_LEN = 12;

  function isValidPlazaId(id) { return PLAZA_ID_RE.test(String(id || '')); }
  function isValidPid(pid) { return PID_RE.test(String(pid || '')); }

  // 词包快照的防御性清洗（与 game.sanitizeWordPack / WTShares.cleanSharedPack 同一口径）。
  // 服务端写入前已用 game.sanitizeWordPack 严格校验；这里用于从磁盘恢复时丢弃损坏条目。
  function cleanPack(pack) {
    if (!pack || typeof pack !== 'object') return null;
    const name = String(pack.name || '').trim();
    if (!name || name.length > MAX_NAME_LEN) return null;
    const theme = String(pack.theme || '').trim();
    if (theme.length > MAX_THEME_LEN) return null;
    const words = [];
    for (const w of Array.isArray(pack.words) ? pack.words : []) {
      const word = String(w == null ? '' : w).trim();
      if (!word || word.length > MAX_WORD_LEN || /\s/.test(word)) continue;
      if (!words.includes(word)) words.push(word);
    }
    if (words.length < MIN_WORDS || words.length > MAX_WORDS) return null;
    return { name, theme, words };
  }

  // 发布者昵称只作展示：裁剪长度，允许为空（列表显示"匿名"由调用方兜底）
  function cleanAuthor(author) {
    return String(author || '').trim().slice(0, MAX_AUTHOR_LEN);
  }

  function emptyPlaza() {
    return { version: 1, packs: {} };
  }

  function cleanSubs(raw) {
    const subs = {};
    if (!raw || typeof raw !== 'object') return subs;
    for (const [pid, at] of Object.entries(raw)) {
      if (!isValidPid(pid)) continue;
      if (Object.keys(subs).length >= MAX_SUBS_TRACKED) break;
      subs[pid] = Math.max(0, Math.trunc(Number(at) || 0));
    }
    return subs;
  }

  // 从（可能损坏/被手改的）广场档恢复：逐条校验 id、作者 pid、词包快照与订阅表，
  // 任何字段不合格的条目直接丢弃（损坏单个条目不影响其他发布）。
  function normalizePlaza(raw) {
    const store = emptyPlaza();
    const entries = raw && typeof raw === 'object' &&
      raw.packs && typeof raw.packs === 'object' ? raw.packs : null;
    if (!entries) return store;
    for (const [id, e] of Object.entries(entries)) {
      if (!isValidPlazaId(id) || !e || typeof e !== 'object') continue;
      if (!isValidPid(e.pid)) continue;
      const packId = String(e.packId || '');
      if (!packId || packId.length > MAX_PACK_ID_LEN) continue;
      const pack = cleanPack(e.pack);
      if (!pack) continue;
      store.packs[id] = {
        id, pid: e.pid, packId, pack,
        author: cleanAuthor(e.author),
        subs: cleanSubs(e.subs),
        publishedAt: Math.max(0, Math.trunc(Number(e.publishedAt) || 0)),
        updatedAt: Math.max(0, Math.trunc(Number(e.updatedAt) || 0)),
      };
    }
    return store;
  }

  function countByOwner(store, pid) {
    let n = 0;
    for (const e of Object.values(store.packs)) if (e.pid === pid) n++;
    return n;
  }

  function subscriberCount(entry) { return Object.keys(entry.subs).length; }

  // 发布/更新一个本机词包到广场：
  //  - 该作者已发布过同一 packId（再次点发布/编辑后更新）：沿用原条目、覆盖快照，
  //    订阅数与发布时间保留；
  //  - opts.id 指定了本人持有的有效广场条目（典型场景：另一台设备上从广场订阅了
  //    自己发布的词包，本机副本 id 是新生成的；更新发布时带上该条目 id，服务端覆盖
  //    这个条目、不改 packId，两台设备共用同一条目而不是再分裂出第二条）：
  //    条目不存在/不属于本人时忽略该提示按常规发布处理（绝不允许借提示覆盖别人的条目）；
  //  - 否则新建条目（generate 由服务端注入，基于 crypto 随机并保证不撞 id），
  //    超过每人上限时拒绝。
  // 返回 { id, packId, republished, updatedAt } 或 { error }。
  function publish(store, opts) {
    const pid = String(opts.pid || '');
    if (!isValidPid(pid)) return { error: '需要有效的本机身份才能发布' };
    const packId = String(opts.packId || '');
    if (!packId || packId.length > MAX_PACK_ID_LEN) return { error: '词包数据无效' };
    const pack = cleanPack(opts.pack);
    if (!pack) return { error: '词包数据无效' };
    const author = cleanAuthor(opts.author);
    const now = Math.trunc(opts.now || Date.now());
    // 1) 同一 (pid, packId) 已发布：沿用原条目覆盖
    for (const e of Object.values(store.packs)) {
      if (e.pid === pid && e.packId === packId) {
        e.pack = pack;
        e.author = author;
        e.updatedAt = now;
        return { id: e.id, packId: e.packId, republished: true, updatedAt: now, error: null };
      }
    }
    // 2) 调用方明确指定更新本人已有的某个条目：覆盖快照并保留该条目原 packId/订阅数
    const hinted = String(opts.id || '');
    if (isValidPlazaId(hinted)) {
      const target = store.packs[hinted];
      if (target && target.pid === pid) {
        target.pack = pack;
        target.author = author;
        target.updatedAt = now;
        return { id: target.id, packId: target.packId, republished: true, updatedAt: now, error: null };
      }
    }
    // 3) 全新发布
    if (countByOwner(store, pid) >= MAX_PLAZA_PER_OWNER) {
      return { error: `最多同时在广场发布 ${MAX_PLAZA_PER_OWNER} 个词包，请先下架一些` };
    }
    for (let i = 0; i < 10; i++) {
      const id = String(typeof opts.generate === 'function' ? opts.generate() : '');
      if (!isValidPlazaId(id) || store.packs[id]) continue;
      store.packs[id] = {
        id, pid, packId, author, pack,
        subs: {}, publishedAt: now, updatedAt: now,
      };
      return { id, packId, republished: false, updatedAt: now, error: null };
    }
    return { error: '发布失败，请重试' };
  }

  // 下架：只有发布者本人（pid 一致）能撤下自己的词包。返回是否成功。
  // 已订阅到别人本机的词包是独立副本，不受影响。
  function unpublish(store, id, pid) {
    const e = store.packs[String(id || '')];
    if (!e || e.pid !== pid) return false;
    delete store.packs[e.id];
    return true;
  }

  function getEntry(store, id) {
    return store.packs[String(id || '')] || null;
  }

  // 订阅：返回词包快照供客户端存进本机词包；同一身份只计一次热度，
  // 无有效身份的订阅不计数（仍能拿到词包）；作者本人订阅自己的发布不计数
  // （发布即代表拥有，自己订阅不应抬高热度，也不影响任何人拿到词包）。
  // 返回 { id, packId, pack, subscribers, counted } 或 { error }。
  function subscribe(store, id, pid, now) {
    const e = store.packs[String(id || '')];
    if (!e) return { error: '这个词包不存在或已被作者下架' };
    const base = { id: e.id, packId: e.packId, pack: e.pack, error: null };
    if (!isValidPid(pid) || pid === e.pid || pid in e.subs) {
      return { ...base, subscribers: subscriberCount(e), counted: false };
    }
    if (subscriberCount(e) >= MAX_SUBS_TRACKED) {
      return { ...base, subscribers: subscriberCount(e), counted: false };
    }
    e.subs[pid] = Math.trunc(now || Date.now());
    return { ...base, subscribers: subscriberCount(e), counted: true };
  }

  // ---------- 浏览：排序 / 搜索 / 主题筛选（服务端列表与客户端重排共用） ----------

  // hot（默认）：订阅数优先，同热度按最近更新；new：最近发布/更新优先。名称做稳定次级依据。
  function sortPacks(list, sort) {
    const arr = Array.isArray(list) ? list.slice() : [];
    const byName = (a, b) =>
      String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id));
    if (sort === 'new') {
      arr.sort((a, b) =>
        (b.updatedAt - a.updatedAt) || (b.subscribers - a.subscribers) || byName(a, b));
    } else {
      arr.sort((a, b) =>
        (b.subscribers - a.subscribers) || (b.updatedAt - a.updatedAt) || byName(a, b));
    }
    return arr;
  }

  // 搜索：名称 / 主题 / 发布者 / 全部候选词，大小写不敏感；theme 精确匹配某个主题。
  function filterPacks(list, opts = {}) {
    const keyword = String(opts.keyword || '').trim().toLowerCase();
    const theme = String(opts.theme || '');
    return (Array.isArray(list) ? list : []).filter(p => {
      if (theme && String(p.theme || '') !== theme) return false;
      if (!keyword) return true;
      const hay = [p.name, p.theme, p.author, ...(p.words || p.preview || [])]
        .join('\n').toLowerCase();
      return hay.includes(keyword);
    });
  }

  // 广场里出现过的全部主题（供筛选下拉）：按累计订阅数排，热门主题在前
  function themesOf(list) {
    const seen = new Map();
    for (const p of Array.isArray(list) ? list : []) {
      const t = String(p.theme || '').trim();
      if (!t) continue;
      seen.set(t, (seen.get(t) || 0) + (Number(p.subscribers) || 0));
    }
    return [...seen.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t]) => t);
  }

  // 广场列表（公开只读）：回展示摘要与完整候选词——搜索要覆盖全部候选词，
  // 且词包内容本就是公开的（任何人订阅即可拿到全文）。预览展示由客户端按
  // PREVIEW_WORDS 截取。myPid 用于标出"我发布的"（客户端据此显示下架入口）。
  // 按热度截断到 MAX_LIST。
  function summaries(store, opts = {}) {
    const myPid = isValidPid(opts.myPid) ? opts.myPid : null;
    const list = Object.values(store.packs).map(e => ({
      id: e.id,
      name: e.pack.name,
      theme: e.pack.theme,
      wordCount: e.pack.words.length,
      words: e.pack.words,
      author: e.author,
      subscribers: subscriberCount(e),
      publishedAt: e.publishedAt,
      updatedAt: e.updatedAt,
      mine: myPid !== null && e.pid === myPid,
    }));
    return sortPacks(list, opts.sort).slice(0, MAX_LIST);
  }

  // 发布者的全部广场条目（最近更新在前），供"我的发布"对账与下架
  function listByOwner(store, pid) {
    return Object.values(store.packs)
      .filter(e => e.pid === pid)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .map(e => ({
        id: e.id, packId: e.packId, name: e.pack.name,
        subscribers: subscriberCount(e), updatedAt: e.updatedAt,
      }));
  }

  // ---------- 客户端本机映射（localStorage wt_plaza_mine） ----------
  // 条目：{ id, packId, name, updatedAt }。服务端 myPlaza 列表才是权威：
  // 对账时只保留服务端仍存在的发布，其他设备上发布的也会一并出现。

  function normalizeLocal(list) {
    const out = [];
    const seen = new Set();
    for (const m of Array.isArray(list) ? list : []) {
      const id = String(m && m.id || '');
      if (!isValidPlazaId(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        packId: String((m && m.packId) || ''),
        name: String((m && m.name) || ''),
        updatedAt: Math.max(0, Math.trunc(Number(m && m.updatedAt) || 0)),
      });
    }
    return out;
  }

  function upsertLocal(list, mapping) {
    const id = String(mapping && mapping.id || '');
    if (!isValidPlazaId(id)) return normalizeLocal(list);
    const rest = normalizeLocal(list).filter(m => m.id !== id);
    rest.unshift({
      id,
      packId: String((mapping && mapping.packId) || ''),
      name: String((mapping && mapping.name) || ''),
      updatedAt: Math.max(0, Math.trunc(Number(mapping && mapping.updatedAt) || 0)),
    });
    return rest;
  }

  function removeLocal(list, id) {
    const target = String(id || '');
    return normalizeLocal(list).filter(m => m.id !== target);
  }

  function findLocalByPackId(list, packId) {
    return normalizeLocal(list).find(m => m.packId === packId) || null;
  }

  // 用服务端返回的 myPlaza 列表与本机映射对账：
  // 顺序以服务端为准；名称/时间用服务端的，本机条目仅兜底。
  function reconcileLocal(local, remote) {
    const old = new Map(normalizeLocal(local).map(m => [m.id, m]));
    const out = [];
    for (const s of Array.isArray(remote) ? remote : []) {
      const id = String(s && s.id || '');
      if (!isValidPlazaId(id)) continue;
      const prev = old.get(id);
      out.push({
        id,
        packId: String((s && s.packId) || (prev && prev.packId) || ''),
        name: String((s && s.name) || (prev && prev.name) || ''),
        updatedAt: Math.max(0, Math.trunc(Number(s && s.updatedAt) || (prev && prev.updatedAt) || 0)),
      });
    }
    return out;
  }

  return {
    PLAZA_ID_RE, PID_RE, MAX_PLAZA_PER_OWNER, MAX_LIST, MAX_SUBS_TRACKED, PREVIEW_WORDS,
    MIN_WORDS, MAX_WORDS, MAX_NAME_LEN, MAX_THEME_LEN, MAX_WORD_LEN,
    isValidPlazaId, isValidPid, cleanPack, cleanAuthor,
    emptyPlaza, normalizePlaza, countByOwner, subscriberCount,
    publish, unpublish, getEntry, subscribe,
    sortPacks, filterPacks, themesOf, summaries, listByOwner,
    normalizeLocal, upsertLocal, removeLocal, findLocalByPackId, reconcileLocal,
  };
});
