/* 打印卡与分享页：同一批准集合快照的两种渲染；kind 由数据决定，样式不可改写类别 */
(function () {
    const q = new URLSearchParams(location.search);
    const pid = q.get('pub') || '1';
    let mode = q.get('mode') === 'share' ? 'share' : 'print';
    const lang = q.get('lang') || 'zh';
    const $ = (s) => document.querySelector(s);

    $('#toggle-mode').addEventListener('click', (e) => {
        e.preventDefault();
        mode = mode === 'print' ? 'share' : 'print';
        load();
    });

    async function load() {
        const r = await fetch(`/api/publications/${pid}/${mode}?lang=${lang}`).then(x => x.json());
        document.body.classList.toggle('share-mode', mode === 'share');
        $('#page-title').textContent = mode === 'print' ? '礼仪提示卡（打印）' : '礼仪提示（分享页）';
        $('#page-sub').textContent =
            `批准集合 #${r.publication_id} · 受众 ${r.audience} · 阶段 ${r.phase} · ${r.generated_from}`;

        const report = Object.entries(r.language_report || {})
            .filter(([, v]) => v.stale && v.stale.length)
            .map(([l, v]) => `<div class="banner warn">⚠ 语种 ${l} 仍对应旧依据：${v.stale.join('、')}</div>`);
        $('#lang-report').innerHTML = report.join('');

        $('#cards').innerHTML = r.items.map(i => `
            <div class="print-card">
                <div class="tip-head">
                    <span class="badge ${i.kind}">${i.label}</span>
                    ${i.translation_stale ? '<span class="badge stale">翻译滞后</span>' : ''}
                </div>
                <p class="tip-text">${i.text}</p>
                ${i.penalty ? `<p class="tip-penalty">⚠ 违规后果：${i.penalty}</p>` : ''}
                <div class="tip-meta">陈述 #${i.statement_id} · 修订 #${i.revision_id} · 类别 ${i.kind}（快照锁定）</div>
            </div>`).join('');
        $('#footer-line').textContent =
            `本${mode === 'print' ? '卡片' : '页面'}由批准集合 #${r.publication_id} 生成；建议类条目不构成处罚依据。`;
    }
    load();
})();
