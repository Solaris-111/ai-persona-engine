const initSqlJs = require('sql.js');
const { join } = require('path');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const crypto = require('crypto');

const DB_PATH = join(__dirname, '..', 'calendar.db');

let db;
let SQL;

// ── Lifecycle ─────────────────────────────────────────────

async function open() {
  if (db) return db;
  SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    const buffer = readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');
  initTables();
  migrate();
  save();
  return db;
}

function save() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(DB_PATH, buffer);
}

function close() {
  if (db) { db.close(); db = null; }
}

// ── Schema ────────────────────────────────────────────────

function initTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      end_date TEXT,
      time_type TEXT NOT NULL DEFAULT 'point' CHECK(time_type IN ('point','range','open')),
      type TEXT NOT NULL CHECK(type IN ('meds','period','symptom','schedule','plan','bill','health','note','habit')),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      meta TEXT DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'manual',
      source_id TEXT,
      importance INTEGER DEFAULT 3 CHECK(importance BETWEEN 1 AND 5),
      urgency INTEGER DEFAULT 3 CHECK(urgency BETWEEN 1 AND 5),
      active INTEGER DEFAULT 1,
      conflict INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_events_date ON events(date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)');
  db.run('CREATE INDEX IF NOT EXISTS idx_events_active ON events(active)');
  db.run('CREATE INDEX IF NOT EXISTS idx_events_source ON events(source, source_id)');

  db.run(`
    CREATE TABLE IF NOT EXISTS ingest_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_id TEXT,
      event_id TEXT,
      content_hash TEXT NOT NULL,
      conflict_detected INTEGER DEFAULT 0,
      conflict_detail TEXT,
      ingested_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_ingest_hash ON ingest_log(content_hash)');
}

function migrate() {
  // Add columns if missing (v1 → v2 migration)
  const cols = db.exec("PRAGMA table_info(events)");
  if (cols.length > 0) {
    const colNames = cols[0].values.map(r => r[1]);
    try { if (!colNames.includes('time_type')) db.run("ALTER TABLE events ADD COLUMN time_type TEXT DEFAULT 'point'"); } catch (_) {}
    try { if (!colNames.includes('importance')) db.run("ALTER TABLE events ADD COLUMN importance INTEGER DEFAULT 3"); } catch (_) {}
    try { if (!colNames.includes('urgency')) db.run("ALTER TABLE events ADD COLUMN urgency INTEGER DEFAULT 3"); } catch (_) {}
    try { if (!colNames.includes('notes')) db.run("ALTER TABLE events ADD COLUMN notes TEXT DEFAULT ''"); } catch (_) {}
    // Remove old 'priority' column if it exists
    try { if (colNames.includes('priority')) {
      // SQLite doesn't support DROP COLUMN in older versions, just leave it
    }} catch (_) {}
  }

  // Upgrade old events: map priority→importance+urgency
  try {
    db.run(`UPDATE events SET importance = priority, urgency = priority WHERE importance = 3 AND urgency = 3 AND priority IS NOT NULL AND priority != 3`);
  } catch (_) {}
}

// ── Urgency (purely algorithmic, based on time_type + proximity) ──

function calcUrgency(event, now) {
  if (!event.active) return 0;
  const t = now || new Date();
  const today = new Date(t); today.setHours(0, 0, 0, 0);
  const eventDate = new Date(event.date); eventDate.setHours(0, 0, 0, 0);
  const daysUntil = Math.round((eventDate.getTime() - today.getTime()) / 86400000);

  switch (event.time_type) {
    case 'range': {
      // 已知起止：开始前一段时间 + 中途 → 重要；结束后快速衰减
      if (event.end_date) {
        const endDate = new Date(event.end_date); endDate.setHours(0, 0, 0, 0);
        // 中途 — 最重要
        if (today >= eventDate && today <= endDate) return 5;
        // 结束后 — 快速衰减
        if (today > endDate) {
          const d = Math.round((today.getTime() - endDate.getTime()) / 86400000);
          if (d <= 3) return 4; if (d <= 7) return 3; if (d <= 14) return 2; return 1;
        }
      }
      // 开始前 — 越近越紧急
      if (daysUntil <= 3) return 5;
      if (daysUntil <= 7) return 4;
      if (daysUntil <= 14) return 3;
      return daysUntil <= 30 ? 2 : 1;
    }

    case 'open': {
      // 知道开始但未知结束：没标 end_date 之前，之后的所有时间都算"中途"
      if (event.end_date) {
        // 有结束日期 → 和 range 逻辑一样
        const endDate = new Date(event.end_date); endDate.setHours(0, 0, 0, 0);
        if (today >= eventDate && today <= endDate) return 5;
        if (today > endDate) {
          const d = Math.round((today.getTime() - endDate.getTime()) / 86400000);
          if (d <= 3) return 4; if (d <= 7) return 3; if (d <= 14) return 2; return 1;
        }
        // 开始前
        if (daysUntil <= 3) return 4;
        if (daysUntil <= 14) return 3;
        return 2;
      }
      // 没有结束日期 → 开始后全是"进行中"，持续高紧急
      if (daysUntil <= 0) return 5;
      // 开始前
      if (daysUntil <= 3) return 4;
      if (daysUntil <= 14) return 3;
      return 2;
    }

    case 'point': {
      // 只有开始时间：当天最重要
      if (Math.abs(daysUntil) <= 1) return 5;
      if (Math.abs(daysUntil) <= 3) return 4;
      if (daysUntil < 0) return Math.abs(daysUntil) <= 7 ? 2 : 1;
      return daysUntil <= 7 ? 3 : daysUntil <= 14 ? 2 : 1;
    }

    default: return 2;
  }
}

// ── Content hash ──────────────────────────────────────────

function hashContent(date, type, title, meta) {
  const payload = [date, type, title, JSON.stringify(meta || {})].join('|');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

// ── Validation ────────────────────────────────────────────

const VALID_TYPES = ['meds', 'period', 'symptom', 'schedule', 'plan', 'bill', 'health', 'note', 'habit'];

const TYPE_RULES = {
  meds:     { requireMeta: [], defaultTimeType: 'open' },
  period:   { requireMeta: [], defaultTimeType: 'range' },
  symptom:  { requireMeta: [], defaultTimeType: 'point' },
  schedule: { requireMeta: [], defaultTimeType: 'range' },
  plan:     { requireMeta: [], defaultTimeType: 'range' },
  bill:     { requireMeta: ['month'], defaultTimeType: 'point' },
  health:   { requireMeta: [], defaultTimeType: 'open' },
  note:     { requireMeta: [], defaultTimeType: 'point' },
  habit:    { requireMeta: [], defaultTimeType: 'open' },
};

const TIME_TYPE_LABELS = {
  point: '单日事件',
  range: '时间段',
  open:  '开始日（结束日未知）',
};

function validate(event) {
  const errors = [];
  if (!VALID_TYPES.includes(event.type)) errors.push('Unknown type: ' + event.type);
  if (!event.date) errors.push('date required');
  if (event.time_type === 'range' && !event.end_date) {
    errors.push('range event requires end_date');
  }
  if (event.end_date && event.date > event.end_date) {
    errors.push('end_date must be >= date');
  }

  const rules = TYPE_RULES[event.type];
  if (rules && rules.requireMeta) {
    let meta = event.meta || {};
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch (_) { errors.push('meta is not valid JSON'); }
    }
    for (const key of rules.requireMeta) {
      if (!meta[key]) errors.push(event.type + ' requires meta.' + key);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── CRUD ──────────────────────────────────────────────────

function genId() {
  return crypto.randomUUID().slice(0, 12);
}

function insertEvent(data) {
  const id = genId();
  const meta = typeof data.meta === 'object' ? JSON.stringify(data.meta) : (data.meta || '{}');
  const tags = Array.isArray(data.tags) ? JSON.stringify(data.tags) : (data.tags || '[]');
  const timeType = data.time_type || (TYPE_RULES[data.type] || {}).defaultTimeType || 'point';

  const event = {
    ...data, time_type: timeType, meta,
    notes: data.notes || '',
    importance: data.importance || 3,
    urgency: data.urgency || 3,
  };

  const validation = validate(event);
  if (!validation.valid) {
    return { error: validation.errors.join('; ') };
  }

  const contentHash = hashContent(data.date, data.type, data.title, meta);

  // Dedup check
  const dup = db.exec(`
    SELECT id FROM events
    WHERE active = 1 AND date = ? AND type = ? AND title = ?
    LIMIT 1
  `, [data.date, data.type, data.title]);

  if (dup.length > 0 && dup[0].values.length > 0) {
    const existingId = dup[0].values[0][0];
    logIngest(data.source, data.source_id || null, existingId, contentHash, false, 'Duplicate — skipped');
    return { id: existingId, updated: false, reason: 'duplicate' };
  }

  db.run(`
    INSERT INTO events (id, date, end_date, time_type, type, title, description, notes, tags, meta, source, source_id, importance, urgency, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `, [id, data.date, data.end_date || null, timeType, data.type, data.title,
      data.description || '', data.notes || '', tags, meta,
      data.source || 'manual', data.source_id || null,
      event.importance, event.urgency]);

  logIngest(data.source, data.source_id || null, id, contentHash, false, 'Created');
  save();
  return { id, updated: false };
}

function upsertBySource(source, sourceId, data) {
  if (!source || !sourceId) return insertEvent(data);

  const existing = getBySource(source, sourceId);
  if (existing) {
    // Conflict detection: core fields changed?
    const newMeta = typeof data.meta === 'object' ? JSON.stringify(data.meta) : (data.meta || '{}');
    const coreChanged = (
      existing.type !== data.type ||
      existing.title !== data.title ||
      existing.date !== data.date
    );

    if (coreChanged) {
      db.run(`UPDATE events SET conflict = 1, updated_at = datetime('now','localtime') WHERE id = ?`, [existing.id]);
      const conflictDetail = `type: ${existing.type}→${data.type}, title: ${existing.title}→${data.title}, date: ${existing.date}→${data.date}`;
      const contentHash = hashContent(data.date, data.type, data.title, newMeta);
      logIngest(source, sourceId, existing.id, contentHash, true, conflictDetail);
      save();
      return { id: existing.id, conflict: true, detail: conflictDetail };
    }

    // Safe update: non-core fields only
    const meta = typeof data.meta === 'object' ? JSON.stringify(data.meta) : (data.meta || '{}');
    const tags = Array.isArray(data.tags) ? JSON.stringify(data.tags) : (data.tags || '{}');
    const oldNotes = existing.notes || '';
    const appendNotes = data._appendNotes || '';
    const newNotes = appendNotes ? (oldNotes + (oldNotes ? '\n' : '') + appendNotes) : (data.notes !== undefined ? data.notes : oldNotes);

    db.run(`
      UPDATE events SET
        end_date = ?, time_type = ?, description = ?, notes = ?, tags = ?, meta = ?,
        importance = ?, urgency = ?,
        active = 1, conflict = 0,
        updated_at = datetime('now','localtime')
      WHERE id = ?
    `, [
      data.end_date || existing.end_date,
      data.time_type || existing.time_type || 'point',
      data.description || existing.description,
      newNotes,
      tags, meta,
      data.importance || existing.importance || 3,
      data.urgency || existing.urgency || 3,
      existing.id
    ]);

    const contentHash = hashContent(data.date, data.type, data.title, meta);
    logIngest(source, sourceId, existing.id, contentHash, false, appendNotes ? 'Updated (notes appended)' : 'Updated');
    save();
    return { id: existing.id, updated: true };
  }

  return insertEvent({ ...data, source, source_id: sourceId });
}

// Append notes to an existing event (from companion chat extraction)
function appendNotes(id, text) {
  const existing = getById(id);
  if (!existing) return null;
  const oldNotes = existing.notes || '';
  const newNotes = oldNotes + (oldNotes ? '\n---\n' : '') + new Date().toISOString().slice(0, 16) + ' ' + text;
  db.run(`UPDATE events SET notes = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [newNotes, id]);
  save();
  return { id, notesAppended: true };
}

