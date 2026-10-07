'use strict';
/**
 * 礼仪提示页:
 * - 受众(居民/游客/现场工作人员) × 活动阶段 × 语言 组织展示;
 * - 三视图共享同一批 statement 文本, 只调整强调与排序, 不复制文本;
 * - 冲突未裁定/来源被撤销时展示"待核", 前端绝不自行猜测结论;
 * - 离线缓存带 TTL, 过期必须重新校验; 过期且离线时明确标注, 不冒充新鲜内容;
 * - 已读状态绑定陈述修订号, 新要求/修订保留变更标记。
 */
(() => {
  const TTL_MS = 30 * 1000; // 与服务端 Cache-Control: max-age=30 对齐
  const $ = (s) => document.querySelector(s);
  const EFFECT_LABEL = { allow: '允许', forbid: '禁止', require: '应当', advise: '建议' };
  const KIND_LABEL = { advisory: '建议', mandatory: '应当遵守', fact: '提示' };
  const AUDIENCE_LABEL = { resident: '居民', tourist: '游客', staff: '现场工作人员' };
  const PHASE_LABEL = { auto: '自动(按活动日程)', before: '活动前', during: '活动中', after: '活动后' };

  const state = { audience: 'tourist', phase: 'auto', lang: 'zh', zoneId: '', eventId: '' };

  const visitorId = (() => {
    let v = localStorage.getItem('guide.visitorId');
    if (!v) {
      v = 'v-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('guide.visitorId', v);
    }
    return v;
  })();

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function cacheKey() {
    return 'guide.cache:' + [state.audience, state.phase, state.lang, state.zoneId, state.eventId].join('|');
  }
  function readCache(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  }
  function writeCache(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* 存储满时忽略 */ }
  }

  function buildUrl() {
    const p = new URLSearchParams({ audience: state.audience, lang: state.lang, visitorId });
    if (state.phase !== 'auto') p.set('phase', state.phase);
    if (state.zoneId) p.set('zoneId', state.zoneId);
    if (state.eventId) p.set('eventId', state.eventId);
    return '/api/guide?' + p.toString();
  }

  async function fetchGuide(cached) {
    const headers = {};
    if (cached && cached.etag) headers['If-None-Match'] = cached.etag;
    const res = await fetch(buildUrl(), { headers });
    if (res.status === 304 && cached) return { payload: cached.payload, etag: cached.etag, fromCache: false };
    if (!res.ok) throw new Error('服务器返回 ' + res.status);
    const payload = await res.json();
    return { payload, etag: res.headers.get('ETag'), fromCache: false };
  }

  async function load() {
    const key = cacheKey();
    const cached = readCache(key);
    const fresh = cached && (Date.now() - cached.fetchedAt < TTL_MS);
    if (fresh) {
      render(cached.payload, { cacheState: 'fresh' });
      revalidateInBackground(key, cached); // 新鲜缓存先渲染, 后台再校验
      return;
    }
    try {
      const got = await fetchGuide(cached);
      writeCache(key, { payload: got.payload, etag: got.etag, fetchedAt: Date.now() });
      render(got.payload, { cacheState: cached ? 'revalidated' : 'network' });
    } catch (e) {
      if (cached) {
        // 离线且缓存已过期: 明确标注过期, 绝不冒充最新内容
        render(cached.payload, { cacheState: 'expired-offline', error: e.message });
      } else {
        $('#items').innerHTML = `<div class="banner error">无法连接服务器, 且本机没有可用缓存。(${esc(e.message)})</div>`;
      }
    }
  }

  async function revalidateInBackground(key, cached) {
    try {
      const got = await fetchGuide(cached);
      writeCache(key, { payload: got.payload, etag: got.etag, fetchedAt: Date.now() });
      if (got.etag !== cached.etag) render(got.payload, { cacheState: 'revalidated' });
    } catch { /* 后台校验失败保持现状 */ }
  }

  function badgeFor(item) {
    const out = [];
    out.push(`<span class="badge kind">${esc(KIND_LABEL[item.kind] || item.kind)}</span>`);
    if (item.status === 'pending_verification') {
      out.push('<span class="badge pending">待核</span>');
    } else if (item.effect) {
      out.push(`<span class="badge ${esc(item.effect)}">${esc(EFFECT_LABEL[item.effect] || item.effect)}</span>`);
    }
    if (item.changeMark === 'NEW') out.push('<span class="badge mark">新要求</span>');
    if (item.changeMark === 'UPDATED') out.push('<span class="badge mark">已变更</span>');
    if (item.translationStatus === 'stale') out.push('<span class="badge i18n">翻译基于旧依据</span>');
    if (item.translationStatus === 'missing') out.push('<span class="badge i18n">暂无该语种翻译</span>');
    if (item.readState === 'read_current') out.push('<span class="badge read">已读</span>');
    return out.join('');
  }

  function renderItem(item) {
    // 待核条目: 原样展示候双方与来源, 不由前端挑选结论
    let candidates = '';
    if (item.status === 'pending_verification' && Array.isArray(item.candidates)) {
      const rows = item.candidates.map(c =>
        `<li>${esc(EFFECT_LABEL[c.effect] || c.effect)}(优先级 ${c.priority})</li>`).join('');
      const reason = item.reason === 'source_revoked' ? '依据来源已被撤销' : '规则存在冲突, 等待审校裁定';
      candidates = `<div class="g-candidates">⚠ ${esc(reason)}, 显示待核而非猜测结论:<ul>${rows}</ul></div>`;
    }
    const sources = (item.sources || []).map(s => {
      const cls = [s.status === 'revoked' ? 'revoked' : '', s.stance === 'opposes' ? 'stance-opposes' : ''].join(' ');
      const tag = s.status === 'revoked' ? `(已撤销${s.revokedReason ? ': ' + esc(s.revokedReason) : ''})` : '';
      const stance = s.stance === 'opposes' ? '[反对]' : '';
      return `<span class="${cls}">${esc(s.title)}${stance}${tag}</span>`;
    }).join(' · ');
    const i18nNote = item.translationStatus === 'stale'
      ? `<div class="fallback-note">⚠ 该语种翻译仍基于第 ${item.basedOnRev} 版依据, 原文已更新至第 ${item.currentRev} 版</div>`
      : (item.translationStatus === 'missing'
        ? `<div class="fallback-note">该语种暂无翻译, 以上显示中文原文</div>` : '');
    return `<article class="g-item emphasis-${esc(item.emphasis)}${item.status === 'pending_verification' ? ' pending' : ''}" data-statement="${esc(item.statementId)}" data-kind="${esc(item.kind)}">
  <div class="badges">${badgeFor(item)}</div>
  <p class="g-text">${esc(item.text)}</p>
  ${item.localNote ? `<p class="g-note">当地解释: ${esc(item.localNote)}</p>` : ''}
  ${i18nNote}
  ${candidates}
  <div class="g-sources">来源: ${sources || '—'}</div>
</article>`;
  }

  function render(payload, opts) {
    const m = payload.meta || {};
    const banner = $('#cache-banner');
    if (opts.cacheState === 'expired-offline') {
      banner.className = 'banner error';
      banner.textContent = '当前离线, 且本地缓存已过期, 以下内容可能不是最新, 请联网后刷新核验。';
      banner.style.display = '';
    } else if (opts.cacheState === 'fresh') {
      banner.className = 'banner info';
      banner.textContent = '以下内容来自 30 秒内的本地缓存, 正在后台校验…';
      banner.style.display = '';
    } else {
      banner.style.display = 'none';
    }
    $('#meta-bar').innerHTML = [
      `受众: ${esc(AUDIENCE_LABEL[m.audience] || m.audience)}`,
      `阶段: ${esc(PHASE_LABEL[m.phase] || m.phase)}${m.phaseResolvedBy === 'event_schedule' ? '(按活动日程)' : ''}`,
      m.zoneId ? `区域: ${esc(m.zoneId)}` : '区域: 未指定',
      m.eventId ? `活动: ${esc(m.eventId)}` : null,
      `数据修订 #${m.dataRevision}`
    ].filter(Boolean).map(s => `<span>${s}</span>`).join('');

    const items = payload.items || [];
    $('#items').innerHTML = items.length
      ? items.map(renderItem).join('\n')
      : '<div class="banner info">当前条件下暂无提示条目。</div>';

    // 渲染后上报已读(绑定当前修订号); 本次会话内变更标记仍保留展示
    const unread = items.filter(i => i.readState !== 'read_current')
      .map(i => ({ statementId: i.statementId, rev: i.currentRev }));
    if (unread.length) {
      fetch('/api/read', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId, items: unread })
      }).catch(() => { /* 离线时下次再报 */ });
    }
  }

  function bindControls() {
    const seg = (id, key) => {
      $(id).addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        state[key] = b.dataset.value;
        $(id).querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        load();
      });
    };
    seg('#seg-audience', 'audience');
    seg('#seg-phase', 'phase');
    $('#sel-lang').addEventListener('change', (e) => { state.lang = e.target.value; load(); });
    $('#sel-zone').addEventListener('change', (e) => { state.zoneId = e.target.value; load(); });
    $('#sel-event').addEventListener('change', (e) => { state.eventId = e.target.value; load(); });
  }

  async function initSelectors() {
    try {
      const [zones, events] = await Promise.all([
        fetch('/api/zones').then(r => r.json()),
        fetch('/api/events').then(r => r.json())
      ]);
      $('#sel-zone').innerHTML = '<option value="">全部区域</option>' +
        zones.zones.map(z => `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('');
      $('#sel-event').innerHTML = '<option value="">不限活动</option>' +
        events.events.map(e => `<option value="${esc(e.id)}">${esc(e.name)}(${esc(e.startAt.slice(0, 10))})</option>`).join('');
    } catch { /* 选择器加载失败不阻塞默认视图 */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindControls();
    initSelectors();
    load();
  });
})();
