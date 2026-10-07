'use strict';
/** 规则与来源工作台: 规则审校 / 陈述与翻译 / 来源 / 冲突裁定 / 发布与已读 */
(() => {
  const $ = (s) => document.querySelector(s);
  const EFFECTS = ['allow', 'forbid', 'require', 'advise'];
  const EFFECT_LABEL = { allow: '允许', forbid: '禁止', require: '应当', advise: '建议' };
  const AUDIENCES = { resident: '居民', tourist: '游客', staff: '现场工作人员' };
  const PHASES = { before: '活动前', during: '活动中', after: '活动后' };
  const KINDS = { advisory: '建议类', mandatory: '强制类', fact: '事实类' };

  const identity = () => ({
    role: $('#wb-role').value,
    by: $('#wb-who').value.trim() || 'anonymous'
  });

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function msg(text, isErr) {
    const el = $('#wb-msg');
    el.textContent = text || '';
    el.className = 'msg ' + (isErr ? 'err' : 'ok');
  }
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(Object.assign({}, identity(), body)) : undefined
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const e = new Error((json && json.message) || ('请求失败 ' + res.status));
      e.status = res.status; e.body = json;
      throw e;
    }
    return json;
  }
  const get = (u) => api('GET', u);
  const post = (u, b) => api('POST', u, b || {});
  const put = (u, b) => api('PUT', u, b);
  async function run(fn) {
    try { await fn(); } catch (e) { msg(e.message, true); }
  }

  /* ---------------- 规则 ---------------- */
  async function renderRules() {
    const [{ rules }, { statements }, { zones }, { events }, { sources }] = await Promise.all([
      get('/api/rules'), get('/api/statements'), get('/api/zones'), get('/api/events'), get('/api/sources')
    ]);
    const stName = Object.fromEntries(statements.map(s => [s.id, s.key]));
    const rows = rules.map(r => `<tr class="${r.status === 'retracted' ? 'revoked-row' : ''}">
  <td>${esc(r.id)}</td>
  <td>${esc(stName[r.statementId] || r.statementId)}</td>
  <td>${esc(EFFECT_LABEL[r.effect])} / P${r.priority}</td>
  <td>${r.audiences.map(a => AUDIENCES[a]).join('、')}<br>${r.phases.map(p => PHASES[p]).join('、')}</td>
  <td>${esc(r.zoneId || '全域')}${r.eventId ? '<br>' + esc(r.eventId) : ''}</td>
  <td class="status-${esc(r.status)}">${esc(r.status)}${r.review ? '<br>审校: ' + esc(r.review.conclusion) : ''}</td>
  <td>v${r.version}</td>
  <td>
    <button data-act="edit" data-id="${esc(r.id)}">编辑</button>
    <button data-act="approve" data-id="${esc(r.id)}">批准</button>
    <button data-act="retract" data-id="${esc(r.id)}" class="danger">撤回</button>
  </td>
</tr>`).join('');
    $('#wb-rules-table').innerHTML = `<table class="wb"><thead><tr>
<th>ID</th><th>陈述</th><th>效力/优先级</th><th>受众/阶段</th><th>范围</th><th>状态/审校结论</th><th>版本</th><th>操作</th>
</tr></thead><tbody>${rows}</tbody></table>`;

    $('#rule-statement').innerHTML = statements.filter(s => s.status !== 'retracted')
      .map(s => `<option value="${esc(s.id)}">${esc(s.key)}(${esc(s.kind)})</option>`).join('');
    $('#rule-zone').innerHTML = '<option value="">全域</option>' +
      zones.map(z => `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('');
    $('#rule-event').innerHTML = '<option value="">不限活动</option>' +
      events.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
    $('#rule-sources').innerHTML = sources.map(s =>
      `<option value="${esc(s.id)}">${esc(s.title)}${s.status === 'revoked' ? '(已撤销)' : ''}</option>`).join('');
    window.__rules = rules;
  }

  function readRuleForm() {
    const checked = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(x => x.value);
    return {
      statementId: $('#rule-statement').value,
      effect: $('#rule-effect').value,
      audiences: checked('rule-aud'),
      phases: checked('rule-phase'),
      zoneId: $('#rule-zone').value || null,
      eventId: $('#rule-event').value || null,
      priority: Number($('#rule-priority').value) || 0,
      localNote: $('#rule-note').value,
      sources: [...$('#rule-sources').selectedOptions].map(o => ({ sourceId: o.value, stance: $('#rule-stance').value }))
    };
  }

  async function saveRule() {
    const id = $('#rule-id').value;
    const body = readRuleForm();
    if (id) {
      const rule = (window.__rules || []).find(r => r.id === id);
      await put('/api/rules/' + id, Object.assign(body, { version: Number($('#rule-version').value) }));
      msg('规则已更新' + (rule && rule.status === 'approved' ? '(原已批准, 修改后回到待审校)' : ''));
    } else {
      await post('/api/rules', body);
      msg('规则已创建(草稿), 待审校批准');
    }
    resetRuleForm();
    await renderRules();
  }

  function resetRuleForm() {
    $('#rule-id').value = ''; $('#rule-version').value = '';
    $('#rule-form-title').textContent = '新建规则';
  }

  async function ruleAction(act, id) {
    const rule = (window.__rules || []).find(r => r.id === id);
    if (!rule) return;
    if (act === 'edit') {
      $('#rule-id').value = rule.id;
      $('#rule-version').value = rule.version;
      $('#rule-form-title').textContent = '编辑规则 ' + rule.id + '(v' + rule.version + ')';
      $('#rule-statement').value = rule.statementId;
      $('#rule-effect').value = rule.effect;
      document.querySelectorAll('input[name="rule-aud"]').forEach(x => { x.checked = rule.audiences.includes(x.value); });
      document.querySelectorAll('input[name="rule-phase"]').forEach(x => { x.checked = rule.phases.includes(x.value); });
      $('#rule-zone').value = rule.zoneId || '';
      $('#rule-event').value = rule.eventId || '';
      $('#rule-priority').value = rule.priority;
      $('#rule-note').value = rule.localNote || '';
      [...$('#rule-sources').options].forEach(o => { o.selected = (rule.sources || []).some(s => s.sourceId === o.value); });
    } else if (act === 'approve') {
      const conclusion = prompt('审校结论(必填):', '内容属实，同意发布。');
      if (conclusion == null) return;
      await run(async () => {
        const r = await post(`/api/rules/${rule.id}/approve`, { conclusion, version: rule.version });
        msg('已批准 ' + rule.id + (r.newConflicts && r.newConflicts.length ? `, 检测到 ${r.newConflicts.length} 起新冲突` : ''));
        await renderRules(); await renderConflicts();
      });
    } else if (act === 'retract') {
      const reason = prompt('撤回原因:');
      if (reason == null) return;
      await run(async () => {
        await post(`/api/rules/${rule.id}/retract`, { reason, version: rule.version });
        msg('已撤回 ' + rule.id);
        await renderRules();
      });
    }
  }

  /* ---------------- 陈述与翻译 ---------------- */
  async function renderStatements() {
    const [{ statements }, i18n] = await Promise.all([get('/api/statements'), get('/api/i18n/status')]);
    const i18nMap = Object.fromEntries(i18n.statements.map(s => [s.statementId, s]));
    window.__statements = statements;
    const rows = statements.map(s => {
      const rep = i18nMap[s.id] || { langs: {} };
      const en = rep.langs.en || {};
      const enBadge = en.status === 'stale'
        ? `<span class="badge i18n">英文滞后(基于第${en.basedOnRev}版)</span>`
        : en.status === 'missing' ? '<span class="badge i18n">英文缺失</span>' : '<span class="badge read">英文同步</span>';
      const cur = (s.revisions || [])[0];
      return `<tr class="${s.status === 'retracted' ? 'revoked-row' : ''}">
  <td>${esc(s.key)}<br><small>${esc(s.id)}</small></td>
  <td>${esc(KINDS[s.kind] || s.kind)}</td>
  <td class="status-${esc(s.status)}">${esc(s.status)}${s.retractReason ? '<br>' + esc(s.retractReason) : ''}</td>
  <td>第${s.currentRev}版 v${s.version}</td>
  <td>${esc(cur ? cur.text : '')}</td>
  <td>${enBadge}</td>
  <td>
    <button data-act="revise" data-id="${esc(s.id)}">新修订</button>
    <button data-act="translate" data-id="${esc(s.id)}">更新英译</button>
    <button data-act="retract-st" data-id="${esc(s.id)}" class="danger">撤回</button>
  </td>
</tr>`;
    }).join('');
    $('#wb-statements-table').innerHTML = `<table class="wb"><thead><tr>
<th>键</th><th>类型</th><th>状态</th><th>修订</th><th>当前文本(中文)</th><th>翻译</th><th>操作</th>
</tr></thead><tbody>${rows}</tbody></table>`;
  }

  async function statementAction(act, id) {
    const st = (window.__statements || []).find(s => s.id === id);
    if (!st) return;
    if (act === 'revise') {
      const text = prompt('新修订文本(中文):');
      if (!text) return;
      await run(async () => {
        await post(`/api/statements/${id}/revisions`, { text, note: '工作台修订', version: st.version });
        msg('已发布新修订, 其他语种翻译将标记为滞后');
        await renderStatements();
      });
    } else if (act === 'translate') {
      const text = prompt('英文翻译(将绑定当前修订作为依据):');
      if (!text) return;
      await run(async () => {
        await post('/api/translations', { statementId: id, lang: 'en', text });
        msg('翻译已更新并对齐当前依据');
        await renderStatements();
      });
    } else if (act === 'retract-st') {
      const reason = prompt('撤回原因(撤回对所有语言同时生效):');
      if (reason == null) return;
      await run(async () => {
        await post(`/api/statements/${id}/retract`, { reason, version: st.version });
        msg('已撤回, 所有语言视图不再展示该陈述');
        await renderStatements();
      });
    }
  }

  async function createStatement() {
    const key = $('#st-key').value.trim();
    const kind = $('#st-kind').value;
    const text = $('#st-text').value.trim();
    if (!key || !text) { msg('键与文本必填', true); return; }
    await run(async () => {
      await post('/api/statements', { key, kind, text });
      $('#st-key').value = ''; $('#st-text').value = '';
      msg('陈述已创建');
      await renderStatements();
    });
  }

  /* ---------------- 来源 ---------------- */
  async function renderSources() {
    const { sources } = await get('/api/sources');
    const rows = sources.map(s => `<tr class="${s.status === 'revoked' ? 'revoked-row' : ''}">
  <td>${esc(s.id)}</td>
  <td>${esc(s.title)}</td>
  <td>${esc(s.publisher)}</td>
  <td class="status-${esc(s.status)}">${esc(s.status)}${s.revokedReason ? '<br>' + esc(s.revokedReason) : ''}</td>
  <td>v${s.version}</td>
  <td>${s.status === 'active' ? `<button data-act="revoke" data-id="${esc(s.id)}" class="danger">撤销</button>` : '(记录保留)'}</td>
</tr>`).join('');
    $('#wb-sources-table').innerHTML = `<table class="wb"><thead><tr>
<th>ID</th><th>标题</th><th>发布方</th><th>状态</th><th>版本</th><th>操作</th>
</tr></thead><tbody>${rows}</tbody></table>`;
    window.__sources = sources;
  }

  async function sourceAction(act, id) {
    if (act !== 'revoke') return;
    const src = (window.__sources || []).find(s => s.id === id);
    const reason = prompt('撤销原因(来源记录将保留在库):');
    if (reason == null) return;
    await run(async () => {
      await post(`/api/sources/${id}/revoke`, { reason, version: src.version });
      msg('来源已撤销; 仅依赖它的规则将在视图中显示为待核');
      await renderSources();
    });
  }

  async function createSource() {
    const title = $('#src-title').value.trim();
    const publisher = $('#src-publisher').value.trim();
    if (!title || !publisher) { msg('标题与发布方必填', true); return; }
    await run(async () => {
      await post('/api/sources', { title, publisher, url: $('#src-url').value.trim() });
      $('#src-title').value = ''; $('#src-publisher').value = ''; $('#src-url').value = '';
      msg('来源已登记');
      await renderSources();
    });
  }

  /* ---------------- 冲突 ---------------- */
  async function renderConflicts() {
    const { conflicts } = await get('/api/conflicts');
    window.__conflicts = conflicts;
    if (!conflicts.length) {
      $('#wb-conflicts').innerHTML = '<div class="banner info">当前没有登记的规则冲突。</div>';
      return;
    }
    $('#wb-conflicts').innerHTML = conflicts.map(c => {
      const rules = (c.rules || []).map(r => `
    <li><b>${esc(EFFECT_LABEL[r.effect] || r.effect)}</b>(优先级 ${r.priority}, ${esc(r.status)})
      <br>当地解释: ${esc(r.localNote || '—')}
      <br>来源: ${(r.sources || []).map(s => `${esc(s.title || s.sourceId)}[${s.stance === 'opposes' ? '反对' : '支持'}${s.sourceStatus === 'revoked' ? ',已撤销' : ''}]`).join('；')}
    </li>`).join('');
      const head = c.status === 'pending'
        ? '<span class="badge pending">待裁定</span>'
        : `<span class="badge allow">已裁定</span> 胜出: ${esc(c.resolution.winnerRuleId)} · ${esc(c.resolution.rationale)} · 裁定人 ${esc(c.resolution.decidedBy)}`;
      const form = c.status === 'pending' ? `
    <div class="wb-form">
      <div class="field">胜出规则
        <select id="conf-winner-${esc(c.id)}">${c.ruleIds.map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join('')}</select>
      </div>
      <div class="field">裁定理由 <input id="conf-why-${esc(c.id)}" size="40" placeholder="必填"></div>
      <button class="primary" data-act="resolve" data-id="${esc(c.id)}">提交裁定</button>
    </div>` : '';
      return `<div class="g-item ${c.status === 'pending' ? 'pending' : ''}">
  <div class="badges">${head}</div>
  <div>陈述: ${esc(c.statementId)} · 冲突规则: ${c.ruleIds.map(esc).join(' ↔ ')}</div>
  <ul>${rules}</ul>
  ${form}
</div>`;
    }).join('');
  }

  async function conflictAction(act, id) {
    if (act !== 'resolve') return;
    const c = (window.__conflicts || []).find(x => x.id === id);
    const winnerRuleId = $('#conf-winner-' + CSS.escape(id)).value;
    const rationale = $('#conf-why-' + CSS.escape(id)).value.trim();
    if (!rationale) { msg('裁定理由必填', true); return; }
    await run(async () => {
      await post(`/api/conflicts/${id}/resolve`, { winnerRuleId, rationale, version: c.version });
      msg('冲突已裁定, 相关视图将展示获批一方');
      await renderConflicts();
    });
  }

  /* ---------------- 发布与已读 ---------------- */
  async function renderPublish() {
    const [i18n, pubs] = await Promise.all([get('/api/i18n/status'), get('/api/publications')]);
    const rows = i18n.statements.filter(s => s.status !== 'retracted').map(s => {
      const en = s.langs.en || {};
      const cls = en.status === 'current' ? 'status-ok' : 'status-pending';
      return `<tr><td>${esc(s.key)}</td><td>第${s.currentRev}版</td>
<td class="${cls}">${esc(en.status || '')}${en.basedOnRev != null ? `(基于第${en.basedOnRev}版)` : ''}</td></tr>`;
    }).join('');
    $('#wb-i18n').innerHTML = `<table class="wb"><thead><tr><th>陈述</th><th>原文修订</th><th>英文状态</th></tr></thead><tbody>${rows}</tbody></table>`;
    $('#wb-pubs').innerHTML = pubs.publications.slice().reverse().map(p => `<tr>
  <td>${esc(p.id)}</td><td>${esc(p.createdAt)}</td><td>${esc(p.createdBy)}</td><td>${p.itemCount}</td>
  <td>${Object.entries(p.languages).map(([l, v]) => `${l}:${v.status}`).join(' ')}</td>
  <td><a href="print.html?pub=${esc(p.id)}" target="_blank">打印卡</a> · <a href="share.html?pub=${esc(p.id)}" target="_blank">分享页</a></td>
</tr>`).join('');
  }

  async function publish() {
    await run(async () => {
      const pub = await post('/api/publications', { note: $('#pub-note').value.trim() });
      const langs = Object.entries(pub.languages).map(([l, v]) => `${l}: ${v.status}`).join('；');
      msg(`已发布 ${pub.id}(${pub.items.length} 条)。语种状态: ${langs}`);
      await renderPublish();
    });
  }

  async function lookupRead() {
    const vid = $('#read-vid').value.trim();
    if (!vid) return;
    await run(async () => {
      const { receipts } = await get('/api/read?visitorId=' + encodeURIComponent(vid));
      $('#read-result').innerHTML = receipts.length
        ? '<table class="wb"><thead><tr><th>陈述</th><th>已读修订</th><th>时间</th></tr></thead><tbody>' +
          receipts.map(r => `<tr><td>${esc(r.statementId)}</td><td>第${r.rev}版</td><td>${esc(r.readAt)}</td></tr>`).join('') +
          '</tbody></table>'
        : '<div class="banner info">该访客暂无已读记录。</div>';
    });
  }

  /* ---------------- 事件与区域(验收操作面) ---------------- */
  async function renderOps() {
    const [{ events }, { zones }] = await Promise.all([get('/api/events'), get('/api/zones')]);
    window.__events = events; window.__zones = zones;
    $('#wb-events').innerHTML = events.map(e => `<tr>
  <td>${esc(e.name)}</td><td>${esc(e.startAt)}<br>${esc(e.endAt)}</td>
  <td>v${e.version}(改期 ${((e.scheduleHistory || []).length)} 次)</td>
  <td><button data-act="reschedule" data-id="${esc(e.id)}">改期</button></td>
</tr>`).join('');
    $('#wb-zones').innerHTML = zones.map(z => `<tr>
  <td>${esc(z.name)}</td>
  <td>${z.boundary ? `[${z.boundary.minLng}, ${z.boundary.minLat}] ~ [${z.boundary.maxLng}, ${z.boundary.maxLat}]` : '—'}</td>
  <td>v${z.version}(变更 ${((z.boundaryHistory || []).length)} 次)</td>
  <td><button data-act="boundary" data-id="${esc(z.id)}">调整边界</button></td>
</tr>`).join('');
  }

  async function opsAction(act, id) {
    if (act === 'reschedule') {
      const ev = (window.__events || []).find(e => e.id === id);
      const startAt = prompt('开始时间(ISO):', ev.startAt);
      if (!startAt) return;
      const endAt = prompt('结束时间(ISO):', ev.endAt);
      if (!endAt) return;
      await run(async () => {
        await post(`/api/events/${id}/reschedule`, { startAt, endAt, version: ev.version });
        msg('活动已改期, 相关视图与缓存即刻失效');
        await renderOps();
      });
    } else if (act === 'boundary') {
      const z = (window.__zones || []).find(x => x.id === id);
      const raw = prompt('新边界 minLng,minLat,maxLng,maxLat:', z.boundary ? [z.boundary.minLng, z.boundary.minLat, z.boundary.maxLng, z.boundary.maxLat].join(',') : '');
      if (!raw) return;
      const [minLng, minLat, maxLng, maxLat] = raw.split(',').map(Number);
      await run(async () => {
        await put(`/api/zones/${id}/boundary`, { boundary: { minLng, minLat, maxLng, maxLat }, version: z.version });
        msg('区域边界已更新');
        await renderOps();
      });
    }
  }

  /* ---------------- 装配 ---------------- */
  const TABS = {
    rules: async () => { await renderRules(); },
    statements: async () => { await renderStatements(); },
    sources: async () => { await renderSources(); },
    conflicts: async () => { await renderConflicts(); },
    publish: async () => { await renderPublish(); },
    ops: async () => { await renderOps(); }
  };

  async function activate(tab) {
    document.querySelectorAll('.wb-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.wb-panel').forEach(p => { p.style.display = p.id === 'panel-' + tab ? '' : 'none'; });
    msg('');
    await run(TABS[tab]);
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.wb-tabs button').forEach(b =>
      b.addEventListener('click', () => activate(b.dataset.tab)));
    $('#rule-save').addEventListener('click', () => run(saveRule));
    $('#rule-reset').addEventListener('click', resetRuleForm);
    $('#st-create').addEventListener('click', () => run(createStatement));
    $('#src-create').addEventListener('click', () => run(createSource));
    $('#pub-create').addEventListener('click', () => run(publish));
    $('#read-lookup').addEventListener('click', () => run(lookupRead));
    document.querySelector('.wb').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const { act, id } = b.dataset;
      if ($('#panel-rules').contains(b)) run(() => ruleAction(act, id));
      else if ($('#panel-statements').contains(b)) run(() => statementAction(act, id));
      else if ($('#panel-sources').contains(b)) run(() => sourceAction(act, id));
      else if ($('#panel-conflicts').contains(b)) run(() => conflictAction(act, id));
      else if ($('#panel-ops').contains(b)) run(() => opsAction(act, id));
    });
    activate('rules');
  });
})();
