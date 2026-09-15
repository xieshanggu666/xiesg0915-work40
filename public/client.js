'use strict';
/* 词语领地客户端 */
(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get token() { return localStorage.getItem('wt_token'); },
    set token(v) { v ? localStorage.setItem('wt_token', v) : localStorage.removeItem('wt_token'); },
    get name() { return localStorage.getItem('wt_name') || ''; },
    set name(v) { localStorage.setItem('wt_name', v); },
    // 赛季身份密钥：本浏览器随机生成的 32 字节十六进制（64 位），只存在本机、永不上榜。
    // 公开的玩家标识 pid 由服务端从它派生（pid = sha256(pidSecret)）。建房/加入时提交密钥，
    // 别人即使在排行榜上看到你的 pid，也反推不出密钥、无法冒用你的身份污染战绩。
    get pidSecret() {
      let v = localStorage.getItem('wt_pid_secret');
      if (!v || !/^[a-f0-9]{64}$/.test(v)) {
        const bytes = new Uint8Array(32);
        (globalThis.crypto || {}).getRandomValues
          ? globalThis.crypto.getRandomValues(bytes)
          : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
        v = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('wt_pid_secret', v);
      }
      return v;
    },
    get seenTips() { return JSON.parse(localStorage.getItem('wt_tips') || '[]'); },
    addSeenTip(k) {
      const a = store.seenTips; if (!a.includes(k)) { a.push(k); localStorage.setItem('wt_tips', JSON.stringify(a)); }
    },
    // 历史与战绩：本机参与过的房间 token（用于换取战绩摘要与重返房间），上限 30 条
    get history() { return JSON.parse(localStorage.getItem('wt_history') || '[]'); },
    set history(v) { localStorage.setItem('wt_history', JSON.stringify(v)); },
    addHistory(token, roomCode) {
      const a = store.history.filter(e => e.roomCode !== roomCode);
      a.unshift({ token, roomCode });
      store.history = a.slice(0, 30);
    },
    // 战术练习通关进度（纯本地）：{ [scenarioId]: { at: 时间戳 } }
    get practice() { return JSON.parse(localStorage.getItem('wt_practice') || '{}'); },
    set practice(v) { localStorage.setItem('wt_practice', JSON.stringify(v)); },
    markPracticeDone(id) {
      const v = store.practice;
      v[id] = { at: Date.now() };
      store.practice = v;
    },
    // 个人收藏本（纯本地，不经过服务器）：收藏条目数组，见 favorites.js
    get favorites() { return JSON.parse(localStorage.getItem('wt_favorites') || '[]'); },
    set favorites(v) { localStorage.setItem('wt_favorites', JSON.stringify(v)); },
    // 我的词包（纯本地）：{id,name,theme,words[],updatedAt}[]，见 packs.js。
    // 房主在大厅选用后词包内容才作为快照发给服务器，本机列表始终只存在这里。
    get packs() { return JSON.parse(localStorage.getItem('wt_packs') || '[]'); },
    set packs(v) { localStorage.setItem('wt_packs', JSON.stringify(v)); },
    // 我分享过的词包码（本机映射，见 shares.js）：{code,packId,name,updatedAt}[]。
    // 服务端才是权威：进词包页时用 myShares 对账（跨设备分享也会出现，取消的码消失）。
    // 经 globalThis 引用：旧测试桩可能未加载 shares.js，生产环境 <script> 总会先于本文件。
    get packShares() {
      const lib = globalThis.WTShares;
      return lib ? lib.normalizeLocal(JSON.parse(localStorage.getItem('wt_pack_shares') || '[]')) : [];
    },
    set packShares(v) {
      const lib = globalThis.WTShares;
      if (lib) localStorage.setItem('wt_pack_shares', JSON.stringify(lib.normalizeLocal(v)));
    },
    // 我发布到交流广场的词包（本机映射，见 plaza.js）：{id,packId,name,updatedAt}[]。
    // 服务端才是权威：进词包页时用 myPlaza 对账（跨设备发布的也会出现，已下架的消失）。
    // 经 globalThis 引用：旧测试桩可能未加载 plaza.js，生产环境 <script> 总会先于本文件。
    get plazaMine() {
      const lib = globalThis.WTPlaza;
      return lib ? lib.normalizeLocal(JSON.parse(localStorage.getItem('wt_plaza_mine') || '[]')) : [];
    },
    set plazaMine(v) {
      const lib = globalThis.WTPlaza;
      if (lib) localStorage.setItem('wt_plaza_mine', JSON.stringify(lib.normalizeLocal(v)));
    },
  };

  let ws = null, state = null, prevState = null;
  let selectedParent = null;   // 接词时选中的父节点
  let reinforceMode = false;
  let challengeNodeId = null;
  let replayFrames = null, replayIdx = 0;
  let timerInterval = null;
  // 收藏本：当前筛选条件与复习会话
  let favKeyword = '', favRelation = '';
  let reviewSession = null;

  // ---------- 连接状态 ----------
  // offline：尚未连上（首页）；online：已连接；
  // reconnecting：连接中断、退避重连中；recovering：socket 已通、等待房间状态同步；
  // recovered：同步完成（横幅短暂展示后隐去）；failed：token 恢复被服务器拒绝。
  let connStatus = 'offline';
  let reconnectAttempts = 0;
  let reconnectTimer = null;   // 断线重连退避定时器（null 表示当前没有待执行的重连）
  let recoverHideTimer = null;
  let currentSeq = 0;          // 当前连接代号：旧 socket 的延迟关闭事件不得影响新连接
  // expectRecovery：本次断线发生在房间内，重连后要走"恢复 + 同步 + 提示"流程
  // （首次进页面/刷新后的首次连接不算，不能在正常进房时闪一条"已恢复"）
  let expectRecovery = false;
  let awaitingSync = false;
  let stopRetry = false;        // 恢复被明确拒绝后停止自动重连
  let suppressAutoReconnect = false; // 用户主动回首页：下一次连接不再凭 token 自动恢复
  let connFailMessage = '';     // 恢复失败原因，断线重渲染横幅时沿用
  let rulesSavePending = false;

  // 会产生写操作/重复提交的消息：socket 不可用时一律不发并提示，
  // 作为按钮禁用之外的兜底，防止断线期间从弹窗提交陈旧操作。
  const WRITE_TYPES = new Set([
    'createRoom', 'joinRoom', 'spectate', 'setRules', 'setWordPack', 'startGame',
    'play', 'reinforce', 'endTurn', 'challenge', 'resolve',
    'sharePack', 'unsharePack', 'importShare',
    'plazaPublish', 'plazaUnpublish', 'plazaSubscribe',
    'tournamentCreate', 'tournamentRegister', 'tournamentWithdraw', 'tournamentStart',
    'tournamentCancel', 'tournamentEnter', 'tournamentForfeit', 'tournamentRematch',
  ]);

  function connect() {
    const seq = ++currentSeq;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}`);
    ws = sock;
    let closed = false;
    sock.onopen = () => {
      if (seq !== currentSeq) return; // 已被更新的连接取代
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (store.token && expectRecovery) {
        // 连接已通，但断线期间可能错过广播：先恢复身份，再显式同步一次房间状态
        awaitingSync = true;
        setConnStatus('recovering');
        send({ type: 'reconnect', token: store.token });
      } else {
        awaitingSync = false;
        setConnStatus('online');
        // 有 token 且是刷新后的首次连接：自动恢复身份；
        // 用户主动"暂不等候回首页"（suppressAutoReconnect）时只保留 token 供历史重返，不自动进房
        if (store.token && !suppressAutoReconnect) send({ type: 'reconnect', token: store.token });
        suppressAutoReconnect = false;
      }
      requestHistory();
    };
    sock.onmessage = (e) => { if (seq === currentSeq) handle(JSON.parse(e.data)); };
    sock.onerror = () => { try { sock.close(); } catch { /* 关闭流程统一由 onclose 处理 */ } };
    sock.onclose = () => {
      if (closed) return; // onerror 手动 close 与浏览器原生 close 事件可能都到达，只处理一次
      closed = true;
      if (seq !== currentSeq) return; // 旧 socket 的延迟关闭，忽略
      ws = null;
      awaitingSync = false;
      rulesSavePending = false;
      // 恢复已被服务器明确拒绝：保持失败横幅与去向入口，不再自动重连
      if (stopRetry) { renderConnBanners(connFailMessage); return; }
      // 先切换连接状态（横幅/操作锁定据此渲染），再解除在途保存请求的提交锁
      if (state) {
        // 处于大厅/对局/结算：展示重连进度并锁定操作，1.5s 后自动重连
        expectRecovery = true;
        reconnectAttempts += 1;
        setConnStatus('reconnecting');
        render(); // 状态变化不会自动推送，按断线状态重渲染以锁定本页操作
        clearInterval(timerInterval); // 计时条停止空跑，恢复后由状态同步重启
      } else {
        setConnStatus('offline');
      }
      $('btn-save-rules').disabled = roomOffline();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (stopRetry) return;
        // 重连期间用户已离开房间：退避中一旦回到首页且没有待恢复身份，就停止循环
        if (!state && !store.token) return;
        connect();
      }, 1500);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
    if (WRITE_TYPES.has(msg.type)) toast('正在重连，操作已暂时锁定，恢复后会自动刷新房间状态');
    return false;
  }

  // 房间内操作是否应锁定：断线重连中、状态同步中、恢复失败后都禁止写操作，
  // 避免在旧局面上重复提交（恢复成功的瞬间状态已刷新，不锁定）。
  const roomOffline = () => !!state &&
    (connStatus === 'reconnecting' || connStatus === 'recovering' || connStatus === 'failed');
  // 我是否正被系统托管（掉线/超时）：托管期间服务端会拒绝一切行动/质疑/裁定，
  // 界面也相应禁用，避免提交后只收到一条错误。
  const meAutoPilot = () => {
    const me = state && state.players.find(p => p.id === state.you);
    return !!state && !!me && !!me.autoPilot;
  };

  function handle(msg) {
    switch (msg.type) {
      case 'joined':
        store.token = msg.token;
        // 观战是临时只读身份，不进历史；玩家 token 按房间码去重保存
        if (!msg.spectator) store.addHistory(msg.token, msg.roomCode);
        // 重连身份确认后，显式拉取一次最新房间状态作为"恢复完成"信号
        // （不能只靠 reconnect 触发的广播，那两者时序耦合）
        if (awaitingSync) {
          // 断线期间可能错过回合变更：清掉基于旧局面的本地选择，恢复后以服务器状态为准
          selectedParent = null;
          reinforceMode = false;
          challengeNodeId = null;
          send({ type: 'syncState' });
        }
        break;
      case 'state':
        prevState = state;
        state = msg.state;
        // 重连后的第一份房间状态（广播或显式同步）即恢复完成：
        // 断线期间错过的变更已包含在这份状态里，重新渲染并解除操作锁定。
        if (awaitingSync) {
          awaitingSync = false;
          expectRecovery = false;
          reconnectAttempts = 0;
          setConnStatus('recovered');
          toast('连接已恢复，房间状态已刷新');
        }
        onStateChange(prevState, state);
        render();
        break;
      case 'error':
        // 重连被服务器明确拒绝（会话失效/房间不存在/观战会话过期）：
        // 不再自动重连，展示失败横幅与去向入口
        if (msg.context === 'reconnect') { onReconnectFailed(msg.message); break; }
        // 规则保存失败：编辑器保持打开，错误就地展示
        if (msg.context === 'setRules') onRulesSaveError(msg.message);
        // 分享/取消/导入失败：错误就地展示在词包页对应入口
        else if (msg.context === 'sharePack') onShareError(msg.message);
        else if (msg.context === 'unsharePack') onUnshareError(msg.message);
        else if (msg.context === 'importShare') onImportError(msg.message);
        else if (msg.context === 'plazaUnpublish') onPlazaUnpublishError(msg.message);
        else if (msg.context === 'plazaPublish' || msg.context === 'plazaSubscribe') toast(msg.message);
        else if (msg.context === 'tournament') Tour.onError(msg.message);
        else toast(msg.message);
        if (msg.message.includes('会话已失效') || msg.message.includes('房间已不存在')) {
          store.token = null;
          showScreen('home');
        }
        break;
      case 'rulesSaved':
        onRulesSaved();
        break;
      case 'shared':
        onPackShared(msg);
        break;
      case 'unshared':
        onPackUnshared(msg.code);
        break;
      case 'sharedPack':
        onImportedPack(msg);
        break;
      case 'myShares':
        onMyShares(msg.shares);
        break;
      case 'plazaList':
        onPlazaList(msg);
        break;
      case 'plazaPack':
        onPlazaPack(msg);
        break;
      case 'plazaPublished':
        onPlazaPublished(msg);
        break;
      case 'plazaUnpublished':
        onPlazaUnpublished(msg.id);
        break;
      case 'myPlaza':
        onMyPlaza(msg.packs);
        break;
      case 'replay':
        replayFrames = msg.frames; replayIdx = 0;
        openReplay();
        break;
      case 'history':
        onHistory(msg.entries);
        break;
      case 'leaderboard':
        onLeaderboard(msg);
        break;
      case 'profile':
        onProfile(msg);
        break;
      case 'tournamentList':
        Tour.onList(msg);
        break;
      case 'tournament':
        Tour.onTournament(msg.tournament);
        break;
      case 'tournamentCreated':
        Tour.onCreated(msg.tournament);
        break;
      case 'tournamentRegistered':
      case 'tournamentWithdrawn':
      case 'tournamentStarted':
      case 'tournamentCancelled':
      case 'tournamentForfeited':
      case 'tournamentRematch':
        // 写操作确认：详情靠随后的 tournament 推送刷新；创建/列表型操作本地再拉一次
        if (Tour.afterWrite) Tour.afterWrite(msg);
        break;
    }
  }

  // 身份恢复失败：停止自动重连循环，横幅给出"返回首页 / 重新输入房间码"。
  // 保留当前页面与最后已知局面作为背景，不清空 state，直到用户选择去向。
  function onReconnectFailed(message) {
    awaitingSync = false;
    stopRetry = true;
    connFailMessage = message;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    setConnStatus('failed', message);
    store.token = null;
    if (state) render(); // 立即按 failed 状态锁定本页操作
  }

  // 作废当前连接：递增代号让其后续 open/message/close 全部失效，并尝试物理关闭。
  // 用于用户主动离开房间（暂不等候/恢复失败后回首页），避免在途消息再改状态。
  function invalidateCurrentSocket() {
    currentSeq += 1;
    const old = ws;
    ws = null;
    if (old) { try { old.onclose = null; old.close(); } catch { /* 已关闭 */ } }
  }

  const goHomeFromFailure = () => {
    stopRetry = false;
    connFailMessage = '';
    expectRecovery = false;
    state = null; prevState = null;
    // 离开失败房间：清掉待恢复身份，避免新连接 onopen 又凭 token 把用户拉回原房间
    store.token = null;
    invalidateCurrentSocket();
    $('inp-code').value = '';
    showScreen('home');
    setConnStatus('offline');
    connect(); // 干净的新连接供首页创建/加入使用
  };

  // 重新输入房间码：回到首页并预填原房间码，加入/观战按钮沿用原有流程
  const reenterRoom = () => {
    const code = state ? state.code : '';
    goHomeFromFailure();
    $('inp-code').value = code;
    $('inp-code').focus();
  };

  // 重连中主动放弃等候回首页：与"恢复失败"不同，本地 token 仍然有效，保留它——
  // 用户可从历史与战绩列表重新进入；作废在途连接，避免迟到的状态推送把用户拉回房间。
  const cancelWaitForRoom = () => {
    expectRecovery = false;
    awaitingSync = false;
    suppressAutoReconnect = true; // 保留 token 但下一次连接不自动进房
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    state = null; prevState = null;
    invalidateCurrentSocket();
    $('inp-code').value = '';
    showScreen('home');
    setConnStatus('offline');
    connect(); // 干净的新连接（无待恢复房间），供首页创建/加入使用
  };

  // ---------- 历史与战绩 ----------

  let historyEntries = [];
  let historyQueryTokens = []; // 最近一次历史查询覆盖的 token，决定清理失效记录的范围

  function requestHistory() {
    const tokens = store.history.map(e => e.token);
    if (!tokens.length) { historyEntries = []; renderHistory(); return; }
    historyQueryTokens = tokens;
    send({ type: 'history', tokens });
  }

  function onHistory(entries) {
    // 只清理"本次查询过、但服务器已不认得"的 token（房间已删/数据已清）。
    // 不能按"未出现在结果中"全量清理：查询发出后，其他标签页可能又加入了新房间，
    // 那些记录不在本次查询的覆盖范围里，全量清理会把它们误删掉。
    const valid = new Set(entries.map(e => e.token));
    const queried = new Set(historyQueryTokens);
    store.history = store.history.filter(e => !queried.has(e.token) || valid.has(e.token));
    // 发现有本次查询未覆盖的新记录：补一次查询，把它们也带进列表
    if (store.history.some(e => !queried.has(e.token))) { requestHistory(); return; }
    historyEntries = entries;
    renderHistory();
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderHistory() {
    const card = $('history-card');
    if (!historyEntries.length) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    const ended = historyEntries.filter(e => e.phase === 'ended');
    const wins = ended.filter(e => e.winner && e.winner === e.youId).length;
    $('history-stats').textContent = ended.length
      ? `已结束 ${ended.length} 场 · 胜 ${wins} 场 · 胜率 ${Math.round(wins / ended.length * 100)}%`
      : '还没有已结束的对局';
    $('history-list').innerHTML = historyEntries.map((e, i) => {
      let badge, result;
      if (e.phase === 'lobby') { badge = '<span class="badge">大厅中</span>'; result = '等待开局'; }
      else if (e.phase === 'playing') { badge = '<span class="badge">对局中</span>'; result = '正在进行'; }
      else if (!e.winner) { badge = '<span class="badge">平局</span>'; result = `你 ${e.yourTotal} 分`; }
      else if (e.winner === e.youId) { badge = '<span class="badge win">胜利</span>'; result = `你 ${e.yourTotal} 分 · 第 1 名`; }
      else { badge = '<span class="badge lose">落败</span>'; result = `${esc(e.winnerName)} 获胜 · 你 ${e.yourTotal} 分（第 ${e.yourRank} 名）`; }
      const others = e.players.filter(n => n !== e.youName).map(esc).join('、') || '—';
      return `<li>
        <div>
          <div><span class="h-code">${e.code}</span>${badge}</div>
          <div class="h-sub">${fmtDate(e.endedAt || e.createdAt)} · 与 ${others} 对局 · ${result}</div>
        </div>
        <button class="link" data-hidx="${i}">${e.phase === 'ended' ? '回看' : '进入'}</button>
      </li>`;
    }).join('');
    $('history-list').querySelectorAll('[data-hidx]').forEach(btn => {
      btn.onclick = () => {
        const entry = historyEntries[Number(btn.dataset.hidx)];
        if (!entry) return;
        // 凭该房间的玩家 token 重返：进行中回到对局，已结束回到结算（可回放）
        store.token = entry.token;
        send({ type: 'reconnect', token: entry.token });
      };
    });
  }

  // ---------- 赛季排行榜与个人页 ----------
  // 服务端从所有已结束对局汇总公开战绩：排行榜按总分/胜场/胜率排序，
  // 个人页展示场次、胜场、平局、平均得分、最高连锁与总分榜名次。

  let rankSort = 'total';   // total | wins | rate
  let rankRows = null;      // null=尚未拉取/加载中；[]=空赛季
  let rankStartedAt = null;
  let rankSeasonNo = null;  // 当前赛季序号（服务端返回）
  let rankSeasonCount = 0;  // 含历史赛季在内的赛季总数
  let rankMyPid = null;     // 服务端从本机密钥派生的公开 pid（用于标出"我"）
  let rankQuery = '';       // 昵称搜索词（纯前端过滤）
  let profileData = null;   // null=尚未拉取；false=该玩家暂无已结束对局

  // 只读请求：socket 不可用时不发送并提示（不能写按钮禁用兜底，因为这是首页入口）
  // 随排行榜带上本机密钥：服务端单向派生出 myPid 随响应返回，客户端据此标出自己那一行，
  // 无需在浏览器端实现 sha256；密钥只在内存里过一遍，服务端不落库（与个人页同一路径）。
  function askLeaderboard() {
    rankRows = null;
    if (!send({ type: 'leaderboard', sort: rankSort, pidSecret: store.pidSecret })) {
      toast('正在连接服务器，排行榜稍后再试');
    }
    renderRank();
  }

  // cred：点排行榜行时传 { pid }（公开标识）；"我的战绩"传 { pidSecret }（本人密钥）
  function askProfile(cred) {
    profileData = null;
    showScreen('profile');
    if (!send({ type: 'profile', ...cred })) {
      toast('正在连接服务器，战绩稍后再试');
    }
    renderProfile();
  }

  function onLeaderboard(msg) {
    rankSort = ['total', 'wins', 'rate'].includes(msg.sort) ? msg.sort : 'total';
    rankRows = Array.isArray(msg.rows) ? msg.rows : [];
    rankStartedAt = msg.startedAt || null;
    rankSeasonNo = Number(msg.season) > 0 ? Number(msg.season) : null;
    const seasons = Array.isArray(msg.seasons) ? msg.seasons : null;
    rankSeasonCount = seasons ? seasons.length : (rankSeasonNo ? rankSeasonNo : 0);
    rankMyPid = typeof msg.myPid === 'string' ? msg.myPid : null;
    renderRank();
  }

  function onProfile(msg) {
    // 服务端同时回当前赛季序号；旧服务端/测试桩没有该字段时保持 undefined（渲染走降级文案）
    profileData = msg.profile
      ? { ...msg.profile, season: Number(msg.season) > 0 ? Number(msg.season) : msg.profile.season }
      : false;
    renderProfile();
  }

  const pct = (r) => `${Math.round(r * 100)}%`;

  function openRank() {
    showScreen('rank');
    askLeaderboard();
  }

  // 从个人页返回排行榜：可能是从首页直接进"我的战绩"（排行榜从未拉取，rankRows 为 null），
  // 此时只 renderRank 会永远停在"加载中"。无数据就补一次拉取；已有数据直接展示，不闪加载。
  function backToRank() {
    showScreen('rank');
    if (rankRows === null) askLeaderboard();
    else renderRank();
  }

  const RANK_SORT_LABEL = { total: '总分', wins: '胜场', rate: '胜率' };

  function renderRank() {
    if ($('screen-rank').classList.contains('hidden')) return;
    // 当前选中的排序维度高亮；服务端按该维度返回名次
    for (const [key, id] of [['total', 'btn-sort-total'], ['wins', 'btn-sort-wins'], ['rate', 'btn-sort-rate']]) {
      $(id).classList.toggle('primary', key === rankSort);
    }
    const seasonLabel = rankSeasonNo ? `第 ${rankSeasonNo} 赛季` : '本赛季';
    const archiveHint = rankSeasonCount > 1 ? ` · 共 ${rankSeasonCount} 个赛季` : '';
    $('rank-season').textContent =
      rankStartedAt ? `${seasonLabel} 自 ${fmtDate(rankStartedAt)} 起${archiveHint}` : '';
    renderRankMine();
    const list = $('rank-list');
    if (rankRows === null) { list.innerHTML = '<p class="hint">排行榜加载中…</p>'; return; }
    if (!rankRows.length) { list.innerHTML = '<p class="hint">还没有人完成对局，打完一局就上榜。</p>'; return; }
    const q = rankQuery.trim().toLowerCase();
    const rows = q ? rankRows.filter(r => r.name.toLowerCase().includes(q)) : rankRows;
    if (!rows.length) {
      list.innerHTML = `<p class="hint">没有昵称包含「${esc(rankQuery.trim())}」的玩家。</p>`;
      return;
    }
    list.innerHTML = `<table>
      <tr><th>名次</th><th>玩家</th><th>总分</th><th>胜场</th><th>胜率</th><th>场次</th></tr>
      ${rows.map(r => {
        const isMe = rankMyPid && r.pid === rankMyPid;
        return `<tr class="rank-row${isMe ? ' me' : ''}" data-pid="${esc(r.pid)}" title="查看个人战绩">
        <td>${r.rank === 1 ? '🏆 ' : ''}${r.rank}</td>
        <td>${esc(r.name)}${isMe ? '<span class="me-tag-inline">我</span>' : ''}</td>
        <td><b>${r.totalScore}</b></td>
        <td>${r.wins}</td>
        <td>${pct(r.winRate)}</td>
        <td>${r.games}</td>
      </tr>`;
      }).join('')}</table>`;
    list.querySelectorAll('.rank-row').forEach(tr => {
      tr.onclick = () => askProfile({ pid: tr.dataset.pid });
    });
  }

  // 顶部固定的"我的"汇总条：名次/总分/胜场/胜率随当前排序维度展示；
  // 尚未上榜（没打完过一局）时给空态。点整条可滚动定位到榜内自己那行（搜索过滤后也能找到）。
  function renderRankMine() {
    const box = $('rank-mine');
    if (rankRows === null) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const me = rankMyPid ? rankRows.find(r => r.pid === rankMyPid) : null;
    box.classList.remove('hidden');
    if (!me) {
      box.innerHTML = `<div class="rank-mine-title">我的战绩</div>
        <div class="rank-mine-stats"><span class="rm-empty">当前赛季还没有完成对局，打完一局就会在这里看到你的名次。</span></div>`;
      box.onclick = null;
      return;
    }
    box.innerHTML = `<div class="rank-mine-title">我的战绩 <span class="me-tag">我</span>
        <span class="hint" style="margin-left:auto;font-weight:400">按${RANK_SORT_LABEL[rankSort]}榜 · 点击定位到我的行 ↑</span></div>
      <div class="rank-mine-stats">
        <span>名次 <b>第 ${me.rank} 名</b></span>
        <span>总分 <b>${me.totalScore}</b></span>
        <span>胜场 <b>${me.wins}</b></span>
        <span>胜率 <b>${pct(me.winRate)}</b></span>
      </div>`;
    box.onclick = () => {
      // 清掉搜索词，保证"我"那一行在当前列表里；再滚到可视区并闪一下
      if (rankQuery) {
        rankQuery = '';
        $('rank-search-input').value = '';
        renderRank();
      }
      // querySelectorAll 返回的是 NodeList（只有 forEach，没有 find），
      // 直接 .find 会抛 TypeError 导致定位失效；先转数组
      const tr = Array.from($('rank-list').querySelectorAll('.rank-row'))
        .find(row => row.dataset.pid === rankMyPid);
      if (tr && typeof tr.scrollIntoView === 'function') {
        tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    };
  }

  // 赛季成就徽章：优先用服务端 profile 附带的徽章；旧服务端/测试桩未加载时
  // 用本机 achievements 纯逻辑按 profile 数据现算（字段相同，渲染无需区分）。
  function resolveBadges(p) {
    if (Array.isArray(p.badges) && p.badges.length) return p.badges;
    const lib = globalThis.WTAchievements;
    return lib ? lib.evaluate(p) : [];
  }

  function renderBadges(badges) {
    if (!badges.length) return '';
    const got = badges.filter(b => b.earned);
    const todo = badges.filter(b => !b.earned);
    const tile = (b, locked) => `<div class="ach${locked ? ' locked' : ''}" title="${esc(b.desc)}">
        <div class="ach-icon">${b.icon}</div>
        <div class="ach-name">${esc(b.name)}</div>
        <div class="ach-metric">${esc(b.label)} ${b.current}/${b.target}</div>
        ${locked ? `<div class="ach-bar"><i style="width:${b.percent}%"></i></div>` : '<div class="ach-done">已点亮</div>'}
      </div>`;
    const section = (title, list, locked) => list.length
      ? `<div class="ach-group-title">${title}</div>
         <div class="ach-grid">${list.map(b => tile(b, locked)).join('')}</div>` : '';
    return `<h3 class="ach-title">赛季成就 <span class="hint">（${got.length}/${badges.length}）</span></h3>
      ${section('已获得', got, false)}
      ${section('待解锁', todo, true)}
      <p class="hint">徽章按本赛季累计数据自动点亮：场次、胜场、最高连锁达到里程碑即可。</p>`;
  }

  // 各赛季名次：当前赛季（进行中，名次实时）在前，其后是冻结归档的历史赛季（名次不再变）。
  // 数据来自服务端 profile.seasons；旧服务端/测试桩没有该字段时不渲染这一段（降级）。
  function renderSeasons(p) {
    const seasons = Array.isArray(p.seasons) ? p.seasons : [];
    if (seasons.length <= 1 && (!seasons.length || seasons[0].current)) return '';
    const row = (sn) => {
      const tag = sn.current
        ? '<span class="season-tag current">进行中</span>'
        : '<span class="season-tag">已归档</span>';
      const span = sn.startedAt ? fmtDate(sn.startedAt) : '—';
      const ended = sn.endedAt ? ` → ${fmtDate(sn.endedAt)}` : '';
      const rank = sn.rank ? `第 ${sn.rank} 名` : '未上榜';
      return `<tr>
        <td>第 ${sn.season} 赛季 ${tag}</td>
        <td><b>${rank}</b></td>
        <td>${sn.totalScore}</td>
        <td>${sn.wins}</td>
        <td>${pct(sn.winRate)}</td>
        <td>${sn.games}</td>
        <td class="hint">${span}${ended}</td>
      </tr>`;
    };
    return `<h3 class="seasons-title">各赛季名次</h3>
      <div class="seasons-table"><table>
        <tr><th>赛季</th><th>总分榜名次</th><th>总分</th><th>胜场</th><th>胜率</th><th>场次</th><th>时间</th></tr>
        ${seasons.map(row).join('')}
      </table></div>
      <p class="hint">历史赛季在赛季结束时冻结归档，名次与战绩不再变化；新赛季从零重新累计。</p>`;
  }

  function renderProfile() {
    if ($('screen-profile').classList.contains('hidden')) return;
    const box = $('profile-body');
    if (profileData === null) { box.innerHTML = '<p class="hint">战绩加载中…</p>'; return; }
    if (!profileData) {
      box.innerHTML = '<p class="hint">这名玩家还没有已结束的对局。</p>';
      return;
    }
    const p = profileData;
    const seasonLabel = p.season ? `第 ${p.season} 赛季` : '当前赛季';
    const rankText = p.rank ? `总分榜第 ${p.rank} 名` : '当前赛季暂无排名';
    box.innerHTML = `
      <h3>${esc(p.name)} <span class="hint">（${rankText}）</span></h3>
      <p class="hint">以下为${seasonLabel}汇总；历史赛季名次见下方。</p>
      <div class="stat-grid">
        <div class="stat"><div class="stat-v">${p.games}</div><div class="stat-k">场次</div></div>
        <div class="stat win"><div class="stat-v">${p.wins}</div><div class="stat-k">胜场</div></div>
        <div class="stat"><div class="stat-v">${p.ties}</div><div class="stat-k">平局</div></div>
        <div class="stat"><div class="stat-v">${p.losses}</div><div class="stat-k">负场</div></div>
        <div class="stat"><div class="stat-v">${pct(p.winRate)}</div><div class="stat-k">胜率</div></div>
        <div class="stat"><div class="stat-v">${p.totalScore}</div><div class="stat-k">总得分</div></div>
        <div class="stat"><div class="stat-v">${p.avgScore}</div><div class="stat-k">平均得分</div></div>
        <div class="stat"><div class="stat-v">${p.bestChain}</div><div class="stat-k">最高连锁</div></div>
      </div>
      <div class="seasons-box">${renderSeasons(p)}</div>
      <div class="ach-box">${renderBadges(resolveBadges(p))}</div>
      <p class="hint">最近对局：${p.lastAt ? fmtDate(p.lastAt) : '—'}</p>`;
  }

  // ---------- 状态变化 → 提示 / 教学 ----------

  function onStateChange(prev, cur) {
    // 观战者只读：不发任何行动引导，只在进入时提示一次
    if (cur.spectating) {
      if (!prev || !prev.spectating) {
        toast(cur.phase === 'playing'
          ? '正在观战：玩家、词链、回合和质疑状态会实时同步'
          : cur.phase === 'ended' ? '对局已结束，可以查看结算与回放' : '正在观战大厅，等待房主开始游戏');
      }
      return;
    }
    if (!prev || prev.phase !== cur.phase) {
      if (cur.phase === 'playing') tip('goal', '【目标】用行动点把新词接到场上，连成你的领地。词链越长得分越高；未加固的连接可能被对手质疑拆除。');
    }
    // 大厅里规则被修改：高亮规则卡片，非房主玩家额外弹提示，确保及时看到
    if (prev && cur.phase === 'lobby' && !WTRules.sameRuleSet(prev.ruleSet, cur.ruleSet)) {
      flashRulesCard();
      if (cur.you !== cur.hostId) toast('房主更新了本局规则');
    }
    // 大厅里词包选择变化：非房主玩家弹提示，主题与候选词已在词包卡片中展示
    if (prev && cur.phase === 'lobby' &&
        JSON.stringify(prev.wordPack || null) !== JSON.stringify(cur.wordPack || null)) {
      if (cur.you !== cur.hostId) {
        toast(cur.wordPack ? `房主选择了主题词包「${cur.wordPack.name}」` : '房主改回了默认词池');
      }
    }
    if (cur.phase === 'playing' && cur.turn) {
      if (!prev || !prev.turn || prev.turn.turnNumber !== cur.turn.turnNumber) {
        if (cur.turn.playerId === cur.you) {
          tip('yourturn', '【轮到你了】点击场上任意一个词作为连接点，再点「接词」。也可以点「加固」保护自己的关键连接。');
        }
      }
      // 有对手新接了词（起始词等中立词不算）
      if (prev) {
        const newOpp = WTTips.findNewOpponentWords(prev.nodes, cur.nodes, cur.you);
        if (newOpp.length) {
          tip('challenge', `【可以质疑】对手接出了「${newOpp[0].word}」。如果你认为关系不成立，点击词上的「质疑」标记，由裁定者按规则判定。`);
        }
      }
    }
    // 质疑出现
    if (cur.pendingChallenge && (!prev || !prev.pendingChallenge)) {
      const ch = cur.pendingChallenge;
      if (ch.adjudicatorId === cur.you) {
        tip('judge', '【请你裁定】对照本局规则，判断这条连接是否成立。裁定结果立即生效，计时已暂停。');
        openJudge();
      } else {
        const who = playerName(cur, ch.challengerId);
        toast(`${who} 发起了质疑，等待裁定…`);
      }
    }
    if (!cur.pendingChallenge && prev && prev.pendingChallenge) closeDialog('dlg-judge');
    if (cur.phase === 'ended' && (!prev || prev.phase !== 'ended')) {
      tip('score', '【结算】每个词得 1+深度 分，加固 +1，最长链另有奖励。点「回放本局」可以复盘整局。');
    }
  }

  // 教学提示：排队展示，关闭时才记为已读
  const tipQueue = WTTips.createTipQueue({
    isSeen: (key) => store.seenTips.includes(key),
    markSeen: (key) => store.addSeenTip(key),
    show: (text) => { $('tip-text').textContent = text; $('tip-box').classList.remove('hidden'); },
    hide: () => $('tip-box').classList.add('hidden'),
  });
  const tip = (key, text) => tipQueue.push(key, text);
  $('tip-ok').onclick = () => tipQueue.dismiss();

  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('toast-wrap').appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ---------- 渲染 ----------

  function showScreen(name) {
    for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
    $(`screen-${name}`).classList.remove('hidden');
    renderConnBanners();
  }

  // ---------- 连接状态横幅（大厅/对局/结算统一） ----------

  const CONN_BANNERS = [
    { id: 'conn-banner-lobby', phase: 'lobby' },
    { id: 'conn-banner-game', phase: 'playing' },
    { id: 'conn-banner-end', phase: 'ended' },
  ];

  function setConnStatus(next, failMessage) {
    connStatus = next;
    if (recoverHideTimer) { clearTimeout(recoverHideTimer); recoverHideTimer = null; }
    if (next === 'recovered') {
      // 成功提示短暂展示后收起，避免一直占用页面
      recoverHideTimer = setTimeout(() => {
        recoverHideTimer = null;
        if (connStatus === 'recovered') { connStatus = 'online'; renderConnBanners(); }
      }, 2500);
    }
    renderConnBanners(failMessage);
    updateHomeConnState();
  }

  function connBannerHtml(status, failMessage) {
    const attempt = reconnectAttempts > 0 ? `（第 ${reconnectAttempts} 次）` : '';
    if (status === 'reconnecting') {
      return `<span class="conn-text"><span class="conn-dot"></span>连接已断开，正在自动重连${attempt}…操作已暂时锁定</span>
        <span class="conn-actions"><button class="link" data-conn="cancel">暂不等候，回首页</button></span>`;
    }
    if (status === 'recovering') {
      return `<span class="conn-text"><span class="conn-dot"></span>已连上服务器，正在恢复房间并同步最新状态…</span>
        <span class="conn-actions"><button class="link" data-conn="cancel">暂不等候，回首页</button></span>`;
    }
    if (status === 'recovered') {
      return `<span class="conn-text"><span class="conn-dot"></span>已恢复连接，房间状态已刷新</span>`;
    }
    if (status === 'failed') {
      const msg = failMessage || '会话已失效，无法恢复房间';
      return `<span class="conn-text"><span class="conn-dot"></span>恢复失败：${esc(msg)}</span>
        <span class="conn-actions">
          <button data-conn="reenter">重新输入房间码</button>
          <button class="primary" data-conn="home">返回首页</button>
        </span>`;
    }
    return '';
  }

  function renderConnBanners(failMessage) {
    for (const b of CONN_BANNERS) {
      const el = $(b.id);
      const show = !!state && state.phase === b.phase &&
        ['reconnecting', 'recovering', 'recovered', 'failed'].includes(connStatus);
      if (!show) { el.classList.add('hidden'); continue; }
      el.classList.remove('hidden');
      el.className = `conn-banner ${connStatus}`;
      el.innerHTML = connBannerHtml(connStatus, failMessage);
    }
    // 横幅按钮事件每次重渲染后重新绑定
    document.querySelectorAll('.conn-banner [data-conn]').forEach(btn => {
      btn.onclick = () => {
        const act = btn.dataset.conn;
        if (act === 'home') goHomeFromFailure();
        else if (act === 'cancel') cancelWaitForRoom();
        else reenterRoom();
      };
    });
  }

  // 首页：未连接时禁用建/加/观战，避免请求在断线时丢失后无反馈。
  // 只在离线时写 home-error，连接恢复时清空；不覆盖用户自己的房间码校验错误。
  function updateHomeConnState() {
    const online = (ws && ws.readyState === 1) &&
      !(connStatus === 'reconnecting' || connStatus === 'recovering');
    for (const id of ['btn-create', 'btn-join', 'btn-spectate']) $(id).disabled = !online;
    if (online) {
      if ($('home-error').textContent === '正在连接服务器…') $('home-error').textContent = '';
    } else if (!state) {
      $('home-error').textContent = '正在连接服务器…';
    }
  }

  const isSpectating = () => !!(state && state.spectating);

  function playerName(s, id) {
    if (!id) return '中立';
    const p = s.players.find(p => p.id === id);
    return p ? p.name : '?';
  }
  function playerColor(s, id) {
    const p = s.players.find(p => p.id === id);
    return p ? p.color : '#999';
  }

  function render() {
    if (!state) return;
    // 阶段切换（如断线同步后发现对局已结束）：本地选词不跨阶段保留
    if (prevState && prevState.phase !== state.phase) {
      selectedParent = null;
      reinforceMode = false;
    }
    if (state.phase === 'lobby') { renderLobby(); showScreen('lobby'); }
    else if (state.phase === 'playing') { renderGame(); showScreen('game'); }
    else if (state.phase === 'ended') { renderEnd(); showScreen('end'); }
  }

  function renderLobby() {
    $('lobby-code').textContent = state.code;
    $('lobby-count').textContent = state.players.length;
    $('lobby-players').innerHTML = state.players.map(p =>
      `<li><span class="dot" style="background:${p.color}"></span>${esc(p.name)}
       ${p.id === state.hostId ? '（房主）' : ''}
       ${p.id === state.you ? '（你）' : ''}
       ${p.connected ? '' : '<span class="offline">离线</span>'}</li>`).join('');
    const specs = state.spectators || [];
    $('lobby-spectators').innerHTML = specs.map(s =>
      `<li class="spectator">👁 ${esc(s.name)}${s.id === state.you ? '（你·观战）' : '（观战）'}
       ${s.connected ? '' : '<span class="offline">离线</span>'}</li>`).join('');
    $('rules-summary').innerHTML = rulesSummary(state.ruleSet);
    const isHost = state.you === state.hostId;
    $('btn-edit-rules').classList.toggle('hidden', !isHost);
    $('btn-start').classList.toggle('hidden', !isHost);
    renderPackCard(isHost);
    // 断线重连中：开始游戏/保存规则等会产生写操作的入口一律锁定，恢复后随状态刷新解锁
    $('btn-start').disabled = roomOffline();
    $('btn-save-rules').disabled = rulesSavePending || roomOffline();
    $('btn-exit-spectate').classList.toggle('hidden', !state.spectating);
    $('lobby-wait').textContent = isHost
      ? (state.players.length < 2 ? '至少需要 2 名玩家才能开始' : '人齐了就点开始吧')
      : (state.spectating ? '你正在观战，对局开始后会自动收到局面' : '等待房主开始…');
  }

  function rulesSummary(r) {
    const names = r.allowedRelations.map(id => {
      const t = state.relationTypes.find(t => t.id === id);
      return t ? t.name : id;
    }).join('、');
    return `<ul>
      <li>允许的关系：${names}</li>
      <li>专有名词：${r.allowProperNouns ? '允许' : '不允许'}</li>
      <li>解释至少 ${r.minReasonLen} 字 · 每回合 ${r.turnSeconds} 秒 · ${r.apPerTurn} 行动点</li>
      <li>每人 ${r.rounds} 回合 · ${r.challengeTokens} 次质疑机会</li>
      <li>计分：词 = 1+深度 分，加固 +1，最长链 ×2 奖励</li>
    </ul>`;
  }

  // ---------- 大厅：主题词包 ----------
  // 所有人都能在大厅看到当前选用的词包（主题与候选词）；只有房主能换选。
  // 房主的下拉选项来自本机词包（localStorage），选中后词包内容作为快照发给服务器。

  let packSelectSig = ''; // 下拉选项签名：本机词包或当前选中变化时才重建，避免打字/刷新时闪烁

  function renderPackCard(isHost) {
    const wp = state.wordPack || null;
    $('pack-host-row').classList.toggle('hidden', !isHost);
    if (isHost) {
      // 当前生效的词包可能已在本机被删除（房间里的快照仍在生效）：
      // 为它补一个"当前选择"选项并如实选中，不能误显示成默认词池
      const missing = !!(wp && !store.packs.some(p => p.id === wp.id));
      const sig = JSON.stringify([store.packs.map(p => [p.id, p.name, p.words.length]), wp && wp.id, missing]);
      if (sig !== packSelectSig) {
        packSelectSig = sig;
        $('pack-select').innerHTML = '<option value="">默认词池</option>' +
          store.packs.map(p =>
            `<option value="${p.id}">${esc(p.name)}（${p.words.length} 词）</option>`).join('') +
          (missing
            ? `<option value="${wp.id}">${esc(wp.name)}（本机已删除，仍是本局选择）</option>`
            : '');
      }
      $('pack-select').value = wp ? wp.id : '';
      $('pack-select').disabled = roomOffline();
    }
    $('pack-info').innerHTML = wp
      ? `<div class="pack-theme-line">主题词包：<b>${esc(wp.name)}</b>${wp.theme ? ` · ${esc(wp.theme)}` : ''}</div>
         <div class="pack-words">${wp.words.map(w => `<span class="pack-chip">${esc(w)}</span>`).join('')}</div>
         <p class="hint">开局将从以上 ${wp.words.length} 个候选词中不重复抽取
           ${Math.min(state.ruleSet.startWordCount, wp.words.length)} 个起始词。</p>`
      : `<p class="hint">未选用主题词包，开局将从默认词池抽取起始词。
           ${isHost ? '可先在首页「我的词包」创建词包，再回到这里选择。' : '房主可以在大厅选用主题词包。'}</p>`;
  }

  $('pack-select').onchange = () => {
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    const id = $('pack-select').value;
    if (!id) { send({ type: 'setWordPack', pack: null }); return; }
    const p = WTPacks.find(store.packs, id);
    if (!p) return toast('这个词包已不在本机，请重新选择');
    send({ type: 'setWordPack', pack: { id: p.id, name: p.name, theme: p.theme, words: p.words } });
  };

  function renderGame() {
    const t = state.turn;
    const spectator = !!state.spectating;
    const active = !spectator && t && t.playerId === state.you;
    $('turn-info').innerHTML = t
      ? `第 ${t.turnNumber} 回合 · 轮到 <b style="color:${playerColor(state, t.playerId)}">${esc(playerName(state, t.playerId))}</b>${active ? '（你）' : ''}` +
        ((state.players.find(p => p.id === t.playerId) || {}).autoPilot ? '<span class="autopilot">托管中</span>' : '')
      : '';
    $('ap-info').textContent = spectator
      ? '观战中 · 只读'
      : active
        ? `你的行动点：${t.apLeft} / ${state.ruleSet.apPerTurn}`
        : `你的质疑机会：${(state.players.find(p => p.id === state.you) || {}).tokensLeft ?? 0}`;

    $('spectator-banner').classList.toggle('hidden', !spectator);

    $('scoreboard').innerHTML = state.players.map(p => {
      const words = state.nodes.filter(n => n.ownerId === p.id).length;
      const status = p.autoPilot
        ? '<span class="autopilot">托管</span>'
        : (p.connected ? '' : '<span class="offline">离线</span>');
      return `<span class="score-chip ${t && t.playerId === p.id ? 'active' : ''}">
        <span class="dot" style="background:${p.color}"></span>${esc(p.name)} · ${words} 词
        ${status}</span>`;
    }).join('') + ((state.spectators || []).length
      ? `<span class="score-chip spec">👁 ${state.spectators.length} 人观战</span>` : '');

    // 待裁定横幅：常显入口，防止弹窗被关掉后整局卡住（观战者不显示裁定入口）
    const ch = state.pendingChallenge;
    if (ch) {
      const iAmJudge = !spectator && ch.adjudicatorId === state.you;
      const node = state.nodes.find(n => n.id === ch.nodeId);
      $('challenge-banner-text').textContent = iAmJudge
        ? `有质疑等待你裁定${node ? `（目标：${node.word}）` : ''}，裁定前对局暂停`
        : spectator
          ? `${playerName(state, ch.challengerId)} 发起了质疑，等待 ${playerName(state, ch.adjudicatorId)} 裁定…`
          : `等待 ${playerName(state, ch.adjudicatorId)} 裁定质疑…`;
      $('btn-goto-judge').classList.toggle('hidden', !iAmJudge);
      $('challenge-banner').classList.remove('hidden');
      // 裁定者每次状态刷新都确保弹窗开着
      if (iAmJudge) openJudge();
    } else {
      $('challenge-banner').classList.add('hidden');
    }

    renderBoard($('board'), state.nodes, {
      selectable: active,
      showChallenge: !active && !spectator && state.phase === 'playing' && !meAutoPilot(),
    });

    // 观战者：隐藏全部行动按钮，词链不可选
    $('action-row').classList.toggle('hidden', spectator);
    // 断线重连/恢复中：行动按钮禁用，防止在旧局面上重复提交。
    // 注意 recovered 横幅展示期间操作已可用（此时状态就是刚同步的最新状态）。
    const offline = roomOffline();
    const pilot = meAutoPilot();
    $('btn-play').disabled = !active || !selectedParent || (t && t.apLeft < 1) || !!state.pendingChallenge || offline || pilot;
    $('btn-reinforce').disabled = !active || (t && t.apLeft < 1) || !!state.pendingChallenge || offline || pilot;
    $('btn-reinforce').textContent = reinforceMode ? '取消加固' : '加固';
    $('btn-endturn').disabled = !active || !!state.pendingChallenge || offline || pilot;
    $('btn-replay').classList.add('hidden');

    updateTimer();
  }

  function renderBoard(container, nodes, opts = {}) {
    // 按树形缩进展示
    const children = new Map();
    for (const n of nodes) {
      const key = n.parentId || '';
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(n);
    }
    const html = [];
    const walk = (parentId, depth) => {
      for (const n of children.get(parentId) || []) {
        html.push(nodeHtml(n, depth, opts));
        walk(n.id, depth + 1);
      }
    };
    walk('', 0);
    // 兜底：父节点缺失的孤儿（理论上不会出现）
    for (const n of nodes) {
      if (n.parentId && !nodes.some(p => p.id === n.parentId) && !html.some(h => h.includes(n.id))) {
        html.push(nodeHtml(n, 0, opts));
      }
    }
    container.innerHTML = html.join('');
    container.querySelectorAll('.node').forEach(el => {
      el.onclick = (e) => {
        if (e.target.classList.contains('challengeable')) return;
        if (e.target.classList.contains('fav-btn')) return; // 收藏按钮自行处理，不触发选词
        onNodeClick(el.dataset.id);
      };
    });
    container.querySelectorAll('.challengeable').forEach(el => {
      el.onclick = () => { challengeNodeId = el.closest('.node').dataset.id; openChallengeConfirm(); };
    });
    container.querySelectorAll('.fav-btn').forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        if (opts.onCollect) opts.onCollect(el.closest('.node').dataset.id);
      };
    });
  }

  function nodeHtml(n, depth, opts) {
    const color = n.ownerId ? playerColor(state, n.ownerId) : '#999';
    const rel = n.relation ? (state.relationTypes.find(r => r.id === n.relation) || {}).name : '';
    const mine = n.ownerId === state.you;
    const canChallenge = opts.showChallenge && n.ownerId && !mine && !n.reinforced &&
      !state.pendingChallenge && (state.players.find(p => p.id === state.you) || {}).tokensLeft > 0;
    const badges = [];
    if (n.reinforced && n.parentId) badges.push('<span class="badge shield">已加固</span>');
    if (n.survivedAsRoot) badges.push('<span class="badge shield">幸存根</span>');
    if (canChallenge) badges.push('<span class="badge challengeable">质疑</span>');
    // 回放里可收藏的连接（有父词、是玩家接出的词）：显示收藏 / 已收藏
    if (opts.collectable && n.parentId && n.ownerId) {
      const saved = store.favorites.some(f => f.key === WTFav.connectionKey(n, state.code));
      badges.push(saved
        ? '<span class="badge fav-saved">已收藏</span>'
        : '<span class="badge fav-btn" title="收藏这条连接">收藏</span>');
    }
    return `<div class="node ${n.ownerId ? '' : 'start'} ${selectedParent === n.id ? 'selected' : ''}"
      data-id="${n.id}" style="margin-left:${depth * 22}px; border-left-color:${color}">
      <span class="word">${esc(n.word)}</span>
      <div class="meta">${n.ownerId ? `${esc(playerName(state, n.ownerId))} · ${rel || ''} · ${esc(n.reason || '')}` : '起始词'}</div>
      <div class="badges">${badges.join('')}</div>
    </div>`;
  }

  function onNodeClick(nodeId) {
    if (isSpectating()) return;
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    const t = state.turn;
    if (!t || t.playerId !== state.you) return;
    const node = state.nodes.find(n => n.id === nodeId);
    if (!node) return;
    if (reinforceMode) {
      if (node.ownerId !== state.you) return toast('只能加固自己的词');
      if (!node.parentId) return toast('起始词无需加固');
      if (node.reinforced) return toast('已经加固过了');
      send({ type: 'reinforce', nodeId });
      reinforceMode = false;
      return;
    }
    selectedParent = selectedParent === nodeId ? null : nodeId;
    render();
  }

  // ---------- 计时 ----------

  function updateTimer() {
    clearInterval(timerInterval);
    const tick = () => {
      if (!state || !state.turn) return;
      // 断线期间不倒数：显示连接状态，避免计时条空跑；恢复后状态同步会带回正确 deadline
      if (connStatus === 'reconnecting' || connStatus === 'recovering' || connStatus === 'failed') {
        $('timer-text').textContent = '连接中断…';
        return;
      }
      const t = state.turn;
      let remain;
      if (t.deadline) remain = Math.max(0, t.deadline - Date.now());
      else if (t.pausedRemaining != null) remain = t.pausedRemaining;
      else return;
      const total = state.ruleSet.turnSeconds * 1000;
      const pct = Math.min(100, remain / total * 1000);
      $('timer-bar').style.width = (Math.min(100, remain / total * 100)) + '%';
      $('timer-bar').classList.toggle('low', remain < 15000);
      if (t.deadline) {
        $('timer-text').textContent = `${Math.ceil(remain / 1000)}s`;
      } else if (t.pausedReason === 'autopilot') {
        $('timer-text').textContent = '托管中…';
      } else {
        $('timer-text').textContent = '裁定中…';
      }
    };
    tick();
    timerInterval = setInterval(tick, 500);
  }

  // ---------- 结算 ----------

  function renderEnd() {
    const scores = state.scores || [];
    const meWin = state.winner === state.you;
    $('btn-exit-spectate3').classList.toggle('hidden', !state.spectating);
    // 断线重连中：回放请求会丢失，先锁定按钮；恢复后状态同步会重新渲染
    $('btn-replay2').disabled = roomOffline();
    $('end-title').textContent = state.spectating
      ? '对局结束（观战中）'
      : state.winner
        ? `🏆 ${playerName(state, state.winner)} 获胜！${meWin ? '（是你）' : ''}` : '平局！';
    $('end-scores').innerHTML = `<table>
      <tr><th>玩家</th><th>词数</th><th>最长链</th><th>总分</th></tr>
      ${scores.map(s => `<tr>
        <td><span class="dot" style="background:${s.color}"></span> ${esc(s.name)}${s.playerId === state.you ? '（你）' : ''}</td>
        <td>${s.words}</td><td>${s.longestChain}</td><td><b>${s.total}</b></td>
      </tr>`).join('')}</table>`;
  }

  // ---------- 弹窗 ----------

  function openDialog(id) { $(id).showModal(); }
  function closeDialog(id) { const d = $(id); if (d.open) d.close(); }
  document.querySelectorAll('[data-close]').forEach(b =>
    b.onclick = () => b.closest('dialog').close());

  $('btn-play').onclick = () => {
    const parent = state.nodes.find(n => n.id === selectedParent);
    if (!parent) return toast('先点击选择一个要连接的词');
    $('play-parent').textContent = parent.word;
    $('play-word').value = '';
    $('play-reason').value = '';
    $('play-relation').innerHTML = state.ruleSet.allowedRelations.map(id => {
      const t = state.relationTypes.find(t => t.id === id);
      return `<option value="${id}">${t.name}（${t.example}）</option>`;
    }).join('');
    $('play-minlen').textContent = `解释至少 ${state.ruleSet.minReasonLen} 字` +
      (state.ruleSet.allowProperNouns ? '；允许专有名词' : '；不允许专有名词');
    openDialog('dlg-play');
  };

  $('play-submit').onclick = () => {
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    send({ type: 'play', word: $('play-word').value, parentId: selectedParent,
      relation: $('play-relation').value, reason: $('play-reason').value });
    closeDialog('dlg-play');
    selectedParent = null;
  };

  $('btn-reinforce').onclick = () => {
    reinforceMode = !reinforceMode;
    if (reinforceMode) toast('点击你的一条未加固连接进行加固');
    render();
  };

  $('btn-endturn').onclick = () => {
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    send({ type: 'endTurn' });
  };

  function openChallengeConfirm() {
    const n = state.nodes.find(x => x.id === challengeNodeId);
    if (!n) return;
    $('challenge-target').innerHTML =
      `目标：<b>${esc(n.word)}</b>（${esc(playerName(state, n.ownerId))}：${esc(n.reason)}）`;
    openDialog('dlg-challenge');
  }
  $('challenge-submit').onclick = () => {
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    send({ type: 'challenge', nodeId: challengeNodeId });
    closeDialog('dlg-challenge');
  };

  function openJudge() {
    const ch = state && state.pendingChallenge;
    if (!ch) return;
    const node = state.nodes.find(n => n.id === ch.nodeId);
    if (!node) return;
    const rel = (state.relationTypes.find(r => r.id === node.relation) || {}).name || '';
    const parent = state.nodes.find(n => n.id === node.parentId);
    $('judge-detail').innerHTML =
      `<p><b>${esc(playerName(state, ch.challengerId))}</b> 质疑了
       <b>${esc(playerName(state, node.ownerId))}</b> 的连接：</p>
       <p style="margin:8px 0">「${parent ? esc(parent.word) : '?'}」—<b>${rel}</b>→「${esc(node.word)}」</p>
       <p>解释：${esc(node.reason)}</p>`;
    $('judge-rules').innerHTML = rulesSummary(state.ruleSet);
    if (!$('dlg-judge').open) openDialog('dlg-judge');
  }
  // 裁定未作出前不允许关闭弹窗（Esc / 取消），避免整局卡死
  $('dlg-judge').addEventListener('cancel', (e) => e.preventDefault());
  $('btn-goto-judge').onclick = () => openJudge();
  // 断线期间裁定同样会丢失：不发送、不关闭弹窗，恢复后可直接重试
  $('judge-uphold').onclick = () => {
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    send({ type: 'resolve', verdict: 'uphold' }); closeDialog('dlg-judge');
  };
  $('judge-reject').onclick = () => {
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    send({ type: 'resolve', verdict: 'reject' }); closeDialog('dlg-judge');
  };

  $('btn-rules-view').onclick = () => {
    $('rules-view').innerHTML = rulesSummary(state.ruleSet);
    openDialog('dlg-rules');
  };

  // ---------- 回放 ----------

  // 关键事件帧（game.js buildReplay 的 frame.kind）→ 列表标签
  const REPLAY_EVENT_KINDS = {
    challenge: '质疑',
    demolish: '拆除',
    reinforce: '加固',
    autopilot: '托管',
    resume: '收回',
    adjudicator: '移交',
    end: '结算',
  };

  function openReplay() {
    renderReplayEvents();
    renderReplayFrame();
    openDialog('dlg-replay');
  }
  function renderReplayFrame() {
    const f = replayFrames[replayIdx];
    $('replay-label').textContent = f.label;
    $('replay-pos').textContent = `${replayIdx + 1} / ${replayFrames.length}`;
    const progress = $('replay-progress');
    progress.max = replayFrames.length - 1;
    progress.value = replayIdx;
    // 高亮当前帧对应的关键事件
    $('replay-events').querySelectorAll('.ev-item').forEach(el => {
      el.classList.toggle('current', Number(el.dataset.idx) === replayIdx);
    });
    renderBoard($('replay-board'), f.nodes, {
      collectable: true,
      onCollect: (nodeId) => collectFromReplay(f.nodes, nodeId),
    });
  }

  // 关键事件列表：质疑 / 拆除 / 加固 / 结算，点一下直接跳到那一帧。
  // 条目用原生 <button>：可 Tab 聚焦、回车/空格触发，键盘用户同样能跳帧。
  function renderReplayEvents() {
    const box = $('replay-events');
    const items = [];
    replayFrames.forEach((f, i) => {
      const tag = REPLAY_EVENT_KINDS[f.kind];
      if (!tag) return;
      items.push(`<li><button type="button" class="ev-item ev-${f.kind}" data-idx="${i}">` +
        `<span class="ev-tag">${tag}</span>` +
        `<span class="ev-step">第 ${i + 1} 步</span>` +
        `<span class="ev-label">${esc(f.label)}</span></button></li>`);
    });
    box.innerHTML = items.join('');
    $('replay-events-title').classList.toggle('hidden', items.length === 0);
    box.querySelectorAll('.ev-item').forEach(el => {
      el.onclick = () => { replayIdx = Number(el.dataset.idx); renderReplayFrame(); };
    });
  }

  // 从回放某一帧收藏一条连接：保存前词、后词、关系、原解释与来源房间
  function collectFromReplay(nodes, nodeId) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node || !node.parentId) return;
    const parent = nodes.find(n => n.id === node.parentId);
    if (!parent) return;
    const entry = WTFav.makeEntry(node, parent, {
      roomCode: state.code, relationTypes: state.relationTypes,
    });
    if (!entry) return;
    const { entries, added } = WTFav.add(store.favorites, entry);
    if (!added) return toast('这条连接已经收藏过了');
    store.favorites = entries;
    toast(`已收藏「${entry.front} → ${entry.back}」`);
    renderReplayFrame(); // 刷新"已收藏"标记
  }
  $('replay-prev').onclick = () => { if (replayIdx > 0) { replayIdx--; renderReplayFrame(); } };
  $('replay-next').onclick = () => { if (replayIdx < replayFrames.length - 1) { replayIdx++; renderReplayFrame(); } };
  // 进度条：点击/拖动直接跳到对应帧
  $('replay-progress').oninput = (e) => {
    if (!replayFrames || !replayFrames.length) return;
    replayIdx = Math.min(replayFrames.length - 1, Math.max(0, Number(e.target.value)));
    renderReplayFrame();
  };
  $('btn-replay').onclick = () => send({ type: 'replay' });
  $('btn-replay2').onclick = () => send({ type: 'replay' });

  // ---------- 首页 / 大厅事件 ----------

  $('inp-name').value = store.name;
  $('btn-create').onclick = () => {
    const name = $('inp-name').value.trim() || '玩家';
    store.name = name;
    send({ type: 'createRoom', name, pidSecret: store.pidSecret });
  };
  $('btn-join').onclick = () => {
    const name = $('inp-name').value.trim() || '玩家';
    const code = $('inp-code').value.trim().toUpperCase();
    if (code.length !== 4) return ($('home-error').textContent = '请输入 4 位房间码');
    store.name = name;
    send({ type: 'joinRoom', name, pidSecret: store.pidSecret, roomCode: code });
  };
  $('btn-spectate').onclick = () => {
    const code = $('inp-code').value.trim().toUpperCase();
    if (code.length !== 4) return ($('home-error').textContent = '请输入 4 位房间码');
    // 观战身份是临时的、只读的；昵称可选，不写入本地
    send({ type: 'spectate', name: $('inp-name').value.trim() || '观战者', roomCode: code });
  };
  // 退出观战：丢弃临时观战 token，回到首页（不影响房间内对局）
  const exitSpectate = () => { store.token = null; location.reload(); };
  $('btn-exit-spectate').onclick = exitSpectate;
  $('btn-exit-spectate2').onclick = exitSpectate;
  $('btn-exit-spectate3').onclick = exitSpectate;

  // ---------- 规则编辑器 ----------
  // 打开时完整回填当前规则；保存前就地校验；等服务器确认（rulesSaved）后再关闭，
  // 失败时编辑器保持打开、错误就地显示，已填内容不丢失。

  function flashRulesCard() {
    const card = $('rules-card');
    card.classList.remove('flash');
    void card.offsetWidth; // 重新触发动画
    card.classList.add('flash');
  }

  function clearRuleErrors() {
    document.querySelectorAll('#rules-editor .field-error').forEach(el => { el.textContent = ''; });
    document.querySelectorAll('#rules-editor input').forEach(el => el.classList.remove('invalid'));
  }

  function showRuleError(errId, inputId, msg) {
    $(errId).textContent = msg;
    if (inputId) $(inputId).classList.add('invalid');
  }

  // 用当前生效的规则完整回填编辑器，并清掉上次遗留的错误提示
  function fillRulesEditor() {
    const r = state.ruleSet;
    $('rules-relations').innerHTML = state.relationTypes.map(t =>
      `<label><input type="checkbox" data-rel="${t.id}" ${r.allowedRelations.includes(t.id) ? 'checked' : ''}>
       ${t.name}（${t.example}）</label>`).join('');
    $('rule-proper').checked = r.allowProperNouns;
    for (const f of WTRules.NUMBER_FIELDS) $(f.id).value = r[f.key];
    clearRuleErrors();
  }

  // 收集输入并校验；通过则返回可提交的 ruleSet，否则就地标出错误并返回 null
  function validateRulesEditor() {
    clearRuleErrors();
    const input = {
      allowedRelations: [...document.querySelectorAll('[data-rel]:checked')].map(x => x.dataset.rel),
    };
    for (const f of WTRules.NUMBER_FIELDS) input[f.key] = $(f.id).value;
    const { errors, ruleSet } = WTRules.validateRuleSet(input);
    for (const [key, msg] of Object.entries(errors)) {
      if (key === 'allowedRelations') showRuleError('err-rule-relations', null, msg);
      else {
        const f = WTRules.NUMBER_FIELDS.find(x => x.key === key);
        showRuleError(`err-${f.id}`, f.id, msg);
      }
    }
    if (Object.keys(errors).length > 0) return null;
    ruleSet.allowProperNouns = $('rule-proper').checked;
    return ruleSet;
  }

  // 提交锁定只能由两种确定结果解除：服务器答复（rulesSaved / 带 setRules 上下文的 error），
  // 或连接断开（onclose，此次请求不会再有答复）。不能用定时器自动解除——
  // 网络延迟超过定时时长而服务器尚未确认时，锁会被误解除，导致重复提交。
  function setRulesSavePending(pending) {
    rulesSavePending = pending;
    $('btn-save-rules').disabled = pending || roomOffline();
  }

  function onRulesSaved() {
    setRulesSavePending(false);
    $('rules-editor').classList.add('hidden');
    toast('规则已保存');
  }

  function onRulesSaveError(message) {
    setRulesSavePending(false);
    if ($('rules-editor').classList.contains('hidden')) $('rules-editor').classList.remove('hidden');
    showRuleError('err-rules-general', null, message);
  }

  $('btn-edit-rules').onclick = () => {
    const editor = $('rules-editor');
    if (editor.classList.contains('hidden')) {
      fillRulesEditor();
      editor.classList.remove('hidden');
    } else {
      editor.classList.add('hidden');
    }
  };
  $('btn-cancel-rules').onclick = () => $('rules-editor').classList.add('hidden');
  $('btn-save-rules').onclick = () => {
    if ($('btn-save-rules').disabled) return;
    const ruleSet = validateRulesEditor();
    if (!ruleSet) return; // 校验未通过：错误已就地标出，不发送
    setRulesSavePending(true);
    send({ type: 'setRules', ruleSet });
  };
  $('btn-start').onclick = () => {
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    send({ type: 'startGame' });
  };
  $('btn-home').onclick = () => { store.token = null; location.reload(); };

  // ---------- 赛季排行榜 / 个人页 ----------

  $('btn-rank-home').onclick = openRank;
  $('btn-my-profile').onclick = () => askProfile({ pidSecret: store.pidSecret });
  $('btn-sort-total').onclick = () => { rankSort = 'total'; askLeaderboard(); };
  $('btn-sort-wins').onclick = () => { rankSort = 'wins'; askLeaderboard(); };
  $('btn-sort-rate').onclick = () => { rankSort = 'rate'; askLeaderboard(); };
  // 昵称搜索：纯前端过滤已拉取的榜单，人多时不用翻表；输入即过滤，大小写不敏感
  $('rank-search-input').oninput = (e) => { rankQuery = e.target.value || ''; renderRank(); };
  $('btn-rank-back').onclick = () => showScreen('home');
  $('btn-rank-my').onclick = () => askProfile({ pidSecret: store.pidSecret });
  $('btn-profile-back-rank').onclick = backToRank;
  $('btn-profile-back-home').onclick = () => showScreen('home');
  // 结算后可直接进排行榜（连接与房间状态保留，返回首页/重连不受影响）
  $('btn-end-rank').onclick = openRank;

  // ---------- 战术练习（单机，纯前端；进度存本浏览器） ----------

  let prSession = null, prReinforceMode = false;

  function renderPracticeList() {
    const done = store.practice;
    $('practice-list').innerHTML = WTPractice.SCENARIOS.map((s, i) => {
      const isDone = !!done[s.id];
      return `<li>
        <div>
          <div class="pl-title">${esc(s.title)} ${isDone ? '<span class="badge done">已通关</span>' : ''}</div>
          <div class="pl-sub">${esc(s.subtitle)}</div>
        </div>
        <button class="link" data-sid="${i}">${isDone ? '再练一次' : '开始'}</button>
      </li>`;
    }).join('');
    $('practice-list').querySelectorAll('[data-sid]').forEach(btn => {
      btn.onclick = () => openScenario(WTPractice.SCENARIOS[Number(btn.dataset.sid)].id);
    });
  }

  function openScenario(id) {
    prSession = WTPractice.startSession(id);
    prReinforceMode = false;
    const s = prSession.scenario;
    $('pr-title').textContent = s.title;
    $('pr-subtitle').textContent = s.subtitle;
    $('pr-goal').textContent = s.goal;
    $('pr-ops').innerHTML = s.ops.map(o => `<li>${esc(o)}</li>`).join('');
    showScreen('practice-game');
    renderPracticeGame();
  }

  function renderPracticeGame() {
    if (!prSession) return;
    const sc = prSession.scenario;

    // 双方当前分数（提交后即结算分数）
    const youTotal = prSession.result
      ? prSession.result.scores.you.after
      : WTPractice.scoreBreakdown(prSession.nodes, WTPractice.YOU).total;
    const oppTotal = prSession.result
      ? prSession.result.scores.opp.after
      : WTPractice.scoreBreakdown(prSession.nodes, WTPractice.OPP).total;
    $('pr-scoreboard').innerHTML = WTPractice.PLAYERS.map(p => {
      const total = p.id === WTPractice.YOU ? youTotal : oppTotal;
      return `<span class="score-chip active"><span class="dot" style="background:${p.color}"></span>${esc(p.name)} · ${total} 分</span>`;
    }).join('');

    // 行动点（级联关没有行动点概念，隐藏整行）
    $('pr-ap').textContent = sc.mode === 'cascade'
      ? ''
      : `你的行动点：${prSession.apLeft} / ${sc.ap}`;

    // 操作提示
    let hint = '';
    if (!prSession.finished) {
      if (sc.mode === 'extend') {
        if (prSession.apLeft > 0) hint = '点下方「接词」选择候选词，接完后「提交答案」结算';
        else hint = '行动点已用完，点「提交答案」查看结算（也可重置重来）';
      } else if (sc.mode === 'protect') {
        if (prReinforceMode) hint = '点击你的一条未加固连接进行加固（再点「加固」取消选择）';
        else if (prSession.apLeft > 0) hint = '点「加固」选择一条连接，提交后对手会质疑让你失分最多的目标';
        else hint = '已用掉加固机会，点「提交答案」看对手如何质疑（也可重置重来）';
      } else if (sc.mode === 'cascade') {
        const n = prSession.nodes.find(x => x.id === prSession.pendingChallengeId);
        hint = n ? `已选中要质疑的「${n.word}」，点「提交答案」拆除（再点该词取消）` : '点击对手的一条未加固连接作为质疑目标';
      }
    }
    $('pr-hint').textContent = hint;

    renderPracticeBoard();

    // 按钮可用性
    $('btn-pr-play').style.display = sc.mode === 'extend' ? '' : 'none';
    $('btn-pr-reinforce').style.display = sc.mode === 'protect' ? '' : 'none';
    $('btn-pr-play').disabled = prSession.finished || prSession.apLeft < 1;
    $('btn-pr-reinforce').disabled = prSession.finished || prSession.apLeft < 1;
    $('btn-pr-reinforce').textContent = prReinforceMode ? '取消加固' : '加固';
    $('btn-pr-submit').disabled = prSession.finished ||
      (sc.mode === 'cascade' && !prSession.pendingChallengeId);

    renderPracticeResult();
  }

  function renderPracticeBoard() {
    const sc = prSession.scenario;
    const colorOf = (ownerId) => {
      if (!ownerId) return '#999';
      const p = WTPractice.PLAYERS.find(x => x.id === ownerId);
      return p ? p.color : '#999';
    };
    // 按树形缩进展示（与正式对局同一套结构）
    const children = new Map();
    for (const n of prSession.nodes) {
      const key = n.parentId || '';
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(n);
    }
    const html = [];
    const walk = (parentId, depth) => {
      for (const n of children.get(parentId) || []) {
        html.push(prNodeHtml(n, depth, colorOf));
        walk(n.id, depth + 1);
      }
    };
    walk('', 0);
    $('pr-board').innerHTML = html.join('');
    $('pr-board').querySelectorAll('.node').forEach(el => {
      el.onclick = () => prNodeClick(el.dataset.id);
    });
  }

  function prNodeHtml(n, depth, colorOf) {
    const badges = [];
    if (n.reinforced && n.parentId) badges.push('<span class="badge shield">已加固</span>');
    if (n.survivedAsRoot) badges.push('<span class="badge shield">幸存根</span>');
    const classes = ['node'];
    if (!n.ownerId) classes.push('start');
    if (prSession.pendingChallengeId === n.id) classes.push('pending');
    if (prSession.scenario.mode === 'protect' && prReinforceMode &&
        n.ownerId === WTPractice.YOU && n.parentId && !n.reinforced &&
        prSession.apLeft > 0 && !prSession.finished) classes.push('reinforced-target');
    const ownerName = n.ownerId === WTPractice.YOU ? '你' : '对手';
    const meta = n.ownerId
      ? `${ownerName} · ${WTPractice.relationName(n.relation)} · ${esc(n.reason || '')}`
      : '起始词';
    return `<div class="${classes.join(' ')}" data-id="${n.id}"
      style="margin-left:${depth * 22}px; border-left-color:${colorOf(n.ownerId)}">
      <span class="word">${esc(n.word)}</span>
      <div class="meta">${meta}</div>
      <div class="badges">${badges.join('')}</div>
    </div>`;
  }

  function prNodeClick(nodeId) {
    if (!prSession || prSession.finished) return;
    const sc = prSession.scenario;
    if (sc.mode === 'protect') {
      if (!prReinforceMode) return;
      const err = WTPractice.reinforce(prSession, nodeId);
      if (err) return toast(err);
      prReinforceMode = false;
      renderPracticeGame();
    } else if (sc.mode === 'cascade') {
      const err = WTPractice.selectChallenge(prSession, nodeId);
      if (err) return toast(err);
      renderPracticeGame();
    }
  }

  function renderPracticeResult() {
    const box = $('pr-result');
    const r = prSession.result;
    if (!r) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const deltaHtml = (s) => {
      const d = s.after - s.before;
      const cls = d < 0 ? 'delta-down' : d > 0 ? 'delta-up' : '';
      const txt = d === 0 ? '不变' : `${d > 0 ? '+' : ''}${d}`;
      return `<span><span class="dot" style="background:${s.name === '你' ? WTPractice.PLAYERS[0].color : WTPractice.PLAYERS[1].color}"></span>
        ${esc(s.name)}：${s.before} → ${s.after} 分 <span class="${cls}">(${txt})</span></span>`;
    };
    box.className = `card result ${r.passed ? 'pass' : 'fail'}`;
    box.classList.remove('hidden');
    box.innerHTML = `<h3>${r.passed ? '✅ 通关！' : '还没达成最优，再想想'}</h3>
      <div class="pr-scores">${deltaHtml(r.scores.you)}${deltaHtml(r.scores.opp)}</div>
      <ol class="pr-lines">${r.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ol>`;
  }

  $('btn-practice').onclick = () => { renderPracticeList(); showScreen('practice'); };
  $('btn-practice-back').onclick = () => showScreen('home');
  $('btn-practice-exit').onclick = () => {
    prSession = null;
    renderPracticeList();
    showScreen('practice');
  };

  $('btn-pr-play').onclick = () => {
    if (!prSession || prSession.finished) return;
    const sc = prSession.scenario;
    $('pr-pick-list').innerHTML = sc.palette.map(m => {
      const used = prSession.nodes.some(n => n.id === m.id);
      const unlocked = prSession.nodes.some(n => n.id === m.parent);
      const locked = used || !unlocked;
      return `<li class="${locked ? 'locked' : ''}" data-move="${m.id}">
        <span class="pk-word">「${esc(m.word)}」</span> 接到「${esc(WTPractice.parentWord(sc, m.parent))}」后面
        <div class="pk-meta">${WTPractice.relationName(m.relation)} · ${esc(m.reason)}${used ? ' · 已在场上' : unlocked ? '' : ' · 前置词还没接上'}</div>
      </li>`;
    }).join('');
    $('pr-pick-list').querySelectorAll('[data-move]').forEach(li => {
      li.onclick = () => {
        if (li.classList.contains('locked')) return;
        const err = WTPractice.playWord(prSession, li.dataset.move);
        if (err) { toast(err); return; }
        closeDialog('dlg-practice-pick');
        renderPracticeGame();
      };
    });
    openDialog('dlg-practice-pick');
  };

  $('btn-pr-reinforce').onclick = () => {
    if (!prSession || prSession.finished) return;
    prReinforceMode = !prReinforceMode;
    if (prReinforceMode) toast('点击你的一条未加固连接进行加固');
    renderPracticeGame();
  };

  $('btn-pr-submit').onclick = () => {
    if (!prSession || prSession.finished) return;
    prReinforceMode = false;
    const r = WTPractice.submit(prSession);
    if (typeof r === 'string') { toast(r); return; }
    if (r.passed) {
      store.markPracticeDone(prSession.scenario.id);
      toast('通关！进度已保存在本浏览器');
    }
    renderPracticeGame();
  };

  $('btn-pr-reset').onclick = () => {
    if (!prSession) return;
    WTPractice.resetSession(prSession);
    prReinforceMode = false;
    renderPracticeGame();
  };

  // ---------- 个人收藏本（纯本地，不经过服务器） ----------

  function renderFavStats() {
    const s = WTFav.stats(store.favorites);
    $('fav-stats').innerHTML =
      `<span>共 ${s.total} 条</span>
       <span class="fav-known">已记住 ${s.known}</span>
       <span class="fav-need">还要复习 ${s.needReview}</span>
       <span class="fav-fresh">未复习 ${s.fresh}</span>`;
  }

  // 重建关系筛选下拉；只在可选项真正变化时重写，避免搜索打字时下拉被重建
  function renderFavFilterOptions() {
    const sel = $('fav-relation-filter');
    const rels = WTFav.usedRelations(store.favorites);
    const wantIds = ['', ...rels.map(r => r.id)];
    const haveIds = [...sel.options].map(o => o.value);
    const same = wantIds.length === haveIds.length && wantIds.every((id, i) => id === haveIds[i]);
    if (same) return;
    sel.innerHTML = '<option value="">全部关系</option>' +
      rels.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
    sel.value = rels.some(r => r.id === favRelation) ? favRelation : '';
    favRelation = sel.value;
  }

  function renderFavList() {
    renderFavFilterOptions();
    renderFavStats();
    const list = WTFav.filter(store.favorites, { keyword: favKeyword, relation: favRelation });
    const ul = $('fav-list');
    $('fav-empty').classList.toggle('hidden', store.favorites.length > 0);
    if (!list.length) {
      ul.innerHTML = store.favorites.length
        ? '<li class="fav-none">没有符合条件的收藏</li>' : '';
      return;
    }
    const statusBadge = (e) =>
      e.status === 'known' ? '<span class="badge fav-known-b">记住了</span>'
      : e.status === 'needReview' ? '<span class="badge fav-need-b">还要复习</span>'
      : '<span class="badge">未复习</span>';
    ul.innerHTML = list.map(e => `
      <li class="fav-item" data-key="${esc(e.key)}">
        <div class="fav-pair">
          <b>${esc(e.front)}</b>
          <span class="fav-arrow">—<span class="badge shield">${esc(e.relationName)}</span>→</span>
          <b>${esc(e.back)}</b>
          ${statusBadge(e)}
        </div>
        <div class="fav-reason">${esc(e.reason)}</div>
        <div class="fav-meta">来源房间 <span class="h-code">${esc(e.roomCode || '—')}</span>
          · 收藏于 ${fmtDate(e.savedAt)}</div>
        <textarea class="fav-note" rows="2" placeholder="补充你的笔记…">${esc(e.note)}</textarea>
        <div class="row fav-ops">
          <button class="link fav-save-note">保存笔记</button>
          <button class="link fav-del danger-link">删除收藏</button>
        </div>
      </li>`).join('');
    ul.querySelectorAll('.fav-item').forEach(li => {
      const key = li.dataset.key;
      li.querySelector('.fav-save-note').onclick = () => {
        const note = li.querySelector('.fav-note').value;
        store.favorites = WTFav.updateNote(store.favorites, key, note);
        toast('笔记已保存');
      };
      li.querySelector('.fav-del').onclick = () => {
        if (!confirm('删除这条收藏？相关复习记录会一并移除。')) return;
        store.favorites = WTFav.remove(store.favorites, key);
        renderFavList();
      };
    });
  }

  function openFav() {
    favKeyword = $('fav-search').value = '';
    renderFavList();
    showScreen('fav');
  }

  $('btn-fav-home').onclick = openFav;
  $('btn-fav-back').onclick = () => showScreen('home');
  $('fav-search').addEventListener('input', (e) => {
    favKeyword = e.target.value;
    renderFavList();
  });
  $('fav-relation-filter').onchange = (e) => {
    favRelation = e.target.value;
    renderFavList();
  };
  $('btn-fav-review').onclick = startReviewFlow;

  // ---------- 复习模式 ----------

  function startReviewFlow() {
    // 进入复习时以当前筛选结果为复习范围（默认全部）
    const pool = WTFav.filter(store.favorites, { keyword: favKeyword, relation: favRelation });
    reviewSession = WTFav.startReview(pool);
    if (!reviewSession) return toast('暂无可复习的收藏');
    showScreen('review');
    renderReview();
  }

  function renderReview() {
    const s = reviewSession;
    if (!s) return;
    const p = WTFav.progress(s);
    $('review-progress').textContent = `第 ${Math.min(p.done + 1, p.total)} / ${p.total} 张`;
    const finishedBox = $('review-finished');
    const cardBox = $('review-card-box');
    if (s.finished) {
      finishedBox.classList.remove('hidden');
      cardBox.classList.add('hidden');
      $('review-summary').textContent =
        `本轮共复习 ${p.total} 张，其中 ${p.needReview} 张标记为「还要复习」，下一轮会优先出现。`;
      return;
    }
    finishedBox.classList.add('hidden');
    cardBox.classList.remove('hidden');
    const e = WTFav.current(s);
    $('review-front-word').textContent = e.front;
    $('review-relation').textContent = e.relationName;
    $('review-back-word').textContent = e.back;
    $('review-reason').textContent = e.reason;
    $('review-source').textContent = `来源房间 ${e.roomCode || '—'}`;
    $('review-note-box').innerHTML = e.note
      ? `<div class="hint">我的笔记</div><p class="fav-note-view">${esc(e.note)}</p>` : '';
    $('review-back').classList.toggle('hidden', !s.revealed);
    $('btn-reveal').classList.toggle('hidden', s.revealed);
    $('btn-known').classList.toggle('hidden', !s.revealed);
    $('btn-need-review').classList.toggle('hidden', !s.revealed);
  }

  $('btn-review-exit').onclick = () => { reviewSession = null; renderFavList(); showScreen('fav'); };
  $('btn-review-to-fav').onclick = () => { reviewSession = null; renderFavList(); showScreen('fav'); };
  $('btn-review-again').onclick = startReviewFlow;
  $('btn-reveal').onclick = () => { reviewSession = WTFav.reveal(reviewSession); renderReview(); };
  $('btn-known').onclick = () => applyReviewMark('known');
  $('btn-need-review').onclick = () => applyReviewMark('needReview');

  // 标记当前卡片，并把结果写回完整收藏（按 key 匹配，不丢未参与本轮的条目）
  function applyReviewMark(verdict) {
    if (!reviewSession) return;
    const { session, entries } = WTFav.mark(reviewSession, store.favorites, verdict);
    reviewSession = session;
    store.favorites = entries;
    renderReview();
  }

  // ---------- 我的词包（本机管理；分享时词包快照发到服务器，朋友凭码导入） ----------

  let editingPackId = null; // null=编辑器关闭；''=新建；否则为正在编辑的词包 id
  let shareDialogPackId = null; // 分享码弹窗当前对应的词包（null=关闭）；''=更新分享但本机包已删

  function openPacks() {
    closePackEditor();
    showScreen('packs');
    requestMyShares();
    requestMyPlaza();
    renderPacks();
  }

  // 与服务端对账我的分享：以服务端列表为准（跨设备分享的也出现、已取消的消失）。
  // 离线时 send 返回 false，直接渲染本机缓存即可（不阻塞打开页面）。
  function requestMyShares() {
    send({ type: 'myShares', pidSecret: store.pidSecret });
    if (!$('screen-packs').classList.contains('hidden')) renderPacks();
  }

  // 跨设备认领：服务端列表里每条「我的分享/发布」都带作者原始 packId；本机若有一份
  // 从该来源导入/订阅来的副本（importedFrom/plazaId 标记），说明它就是同一身份在另一台
  // 设备上发布的同一个词包——把本机副本的 id 改写回稳定 packId，使徽标/更新/取消合流，
  // 跨设备区里不再残留「本机有副本却显示成孤儿」的错位。对所有映射幂等，重复对账无副作用。
  // 返回认领的数量；是否提示由调用方决定（导入/订阅流程本身已有 toast，避免叠两条）。
  function healAdoptedPacks() {
    let packs = store.packs;
    let adopted = 0;
    for (const s of store.packShares) {
      if (!s.packId) continue;
      const r = WTPacks.adoptRemotePack(packs, 'share', { matchId: s.packId, targetId: s.packId });
      if (r.changed) adopted += 1;
      packs = r.packs;
    }
    const plazaLib = globalThis.WTPlaza;
    if (plazaLib) {
      for (const m of store.plazaMine) {
        if (!m.packId || !m.id) continue;
        const r = WTPacks.adoptRemotePack(packs, 'plaza', { matchId: m.id, targetId: m.packId });
        if (r.changed) adopted += 1;
        packs = r.packs;
      }
    }
    if (adopted) store.packs = packs;
    return adopted;
  }

  function onMyShares(remote) {
    store.packShares = WTShares.reconcileLocal(store.packShares, remote);
    if (healAdoptedPacks()) toast('已把另一台设备上的词包认领回本机');
    renderPacks();
  }

  function renderPacks() {
    if ($('screen-packs').classList.contains('hidden')) return;
    const packs = store.packs;
    const myShares = store.packShares;
    const plazaLib = globalThis.WTPlaza || null; // 旧测试桩可能未加载 plaza.js
    const myPlaza = plazaLib ? store.plazaMine : [];
    $('pack-empty').classList.toggle('hidden', packs.length > 0);
    $('pack-list').innerHTML = packs.map(p => {
      const sh = WTShares.findLocalByPackId(myShares, p.id);
      // 广场徽标按本机映射的「条目 id」匹配（认领回自己的发布后，词包 id 已等于作者 packId）；
      // 兼容历史：订阅副本（已删除映射的老数据）仍带 plazaId，也能显示徽标
      const pub = plazaLib
        ? (plazaLib.findLocalByPackId(myPlaza, p.id) || myPlaza.find(m => m.id === p.plazaId) || null)
        : null;
      return `
      <li>
        <div>
          <div class="pl-title">${esc(p.name)} <span class="badge shield">${p.words.length} 词</span>${
            sh ? `<span class="badge share-badge" data-pack-code="${sh.code}">分享码 ${WTShares.formatCode(sh.code)}</span>` : ''
          }${
            pub ? '<span class="badge plaza-badge">已发布到广场</span>' : ''
          }</div>
          <div class="pl-sub">${p.theme ? esc(p.theme) : '（无主题说明）'}</div>
          <div class="pl-sub">候选词：${p.words.slice(0, 8).map(esc).join('、')}${p.words.length > 8 ? ' …' : ''}</div>
        </div>
        <div class="row">
          <button class="link" data-pack-edit="${p.id}">编辑</button>
          <button class="link" data-pack-share="${p.id}">${sh ? '分享码' : '分享'}</button>
          ${plazaLib ? `<button class="link" data-pack-pub="${p.id}">${pub ? '更新发布' : '发布到广场'}</button>` : ''}
          ${pub ? `<button class="link danger-link" data-pack-unpub="${pub.id}">下架</button>` : ''}
          <button class="link danger-link" data-pack-del="${p.id}">删除</button>
        </div>
      </li>`;
    }).join('');
    $('pack-list').querySelectorAll('[data-pack-edit]').forEach(btn => {
      btn.onclick = () => openPackEditor(btn.dataset.packEdit);
    });
    $('pack-list').querySelectorAll('[data-pack-share]').forEach(btn => {
      btn.onclick = () => onPackShareClick(btn.dataset.packShare);
    });
    $('pack-list').querySelectorAll('[data-pack-pub]').forEach(btn => {
      btn.onclick = () => {
        const p = WTPacks.find(store.packs, btn.dataset.packPub);
        if (p) publishPackToPlaza(p);
      };
    });
    $('pack-list').querySelectorAll('[data-pack-unpub]').forEach(btn => {
      btn.onclick = () => confirmPlazaUnpublish(btn.dataset.packUnpub);
    });
    $('pack-list').querySelectorAll('[data-pack-del]').forEach(btn => {
      btn.onclick = () => {
        const p = WTPacks.find(store.packs, btn.dataset.packDel);
        if (!p) return;
        const shared = !!WTShares.findLocalByPackId(store.packShares, p.id);
        const published = !!(plazaLib && (plazaLib.findLocalByPackId(store.plazaMine, p.id) ||
          store.plazaMine.find(m => m.id === p.plazaId)));
        const extra = [
          shared ? '\n该词包的分享仍对朋友有效，可在页面下方「其他设备上分享的词包」中取消。' : '',
          published ? '\n该词包仍在交流广场上，可在页面下方「其他设备上发布的词包」中下架。' : '',
        ].join('');
        const msg = `删除词包「${p.name}」？已选用它的房间不受影响（房间里是快照）。${extra}`;
        if (!confirm(msg)) return;
        store.packs = WTPacks.remove(store.packs, p.id);
        if (editingPackId === p.id) closePackEditor();
        renderPacks();
        toast('词包已删除');
      };
    });
    renderSharedOrphans();
    renderPlazaOrphans();
  }

  // 其他设备分享、或本机词包已删除但服务端仍有效的码：单独列出以便取消。
  function renderSharedOrphans() {
    const packIds = new Set(store.packs.map(p => p.id));
    const orphans = store.packShares.filter(s => !packIds.has(s.packId));
    const box = $('shared-orphans');
    box.classList.toggle('hidden', orphans.length === 0);
    if (!orphans.length) return;
    $('shared-orphan-list').innerHTML = orphans.map(s => `
      <li>
        <div>
          <div class="pl-title">${esc(s.name || '未命名词包')} <span class="badge shield">分享码 ${WTShares.formatCode(s.code)}</span></div>
          <div class="pl-sub">本机已无此词包，分享对朋友仍然有效</div>
        </div>
        <div class="row">
          <button class="link" data-orphan-copy="${s.code}">复制码</button>
          <button class="link danger-link" data-orphan-cancel="${s.code}">取消分享</button>
        </div>
      </li>`).join('');
    $('shared-orphan-list').querySelectorAll('[data-orphan-copy]').forEach(btn => {
      btn.onclick = () => copyText(WTShares.formatCode(btn.dataset.orphanCopy), '分享码已复制');
    });
    $('shared-orphan-list').querySelectorAll('[data-orphan-cancel]').forEach(btn => {
      btn.onclick = () => confirmUnshare(btn.dataset.orphanCancel, '');
    });
  }

  // ---------- 分享 / 取消分享 ----------

  // 列表「分享 / 分享码」：已分享直接打开弹窗（可复制/更新/取消）；未分享则发布。
  function onPackShareClick(packId) {
    const p = WTPacks.find(store.packs, packId);
    if (!p) return;
    const sh = WTShares.findLocalByPackId(store.packShares, packId);
    if (sh) { openShareDialog(p, sh.code); return; }
    shareCurrentPack(p);
  }

  // 若本机词包是从自己的分享码导入的副本（跨设备场景），找出它对应的有效码：
  // 更新分享时带上该码，服务端覆盖同一条分享而不是再发一个新码。
  // 认领回稳定 id 后，本机映射已直接按 packId 对上，优先按 packId 找。
  function ownShareCodeForPack(p) {
    if (!p) return '';
    const byPackId = WTShares.findLocalByPackId(store.packShares, p.id);
    if (byPackId) return byPackId.code;
    if (p.importedFrom) {
      const m = WTShares.findLocalByPackId(store.packShares, p.importedFrom);
      if (m) return m.code;
    }
    return '';
  }

  function shareCurrentPack(p) {
    // 离线时 send 会统一提示"正在重连"，这里不额外弹"正在生成"，避免两条矛盾提示
    if (!send({
      type: 'sharePack', pidSecret: store.pidSecret,
      pack: { id: p.id, name: p.name, theme: p.theme, words: p.words },
      code: ownShareCodeForPack(p) || undefined,
    })) return;
    toast('正在生成分享码…');
  }

  // 服务端确认分享成功（新建或更新）：记下本机映射，弹窗展示码。
  // 码提示更新（跨设备）时服务端返回的 packId 是该码原有的稳定 id，可能与本机新副本
  // id 不同：本机映射记到稳定 id，并把本机副本认领/对齐到该 id，两边重新合流。
  function onPackShared(msg) {
    const code = WTShares.normalizeCode(msg.code);
    if (!WTShares.isValidCode(code)) return;
    const serverPackId = String(msg.packId || '');
    store.packShares = WTShares.upsertLocal(store.packShares,
      { code, packId: serverPackId, name: msg.name, updatedAt: msg.updatedAt || Date.now() });
    // 触发分享的本机词包（按当前列表找到的原始 id 与服务端稳定 id 不一致时）认领回来
    if (serverPackId) {
      const local = WTPacks.find(store.packs, serverPackId);
      if (!local) {
        const byImport = store.packs.find(p => p.importedFrom === serverPackId);
        if (byImport) {
          const r = WTPacks.adoptRemotePack(store.packs, 'share',
            { matchId: serverPackId, targetId: serverPackId });
          if (r.changed) store.packs = r.packs;
        }
      }
    }
    if (msg.republished) toast('分享内容已更新，朋友导入的始终是最新版本');
    // 仅当用户仍停留在词包页时弹窗，避免响应到达瞬间已切页而弹窗叠在别的页面上
    const p = WTPacks.find(store.packs, serverPackId);
    if (p && !$('dlg-share').open && !$('screen-packs').classList.contains('hidden')) {
      openShareDialog(p, code);
    }
    renderPacks();
  }

  function onShareError(message) {
    toast(message);
  }

  function openShareDialog(p, code) {
    shareDialogPackId = p ? p.id : '';
    $('share-title').textContent = p ? `分享词包「${p.name}」` : '分享词包';
    $('share-code').textContent = WTShares.formatCode(code);
    $('share-code').dataset.code = code;
    // 弹窗按钮随当前是否还有本机词包切换（本机包已删时只能取消分享）
    $('btn-share-update').classList.toggle('hidden', !p);
    $('share-updated-note').classList.toggle('hidden', !p);
    openDialog('dlg-share');
  }

  function confirmUnshare(code, packId) {
    const c = WTShares.normalizeCode(code);
    if (!WTShares.isValidCode(c)) return toast('分享码无效');
    if (!confirm(`取消分享 ${WTShares.formatCode(c)}？取消后该码立即作废，朋友无法再凭它导入（已导入朋友本机的词包不受影响）。`)) return;
    send({ type: 'unsharePack', pidSecret: store.pidSecret, code: c });
  }

  function onPackUnshared(code) {
    const c = WTShares.normalizeCode(code);
    store.packShares = WTShares.removeLocal(store.packShares, c);
    if (shareDialogCode() === c) {
      shareDialogPackId = null;
      closeDialog('dlg-share');
    }
    renderPacks();
    toast('分享已取消，该码已作废');
  }

  function onUnshareError(message) {
    // 服务端已无此码（如其他设备先取消了）：重新拉取列表对账，让本机残留自行消失
    if (/分享码无效|不是这个分享的作者/.test(message)) requestMyShares();
    toast(message);
  }

  // 下架失败（如别的设备已先下架）：重新拉取我的发布对账，让本机残留自行消失
  function onPlazaUnpublishError(message) {
    if (/没有这个词包|不是发布者/.test(message)) requestMyPlaza();
    toast(message);
  }

  const shareDialogCode = () => WTShares.normalizeCode($('share-code').dataset.code || '');

  // 复制到剪贴板：优先 Clipboard API，不可用时退化为选区 + execCommand
  function copyText(text, okMessage) {
    const done = () => toast(okMessage || '已复制');
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch { toast(`复制失败，请手动选择：${text}`); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else fallback();
  }

  $('btn-share-copy').onclick = () => copyText(WTShares.formatCode(shareDialogCode()), '分享码已复制');
  $('btn-share-update').onclick = () => {
    const p = WTPacks.find(store.packs, shareDialogPackId);
    if (!p) return toast('本机已没有这个词包');
    shareCurrentPack(p);
  };
  $('btn-share-cancel').onclick = () => confirmUnshare(shareDialogCode(), shareDialogPackId);

  // ---------- 凭码导入 ----------

  function onImportError(message) {
    $('err-pack-import').textContent = message;
  }

  function onImportedPack(msg) {
    const pack = msg.pack;
    if (!pack || !Array.isArray(pack.words)) {
      $('err-pack-import').textContent = '导入的词包数据无效';
      return;
    }
    // 去重 1：同一来源词包（作者 packId）已导入过，直接提示，不产生重复副本
    const existingBySource = store.packs.find(p => p.importedFrom === pack.id);
    if (existingBySource) {
      $('err-pack-import').textContent = '';
      $('pack-import-code').value = '';
      toast(`这个词包已经在你的列表里：「${existingBySource.name}」`);
      return;
    }
    // 去重 2：名称与候选词完全相同（不同码的同一内容）也不重复导入
    const dupContent = store.packs.find(p =>
      p.name === pack.name && JSON.stringify(p.words) === JSON.stringify(pack.words));
    if (dupContent) {
      $('err-pack-import').textContent = '';
      $('pack-import-code').value = '';
      toast(`你已经有相同的词包「${dupContent.name}」了`);
      return;
    }
    const { packs, error } = WTPacks.upsert(store.packs, {
      id: WTPacks.makeId(),
      name: pack.name, theme: pack.theme, words: pack.words,
      importedFrom: String(pack.id || ''), importedAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (error) { $('err-pack-import').textContent = error; return; }
    store.packs = packs;
    $('err-pack-import').textContent = '';
    $('pack-import-code').value = '';
    // 若导入的其实是自己在别的设备上分享的词包（来源 packId 已在「我的分享」里），
    // 立即认领回稳定 id，徽标/更新/取消合流，不留在本机列表里当普通导入副本。
    healAdoptedPacks();
    renderPacks();
    toast(`已导入词包「${pack.name}」，建房时可在大厅选用`);
  }

  $('btn-pack-import').onclick = () => {
    $('err-pack-import').textContent = '';
    const code = WTShares.normalizeCode($('pack-import-code').value);
    if (!WTShares.isValidCode(code)) {
      $('err-pack-import').textContent = '分享码应为 8 位字母数字（形如 ABCD-EFGH）';
      return;
    }
    send({ type: 'importShare', code });
  };
  $('pack-import-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-pack-import').onclick();
  });

  // ---------- 交流广场 ----------
  // 发布/下架在「我的词包」操作；浏览/搜索/订阅在广场页。订阅成功后词包存进本机
  // 词包列表（带 plazaId 来源标记防重复订阅），建房时与自建词包一样在大厅选用。

  let plazaPacks = null;    // null=尚未拉取/加载中；[]=空广场
  let plazaQuery = '';      // 搜索词（纯前端过滤）
  let plazaTheme = '';      // 主题筛选（''=全部）
  let plazaSort = 'hot';    // hot | new
  let plazaThemeSig = '';   // 主题下拉选项签名：广场数据变化时才重建，避免打字时下拉被重置

  // 只读请求：socket 不可用时不发送并提示（与排行榜同一处理）
  function askPlaza() {
    plazaPacks = null;
    if (!send({ type: 'plazaList', sort: plazaSort, pidSecret: store.pidSecret })) {
      toast('正在连接服务器，广场稍后再试');
    }
    renderPlaza();
  }

  function openPlaza() {
    showScreen('plaza');
    askPlaza();
  }

  function onPlazaList(msg) {
    plazaSort = msg.sort === 'new' ? 'new' : 'hot';
    plazaPacks = Array.isArray(msg.packs) ? msg.packs : [];
    renderPlaza();
  }

  // 主题筛选下拉：选项来自当前广场数据里出现过的主题（热门主题在前）；
  // 当前选中的主题随词包下架消失时回退到"全部主题"。
  function renderPlazaThemeOptions() {
    const themes = WTPlaza.themesOf(plazaPacks || []);
    const sig = JSON.stringify(themes);
    if (sig === plazaThemeSig) return;
    plazaThemeSig = sig;
    const sel = $('plaza-theme-filter');
    sel.innerHTML = '<option value="">全部主题</option>' +
      themes.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    sel.value = themes.includes(plazaTheme) ? plazaTheme : '';
    plazaTheme = sel.value;
  }

  function renderPlaza() {
    if ($('screen-plaza').classList.contains('hidden')) return;
    for (const [key, id] of [['hot', 'btn-plaza-sort-hot'], ['new', 'btn-plaza-sort-new']]) {
      $(id).classList.toggle('primary', key === plazaSort);
    }
    const listEl = $('plaza-list');
    if (plazaPacks === null) {
      listEl.innerHTML = '<p class="hint">广场加载中…</p>';
      $('plaza-empty').classList.add('hidden');
      $('plaza-stats').textContent = '';
      return;
    }
    renderPlazaThemeOptions();
    const filtered = WTPlaza.sortPacks(
      WTPlaza.filterPacks(plazaPacks, { keyword: plazaQuery, theme: plazaTheme }), plazaSort);
    const filtering = !!(plazaQuery.trim() || plazaTheme);
    $('plaza-stats').textContent = plazaPacks.length
      ? `共 ${plazaPacks.length} 个词包${filtering ? ` · 筛选出 ${filtered.length} 个` : ''}`
      : '';
    $('plaza-empty').classList.toggle('hidden', plazaPacks.length > 0);
    if (!filtered.length) {
      listEl.innerHTML = plazaPacks.length
        ? `<p class="hint">没有符合条件的词包${plazaQuery.trim() ? `（搜索：${esc(plazaQuery.trim())}）` : ''}。</p>` : '';
      return;
    }
    listEl.innerHTML = filtered.map(item => {
      // 已订阅（同一广场条目）直接显示已订阅；名称+候选词完全相同（如来自分享码导入
      // 或自己另一份副本）也不再给订阅入口，避免跨来源重复订阅产生重复副本
      const sameId = store.packs.some(p => p.plazaId === item.id);
      const sameContent = !sameId && store.packs.some(p =>
        p.name === item.name && JSON.stringify(p.words) === JSON.stringify(
          Array.isArray(item.words) ? item.words : []));
      const ownedHere = sameId || sameContent;
      // 列表带全部候选词（搜索可命中任意词），展示只取前几个做预览
      const words = Array.isArray(item.words) ? item.words : [];
      const preview = words.slice(0, WTPlaza.PREVIEW_WORDS);
      const more = item.wordCount > preview.length ? ' …' : '';
      return `
      <li>
        <div>
          <div class="pl-title">${esc(item.name)}
            <span class="badge shield">${item.wordCount} 词</span>
            <span class="badge hot-badge">🔥 ${item.subscribers} 人订阅</span>
            ${item.mine ? '<span class="badge plaza-mine">我发布的</span>' : ''}
          </div>
          <div class="pl-sub">${item.theme ? esc(item.theme) : '（无主题说明）'}</div>
          <div class="pl-sub">候选词：${preview.map(esc).join('、')}${more}</div>
          <div class="pl-sub">${item.author ? `发布者：${esc(item.author)} · ` : ''}更新于 ${fmtDate(item.updatedAt)}</div>
        </div>
        <div class="row">
          ${item.mine
            ? `<button class="link danger-link" data-plaza-unpub="${item.id}">下架</button>`
            : sameId
              ? '<span class="badge plaza-subbed">已订阅</span>'
              : sameContent
                ? '<span class="badge plaza-subbed">已在本机</span>'
                : `<button class="link" data-plaza-sub="${item.id}">订阅到本机</button>`}
        </div>
      </li>`;
    }).join('');
    listEl.querySelectorAll('[data-plaza-sub]').forEach(btn => {
      btn.onclick = () => send({ type: 'plazaSubscribe', id: btn.dataset.plazaSub, pidSecret: store.pidSecret });
    });
    listEl.querySelectorAll('[data-plaza-unpub]').forEach(btn => {
      btn.onclick = () => confirmPlazaUnpublish(btn.dataset.plazaUnpub);
    });
  }

  // 订阅成功：词包快照存进本机词包（与凭码导入同一套去重：来源标记 + 内容判重）
  function onPlazaPack(msg) {
    const pack = msg.pack;
    if (!pack || !Array.isArray(pack.words)) return toast('订阅的词包数据无效');
    // 列表里的热度就地刷新（不等下次拉取）
    const item = (plazaPacks || []).find(p => p.id === msg.id);
    if (item && Number.isInteger(msg.subscribers)) item.subscribers = msg.subscribers;
    // 去重 1：同一广场词包已订阅过，直接提示，不产生重复副本
    const existing = store.packs.find(p => p.plazaId === msg.id);
    if (existing) {
      toast(`这个词包已经在你的列表里：「${existing.name}」`);
      renderPlaza();
      return;
    }
    // 去重 2：名称与候选词完全相同（如作者就是自己的另一份副本）也不重复订阅
    const dupContent = store.packs.find(p =>
      p.name === pack.name && JSON.stringify(p.words) === JSON.stringify(pack.words));
    if (dupContent) {
      toast(`你已经有相同的词包「${dupContent.name}」了`);
      renderPlaza();
      return;
    }
    const { packs, error } = WTPacks.upsert(store.packs, {
      id: WTPacks.makeId(),
      name: pack.name, theme: pack.theme, words: pack.words,
      plazaId: String(msg.id || ''), subscribedAt: Date.now(), updatedAt: Date.now(),
    });
    if (error) return toast(error);
    store.packs = packs;
    // 订阅到的若是自己在别的设备上发布的词包（条目 packId 已在「我的发布」里），
    // 立即认领回稳定 id，徽标/更新/下架合流。
    healAdoptedPacks();
    toast(`已订阅「${pack.name}」到本机，建房时可在大厅选用`);
    renderPlaza();
  }

  // 若本机词包是从自己的广场发布订阅来的副本（跨设备场景），找出它对应的条目 id：
  // 更新发布时带上该 id，服务端覆盖同一条目（订阅数保留）而不是再发一条。
  // 认领回稳定 id 后，本机映射已直接按 packId 对上，优先按 packId 找。
  function ownPlazaIdForPack(p) {
    if (!p) return '';
    const byPackId = store.plazaMine.find(x => x.packId === p.id);
    if (byPackId) return byPackId.id;
    if (p.plazaId) {
      const m = store.plazaMine.find(x => x.id === p.plazaId);
      if (m) return m.id;
    }
    return '';
  }

  // 发布到广场（词包页「发布到广场 / 更新发布」）：一键发布，同一词包重复发布沿用原条目
  function publishPackToPlaza(p) {
    // 离线时 send 会统一提示"正在重连"，这里不额外弹"正在发布"，避免两条矛盾提示
    if (!send({
      type: 'plazaPublish', pidSecret: store.pidSecret, author: store.name,
      pack: { id: p.id, name: p.name, theme: p.theme, words: p.words },
      id: ownPlazaIdForPack(p) || undefined,
    })) return;
    toast('正在发布到广场…');
  }

  // 服务端确认发布成功（新建或更新）：记下本机映射，词包行出现"已发布"徽标。
  // 条目 id 提示更新（跨设备）时服务端返回的 packId 是该条目原有的稳定作者 packId，
  // 可能与本机新副本 id 不同：映射记到稳定 id，并把本机订阅副本认领/对齐到该 id。
  function onPlazaPublished(msg) {
    if (!WTPlaza.isValidPlazaId(msg.id)) return;
    const serverPackId = String(msg.packId || '');
    store.plazaMine = WTPlaza.upsertLocal(store.plazaMine,
      { id: msg.id, packId: serverPackId, name: msg.name, updatedAt: msg.updatedAt || Date.now() });
    if (serverPackId && !WTPacks.find(store.packs, serverPackId)) {
      const bySub = store.packs.find(p => p.plazaId === msg.id);
      if (bySub) {
        const r = WTPacks.adoptRemotePack(store.packs, 'plaza',
          { matchId: msg.id, targetId: serverPackId });
        if (r.changed) store.packs = r.packs;
      }
    }
    toast(msg.republished ? '广场上的词包已更新为最新内容' : `已发布到广场，大家都能搜索订阅「${msg.name}」了`);
    renderPacks();
  }

  function confirmPlazaUnpublish(id) {
    if (!WTPlaza.isValidPlazaId(id)) return toast('广场条目无效');
    const mine = store.plazaMine.find(m => m.id === id);
    const item = (plazaPacks || []).find(p => p.id === id);
    const name = (mine && mine.name) || (item && item.name) || '';
    if (!confirm(`把${name ? `「${name}」` : '这个词包'}从交流广场下架？下架后其他人无法再搜索和订阅它（已订阅到本机的不受影响）。`)) return;
    send({ type: 'plazaUnpublish', pidSecret: store.pidSecret, id });
  }

  function onPlazaUnpublished(id) {
    store.plazaMine = WTPlaza.removeLocal(store.plazaMine, String(id || ''));
    if (plazaPacks) plazaPacks = plazaPacks.filter(p => p.id !== id);
    renderPacks();
    renderPlaza();
    toast('已从交流广场下架');
  }

  // 与服务端对账我的广场发布：以服务端列表为准（跨设备发布的也出现、已下架的消失）。
  function requestMyPlaza() {
    send({ type: 'myPlaza', pidSecret: store.pidSecret });
    if (!$('screen-packs').classList.contains('hidden')) renderPacks();
  }

  function onMyPlaza(remote) {
    store.plazaMine = WTPlaza.reconcileLocal(store.plazaMine, remote);
    if (healAdoptedPacks()) toast('已把另一台设备上的词包认领回本机');
    renderPacks();
  }

  // 其他设备发布、或本机词包已删除但服务端仍在广场上的条目：单独列出以便下架。
  function renderPlazaOrphans() {
    const plazaLib = globalThis.WTPlaza;
    const box = $('plaza-orphans');
    if (!plazaLib) { box.classList.add('hidden'); return; }
    const packIds = new Set(store.packs.map(p => p.id));
    const orphans = store.plazaMine.filter(m => !packIds.has(m.packId));
    box.classList.toggle('hidden', orphans.length === 0);
    if (!orphans.length) return;
    $('plaza-orphan-list').innerHTML = orphans.map(m => `
      <li>
        <div>
          <div class="pl-title">${esc(m.name || '未命名词包')} <span class="badge plaza-badge">广场上</span></div>
          <div class="pl-sub">本机已无此词包，发布仍在交流广场上</div>
        </div>
        <div class="row">
          <button class="link danger-link" data-plaza-orphan-unpub="${m.id}">下架</button>
        </div>
      </li>`).join('');
    $('plaza-orphan-list').querySelectorAll('[data-plaza-orphan-unpub]').forEach(btn => {
      btn.onclick = () => confirmPlazaUnpublish(btn.dataset.plazaOrphanUnpub);
    });
  }

  $('btn-plaza-home').onclick = openPlaza;
  $('btn-plaza-back').onclick = () => showScreen('home');
  $('btn-plaza-sort-hot').onclick = () => { plazaSort = 'hot'; renderPlaza(); };
  $('btn-plaza-sort-new').onclick = () => { plazaSort = 'new'; renderPlaza(); };
  // 搜索与主题筛选都是纯前端过滤已拉取的列表（候选词全文随列表下发），不重发请求
  $('plaza-search').addEventListener('input', (e) => { plazaQuery = e.target.value || ''; renderPlaza(); });
  $('plaza-theme-filter').onchange = (e) => { plazaTheme = e.target.value || ''; renderPlaza(); };

  function clearPackErrors() {
    for (const id of ['err-pack-name', 'err-pack-theme', 'err-pack-words', 'err-pack-general']) {
      $(id).textContent = '';
    }
    for (const id of ['pack-name', 'pack-theme', 'pack-words']) $(id).classList.remove('invalid');
  }

  // id 为 '' 时新建；否则编辑对应词包并回填
  function openPackEditor(id) {
    const p = id ? WTPacks.find(store.packs, id) : null;
    editingPackId = id || '';
    $('pack-editor-title').textContent = p ? '编辑词包' : '新建词包';
    $('pack-name').value = p ? p.name : '';
    $('pack-theme').value = p ? p.theme : '';
    $('pack-words').value = p ? p.words.join('\n') : '';
    clearPackErrors();
    $('pack-editor').classList.remove('hidden');
  }

  function closePackEditor() {
    editingPackId = null;
    $('pack-editor').classList.add('hidden');
  }

  $('btn-packs-home').onclick = openPacks;
  $('btn-packs-back').onclick = () => showScreen('home');
  $('btn-pack-new').onclick = () => {
    if ($('pack-editor').classList.contains('hidden')) openPackEditor('');
    else closePackEditor();
  };
  $('btn-pack-cancel').onclick = closePackEditor;
  $('btn-pack-save').onclick = () => {
    clearPackErrors();
    const { errors, pack } = WTPacks.validatePack({
      name: $('pack-name').value,
      theme: $('pack-theme').value,
      wordsText: $('pack-words').value,
    });
    for (const [key, msg] of Object.entries(errors)) {
      $(`err-pack-${key}`).textContent = msg;
      $(`pack-${key}`).classList.add('invalid');
    }
    if (Object.keys(errors).length > 0) return;
    const wasEditing = !!editingPackId;
    // 编辑导入/订阅来的词包时保留来源标记：否则改过一个字就与来源脱钩，
    // 同一来源能被再次导入/订阅成重复副本（新建时旧列表里没有，不继承任何标记）。
    const nextPack = WTPacks.withPreservedProvenance(store.packs, {
      ...pack, id: editingPackId || WTPacks.makeId(), updatedAt: Date.now(),
    });
    const { packs, error } = WTPacks.upsert(store.packs, nextPack);
    if (error) { $('err-pack-general').textContent = error; return; }
    store.packs = packs;
    closePackEditor();
    renderPacks();
    toast(wasEditing ? '词包已保存' : '词包已创建，可在大厅选用');
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 初始：首页按钮先置为"连接中"，onopen 后可用
  updateHomeConnState();
  connect();

  // 测试钩子：仅供 test/client.test.js 的 DOM/WS 桩驱动内部状态，生产环境无消费者
  if (typeof globalThis !== 'undefined' && globalThis.__WT_TEST) {
    globalThis.__WTClient = {
      get connStatus() { return connStatus; },
      get state() { return state; },
      get reconnectAttempts() { return reconnectAttempts; },
      get stopRetry() { return stopRetry; },
      get ws() { return ws; },
      connect, goHomeFromFailure, reenterRoom,
    };
  }

  // 赛事 UI（public/tournament.js）共用同一条 WS 连接与本机身份：
  // 它只负责赛事大厅/对阵表的渲染，消息发送复用 send（含断线写操作锁定），
  // 进入对阵房间后由既有房间流程接管（joined→state→对局界面）。
  globalThis.WTMessages = {
    send,
    get secret() { return store.pidSecret; },
    get displayName() { return store.name; },
    showScreen,
    toast,
  };
})();
