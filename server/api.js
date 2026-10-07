'use strict';
/** REST API: 规则/陈述/翻译/来源/冲突/事件/区域/已读/发布 */
const crypto = require('crypto');
const { rid } = require('./db');
const engine = require('./rulesEngine');

const ROLES = { editor: 1, reviewer: 2, admin: 3 };
const EFFECTS = ['allow', 'forbid', 'require', 'advise'];
const AUDIENCES = ['resident', 'tourist', 'staff'];
const PHASES = ['before', 'during', 'after'];
const KINDS = ['advisory', 'mandatory', 'fact'];

function err(status, code, message, extra) {
  const e = new Error(message);
  e.status = status; e.code = code; e.extra = extra;
  return e;
}
function requireRole(body, min) {
  const role = body && body.role;
  if (!role || !(ROLES[role] >= ROLES[min])) throw err(403, 'forbidden', `需要 ${min} 及以上权限(role)`);
  return role;
}
function actor(body) { return (body && (body.by || body.reviewer)) || 'anonymous'; }
function checkVersion(doc, version) {
  if (version == null) throw err(409, 'version_required', '必须携带当前版本号 version 以防并发覆盖', { current: doc });
  if (Number(version) !== doc.version) throw err(409, 'version_conflict', `版本冲突: 当前版本为 ${doc.version}`, { current: doc });
}
function nowIso() { return new Date().toISOString(); }

/* ---------- handlers ---------- */

function guideHandler({ db, query, req }) {
  const q = {
    audience: query.audience || 'tourist',
    lang: query.lang || 'zh',
    phase: query.phase || null,
    zoneId: query.zoneId || null,
    eventId: query.eventId || null,
    lng: query.lng != null && query.lng !== '' ? Number(query.lng) : null,
    lat: query.lat != null && query.lat !== '' ? Number(query.lat) : null,
    visitorId: query.visitorId || null,
    at: query.at ? Date.parse(query.at) : Date.now()
  };
  if (!AUDIENCES.includes(q.audience)) throw err(400, 'bad_audience', '未知受众: ' + q.audience);
  if (q.phase && !PHASES.includes(q.phase)) throw err(400, 'bad_phase', '未知阶段: ' + q.phase);
  const payload = engine.buildGuide(db, q);
  const etag = 'W/"' + crypto.createHash('sha1').update(JSON.stringify(payload.items)).digest('hex') + '"';
  const headers = {
    ETag: etag,
    'Cache-Control': 'max-age=30, must-revalidate',
    'X-Data-Revision': String(db.revision)
  };
  if (req.headers['if-none-match'] === etag) return [304, null, headers];
  return [200, payload, headers];
}

function listStatements({ db }) {
  const revs = db.collection('statement_revisions').all();
  const translations = db.collection('translations').all();
  const statements = db.collection('statements').all().map(s => ({
    ...s,
    revisions: revs.filter(r => r.statementId === s.id).sort((a, b) => b.rev - a.rev),
    translations: translations.filter(t => t.statementId === s.id)
  }));
  return [200, { statements, dataRevision: db.revision }];
}

function createStatement({ db, body }) {
  requireRole(body, 'editor');
  const { key, kind, text } = body;
  if (!key || !text) throw err(400, 'bad_request', 'key 与 text 必填');
  if (!KINDS.includes(kind)) throw err(400, 'bad_kind', 'kind 须为 ' + KINDS.join('/'));
  const statements = db.collection('statements');
  if (statements.find(s => s.key === key).length) throw err(409, 'duplicate_key', 'key 已存在: ' + key);
  const id = rid('st');
  const at = nowIso();
  statements.insert({ id, key, kind, status: 'approved', currentRev: 1, version: 1, createdAt: at, updatedAt: at });
  db.collection('statement_revisions').insert({ id: rid('rev'), statementId: id, rev: 1, text, note: body.note || '', createdBy: actor(body), createdAt: at });
  return [201, statements.get(id)];
}

function reviseStatement({ db, params, body }) {
  requireRole(body, 'editor');
  const statements = db.collection('statements');
  const st = statements.get(params.id);
  if (!st) throw err(404, 'not_found', '陈述不存在');
  if (st.status === 'retracted') throw err(409, 'retracted', '已撤回的陈述不能再修订');
  checkVersion(st, body.version);
  if (!body.text) throw err(400, 'bad_request', 'text 必填');
  const at = nowIso();
  statements.update(st.id, d => {
    d.currentRev += 1;
    d.version += 1;
    d.updatedAt = at;
  });
  const rev = db.collection('statement_revisions').insert({
    id: rid('rev'), statementId: st.id, rev: st.currentRev, text: body.text,
    note: body.note || '', createdBy: actor(body), createdAt: at
  });
  return [200, { statement: statements.get(st.id), revision: rev }];
}

