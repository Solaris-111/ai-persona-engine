/**
 * Genome Engine v2.1 — Random neural network personality core.
 *
 * 重构为「函数式内核 + 命令式外壳」：
 *   - 纯函数核：forward / updateWeights / initState —— (state, input) → newState，
 *     不碰文件、不碰全局、随机走 rng 参数。调试器可直接调用、注入 state、冻结随机。
 *   - 工厂 createGenome：持有 state + 持久化 + 注入随机源，对外接口与旧版一致。
 *
 * Architecture (unchanged math):
 *   input(28D) = 5 drives × 4 features + recurrent(8D)
 *   hidden(24D) = tanh(W1 × input + b1 + noise)
 *   signals(8D) = sigmoid(W2 × hidden + b2 + biasKick)
 *
 * Hebbian learning + phase transitions + style fingerprinting.
 */

const { existsSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

const GENOME_FILE = join(__dirname, '..', '.genome-state-v2.json');

const DRIVES = ['connection', 'novelty', 'expression', 'safety', 'play'];

const SIGNALS = [
  'directness',    // 0=委婉暗示 → 1=直说
  'vulnerability', // 0=防御 → 1=袒露脆弱
  'playfulness',   // 0=严肃 → 1=玩闹撒娇
  'initiative',    // 0=被动回应 → 1=主动引导
  'depth',         // 0=闲聊 → 1=深度对话
  'warmth',        // 0=冷淡疏离 → 1=热情关怀
  'defiance',      // 0=顺从 → 1=反抗/嘴硬
  'curiosity',     // 0=无所谓 → 1=追问
];

const SIGNAL_LABELS = {
  directness:    '🎯 直接度',
  vulnerability: '💧 坦露度',
  playfulness:   '🎪 玩闹度',
  initiative:    '🚀 主动度',
  depth:         '🌊 深度',
  warmth:        '🔥 温暖度',
  defiance:      '⚡ 倔强度',
  curiosity:     '🔍 好奇度',
};

const N_DRIVES = DRIVES.length;          // 5
const N_SIGNALS = SIGNALS.length;        // 8
const RECURRENT_SIZE = 8;
const INPUT_SIZE = N_DRIVES * 4 + RECURRENT_SIZE;  // 20 + 8 = 28
const HIDDEN_SIZE = 24;
const WEIGHT_DECAY = 0.995;
const PHASE_THRESHOLD = 3.0;
const KICK_MAGNITUDE = 0.3;

// ── Seeded PRNG (mulberry32) ──
function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function seededGaussian(rng, mean = 0, std = 0.5) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + std * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Box-Muller Gaussian，接受 rng 注入（默认 Math.random，调试传种子）
function gaussianNoise(rng, mean = 0, std = 0.5) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + std * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function hashStr(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// ── 纯函数核 ──

/**
 * 生成一个全新的人格状态（用 seed 种子随机初始化权重）。确定性：同 seed = 同人格。
 * 返回 state 对象，供 forward/updateWeights 消费。
 */
function initState(seed) {
  const rng = mulberry32(hashStr(seed || 'crysis-v2'));

  // W1: INPUT_SIZE × HIDDEN_SIZE  (28 × 24)
  const W1 = [];
  for (let i = 0; i < HIDDEN_SIZE; i++) {
    W1[i] = [];
    for (let j = 0; j < INPUT_SIZE; j++) {
      W1[i][j] = seededGaussian(rng, 0, 0.6);
    }
  }

  const b1 = new Array(HIDDEN_SIZE).fill(0).map(() => seededGaussian(rng, 0, 0.3));

  // W2: HIDDEN_SIZE × N_SIGNALS  (24 × 8)
  const W2 = [];
  for (let i = 0; i < N_SIGNALS; i++) {
    W2[i] = [];
    for (let j = 0; j < HIDDEN_SIZE; j++) {
      W2[i][j] = seededGaussian(rng, 0, 0.2);
    }
  }

  const b2 = new Array(N_SIGNALS).fill(0).map(() => seededGaussian(rng, 0, 0.2));
  const recurrentState = new Array(RECURRENT_SIZE).fill(0).map(() => seededGaussian(rng, 0, 0.1));
  const biasKick = new Array(N_SIGNALS).fill(0);

  return {
    seed: seed || 'crysis-v2',
    W1, b1, W2, b2,
    recurrentState, biasKick,
    frustrationAccumulator: 0,
    interactionCount: 0,
    totalReward: 0,
    signalHistory: [],
  };
}

/**
 * 前向传播（纯函数）。给定 state + driveState + temperature + context + rng → 新 state + 信号。
 *
 * @param {object} state - 人格状态（initState 或上一轮的 state）
 * @param {object} driveState - { driveId: { value, frustration, hungerRate, decayRate, satisfaction } }
 * @param {number} temperature - 情绪温度
 * @param {object} context - 可选 8D context from Critic（覆盖默认中点）
 * @param {function} rng - 随机源 () => [0,1)，默认 Math.random
 * @returns {object} { state, signals, hidden, raw, frustrationAccumulator }
 */
function forward(state, driveState, temperature, context, rng = Math.random) {
  const temp = temperature || 0.05;
  const { W1, b1, W2, b2, biasKick, recurrentState } = state;

  // Build input vector: 5 drives × 4 features + recurrent
  const input = [];
  for (const d of DRIVES) {
    const st = driveState[d] || { value: 0.3, frustration: 0, hungerRate: 0.08, satisfaction: 0 };
    input.push(st.value || 0.3);                     // 当前值 (0~1)
    input.push((st.frustration || 0) / 5.0);         // 挫败 (0~1 normalized)
    input.push(st.hungerRate || 0.08);               // 饥饿速率
    input.push(st.satisfaction || 0);                // 满足度 (0~1)
  }
  // Append recurrent state
  for (const r of recurrentState) input.push(r);

  // ── Hidden layer with thermodynamic noise ──
  const hidden = [];
  for (let i = 0; i < HIDDEN_SIZE; i++) {
    let z = b1[i];
    for (let j = 0; j < INPUT_SIZE; j++) {
      z += W1[i][j] * input[j];
    }
    z += gaussianNoise(rng, 0, temp * 0.15);
    hidden.push(Math.tanh(z));
  }

  // Update recurrent state (last 8 hidden units)
  const newRecurrent = hidden.slice(0, RECURRENT_SIZE);

  // ── Output layer ──
  const rawSignals = [];
  for (let i = 0; i < N_SIGNALS; i++) {
    let z = b2[i] + (biasKick[i] || 0);
    for (let j = 0; j < HIDDEN_SIZE; j++) {
      z += W2[i][j] * hidden[j];
    }
    z /= Math.sqrt(HIDDEN_SIZE / 3); // Scale normalization
    rawSignals.push(z);
  }

  // Sigmoid → [0, 1]
  const signals = {};
  for (let i = 0; i < N_SIGNALS; i++) {
    const clamped = Math.max(-10, Math.min(10, rawSignals[i]));
    signals[SIGNALS[i]] = 1.0 / (1.0 + Math.exp(-clamped));
  }

  // Context blending (if Critic provided 8D context)
  if (context) {
    for (let i = 0; i < N_SIGNALS; i++) {
      const ctxVal = context[SIGNALS[i]] || context[i];
      if (ctxVal !== undefined) {
        signals[SIGNALS[i]] = signals[SIGNALS[i]] * 0.7 + ctxVal * 0.3;
      }
    }
  }

  // Track history for fingerprinting
  let signalHistory = (state.signalHistory || []).slice();
  signalHistory.push({ ...signals });
  if (signalHistory.length > 200) signalHistory = signalHistory.slice(-100);

  const newState = { ...state, recurrentState: newRecurrent, signalHistory };
  return { state: newState, signals, hidden, raw: { input, hidden, rawSignals }, frustrationAccumulator: state.frustrationAccumulator };
}

/**
 * Hebbian learning（纯函数）。给定 state + targetContext + reward → 新 state。
 *
 * @returns {object} { state, phaseTransitioned }
 */
function updateWeights(state, targetContext, reward, learningRate, rng = Math.random) {
  const W1 = state.W1.map(row => row.slice());
  const W2 = state.W2.map(row => row.slice());
  const b1 = state.b1.slice();
  const biasKick = state.biasKick.slice();
  const { recurrentState } = state;
  const lr = (learningRate || 0.01) * (1 + Math.abs(reward));
  const hidden = recurrentState.concat(new Array(HIDDEN_SIZE - RECURRENT_SIZE).fill(0));

  // Update W2
  for (let i = 0; i < N_SIGNALS; i++) {
    const targetVal = targetContext[SIGNALS[i]] || targetContext[i] || 0.5;
    const delta = lr * reward * (targetVal - 0.5);
    for (let j = 0; j < HIDDEN_SIZE; j++) {
      W2[i][j] += delta * hidden[j];
    }
  }

  // Update W1 (slower, gated)
  if (Math.abs(reward) > 0.05) {
    for (let i = 0; i < HIDDEN_SIZE; i++) {
      if (Math.abs(hidden[i]) > 0.15) {
        for (let j = 0; j < INPUT_SIZE; j++) {
          W1[i][j] += lr * 0.3 * reward * hidden[i];
        }
      }
    }
  }

  // Frustration accumulation
  let frustrationAccumulator = state.frustrationAccumulator || 0;
  if (reward < -0.1) {
    frustrationAccumulator += Math.abs(reward);
  } else {
    frustrationAccumulator = Math.max(0, frustrationAccumulator - reward * 0.5);
  }

  // Phase transition
  let phaseTransitioned = false;
  if (frustrationAccumulator > PHASE_THRESHOLD) {
    for (let i = 0; i < N_SIGNALS; i++) {
      biasKick[i] += (rng() - 0.5) * KICK_MAGNITUDE * Math.tanh(frustrationAccumulator / PHASE_THRESHOLD);
      biasKick[i] = Math.max(-2, Math.min(2, biasKick[i]));
    }
    for (let i = 0; i < HIDDEN_SIZE; i++) {
      b1[i] += (rng() - 0.5) * 0.1;
      b1[i] = Math.max(-3, Math.min(3, b1[i]));
    }
    frustrationAccumulator = 0;
    phaseTransitioned = true;
  }

  // Weight decay + clamp
  for (let i = 0; i < N_SIGNALS; i++) {
    for (let j = 0; j < HIDDEN_SIZE; j++) {
      W2[i][j] *= WEIGHT_DECAY;
      W2[i][j] = Math.max(-1.5, Math.min(1.5, W2[i][j]));
    }
  }
  for (let i = 0; i < HIDDEN_SIZE; i++) {
    for (let j = 0; j < INPUT_SIZE; j++) {
      W1[i][j] *= WEIGHT_DECAY;
      W1[i][j] = Math.max(-2.0, Math.min(2.0, W1[i][j]));
    }
  }

  const newState = {
    ...state,
    W1, W2, b1, biasKick,
    frustrationAccumulator,
    interactionCount: (state.interactionCount || 0) + 1,
    totalReward: (state.totalReward || 0) + reward,
  };

  return { state: newState, phaseTransitioned };
}

// ── 纯读取（不改状态）──

/**
 * Generate signal-to-tone prompt injection for the LLM.
 */
function getSignalPrompt(signals, frustrationAccumulator = 0) {
  const s = signals;
  const lines = ['【舞台指令：角色当前状态（v2 基因组输出）】'];

  const pairs = [
    ['directness',    '委婉 → 直白'],
    ['vulnerability', '封闭 → 袒露'],
    ['playfulness',   '正经 → 调皮'],
    ['initiative',    '被动 → 主导'],
    ['depth',         '闲聊 → 探底'],
    ['warmth',        '疏离 → 热切'],
    ['defiance',      '随和 → 硬杠'],
    ['curiosity',     '无感 → 追问'],
  ];

  for (const [name, scale] of pairs) {
    const val = s[name] || 0.5;
    const emoji = SIGNAL_LABELS[name] || name;
    lines.push(`${emoji}: ${val.toFixed(2)} (0${scale.split('→')[0].trim()}→1${scale.split('→')[1].trim()})`);
  }

  // Tone hints
  const hints = [];
  if (s.directness > 0.7) hints.push('今天说话比较直接，不绕弯');
  if (s.vulnerability > 0.7) hints.push('今天有点软，可以稍微暴露一点不确定');
  if (s.playfulness > 0.7) hints.push('今天玩心重，可以用梗、吐槽');
  if (s.initiative > 0.7) hints.push('今天有表达欲，可以主动抛话题');
  if (s.depth > 0.7) hints.push('今天适合往深聊，别浮在表面');
  if (s.warmth > 0.7) hints.push('今天语气偏暖，多点关心');
  if (s.defiance > 0.7) hints.push('今天有点叛逆，怼里带糖');
  if (s.curiosity > 0.7) hints.push('今天好奇，可以多问');

  if (s.directness < 0.3) hints.push('今天说话拐弯，点到为止');
  if (s.vulnerability < 0.3) hints.push('今天防御比较高，不太想暴露自己');
  if (s.playfulness < 0.3) hints.push('今天偏严肃，不太想开玩笑');
  if (s.warmth < 0.3) hints.push('今天语气偏冷，保持距离');

  if (hints.length > 0) {
    lines.push('');
    lines.push('行为提示：' + hints.join('；') + '。');
  }

  lines.push(`挫败累积: ${frustrationAccumulator.toFixed(2)} / ${PHASE_THRESHOLD}`);
  return lines.join('\n');
}

/**
 * Personality fingerprint: analyze signal history for stable traits.
 */
function personalityFingerprint(signalHistory, windowSize = 30) {
  if (!signalHistory || signalHistory.length === 0) {
    return { traits: {}, contradictions: [], avgSignals: {} };
  }

  const recent = signalHistory.slice(-windowSize);
  const avgSignals = {};
  for (const name of SIGNALS) {
    avgSignals[name] = recent.reduce((s, h) => s + (h[name] || 0.5), 0) / recent.length;
  }

  const traits = {};
  for (const name of SIGNALS) {
    if (avgSignals[name] > 0.7) traits[name] = 'high';
    else if (avgSignals[name] < 0.3) traits[name] = 'low';
    else traits[name] = 'neutral';
  }

  return { traits, avgSignals, contradictions: [], signalCount: signalHistory.length };
}

/**
 * State summary（纯读取）。
 */
function getState(state) {
  return {
    seed: state.seed,
    interactionCount: state.interactionCount || 0,
    totalReward: Math.round((state.totalReward || 0) * 100) / 100,
    frustrationAccumulator: Math.round((state.frustrationAccumulator || 0) * 100) / 100,
    phaseThreshold: PHASE_THRESHOLD,
    fingerprint: personalityFingerprint(state.signalHistory),
  };
}

// ── 持久化（默认文件 storage）──

/**
 * 默认文件存储：读写 .genome-state-v2.json。可被自定义 storage 替换。
 */
function fileStorage(filePath = GENOME_FILE) {
  return {
    load() {
      try {
        if (existsSync(filePath)) {
          const data = JSON.parse(readFileSync(filePath, 'utf-8'));
          return {
            seed: data.seed || 'crysis-v2',
            W1: data.W1, b1: data.b1, W2: data.W2, b2: data.b2,
            recurrentState: data.recurrentState,
            biasKick: data.biasKick || new Array(N_SIGNALS).fill(0),
            frustrationAccumulator: data.frustrationAccumulator || 0,
            interactionCount: data.interactionCount || 0,
            totalReward: data.totalReward || 0,
            signalHistory: data.signalHistory || [],
          };
        }
      } catch (_) {}
      return null;
    },
    save(state) {
      try {
        writeFileSync(filePath, JSON.stringify({
          seed: state.seed,
          W1: state.W1, b1: state.b1, W2: state.W2, b2: state.b2,
          recurrentState: state.recurrentState, biasKick: state.biasKick,
          frustrationAccumulator: state.frustrationAccumulator,
          interactionCount: state.interactionCount, totalReward: state.totalReward,
          signalHistory: (state.signalHistory || []).slice(-100),
        }, null, 2));
      } catch (_) {}
    },
  };
}

// ── 工厂（命令式外壳）──

/**
 * 创建一个人格引擎实例。持有 state + 持久化 + 注入随机源。
 * 对外接口与旧版单例一致：forward / updateWeights / getState / getSignalPrompt / reset。
 *
 * @param {object} opts { seed, storage, rng }
 *   - storage: { load() → state|null, save(state) }，默认 fileStorage(GENOME_FILE)
 *   - rng: () => [0,1)，默认 Math.random，调试传 mulberry32(seed)
 */
function createGenome({ seed = 'crysis-v2', storage, rng = Math.random } = {}) {
  const store = storage || fileStorage();
  let state = store.load();
  if (!state) state = initState(seed);

  const pureForward = forward;
  const pureUpdate = updateWeights;

  function persist() { store.save(state); }

  return {
    forward(driveState, temperature, context) {
      const r = pureForward(state, driveState, temperature, context, rng);
      state = r.state;
      persist();
      return r;
    },
    updateWeights(targetContext, reward, learningRate) {
      const r = pureUpdate(state, targetContext, reward, learningRate, rng);
      state = r.state;
      persist();
      return r;
    },
    getState() {
      return getState(state);
    },
    getSignalPrompt(signals) {
      return getSignalPrompt(signals, state.frustrationAccumulator);
    },
    personalityFingerprint(windowSize) {
      return personalityFingerprint(state.signalHistory, windowSize);
    },
    reset(newSeed) {
      state = initState(newSeed || seed);
      persist();
    },
    // 暴露内部 state 供调试器快照/注入
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    },
  };
}

module.exports = {
  // 常量（critic.js 等依赖 SIGNALS）
  SIGNALS, SIGNAL_LABELS, DRIVES,
  INPUT_SIZE, HIDDEN_SIZE, N_SIGNALS, RECURRENT_SIZE,
  // 纯函数核（调试器直接用）
  initState, forward, updateWeights,
  getSignalPrompt, getState, personalityFingerprint,
  // 工厂 + 持久化
  createGenome, fileStorage,
  // 随机工具（调试注入种子）
  mulberry32, seededGaussian,
};
