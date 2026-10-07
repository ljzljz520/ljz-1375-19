'use strict';
/**
 * 验收测试: 活动改期 / 区域边界变化 / 来源撤销 / 编辑并发批准 / 离线缓存过期
 *          冲突待核与显式审批 / 优先级决议 / 翻译滞后与撤回 / 已读绑定修订 / 发布同源
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createServer } = require('../server/server');

let server, base, tmpFile;

async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}
const get = (p) => api('GET', p);

test.before(async () => {
  tmpFile = path.join(os.tmpdir(), `guide-test-${process.pid}-${Date.now()}.json`);
  const created = createServer({ dbFile: tmpFile });
  server = created.server;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  for (const f of [tmpFile, tmpFile + '.tmp']) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
});

test('冲突待核: "可拍摄"与"禁止拍摄"同时命中时返回待核而非猜测', async () => {
  const r = await get('/api/guide?audience=tourist&phase=during&zoneId=zone_core&eventId=evt_shehuo&lang=zh');
  assert.equal(r.status, 200);
  const item = r.json.items.find(i => i.statementId === 'st_photo_core');
  assert.ok(item, '应包含核心区拍摄条目');
  assert.equal(item.status, 'pending_verification');
  assert.equal(item.reason, 'effect_conflict');
  assert.equal(item.effect, null, '待核时不得给出结论性效力');
  const effects = item.candidates.map(c => c.effect).sort();
  assert.deepEqual(effects, ['allow', 'forbid']);
  // 冲突双方来源都保留
  const srcIds = item.sources.map(s => s.id).sort();
  assert.ok(srcIds.includes('src_org') && srcIds.includes('src_joint'));
});

test('显式冲突审批: 裁定后返回获批一方, 并记录裁定人', async () => {
  const list = await get('/api/conflicts');
  const conf = list.json.conflicts.find(c => c.id === 'conf_photo');
  assert.equal(conf.status, 'pending');
  const bad = await api('POST', '/api/conflicts/conf_photo/resolve', { role: 'reviewer', by: 'reviewer_zhao', winnerRuleId: 'rule_nope', rationale: 'x', version: conf.version });
  assert.equal(bad.status, 400);
  const ok = await api('POST', '/api/conflicts/conf_photo/resolve', { role: 'reviewer', by: 'reviewer_zhao', winnerRuleId: 'rule_photo_forbid', rationale: '以公安·文保联合通告为准，核心区巡游期间禁止驻足拍摄。', version: conf.version });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'resolved');
  const g = await get('/api/guide?audience=tourist&phase=during&zoneId=zone_core&eventId=evt_shehuo&lang=zh');
  const item = g.json.items.find(i => i.statementId === 'st_photo_core');
  assert.equal(item.status, 'ok');
  assert.equal(item.effect, 'forbid');
  assert.equal(item.decidedBy, 'explicit_approval');
});

test('优先级决议: 效力相反但优先级可区分时由高优先级胜出', async () => {
  const st = await api('POST', '/api/statements', { role: 'editor', by: 'editor_li', key: 'test.drone', kind: 'fact', text: '核心区无人机飞行管理。' });
  assert.equal(st.status, 201);
  const sid = st.json.id;
  const mk = (effect, priority) => api('POST', '/api/rules', {
    role: 'editor', by: 'editor_li', statementId: sid, effect,
    audiences: ['tourist'], phases: ['during'], zoneId: 'zone_core', eventId: null,
    priority, sources: [{ sourceId: 'src_org', stance: 'supports' }]
  });
  const ra = (await mk('allow', 40)).json;
  const rb = (await mk('forbid', 70)).json;
  for (const r of [ra, rb]) {
    const ap = await api('POST', `/api/rules/${r.id}/approve`, { role: 'reviewer', by: 'reviewer_zhao', conclusion: '测试批准', version: r.version });
    assert.equal(ap.status, 200);
  }
  const g = await get('/api/guide?audience=tourist&phase=during&zoneId=zone_core&lang=zh');
  const item = g.json.items.find(i => i.statementId === sid);
  assert.equal(item.status, 'ok');
  assert.equal(item.effect, 'forbid');
  assert.equal(item.decidedBy, 'priority');
  assert.equal(item.contested, true);
});

test('活动改期: 自动阶段随日程变化, 版本冲突返回 409', async () => {
  const ev0 = (await get('/api/events')).json.events.find(e => e.id === 'evt_shehuo');
  const before = await get('/api/guide?audience=staff&eventId=evt_shehuo&lang=zh');
  assert.equal(before.json.meta.phase, 'before'); // 种子日程在未来
  assert.ok(before.json.items.find(i => i.statementId === 'st_cordon'), '活动前应看到工作人员警戒绳要求');

  const now = Date.now();
  const bad = await api('POST', '/api/events/evt_shehuo/reschedule', { role: 'editor', by: 'editor_li', startAt: new Date(now - 3600e3).toISOString(), endAt: new Date(now + 3600e3).toISOString(), version: ev0.version + 99 });
  assert.equal(bad.status, 409, '版本不符必须 409');

  const ok = await api('POST', '/api/events/evt_shehuo/reschedule', { role: 'editor', by: 'editor_li', startAt: new Date(now - 3600e3).toISOString(), endAt: new Date(now + 3600e3).toISOString(), version: ev0.version });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.scheduleHistory.length, 1, '改期留痕');

  const during = await get('/api/guide?audience=tourist&eventId=evt_shehuo&zoneId=zone_core&lang=zh');
  assert.equal(during.json.meta.phase, 'during');
  assert.equal(during.json.meta.phaseResolvedBy, 'event_schedule');
  assert.ok(during.json.items.find(i => i.statementId === 'st_photo_core'), '活动中应出现拍摄条目');
  const staff = await get('/api/guide?audience=staff&eventId=evt_shehuo&zoneId=zone_core&lang=zh');
  assert.ok(!staff.json.items.find(i => i.statementId === 'st_cordon'), '活动开始后"活动前"规则不再命中');

  // 改回未来, 避免影响后续用例
  const ev1 = (await get('/api/events')).json.events.find(e => e.id === 'evt_shehuo');
  await api('POST', '/api/events/evt_shehuo/reschedule', { role: 'editor', by: 'editor_li', startAt: '2026-12-10T10:00:00+08:00', endAt: '2026-12-10T12:00:00+08:00', version: ev1.version });
});

test('区域边界变化: 同一点位命中结果随边界更新而改变', async () => {
  const q = 'audience=tourist&phase=during&eventId=evt_shehuo&lng=108.96&lat=34.22&lang=zh';
  const inside = await get('/api/guide?' + q);
  assert.equal(inside.json.meta.zoneId, 'zone_core');
  assert.ok(inside.json.items.find(i => i.statementId === 'st_photo_core'));

  const zone = (await get('/api/zones')).json.zones.find(z => z.id === 'zone_core');
  const moved = await api('PUT', '/api/zones/zone_core/boundary', {
    role: 'editor', by: 'editor_li', version: zone.version,
    boundary: { minLng: 108.90, minLat: 34.20, maxLng: 108.92, maxLat: 34.22 }
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.boundaryHistory.length, 1, '边界变化留痕');

  const outside = await get('/api/guide?' + q);
  assert.equal(outside.json.meta.zoneId, null, '点位已不在新边界内');
  assert.ok(!outside.json.items.find(i => i.statementId === 'st_photo_core'), '区域规则不再命中');

  // 还原边界
  const z2 = (await get('/api/zones')).json.zones.find(z => z.id === 'zone_core');
  await api('PUT', '/api/zones/zone_core/boundary', { role: 'editor', by: 'editor_li', version: z2.version, boundary: { minLng: 108.95, minLat: 34.21, maxLng: 108.97, maxLat: 34.23 } });
});

test('来源撤销: 唯一支撑来源被撤销后条目降级为待核, 来源仍保留在库', async () => {
  const src = (await get('/api/sources')).json.sources.find(s => s.id === 'src_museum');
  const rv = await api('POST', '/api/sources/src_museum/revoke', { role: 'reviewer', by: 'reviewer_zhao', reason: '新版须知替换旧版，旧版作废', version: src.version });
  assert.equal(rv.status, 200);
  assert.equal(rv.json.status, 'revoked');

  const g = await get('/api/guide?audience=tourist&phase=during&zoneId=zone_museum&lang=zh');
  const item = g.json.items.find(i => i.statementId === 'st_flash');
  assert.equal(item.status, 'pending_verification');
  assert.equal(item.reason, 'source_revoked');
  assert.equal(item.effect, null);
  const srcView = item.sources.find(s => s.id === 'src_museum');
  assert.equal(srcView.status, 'revoked', '视图中来源标注为已撤销而非消失');

  const all = await get('/api/sources');
  assert.ok(all.json.sources.find(s => s.id === 'src_museum'), '撤销的来源仍保留在数据库');
});

test('编辑并发: 携带过期版本的修改与重复批准都返回 409', async () => {
  const created = await api('POST', '/api/rules', {
    role: 'editor', by: 'editor_li', statementId: 'st_queue', effect: 'require',
    audiences: ['staff'], phases: ['during'], zoneId: 'zone_museum', eventId: null,
    priority: 55, sources: [{ sourceId: 'src_joint', stance: 'supports' }]
  });
  const rule = created.json;
  const body = {
    role: 'editor', by: 'editor_li', statementId: 'st_queue', effect: 'require',
    audiences: ['staff'], phases: ['during'], zoneId: 'zone_museum', eventId: null,
    priority: 56, sources: [{ sourceId: 'src_joint', stance: 'supports' }]
  };
  const noVer = await api('PUT', `/api/rules/${rule.id}`, body);
  assert.equal(noVer.status, 409);
  assert.equal(noVer.json.error, 'version_required');
  const first = await api('PUT', `/api/rules/${rule.id}`, { ...body, version: rule.version });
  assert.equal(first.status, 200);
  const stale = await api('PUT', `/api/rules/${rule.id}`, { ...body, version: rule.version });
  assert.equal(stale.status, 409, '过期版本必须 409');
  assert.equal(stale.json.error, 'version_conflict');

  const ap1 = await api('POST', `/api/rules/${rule.id}/approve`, { role: 'reviewer', by: 'reviewer_zhao', conclusion: '同意', version: first.json.version });
  assert.equal(ap1.status, 200);
  const ap2 = await api('POST', `/api/rules/${rule.id}/approve`, { role: 'reviewer', by: 'reviewer_wu', conclusion: '并发重复批准', version: first.json.version });
  assert.equal(ap2.status, 409, '并发第二次批准必须 409');
  assert.equal(ap2.json.detail.current.review.reviewer, 'reviewer_zhao', '保留先到的审校结论');
});

test('离线缓存过期: ETag 304/200 语义与数据修订号', async () => {
  const p = '/api/guide?audience=tourist&phase=during&zoneId=zone_core&eventId=evt_shehuo&lang=zh';
  const r1 = await get(p);
  const etag = r1.headers.get('etag');
  assert.ok(etag, '应返回 ETag');
  assert.match(r1.headers.get('cache-control'), /max-age=30/);
  const rev1 = Number(r1.headers.get('x-data-revision'));

  const r2 = await fetch(base + p, { headers: { 'If-None-Match': etag } });
  assert.equal(r2.status, 304, '未变更时应 304, 客户端可安全复用缓存');

  // 变更数据(修订核心区拍摄陈述) → 旧缓存必须失效
  const st = (await get('/api/statements')).json.statements.find(s => s.id === 'st_photo_core');
  await api('POST', '/api/statements/st_photo_core/revisions', { role: 'editor', by: 'editor_li', text: '社火巡游核心表演区(大唐不夜城主街及两侧辅路)的游客拍摄管理要求。', note: '补充辅路范围', version: st.version });
  const r3 = await fetch(base + p, { headers: { 'If-None-Match': etag } });
  assert.equal(r3.status, 200, '数据变化后旧 ETag 不得再 304');
  const etag2 = r3.headers.get('etag');
  assert.notEqual(etag2, etag);
  const rev2 = Number(r3.headers.get('x-data-revision'));
  assert.ok(rev2 > rev1, '数据修订号应递增');
});

test('翻译滞后与撤回: 发布标注旧依据语种, 撤回对所有语言生效', async () => {
  const st0 = await get('/api/i18n/status');
  const peak = st0.json.statements.find(s => s.statementId === 'st_peak');
  assert.equal(peak.langs.en.status, 'stale', '英文翻译仍基于旧依据');
  assert.equal(peak.langs.en.basedOnRev, 1);
  assert.equal(peak.currentRev, 2);

  const pub = await api('POST', '/api/publications', { role: 'reviewer', by: 'reviewer_zhao', note: '验收测试发布' });
  assert.equal(pub.status, 201);
  assert.equal(pub.json.languages.en.status, 'stale');
  assert.ok(pub.json.languages.en.stale.includes('st_peak'), '发布必须指出哪些语种仍对应旧依据');
  assert.ok(pub.json.languages.en.missing.includes('st_cordon'), '缺译语种必须列出');

  // 更新翻译对齐当前依据
  const tr = await api('POST', '/api/translations', { role: 'editor', by: 'translator_wang', statementId: 'st_peak', lang: 'en', text: 'Visitors are advised to travel off-peak and avoid the 10:00–14:00 crowds; evening sessions are more comfortable.' });
  assert.equal(tr.json.basedOnRev, 2);

  // 撤回: 任何语言都不得再展示
  const st = (await get('/api/statements')).json.statements.find(s => s.id === 'st_peak');
  const ret = await api('POST', '/api/statements/st_peak/retract', { role: 'reviewer', by: 'reviewer_zhao', reason: '客流预测作废', version: st.version });
  assert.equal(ret.status, 200);
  for (const lang of ['zh', 'en']) {
    const g = await get(`/api/guide?audience=tourist&phase=before&lang=${lang}`);
    assert.ok(!g.json.items.find(i => i.statementId === 'st_peak'), `撤回后 ${lang} 视图不得再出现`);
  }
});

test('已读绑定修订: 新要求与修订保留变更标记', async () => {
  const vid = 'visitor-acceptance-1';
  const p = `/api/guide?audience=resident&phase=during&zoneId=zone_core&eventId=evt_shehuo&lang=zh&visitorId=${vid}`;
  const g1 = await get(p);
  const noise = g1.json.items.find(i => i.statementId === 'st_noise');
  assert.equal(noise.readState, 'unread');
  assert.equal(noise.changeMark, 'NEW', '新要求保留 NEW 标记');

  await api('POST', '/api/read', { visitorId: vid, items: [{ statementId: 'st_noise', rev: noise.currentRev }] });
  const g2 = await get(p);
  assert.equal(g2.json.items.find(i => i.statementId === 'st_noise').changeMark, null);

  const st = (await get('/api/statements')).json.statements.find(s => s.id === 'st_noise');
  await api('POST', '/api/statements/st_noise/revisions', { role: 'editor', by: 'editor_li', text: '巡游彩排及演出期间，周边居民与商户请遵守 21:30 后夜间降噪时段。', note: '降噪时段提前', version: st.version });
  const g3 = await get(p);
  const updated = g3.json.items.find(i => i.statementId === 'st_noise');
  assert.equal(updated.readState, 'read_stale');
  assert.equal(updated.changeMark, 'UPDATED', '已读后发生修订必须重新标记');
});

test('发布同源: 打印卡与分享页来自同一批准集合, 建议不被改写', async () => {
  const pub = await api('POST', '/api/publications', { role: 'reviewer', by: 'reviewer_zhao', note: '同源验收' });
  const pid = pub.json.id;
  const again = await get(`/api/publications/${pid}`);
  assert.deepEqual(again.json.items, pub.json.items, '同一发布物内容恒定');

  const food = pub.json.items.find(i => i.statementId === 'st_food');
  assert.ok(food, '发布集合应包含就餐建议');
  assert.equal(food.kind, 'advisory', '建议类条目在发布物中保持 advisory');
  const st = (await get('/api/statements')).json.statements.find(s => s.id === 'st_food');
  const rev = st.revisions.find(r => r.rev === st.currentRev);
  assert.equal(food.texts.zh, rev.text, '发布文本逐字来自批准陈述, 无自动摘要改写');
  assert.match(pub.json.disclaimer, /不构成处罚依据/);

  // 打印页与分享页共用同一渲染模块与同一接口
  const printHtml = fs.readFileSync(path.join(__dirname, '..', 'print.html'), 'utf8');
  const shareHtml = fs.readFileSync(path.join(__dirname, '..', 'share.html'), 'utf8');
  assert.ok(printHtml.includes('js/publication.js'));
  assert.ok(shareHtml.includes('js/publication.js'));
  assert.ok(printHtml.includes('/api/publications/') || printHtml.includes('publication.js'));
});

test('三视图同源: 相同事实引用共同陈述而非三套文本', async () => {
  const zh = await get('/api/guide?audience=staff&phase=during&zoneId=zone_museum&lang=zh');
  const en = await get('/api/guide?audience=staff&phase=during&zoneId=zone_museum&lang=en');
  const a = zh.json.items.find(i => i.statementId === 'st_flash');
  const b = en.json.items.find(i => i.statementId === 'st_flash');
  assert.ok(a && b);
  assert.equal(a.statementId, b.statementId, '不同语言/视图共享同一陈述 id');
  assert.equal(a.currentRev, b.currentRev);
  assert.equal(b.translationStatus, 'current');
  // 工作人员在英文视图下能看到缺译回退(警戒绳无英文翻译)
  const enBefore = await get('/api/guide?audience=staff&phase=before&zoneId=zone_core&eventId=evt_shehuo&lang=en');
  const cordon = enBefore.json.items.find(i => i.statementId === 'st_cordon');
  assert.equal(cordon.translationStatus, 'missing');
  assert.match(cordon.text, /警戒绳/, '缺译时回退中文原文并显式标注');
});