function retractStatement({ db, params, body }) {
  requireRole(body, 'reviewer');
  const statements = db.collection('statements');
  const st = statements.get(params.id);
  if (!st) throw err(404, 'not_found', '陈述不存在');
  checkVersion(st, body.version);
  statements.update(st.id, d => {
    d.status = 'retracted';
    d.retractedAt = nowIso();
    d.retractReason = body.reason || '';
    d.version += 1;
  });
  return [200, statements.get(st.id)];
}

function listRules({ db }) {
  const statements = db.collection('statements').all();
  const rules = db.collection('rules').all().map(r => {
    const st = statements.find(s => s.id === r.statementId);
    return { ...r, statementKey: st ? st.key : null, statementStatus: st ? st.status : 'missing' };
  });
  return [200, { rules, dataRevision: db.revision }];
}

function validateRuleBody(db, body) {
  if (!body.statementId || !db.collection('statements').get(body.statementId)) throw err(400, 'bad_statement', 'statementId 无效');
  if (!EFFECTS.includes(body.effect)) throw err(400, 'bad_effect', 'effect 须为 ' + EFFECTS.join('/'));
  if (!Array.isArray(body.audiences) || !body.audiences.length || body.audiences.some(a => !AUDIENCES.includes(a))) throw err(400, 'bad_audiences', 'audiences 须为 ' + AUDIENCES.join('/') + ' 的非空子集');
  if (!Array.isArray(body.phases) || !body.phases.length || body.phases.some(p => !PHASES.includes(p))) throw err(400, 'bad_phases', 'phases 须为 ' + PHASES.join('/') + ' 的非空子集');
  if (body.zoneId && !db.collection('zones').get(body.zoneId)) throw err(400, 'bad_zone', 'zoneId 无效');
  if (body.eventId && !db.collection('events').get(body.eventId)) throw err(400, 'bad_event', 'eventId 无效');
  for (const s of (body.sources || [])) {
    if (!db.collection('sources').get(s.sourceId)) throw err(400, 'bad_source', '来源不存在: ' + s.sourceId);
    if (!['supports', 'opposes'].includes(s.stance)) throw err(400, 'bad_stance', 'stance 须为 supports/opposes');
  }
}

function createRule({ db, body }) {
  requireRole(body, 'editor');
  validateRuleBody(db, body);
  const at = nowIso();
  const rule = db.collection('rules').insert({
    id: rid('rule'), statementId: body.statementId, effect: body.effect,
    audiences: body.audiences, phases: body.phases,
    zoneId: body.zoneId || null, eventId: body.eventId || null,
    priority: Number(body.priority) || 0,
    validFrom: body.validFrom || null, validTo: body.validTo || null,
    localNote: body.localNote || '',
    sources: body.sources || [],
    status: 'draft', review: null,
    version: 1, createdBy: actor(body), createdAt: at, updatedAt: at
  });
  return [201, rule];
}

function updateRule({ db, params, body }) {
  requireRole(body, 'editor');
  const rules = db.collection('rules');
  const rule = rules.get(params.id);
  if (!rule) throw err(404, 'not_found', '规则不存在');
  checkVersion(rule, body.version);
  validateRuleBody(db, Object.assign({}, rule, body));
  rules.update(rule.id, d => {
    d.statementId = body.statementId; d.effect = body.effect;
    d.audiences = body.audiences; d.phases = body.phases;
    d.zoneId = body.zoneId || null; d.eventId = body.eventId || null;
    d.priority = Number(body.priority) || 0;
    d.validFrom = body.validFrom || null; d.validTo = body.validTo || null;
    d.localNote = body.localNote || '';
    d.sources = body.sources || [];
    if (d.status === 'approved') { d.status = 'draft'; d.review = null; } // 修改后需重新审校
    d.version += 1; d.updatedAt = nowIso();
  });
  return [200, rules.get(rule.id)];
}

