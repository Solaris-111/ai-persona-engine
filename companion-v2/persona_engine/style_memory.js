/**
 * Style Memory v2.1 — KNN context-space memory with gravitational crystallization.
 *
 * 重构为「函数式内核 + 命令式外壳」（同 genome_engine 模式）：
 *   纯函数 insert / retrieve / decay 均 (state, input) → newState，时间走 state._now。
 *
 * Each interaction → point in 8D context space (Critic output) with
 * message text + reward. Points crystallize (merge) when nearby,
 * and mass decays via Hawking radiation over time.
 *
 * Retrieval: mass-weighted KNN in context space → few-shot prompt injection.
 */

const { existsSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

const MEMORY_FILE = join(__dirname, '..', '.style-memory-v2.json');

const DIM = 8;
const MERGE_THRESHOLD = 0.85;       // Cosine similarity threshold for crystallization
const DECAY_RATE = 0.001;           // Hawking radiation per hour (~29 day half-life)
const EVICTION_THRESHOLD = 0.005;   // Mass below this → deleted
const MAX_POINTS = 200;

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

// ── Vector math（纯）──

function dot(a, b) {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s;
}

function norm(a) {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s);
}

function cosineSimilarity(a, b) {
  const n = norm(a) * norm(b);
  return n < 1e-9 ? 0 : dot(a, b) / n;
}

function vecAdd(a, b, wa = 1, wb = 1) {
  return a.map((v, i) => (v * wa + b[i] * wb) / (wa + wb));
}

// ── 纯函数核 ──

function initState(now = Date.now()) {
  return { pool: [], _now: now };
}

/**
 * Insert a memory point（纯函数）。Crystalizes with nearest neighbor if similarity > threshold.
 * @returns {{ state, point }}
 */
function insert(state, context, message, reward) {
  if (!context || context.length < DIM) return { state, point: null };

  const pool = deepClone(state.pool);
  const _now = state._now;

  const vec = context.slice(0, DIM);
  const normV = norm(vec);
  const normalized = normV < 1e-9 ? vec : vec.map(v => v / normV);

  // Find nearest neighbor
  let bestMatch = null;
  let bestSim = 0;
  for (const pt of pool) {
    const sim = cosineSimilarity(normalized, pt.context);
    if (sim > bestSim) { bestSim = sim; bestMatch = pt; }
  }

  if (bestMatch && bestSim > MERGE_THRESHOLD) {
    // Crystallization: merge into existing
    const oldMass = bestMatch.mass || 1.0;
    bestMatch.mass = oldMass + 1.0;
    bestMatch.context = vecAdd(bestMatch.context, normalized, oldMass, 1.0);
    bestMatch.reward = (bestMatch.reward * bestMatch.access_count + reward) / (bestMatch.access_count + 1);
    bestMatch.access_count += 1;
    bestMatch.last_accessed = _now;
    return { state: { ...state, pool }, point: bestMatch };
  }

  // New memory point
  const point = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    context: normalized,
    message: message.slice(0, 500),
    reward,
    mass: 1.0,
    created_at: _now,
    last_accessed: _now,
    access_count: 1,
  };

  pool.push(point);

  // Evict if over limit (remove lowest mass)
  if (pool.length > MAX_POINTS) {
    pool.sort((a, b) => a.mass - b.mass);
    pool.shift();
  }

  return { state: { ...state, pool }, point };
}

/**
 * Apply Hawking radiation（纯函数）。mass decays exponentially with time.
 * @returns {{ state, removed }}
 */
function decay(state) {
  const pool = deepClone(state.pool);
  const _now = state._now;
  let removed = 0;

  for (let i = pool.length - 1; i >= 0; i--) {
    const pt = pool[i];
    const deltaHours = Math.max(0, (_now - (pt.last_accessed || pt.created_at)) / 3600000);
    const excessMass = Math.max(0, (pt.mass || 1.0) - 1.0);
    const decayedExcess = excessMass * Math.exp(-DECAY_RATE * deltaHours);
    pt.mass = 1.0 + decayedExcess;
    if (pt.mass - 1.0 < EVICTION_THRESHOLD && pt.mass < 1.01) {
      pool.splice(i, 1);
      removed++;
    }
  }

  return { state: { ...state, pool }, removed };
}

/**
 * Retrieve top-k points by mass-weighted cosine similarity（纯函数，内部先 decay）。
 * @returns {{ state, points }}
 */
