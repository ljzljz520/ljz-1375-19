# 西安文化介绍网站 + 礼仪规则与来源工作台

本站原为静态文化介绍站，现已将"礼仪提示"升级为**全栈规则与来源工作台**：网页按受众、活动阶段和语言组织说明；API 保存当地解释、适用范围与审校结论；数据库保留冲突来源（只改状态、不删除）。

## 页面

| 页面 | 说明 |
| --- | --- |
| `index.html` / `activities.html` / `travel.html` | 原有文化介绍页（保留） |
| `guide.html` | 礼仪提示：居民 / 游客 / 现场工作人员三视图 × 活动阶段 × 语言；冲突未裁定显示**待核**而非前端猜测；已读绑定修订号，新要求保留变更标记；离线缓存 30s TTL，过期必须重新校验 |
| `workbench.html` | 规则与来源工作台：规则起草/批准（审校结论）、陈述修订与翻译、来源登记/撤销、冲突显式裁定、发布、活动改期、区域边界调整 |
| `print.html` / `share.html` | 打印卡与分享页：都从**同一批准集合**（发布快照）经同一渲染模块 `js/publication.js` 生成；"建议"类内容永不改写成处罚规则 |

## 架构

- **数据库**（`server/db.js`）：JSON 文档库，原子写入 `data/db.json`；冲突/撤销来源、历史修订、改期与边界变更全部留痕。
- **规则引擎**（`server/rulesEngine.js`）：
  - 规则按 受众 × 阶段 × 区域 × 活动 × 有效期 匹配；
  - 同一事实由共享陈述（statement）承载，三视图只是投影，不会漂移成三套文本；
  - 效力相反时先比较组合优先级（priority → 特异性 → 时间），无法区分则必须**显式冲突审批**；未裁定一律 `pending_verification`（待核）；
  - 支撑来源全部撤销 → 自动降级为待核；陈述撤回对**所有语言**同时生效，换语言无法绕过。
- **API**（`server/api.js`）：`/api/guide`、`/api/rules`、`/api/statements`、`/api/translations`、`/api/sources`、`/api/conflicts`、`/api/events/:id/reschedule`、`/api/zones/:id/boundary`、`/api/read`、`/api/publications` 等；所有写操作要求 `version` 乐观锁（并发编辑/重复批准返回 409）。
- **翻译治理**：翻译记录绑定所依据的原文修订号；原文修订后旧翻译自动标记 `stale`；发布快照逐语种报告"仍对应旧依据"的条目。
- **缓存**：`/api/guide` 返回 `ETag` + `Cache-Control: max-age=30` + `X-Data-Revision`；前端 localStorage 缓存与 TTL 对齐，过期离线时明确标注而不冒充新鲜内容。

## 运行

```bash
npm start          # http://localhost:3000 （首启自动播种 data/db.json）
npm test           # node --test：12 项验收测试
```

## 验收场景覆盖（test/acceptance.test.js）

活动改期、区域边界变化、来源撤销、编辑并发批准（409）、离线缓存过期（ETag/304）、"可拍摄 vs 禁止拍摄"冲突待核与显式审批、优先级决议、翻译滞后与撤回跨语言生效、已读绑定修订与变更标记、打印卡/分享页同源且建议不被改写、三视图共享共同陈述。
