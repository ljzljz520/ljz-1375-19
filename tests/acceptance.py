#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验收测试：改期 / 边界变化 / 来源撤销 / 并发批准 / 缓存过期 /
冲突待核 / 翻译滞后 / 撤回不绕过 / 已读绑定修订 / 打印分享同源。"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import urllib.error
import urllib.parse

PORT = 8123
BASE = f"http://127.0.0.1:{PORT}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  ✓ " if cond else "  ✗ ") + name + (f"  [{detail}]" if detail and not cond else ""))


def req(method, path, body=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def main():
    tmp = tempfile.mkdtemp(prefix="wb_test_")
    db = os.path.join(tmp, "test.db")
    env = dict(os.environ, WORKBENCH_DB=db)
    srv = subprocess.Popen([sys.executable, os.path.join(ROOT, "server", "app.py"), str(PORT)],
                           env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                s, _ = req("GET", "/api/sources")
                if s == 200:
                    break
            except Exception:
                time.sleep(0.2)
        else:
            print("server failed to start")
            return 1

        print("== 1. 冲突：可拍摄 vs 禁止拍摄 同时命中 → 待核，前端不得猜测 ==")
        s, r = req("GET", "/api/tips?audience=tourist&phase=during&zone_id=1&event_id=1")
        check("返回 200", s == 200)
        photo_confirmed = [i for i in r["confirmed"] if i["topic"] == "photography"]
        photo_pending = [p for p in r["pending"]
                         if p.get("reason") == "conflict" and p.get("topic") == "photography"]
        check("冲突双方均不在 confirmed（系统不猜测）", len(photo_confirmed) == 0)
        check("生成待核条目且带 conflict_id", len(photo_pending) == 1
              and photo_pending[0]["conflict_id"] >= 1)
        stances = sorted(c["stance"] for c in photo_pending[0]["candidates"])
        check("待核条目同时给出 allow/forbid 两个候选及来源", stances == ["allow", "forbid"])
        cid = photo_pending[0]["conflict_id"]

        print("== 2. 显式冲突审批后结果确定 ==")
        s, r = req("POST", f"/api/conflicts/{cid}/resolve",
                   {"winner_statement": 2, "resolved_by": "reviewer.zhou",
                    "note": "灯会期间以现场告示为准"})
        check("裁决成功", s == 200 and r["status"] == "resolved")
        s, r = req("GET", "/api/tips?audience=tourist&phase=during&zone_id=1&event_id=1")
        ids = [i["statement_id"] for i in r["confirmed"]]
        check("败方(可拍摄)被排除", 1 not in ids)
        check("胜方(禁止拍摄)出现且附裁决信息",
              2 in ids and r["confirmed"][ids.index(2)]["resolution"]["conflict_id"] == cid)
        check("不再有待核的摄影冲突",
              not any(p.get("topic") == "photography" for p in r["pending"]))
        s, r = req("POST", f"/api/conflicts/{cid}/resolve", {"winner_statement": 1})
        check("重复裁决被拒 409（并发保护）", s == 409)

        print("== 3. 相同事实引用共同陈述，三视图不复制文本 ==")
        _, rz = req("GET", "/api/tips?audience=resident&phase=pre")
        _, tz = req("GET", "/api/tips?audience=tourist&phase=pre")
        q_r = next(i for i in rz["confirmed"] if i["skey"] == "queue.offpeak")
        q_t = next(i for i in tz["confirmed"] if i["skey"] == "queue.offpeak")
        check("居民/游客拿到同一 statement_id 与 revision",
              q_r["statement_id"] == q_t["statement_id"] and q_r["revision_id"] == q_t["revision_id"])
        check("事实文本完全一致（共同陈述）", q_r["text"] == q_t["text"])
        check("侧重点(emphasis)按受众不同", q_r["emphasis"] != q_t["emphasis"])

        print("== 4. 编辑并发批准：只有一方成功 ==")
        s, r = req("POST", "/api/statements/3/revisions",
                   {"text_zh": "高峰时段建议错峰参观，排队时请勿插队；团队请走团体通道。",
                    "created_by": "editor.lin"})
        rid = r["revision_id"]
        results = []
        barrier = threading.Barrier(2)

        def approve(who):
            barrier.wait()
            results.append(req("POST", f"/api/revisions/{rid}/approve",
                               {"approver": who})[0])
        t1 = threading.Thread(target=approve, args=("reviewer.a",))
        t2 = threading.Thread(target=approve, args=("reviewer.b",))
        t1.start(); t2.start(); t1.join(); t2.join()
        check("并发批准恰好一个 200 一个 409", sorted(results) == [200, 409],
              f"got {results}")

        print("== 5. 翻译滞后与发布语种报告 ==")
        s, r = req("GET", "/api/translations/status")
        t3 = next(t for t in r["translations"] if t["statement_id"] == 3)
        check("原文升版后 en 翻译标记 stale（仍对应旧依据）", t3["stale"] is True
              and t3["based_on_version"] == 1 and t3["current_version"] == 2)
        s, r = req("GET", "/api/tips?audience=tourist&phase=pre&lang=en")
        q_en = next(i for i in r["confirmed"] if i["skey"] == "queue.offpeak")
        check("英文视图携带 translation_stale 标记", q_en["translation_stale"] is True)
        s, r = req("POST", "/api/publications",
                   {"audience": "tourist", "phase": "pre", "created_by": "publisher"})
        pid = r["publication_id"]
        s, r = req("GET", f"/api/publications/{pid}")
        check("发布报告列出仍对应旧依据的语种", "queue.offpeak" in
              r["language_report"].get("en", {}).get("stale", []))
        # 更新翻译后不再 stale
        req("POST", "/api/statements/3/translations",
            {"lang": "en", "text": "Visit off-peak; no queue-jumping; groups use group lane."})
        s, r = req("GET", "/api/translations/status")
        t3 = next(t for t in r["translations"] if t["statement_id"] == 3)
        check("翻译更新后 stale 解除", t3["stale"] is False)

        print("== 6. 撤回对所有语种同时生效（不能换语言绕过） ==")
        s, r = req("POST", "/api/statements/6/retract", {"by": "reviewer.zhou"})
        check("撤回成功", s == 200)
        for lang in ("zh", "en"):
            _, r = req("GET", f"/api/tips?audience=tourist&phase=pre&lang={lang}")
            check(f"{lang} 视图均不再出现已撤回陈述",
                  all(i["skey"] != "info.water" for i in r["confirmed"]))

        print("== 7. 来源撤销 → 待核；冲突来源保留 ==")
        s, r = req("POST", "/api/sources/4/withdraw", {"by": "editor.lin"})
        check("撤销成功且列出受影响陈述", s == 200 and 4 in r["affected_statements"])
        _, r = req("GET", "/api/tips?audience=tourist&phase=any&zone_id=2")
        check("唯一支撑被撤销的陈述转入待核",
              any(p.get("reason") == "unverified_source" and p["statement_id"] == 4
                  for p in r["pending"]))
        check("待核条目不出现在 confirmed",
              all(i["statement_id"] != 4 for i in r["confirmed"]))
        _, r = req("GET", "/api/statements")
        st2 = next(x for x in r["statements"] if x["id"] == 2)
        check("冲突来源记录仍保留在数据库", len(st2["conflict_sources"]) == 1)
        _, r = req("GET", "/api/sources")
        check("被撤销来源仅标记不删除",
              any(x["id"] == 4 and x["status"] == "withdrawn" for x in r["sources"]))

        print("== 8. 活动改期：阶段推导随之变化 ==")
        at = "2026-10-16T12:00:00+00:00"
        _, r1 = req("GET", f"/api/tips?audience=tourist&zone_id=1&event_id=1&at={at}")
        check("改期前 10-16 属于 during", r1["context"]["derived_phase"] == "during")
        s, r = req("POST", "/api/events/1/reschedule", {"phases": [
            {"phase": "pre", "starts_at": "2026-10-01T00:00:00+00:00",
             "ends_at": "2026-10-17T23:59:59+00:00"},
            {"phase": "during", "starts_at": "2026-10-18T00:00:00+00:00",
             "ends_at": "2026-10-23T23:59:59+00:00"},
            {"phase": "post", "starts_at": "2026-10-24T00:00:00+00:00",
             "ends_at": "2026-10-28T23:59:59+00:00"}]})
        check("改期成功且版本提升", s == 200 and r["version"] == 2)
        _, r2 = req("GET", f"/api/tips?audience=tourist&zone_id=1&event_id=1&at={at}")
        check("改期后同一时刻推导为 pre", r2["context"]["derived_phase"] == "pre")
        check("during 专属规则不再命中",
              all(i["statement_id"] != 2 for i in r2["confirmed"]))

        print("== 9. 区域边界变化：快照保留旧版本 ==")
        s, r = req("POST", "/api/publications",
                   {"audience": "tourist", "phase": "pre", "zone_id": 1})
        pid2 = r["publication_id"]
        s, r = req("POST", "/api/zones/1/boundary", {"boundary": "A栋1-3层(含扩建区)"})
        check("边界更新版本 +1", s == 200 and r["version"] == 2)
        _, r = req("GET", f"/api/publications/{pid2}")
        ctx = json.loads(r["publication"]["context_json"])
        check("旧快照仍记录 zone_version=1（可追溯）", ctx["zone_version"] == 1)
        _, r = req("GET", "/api/tips?audience=tourist&phase=pre&zone_id=1")
        check("实时解析使用新边界版本", r["context"]["zone_version"] == 2)

        print("== 10. 离线缓存过期与取代 ==")
        req("POST", "/api/cache/fetch",
            {"cache_key": "tips:tourist", "visitor_id": "v1", "ttl_seconds": 1})
        _, r = req("GET", "/api/cache/check?cache_key=tips:tourist&visitor_id=v1")
        check("TTL 内缓存有效", r["fresh"] is True)
        future = "2099-01-01T00:00:00+00:00"
        _, r = req("GET",
                   "/api/cache/check?cache_key=tips:tourist&visitor_id=v1&now="
                   + urllib.parse.quote(future))
        check("超过 TTL 判定 expired 且必须重新验证",
              r["fresh"] is False and r["reason"] == "expired"
              and r["must_revalidate"] is True)
        req("POST", "/api/cache/fetch",
            {"cache_key": "tips:tourist", "visitor_id": "v1", "ttl_seconds": 3600})
        req("POST", "/api/publications", {"audience": "tourist", "phase": "pre"})
        _, r = req("GET", "/api/cache/check?cache_key=tips:tourist&visitor_id=v1")
        check("新批准集合发布后旧缓存被取代", r["fresh"] is False
              and r["reason"] == "superseded")

        print("== 11. 已读状态绑定修订，新要求保留变更标记 ==")
        req("POST", "/api/read", {"visitor_id": "v9", "statement_id": 3})
        _, r = req("GET", "/api/read/status?visitor_id=v9")
        st = next(x for x in r["status"] if x["statement_id"] == 3)
        check("读取后无变更标记", st["marker"] is None)
        s, r = req("POST", "/api/statements/3/revisions",
                   {"text_zh": "高峰时段建议错峰参观；节假日增设单向通行。"})
        rid2 = r["revision_id"]
        req("POST", f"/api/revisions/{rid2}/approve", {"approver": "reviewer.a"})
        _, r = req("GET", "/api/read/status?visitor_id=v9")
        st = next(x for x in r["status"] if x["statement_id"] == 3)
        check("新修订批准后旧已读失效并标记 updated", st["marker"] == "updated")
        _, r = req("GET", "/api/tips?audience=tourist&phase=pre&visitor_id=v9")
        q3 = next(i for i in r["confirmed"] if i["skey"] == "queue.offpeak")
        check("提示条目携带变更标记", q3["read_marker"] == "updated")
        st5 = next(x for x in r["status"] if False) if False else None
        _, r = req("GET", "/api/read/status?visitor_id=v_new")
        check("从未阅读的陈述标记 new",
              all(x["marker"] == "new" for x in r["status"]))

        print("== 12. 打印卡与分享页同源；建议不可被改写为处罚规则 ==")
        s, r = req("POST", "/api/publications",
                   {"audience": "tourist", "phase": "pre", "zone_id": 1})
        pid3 = r["publication_id"]
        _, pr = req("GET", f"/api/publications/{pid3}/print")
        _, sh = req("GET", f"/api/publications/{pid3}/share")
        check("打印与分享来自同一批准集合",
              pr["publication_id"] == sh["publication_id"] == pid3
              and pr["generated_from"] == sh["generated_from"] == "approved_snapshot")
        check("两者条目集合一致",
              [i["statement_id"] for i in pr["items"]]
              == [i["statement_id"] for i in sh["items"]])
        adv = [i for i in pr["items"] if i["kind"] == "advisory"]
        check("快照中存在建议类条目", len(adv) >= 1)
        check("建议条目无 penalty 字段且标签为“建议”",
              all("penalty" not in i and i["label"] == "建议" for i in adv))
        rules_items = [i for i in pr["items"] if i["kind"] == "rule"]
        check("规则条目可携带 penalty，建议不可",
              all("penalty" not in i for i in adv)
              and all(i["kind"] != "advisory" for i in rules_items))
        s, r = req("POST", f"/api/publications/{pid3}/items/{adv[0]['statement_id']}/kind",
                   {"kind": "rule"})
        check("展示层改写类别被拒 403", s == 403 and r["error"] == "kind_immutable")
        _, sm = req("GET", f"/api/publications/{pid3}/summary")
        adv_s = [i for i in sm["items"] if i["kind"] == "advisory"]
        check("自动摘要保留 kind/label，不升级为处罚规则",
              len(adv_s) == len(adv)
              and all(i["label"] == "建议" and "penalty" not in i for i in adv_s))
        check("摘要只压缩文本", all("summary" in i for i in sm["items"]))

        print("== 13. 待核条目不进入批准集合 ==")
        _, r = req("GET", "/api/tips?audience=tourist&phase=during&zone_id=1&event_id=1"
                          "&at=2026-10-19T12:00:00+00:00")
        n_pending = len(r["pending"])
        s, r = req("POST", "/api/publications",
                   {"audience": "tourist", "phase": "during", "zone_id": 1,
                    "event_id": 1, "at": "2026-10-19T12:00:00+00:00"})
        check("发布返回被排除的待核数量", r["excluded_pending"] == n_pending)

        print(f"\n通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
        return 1 if FAIL else 0
    finally:
        srv.terminate()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
