# -*- coding: utf-8 -*-
"""种子数据：来源、共同陈述、规则、区域、活动、翻译。幂等。"""
import sqlite3
from datetime import datetime, timezone


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def run(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    if conn.execute("SELECT COUNT(*) c FROM statements").fetchone()["c"]:
        conn.close()
        return
    now = _now()
    cur = conn.cursor()

    # 来源（含相互冲突的来源，全部保留）
    cur.executemany(
        "INSERT INTO sources(id,title,stype,ref,reliability,status) VALUES(?,?,?,?,?,?)",
        [(1, "西安市文明行为促进条例", "regulation", "市人大公告2021-18", 95, "active"),
         (2, "景区管理处开放公告(2026-09)", "organizer", "公告栏A-2026-09", 80, "active"),
         (3, "壁画馆施工期临时告示牌", "signage", "现场照片#S-117", 70, "active"),
         (4, "社区文明公约通知", "community", "社区公众号2026-08", 60, "active")])

    # 共同陈述：同一事实唯一载体
    cur.executemany(
        """INSERT INTO statements(id,skey,topic,stance,kind,status,penalty_note,created_at)
           VALUES(?,?,?,?,?,?,?,?)""",
        [(1, "photo.allow_main", "photography", "allow", "rule", "active", None, now),
         (2, "photo.forbid_mural", "photography", "forbid", "rule", "active",
          "依据管理条例可予以劝阻并报告", now),
         (3, "queue.offpeak", "queue", "neutral", "advisory", "active", None, now),
         (4, "dress.respect", "dress", "neutral", "advisory", "active", None, now),
         (5, "staff.badge", "staff_conduct", "neutral", "rule", "active", None, now),
         (6, "info.water", "facility", "neutral", "info", "active", None, now)])

    # 修订(均已批准)；emphasis_* 为各受众侧重点说明，不是事实副本
    revs = [
        (1, 1, 1, "主展厅允许拍摄，但请勿使用闪光灯与三脚架。",
         "居民讲解拍摄限制时可引用同一条款。",
         "游客可拍照留念，关闭闪光灯即可。",
         "工作人员巡查时先口头提醒闪光灯使用。"),
        (2, 2, 1, "壁画馆及施工区域禁止拍摄。",
         "居民带亲友参观时注意绕行施工区。",
         "请勿在壁画馆举起相机或手机拍摄。",
         "工作人员发现拍摄应立即劝阻并指引至可拍区域。"),
        (3, 3, 1, "高峰时段建议错峰参观，排队时请勿插队。",
         "居民可选择工作日上午错峰出行。",
         "建议开馆后一小时或闭馆前两小时到访。",
         "高峰时请在入口引导排队并提示预计等待时间。"),
        (4, 4, 1, "进入祠堂区域建议着装整洁得体。",
         "居民参加家族活动时留意着装。",
         "建议避免背心、拖鞋进入祠堂区域。",
         "工作人员以礼貌用语提醒，不作强制。"),
        (5, 5, 1, "现场工作人员须佩戴证件并熟悉疏散路线。",
         None, None, "上岗前自查证件与当日疏散图。"),
        (6, 6, 1, "直饮水点位于东门服务台旁。",
         "居民晨练可就近取水。",
         "游客可在东门免费接水。",
         "每日开馆前检查水点设备。"),
    ]
    cur.executemany(
        """INSERT INTO revisions(id,statement_id,version,text_zh,emphasis_resident,
             emphasis_tourist,emphasis_staff,review_status,created_by,created_at,
             approved_by,approved_at)
           VALUES(?,?,?,?,?,?,?, 'approved', 'editor.lin', ?, 'reviewer.zhou', ?)""",
        [(r[0], r[1], r[2], r[3], r[4], r[5], r[6], now, now) for r in revs])
    for rid in range(1, 7):
        cur.execute("UPDATE statements SET current_revision=? WHERE id=?", (rid, rid))

    # 翻译：记录所依据的修订
    cur.executemany(
        """INSERT INTO translations(statement_id,lang,text,based_on_revision,updated_by,updated_at)
           VALUES(?,?,?,?,?,?)""",
        [(1, "en", "Photography is allowed in the main hall, but no flash or tripods.",
          1, "translator.mei", now),
         (3, "en", "Consider visiting off-peak; please do not jump the queue.",
          3, "translator.mei", now)])

    # 陈述-来源关联：conflicts 关系永久保留冲突来源
    cur.executemany(
        "INSERT INTO statement_sources(statement_id,source_id,relation,note) VALUES(?,?,?,?)",
        [(1, 1, "supports", None), (1, 2, "supports", "公告明确主展厅可拍"),
         (2, 3, "supports", "告示牌明示禁拍"),
         (2, 2, "conflicts", "公告未排除壁画馆，与告示牌冲突"),
         (3, 1, "supports", None),
         (4, 4, "supports", "唯一支撑来源"),
         (5, 1, "supports", None), (5, 2, "supports", None),
         (6, 2, "supports", None)])

    # 区域与活动
    cur.executemany(
        "INSERT INTO zones(id,name,version,boundary) VALUES(?,?,?,?)",
        [(1, "主展厅", 1, "A栋1-2层"), (2, "祠堂区", 1, "B栋全院")])
    cur.execute("INSERT INTO events(id,name,version) VALUES(1,'中秋灯会',1)")
    cur.executemany(
        "INSERT INTO event_phases(event_id,phase,starts_at,ends_at) VALUES(?,?,?,?)",
        [(1, "pre", "2026-10-01T00:00:00+00:00", "2026-10-14T23:59:59+00:00"),
         (1, "during", "2026-10-15T00:00:00+00:00", "2026-10-20T23:59:59+00:00"),
         (1, "post", "2026-10-21T00:00:00+00:00", "2026-10-25T23:59:59+00:00")])

    # 规则：受众×阶段×区域×活动×优先级
    cur.executemany(
        """INSERT INTO rules(statement_id,audience,phase,zone_id,event_id,priority,active)
           VALUES(?,?,?,?,?,?,1)""",
        [(1, "all", "any", 1, None, 10),
         (2, "all", "during", 1, 1, 10),   # 与 stmt1 在灯会期间同域冲突 → 待核
         (3, "all", "any", None, None, 5),
         (4, "all", "any", 2, None, 5),
         (5, "staff", "any", None, None, 20),
         (6, "all", "any", None, None, 1)])

    conn.commit()
    conn.close()
