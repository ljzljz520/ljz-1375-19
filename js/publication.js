'use strict';
/**
 * 发布物渲染器(打印卡与分享页共用):
 * - 两个页面都从 /api/publications 取同一批准集合, 用本模块渲染, 保证内容一致;
 * - 文本逐字来自发布快照, 不做自动摘要/改写;
 * - kind=advisory 的条目只渲染为"建议", 绝不因样式或措辞变成处罚/强制规则。
 */
window.PublicationUI = (() => {
  const AUDIENCE_LABEL = { resident: '居民', tourist: '游客', staff: '现场工作人员' };
  const PHASE_LABEL = { before: '活动前', during: '活动中', after: '活动后' };
  const EFFECT_LABEL = { allow: '允许', forbid: '禁止', require: '应当', advise: '建议' };
  const KIND_LABEL = { advisory: '建议', mandatory: '应当遵守', fact: '提示' };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function fetchPublication(id) {
    const res = await fetch('/api/publications/' + (id || 'latest'));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || ('加载发布物失败: ' + res.status));
    }
    return res.json();
  }

  function effectBadge(item) {
    if (item.status === 'pending_verification') {
      return '<span class="badge pending">待核</span>';
    }
    const e = item.effect;
    return e ? `<span class="badge ${esc(e)}">${esc(EFFECT_LABEL[e] || e)}</span>` : '';
  }

  function renderItem(item, lang) {
    // 建议类内容: 仅按"建议"呈现, 文本逐字引用, 不改写为处罚规则
    const kind = item.kind;
    const kindBadge = `<span class="badge kind" data-kind="${esc(kind)}">${esc(KIND_LABEL[kind] || kind)}</span>`;
    let text = item.texts.zh;
    let i18nNote = '';
    if (lang && lang !== 'zh') {
      const tr = item.texts[lang];
      if (!tr) {
        i18nNote = `<div class="fallback-note">该语种暂无翻译, 显示中文原文</div>`;
      } else {
        text = tr.text;
        if (tr.status === 'stale') {
          i18nNote = `<div class="fallback-note">⚠ 该语种翻译基于旧依据(第${tr.basedOnRev}版), 原文已更新至第${item.statementRev}版</div>`;
        }
      }
    }
    const scopeBits = [];
    if (item.scope.zoneId) scopeBits.push('区域:' + esc(item.scope.zoneId));
    if (item.scope.eventId) scopeBits.push('活动:' + esc(item.scope.eventId));
    const pendingNote = item.status === 'pending_verification'
      ? '<div class="fallback-note">存在待确认事项, 以现场工作人员与最新公告为准。</div>' : '';
    return `<div class="pub-item" data-kind="${esc(kind)}" data-statement="${esc(item.statementId)}">
  <div class="badges">${kindBadge}${effectBadge(item)}</div>
  <div class="g-text">${esc(text)}</div>
  ${i18nNote}${pendingNote}
  <div class="g-sources">${scopeBits.join(' · ')}</div>
</div>`;
  }

  function render(pub, opts) {
    const lang = (opts && opts.lang) || 'zh';
    const audienceFilter = (opts && opts.audience) || null;
    const groups = new Map();
    for (const item of pub.items) {
      if (audienceFilter && item.scope.audience !== audienceFilter) continue;
      const gk = item.scope.audience;
      if (!groups.has(gk)) groups.set(gk, new Map());
      const phases = groups.get(gk);
      const pk = item.scope.phase;
      if (!phases.has(pk)) phases.set(pk, []);
      phases.get(pk).push(item);
    }
    let html = `<div class="pub-head">
  <h2>礼仪提示卡</h2>
  <div class="pub-id">发布编号 ${esc(pub.id)} · 发布于 ${esc(pub.createdAt)} · 数据修订 #${pub.dataRevision}</div>
</div>`;
    if (!groups.size) html += '<p>该筛选条件下暂无条目。</p>';
    for (const [aud, phases] of groups) {
      html += `<div class="pub-group-title">${esc(AUDIENCE_LABEL[aud] || aud)}</div>`;
      for (const [phase, items] of phases) {
        html += `<div class="pub-phase-title">${esc(PHASE_LABEL[phase] || phase)}</div>`;
        html += items.map(i => renderItem(i, lang)).join('\n');
      }
    }
    const staleLangs = Object.entries(pub.languages || {})
      .filter(([, v]) => v.status !== 'current')
      .map(([l, v]) => `${l}: ${v.status}(滞后 ${v.stale.length} 条, 缺失 ${v.missing.length} 条)`);
    if (staleLangs.length) {
      html += `<div class="banner warn">翻译依据提示: ${esc(staleLangs.join('；'))}</div>`;
    }
    html += `<div class="pub-disclaimer">${esc(pub.disclaimer || '')}</div>`;
    return html;
  }

  async function renderInto(el, opts) {
    try {
      const pub = await fetchPublication(opts && opts.pubId);
      el.innerHTML = render(pub, opts || {});
      return pub;
    } catch (e) {
      el.innerHTML = `<div class="banner error">${esc(e.message)}。请先到工作台发布一个批准集合。</div>`;
      return null;
    }
  }

  return { fetchPublication, render, renderInto, EFFECT_LABEL, KIND_LABEL, AUDIENCE_LABEL, PHASE_LABEL };
})();
