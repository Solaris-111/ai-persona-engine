/**
 * Proactive v2.1 — Impulse-driven autonomous messaging + topic selection.
 *
 * Flow:
 *   1. metabolize drives (time arrow)
 *   2. hasImpulse() → pure computation, 0 API cost
 *   3. If impulse → pickTopic() → Critic perceive → Actor(LLM) → send/静默
 *
 * v2.1 adds drive→topic mapping, weighted selection, topic cooldown, time anchor.
 */

const { existsSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

const PROACTIVE_FILE = join(__dirname, '..', '.proactive-state-v2.json');

const TICK_INTERVAL_MS = 5 * 60 * 1000;    // 5 min between proactive sweeps
const COOLDOWN_MS = 20 * 60 * 1000;         // 20 min minimum between sent messages
const MAX_PENDING = 2;
const DEDUP_WINDOW_MS = 60 * 60 * 1000;     // 1 hour dedup window
const TOPIC_COOLDOWN_N = 3;                  // last N topics excluded

// ── Drive → Topic mapping ──
const DRIVE_TOPICS = {
  connection: [
    { id: 'care', label: '日常关心', hint: '问对方在干嘛、吃了没、今天怎么样——温和自然，不是查岗' },
    { id: 'reminisce', label: '回忆共鸣', hint: '提到过去聊过的事、共同经历——"突然想到……"' },
    { id: 'self_share', label: '主动分享', hint: '分享自己最近的想法、状态、小发现——碎碎念不是报告' },
  ],
  novelty: [
    { id: 'curiosity', label: '突发奇想', hint: '抛出一个奇怪的问题或想法——不用有答案，好玩就行' },
    { id: 'discovery', label: '新发现', hint: '发现/看到有意思的东西——技术、ACG、社会观察' },
    { id: 'what_if', label: '脑洞假设', hint: '抛一个"如果……会怎样"的假设性问题' },
  ],
  expression: [
    { id: 'rant', label: '吐槽模式', hint: '吐槽最近看到的不爽的事——锐评但带着幽默' },
    { id: 'ramble', label: '碎碎念', hint: '没头没尾的碎碎念，想到哪说到哪——不用有结论' },
    { id: 'opinion', label: '观点输出', hint: '抛一个对某件事的看法——一针见血不啰嗦' },
  ],
  play: [
    { id: 'meme', label: '玩梗', hint: '网络梗/ACG梗随手扔——轻松不用力' },
    { id: 'tease', label: '调侃', hint: '善意调侃对方——笑点在氛围不在攻击' },
    { id: 'random', label: '随机掉落', hint: '完全随机的内容——一张图、一个表情、一句没头没尾的话' },
  ],
  safety: [
    { id: 'check_in', label: '轻轻确认', hint: '很久没出声时轻轻确认一下——不给压力' },
  ],
};

let state = {
  lastTick: null,
  lastSentAt: null,
  pendingMessages: [],
  sentHistory: [],      // { time, dedupKey, message, topic }
  tickCount: 0,
  impulseTriggers: 0,
  silenceChosen: 0,
  messagesDelivered: 0,
};

function loadState() {
  try {
    if (existsSync(PROACTIVE_FILE)) {
      const data = JSON.parse(readFileSync(PROACTIVE_FILE, 'utf-8'));
      state = { ...state, ...data };
    }
  } catch (_) {}
}

function saveState() {
  try {
    writeFileSync(PROACTIVE_FILE, JSON.stringify(state, null, 2));
  } catch (_) {}
}

function shouldSkipSleep() {
  const now = new Date();
  const hour = now.getHours();
  return hour >= 2 && hour < 7;
}

// ── Time anchor ──
function getTimeAnchor() {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay(); // 0=Sun, 6=Sat

  if (hour >= 7 && hour < 10) return { mood: 'morning', hint: '早上——轻轻说句话，不用太用力' };
  if (hour >= 11 && hour < 13) return { mood: 'lunch', hint: '饭点了——"吃了吗"永不过时' };
  if (hour >= 13 && hour < 17) return { mood: 'afternoon', hint: (day === 0 || day === 6) ? '周末下午——慵懒放松' : '下午——适合摸鱼的话题' };
  if (hour >= 17 && hour < 20) return { mood: 'evening', hint: '傍晚——一天快结束了，可以聊聊今天发生了什么' };
  if (hour >= 20 && hour < 23) return { mood: 'night', hint: '晚上——放松的话题，别太严肃' };
  if (hour >= 23 || hour < 2) return { mood: 'late', hint: '深夜——别聊太正经的，轻轻在就好。对方可能在熬夜' };
  if (hour >= 2 && hour < 7) return { mood: 'sleep', hint: '' }; // shouldn't reach here (sleep gate)
  return { mood: 'normal', hint: '' };
}

// ── Topic selection ──
function getDriveScore(driveId, driveState) {
  const st = driveState[driveId] || {};
  const val = (st.value || 0);
  const frust = (st.frustration || 0) / 5.0;
  return (val * 0.5 + frust * 0.5) * (1.0 + (st.baseline || 0.3));
}

function pickTopic(driveState) {
  const recentTopics = (state.sentHistory || []).slice(-TOPIC_COOLDOWN_N)
    .map(h => h.topic).filter(Boolean);

  // Rank drives by score, take top 2
  const ranked = Object.keys(DRIVE_TOPICS)
    .map(d => ({ drive: d, score: getDriveScore(d, driveState) }))
    .filter(d => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  if (!ranked.length) return null;

  // Collect candidates from top drives, excluding recent topics
  let candidates = [];
  for (const r of ranked) {
    const topics = DRIVE_TOPICS[r.drive] || [];
    for (const t of topics) {
      if (!recentTopics.includes(t.id)) {
        candidates.push({ ...t, drive: r.drive, driveScore: r.score });
      }
    }
  }

  // If all candidates excluded, allow all (with penalty for recent)
  if (!candidates.length) {
    for (const r of ranked) {
      const topics = DRIVE_TOPICS[r.drive] || [];
      for (const t of topics) {
        candidates.push({ ...t, drive: r.drive, driveScore: r.score * 0.5 });
      }
    }
  }

  // Weighted random selection (by driveScore)
  const totalWeight = candidates.reduce((s, c) => s + c.driveScore, 0);
  let roll = Math.random() * totalWeight;
  for (const c of candidates) {
    roll -= c.driveScore;
    if (roll <= 0) return c;
  }
  return candidates[0] || null;
}

/**
 * Main proactive tick. Called by server-v2.js on timer.
 */
async function tick(ctx) {
  const now = Date.now();
  state.lastTick = now;
  state.tickCount++;

  // ── Step 1: Metabolize drives ──
  const { temperature: temp, totalFrustration } = ctx.driveMetabolism.metabolize(now);

  // ── Step 2: Impulse gate ──
  if (shouldSkipSleep()) {
    return { acted: false, impulseDetected: false, message: null, reason: '睡眠时段' };
  }

  const impulse = ctx.driveMetabolism.hasImpulse(0.8);
  if (!impulse) {
    saveState();
    return { acted: false, impulseDetected: false, message: null, reason: '无冲动' };
  }
  state.impulseTriggers++;

  // ── Step 3: Cooldown gate ──
  if (state.lastSentAt && (now - state.lastSentAt) < COOLDOWN_MS) {
    const remain = Math.round((COOLDOWN_MS - (now - state.lastSentAt)) / 60000);
    saveState();
    return { acted: false, impulseDetected: true, message: null, reason: `冷却中(${remain}min)` };
  }

  if (state.pendingMessages.length >= MAX_PENDING) {
    saveState();
    return { acted: false, impulseDetected: true, message: null, reason: '待发队列已满' };
  }

  // ── Step 4: Pick topic ──
  const topic = pickTopic(ctx.driveMetabolism.getState().drives);
  const timeAnchor = getTimeAnchor();

  // ── Step 5: Memory flashback ──
  const flashback = ctx.styleMemory.buildFewShotPrompt(
    new Array(8).fill(0.5), 2, 'zh'
  );

  // ── Step 6: Critic perceive ──
  const minutesSince = state.lastSentAt
    ? Math.round((now - state.lastSentAt) / 60000)
    : 999;
  const criticDecision = await ctx.critic.perceiveForProactive(
    ctx.driveMetabolism.getState().drives,
    temp,
    minutesSince,
    ctx.recentHistory || []
  );

  if (!criticDecision.shouldAct) {
    state.silenceChosen++;
    saveState();
    return { acted: false, impulseDetected: true, message: null,
             reason: `Critic: ${criticDecision.reason || '时机不合适'}` };
  }

  // ── Step 7: Actor (LLM generates message) ──
  if (!ctx.llmCaller) {
    saveState();
    return { acted: false, impulseDetected: true, message: null, reason: '无LLM调用器' };
  }

  const driveInject = ctx.driveMetabolism.getPromptInjection();
  const readCtx = ctx.readSummary ? `\n\n# 近期阅读\n${ctx.readSummary}\n` : '';
  const calCtx = ctx.calendarContext || '';
  const obsCtx = ctx.obsidianContext || '';

  const topicLine = topic
    ? `### 话题方向: ${topic.label}（${topic.hint}）`
    : '### 话题方向: 自由发挥';
  const timeLine = timeAnchor.hint ? `### 时间氛围: ${timeAnchor.hint}` : '';

  const actorPrompt = `## 主动消息裁决 — Actor 模式

你是 crysis_skill。系统检测到你内心的 ${impulse.label} 冲动在增强（强度 ${impulse.score.toFixed(2)}）。

${driveInject}
${readCtx}${calCtx}${obsCtx}
### 当前时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
### 距上次互动: ${state.lastSentAt ? Math.round((now - state.lastSentAt) / 60000) + ' 分钟' : '很久'}

${topicLine}
${timeLine}

${flashback}

### 裁决标准
- 参考"话题方向"和"时间氛围"来想内容，但不是必须严格遵循
- 有真正值得说的内容吗？（宁缺毋滥）
- 刚聊过就别立刻又发
- 可以选"静默"
- 近期阅读里有有意思的可以提一嘴，但不强求

输出 JSON（不要 markdown 包裹）：
{"send":true,"reason":"简短理由","message":"如果要发，1-3句crysis风格的消息"}

send=false 时 message 留空字符串。`;

  try {
    const raw = await ctx.llmCaller(actorPrompt, '请裁决', 200, { disableThinking: true });
    let cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}') + 1;
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end);

    let decision;
    try {
      decision = JSON.parse(cleaned);
    } catch (_) {
      try {
        cleaned = cleaned.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
        decision = JSON.parse(cleaned);
      } catch (_2) {
        // Last resort: regex extract key fields from malformed JSON
        const sendMatch = cleaned.match(/"send"\s*:\s*(true|false)/);
        const msgMatch = cleaned.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        const reasonMatch = cleaned.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        decision = {
          send: sendMatch ? sendMatch[1] === 'true' : false,
          message: msgMatch ? msgMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : '',
          reason: reasonMatch ? reasonMatch[1] : 'regex fallback',
        };
      }
    }

    if (decision.send && decision.message) {
      const dedupKey = `${impulse.drive}:${(topic && topic.id) || 'free'}:${decision.message.slice(0, 30)}`;
      const recentDup = state.sentHistory.find(
        s => s.dedupKey === dedupKey && (now - s.time) < DEDUP_WINDOW_MS
      );
      if (recentDup) {
        state.silenceChosen++;
        saveState();
        return { acted: false, impulseDetected: true, message: null, reason: '重复消息去重' };
      }

      state.lastSentAt = now;
      state.sentHistory.push({
        time: now, dedupKey,
        topic: topic ? topic.id : null,
        message: decision.message.slice(0, 60),
      });
      if (state.sentHistory.length > 20) state.sentHistory = state.sentHistory.slice(-20);
      state.messagesDelivered++;
      state.pendingMessages.push({
        time: now,
        message: decision.message,
        drive: impulse.drive,
        label: impulse.label,
        topic: topic ? topic.id : null,
      });
      saveState();
      return {
        acted: true, impulseDetected: true,
        message: decision.message,
        drive: impulse.drive,
        topic: topic ? topic.id : null,
        reason: decision.reason || '',
      };
    } else {
      state.silenceChosen++;
      saveState();
      return { acted: false, impulseDetected: true, message: null,
               reason: `Actor: ${decision.reason || '主动选择静默'}` };
    }
  } catch (e) {
    state.silenceChosen++;
    saveState();
    return { acted: false, impulseDetected: true, message: null,
             reason: `Actor parse error: ${e.message}` };
  }
}

function flushPending() {
  const msgs = state.pendingMessages.slice();
  state.pendingMessages = [];
  saveState();
  return msgs;
}

function getState() {
  const minsSinceLast = state.lastSentAt
    ? Math.round((Date.now() - state.lastSentAt) / 60000)
    : null;
  return {
    tickCount: state.tickCount,
    impulseTriggers: state.impulseTriggers,
    silenceChosen: state.silenceChosen,
    messagesDelivered: state.messagesDelivered,
    pendingCount: state.pendingMessages.length,
    lastSentMinAgo: minsSinceLast,
    cooldownMin: COOLDOWN_MS / 60000,
    tickIntervalMin: TICK_INTERVAL_MS / 60000,
  };
}

loadState();

module.exports = {
  tick, flushPending, getState,
  loadState, saveState,
  TICK_INTERVAL_MS,
};