function approveRule({ db, params, body }) {
  requireRole(body, 'reviewer');
  const rules = db.collection('rules');
  const rule = rules.get(params.id);
  if (!rule) throw err(404, 'not_found', '规则不存在');
  checkVersion(rule, body.version); // 并发批准: 第二个请求将因版本过期得到 409
  if (!body.conclusion) throw err(400, 'bad_request', '审校结论 conclusion 必填');
  rules.update(rule.id, d => {
    d.status = 'approved';
    d.review = { reviewer: actor(body), conclusion: body.conclusion, at: nowIso() };
    d.version += 1; d.updatedAt = nowIso();
  });
  const conflicts = engine.detectConflicts(db, rules.get(rule.id));
  return [200, { rule: rules.get(rule.id), newConflicts: conflicts }];
}

function retractRule({ db, params, body }) {
  requireRole(body, 'reviewer');
  const rules = db.collection('rules');
  const rule = rules.get(params.id);
  if (!rule) throw err(404, 'not_found', '规则不存在');
  checkVersion(rule, body.version);
  rules.update(rule.id, d => {
    d.status = 'retracted';
    d.retractedAt = nowIso();
    d.retractReason = body.reason || '';
    d.version += 1; d.updatedAt = nowIso();
  });
  return [200, rules.get(rule.id)];
}

function listSources({ db }) {
  return [200, { sources: db.collection('sources').all(), dataRevision: db.revision }];
}

function createSource({ db, body }) {
  requireRole(body, 'editor');
  if (!body.title || !body.publisher) throw err(400, 'bad_request', 'title 与 publisher 必填');
  const src = db.collection('sources').insert({
    id: rid('src'), title: body.title, publisher: body.publisher,
    url: body.url || '', publishedAt: body.publishedAt || null,
    status: 'active', version: 1, createdBy: actor(body)
  });
  return [201, src];
}

function revokeSource({ db, params, body }) {
  requireRole(body, 'reviewer');
  const sources = db.collection('sources');
  const src = sources.get(params.id);
  if (!src) throw err(404, 'not_found', '来源不存在');
  checkVersion(src, body.version);
  // 撤销只改状态, 记录保留在库, 冲突来源仍可追溯
  sources.update(src.id, d => {
    d.status = 'revoked';
    d.revokedAt = nowIso();
    d.revokedReason = body.reason || '';
    d.version += 1;
  });
  return [200, sources.get(src.id)];
}

function listConflicts({ db }) {
  const rules = db.collection('rules').all();
  const sources = db.collection('sources').all();
  const conflicts = db.collection('conflicts').all().map(c => ({
    ...c,
    rules: c.ruleIds.map(id => {
      const r = rules.find(x => x.id === id);
      if (!r) return { id, missing: true };
      return {
        id: r.id, effect: r.effect, priority: r.priority, status: r.status,
        localNote: r.localNote,
        sources: (r.sources || []).map(s => {
          const src = sources.find(x => x.id === s.sourceId);
          return { sourceId: s.sourceId, stance: s.stance, title: src ? src.title : null, sourceStatus: src ? src.status : 'missing' };
        })
      };
    })
  }));
  return [200, { conflicts, dataRevision: db.revision }];
}

function resolveConflict({ db, params, body }) {
  requireRole(body, 'reviewer');
  const conflicts = db.collection('conflicts');
  const c = conflicts.get(params.id);
  if (!c) throw err(404, 'not_found', '冲突记录不存在');
  checkVersion(c, body.version);
  if (c.status !== 'pending') throw err(409, 'already_resolved', '该冲突已裁定');
  if (!c.ruleIds.includes(body.winnerRuleId)) throw err(400, 'bad_winner', 'winnerRuleId 必须是冲突双方之一');
  if (!body.rationale) throw err(400, 'bad_request', '裁定理由 rationale 必填');
  conflicts.update(c.id, d => {
    d.status = 'resolved';
    d.resolution = { winnerRuleId: body.winnerRuleId, rationale: body.rationale, decidedBy: actor(body), decidedAt: nowIso() };
    d.version += 1;
  });
  return [200, conflicts.get(c.id)];
}

function listTranslations({ db, query }) {
  let all = db.collection('translations').all();
  if (query.statementId) all = all.filter(t => t.statementId === query.statementId);
  return [200, { translations: all }];
}

