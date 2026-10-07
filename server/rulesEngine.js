'use strict';
/**
 * 规则引擎:
 * 1. 规则按 受众 × 活动阶段 × 区域 × 活动 × 有效期 匹配;
 * 2. 同一陈述(statement)下的多条规则先做"组合优先级"比较
 *    (priority → 特异性: 活动>区域>全局 → 更新时间);
 * 3. 效力相反(允许↔禁止 / 要求↔禁止)且优先级无法区分时,
 *    必须经"显式冲突审批"(conflicts 集合)裁定; 未裁定前一律
 *    返回 pending_verification(待核), 由前端原样展示, 绝不猜测;
 * 4. 支撑来源全部被撤销的规则同样降级为待核(来源保留在库, 不删除);
 * 5. 撤回的陈述对所有语言同时生效, 任何语言都不得绕过。
 */
const { rid } = require('./db');

const OPPOSITES = {
  allow: ['forbid'],
  forbid: ['allow', 'require'],
  require: ['forbid'],
  advise: []
};

const LANGS = ['zh', 'en'];

function effectsOppose(a, b) {
  return (OPPOSITES[a] || []).includes(b);
}

function specificity(rule) {
  let s = 0;
  if (rule.eventId) s += 2;
  if (rule.zoneId) s += 1;
  return s;
}

function cmpRules(a, b) {
  if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
  const s = specificity(b) - specificity(a);
  if (s !== 0) return s;
  return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
}

function ruleMatches(rule, q) {
  if (rule.status !== 'approved') return false;
  const at = q.at;
  if (rule.validFrom && at < Date.parse(rule.validFrom)) return false;
  if (rule.validTo && at > Date.parse(rule.validTo)) return false;
  if (!rule.audiences.includes(q.audience)) return false;
  if (!rule.phases.includes(q.phase)) return false;
  if (rule.zoneId && rule.zoneId !== q.zoneId) return false;
  if (rule.eventId && rule.eventId !== q.eventId) return false;
  return true;
}

function computePhase(event, at) {
  if (!event) return null;
  if (at < Date.parse(event.startAt)) return 'before';
  if (at > Date.parse(event.endAt)) return 'after';
  return 'during';
}

function zoneAtPoint(zones, lng, lat) {
  return zones.find(z => {
    const b = z.boundary;
    return b && lng >= b.minLng && lng <= b.maxLng && lat >= b.minLat && lat <= b.maxLat;
  }) || null;
}

function supportingSourcesCompromised(rule, sourcesCol) {
  const supports = (rule.sources || []).filter(s => s.stance === 'supports');
  if (supports.length === 0) return false;
  return supports.every(s => {
    const src = sourcesCol.get(s.sourceId);
    return src && src.status === 'revoked';
  });
}

function resolveEffects(rules, conflicts) {
  const sorted = rules.slice().sort(cmpRules);
  let opposition = false;
  for (let i = 0; i < sorted.length && !opposition; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (effectsOppose(sorted[i].effect, sorted[j].effect)) { opposition = true; break; }
    }
  }
  if (!opposition) {
    return { status: 'ok', effect: sorted[0].effect, decidedBy: 'uncontested', winnerRuleId: sorted[0].id, ruleIds: sorted.map(r => r.id) };
  }
  // 1) 显式冲突审批优先
  const ids = new Set(sorted.map(r => r.id));
  const res = (conflicts || []).find(c =>
    c.status === 'resolved' &&
    c.ruleIds.every(id => ids.has(id)) &&
    c.resolution && ids.has(c.resolution.winnerRuleId));
  if (res) {
    const winner = sorted.find(r => r.id === res.resolution.winnerRuleId);
    if (winner) {
      return { status: 'ok', effect: winner.effect, decidedBy: 'explicit_approval', conflictId: res.id, winnerRuleId: winner.id, ruleIds: sorted.map(r => r.id) };
    }
  }
  // 2) 组合优先级比较
  const top = sorted[0];
  const tied = sorted.filter(r => cmpRules(r, top) === 0);
  const topOpposed = tied.some(r => effectsOppose(r.effect, top.effect));
  if (!topOpposed) {
    return { status: 'ok', effect: top.effect, decidedBy: 'priority', contested: true, winnerRuleId: top.id, ruleIds: sorted.map(r => r.id) };
  }
  // 3) 无法确认 → 待核
  return {
    status: 'pending_verification',
    reason: 'effect_conflict',
    candidates: tied.map(r => ({ ruleId: r.id, effect: r.effect, priority: r.priority })),
    ruleIds: sorted.map(r => r.id)
  };
}

