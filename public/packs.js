'use strict';
/* 主题词包：纯逻辑模块，浏览器（window.WTPacks）与 Node（测试）共用。
   词包 = 名称 + 主题说明 + 起始词候选列表，由玩家在首页「我的词包」中维护，
   数据只保存在本浏览器（localStorage）；房主在大厅选用后，词包内容作为快照
   发给服务器进入房间状态，所有玩家开局前都能看到主题与候选词。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WTPacks = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const MAX_PACKS = 20;      // 本机最多保存的词包数
  const MIN_WORDS = 3;       // 至少 3 个候选词（默认开局抽 3 个起始词）
  const MAX_WORDS = 60;
  const MAX_NAME_LEN = 12;
  const MAX_THEME_LEN = 60;
  const MAX_WORD_LEN = 12;   // 与对局接词的长度上限一致

  // 把文本框内容解析成候选词列表：按换行/逗号/顿号/分号/空白切分，
  // 去空白、去重（保留首次出现的顺序）。
  function parseWords(text) {
    const out = [];
    for (const raw of String(text || '').split(/[\n,，、;；\s]+/)) {
      const w = raw.trim();
      if (w && !out.includes(w)) out.push(w);
    }
    return out;
  }

  // 校验词包输入。input: { name, theme, wordsText }（wordsText 为文本框原文）
  // 或 { name, theme, words }（已是数组）。返回 { errors, pack }：
  // errors 以字段为索引，为空对象表示通过；pack 为清洗后的 { name, theme, words }。
  function validatePack(input) {
    const errors = {};
    const name = String(input.name || '').trim();
    if (!name) errors.name = '请填写词包名称';
    else if (name.length > MAX_NAME_LEN) errors.name = `名称最多 ${MAX_NAME_LEN} 个字`;
    const theme = String(input.theme || '').trim();
    if (theme.length > MAX_THEME_LEN) errors.theme = `主题说明最多 ${MAX_THEME_LEN} 个字`;
    const words = Array.isArray(input.words)
      ? parseWords(input.words.join('\n'))
      : parseWords(input.wordsText);
    const tooLong = words.find(w => w.length > MAX_WORD_LEN);
    if (tooLong) errors.words = `「${tooLong}」超过 ${MAX_WORD_LEN} 个字`;
    else if (words.length < MIN_WORDS) errors.words = `至少需要 ${MIN_WORDS} 个候选词（当前 ${words.length} 个）`;
    else if (words.length > MAX_WORDS) errors.words = `最多 ${MAX_WORDS} 个候选词`;
    return { errors, pack: { name, theme, words } };
  }

  function makeId() {
    return `pk_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e8).toString(36)}`;
  }

  // 新增或更新（按 id 匹配），返回 { packs, error }。
  // 新建时超出 MAX_PACKS 拒绝；更新已存在的 id 不受数量限制。
  function upsert(packs, pack) {
    const list = Array.isArray(packs) ? packs.slice() : [];
    if (!pack || !pack.id) return { packs: list, error: '词包数据无效' };
    const idx = list.findIndex(p => p.id === pack.id);
    if (idx >= 0) {
      list[idx] = pack;
      return { packs: list, error: null };
    }
    if (list.length >= MAX_PACKS) return { packs: list, error: `最多保存 ${MAX_PACKS} 个词包，先删除一些再新建` };
    return { packs: [pack, ...list], error: null };
  }

  function remove(packs, id) {
    return (Array.isArray(packs) ? packs : []).filter(p => p.id !== id);
  }

  function find(packs, id) {
    return (Array.isArray(packs) ? packs : []).find(p => p.id === id) || null;
  }

  // 本机词包可能带来源标记（importedFrom=分享码作者原始 packId；plazaId=广场条目 id）。
  // 编辑器保存时只产出 {name,theme,words}，直接覆盖会把来源标记一起抹掉——抹掉后
  // 同一来源可以被再次导入/订阅成重复副本。编辑已有词包时用这个函数把来源标记保留下来；
  // 新建词包（原列表里没有）不继承任何标记。
  function withPreservedProvenance(packs, next) {
    const old = find(packs, next && next.id);
    if (!old) return next;
    const merged = { ...next };
    if (old.importedFrom) merged.importedFrom = old.importedFrom;
    if (old.importedAt) merged.importedAt = old.importedAt;
    if (old.plazaId) merged.plazaId = old.plazaId;
    if (old.subscribedAt) merged.subscribedAt = old.subscribedAt;
    return merged;
  }

  // 跨设备认领（adopt）：本机有一份「从分享码导入 / 从广场订阅」来的副本
  // （带 importedFrom / plazaId 来源标记），对账发现这个来源其实就是当前身份在
  // 另一台设备上发布的——把本机副本的 id 改写为来源的稳定 id，让它与「我的分享/发布」
  // 映射重新对上：徽标、沿用原码/原条目更新、取消/下架都合流，不再被当成两份东西。
  //
  // kind='share'：ref={matchId=作者原始 packId}，按 importedFrom 匹配，id 改写为 packId；
  // kind='plaza'：ref={matchId=广场条目 id, targetId=作者原始 packId}，
  //               按 plazaId 匹配，id 改写为 packId（广场徽标按 packId 对账）。
  // 幂等：已认领过（本机 id 已是 targetId）返回 changed=false。
  // 安全：若本机已存在 id===targetId 的另一份词包（极端 id 撞车/真身与副本并存），
  //       不覆盖、不改写。
  // 返回 { packs, adoptedId, changed }：changed 仅在真正发生 id 改写时为真。
  function adoptRemotePack(packs, kind, ref) {
    const list = Array.isArray(packs) ? packs.slice() : [];
    const matchId = String((ref && ref.matchId) || '');
    const targetId = String((ref && ref.targetId) || matchId);
    if (!matchId || !targetId) return { packs: list, adoptedId: null, changed: false };
    const existing = list.find(p => p.id === targetId);
    if (existing) return { packs: list, adoptedId: targetId, changed: false };
    const field = kind === 'plaza' ? 'plazaId' : 'importedFrom';
    const idx = list.findIndex(p => p[field] === matchId);
    if (idx < 0) return { packs: list, adoptedId: null, changed: false };
    const adopted = { ...list[idx], id: targetId };
    if (kind === 'share') {
      // 认领回自己的分享：它不再是「导入副本」，清掉导入标记，避免对自己重复导入
      delete adopted.importedFrom;
      delete adopted.importedAt;
    } else {
      // 认领回自己的广场发布：本机副本即发布真身，订阅标记随之退场
      delete adopted.plazaId;
      delete adopted.subscribedAt;
    }
    list[idx] = adopted;
    return { packs: list, adoptedId: targetId, changed: true };
  }

  return {
    MAX_PACKS, MIN_WORDS, MAX_WORDS, MAX_NAME_LEN, MAX_THEME_LEN, MAX_WORD_LEN,
    parseWords, validatePack, makeId, upsert, remove, find,
    withPreservedProvenance, adoptRemotePack,
  };
});
