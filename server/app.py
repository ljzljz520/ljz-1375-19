#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
礼仪提示 · 全栈规则与来源工作台（后端，仅 Python 标准库）

核心不变量：
1. 同一事实只有一条“共同陈述”(statement)，居民/游客/工作人员视图只调整侧重点(emphasis)，
   不复制事实文本。
2. 规则组合命中冲突（如“可拍摄”与“禁止拍摄”同时命中）时，若无已批准的冲突裁决，
   一律输出 pending(待核)，前端不得猜测结论。
3. 翻译记录 based_on_revision；原文修订后旧翻译标记 stale；撤回(statement retract)
   对所有语种同时生效，切换语言不能绕过撤回。
4. 打印卡与分享页只从“批准集合快照”(publication)生成；建议(advisory)的类别
   在展示层不可被样式或自动摘要改写为处罚规则。
"""
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("WORKBENCH_DB", os.path.join(ROOT, "server", "workbench.db"))

SCHEMA = """
PRAGMA foreign_keys=ON;

-- 共同陈述：同一事实的唯一载体
CREATE TABLE IF NOT EXISTS statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skey TEXT UNIQUE NOT NULL,
  topic TEXT NOT NULL,                 -- 冲突检测分组，如 photography
  stance TEXT NOT NULL DEFAULT 'neutral',  -- allow | forbid | neutral
  kind TEXT NOT NULL DEFAULT 'rule',       -- rule | advisory | info
  status TEXT NOT NULL DEFAULT 'active',   -- active | retracted
  current_revision INTEGER,
  penalty_note TEXT,                       -- 仅 kind=rule 时允许存在
  created_at TEXT NOT NULL
);

-- 陈述修订：审校结论落在这里；emphasis_* 是各受众的侧重点说明，不是事实副本
CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER NOT NULL REFERENCES statements(id),
  version INTEGER NOT NULL,
  text_zh TEXT NOT NULL,               -- 源语言(中文)事实文本，唯一事实源
  emphasis_resident TEXT,
  emphasis_tourist TEXT,
  emphasis_staff TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | retracted
  created_by TEXT, created_at TEXT NOT NULL,
  approved_by TEXT, approved_at TEXT,
  UNIQUE(statement_id, version)
);

-- 翻译：记录所依据的修订，滞后即可判定 stale
CREATE TABLE IF NOT EXISTS translations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER NOT NULL REFERENCES statements(id),
  lang TEXT NOT NULL,
  text TEXT NOT NULL,
  based_on_revision INTEGER NOT NULL REFERENCES revisions(id),
  updated_by TEXT, updated_at TEXT NOT NULL,
  UNIQUE(statement_id, lang)
);

-- 来源：撤销只标记不删除；冲突来源通过 statement_sources.relation='conflicts' 永久保留
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  stype TEXT NOT NULL,                 -- regulation | organizer | signage | community
  ref TEXT,
  reliability INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'active',   -- active | withdrawn
  withdrawn_at TEXT,
  effective_from TEXT, effective_to TEXT
);

CREATE TABLE IF NOT EXISTS statement_sources (
  statement_id INTEGER NOT NULL REFERENCES statements(id),
  source_id INTEGER NOT NULL REFERENCES sources(id),
  relation TEXT NOT NULL DEFAULT 'supports',   -- supports | conflicts
  note TEXT,
  PRIMARY KEY(statement_id, source_id, relation)
);

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,   -- 边界每次变化 +1
  boundary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1    -- 每次改期 +1
);

CREATE TABLE IF NOT EXISTS event_phases (
  event_id INTEGER NOT NULL REFERENCES events(id),
  phase TEXT NOT NULL,                  -- pre | during | post
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  PRIMARY KEY(event_id, phase)
);

-- 规则：把陈述绑定到 受众×阶段×区域×活动，并给出优先级
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER NOT NULL REFERENCES statements(id),
  audience TEXT NOT NULL DEFAULT 'all',   -- all | resident | tourist | staff
  phase TEXT NOT NULL DEFAULT 'any',      -- any | pre | during | post
  zone_id INTEGER REFERENCES zones(id),
  event_id INTEGER REFERENCES events(id),
  priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- 显式冲突审批记录
CREATE TABLE IF NOT EXISTS conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_a INTEGER NOT NULL,
  statement_b INTEGER NOT NULL,
  audience TEXT, phase TEXT, zone_id INTEGER,   -- NULL = 通配
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | resolved
  winner_statement INTEGER,
  resolved_by TEXT, resolved_at TEXT, resolution_note TEXT
);

-- 批准集合快照：打印卡/分享页唯一数据源
CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audience TEXT NOT NULL, phase TEXT NOT NULL,
  zone_id INTEGER, event_id INTEGER,
  context_json TEXT NOT NULL,           -- 含 zone_version / event_version 等追溯信息
  note TEXT,
  created_by TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publication_items (
  publication_id INTEGER NOT NULL REFERENCES publications(id),
  statement_id INTEGER NOT NULL,
  revision_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                   -- 快照时的类别，展示层不可改写
  text_zh TEXT NOT NULL,                -- 快照文本
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(publication_id, statement_id)
);

