/* 审校工作台：批准/驳回、冲突裁决、来源撤销、翻译状态、改期、边界、发布 */
(function () {
    const $ = (s) => document.querySelector(s);
    const api = async (method, url, body) => {
        const r = await fetch(url, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw Object.assign(new Error(j.message || j.error || r.status), { payload: j });
        return j;
    };
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    async function loadRevisions() {
        const { revisions } = await api('GET', '/api/revisions/pending');
        $('#wb-revisions').innerHTML = revisions.length ? revisions.map(r => `
            <div class="wb-row">
                <span><b>${esc(r.skey)}</b> v${r.version}：${esc(r.text_zh)}
                    <div class="tip-meta">提交人 ${esc(r.created_by)} · 待审校</div></span>
                <span class="actions">
                    <button class="btn primary" data-approve="${r.id}">批准</button>
                </span>
            </div>`).join('') : '<p class="tip-meta">无待审修订</p>';
        document.querySelectorAll('[data-approve]').forEach(b =>
            b.addEventListener('click', async () => {
                try {
                    await api('POST', `/api/revisions/${b.dataset.approve}/approve`,
                              { approver: 'reviewer.ui' });
                } catch (e) { alert('批准失败：' + (e.payload?.message || e.message)); }
                refresh();
            }));
    }

    async function loadConflicts() {
        const { conflicts } = await api('GET', '/api/conflicts');
        $('#wb-conflicts').innerHTML = conflicts.length ? conflicts.map(c => `
            <div class="wb-row">
                <span>#${c.id} 陈述 ${c.statement_a} × ${c.statement_b}
                    <span class="tag ${c.status}">${c.status === 'pending' ? '待裁决' : '已裁决'}</span>
                    ${c.status === 'resolved'
                        ? `<div class="tip-meta">胜出 #${c.winner_statement} · ${esc(c.resolved_by)} · ${esc(c.resolution_note || '')}</div>`
                        : `<div class="tip-meta">上下文：受众=${c.audience ?? '*'} 阶段=${c.phase ?? '*'} 区域=${c.zone_id ?? '*'}</div>`}
                </span>
                ${c.status === 'pending' ? `<span class="actions">
                    <button class="btn primary" data-win="${c.id}:${c.statement_a}">采信 #${c.statement_a}</button>
                    <button class="btn" data-win="${c.id}:${c.statement_b}">采信 #${c.statement_b}</button>
                </span>` : ''}
            </div>`).join('') : '<p class="tip-meta">暂无冲突记录（解析视图时自动登记）</p>';
        document.querySelectorAll('[data-win]').forEach(b =>
            b.addEventListener('click', async () => {
                const [cid, sid] = b.dataset.win.split(':');
                try {
                    await api('POST', `/api/conflicts/${cid}/resolve`,
                              { winner_statement: Number(sid), resolved_by: 'reviewer.ui',
                                note: '工作台显式裁决' });
                } catch (e) { alert('裁决失败：' + (e.payload?.message || e.message)); }
                refresh();
            }));
    }

    async function loadSources() {
        const { sources } = await api('GET', '/api/sources');
        $('#wb-sources').innerHTML = sources.map(s => `
            <div class="wb-row">
                <span>#${s.id} ${esc(s.title)}
                    <span class="tag">${esc(s.stype)}</span>
                    <span class="tag ${s.status === 'active' ? 'ok' : 'withdrawn'}">${s.status === 'active' ? '有效' : '已撤销'}</span>
                    <div class="tip-meta">可信度 ${s.reliability} · ${esc(s.ref || '')}</div>
                </span>
                ${s.status === 'active' ? `<span class="actions">
                    <button class="btn danger" data-withdraw="${s.id}">撤销</button></span>` : ''}
            </div>`).join('');
        document.querySelectorAll('[data-withdraw]').forEach(b =>
            b.addEventListener('click', async () => {
                if (!confirm('撤销后来源记录保留，仅状态变更。继续？')) return;
                await api('POST', `/api/sources/${b.dataset.withdraw}/withdraw`, { by: 'editor.ui' });
                refresh();
            }));
    }

    async function loadTranslations() {
        const { translations } = await api('GET', '/api/translations/status');
        $('#wb-translations').innerHTML = translations.length ? translations.map(t => `
            <div class="wb-row">
                <span><b>${esc(t.skey)}</b> [${esc(t.lang)}]
                    基于 v${t.based_on_version} / 当前 v${t.current_version}</span>
                <span class="tag ${t.stale ? 'stale' : 'ok'}">${t.stale ? '滞后：仍对应旧依据' : '同步'}</span>
            </div>`).join('') : '<p class="tip-meta">暂无翻译</p>';
    }

    async function loadEvents() {
        const { events } = await api('GET', '/api/events');
        $('#wb-events').innerHTML = events.map(e => `
            <div class="wb-row">
                <span><b>${esc(e.name)}</b> <span class="tag">v${e.version}</span>
                    ${e.phases.map(p => `<div class="tip-meta">${p.phase}: ${p.starts_at.slice(0, 10)} ~ ${p.ends_at.slice(0, 10)}</div>`).join('')}
                </span>
                <span class="actions"><button class="btn" data-resched="${e.id}">改期+3天</button></span>
            </div>`).join('');
        document.querySelectorAll('[data-resched]').forEach(b =>
            b.addEventListener('click', async () => {
                const ev = events.find(x => x.id === Number(b.dataset.resched));
                const shift = (iso) => new Date(new Date(iso).getTime() + 3 * 864e5).toISOString();
                await api('POST', `/api/events/${ev.id}/reschedule`, {
                    phases: ev.phases.map(p => ({ phase: p.phase,
                        starts_at: shift(p.starts_at), ends_at: shift(p.ends_at) })),
                });
                refresh();
            }));
    }

    async function loadZones() {
        const { zones } = await api('GET', '/api/zones');
        $('#wb-zones').innerHTML = zones.map(z => `
            <div class="wb-row">
                <span><b>${esc(z.name)}</b> <span class="tag">v${z.version}</span>
                    <div class="tip-meta">${esc(z.boundary)}</div></span>
                <span class="actions"><button class="btn" data-zone="${z.id}">调整边界</button></span>
            </div>`).join('');
        document.querySelectorAll('[data-zone]').forEach(b =>
            b.addEventListener('click', async () => {
                const z = zones.find(x => x.id === Number(b.dataset.zone));
                const nb = prompt('新的边界描述：', z.boundary);
                if (nb && nb !== z.boundary)
                    await api('POST', `/api/zones/${z.id}/boundary`, { boundary: nb });
                refresh();
            }));
    }

    async function loadPublications() {
        const { publications } = await api('GET', '/api/publications');
        $('#wb-publications').innerHTML = publications.length ? publications.map(p => `
            <div class="wb-row">
                <span>批准集合 #${p.id} · ${p.audience}/${p.phase}
                    <div class="tip-meta">${esc(p.created_at)}</div></span>
                <span class="actions">
                    <a class="btn" href="print.html?pub=${p.id}&mode=print" target="_blank">打印卡</a>
                    <a class="btn" href="print.html?pub=${p.id}&mode=share" target="_blank">分享页</a>
                </span>
            </div>`).join('') : '<p class="tip-meta">尚未发布</p>';
    }

    async function loadStatements() {
        const { statements } = await api('GET', '/api/statements');
        $('#wb-statements').innerHTML = statements.map(s => `
            <div class="wb-row">
                <span><b>${esc(s.skey)}</b>
                    <span class="tag">${esc(s.kind)}</span>
                    ${s.status === 'retracted' ? '<span class="tag withdrawn">已撤回</span>' : ''}
                    ${s.unverified ? '<span class="tag stale">来源失效·待核</span>' : ''}
                    <div class="tip-meta">当前修订 #${s.current_revision ?? '—'} ·
                        支撑 ${s.sources.length} · 冲突来源保留 ${s.conflict_sources.length}</div>
                </span>
                ${s.status === 'active' ? `<span class="actions">
                    <button class="btn danger" data-retract="${s.id}">撤回(全语种)</button></span>` : ''}
            </div>`).join('');
        document.querySelectorAll('[data-retract]').forEach(b =>
            b.addEventListener('click', async () => {
                if (!confirm('撤回对所有语种同时生效，确认？')) return;
                await api('POST', `/api/statements/${b.dataset.retract}/retract`, { by: 'reviewer.ui' });
                refresh();
            }));
    }

    $('#btn-publish').addEventListener('click', async () => {
        const msg = $('#pub-msg');
        try {
            const r = await api('POST', '/api/publications', {
                audience: $('#pub-audience').value, phase: $('#pub-phase').value,
                created_by: 'publisher.ui',
            });
            msg.className = 'wb-msg ok';
            msg.textContent = `批准集合 #${r.publication_id} 已生成：收录 ${r.items} 条，排除待核 ${r.excluded_pending} 条`;
        } catch (e) {
            msg.className = 'wb-msg err';
            msg.textContent = '发布失败：' + e.message;
        }
        refresh();
    });

    async function refresh() {
        for (const fn of [loadRevisions, loadConflicts, loadSources, loadTranslations,
                          loadEvents, loadZones, loadPublications, loadStatements]) {
            try { await fn(); } catch (e) { console.error(e); }
        }
    }
    refresh();
})();
