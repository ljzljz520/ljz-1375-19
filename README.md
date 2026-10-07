# 西安文化介绍网站 · 礼仪提示规则与来源工作台

静态文化站（历史背景 / 民俗活动 / 旅游指南）+ 全栈「礼仪提示」系统：
网页按**受众 × 活动阶段 × 语言**组织说明，API 保存当地解释、适用范围与审校结论，
数据库保留冲突来源。后端仅使用 Python 标准库（http.server + sqlite3），无外部依赖。

## 快速开始

```bash
python3 server/app.py 8000        # 启动（自动建库+种子数据）
# 公众视图    http://localhost:8000/etiquette.html
# 审校工作台  http://localhost:8000/workbench.html
# 打印/分享   http://localhost:8000/print.html?pub=1&mode=print|share
python3 tests/acceptance.py       # 48 项验收测试（独立端口与临时库）
```

## 架构

```
etiquette.html   公众提示页：受众/阶段/区域/语言切换，待核不猜测，离线缓存带过期提示
workbench.html   审校工作台：批准修订、裁决冲突、撤销来源、翻译状态、改期、边界、发布
print.html       打印卡 / 分享页：仅从“批准集合快照”渲染
server/app.py    REST API + 规则引擎 + 静态服务（仅标准库）
server/seed.py   种子数据（含相互冲突的来源）
tests/acceptance.py  端到端验收
```

## 核心不变量

| 需求 | 实现 |
| --- | --- |
| 相同事实共同陈述 | `statements` 唯一事实源；三受众视图只切换 `emphasis_*` 侧重点，不复制文本 |
| 冲突不猜测 | 同 topic 下 allow/forbid 同时命中且无已批准裁决 → `pending`(待核)，前端只展示候选 |
| 显式冲突审批 | `POST /api/conflicts/{id}/resolve` 指定胜出陈述；重复裁决 409 |
| 来源撤销 | 仅标记 `withdrawn`；唯一支撑被撤销的陈述自动转待核；`relation='conflicts'` 记录永久保留 |
| 翻译滞后 | `translations.based_on_revision` 对比当前修订 → `stale`；发布报告列出滞后语种 |
| 撤回不绕过 | `statements.status='retracted'` 对所有语种同时生效 |
| 已读绑定修订 | `read_receipts` 记录修订号；新修订批准后标记 `updated`，未读标记 `new` |
| 打印/分享同源 | `publications`+`publication_items` 快照；`kind` 快照锁定，展示层改写返回 403 |
| 建议≠处罚 | `penalty` 仅 `kind=rule` 可携带；摘要只压缩文本，不改写类别 |
| 离线缓存 | `cache_entries` TTL + 取代判定（新批准集合/新修订 → must_revalidate） |
| 并发批准 | 乐观锁 `UPDATE ... WHERE review_status='pending'`，并发下恰一人成功 |

## 主要 API

- `GET /api/tips?audience=&phase=&zone_id=&event_id=&lang=&visitor_id=&at=` — 解析视图（confirmed + pending）
- `POST /api/statements/{id}/revisions` / `POST /api/revisions/{id}/approve` — 修订与批准（409 并发保护）
- `POST /api/statements/{id}/retract` — 撤回（全语种生效）
- `POST /api/statements/{id}/translations` / `GET /api/translations/status` — 翻译与滞后报告
- `GET /api/sources` / `POST /api/sources/{id}/withdraw` — 来源管理
- `GET /api/conflicts` / `POST /api/conflicts/{id}/resolve` — 冲突审批
- `POST /api/events/{id}/reschedule` / `POST /api/zones/{id}/boundary` — 改期 / 边界（版本递增）
- `POST /api/publications` / `GET /api/publications/{id}/print|share|summary` — 批准集合与同源渲染
- `POST /api/read` / `GET /api/read/status?visitor_id=` — 已读绑定修订
- `POST /api/cache/fetch` / `GET /api/cache/check` — 离线缓存过期与取代

## 验收覆盖（tests/acceptance.py，48 项）

活动改期、区域边界变化（快照保留旧版本）、来源撤销（冲突来源保留）、
编辑并发批准（恰一人成功）、离线缓存过期与取代、可拍摄/禁止拍摄冲突待核与显式裁决、
翻译滞后与发布语种报告、撤回全语种生效、已读绑定修订与变更标记、
打印/分享同源且建议不可被样式或摘要改写为处罚规则、待核条目不进入批准集合。