-- 访客已读状态：绑定到具体修订
CREATE TABLE IF NOT EXISTS read_receipts (
  visitor_id TEXT NOT NULL,
  statement_id INTEGER NOT NULL,
  revision_id INTEGER NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY(visitor_id, statement_id)
);

-- 离线缓存登记：TTL + 取代判定
CREATE TABLE IF NOT EXISTS cache_entries (
  cache_key TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  publication_id INTEGER,
  fetched_at TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL DEFAULT 300,
  PRIMARY KEY(cache_key, visitor_id)
);
"""

KIND_LABELS = {"rule": "规则", "advisory": "建议", "info": "提示"}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_iso(s):
    """解析 ISO 时间；朴素时间按 UTC 处理，避免与带时区时间比较出错。"""
    dt = datetime.fromisoformat(s)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def connect():
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    return c


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = connect()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


def rows(cur):
    return [dict(r) for r in cur.fetchall()]


# ---------------------------------------------------------------- 规则引擎 --

def derive_phase(conn, event_id, at):
    """按活动日程推导 at 时刻所处阶段；改期后结果随之变化。"""
    if not event_id or not at:
        return None
    for r in conn.execute(
        "SELECT phase, starts_at, ends_at FROM event_phases WHERE event_id=?",
        (event_id,),
    ):
        if r["starts_at"] <= at <= r["ends_at"]:
            return r["phase"]
    return None


def _statement_sources(conn, sid):
    sup = rows(conn.execute(
        """SELECT s.id, s.title, s.stype, s.status FROM statement_sources ss
           JOIN sources s ON s.id=ss.source_id
           WHERE ss.statement_id=? AND ss.relation='supports'""", (sid,)))
    con = rows(conn.execute(
        """SELECT s.id, s.title, s.stype, s.status FROM statement_sources ss
           JOIN sources s ON s.id=ss.source_id
           WHERE ss.statement_id=? AND ss.relation='conflicts'""", (sid,)))
    return sup, con


def _find_resolution(conn, a, b, audience, phase, zone_id):
    lo, hi = sorted((a, b))
    return conn.execute(
        """SELECT * FROM conflicts
           WHERE statement_a=? AND statement_b=? AND status='resolved'
             AND (audience IS NULL OR audience=?)
             AND (phase IS NULL OR phase=?)
             AND (zone_id IS NULL OR zone_id=?)
           ORDER BY id DESC LIMIT 1""",
        (lo, hi, audience, phase, zone_id),
    ).fetchone()


def _ensure_conflict(conn, a, b, audience, phase, zone_id):
    lo, hi = sorted((a, b))
    row = conn.execute(
        """SELECT * FROM conflicts WHERE statement_a=? AND statement_b=?
           AND status='pending'
           AND COALESCE(audience,'')=COALESCE(?, '')
           AND COALESCE(phase,'')=COALESCE(?, '')
           AND COALESCE(zone_id,-1)=COALESCE(?, -1)""",
        (lo, hi, audience, phase, zone_id),
    ).fetchone()
    if row:
        return row["id"]
    cur = conn.execute(
        """INSERT INTO conflicts(statement_a, statement_b, audience, phase, zone_id)
           VALUES(?,?,?,?,?)""",
        (lo, hi, audience, phase, zone_id),
    )
    conn.commit()
    return cur.lastrowid


def resolve_tips(conn, audience, phase, zone_id, event_id, lang, visitor_id=None, at=None):
    """按 受众×阶段×区域×活动×语言 解析提示。返回 confirmed + pending(待核)。

    无法确认的场景（来源冲突未裁决 / 支撑来源全部被撤销）一律进入 pending，
    由前端展示“待核”，绝不输出猜测结论。
    """
    derived = derive_phase(conn, event_id, at)
    eff_phase = phase or derived or "any"

    zver = ever = None
    if zone_id:
        z = conn.execute("SELECT version FROM zones WHERE id=?", (zone_id,)).fetchone()
        zver = z["version"] if z else None
    if event_id:
        e = conn.execute("SELECT version FROM events WHERE id=?", (event_id,)).fetchone()
        ever = e["version"] if e else None

    rule_rows = rows(conn.execute(
        """SELECT r.id AS rule_id, r.priority, r.audience AS r_audience, r.phase AS r_phase,
                  s.id AS sid, s.skey, s.topic, s.stance, s.kind, s.current_revision, s.penalty_note
           FROM rules r JOIN statements s ON s.id = r.statement_id
           WHERE r.active=1 AND s.status='active'
             AND (r.audience='all' OR r.audience=?)
             AND (r.phase='any' OR r.phase=?)
             AND (r.zone_id IS NULL OR r.zone_id=?)
             AND (r.event_id IS NULL OR r.event_id=? OR ? IS NULL)
           ORDER BY r.priority DESC, r.id""",
        (audience, eff_phase, zone_id, event_id, event_id),
    ))

    items, pending = [], []
    for r in rule_rows:
        rev = conn.execute("SELECT * FROM revisions WHERE id=?", (r["current_revision"],)).fetchone()
        if not rev or rev["review_status"] != "approved":
            continue  # 无已批准修订：不展示
        sup, con = _statement_sources(conn, r["sid"])
        active_sup = [s for s in sup if s["status"] == "active"]
        if sup and not active_sup:
            pending.append({
                "reason": "unverified_source",
                "message": "待核：支撑来源已全部撤销，需重新审校",
                "statement_id": r["sid"], "skey": r["skey"],
                "text_zh": rev["text_zh"],
                "withdrawn_sources": sup, "conflict_sources": con,
            })
            continue
        item = {
            "statement_id": r["sid"], "skey": r["skey"], "topic": r["topic"],
            "stance": r["stance"], "kind": r["kind"], "label": KIND_LABELS[r["kind"]],
            "revision_id": rev["id"], "version": rev["version"],
            "priority": r["priority"],
            "emphasis": rev[f"emphasis_{audience}"] if audience in ("resident", "tourist", "staff") else None,
            "sources": active_sup, "conflict_sources": con,
            "penalty": r["penalty_note"] if r["kind"] == "rule" else None,
        }
        # 语言层
        item["translation_stale"] = False
        item["translation_missing"] = False
        if lang == "zh":
            item["text"] = rev["text_zh"]
        else:
            tr = conn.execute(
                "SELECT * FROM translations WHERE statement_id=? AND lang=?",
                (r["sid"], lang)).fetchone()
            if not tr:
                item["text"] = rev["text_zh"]
                item["translation_missing"] = True
            else:
                item["text"] = tr["text"]
                item["translation_stale"] = tr["based_on_revision"] != r["current_revision"]
                item["translation_based_on_version"] = conn.execute(
                    "SELECT version FROM revisions WHERE id=?",
                    (tr["based_on_revision"],)).fetchone()["version"]
        # 已读状态绑定修订
        if visitor_id:
            rr = conn.execute(
                "SELECT revision_id FROM read_receipts WHERE visitor_id=? AND statement_id=?",
                (visitor_id, r["sid"])).fetchone()
            if not rr:
                item["read_marker"] = "new"
            elif rr["revision_id"] != r["current_revision"]:
                item["read_marker"] = "updated"   # 新要求保留变更标记
            else:
                item["read_marker"] = None
        items.append(item)

    # 冲突检测：同 topic 下 allow 与 forbid 同时命中
    confirmed = []
    by_topic = {}
    for it in items:
        by_topic.setdefault(it["topic"], []).append(it)
    for topic, group in by_topic.items():
        allows = [g for g in group if g["stance"] == "allow"]
        forbids = [g for g in group if g["stance"] == "forbid"]
        if allows and forbids:
            losers, unresolved = set(), []
            for a in allows:
                for f in forbids:
                    res = _find_resolution(conn, a["statement_id"], f["statement_id"],
                                           audience, eff_phase, zone_id)
                    if res:
                        win = res["winner_statement"]
                        for g in (a, f):
                            if g["statement_id"] == win:
                                g["resolution"] = {
                                    "conflict_id": res["id"],
                                    "resolved_by": res["resolved_by"],
                                    "note": res["resolution_note"],
                                }
                            else:
                                losers.add(g["statement_id"])
                    else:
                        cid = _ensure_conflict(conn, a["statement_id"], f["statement_id"],
                                               audience, eff_phase, zone_id)
                        unresolved.append((cid, a, f))
            if unresolved:
                for cid, a, f in unresolved:
                    pending.append({
                        "reason": "conflict",
                        "conflict_id": cid,
                        "message": "待核：来源冲突待审校裁决，系统不作猜测",
                        "topic": topic,
                        "candidates": [
                            {"statement_id": x["statement_id"], "skey": x["skey"],
                             "stance": x["stance"], "text": x["text"],
                             "sources": x["sources"], "conflict_sources": x["conflict_sources"]}
                            for x in (a, f)
                        ],
                    })
                losers.update(x["statement_id"] for _, a, f in unresolved for x in (a, f))
            confirmed.extend(g for g in group if g["statement_id"] not in losers)
        else:
            confirmed.extend(group)

    return {
        "context": {"audience": audience, "phase": eff_phase, "derived_phase": derived,
                    "zone_id": zone_id, "zone_version": zver,
                    "event_id": event_id, "event_version": ever, "lang": lang, "at": at},
        "confirmed": confirmed,
        "pending": pending,
    }


def translation_status(conn):
    out = []
    for st in rows(conn.execute(
            "SELECT id, skey, current_revision, status FROM statements ORDER BY id")):
        cur_ver = None
        if st["current_revision"]:
            r = conn.execute("SELECT version FROM revisions WHERE id=?",
                             (st["current_revision"],)).fetchone()
            cur_ver = r["version"] if r else None
        for tr in rows(conn.execute(
                "SELECT lang, based_on_revision, updated_at FROM translations WHERE statement_id=?",
                (st["id"],))):
            base = conn.execute("SELECT version FROM revisions WHERE id=?",
                                (tr["based_on_revision"],)).fetchone()
            out.append({
                "statement_id": st["id"], "skey": st["skey"], "lang": tr["lang"],
                "based_on_version": base["version"] if base else None,
                "current_version": cur_ver,
                "stale": (st["current_revision"] is not None
                          and tr["based_on_revision"] != st["current_revision"]),
                "statement_status": st["status"],
            })
    return out


# ---------------------------------------------------------------- HTTP 层 --

class Api(Exception):
    def __init__(self, status, obj):
        self.status, self.obj = status, obj


def body_of(h):
    n = int(h.headers.get("Content-Length") or 0)
    if not n:
        return {}
    return json.loads(h.rfile.read(n).decode("utf-8"))


def require(b, *keys):
    for k in keys:
        if b.get(k) in (None, ""):
            raise Api(400, {"error": "missing_field", "field": k})
    return b


# ---- handlers: 查询视图 ----

def h_tips(q, b, p):
    conn = connect()
    try:
        return 200, resolve_tips(
            conn,
            audience=q.get("audience", ["tourist"])[0],
            phase=q.get("phase", [None])[0] or None,
            zone_id=_int(q.get("zone_id", [None])[0]),
            event_id=_int(q.get("event_id", [None])[0]),
            lang=q.get("lang", ["zh"])[0],
            visitor_id=q.get("visitor_id", [None])[0],
            at=q.get("at", [None])[0],
        )
    finally:
        conn.close()


def h_statements(q, b, p):
    conn = connect()
    try:
        out = []
        for st in rows(conn.execute("SELECT * FROM statements ORDER BY id")):
            revs = rows(conn.execute(
                "SELECT id, version, review_status, created_by, approved_by FROM revisions"
                " WHERE statement_id=? ORDER BY version", (st["id"],)))
            sup, con = _statement_sources(conn, st["id"])
            st["revisions"] = revs
            st["sources"] = sup
            st["conflict_sources"] = con
            st["unverified"] = bool(sup) and not any(s["status"] == "active" for s in sup)
            out.append(st)
        return 200, {"statements": out}
    finally:
        conn.close()


def h_pending_revisions(q, b, p):
    conn = connect()
    try:
        return 200, {"revisions": rows(conn.execute(
            """SELECT r.*, s.skey FROM revisions r JOIN statements s ON s.id=r.statement_id
               WHERE r.review_status='pending' ORDER BY r.id"""))}
    finally:
        conn.close()


# ---- handlers: 陈述 / 修订 / 审校 ----

def h_create_revision(q, b, p):
    require(b, "text_zh")
    sid = int(p[0])
    conn = connect()
    try:
        st = conn.execute("SELECT * FROM statements WHERE id=?", (sid,)).fetchone()
        if not st:
            raise Api(404, {"error": "statement_not_found"})
        v = conn.execute("SELECT COALESCE(MAX(version),0)+1 v FROM revisions WHERE statement_id=?",
                         (sid,)).fetchone()["v"]
        cur = conn.execute(
            """INSERT INTO revisions(statement_id, version, text_zh, emphasis_resident,
                   emphasis_tourist, emphasis_staff, review_status, created_by, created_at)
               VALUES(?,?,?,?,?,?, 'pending', ?, ?)""",
            (sid, v, b["text_zh"], b.get("emphasis_resident"), b.get("emphasis_tourist"),
             b.get("emphasis_staff"), b.get("created_by", "editor"), now_iso()))
        conn.commit()
        return 201, {"revision_id": cur.lastrowid, "version": v, "review_status": "pending"}
    finally:
        conn.close()


def h_approve(q, b, p):
    """批准修订。乐观并发：仅当仍处于 pending 才批准成功，否则 409。"""
    rid = int(p[0])
    approver = b.get("approver", "reviewer")
    conn = connect()
    try:
        cur = conn.execute(
            "UPDATE revisions SET review_status='approved', approved_by=?, approved_at=?"
            " WHERE id=? AND review_status='pending'",
            (approver, now_iso(), rid))
        if cur.rowcount == 0:
            raise Api(409, {"error": "concurrent_modification",
                            "message": "该修订已被其他编辑处理，请刷新后重试"})
        conn.execute(
            "UPDATE statements SET current_revision=? WHERE id="
            "(SELECT statement_id FROM revisions WHERE id=?)", (rid, rid))
        conn.commit()
        return 200, {"revision_id": rid, "review_status": "approved", "approved_by": approver}
    finally:
        conn.close()


def h_retract_statement(q, b, p):
    """撤回：对所有语种同时生效，切换语言不能绕过。"""
    sid = int(p[0])
    conn = connect()
    try:
        cur = conn.execute(
            "UPDATE statements SET status='retracted' WHERE id=? AND status='active'", (sid,))
        if cur.rowcount == 0:
            raise Api(409, {"error": "already_retracted_or_missing"})
        conn.commit()
        return 200, {"statement_id": sid, "status": "retracted",
                     "note": "撤回对所有语种同时生效"}
    finally:
        conn.close()


# ---- handlers: 翻译 ----

def h_upsert_translation(q, b, p):
    require(b, "lang", "text")
    sid = int(p[0])
    conn = connect()
    try:
        st = conn.execute("SELECT current_revision FROM statements WHERE id=?", (sid,)).fetchone()
        if not st or not st["current_revision"]:
            raise Api(400, {"error": "no_approved_revision"})
        conn.execute(
            """INSERT INTO translations(statement_id, lang, text, based_on_revision, updated_by, updated_at)
               VALUES(?,?,?,?,?,?)
               ON CONFLICT(statement_id, lang) DO UPDATE SET
                 text=excluded.text, based_on_revision=excluded.based_on_revision,
                 updated_by=excluded.updated_by, updated_at=excluded.updated_at""",
            (sid, b["lang"], b["text"], st["current_revision"],
             b.get("updated_by", "translator"), now_iso()))
        conn.commit()
        return 200, {"statement_id": sid, "lang": b["lang"],
                     "based_on_revision": st["current_revision"]}
    finally:
        conn.close()


def h_translation_status(q, b, p):
    conn = connect()
    try:
        return 200, {"translations": translation_status(conn)}
    finally:
        conn.close()


# ---- handlers: 来源 ----

def h_sources(q, b, p):
    conn = connect()
    try:
        return 200, {"sources": rows(conn.execute("SELECT * FROM sources ORDER BY id"))}
    finally:
        conn.close()


def h_withdraw_source(q, b, p):
    """撤销来源：只标记不删除；冲突来源记录永久保留在 statement_sources。"""
    sid = int(p[0])
    conn = connect()
    try:
        cur = conn.execute(
            "UPDATE sources SET status='withdrawn', withdrawn_at=? WHERE id=? AND status='active'",
            (now_iso(), sid))
        if cur.rowcount == 0:
            raise Api(409, {"error": "already_withdrawn_or_missing"})
        conn.commit()
        affected = rows(conn.execute(
            "SELECT DISTINCT statement_id FROM statement_sources WHERE source_id=?", (sid,)))
        return 200, {"source_id": sid, "status": "withdrawn",
                     "affected_statements": [a["statement_id"] for a in affected],
                     "note": "来源记录与冲突引用保留，仅状态置为 withdrawn"}
    finally:
        conn.close()


# ---- handlers: 冲突审批 ----

def h_conflicts(q, b, p):
    conn = connect()
    try:
        status = q.get("status", [None])[0]
        sql = "SELECT * FROM conflicts"
        args = ()
        if status:
            sql += " WHERE status=?"
            args = (status,)
        return 200, {"conflicts": rows(conn.execute(sql + " ORDER BY id", args))}
    finally:
        conn.close()


def h_resolve_conflict(q, b, p):
    """显式冲突审批：指定胜出的陈述。仅 pending 可裁决，否则 409。"""
    cid = int(p[0])
    require(b, "winner_statement")
    conn = connect()
    try:
        cur = conn.execute(
            """UPDATE conflicts SET status='resolved', winner_statement=?,
                 resolved_by=?, resolved_at=?, resolution_note=?
               WHERE id=? AND status='pending'""",
            (int(b["winner_statement"]), b.get("resolved_by", "reviewer"),
             now_iso(), b.get("note"), cid))
        if cur.rowcount == 0:
            raise Api(409, {"error": "concurrent_modification",
                            "message": "该冲突已被裁决"})
        conn.commit()
        return 200, {"conflict_id": cid, "status": "resolved",
                     "winner_statement": int(b["winner_statement"])}
    finally:
        conn.close()


# ---- handlers: 活动改期 / 区域边界 ----

def h_events(q, b, p):
    conn = connect()
    try:
        out = []
        for e in rows(conn.execute("SELECT * FROM events ORDER BY id")):
            e["phases"] = rows(conn.execute(
                "SELECT phase, starts_at, ends_at FROM event_phases WHERE event_id=?",
                (e["id"],)))
            out.append(e)
        return 200, {"events": out}
    finally:
        conn.close()


def h_reschedule(q, b, p):
    """活动改期：整体替换阶段日程并提升版本。"""
    eid = int(p[0])
    phases = b.get("phases") or []
    if not phases:
        raise Api(400, {"error": "missing_field", "field": "phases"})
    conn = connect()
    try:
        if not conn.execute("SELECT 1 FROM events WHERE id=?", (eid,)).fetchone():
            raise Api(404, {"error": "event_not_found"})
        conn.execute("DELETE FROM event_phases WHERE event_id=?", (eid,))
        for ph in phases:
            conn.execute(
                "INSERT INTO event_phases(event_id, phase, starts_at, ends_at) VALUES(?,?,?,?)",
                (eid, ph["phase"], ph["starts_at"], ph["ends_at"]))
        conn.execute("UPDATE events SET version=version+1 WHERE id=?", (eid,))
        conn.commit()
        v = conn.execute("SELECT version FROM events WHERE id=?", (eid,)).fetchone()["version"]
        return 200, {"event_id": eid, "version": v, "phases": phases}
    finally:
        conn.close()


def h_zones(q, b, p):
    conn = connect()
    try:
        return 200, {"zones": rows(conn.execute("SELECT * FROM zones ORDER BY id"))}
    finally:
        conn.close()


def h_zone_boundary(q, b, p):
    """区域边界变化：版本 +1；已发布快照仍记录旧版本，互不影响。"""
    zid = int(p[0])
    require(b, "boundary")
    conn = connect()
    try:
        cur = conn.execute(
            "UPDATE zones SET boundary=?, version=version+1 WHERE id=?", (b["boundary"], zid))
        if cur.rowcount == 0:
            raise Api(404, {"error": "zone_not_found"})
        conn.commit()
        z = conn.execute("SELECT * FROM zones WHERE id=?", (zid,)).fetchone()
        return 200, {"zone_id": zid, "version": z["version"], "boundary": z["boundary"]}
    finally:
        conn.close()


# ---- handlers: 发布（批准集合快照） ----

def h_publish(q, b, p):
    """生成批准集合快照：只收录 confirmed（已批准、无未决冲突、来源有效）。"""
    audience = b.get("audience", "tourist")
    phase = b.get("phase")
    zone_id = _int(b.get("zone_id"))
    event_id = _int(b.get("event_id"))
    conn = connect()
    try:
        res = resolve_tips(conn, audience, phase, zone_id, event_id, "zh",
                           at=b.get("at"))
        ctx = dict(res["context"])
        ctx["published_at"] = now_iso()
        cur = conn.execute(
            """INSERT INTO publications(audience, phase, zone_id, event_id, context_json, note, created_by, created_at)
               VALUES(?,?,?,?,?,?,?,?)""",
            (audience, res["context"]["phase"], zone_id, event_id,
             json.dumps(ctx, ensure_ascii=False), b.get("note"),
             b.get("created_by", "publisher"), now_iso()))
        pid = cur.lastrowid
        for i, it in enumerate(res["confirmed"]):
            conn.execute(
                """INSERT INTO publication_items(publication_id, statement_id, revision_id, kind, text_zh, sort)
                   VALUES(?,?,?,?,?,?)""",
                (pid, it["statement_id"], it["revision_id"], it["kind"],
                 it["text"] if res["context"]["lang"] == "zh" else
                 conn.execute("SELECT text_zh FROM revisions WHERE id=?",
                              (it["revision_id"],)).fetchone()["text_zh"], i))
        conn.commit()
        return 201, {"publication_id": pid, "items": len(res["confirmed"]),
                     "excluded_pending": len(res["pending"]),
                     "note": "待核条目不进入批准集合"}
    finally:
        conn.close()


def _publication_payload(conn, pid, lang="zh"):
    pub = conn.execute("SELECT * FROM publications WHERE id=?", (pid,)).fetchone()
    if not pub:
        raise Api(404, {"error": "publication_not_found"})
    items = []
    for it in rows(conn.execute(
            """SELECT pi.*, s.skey, s.penalty_note FROM publication_items pi
               JOIN statements s ON s.id=pi.statement_id
               WHERE pi.publication_id=? ORDER BY pi.sort""", (pid,))):
        text = it["text_zh"]
        tr_stale = tr_missing = False
        if lang != "zh":
            tr = conn.execute(
                "SELECT * FROM translations WHERE statement_id=? AND lang=?",
                (it["statement_id"], lang)).fetchone()
            if not tr:
                tr_missing = True
            else:
                text = tr["text"]
                tr_stale = tr["based_on_revision"] != it["revision_id"]
        item = {
            "statement_id": it["statement_id"], "skey": it["skey"],
            "revision_id": it["revision_id"],
            "kind": it["kind"], "label": KIND_LABELS[it["kind"]],  # 类别由快照数据决定
            "text": text,
            "translation_stale": tr_stale, "translation_missing": tr_missing,
        }
        if it["kind"] == "rule" and it["penalty_note"]:
            item["penalty"] = it["penalty_note"]  # 仅规则可携带处罚说明
        items.append(item)
    # 语种滞后报告：发布方必须知道哪些语种仍对应旧依据
    lang_report = {}
    for t in translation_status(conn):
        pub_item = conn.execute(
            "SELECT revision_id FROM publication_items WHERE publication_id=? AND statement_id=?",
            (pid, t["statement_id"])).fetchone()
        if not pub_item:
            continue
        stale = t["based_on_version"] != conn.execute(
            "SELECT version FROM revisions WHERE id=?",
            (pub_item["revision_id"],)).fetchone()["version"]
        lang_report.setdefault(t["lang"], {"stale": [], "current": []})
        lang_report[t["lang"]]["stale" if stale else "current"].append(t["skey"])
    return pub, items, lang_report


def h_publication(q, b, p):
    conn = connect()
    try:
        pub, items, lang_report = _publication_payload(conn, int(p[0]),
                                                       q.get("lang", ["zh"])[0])
        return 200, {"publication": dict(pub), "items": items,
                     "language_report": lang_report}
    finally:
        conn.close()


def h_publications(q, b, p):
    conn = connect()
    try:
        return 200, {"publications": rows(conn.execute(
            "SELECT * FROM publications ORDER BY id DESC"))}
    finally:
        conn.close()


def _render_view(q, p, mode):
    conn = connect()
    try:
        pub, items, lang_report = _publication_payload(conn, int(p[0]),
                                                       q.get("lang", ["zh"])[0])
        return 200, {
            "mode": mode, "publication_id": pub["id"],
            "generated_from": "approved_snapshot",   # 打印卡与分享页同源
            "audience": pub["audience"], "phase": pub["phase"],
            "items": items, "language_report": lang_report,
        }
    finally:
        conn.close()


def h_print(q, b, p):
    return _render_view(q, p, "print")


def h_share(q, b, p):
    return _render_view(q, p, "share")


def h_summary(q, b, p):
    """自动摘要：只压缩文本长度，类别(kind)与标签不可被摘要改写。"""
    conn = connect()
    try:
        pub, items, _ = _publication_payload(conn, int(p[0]), q.get("lang", ["zh"])[0])
        for it in items:
            t = it["text"]
            it["summary"] = t if len(t) <= 40 else t[:40] + "…"
            it.pop("text", None)
        return 200, {"publication_id": pub["id"], "items": items,
                     "note": "摘要仅压缩文本，kind/label 保持快照原值"}
    finally:
        conn.close()


def h_relabel_guard(q, b, p):
    """展示层禁止改写类别：建议不能被样式或摘要改成处罚规则。"""
    raise Api(403, {"error": "kind_immutable",
                    "message": "kind 由批准快照决定，打印/分享/摘要等展示层不可改写"})


# ---- handlers: 已读状态 ----

def h_read(q, b, p):
    require(b, "visitor_id", "statement_id")
    conn = connect()
    try:
        st = conn.execute("SELECT current_revision FROM statements WHERE id=?",
                          (int(b["statement_id"]),)).fetchone()
        if not st or not st["current_revision"]:
            raise Api(400, {"error": "no_approved_revision"})
        conn.execute(
            """INSERT INTO read_receipts(visitor_id, statement_id, revision_id, read_at)
               VALUES(?,?,?,?)
               ON CONFLICT(visitor_id, statement_id) DO UPDATE SET
                 revision_id=excluded.revision_id, read_at=excluded.read_at""",
            (b["visitor_id"], int(b["statement_id"]), st["current_revision"], now_iso()))
        conn.commit()
        return 200, {"visitor_id": b["visitor_id"], "statement_id": int(b["statement_id"]),
                     "revision_id": st["current_revision"]}
    finally:
        conn.close()


def h_read_status(q, b, p):
    vid = q.get("visitor_id", [None])[0]
    if not vid:
        raise Api(400, {"error": "missing_field", "field": "visitor_id"})
    conn = connect()
    try:
        out = []
        for st in rows(conn.execute(
                "SELECT id, skey, current_revision FROM statements WHERE status='active'")):
            rr = conn.execute(
                "SELECT revision_id, read_at FROM read_receipts WHERE visitor_id=? AND statement_id=?",
                (vid, st["id"])).fetchone()
            marker = None
            if not rr:
                marker = "new"
            elif st["current_revision"] and rr["revision_id"] != st["current_revision"]:
                marker = "updated"
            out.append({"statement_id": st["id"], "skey": st["skey"],
                        "read_revision": rr["revision_id"] if rr else None,
                        "current_revision": st["current_revision"],
                        "marker": marker})
        return 200, {"visitor_id": vid, "status": out}
    finally:
        conn.close()


# ---- handlers: 离线缓存 ----

def h_cache_fetch(q, b, p):
    require(b, "cache_key", "visitor_id")
    conn = connect()
    try:
        pub = conn.execute("SELECT MAX(id) m FROM publications").fetchone()["m"]
        conn.execute(
            """INSERT INTO cache_entries(cache_key, visitor_id, publication_id, fetched_at, ttl_seconds)
               VALUES(?,?,?,?,?)
               ON CONFLICT(cache_key, visitor_id) DO UPDATE SET
                 publication_id=excluded.publication_id, fetched_at=excluded.fetched_at,
                 ttl_seconds=excluded.ttl_seconds""",
            (b["cache_key"], b["visitor_id"], pub, now_iso(),
             int(b.get("ttl_seconds", 300))))
        conn.commit()
        return 200, {"cache_key": b["cache_key"], "publication_id": pub,
                     "fetched_at": now_iso()}
    finally:
        conn.close()


def h_cache_check(q, b, p):
    key = q.get("cache_key", [None])[0]
    vid = q.get("visitor_id", [None])[0]
    now = q.get("now", [None])[0] or now_iso()
    conn = connect()
    try:
        row = conn.execute(
            "SELECT * FROM cache_entries WHERE cache_key=? AND visitor_id=?",
            (key, vid)).fetchone()
        if not row:
            return 200, {"fresh": False, "reason": "miss", "must_revalidate": True}
        fetched = parse_iso(row["fetched_at"])
        age = (parse_iso(now) - fetched).total_seconds()
        if age > row["ttl_seconds"]:
            return 200, {"fresh": False, "reason": "expired", "must_revalidate": True,
                         "age_seconds": age, "ttl_seconds": row["ttl_seconds"]}
        latest_pub = conn.execute("SELECT MAX(id) m FROM publications").fetchone()["m"]
        if latest_pub and row["publication_id"] and latest_pub > row["publication_id"]:
            return 200, {"fresh": False, "reason": "superseded", "must_revalidate": True,
                         "latest_publication": latest_pub}
        newer = conn.execute(
            "SELECT 1 FROM revisions WHERE review_status='approved' AND approved_at>? LIMIT 1",
            (row["fetched_at"],)).fetchone()
        if newer:
            return 200, {"fresh": False, "reason": "superseded", "must_revalidate": True}
        return 200, {"fresh": True, "reason": "ok", "must_revalidate": False}
    finally:
        conn.close()


# ---------------------------------------------------------------- 路由 ----

def _int(v):
    try:
        return int(v) if v not in (None, "", "null") else None
    except (TypeError, ValueError):
        return None


ROUTES = [
    ("GET",  r"^/api/tips$", h_tips),
    ("GET",  r"^/api/statements$", h_statements),
    ("GET",  r"^/api/revisions/pending$", h_pending_revisions),
    ("POST", r"^/api/statements/(\d+)/revisions$", h_create_revision),
    ("POST", r"^/api/statements/(\d+)/retract$", h_retract_statement),
    ("POST", r"^/api/statements/(\d+)/translations$", h_upsert_translation),
    ("GET",  r"^/api/translations/status$", h_translation_status),
    ("POST", r"^/api/revisions/(\d+)/approve$", h_approve),
    ("GET",  r"^/api/sources$", h_sources),
    ("POST", r"^/api/sources/(\d+)/withdraw$", h_withdraw_source),
    ("GET",  r"^/api/conflicts$", h_conflicts),
    ("POST", r"^/api/conflicts/(\d+)/resolve$", h_resolve_conflict),
    ("GET",  r"^/api/events$", h_events),
    ("POST", r"^/api/events/(\d+)/reschedule$", h_reschedule),
    ("GET",  r"^/api/zones$", h_zones),
    ("POST", r"^/api/zones/(\d+)/boundary$", h_zone_boundary),
    ("POST", r"^/api/publications$", h_publish),
    ("GET",  r"^/api/publications$", h_publications),
    ("GET",  r"^/api/publications/(\d+)$", h_publication),
    ("GET",  r"^/api/publications/(\d+)/print$", h_print),
    ("GET",  r"^/api/publications/(\d+)/share$", h_share),
    ("GET",  r"^/api/publications/(\d+)/summary$", h_summary),
    ("POST", r"^/api/publications/(\d+)/items/(\d+)/kind$", h_relabel_guard),
    ("POST", r"^/api/read$", h_read),
    ("GET",  r"^/api/read/status$", h_read_status),
    ("POST", r"^/api/cache/fetch$", h_cache_fetch),
    ("GET",  r"^/api/cache/check$", h_cache_check),
]

MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8", ".png": "image/png",
        ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json"}


class Handler(BaseHTTPRequestHandler):
    server_version = "EtiquetteWorkbench/1.0"

    def log_message(self, *a):  # 静默
        pass

    def _json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._json(204, {})

    def _dispatch(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            q = parse_qs(parsed.query)
            try:
                body = body_of(self) if method == "POST" else {}
            except json.JSONDecodeError:
                return self._json(400, {"error": "invalid_json"})
            for m, pat, fn in ROUTES:
                if m != method:
                    continue
                mt = re.match(pat, path)
                if mt:
                    try:
                        status, obj = fn(q, body, mt.groups())
                    except Api as e:
                        return self._json(e.status, e.obj)
                    except Exception as e:  # noqa
                        return self._json(500, {"error": "internal", "detail": str(e)})
                    return self._json(status, obj)
            return self._json(404, {"error": "not_found", "path": path})
        self._static(path)

    def _static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        fp = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
        if not fp.startswith(ROOT) or not os.path.isfile(fp):
            self.send_error(404)
            return
        ext = os.path.splitext(fp)[1]
        data = open(fp, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    init_db()
    import seed
    seed.run(DB_PATH)
    print(f"礼仪提示工作台已启动: http://localhost:{port}")
    print(f"  公众视图:  http://localhost:{port}/etiquette.html")
    print(f"  审校工作台: http://localhost:{port}/workbench.html")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