// Append notes by source (for companion to update bridge events)
function appendNotesBySource(source, sourceId, text) {
  const existing = getBySource(source, sourceId);
  if (!existing) return null;
  return appendNotes(existing.id, text);
}

function markInactiveBySource(source, sourceId) {
  const existing = getBySource(source, sourceId);
  if (!existing) return null;
  db.run(`UPDATE events SET active = 0, updated_at = datetime('now','localtime') WHERE id = ?`, [existing.id]);
  save();
  return { id: existing.id, archived: true };
}

function getBySource(source, sourceId) {
  const stmt = db.prepare(`SELECT * FROM events WHERE source = ? AND source_id = ? AND active = 1 LIMIT 1`);
  stmt.bind([source, sourceId]);
  if (stmt.step()) {
    const row = rowToEvent(stmt.getAsObject());
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function getById(id) {
  const stmt = db.prepare(`SELECT * FROM events WHERE id = ?`);
  stmt.bind([id]);
  if (stmt.step()) {
    const row = rowToEvent(stmt.getAsObject());
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function updateEvent(id, data) {
  const existing = getById(id);
  if (!existing) return null;

  // Handle notes append
  if (data._appendNotes) {
    const oldNotes = existing.notes || '';
    data.notes = oldNotes + (oldNotes ? '\n---\n' : '') + new Date().toISOString().slice(0, 16) + ' ' + data._appendNotes;
    delete data._appendNotes;
  }

  const fields = [];
  const values = [];
  const allowed = ['date', 'end_date', 'time_type', 'type', 'title', 'description', 'notes', 'tags', 'meta', 'importance', 'urgency', 'active', 'conflict'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      if ((key === 'tags' || key === 'meta') && typeof data[key] === 'object') {
        fields.push(key + ' = ?');
        values.push(JSON.stringify(data[key]));
      } else {
        fields.push(key + ' = ?');
        values.push(data[key]);
      }
    }
  }

  if (fields.length === 0) return existing;
  fields.push("updated_at = datetime('now','localtime')");
  values.push(id);

  db.run(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`, values);
  save();
  return getById(id);
}

function deleteEvent(id) {
  const existing = getById(id);
  if (!existing) return false;
  db.run(`DELETE FROM events WHERE id = ?`, [id]);
  db.run(`DELETE FROM ingest_log WHERE event_id = ?`, [id]);
  save();
  return true;
}

// ── Query ─────────────────────────────────────────────────

function queryEvents({ activeOnly = true, type, dateFrom, dateTo, source, limit = 200, offset = 0, includeConflict = false } = {}) {
  const conditions = [];
  const params = [];

  if (activeOnly) { conditions.push('active = 1'); params.push(); }
  if (type) { conditions.push('type = ?'); params.push(type); }
  if (dateFrom) { conditions.push('date >= ?'); params.push(dateFrom); }
  if (dateTo) { conditions.push('date <= ?'); params.push(dateTo); }
  if (source) { conditions.push('source = ?'); params.push(source); }
  if (!includeConflict) { conditions.push('conflict = 0'); params.push(); }

  // Remove undefined params (from activeOnly and includeConflict)
  const cleanParams = params.filter(p => p !== undefined);

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const sql = `SELECT * FROM events ${where} ORDER BY date DESC, updated_at DESC LIMIT ? OFFSET ?`;
  cleanParams.push(limit, offset);

  const results = [];
  const stmt = db.prepare(sql);
  stmt.bind(cleanParams);
  while (stmt.step()) {
    const row = rowToEvent(stmt.getAsObject());
    row._weight = calcWeight(row, new Date());
    row._urgency = calcUrgency(row, new Date());
    results.push(row);
  }
  stmt.free();
  return results;
}

function getMonthView(year, month) {
  const m = String(month).padStart(2, '0');
  const from = `${year}-${m}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${m}-${String(lastDay).padStart(2, '0')}`;
  return queryEvents({ dateFrom: from, dateTo: to, activeOnly: false, limit: 500 });
}

function getContextEvents(now) {
  const today = now || new Date();
  const events = queryEvents({ activeOnly: true, limit: 100 });

  return events.map(e => {
    e._weight = calcWeight(e, today);
    e._urgency = calcUrgency(e, today);
    return e;
  }).filter(e => e._weight > 0.02)
    .sort((a, b) => b._weight - a._weight);
}

function autoArchive(now) {
  const today = now || new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Archive rules by time_type
  db.run(`UPDATE events SET active = 0, updated_at = datetime('now','localtime')
    WHERE active = 1 AND (
      (time_type = 'range' AND end_date IS NOT NULL AND end_date < date('now','-7 days')) OR
      (time_type = 'point' AND date < date('now','-30 days')) OR
      (time_type = 'open' AND date < date('now','-90 days') AND (end_date IS NULL OR end_date = ''))
    )`, []);
  save();
}

// ── Weight = importance × urgency (urgency computed, not stored) ──

function calcWeight(event, now) {
  if (!event.active) return 0;
  const imp = event.importance || 3;
  const urg = calcUrgency(event, now);
  return Math.round(imp * urg * 100) / 100;
}

// ── Topic relevance ──────────────────────────────────────

const TYPE_TOPIC_MAP = {
  meds:     ['pills', 'daily'],
  period:   ['daily', 'mood'],
  symptom:  ['pills', 'daily'],
  schedule: ['internship', 'daily', 'sleep', 'food'],
  plan:     ['daily', 'mood'],
  bill:     ['daily'],
  health:   ['pills', 'daily', 'food'],
  note:     ['mood'],
  habit:    ['daily'],
};

function getTopicBoosts(now) {
  const events = getContextEvents(now);
  const boosts = {};

  for (const event of events) {
    if (event._weight < 1) continue;
    const topics = TYPE_TOPIC_MAP[event.type] || ['daily'];
    const boost = event._weight;
    for (const topicId of topics) {
      if (boost > 1) {
        boosts[topicId] = Math.max(boosts[topicId] || 1, boost);
      } else if (!boosts[topicId]) {
        boosts[topicId] = Math.max(boosts[topicId] || 0.3, boost);
      }
    }
  }

  return boosts;
}

// ── Ingest log ────────────────────────────────────────────

function logIngest(source, sourceId, eventId, contentHash, conflict, detail) {
  db.run(`
    INSERT INTO ingest_log (source, source_id, event_id, content_hash, conflict_detected, conflict_detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [source || 'manual', sourceId, eventId, contentHash, conflict ? 1 : 0, detail || null]);
}

function getIngestLog(limit = 50) {
  const results = [];
  const stmt = db.prepare(`SELECT * FROM ingest_log ORDER BY ingested_at DESC LIMIT ?`);
  stmt.bind([limit]);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function getConflicts() {
  return queryEvents({ activeOnly: true, includeConflict: true, limit: 50 })
    .filter(e => e.conflict === 1 || e.conflict === '1');
}

// ── Stats ─────────────────────────────────────────────────

function getStats() {
  const total = db.exec(`SELECT COUNT(*) FROM events`);
  const active = db.exec(`SELECT COUNT(*) FROM events WHERE active = 1`);
  const byType = db.exec(`SELECT type, COUNT(*) as cnt FROM events WHERE active = 1 GROUP BY type`);
  const byQuadrant = db.exec(`SELECT importance, urgency, COUNT(*) as cnt FROM events WHERE active = 1 GROUP BY importance, urgency`);

  return {
    totalEvents: total[0]?.values[0]?.[0] || 0,
    activeEvents: active[0]?.values[0]?.[0] || 0,
    byType: byType[0]?.values?.map(r => ({ type: r[0], count: r[1] })) || [],
  };
}

// ── Helpers ───────────────────────────────────────────────

function rowToEvent(row) {
  const event = { ...row };
  try { event.tags = JSON.parse(event.tags); } catch (_) { event.tags = []; }
  try { event.meta = JSON.parse(event.meta); } catch (_) { event.meta = {}; }
  return event;
}

// ── Seed defaults ─────────────────────────────────────────

function seedDefaults() {
  const count = db.exec(`SELECT COUNT(*) FROM events`);
  if (count[0]?.values[0]?.[0] > 0) return;

  const defaults = [
    {
      date: '2026-07-04',
      end_date: '2026-07-11',
      title: '峨眉山地质实习',
      type: 'schedule',
      time_type: 'range',
      tags: ['实习', '地质'],
      importance: 5,
      urgency: 4,
      source: 'manual',
    },
  ];

  for (const d of defaults) {
    insertEvent(d);
  }
}

module.exports = {
  open, save, close,
  insertEvent, upsertBySource, markInactiveBySource,
  getById, updateEvent, deleteEvent,
  appendNotes, appendNotesBySource,
  queryEvents, getMonthView, getContextEvents,
  getTopicBoosts, calcWeight,
  getIngestLog, getConflicts, getStats,
  seedDefaults, autoArchive,
  hashContent, validate,
  TYPE_TOPIC_MAP, TIME_TYPE_LABELS,
};