function upsertTranslation({ db, body }) {
  requireRole(body, 'editor');
  const st = db.collection('statements').get(body.statementId);
  if (!st) throw err(404, 'not_found', '陈述不存在');
  if (st.status === 'retracted') throw err(409, 'retracted', '已撤回的陈述不再维护翻译');
  if (!body.lang || !body.text) throw err(400, 'bad_request', 'lang 与 text 必填');
  const translations = db.collection('translations');
  const existing = translations.findOne(t => t.statementId === st.id && t.lang === body.lang);
  if (existing) {
    translations.update(existing.id, d => {
      d.text = body.text;
      d.basedOnRev = st.currentRev; // 翻译重新对齐当前依据
      d.updatedBy = actor(body);
      d.updatedAt = nowIso();
      d.version += 1;
    });
    return [200, translations.get(existing.id)];
  }
  const tr = translations.insert({
    id: rid('tr'), statementId: st.id, lang: body.lang, text: body.text,
    basedOnRev: st.currentRev, updatedBy: actor(body), updatedAt: nowIso(), version: 1
  });
  return [201, tr];
}

function i18nStatus({ db }) {
  const statements = db.collection('statements').all();
  const translations = db.collection('translations').all();
  const report = statements.map(s => {
    const langs = {};
    for (const lang of engine.LANGS) {
      if (lang === 'zh') { langs.zh = { status: 'current', basedOnRev: s.currentRev }; continue; }
      const tr = translations.find(t => t.statementId === s.id && t.lang === lang);
      langs[lang] = tr
        ? { translationId: tr.id, basedOnRev: tr.basedOnRev, status: tr.basedOnRev < s.currentRev ? 'stale' : 'current' }
        : { status: 'missing' };
    }
    return { statementId: s.id, key: s.key, status: s.status, currentRev: s.currentRev, langs };
  });
  return [200, { statements: report, dataRevision: db.revision }];
}

function listEvents({ db }) {
  return [200, { events: db.collection('events').all(), dataRevision: db.revision }];
}

function rescheduleEvent({ db, params, body }) {
  requireRole(body, 'editor');
  const events = db.collection('events');
  const ev = events.get(params.id);
  if (!ev) throw err(404, 'not_found', '活动不存在');
  checkVersion(ev, body.version);
  const start = Date.parse(body.startAt);
  const end = Date.parse(body.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw err(400, 'bad_schedule', '起止时间无效');
  events.update(ev.id, d => {
    d.scheduleHistory = (d.scheduleHistory || []).concat([{ startAt: d.startAt, endAt: d.endAt, changedAt: nowIso(), changedBy: actor(body) }]);
    d.startAt = body.startAt;
    d.endAt = body.endAt;
    d.version += 1;
    d.updatedAt = nowIso();
  });
  return [200, events.get(ev.id)];
}

function listZones({ db }) {
  return [200, { zones: db.collection('zones').all(), dataRevision: db.revision }];
}

function updateZoneBoundary({ db, params, body }) {
  requireRole(body, 'editor');
  const zones = db.collection('zones');
  const z = zones.get(params.id);
  if (!z) throw err(404, 'not_found', '区域不存在');
  checkVersion(z, body.version);
  const b = body.boundary || {};
  const nums = [b.minLng, b.minLat, b.maxLng, b.maxLat].map(Number);
  if (nums.some(n => !Number.isFinite(n)) || nums[0] >= nums[2] || nums[1] >= nums[3]) throw err(400, 'bad_boundary', '边界无效');
  zones.update(z.id, d => {
    d.boundaryHistory = (d.boundaryHistory || []).concat([{ boundary: d.boundary, changedAt: nowIso(), changedBy: actor(body) }]);
    d.boundary = { minLng: nums[0], minLat: nums[1], maxLng: nums[2], maxLat: nums[3] };
    d.version += 1;
    d.updatedAt = nowIso();
  });
  return [200, zones.get(z.id)];
}

function markRead({ db, body }) {
  const visitorId = body.visitorId;
  if (!visitorId) throw err(400, 'bad_request', 'visitorId 必填');
  if (!Array.isArray(body.items) || !body.items.length) throw err(400, 'bad_request', 'items 必填');
  const receipts = db.collection('read_receipts');
  const at = nowIso();
  const saved = [];
  for (const item of body.items) {
    const st = db.collection('statements').get(item.statementId);
    if (!st) continue;
    const rev = Math.min(Number(item.rev) || 0, st.currentRev);
    const existing = receipts.findOne(r => r.visitorId === visitorId && r.statementId === st.id);
    if (existing) {
      if (rev > existing.rev) receipts.update(existing.id, d => { d.rev = rev; d.readAt = at; });
      saved.push(receipts.get(existing.id));
    } else {
      saved.push(receipts.insert({ id: rid('rr'), visitorId, statementId: st.id, rev, readAt: at }));
    }
  }
  return [200, { receipts: saved }];
}

function listReceipts({ db, query }) {
  if (!query.visitorId) throw err(400, 'bad_request', 'visitorId 必填');
  return [200, { receipts: db.collection('read_receipts').find(r => r.visitorId === query.visitorId) }];
}

function publish({ db, body }) {
  requireRole(body, 'reviewer');
  const pub = engine.buildPublication(db, actor(body), body.note || '');
  return [201, pub];
}

function listPublications({ db }) {
  const pubs = db.collection('publications').all()
    .map(p => ({ id: p.id, createdAt: p.createdAt, createdBy: p.createdBy, note: p.note, itemCount: p.items.length, languages: p.languages, dataRevision: p.dataRevision }));
  return [200, { publications: pubs }];
}

function getPublication({ db, params }) {
  const pub = db.collection('publications').get(params.id);
  if (!pub) throw err(404, 'not_found', '发布不存在');
  return [200, pub];
}

function latestPublication({ db }) {
  const pubs = db.collection('publications').all();
  if (!pubs.length) throw err(404, 'no_publication', '尚未发布');
  return [200, pubs[pubs.length - 1]];
}

function meta({ db }) {
  return [200, {
    dataRevision: db.revision,
    counts: {
      statements: db.collection('statements').all().length,
      rules: db.collection('rules').all().length,
      sources: db.collection('sources').all().length,
      conflicts: db.collection('conflicts').all().length,
      publications: db.collection('publications').all().length
    }
  }];
}

/* ---------- router ---------- */

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler });
}

