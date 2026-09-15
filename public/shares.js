'use strict';
/* 词包分享码：纯逻辑模块，浏览器（window.WTShares）与 Node（服务端/测试）共用。
   作者在「我的词包」里把本机词包发布为一串 8 位分享码，词包快照同时存在服务端；
   朋友凭码把词包导进自己的本机词包，建房时与本机词包一样在大厅选用。
   作者可随时取消分享，取消后码立即作废（已导入朋友本机的词包不受影响）。

   - 分享码：8 位大写字母数字（去除易混的 0/1/I/O），展示时按 XXXX-XXXX 分组；
   - 服务端存储 shares = { [code]: { code, pid, packId, pack:{name,theme,words}, updatedAt } }，
     pid 由作者密钥在服务端单向派生（同赛季身份），取消分享时据此校验只有作者能作废自己的码；
   - 客户端另在本机 localStorage 维护一份"我分享过的码"映射（code→packId），
     进入词包页时用服务端返回的列表对账（别的设备分享的也能看到/取消）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WTShares = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const CODE_LEN = 8;
  // 与房间码同一套易读字母表：不含 0/1/I/O，口头转告也不容易混
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
  const PID_RE = /^[a-f0-9]{64}$/;
  const MAX_SHARES_PER_OWNER = 100; // 每名作者同时有效的分享数上限，防止分享表无限膨胀
  const MAX_PACK_ID_LEN = 60;

  const MIN_WORDS = 3;
  const MAX_WORDS = 60;
  const MAX_NAME_LEN = 12;
  const MAX_THEME_LEN = 60;
  const MAX_WORD_LEN = 12;

  // 输入容错：转大写、去掉空白与分组短横（XXXX-XXXX 与手打空格都能识别）
  function normalizeCode(input) {
    return String(input || '').toUpperCase().replace(/[\s-]/g, '');
  }

  function isValidCode(code) { return CODE_RE.test(String(code || '')); }

  // 展示形式：XXXX-XXXX
  function formatCode(code) {
    const c = normalizeCode(code);
    return c.length === CODE_LEN ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
  }

  function isValidPid(pid) { return PID_RE.test(String(pid || '')); }

  // 分享快照的防御性结构清洗（与 game.sanitizeWordPack / WTPacks.validatePack 同一口径）。
  // 服务端在写入前会先用 game.sanitizeWordPack 严格校验；这里也用于从磁盘恢复时
  // 丢弃损坏条目。返回 { name, theme, words }，不合法返回 null。
  function cleanSharedPack(pack) {
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

  function emptyShares() {
    return { version: 1, shares: {} };
  }

  // 从（可能损坏/被手改的）分享档恢复：逐条校验码、作者 pid 与词包快照，
  // 任何字段不合格的条目直接丢弃（损坏单个条目不影响其他分享）。
  function normalizeShares(raw) {
    const store = emptyShares();
    const entries = raw && typeof raw === 'object' &&
      raw.shares && typeof raw.shares === 'object' ? raw.shares : null;
    if (!entries) return store;
    for (const [code, e] of Object.entries(entries)) {
      if (!isValidCode(code) || !e || typeof e !== 'object') continue;
      if (!isValidPid(e.pid)) continue;
      const packId = String(e.packId || '');
      if (!packId || packId.length > MAX_PACK_ID_LEN) continue;
      const pack = cleanSharedPack(e.pack);
      if (!pack) continue;
      store.shares[code] = {
        code, pid: e.pid, packId, pack,
        updatedAt: Math.max(0, Math.trunc(Number(e.updatedAt) || 0)),
      };
    }
    return store;
  }

  function countByOwner(store, pid) {
    let n = 0;
    for (const e of Object.values(store.shares)) if (e.pid === pid) n++;
    return n;
  }

  // 按码写入/覆盖一条分享。码已被别人占用时返回冲突（调用方应换码重试）。
  function publish(store, entry) {
    const code = normalizeCode(entry.code);
    if (!isValidCode(code)) return { error: '分享码无效' };
    if (!isValidPid(entry.pid)) return { error: '身份无效，无法分享' };
    const packId = String(entry.packId || '');
    if (!packId || packId.length > MAX_PACK_ID_LEN) return { error: '词包数据无效' };
    const pack = cleanSharedPack(entry.pack);
    if (!pack) return { error: '词包数据无效' };
    const existing = store.shares[code];
    if (existing && existing.pid !== entry.pid) return { error: '分享码冲突' };
    const updatedAt = Math.trunc(entry.now || Date.now());
    store.shares[code] = { code, pid: entry.pid, packId, pack, updatedAt };
    return { code, updatedAt, error: null };
  }

  // 作者发布/更新一个本机词包的分享：
  //  - 该作者已分享过同一 packId（同一词包再次点分享/编辑后更新）：沿用原码、覆盖快照；
  //  - 否则生成一个新码（generate 由服务端注入，基于 crypto 随机并保证不撞码），
  //    超过每人上限时拒绝。
  // 返回 { code, updated, updatedAt } 或 { error }。
  function publishForPack(store, opts) {
    const pid = String(opts.pid || '');
    const packId = String(opts.packId || '');
    const pack = cleanSharedPack(opts.pack);
    if (!isValidPid(pid)) return { error: '身份无效，无法分享' };
    if (!packId || packId.length > MAX_PACK_ID_LEN) return { error: '词包数据无效' };
    if (!pack) return { error: '词包数据无效' };
    const now = Math.trunc(opts.now || Date.now());
    for (const e of Object.values(store.shares)) {
      if (e.pid === pid && e.packId === packId) {
        const r = publish(store, { code: e.code, pid, packId, pack, now });
        if (r.error) return { error: r.error };
        return { code: e.code, updated: true, updatedAt: r.updatedAt, error: null };
      }
    }
    if (countByOwner(store, pid) >= MAX_SHARES_PER_OWNER) {
      return { error: `最多同时分享 ${MAX_SHARES_PER_OWNER} 个词包，请先取消一些分享` };
    }
    for (let i = 0; i < 10; i++) {
      const code = normalizeCode(typeof opts.generate === 'function' ? opts.generate() : '');
      if (!isValidCode(code) || store.shares[code]) continue;
      const r = publish(store, { code, pid, packId, pack, now });
      if (!r.error) return { code, updated: false, updatedAt: r.updatedAt, error: null };
    }
    return { error: '生成分享码失败，请重试' };
  }

  // 取消分享：只有作者本人（pid 一致）能作废自己的码。返回是否成功。
  function unpublish(store, code, pid) {
    const c = normalizeCode(code);
    const e = store.shares[c];
    if (!e || e.pid !== pid) return false;
    delete store.shares[c];
    return true;
  }

  function getShare(store, code) {
    const c = normalizeCode(code);
    return store.shares[c] || null;
  }

  // 作者的全部有效分享（最近更新在前），只回客户端展示所需字段（快照全文不回给作者自己）
  function listByOwner(store, pid) {
    return Object.values(store.shares)
      .filter(e => e.pid === pid)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.code.localeCompare(b.code))
      .map(e => ({ code: e.code, packId: e.packId, name: e.pack.name, updatedAt: e.updatedAt }));
  }

  // ---------- 客户端本机映射（localStorage wt_pack_shares） ----------
  // 条目：{ code, packId, name, updatedAt }。服务端列表才是权威：
  // 对账时只保留服务端仍存在的码，其他设备上新建的分享也会一并出现。

  function normalizeLocal(list) {
    const out = [];
    const seen = new Set();
    for (const m of Array.isArray(list) ? list : []) {
      const code = normalizeCode(m && m.code);
      if (!isValidCode(code) || seen.has(code)) continue;
      seen.add(code);
      out.push({
        code,
        packId: String((m && m.packId) || ''),
        name: String((m && m.name) || ''),
        updatedAt: Math.max(0, Math.trunc(Number(m && m.updatedAt) || 0)),
      });
    }
    return out;
  }

  function upsertLocal(list, mapping) {
    const code = normalizeCode(mapping && mapping.code);
    if (!isValidCode(code)) return normalizeLocal(list);
    const rest = normalizeLocal(list).filter(m => m.code !== code);
    rest.unshift({
      code,
      packId: String((mapping && mapping.packId) || ''),
      name: String((mapping && mapping.name) || ''),
      updatedAt: Math.max(0, Math.trunc(Number(mapping && mapping.updatedAt) || 0)),
    });
    return rest;
  }

  function removeLocal(list, code) {
    const c = normalizeCode(code);
    return normalizeLocal(list).filter(m => m.code !== c);
  }

  function findLocalByPackId(list, packId) {
    return normalizeLocal(list).find(m => m.packId === packId) || null;
  }

  // 用服务端返回的 myShares 列表与本机映射对账：
  // 顺序以服务端为准；名称/时间用服务端的，本机条目仅兜底。
  function reconcileLocal(local, remote) {
    const old = new Map(normalizeLocal(local).map(m => [m.code, m]));
    const out = [];
    for (const s of Array.isArray(remote) ? remote : []) {
      const code = normalizeCode(s && s.code);
      if (!isValidCode(code)) continue;
      const prev = old.get(code);
      out.push({
        code,
        packId: String((s && s.packId) || (prev && prev.packId) || ''),
        name: String((s && s.name) || (prev && prev.name) || ''),
        updatedAt: Math.max(0, Math.trunc(Number(s && s.updatedAt) || (prev && prev.updatedAt) || 0)),
      });
    }
    return out;
  }

  return {
    CODE_LEN, CODE_ALPHABET, CODE_RE, PID_RE,
    MAX_SHARES_PER_OWNER, MIN_WORDS, MAX_WORDS, MAX_NAME_LEN, MAX_THEME_LEN, MAX_WORD_LEN,
    normalizeCode, isValidCode, formatCode, isValidPid,
    cleanSharedPack, emptyShares, normalizeShares,
    publish, publishForPack, unpublish, getShare, countByOwner, listByOwner,
    normalizeLocal, upsertLocal, removeLocal, findLocalByPackId, reconcileLocal,
  };
});