function retrieve(state, queryContext, k = 3) {
  if (!queryContext || state.pool.length === 0) return { state, points: [] };

  const { state: s1 } = decay(state); // Apply time-based mass decay
  const pool = deepClone(s1.pool);
  const _now = s1._now;

  const vec = queryContext.slice(0, DIM);
  const normV = norm(vec);
  const q = normV < 1e-9 ? vec : vec.map(v => v / normV);

  const scored = pool.map(pt => ({
    ...pt,
    _score: cosineSimilarity(q, pt.context) * (pt.mass || 1.0),
  }));

  scored.sort((a, b) => b._score - a._score);

  const top = scored.slice(0, k).filter(p => p._score > 0.1);
  // Mark as accessed
  for (const pt of top) {
    pt.last_accessed = _now;
  }
  return { state: { ...s1, pool }, points: top };
}

/**
 * Build few-shot prompt from retrieved memory points（纯格式化）。
 */
function buildFewShotPrompt(points, lang = 'zh') {
  if (!points || points.length === 0) return '';

  const lines = lang === 'en'
    ? ['## Style Reference (historical responses in similar contexts)']
    : ['## 风格参考（类似情境下的历史回应，按质量加权）'];

  for (const pt of points) {
    const score = pt._score.toFixed(2);
    const quality = pt.reward > 0.7 ? (lang === 'en' ? 'great' : '很好')
      : pt.reward > 0.4 ? (lang === 'en' ? 'ok' : '还行')
      : (lang === 'en' ? 'meh' : '一般');
    lines.push(`${lang === 'en' ? 'Context similarity' : '情境相似度'}: ${score}`);
    lines.push(`${lang === 'en' ? 'User reaction' : '用户反应'}: ${quality}`);
    lines.push(`${lang === 'en' ? 'Reply' : '回应'}: "${pt.message}"`);
    lines.push('---');
  }

  return lines.join('\n');
}

/**
 * State summary（纯读取）。
 */
function getState(state) {
  const pool = state.pool;
  const _now = state._now;
  const totalMass = pool.reduce((s, p) => s + (p.mass || 1), 0);
  return {
    totalPoints: pool.length,
    totalMass: Math.round(totalMass * 10) / 10,
    oldestPoint: pool.length > 0 ? Math.round((_now - pool[0].created_at) / 3600000) : 0,
    newestPoint: pool.length > 0 ? pool[pool.length - 1].created_at : 0,
  };
}

// ── 持久化 ──

function fileStorage(filePath = MEMORY_FILE) {
  return {
    load() {
      try {
        if (existsSync(filePath)) {
          const data = JSON.parse(readFileSync(filePath, 'utf-8'));
          return {
            pool: data.pool || [],
            _now: data._now || Date.now(),
          };
        }
      } catch (_) {}
      return null;
    },
    save(state) {
      try {
        writeFileSync(filePath, JSON.stringify({
          pool: (state.pool || []).slice(-MAX_POINTS),
          _now: state._now,
        }, null, 2));
      } catch (_) {}
    },
  };
}

// ── 工厂 ──

function createStyleMemory({ storage, clock = Date.now } = {}) {
  const store = storage || fileStorage();
  let state = store.load();
  if (!state) state = initState(clock());

  const pureInsert = insert;
  const pureRetrieve = retrieve;
  const pureDecay = decay;
  const pureBuild = buildFewShotPrompt;

  function persist() { store.save(state); }

  return {
    insert(context, message, reward) {
      state._now = clock();
      const r = pureInsert(state, context, message, reward);
      state = r.state;
      persist();
      return r.point;
    },
    retrieve(queryContext, k) {
      state._now = clock();
      const r = pureRetrieve(state, queryContext, k);
      state = r.state;
      persist();
      return r.points;
    },
    decay() {
      state._now = clock();
      const r = pureDecay(state);
      state = r.state;
      persist();
      return r.removed;
    },
    buildFewShotPrompt(queryContext, k = 3, lang = 'zh') {
      state._now = clock();
      const r = pureRetrieve(state, queryContext, k);
      state = r.state;
      persist();
      return pureBuild(r.points, lang);
    },
    setClock(t) { state._now = t; },
    getState() { return getState(state); },
    snapshot() { return JSON.parse(JSON.stringify(state)); },
  };
}

module.exports = {
  DIM, MAX_POINTS,
  // 向量数学（纯）
  dot, norm, cosineSimilarity, vecAdd,
  // 纯函数核
  initState, insert, retrieve, decay, buildFewShotPrompt, getState,
  // 工厂 + 持久化
  createStyleMemory, fileStorage,
};