route('GET', '/api/meta', meta);
route('GET', '/api/guide', guideHandler);
route('GET', '/api/statements', listStatements);
route('POST', '/api/statements', createStatement);
route('POST', '/api/statements/:id/revisions', reviseStatement);
route('POST', '/api/statements/:id/retract', retractStatement);
route('GET', '/api/rules', listRules);
route('POST', '/api/rules', createRule);
route('PUT', '/api/rules/:id', updateRule);
route('POST', '/api/rules/:id/approve', approveRule);
route('POST', '/api/rules/:id/retract', retractRule);
route('GET', '/api/sources', listSources);
route('POST', '/api/sources', createSource);
route('POST', '/api/sources/:id/revoke', revokeSource);
route('GET', '/api/conflicts', listConflicts);
route('POST', '/api/conflicts/:id/resolve', resolveConflict);
route('GET', '/api/translations', listTranslations);
route('POST', '/api/translations', upsertTranslation);
route('GET', '/api/i18n/status', i18nStatus);
route('GET', '/api/events', listEvents);
route('POST', '/api/events/:id/reschedule', rescheduleEvent);
route('GET', '/api/zones', listZones);
route('PUT', '/api/zones/:id/boundary', updateZoneBoundary);
route('POST', '/api/read', markRead);
route('GET', '/api/read', listReceipts);
route('POST', '/api/publications', publish);
route('GET', '/api/publications', listPublications);
route('GET', '/api/publications/latest', latestPublication);
route('GET', '/api/publications/:id', getPublication);

function send(res, status, payload, headers) {
  const body = payload == null ? '' : JSON.stringify(payload);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));
  res.end(body);
}

function handle(db, req, res, url) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body = {};
    if (chunks.length) {
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return send(res, 400, { error: 'bad_json', message: '请求体不是合法 JSON' }); }
    }
    const query = Object.fromEntries(url.searchParams.entries());
    const method = req.method === 'HEAD' ? 'GET' : req.method; // HEAD 复用 GET 语义(含 ETag)
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.rx.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      let out;
      try {
        out = r.handler({ db, req, params, query, body });
      } catch (e) {
        return send(res, e.status || 500, { error: e.code || 'internal', message: e.message, detail: e.extra });
      }
      const [status, payload, headers] = out;
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && status < 400) db.save();
      if (status === 304) { res.writeHead(304, headers || {}); return res.end(); }
      return send(res, status, payload, headers);
    }
    send(res, 404, { error: 'not_found', message: '接口不存在: ' + url.pathname });
  });
}

module.exports = { handle };
