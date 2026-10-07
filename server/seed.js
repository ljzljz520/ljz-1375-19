'use strict';
/** 种子数据: 西安"社火巡游 + 景区参观"礼仪规则, 含刻意构造的冲突/翻译滞后/撤回样例 */
const engine = require('./rulesEngine');

function seed(db) {
  const now = '2026-10-01T09:00:00+08:00';

  const zones = db.collection('zones');
  zones.insert({ id: 'zone_museum', name: '秦始皇帝陵博物院展区', boundary: { minLng: 109.27, minLat: 34.38, maxLng: 109.29, maxLat: 34.40 }, version: 1, updatedAt: now });
  zones.insert({ id: 'zone_core', name: '社火巡游核心区(大唐不夜城主街)', boundary: { minLng: 108.95, minLat: 34.21, maxLng: 108.97, maxLat: 34.23 }, version: 1, updatedAt: now });
  zones.insert({ id: 'zone_huimin', name: '回民街片区', boundary: { minLng: 108.93, minLat: 34.25, maxLng: 108.94, maxLat: 34.26 }, version: 1, updatedAt: now });

  db.collection('events').insert({
    id: 'evt_shehuo', name: '关中社火巡游', zoneId: 'zone_core',
    startAt: '2026-10-10T10:00:00+08:00', endAt: '2026-10-10T12:00:00+08:00',
    version: 1, scheduleHistory: [], updatedAt: now
  });

  const sources = db.collection('sources');
  sources.insert({ id: 'src_museum', title: '秦始皇帝陵博物院《参观须知》(2026-09 版)', publisher: '秦始皇帝陵博物院', url: 'https://example.org/museum-notice', publishedAt: '2026-09-01', status: 'active', version: 1 });
  sources.insert({ id: 'src_org', title: '《社火巡游组委会公告》', publisher: '社火巡游组委会', url: 'https://example.org/shehuo-notice', publishedAt: '2026-09-30', status: 'active', version: 1 });
  sources.insert({ id: 'src_joint', title: '《公安·文保联合通告》', publisher: '市公安局·市文物局', url: 'https://example.org/joint-notice', publishedAt: '2026-10-02', status: 'active', version: 1 });
  sources.insert({ id: 'src_street', title: '回民街管委会《文明就餐提示》', publisher: '回民街管委会', url: 'https://example.org/huimin-tips', publishedAt: '2026-09-15', status: 'active', version: 1 });
  sources.insert({ id: 'src_transport', title: '公交集团《临时摆渡车通知》', publisher: '市公交集团', url: 'https://example.org/shuttle', publishedAt: '2026-09-28', status: 'revoked', revokedAt: '2026-10-05T10:00:00+08:00', revokedReason: '摆渡车线路取消', version: 2 });

  const statements = db.collection('statements');
  const revs = db.collection('statement_revisions');
  const translations = db.collection('translations');
  const addStatement = (id, key, kind, text) => {
    statements.insert({ id, key, kind, status: 'approved', currentRev: 1, version: 1, createdAt: now, updatedAt: now });
    revs.insert({ id: id + '_r1', statementId: id, rev: 1, text, note: '初始版本', createdBy: 'editor_li', createdAt: now });
  };
  const addTranslation = (statementId, lang, text, basedOnRev) => {
    translations.insert({ id: 'tr_' + statementId + '_' + lang, statementId, lang, text, basedOnRev, updatedBy: 'translator_wang', updatedAt: now, version: 1 });
  };

  addStatement('st_flash', 'museum.flash', 'mandatory', '兵马俑展厅内禁止使用闪光灯拍照，强光会加速陶俑彩绘氧化。');
  addTranslation('st_flash', 'en', 'Flash photography is prohibited in the Terracotta Army exhibition halls; strong light accelerates pigment oxidation.', 1);

  addStatement('st_queue', 'museum.queue', 'mandatory', '请按标识队列有序参观，勿翻越护栏、勿拥挤。');
  addTranslation('st_queue', 'en', 'Please follow the marked queue. Do not climb barriers or crowd.', 1);

  addStatement('st_photo_core', 'shehuo.photo_core', 'fact', '社火巡游核心表演区(大唐不夜城主街)的游客拍摄管理要求。');
  addTranslation('st_photo_core', 'en', 'Photography rules for visitors in the core parade area (Grand Tang Mall main street).', 1);

  // 错峰提示: 原文已到 rev2, 英文翻译仍基于 rev1 → 翻译滞后示例
  statements.insert({ id: 'st_peak', key: 'travel.off_peak', kind: 'advisory', status: 'approved', currentRev: 2, version: 2, createdAt: now, updatedAt: '2026-10-03T09:00:00+08:00' });
  revs.insert({ id: 'st_peak_r1', statementId: 'st_peak', rev: 1, text: '建议游客错峰出行，避开 11:00–15:00 客流高峰。', note: '初版', createdBy: 'editor_li', createdAt: now });
  revs.insert({ id: 'st_peak_r2', statementId: 'st_peak', rev: 2, text: '建议游客错峰出行，避开 10:00–14:00 客流高峰；夜间场次体验更佳。', note: '按最新客流预测调整高峰时段', createdBy: 'editor_li', createdAt: '2026-10-03T09:00:00+08:00' });
  addTranslation('st_peak', 'en', 'Visitors are advised to travel off-peak and avoid the 11:00–15:00 crowds.', 1);

  addStatement('st_food', 'huimin.dining', 'advisory', '回民街就餐请适量点餐、避免浪费，尊重清真饮食习俗，勿携带非清真食品进入清真餐馆。');
  addTranslation('st_food', 'en', 'At Muslim Quarter eateries, order moderately and avoid waste. Respect halal customs; do not bring non-halal food into halal restaurants.', 1);

  addStatement('st_cordon', 'shehuo.cordon', 'mandatory', '现场工作人员须在巡游开始前 60 分钟完成警戒绳设置与双语告示牌检查。');
  // 故意不建英文翻译 → missing 示例

  addStatement('st_noise', 'shehuo.noise', 'advisory', '巡游彩排及演出期间，周边居民与商户请遵守 22:00 后夜间降噪时段，调低户外音响。');
  addTranslation('st_noise', 'en', 'During rehearsals and performances, residents and shops along the route are asked to observe quiet hours after 22:00.', 1);

  // 已撤回陈述: 任何语言都不得再展示
  statements.insert({ id: 'st_shuttle', key: 'event.shuttle', kind: 'fact', status: 'retracted', currentRev: 1, version: 2, createdAt: now, updatedAt: '2026-10-05T10:00:00+08:00', retractedAt: '2026-10-05T10:00:00+08:00', retractReason: '摆渡车线路取消，提示作废' });
  revs.insert({ id: 'st_shuttle_r1', statementId: 'st_shuttle', rev: 1, text: '活动期间临时摆渡车乘车点位于南门广场东侧。', note: '初始版本', createdBy: 'editor_li', createdAt: now });
  addTranslation('st_shuttle', 'en', 'The temporary shuttle stop is on the east side of the South Gate square.', 1);

  const rules = db.collection('rules');
  const addRule = (doc) => rules.insert(Object.assign({
    status: 'approved', version: 1, createdAt: now, updatedAt: now,
    validFrom: null, validTo: null,
    review: { reviewer: 'reviewer_zhao', conclusion: '内容属实，同意发布。', at: now }
  }, doc));
  addRule({ id: 'rule_flash', statementId: 'st_flash', effect: 'forbid', audiences: ['tourist', 'staff'], phases: ['before', 'during', 'after'], zoneId: 'zone_museum', eventId: null, priority: 80, localNote: '临潼展区彩绘保护要求，展厅入口与讲解员会双重提醒。', sources: [{ sourceId: 'src_museum', stance: 'supports' }] });
  addRule({ id: 'rule_queue', statementId: 'st_queue', effect: 'require', audiences: ['tourist'], phases: ['during'], zoneId: 'zone_museum', eventId: null, priority: 50, localNote: '节假日增设蛇形队列护栏。', sources: [{ sourceId: 'src_museum', stance: 'supports' }] });
  addRule({ id: 'rule_photo_allow', statementId: 'st_photo_core', effect: 'allow', audiences: ['tourist'], phases: ['during'], zoneId: 'zone_core', eventId: 'evt_shehuo', priority: 60, localNote: '组委会鼓励拍摄传播，但请避开表演者正前方。', sources: [{ sourceId: 'src_org', stance: 'supports' }] });
  addRule({ id: 'rule_photo_forbid', statementId: 'st_photo_core', effect: 'forbid', audiences: ['tourist'], phases: ['during'], zoneId: 'zone_core', eventId: 'evt_shehuo', priority: 60, localNote: '联合通告：核心区人员密集，驻足拍摄易造成拥堵与安全隐患。', sources: [{ sourceId: 'src_joint', stance: 'supports' }, { sourceId: 'src_org', stance: 'opposes' }] });
  addRule({ id: 'rule_peak', statementId: 'st_peak', effect: 'advise', audiences: ['tourist'], phases: ['before'], zoneId: null, eventId: null, priority: 10, localNote: '节假日 10 点后主景区排队显著增长。', sources: [{ sourceId: 'src_org', stance: 'supports' }] });
  addRule({ id: 'rule_food', statementId: 'st_food', effect: 'advise', audiences: ['tourist'], phases: ['during'], zoneId: 'zone_huimin', eventId: null, priority: 20, localNote: '清真餐馆标识由管委会统一悬挂。', sources: [{ sourceId: 'src_street', stance: 'supports' }] });
  addRule({ id: 'rule_cordon', statementId: 'st_cordon', effect: 'require', audiences: ['staff'], phases: ['before'], zoneId: 'zone_core', eventId: 'evt_shehuo', priority: 90, localNote: '警戒绳与双语告示牌清单见执勤手册附录。', sources: [{ sourceId: 'src_joint', stance: 'supports' }] });
  addRule({ id: 'rule_noise', statementId: 'st_noise', effect: 'advise', audiences: ['resident'], phases: ['during', 'after'], zoneId: 'zone_core', eventId: 'evt_shehuo', priority: 30, localNote: '社区网格员会提前一晚入户提醒。', sources: [{ sourceId: 'src_org', stance: 'supports' }] });
  addRule({ id: 'rule_shuttle', statementId: 'st_shuttle', effect: 'advise', audiences: ['tourist'], phases: ['before'], zoneId: null, eventId: null, priority: 5, localNote: '', sources: [{ sourceId: 'src_transport', stance: 'supports' }] });

  // 冲突登记: "可拍摄" vs "禁止拍摄" 同时命中, 双方来源都保留在库
  db.collection('conflicts').insert({
    id: 'conf_photo', statementId: 'st_photo_core',
    ruleIds: ['rule_photo_allow', 'rule_photo_forbid'],
    status: 'pending', detectedAt: now, version: 1
  });

  // 初始发布快照(打印卡/分享页同源)
  engine.buildPublication(db, 'system', '初始发布');
}

module.exports = { seed };
