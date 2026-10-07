/* 礼仪提示公众视图：受众×阶段×区域×语言；待核不猜测；离线缓存带过期提示 */
(function () {
    const state = {
        audience: 'tourist', phase: 'during', lang: 'zh', zone_id: '',
        visitor_id: localStorage.getItem('etq.visitor') || null,
    };
    if (!state.visitor_id) {
        state.visitor_id = 'v-' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('etq.visitor', state.visitor_id);
    }
    const CACHE_KEY = 'etq.cache';
    const TTL_MS = 5 * 60 * 1000;
    const $ = (s) => document.querySelector(s);

    const I18N = {
        zh: { pending: '待核', pendingNote: '以下来源存在冲突或依据失效，审校完成前系统不作判断：',
              confirmed: '当前适用提示', stale: '翻译基于旧版本，原文已更新',
              missing: '该语种翻译缺失，暂显示中文原文', read: '标记已读',
              newReq: '新', updated: '有更新', sources: '来源', offline: '离线缓存（可能过期）',
              penalty: '违规后果', emphasis: '侧重点' },
        en: { pending: 'Pending review', pendingNote: 'Conflicting or invalidated sources; the system does not guess:',
              confirmed: 'Applicable tips', stale: 'Translation based on an older revision',
              missing: 'Translation missing; showing Chinese source', read: 'Mark read',
              newReq: 'New', updated: 'Updated', sources: 'Sources', offline: 'Offline cache (may be stale)',
              penalty: 'Consequence', emphasis: 'Emphasis' },
    };

    function bindSeg(id, key) {
        $(id).addEventListener('click', (e) => {
            if (e.target.tagName !== 'BUTTON') return;
            $(id).querySelectorAll('button').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            state[key] = e.target.dataset.v;
            load();
        });
    }
    bindSeg('#seg-audience', 'audience');
    bindSeg('#seg-phase', 'phase');
    bindSeg('#seg-lang', 'lang');

    async function loadZones() {
        try {
            const r = await fetch('/api/zones').then(x => x.json());
            $('#sel-zone').innerHTML = '<option value="">全部区域</option>' +
                r.zones.map(z => `<option value="${z.id}">${z.name}(v${z.version})</option>`).join('');
            $('#sel-zone').addEventListener('change', () => {
                state.zone_id = $('#sel-zone').value; load();
            });
        } catch (e) { /* 离线时忽略 */ }
    }

    function tipsUrl() {
        const p = new URLSearchParams({
            audience: state.audience, phase: state.phase, lang: state.lang,
            visitor_id: state.visitor_id,
        });
        if (state.zone_id) p.set('zone_id', state.zone_id);
        return '/api/tips?' + p.toString();
    }

    function render(data, fromCache) {
        const t = I18N[state.lang];
        const banners = [];
        if (fromCache) banners.push(`<div class="banner offline">⚠ ${t.offline}</div>`);
        if (data.confirmed.some(i => i.translation_stale))
            banners.push(`<div class="banner warn">⚠ ${t.stale}</div>`);
        if (data.confirmed.some(i => i.translation_missing))
            banners.push(`<div class="banner warn">⚠ ${t.missing}</div>`);
        $('#banners').innerHTML = banners.join('');

        const marker = (m) => m === 'new' ? `<span class="badge marker-new">${t.newReq}</span>`
            : m === 'updated' ? `<span class="badge marker-updated">${t.updated}</span>` : '';
        $('#confirmed').innerHTML =
            `<h3 style="margin:.8rem 0">${t.confirmed}</h3>` +
            (data.confirmed.map(i => `
            <div class="tip-card kind-${i.kind}">
                <div class="tip-head">
                    <span class="badge ${i.kind}">${i.label}</span>
                    ${marker(i.read_marker)}
                    ${i.translation_stale ? `<span class="badge stale">${t.stale}</span>` : ''}
                </div>
                <p class="tip-text">${i.text}</p>
                ${i.emphasis ? `<p class="tip-emphasis">${t.emphasis}：${i.emphasis}</p>` : ''}
                ${i.penalty ? `<p class="tip-penalty">⚠ ${t.penalty}：${i.penalty}</p>` : ''}
                <div class="tip-meta">
                    ${t.sources}：${i.sources.map(s => `<span class="src">${s.title}</span>`).join('') || '—'}
                    ${i.conflict_sources.length ? `<span class="src">⚠ 冲突来源保留：${i.conflict_sources.map(s => s.title).join('、')}</span>` : ''}
                    · 陈述 #${i.statement_id} / 修订 v${i.version}
                </div>
                <button class="mark-read" data-sid="${i.statement_id}">${t.read}</button>
            </div>`).join('') || '<p class="tip-meta">—</p>');

        $('#pending').innerHTML = data.pending.length ? `
            <h3 style="margin:.8rem 0;color:#8a6d00">${t.pending}</h3>
            <p class="tip-meta">${t.pendingNote}</p>` +
            data.pending.map(p => `
            <div class="pending-card">
                <h4>⏳ ${p.message}</h4>
                ${(p.candidates || []).map(c => `
                    <div class="cand"><span class="stance ${c.stance}">[${c.stance}]</span>${c.text}
                        <div class="tip-meta">${t.sources}：${c.sources.map(s => s.title).join('、') || '—'}
                        ${c.conflict_sources.length ? ' · 冲突来源：' + c.conflict_sources.map(s => s.title).join('、') : ''}</div>
                    </div>`).join('')}
                ${p.text_zh ? `<div class="cand">${p.text_zh}</div>` : ''}
            </div>`).join('') : '';

        const c = data.context;
        $('#ctx-line').textContent =
            `上下文：受众=${c.audience} 阶段=${c.phase} 区域=${c.zone_id ?? '全部'}(v${c.zone_version ?? '-'}) 语言=${c.lang}`;

        document.querySelectorAll('.mark-read').forEach(btn => {
            btn.addEventListener('click', async () => {
                await fetch('/api/read', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ visitor_id: state.visitor_id,
                                           statement_id: Number(btn.dataset.sid) }),
                });
                btn.closest('.tip-card').querySelectorAll('.marker-new,.marker-updated')
                    .forEach(el => el.remove());
            });
        });
    }

    async function load() {
        const url = tipsUrl();
        try {
            const resp = await fetch(url);
            const data = await resp.json();
            localStorage.setItem(CACHE_KEY, JSON.stringify(
                { url, data, fetchedAt: Date.now() }));
            render(data, false);
        } catch (e) {
            const raw = localStorage.getItem(CACHE_KEY);
            if (raw) {
                const c = JSON.parse(raw);
                if (c.url === url) render(c.data, Date.now() - c.fetchedAt > TTL_MS);
                else $('#banners').innerHTML = '<div class="banner offline">离线且无匹配缓存</div>';
            } else {
                $('#banners').innerHTML = '<div class="banner offline">离线且无缓存</div>';
            }
        }
    }

    loadZones();
    load();
})();