function scopesOverlap(a, b) {
  const aud = a.audiences.some(x => b.audiences.includes(x));
  const pha = a.phases.some(x => b.phases.includes(x));
  const zone = !a.zoneId || !b.zoneId || a.zoneId === b.zoneId;
  const evt = !a.eventId || !b.eventId || a.eventId === b.eventId;
  return aud && pha && zone && evt;
}

function detectConflicts(db, rule) {
  const others = db.collection('rules').all()
    .filter(r => r.status === 'approved' && r.statementId === rule.statementId && r.id !== rule.id);
  const conflicts = db.collection('conflicts');
  const created = [];
  for (const other of others) {
    if (!effectsOppose(rule.effect, other.effect)) continue;
    if (!scopesOverlap(rule, other)) continue;
    const existing = conflicts.findOne(c => c.ruleIds.includes(rule.id) && c.ruleIds.includes(other.id));
    if (existing) continue;
    created.push(conflicts.insert({
      id: rid('conf'), statementId: rule.statementId, ruleIds: [rule.id, other.id],
      status: 'pending', detectedAt: new Date().toISOString(), version: 1
    }));
  }
  return created;
}

function collectSources(rs, sourcesCol) {
  const map = new Map();
  for (const r of rs) for (const s of (r.sources || [])) map.set(s.sourceId, s.stance);
  return [...map.entries()].map(([sourceId, stance]) => {
    const src = sourcesCol.get(sourceId);
    return src ? {
      id: src.id, title: src.title, publisher: src.publisher, stance,
      status: src.status, revokedReason: src.revokedReason || null
    } : null;
  }).filter(Boolean);
}

function resolveStatementRules(rs, conflicts, sourcesCol) {
  const resolution = resolveEffects(rs, conflicts);
  let status = resolution.status;
  let reason = resolution.reason || null;
  const winner = resolution.winnerRuleId ? rs.find(r => r.id === resolution.winnerRuleId) : null;
  if (status === 'ok' && winner && supportingSourcesCompromised(winner, sourcesCol)) {
    status = 'pending_verification';
    reason = 'source_revoked';
  }
  return { resolution, status, reason, winner };
}

/**
 * 组装礼仪提示视图。三种受众视图只是同一批准集合的不同投影:
 * 文本永远来自共享陈述(statement), 视图只调整 emphasis/排序, 不复制文本。
 */
