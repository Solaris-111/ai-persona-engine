/**
 * Context Referencer v2.1 — 话题线程追踪。
 *
 * 纯函数核：state { turns, activeThread }，时钟注入（now 参数）。
 */

const MAX_TURNS = 20;
const CONTINUATION_BOOST = 2.5;
const CONTINUATION_SCORE_THRESHOLD = 0.50;
const THREAD_EXPIRY_MS = 30 * 60 * 1000;

function initState() {
  return { turns: [], activeThread: null };
}

function addTurn(state, role, text, topicId = null, now = Date.now()) {
  const turn = {
    role,
    text: text.slice(0, 200),
    topicId,
    timestamp: now,
  };
  let turns = (state.turns || []).slice();
  turns.push(turn);
  if (turns.length > MAX_TURNS) turns = turns.slice(-MAX_TURNS);

  let activeThread = state.activeThread;
  if (topicId) {
    if (!activeThread || activeThread.topicId !== topicId) {
      activeThread = {
        topicId,
        startedAt: turn.timestamp,
        lastMentionedAt: turn.timestamp,
        turnCount: 1,
      };
    } else {
      activeThread = {
        ...activeThread,
        lastMentionedAt: turn.timestamp,
        turnCount: activeThread.turnCount + 1,
      };
    }
  }

  return { turns, activeThread };
}

function setActiveThreadScore(state, score) {
  if (!state.activeThread) return state;
  return { ...state, activeThread: { ...state.activeThread, lastScore: score } };
}

function getActiveThread(state, now = Date.now()) {
  if (!state.activeThread) return null;
  // Thread expires after 30 minutes of no mention
  if (now - state.activeThread.lastMentionedAt > THREAD_EXPIRY_MS) {
    return null;
  }
  return state.activeThread;
}

function shouldContinueThread(state, newTopicId, now = Date.now()) {
  const thread = getActiveThread(state, now);
  if (!thread) return false;
  if (thread.topicId === newTopicId) return false; // already continuing
  // Continue if last interaction was good and thread is recent
  const lastScore = thread.lastScore;
  if (lastScore !== undefined && lastScore >= CONTINUATION_SCORE_THRESHOLD) {
    return thread.turnCount >= 1 && thread.turnCount <= 5; // Don't over-stay
  }
  return false;
}

function buildContinuityHint(state, now = Date.now()) {
  const thread = getActiveThread(state, now);
  if (!thread) return '';
  return `你在和对方聊 ${thread.topicId} 相关的话题（第${thread.turnCount}轮）。接着聊，不要突然切到别的话题。但自然地推进，不要原地打转。`;
}

function getRecentTopics(state, n = 5) {
  const seen = new Set();
  const topics = [];
  for (let i = state.turns.length - 1; i >= 0 && topics.length < n; i--) {
    const t = state.turns[i];
    if (t.topicId && !seen.has(t.topicId)) {
      seen.add(t.topicId);
      topics.push({ topicId: t.topicId, lastAt: t.timestamp });
    }
  }
  return topics;
}

function getLastUserMessage(state) {
  for (let i = state.turns.length - 1; i >= 0; i--) {
    if (state.turns[i].role === 'user') return state.turns[i];
  }
  return null;
}

function getState(state, now = Date.now()) {
  return {
    activeThread: getActiveThread(state, now),
    recentTopics: getRecentTopics(state, 3),
    turnCount: state.turns.length,
  };
}

// ── 工厂 ──

function createContextReferencer({ now = Date.now } = {}) {
  let state = initState();

  return {
    addTurn(role, text, topicId) {
      state = addTurn(state, role, text, topicId, now());
      return state;
    },
    setActiveThreadScore(score) { state = setActiveThreadScore(state, score); },
    getActiveThread() { return getActiveThread(state, now()); },
    shouldContinueThread(newTopicId) { return shouldContinueThread(state, newTopicId, now()); },
    buildContinuityHint() { return buildContinuityHint(state, now()); },
    getRecentTopics(n) { return getRecentTopics(state, n); },
    getLastUserMessage() { return getLastUserMessage(state); },
    getState() { return getState(state, now()); },
    snapshot() { return JSON.parse(JSON.stringify(state)); },
  };
}

module.exports = {
  MAX_TURNS, CONTINUATION_BOOST, CONTINUATION_SCORE_THRESHOLD,
  initState, addTurn, setActiveThreadScore, getActiveThread,
  shouldContinueThread, buildContinuityHint,
  getRecentTopics, getLastUserMessage, getState,
  createContextReferencer,
};
