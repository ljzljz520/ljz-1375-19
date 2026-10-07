'use strict';
/**
 * 极简 JSON 文档数据库:
 * - 集合式存储, 全量持久化到单个 JSON 文件(临时文件 + rename 原子写入)
 * - 冲突来源、撤回来源、历史修订一律"只改状态不删除", 保证可追溯
 * - data.meta.revision 为全局数据修订号, 每次写操作自增, 用于缓存失效判定
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function rid(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

class Collection {
  constructor(db, name) {
    this.db = db;
    this.name = name;
    if (!Array.isArray(db.data[name])) db.data[name] = [];
    this.docs = db.data[name];
  }
  all() { return this.docs.slice(); }
  get(id) { return this.docs.find(d => d.id === id) || null; }
  find(pred) { return this.docs.filter(pred); }
  findOne(pred) { return this.docs.find(pred) || null; }
  insert(doc) {
    if (!doc.id) doc.id = rid(this.name.slice(0, 4));
    this.docs.push(doc);
    this.db.touch();
    return doc;
  }
  update(id, mutator) {
    const doc = this.get(id);
    if (!doc) return null;
    if (typeof mutator === 'function') mutator(doc);
    else Object.assign(doc, mutator);
    this.db.touch();
    return doc;
  }
  remove(id) {
    const i = this.docs.findIndex(d => d.id === id);
    if (i < 0) return false;
    this.docs.splice(i, 1);
    this.db.touch();
    return true;
  }
}

class DB {
  constructor(file) {
    this.file = file || null;
    this.data = { meta: { revision: 0 } };
    if (this.file && fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!this.data.meta) this.data.meta = { revision: 0 };
    }
  }
  collection(name) { return new Collection(this, name); }
  touch() { this.data.meta.revision += 1; }
  get revision() { return this.data.meta.revision; }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { DB, rid };