function buildGuide(db, q) {
  const zonesCol = db.collection('zones');
  const eventsCol = db.collection('events');
  const rulesCol = db.collection('rules');
  const statementsCol = db.collection('statements');
  const revsCol = db.collection('statement_revisions');
  const translationsCol = db.collection('translations');
  const sourcesCol = db.collection('sources');

  const at = q.at || Date.now();
  const event = q.eventId ? eventsCol.get(q.eventId) : null;
  let zoneId = q.zoneId || null;
  let zoneResolvedBy = zoneId ? 'explicit' : null;
  if (!zoneId && q.lng != null && q.lat != null) {
    const z = zoneAtPoint(zonesCol.all(), Number(q.lng), Number(q.lat));
    zoneId = z ? z.id : null;
    zoneResolvedBy = 'point';
  }
  // 仅在未提供任何位置信息(显式区域或坐标)时, 才从活动继承区域;
  // 客户端明确给了坐标且未命中任何区域时, 不得用活动区域兜底
  if (!zoneId && q.lng == null && q.lat == null && event && event.zoneId) {
    zoneId = event.zoneId;
    zoneResolvedBy = 'event';
  }
  let phase = q.phase || null;
  let phaseResolvedBy = phase ? 'explicit' : null;
  if (!phase && event) { phase = computePhase(event, at); phaseResolvedBy = 'event_schedule'; }
  if (!phase) { phase = 'during'; phaseResolvedBy = 'default'; }

  const scope = { audience: q.audience, phase, zoneId, eventId: event ? event.id : null, at };
  const matched = rulesCol.all().filter(r => ruleMatches(r, scope));
  const conflicts = db.collection('conflicts').all();
  const receipts = q.visitorId
    ? db.collection('read_receipts').find(r => r.visitorId === q.visitorId)
    : [];

  const byStatement = new Map();
  for (const r of matched) {
    if (!byStatement.has(r.statementId)) byStatement.set(r.statementId, []);
    byStatement.get(r.statementId).push(r);
  }

  const items = [];
  for (const [sid, rs] of byStatement.entries()) {
    const st = statementsCol.get(sid);
    if (!st || st.status === 'retracted') continue; // 撤回对所有语言同时生效
    const rev = revsCol.findOne(x => x.statementId === sid && x.rev === st.currentRev);
    const { resolution, status, reason, winner } = resolveStatementRules(rs, conflicts, sourcesCol);

    let text = rev ? rev.text : '';
    let translationStatus = 'current';
    let basedOnRev = st.currentRev;
    if (q.lang !== 'zh') {
      const tr = translationsCol.findOne(t => t.statementId === sid && t.lang === q.lang);
      if (!tr) {
        translationStatus = 'missing'; // 缺译: 回退原文并显式标注
      } else {
        text = tr.text;
        basedOnRev = tr.basedOnRev;
        if (tr.basedOnRev < st.currentRev) translationStatus = 'stale';
      }
    }

    const receipt = receipts.find(x => x.statementId === sid);
    let readState = 'unread';
    let changeMark = 'NEW'; // 新要求保留变更标记
    if (receipt) {
      if (receipt.rev >= st.currentRev) { readState = 'read_current'; changeMark = null; }
      else { readState = 'read_stale'; changeMark = 'UPDATED'; }
    }

    const maxPriority = Math.max(...rs.map(r => r.priority || 0));
    items.push({
      statementId: sid,
      key: st.key,
      kind: st.kind,
      rev: st.currentRev,
      text, lang: q.lang, translationStatus, basedOnRev, currentRev: st.currentRev,
      status, reason,
      effect: status === 'ok' ? resolution.effect : null,
      decidedBy: status === 'ok' ? resolution.decidedBy : null,
      contested: !!resolution.contested,
      candidates: status === 'pending_verification'
        ? (resolution.candidates || rs.map(r => ({ ruleId: r.id, effect: r.effect, priority: r.priority })))
        : undefined,
      localNote: (winner && winner.localNote) || rs[0].localNote || null,
      emphasis: maxPriority >= 80 ? 'high' : (maxPriority >= 50 ? 'normal' : 'low'),
      sources: collectSources(rs, sourcesCol),
      readState, changeMark,
      ruleIds: rs.map(r => r.id)
    });
  }
  const rank = { high: 0, normal: 1, low: 2 };
  items.sort((a, b) => rank[a.emphasis] - rank[b.emphasis] || a.key.localeCompare(b.key));

  return {
    items,
    meta: {
      audience: q.audience, lang: q.lang,
      phase, phaseResolvedBy, zoneId, zoneResolvedBy,
      eventId: scope.eventId, at: new Date(at).toISOString(),
      dataRevision: db.revision
    }
  };
}

