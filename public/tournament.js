'use strict';
/* 跨房间赛事 UI（浏览器）。依赖 client.js 暴露的全局 WTMessages（同一条 WS、本机密钥、
   showScreen/toast）。负责三块屏幕：赛事大厅列表、创建表单、赛事详情（报名/对阵表/进入对阵）。
   进入对阵房间后由 client.js 的既有房间流程接管（joined→state→大厅/对局/结算）。
   赛事是跨房间对象：详情打开时发 tournamentWatch 订阅实时推送，离开即由服务端在连接关闭/
   被新订阅取代时自然收敛（每打开一次详情都重新 watch，服务端按 pid 去重通知）。 */
(() => {
  const $ = (id) => document.getElementById(id);
  const M = () => globalThis.WTMessages;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let list = [];
  let detail = null;       // 当前打开的赛事完整视图
  let detailId = null;
  let myPid = null;

  const send = (m) => M().send(m);
  const secret = () => M().secret;
  const go = (name) => M().showScreen(name);

  const PHASE_LABEL = {
    registering: '报名中', running: '对阵中', finished: '已完赛', cancelled: '已取消',
  };
  const MATCH_STATUS_LABEL = {
    pending: '等待对阵', ready: '可进入', live: '对局中',
    finished: '已结束', bye: '轮空', void: '已作废',
  };
  const RESULT_LABEL = {
    played: '对局决胜', bye: '轮空晋级', forfeit: '对手弃权', walkover: '对手超时未到',
    noshow: '双方未到·种子晋级', tiebreak: '连平·种子靠前', tie: '平局',
  };
  const ROUND_NAME = (r, total) => {
    const left = total - r + 1;
    if (left === 1) return '决赛';
    if (left === 2) return '半决赛';
    if (left === 3) return '四分之一决赛';
    return `第 ${r} 轮`;
  };

  // ---------- 列表 ----------

  function openList() {
    go('tournaments');
    refreshList();
  }

  function refreshList() {
    send({ type: 'tournamentList', pidSecret: secret() });
  }

  function onList(msg) {
    list = Array.isArray(msg.tournaments) ? msg.tournaments : [];
    myPid = msg.myPid || null;
    renderList();
  }

  function fmtDeadline(ts) {
    if (!ts) return '房主手动开赛';
    const left = ts - Date.now();
    if (left <= 0) return '即将开赛';
    const m = Math.round(left / 60000);
    if (m < 60) return `${m} 分钟后截止`;
    return `${Math.round(m / 60)} 小时后截止`;
  }

  function renderList() {
    const ul = $('tour-list');
    if (!ul) return;
    $('tour-empty').classList.toggle('hidden', list.length > 0);
    ul.innerHTML = list.map(t => {
      const mine = t.myEid ? '<span class="badge shield">已报名</span>' : '';
      const champ = t.phase === 'finished' && t.championName
        ? ` · 冠军 <b>${esc(t.championName)}</b>` : '';
      const sub = t.phase === 'registering'
        ? `${t.entrants} 人报名 · ${fmtDeadline(t.registerDeadline)}`
        : `${t.entrants} 人${champ}`;
      return `<li>
        <div>
          <div><b>${esc(t.name)}</b> <span class="badge">${PHASE_LABEL[t.phase] || t.phase}</span> ${mine}</div>
          <div class="h-sub">房主 ${esc(t.hostName)} · ${sub}</div>
        </div>
        <button class="link" data-tour="${esc(t.id)}">查看</button>
      </li>`;
    }).join('');
    ul.querySelectorAll('[data-tour]').forEach(btn => {
      btn.onclick = () => openDetail(btn.dataset.tour);
    });
  }

  // ---------- 创建 ----------

  function openCreate() {
    $('err-tour-name').textContent = '';
    $('err-tour-general').textContent = '';
    $('tour-name').value = '';
    go('tour-create');
  }

  function submitCreate() {
    const name = $('tour-name').value.trim();
    if (!name) { $('err-tour-name').textContent = '请填写赛事名称'; return; }
    const int = (id) => {
      const n = parseInt($(id).value, 10);
      return Number.isFinite(n) ? n : undefined;
    };
    send({
      type: 'tournamentCreate',
      name: M().displayName || '房主',
      tournamentName: name,
      registerMs: Number($('tour-deadline').value) || 0,
      pidSecret: secret(),
      rules: {
        turnSeconds: int('tour-rule-seconds'),
        apPerTurn: int('tour-rule-ap'),
        rounds: int('tour-rule-rounds'),
        startWordCount: int('tour-rule-words'),
        challengeTokens: int('tour-rule-tokens'),
      },
    });
  }

  function onCreated(t) {
    M().toast('赛事已创建');
    openDetail(t.id);
  }

  // ---------- 详情 ----------

  function openDetail(id) {
    detailId = id;
    detail = null;
    $('err-tour-detail').textContent = '';
    go('tour-detail');
    // 订阅实时推送（服务端返回完整视图）
    send({ type: 'tournamentWatch', tournamentId: id, pidSecret: secret() });
  }

  function onTournament(t) {
    if (!t || t.id !== detailId) return;
    detail = t;
    renderDetail();
  }

  function onError(message) {
    const el = $('err-tour-detail');
    if (el && detailId) el.textContent = message;
    else toast(message);
  }

  // 写操作确认回调：创建由 onCreated 单独接管；其余详情操作都有 tournament 推送刷新，
  // 列表页发起的操作（如列表里没有写按钮，此处为兜底）重拉一次列表。
  function afterWrite(msg) {
    if (!detailId) refreshList();
  }

  function myEntrant() {
    return detail && detail.myEid
      ? detail.entrants.find(e => e.eid === detail.myEid) : null;
  }

  function renderDetail() {
    const t = detail;
    if (!t) return;
    $('tour-detail-title').textContent = t.name;
    const phaseBadge = `<span class="badge">${PHASE_LABEL[t.phase] || t.phase}</span>`;
    const dl = t.phase === 'registering' ? ` · ${fmtDeadline(t.registerDeadline)}` : '';
    $('tour-detail-meta').innerHTML =
      `房主 ${esc(t.hostName)} ${phaseBadge} · ${t.entrants.length} 人报名` +
      (t.size ? ` · ${t.size} 签` : '') + dl;
    $('tour-entrant-count').textContent = t.entrants.length;

    // 报名者
    $('tour-entrants').innerHTML = t.entrants
      .slice().sort((a, b) => (a.seed || 999) - (b.seed || 999))
      .map(e => {
        const seed = e.seed ? `<span class="h-sub">#${e.seed}</span> ` : '';
        const statusTag = e.status === 'champion' ? '<span class="badge win">冠军</span>'
          : e.status === 'forfeit' ? '<span class="badge lose">弃权</span>'
            : e.status === 'noshow' ? '<span class="badge lose">未到</span>'
              : e.status === 'eliminated' ? '<span class="badge lose">淘汰</span>'
                : e.status === 'alive' ? '<span class="badge">晋级</span>' : '';
        return `<li>${seed}${esc(e.name)} ${statusTag}</li>`;
      }).join('');

    renderActions(t);
    renderBracket(t);
    renderStandings(t);
  }

  function renderActions(t) {
    const box = $('tour-actions');
    const me = myEntrant();
    const isHost = myPid === t.hostPid;
    const btns = [];

    if (t.phase === 'registering') {
      if (!me) {
        btns.push(primary('btn-tour-register', '我要报名'));
      } else {
        btns.push(plain('btn-tour-withdraw', '退出报名'));
      }
      if (isHost) {
        btns.push(primary('btn-tour-start', '提前开赛'));
        btns.push(danger('btn-tour-cancel', '取消赛事'));
      }
    } else if (t.phase === 'running') {
      // 我有当前对阵：可进入 / 弃权
      if (me && t.myMatchId) {
        if (t.myMatchStatus === 'ready' || t.myMatchStatus === 'live') {
          btns.push(primary('btn-tour-enter', t.myMatchStatus === 'live' ? '回到对局房间' : '进入我的对阵'));
          if (t.myMatchStatus === 'ready') btns.push(danger('btn-tour-forfeit', '本轮弃权'));
        }
      }
      if (isHost) btns.push(plain('btn-tour-rematch-hint', '异常重赛在对阵表中操作'));
    } else if (t.phase === 'finished') {
      if (isHost) btns.push(plain('btn-tour-rematch-final', '对决赛安排异常重赛'));
    }
    box.innerHTML = btns.join('');
    bind('btn-tour-register', () => send({
      type: 'tournamentRegister', tournamentId: t.id,
      name: (M().displayName || '玩家'), pidSecret: secret() }));
    bind('btn-tour-withdraw', () => send({
      type: 'tournamentWithdraw', tournamentId: t.id, pidSecret: secret() }));
    bind('btn-tour-start', () => send({
      type: 'tournamentStart', tournamentId: t.id, pidSecret: secret() }));
    bind('btn-tour-cancel', () => {
      if (confirm('确定取消这场赛事吗？')) send({
        type: 'tournamentCancel', tournamentId: t.id, pidSecret: secret() });
    });
    bind('btn-tour-enter', () => send({
      type: 'tournamentEnter', tournamentId: t.id, pidSecret: secret() }));
    bind('btn-tour-forfeit', () => {
      if (confirm('确定本轮弃权吗？对手将直接晋级。')) send({
        type: 'tournamentForfeit', tournamentId: t.id, pidSecret: secret() });
    });
    bind('btn-tour-rematch-final', () => {
      if (confirm('对决赛安排异常重赛？将回滚冠军并重新等待双方进入。')) send({
        type: 'tournamentRematch', tournamentId: t.id,
        matchId: finalMatchId(t), pidSecret: secret() });
    });
  }

  function finalMatchId(t) {
    const rounds = t.bracket || [];
    const last = rounds[rounds.length - 1] || [];
    const finished = last.find(m => m.status === 'finished' || m.status === 'void');
    return finished ? finished.id : (last[0] && last[0].id);
  }

  function bind(id, fn) {
    const el = $(id);
    if (el) el.onclick = fn;
  }
  const primary = (id, label) => `<button id="${id}" class="primary">${label}</button>`;
  const plain = (id, label) => `<button id="${id}">${label}</button>`;
  const danger = (id, label) => `<button id="${id}" class="danger">${label}</button>`;

  // ---------- 对阵表 ----------

  function playerCell(t, m, side) {
    const eid = side === 'A' ? m.eidA : m.eidB;
    const name = side === 'A' ? m.nameA : m.nameB;
    const seed = side === 'A' ? m.seedA : m.seedB;
    if (!eid) return '<span class="h-sub">待定</span>';
    const won = m.winnerEid === eid;
    const cls = won ? 'tour-winner' : '';
    const tag = seed ? `<span class="h-sub">${seed}.</span> ` : '';
    return `<span class="${cls}">${tag}${esc(name || '?')}</span>`;
  }

  function renderBracket(t) {
    const root = $('tour-bracket');
    if (!t.rounds) { root.innerHTML = '<p class="hint">开赛后生成对阵表。</p>'; return; }
    root.innerHTML = (t.bracket || []).map((rounds, ri) => {
      const r = ri + 1;
      const cards = rounds.map(m => matchCard(t, m)).join('');
      return `<div class="tour-round">
        <div class="hint">${ROUND_NAME(r, t.rounds)}</div>
        ${cards}
      </div>`;
    }).join('');
    // 房主的异常重赛按钮（下一轮公示前可用，服务端最终把关）
    root.querySelectorAll('[data-rematch]').forEach(b => {
      b.onclick = () => {
        if (confirm('安排这场异常重赛？旧对局作废（赛季战绩保留），双方重新进入。')) send({
          type: 'tournamentRematch', tournamentId: t.id,
          matchId: b.dataset.rematch, pidSecret: secret() });
      };
    });
  }

  function matchCard(t, m) {
    const status = `<span class="badge">${MATCH_STATUS_LABEL[m.status] || m.status}</span>`;
    let note = '';
    if (m.status === 'bye') note = '轮空晋级';
    else if (m.status === 'void') note = esc(m.note || '已作废');
    else if (m.result) note = RESULT_LABEL[m.result.type] || '';
    const canRematch = myPid === t.hostPid && t.phase === 'running' &&
      (m.status === 'finished');
    const rematchBtn = canRematch
      ? ` <button class="link" data-rematch="${esc(m.id)}">异常重赛</button>` : '';
    const checked = m.status === 'ready' ? ` <span class="h-sub">（已到 ${m.checked}/2）</span>` : '';
    return `<div class="tour-match tour-${m.status}">
      <div class="tour-row">${playerCell(t, m, 'A')}</div>
      <div class="tour-row">${playerCell(t, m, 'B')}</div>
      <div class="h-sub">${status}${checked} ${note ? '· ' + note : ''}${rematchBtn}</div>
    </div>`;
  }

  function renderStandings(t) {
    const card = $('tour-standings-card');
    if (t.phase !== 'finished' || !t.finalStandings || !t.finalStandings.length) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    $('tour-standings').innerHTML = t.finalStandings.map(s => {
      const e = t.entrants.find(x => x.eid === s.eid);
      return `<li>第 ${s.rank} 名 · ${esc(e ? e.name : '?')}</li>`;
    }).join('');
  }

  // ---------- 绑定（仅一次） ----------

  function init() {
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    on('btn-tour-home', openList);
    on('btn-tour-back', () => go('home'));
    on('btn-tour-refresh', refreshList);
    on('btn-tour-create', openCreate);
    on('btn-tour-create-back', openList);
    on('btn-tour-create-cancel', openList);
    on('btn-tour-create-submit', submitCreate);
    on('btn-tour-detail-back', openList);
  }

  globalThis.WTTournament = {
    init, onList, onTournament, onCreated, onError, afterWrite,
    openList, openDetail, refreshList,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
