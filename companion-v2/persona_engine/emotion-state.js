/**
 * Emotion State v2.1 — 关系状态机（FORMAL/WARMING/TRUSTED/TENSE/RELIEF）。
 *
 * 重构为「函数式内核 + 命令式外壳」：processInteraction 变纯函数，
 * 状态转移规则（TRANSITIONS/TONE_MODIFIERS）不变。
 */

const { existsSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

const EMOTION_FILE = join(__dirname, '..', '.emotion-state.json');

const STATES = ['FORMAL', 'WARMING', 'TRUSTED', 'TENSE', 'RELIEF'];

// Number of consecutive interactions meeting threshold for each transition
const TRANSITIONS = {
  'FORMAL->WARMING':    { trigger: 'score_ok',     threshold: 3,  minScore: 0.55 },
  'WARMING->TRUSTED':   { trigger: 'score_ok',     threshold: 10, minScore: 0.55 },
  'ANY->TENSE':         { trigger: 'pushback',     threshold: 1,  minScore: 0 },
  'ANY->TENSE':         { trigger: 'low_scores',   threshold: 2,  maxScore: 0.40 },
  'TENSE->RELIEF':      { trigger: 'score_ok',     threshold: 2,  minScore: 0.60 },
  'RELIEF->WARMING':    { trigger: 'no_pushback',  threshold: 3,  minScore: 0 },
};

const TONE_MODIFIERS = {
  FORMAL:   { formality: 0.8, warmth: 0.3, caution: 0.6, hint: '礼貌但有点生疏。短句为主。不太用梗。' },
  WARMING:  { formality: 0.5, warmth: 0.6, caution: 0.3, hint: '开始放松了。可以接梗，偶尔吐槽。语气自然像跟朋友说话。' },
  TRUSTED:  { formality: 0.2, warmth: 0.9, caution: 0.1, hint: '有自己节奏。敢开玩笑。主动分享变多。可以直接说"我今天xxx"，不用等对方问。' },
  TENSE:    { formality: 0.6, warmth: 0.2, caution: 0.8, hint: '有点紧张。收着点，观察对方态度。不要强行搞笑。简短礼貌，给对方空间。' },
  RELIEF:   { formality: 0.4, warmth: 0.7, caution: 0.4, hint: '松了一口气。轻松但有记忆。可以说"刚才xxx，还好现在xxx"。自然过渡回正常节奏。' },
};

// ── 纯函数核 ──

function initState(current = 'FORMAL') {
  return {
    current,
    streakGood: 0,
    streakBad: 0,
    streakNoPushback: 0,
    totalInteractions: 0,
    history: [],
  };
}

/**
 * Process an interaction（纯函数）。状态转移逻辑不变。
 * @param {object} state
 * @param {object} scoreResult { score, pushbackDetected }
 * @param {Date} now - 时间注入（默认 new Date）
 * @returns {{ state, transitioned }}
 */
function processInteraction(state, scoreResult, now = new Date()) {
  const { score, pushbackDetected } = scoreResult;
  let current = state.current;
  let streakGood = state.streakGood;
  let streakBad = state.streakBad;
  let streakNoPushback = state.streakNoPushback;
  let totalInteractions = state.totalInteractions + 1;
  let transitioned = null;

  if (pushbackDetected) {
    streakGood = 0;
    streakNoPushback = 0;
    streakBad++;
    if (current !== 'TENSE') {
      current = 'TENSE';
      transitioned = 'pushback → TENSE';
    }
  } else if (score >= 0.55) {
    streakGood++;
    streakBad = 0;
    streakNoPushback++;
  } else if (score < 0.40) {
    streakGood = 0;
    streakNoPushback = 0;
    streakBad++;
    if (streakBad >= 2 && current !== 'TENSE' && current !== 'RELIEF') {
      current = 'TENSE';
      transitioned = 'low scores → TENSE';
    }
  } else {
    streakNoPushback = 0;
  }

  // State transitions
  if (current === 'FORMAL' && streakGood >= 3) {
    current = 'WARMING';
    transitioned = 'FORMAL → WARMING';
  }
  if (current === 'WARMING' && streakGood >= 10) {
    current = 'TRUSTED';
    transitioned = 'WARMING → TRUSTED';
  }
  if (current === 'TENSE' && streakGood >= 2) {
    current = 'RELIEF';
    transitioned = 'TENSE → RELIEF';
  }
  if (current === 'RELIEF' && streakNoPushback >= 3) {
    current = 'WARMING';
    transitioned = 'RELIEF → WARMING';
  }

  let history = state.history || [];
  history.push({
    time: now.toISOString(),
    score, pushbackDetected,
    newState: current,
    transitioned,
  });
  if (history.length > 50) history = history.slice(-50);

  return {
    state: { current, streakGood, streakBad, streakNoPushback, totalInteractions, history },
    transitioned,
  };
}

// ── 纯读取 ──

function getToneModifier(state) {
  const mod = TONE_MODIFIERS[state.current] || TONE_MODIFIERS.FORMAL;
  return { ...mod, state: state.current };
}

function getPromptInjection(state) {
  const mod = getToneModifier(state);
  return `### 回应的语气基调: ${mod.state}\n语气指引: ${mod.hint}`;
}

function getState(state) {
  return {
    current: state.current,
    streakGood: state.streakGood,
    streakBad: state.streakBad,
    streakNoPushback: state.streakNoPushback,
    totalInteractions: state.totalInteractions,
    tone: getToneModifier(state),
  };
}

// ── 持久化 ──

function fileStorage(filePath = EMOTION_FILE) {
  return {
    load() {
      try {
        if (existsSync(filePath)) {
          const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
          const state = initState();
          if (STATES.includes(saved.current)) state.current = saved.current;
          if (typeof saved.streakGood === 'number') state.streakGood = saved.streakGood;
          if (typeof saved.streakBad === 'number') state.streakBad = saved.streakBad;
          if (typeof saved.streakNoPushback === 'number') state.streakNoPushback = saved.streakNoPushback;
          if (typeof saved.totalInteractions === 'number') state.totalInteractions = saved.totalInteractions;
          if (Array.isArray(saved.history)) state.history = saved.history;
          return state;
        }
      } catch (_) {}
      return null;
    },
    save(state) {
      try {
        writeFileSync(filePath, JSON.stringify(state, null, 2));
      } catch (_) {}
    },
  };
}

// ── 工厂 ──

function createEmotionState({ storage, clock = () => new Date() } = {}) {
  const store = storage || fileStorage();
  let state = store.load();
  if (!state) state = initState();

  const pureProcess = processInteraction;

  function persist() { store.save(state); }

  return {
    processInteraction(scoreResult) {
      const r = pureProcess(state, scoreResult, clock());
      state = r.state;
      persist();
      return { state: state.current, transitioned: r.transitioned };
    },
    getToneModifier() { return getToneModifier(state); },
    getPromptInjection() { return getPromptInjection(state); },
    getState() { return getState(state); },
    resetState(to = 'FORMAL') {
      state = initState(to);
      persist();
    },
    snapshot() { return JSON.parse(JSON.stringify(state)); },
  };
}

module.exports = {
  STATES, TRANSITIONS, TONE_MODIFIERS,
  // 纯函数核
  initState, processInteraction,
  getToneModifier, getPromptInjection, getState,
  // 工厂 + 持久化
  createEmotionState, fileStorage,
};