/**
 * 发布: 把当前"批准集合"快照为不可变发布物。
 * 打印卡与分享页都从该快照生成; 快照记录每个语种的滞后/缺失情况,
 * 让发布者明确知道哪些语种仍对应旧依据。
 */
function buildPublication(db, by, note) {
  const now = new Date().toISOString();
  const rulesCol = db.collection('rules');
  const statementsCol = db.collection('statements');
  const revsCol = db.collection('statement_revisions');
  const translationsCol = db.collection('translations');
  const sourcesCol = db.collection('sources');
  const conflicts = db.collection('conflicts').all();
  const at = Date.now();

  const approved = rulesCol.all().filter(r => {
    if (r.status !== 'approved') return false;
    const st = statementsCol.get(r.statementId);
    return st && st.status !== 'retracted';
  });

  const scopeMap = new Map();
  for (const r of approved) {
    for (const a of r.audiences) for (const p of r.phases) {
      const key = [a, p, r.zoneId || '', r.eventId || ''].join('|');
      if (!scopeMap.has(key)) scopeMap.set(key, { audience: a, phase: p, zoneId: r.zoneId || null, eventId: r.eventId || null });
    }
  }

  const items = [];
  for (const scope of scopeMap.values()) {
    const matched = approved.filter(r => ruleMatches(r, Object.assign({}, scope, { at })));
    const byStatement = new Map();
    for (const r of matched) {
      if (!byStatement.has(r.statementId)) byStatement.set(r.statementId, []);
      byStatement.get(r.statementId).push(r);
    }
    for (const [sid, rs] of byStatement) {
      const st = statementsCol.get(sid);
      const rev = revsCol.findOne(x => x.statementId === sid && x.rev === st.currentRev);
      const { resolution, status, reason } = resolveStatementRules(rs, conflicts, sourcesCol);
      const texts = { zh: rev ? rev.text : '' };
      for (const lang of LANGS) {
        if (lang === 'zh') continue;
        const tr = translationsCol.findOne(t => t.statementId === sid && t.lang === lang);
        texts[lang] = tr
          ? { translationId: tr.id, text: tr.text, basedOnRev: tr.basedOnRev, status: tr.basedOnRev < st.currentRev ? 'stale' : 'current' }
          : null;
      }
      items.push({
        statementId: sid, key: st.key, kind: st.kind, statementRev: st.currentRev,
        scope,
        status, reason,
        effect: status === 'ok' ? resolution.effect : null,
        decidedBy: status === 'ok' ? resolution.decidedBy : null,
        texts,
        sources: collectSources(rs, sourcesCol)
      });
    }
  }
  items.sort((a, b) => a.key.localeCompare(b.key) || a.scope.audience.localeCompare(b.scope.audience) || a.scope.phase.localeCompare(b.scope.phase));

  const languages = {};
  const stmtIds = [...new Set(items.map(i => i.statementId))];
  for (const lang of LANGS) {
    if (lang === 'zh') { languages.zh = { status: 'current', stale: [], missing: [] }; continue; }
    const stale = [];
    const missing = [];
    for (const sid of stmtIds) {
      const st = statementsCol.get(sid);
      const tr = translationsCol.findOne(t => t.statementId === sid && t.lang === lang);
      if (!tr) missing.push(sid);
      else if (tr.basedOnRev < st.currentRev) stale.push(sid);
    }
    languages[lang] = { status: stale.length ? 'stale' : (missing.length ? 'incomplete' : 'current'), stale, missing };
  }

  const pub = {
    id: rid('pub'), createdAt: now, createdBy: by, note: note || '',
    dataRevision: db.revision,
    items, languages,
    disclaimer: '本集合中"建议"类内容为文明倡导, 不构成处罚依据; 打印卡与分享页均从本批准集合生成。'
  };
  return db.collection('publications').insert(pub);
}

module.exports = {
  LANGS, OPPOSITES,
  effectsOppose, cmpRules, ruleMatches, computePhase, zoneAtPoint,
  resolveEffects, detectConflicts, buildGuide, buildPublication
};
