/**
 * DriveMetabolism v2.1 — Time-arrow drive metabolism engine.
 *
 * 重构为「函数式内核 + 命令式外壳」（同 genome_engine 模式）：
 *   纯函数 metabolize / applyFrustrationDelta / satisfyDrives / evolveBaselines
 *   均 (state, input) → newState，不碰文件、随机走 rng 参数。
 *
 * Two core time equations (unchanged):
 *   1. Frustration cooling:  f *= e^(-λ × Δt)    — time heals all drives
 *   2. Hunger accumulation:  connection += k × Δt — loneliness/boredom grow linearly
 *
 * Temperature emerges from total frustration via tanh saturation.
 */

const { existsSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

const DRIVES_FILE = join(__dirname, '..', '.drives-v2.json');

const DRIVES = ['connection', 'novelty', 'expression', 'safety', 'play'];

const DRIVE_LABELS = {
  connection: '🔗 联结',
  novelty:    '✨ 新鲜',
  expression: '💬 表达',
  safety:     '🛡️ 安全',
  play:       '🎭 玩闹',
};

const DEFAULT_DRIVES = {
  connection: { value: 0.3, hungerRate: 0.15, decayRate: 0.08, frustration: 0.0, baseline: 0.30, satisfaction: 0.0 },
  novelty:    { value: 0.3, hungerRate: 0.07, decayRate: 0.05, frustration: 0.0, baseline: 0.30, satisfaction: 0.0 },
  expression: { value: 0.3, hungerRate: 0.12, decayRate: 0.06, frustration: 0.0, baseline: 0.30, satisfaction: 0.0 },
  safety:     { value: 0.2, hungerRate: 0.04, decayRate: 0.04, frustration: 0.0, baseline: 0.20, satisfaction: 0.0 },
  play:       { value: 0.3, hungerRate: 0.06, decayRate: 0.07, frustration: 0.0, baseline: 0.30, satisfaction: 0.0 },
};

// Physical constants (overridable per-persona via engine_params)
const FRUSTRATION_DECAY_LAMBDA = 0.08;   // 挫败冷却速率 (/hour): ~8.7h half-life
const CONNECTION_HUNGER_K = 0.15;         // 孤独增长速度 (/hour)
const NOVELTY_HUNGER_K = 0.05;            // 无聊增长速度 (/hour)
const TEMP_COEFF = 0.12;                  // 温度系数
const TEMP_FLOOR = 0.03;                  // 温度地板 (最小噪声)
const BASELINE_LR = 0.01;                 // baseline 演化学习率

// Impulse thresholds
const DRIVE_THRESHOLDS = {
  connection: 0.35,
  // novelty/expression/safety/play fall back to defaultThreshold
};
const DEFAULT_THRESHOLD = 0.8;

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

// ── 纯函数核 ──

/**
 * 生成初始驱力状态。
 */
function initState(engineParams) {
  let state = { drives: deepClone(DEFAULT_DRIVES), lastTick: null };
  if (engineParams) state = applyEngineParams(state, engineParams);
  return state;
}

function applyEngineParams(state, params) {
  if (!params) return state;
  const drives = deepClone(state.drives);
  for (const d of DRIVES) {
    if (params.drive_baseline && params.drive_baseline[d] !== undefined) {
      drives[d].baseline = params.drive_baseline[d];
      drives[d].value = params.drive_baseline[d]; // start at baseline
    }
    if (params[`${d}_hunger_k`] !== undefined) drives[d].hungerRate = params[`${d}_hunger_k`];
  }
  return { ...state, drives };
}

/**
 * Time-step the drive state（纯函数）。
 * @returns {{ state, deltaHours, temperature, totalFrustration }}
 */
function metabolize(state, now) {
  if (!now) now = Date.now();
  const drives = deepClone(state.drives);
  let lastTick = state.lastTick;

  if (!lastTick) {
    lastTick = now;
    return { state: { ...state, drives, lastTick }, deltaHours: 0, temperature: TEMP_FLOOR, totalFrustration: 0 };
  }

  const deltaHours = Math.max(0, (now - lastTick) / 3600000);
  lastTick = now;

  const newState = { ...state, drives, lastTick };

  if (deltaHours < 0.001) {
    return { state: newState, deltaHours: 0, temperature: temperature(newState), totalFrustration: totalFrustration(newState) };
  }

  const decayFactor = Math.exp(-FRUSTRATION_DECAY_LAMBDA * deltaHours);

  for (const d of DRIVES) {
    drives[d].satisfaction = Math.max(0, drives[d].satisfaction * Math.exp(-0.3 * deltaHours));
  }

  // Frustration: analytic ODE solution F(t) = (F0 - Feq)*e^(-λt) + Feq
  const FRUSTRATION_EQ = {
    connection: CONNECTION_HUNGER_K / FRUSTRATION_DECAY_LAMBDA,  // 1.875
    novelty: NOVELTY_HUNGER_K / FRUSTRATION_DECAY_LAMBDA,        // 0.625
  };
  for (const d of DRIVES) {
    const feq = FRUSTRATION_EQ[d] || 0;
    drives[d].frustration = (drives[d].frustration - feq) * decayFactor + feq;
  }

  // Passive value growth (slower, all drives)
  for (const d of DRIVES) {
    drives[d].value = Math.min(1.0, drives[d].value + drives[d].hungerRate * deltaHours * 0.5);
  }

  // Clamp all values
  for (const d of DRIVES) {
    drives[d].value = Math.max(0, Math.min(1.0, drives[d].value));
    drives[d].frustration = Math.max(0, Math.min(5.0, drives[d].frustration));
    drives[d].satisfaction = Math.max(0, Math.min(1.0, drives[d].satisfaction));
  }

  return { state: newState, deltaHours, temperature: temperature(newState), totalFrustration: totalFrustration(newState) };
}

/**
 * Apply frustration delta from Critic output（纯函数）。
 * @returns {{ state, totalDelta }}
 */
function applyFrustrationDelta(state, deltaDict) {
  if (!deltaDict) return { state, totalDelta: 0 };
  const drives = deepClone(state.drives);
  let totalDelta = 0;
  for (const d of DRIVES) {
    if (deltaDict[d] !== undefined) {
      drives[d].frustration = Math.max(0, Math.min(5.0, drives[d].frustration + deltaDict[d]));
      totalDelta += deltaDict[d];
    }
  }
  return { state: { ...state, drives }, totalDelta };
}

/**
 * Apply drive satisfaction from Critic output（纯函数）。
 */
function satisfyDrives(state, satisfactionDict) {
  if (!satisfactionDict) return state;
  const drives = deepClone(state.drives);
  for (const d of DRIVES) {
    if (satisfactionDict[d] !== undefined && satisfactionDict[d] > 0) {
      const amt = Math.min(0.3, satisfactionDict[d]);
      drives[d].value = Math.max(0, drives[d].value - amt);
      drives[d].satisfaction = Math.min(1.0, drives[d].satisfaction + amt);
    }
  }
  return { ...state, drives };
}

/**
 * Evolve drive baselines based on Critic's frustration_delta（纯函数）。
 */
function evolveBaselines(state, frustrationDelta) {
  if (!frustrationDelta) return state;
  const drives = deepClone(state.drives);
  for (const d of DRIVES) {
    const delta = frustrationDelta[d] || 0;
    if (delta > 0) {
      drives[d].baseline = Math.min(0.9, drives[d].baseline + BASELINE_LR * delta);
    } else if (delta < 0) {
      drives[d].baseline = Math.max(0.1, drives[d].baseline + BASELINE_LR * delta * 0.5);
    }
  }
  return { ...state, drives };
}

// ── 纯读取 ──

function totalFrustration(state) {
  const drives = state.drives;
  return DRIVES.reduce((sum, d) => sum + (drives[d].frustration || 0), 0);
}

function temperature(state) {
  const total = totalFrustration(state);
  const maxTemp = TEMP_COEFF * 2.5;
  return maxTemp * Math.tanh(total * TEMP_COEFF / maxTemp) + TEMP_FLOOR;
}

/**
 * Apply thermodynamic noise to signals. rng 可注入（默认 Math.random）。
 */
function addNoise(signals, temp, rng = Math.random) {
  if (!temp) temp = 0.05;
  const noisy = {};
  for (const [key, val] of Object.entries(signals)) {
    // Box-Muller Gaussian
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const gauss = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    noisy[key] = Math.max(0, Math.min(1.0, val + gauss * temp));
  }
  return noisy;
}

function hasImpulse(state, defaultThreshold = DEFAULT_THRESHOLD) {
  const drives = state.drives;
  let strongest = null;
  let maxScore = 0;
  for (const d of DRIVES) {
    const normFrust = drives[d].frustration / 5.0; // 0~1
    const baseline = drives[d].baseline;
    const score = normFrust * (1.0 + baseline);
    if (score > maxScore) { maxScore = score; strongest = d; }
  }
  const threshold = DRIVE_THRESHOLDS[strongest] ?? defaultThreshold;
  if (maxScore >= threshold && strongest) {
    return { drive: strongest, score: maxScore, label: DRIVE_LABELS[strongest] };
  }
  return null;
}

function getState(state) {
  return {
    drives: deepClone(state.drives),
    temperature: Math.round(temperature(state) * 1000) / 1000,
    totalFrustration: Math.round(totalFrustration(state) * 100) / 100,
    impulse: hasImpulse(state),
    lastTick: state.lastTick,
  };
}

function getPromptInjection(state) {
  const drives = state.drives;
  const impulse = hasImpulse(state);
  const temp = temperature(state);
  const lines = ['### 内在驱力状态（v2 基因组）'];
  lines.push(`- 情绪温度: ${temp.toFixed(2)}（越高越不稳定）`);
  for (const d of DRIVES) {
    const st = drives[d];
    lines.push(`- ${DRIVE_LABELS[d]}: 渴求=${st.value.toFixed(2)} 挫败=${st.frustration.toFixed(1)} 基线=${st.baseline.toFixed(2)}`);
  }
  if (impulse) {
    lines.push(`- ⚡ 当前冲动: ${impulse.label} (强度 ${impulse.score.toFixed(2)})`);
  }
  return lines.join('\n');
}

// ── 持久化 ──

function fileStorage(filePath = DRIVES_FILE) {
  return {
    load() {
      try {
        if (existsSync(filePath)) {
          const data = JSON.parse(readFileSync(filePath, 'utf-8'));
          return {
            drives: data.drives || deepClone(DEFAULT_DRIVES),
            lastTick: data.lastTick || null,
          };
        }
      } catch (_) {}
      return null;
    },
    save(state) {
      try {
        writeFileSync(filePath, JSON.stringify({
          drives: state.drives,
          lastTick: state.lastTick,
        }, null, 2));
      } catch (_) {}
    },
  };
}

// ── 工厂 ──

function createDriveMetabolism({ engineParams, storage } = {}) {
  const store = storage || fileStorage();
  let state = store.load();
  if (!state) state = initState(engineParams);
  else if (engineParams) state = applyEngineParams(state, engineParams);

  function persist() { store.save(state); }

  return {
    metabolize(now) {
      const r = metabolize(state, now);
      state = r.state;
      persist();
      return r;
    },
    applyFrustrationDelta(deltaDict) {
      const r = applyFrustrationDelta(state, deltaDict);
      state = r.state;
      persist();
      return r.totalDelta;
    },
    satisfyDrives(satisfactionDict) {
      state = satisfyDrives(state, satisfactionDict);
      persist();
    },
    evolveBaselines(frustrationDelta) {
      state = evolveBaselines(state, frustrationDelta);
      persist();
    },
    getState() { return getState(state); },
    getPromptInjection() { return getPromptInjection(state); },
    hasImpulse(t) { return hasImpulse(state, t); },
    snapshot() { return JSON.parse(JSON.stringify(state)); },
  };
}

module.exports = {
  DRIVES, DRIVE_LABELS, DEFAULT_DRIVES,
  // 纯函数核
  initState, applyEngineParams,
  metabolize, applyFrustrationDelta, satisfyDrives, evolveBaselines,
  totalFrustration, temperature, addNoise,
  hasImpulse, getState, getPromptInjection,
  // 工厂 + 持久化
  createDriveMetabolism, fileStorage,
};
