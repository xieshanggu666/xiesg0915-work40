'use strict';
/* 赛季成就徽章：纯逻辑模块，浏览器（window.WTAchievements）与 Node（服务端/测试）共用。
   徽章完全是赛季累计数据的"读时派生"——场次、胜场、最高连锁达到里程碑即点亮，
   未达成显示当前进度；不在赛季存档里存任何额外字段，历史玩家首次打开个人页即有徽章。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WTAchievements = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // 里程碑定义，顺序即展示顺序（先按指标分组：场次 → 胜场 → 最高连锁，组内由易到难）。
  // metric 对应赛季聚合字段；desc 为达成后的说明，progress 文案按目标值统一生成。
  const BADGES = [
    // 场次里程碑
    { id: 'games-1', metric: 'games', target: 1, icon: '🌱', name: '初来乍到', desc: '完成第 1 场对局' },
    { id: 'games-10', metric: 'games', target: 10, icon: '🎲', name: '赛场常客', desc: '累计完成 10 场对局' },
    { id: 'games-50', metric: 'games', target: 50, icon: '🏟️', name: '百战不殆', desc: '累计完成 50 场对局' },
    // 胜场里程碑（平局不算胜）
    { id: 'wins-1', metric: 'wins', target: 1, icon: '🥇', name: '首战告捷', desc: '拿下第 1 场胜利' },
    { id: 'wins-3', metric: 'wins', target: 3, icon: '🏅', name: '连战连捷', desc: '累计获胜 3 场' },
    { id: 'wins-10', metric: 'wins', target: 10, icon: '👑', name: '常胜将军', desc: '累计获胜 10 场' },
    // 最高连锁里程碑（单局自己最长的玩家词链长度，赛季内取历史最大值）
    { id: 'chain-3', metric: 'bestChain', target: 3, icon: '🔗', name: '接龙新手', desc: '单局拼出 3 连锁' },
    { id: 'chain-5', metric: 'bestChain', target: 5, icon: '⛓️', name: '连锁达人', desc: '单局拼出 5 连锁' },
    { id: 'chain-8', metric: 'bestChain', target: 8, icon: '🐉', name: '词链长龙', desc: '单局拼出 8 连锁' },
  ];

  const METRIC_LABEL = { games: '场次', wins: '胜场', bestChain: '最高连锁' };

  function metricLabel(metric) { return METRIC_LABEL[metric] || metric; }

  function num(v) {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // 由赛季聚合数据（aggregate/getProfile 的形状均可）派生全部徽章的展示状态。
  // 每枚徽章：{...定义, label, current, target, earned, percent}
  // current 截顶到 target（链已超过里程碑后，进度停在满格而不是显示 12/8）；
  // percent 为 0–100 的整数，供进度条宽度使用。
  function evaluate(stat) {
    const s = stat && typeof stat === 'object' ? stat : {};
    return BADGES.map(b => {
      const current = Math.min(num(s[b.metric]), b.target);
      const earned = num(s[b.metric]) >= b.target;
      return {
        ...b,
        label: metricLabel(b.metric),
        current,
        percent: Math.max(0, Math.min(100, Math.round((current / b.target) * 100))),
        earned,
      };
    });
  }

  // 汇总：{ earned, total }，供标题"赛季成就（3/9）"与排行榜等处使用
  function summarize(badges) {
    const list = Array.isArray(badges) ? badges : [];
    return { earned: list.filter(b => b && b.earned).length, total: list.length };
  }

  return { BADGES, METRIC_LABEL, metricLabel, evaluate, summarize };
});
