/**
 * Critic v2.0 — LLM-based context perception engine.
 *
 * Replaces v1.0's hardcoded DRIVE_TOPIC_MAP with LLM-powered analysis.
 * Each user message → Critic → 8D context + 5D frustration_delta +
 * 5D drive_satisfaction + engagement_score.
 *
 * Also provides perceiveForProactive() for impulse-driven proactive ticks.
 */

const { SIGNALS } = require('../persona_engine/genome_engine');
const { DRIVES } = require('../persona_engine/drive_metabolism');

// Default fallback when Critic LLM fails
const DEFAULT_CONTEXT = {
  directness: 0.5, vulnerability: 0.5, playfulness: 0.5, initiative: 0.5,
  depth: 0.5, warmth: 0.5, defiance: 0.5, curiosity: 0.5,
};
const DEFAULT_DELTA = { connection: 0, novelty: 0, expression: 0, safety: 0, play: 0 };
const DEFAULT_SATISFACTION = { connection: 0, novelty: 0, expression: 0, safety: 0, play: 0 };

let llmCaller = null;

function init(caller) {
  llmCaller = caller;
}

/**
 * Analyze user message → 8D context + frustration deltas + drive satisfaction.
 *
 * @param {string} userMessage
 * @param {object} driveState - current drive values and frustrations
 * @param {number} temperature - emotional temperature
 * @param {object[]} recentHistory - last N turns [{role, text}]
 * @returns {object} { context, frustrationDelta, driveSatisfaction, engagementScore, topicCategory, toneHint }
 */
async function analyze(userMessage, driveState, temperature, recentHistory) {
  if (!llmCaller) {
    return { context: { ...DEFAULT_CONTEXT }, frustrationDelta: { ...DEFAULT_DELTA },
             driveSatisfaction: { ...DEFAULT_SATISFACTION }, engagementScore: 0.5,
             topicCategory: 'general', toneHint: '' };
  }

  const frustSummary = DRIVES.map(d => {
    const st = driveState[d] || {};
    return `${d}: 渴求=${(st.value||0).toFixed(2)} 挫败=${(st.frustration||0).toFixed(1)} 基线=${(st.baseline||0.2).toFixed(2)}`;
  }).join('\n');

  const historyText = (recentHistory || []).slice(-6)
    .map(h => `${h.role === 'user' ? '用户' : 'crysis'}: ${(h.text||'').slice(0,100)}`)
    .join('\n');

  const systemPrompt = `你是一个角色扮演 Agent 的情感感知器（Critic）。分析用户输入，输出五组数据：

1. 8维行为上下文（0.0~1.0）：
  - directness: 用户说话的直接程度（0=委婉暗示, 1=直白坦率）
  - vulnerability: 用户暴露脆弱的程度（0=防御, 1=敞开心扉）
  - playfulness: 用户玩闹程度（0=严肃, 1=玩闹撒娇）
  - initiative: 用户主动程度（0=被动回应, 1=主动引导话题）
  - depth: 话题深度（0=表面闲聊, 1=深度对话）
  - warmth: 用户温暖程度（0=冷淡疏离, 1=热情关怀）
  - defiance: 用户对抗程度（0=顺从, 1=反抗/嘴硬）
  - curiosity: 用户好奇程度（0=无所谓, 1=追问探究）

2. Agent 5个驱力的挫败变化量（-1~1，正值=更挫败，负值=被缓解）：
  - connection: 用户冷落/疏远 → +挫败；用户主动亲近 → -挫败
  - novelty: 重复无聊话题 → +挫败；新信息/意外 → -挫败
  - expression: 被打断/被忽视 → +挫败；被倾听被理解 → -挫败
  - safety: 用户不安/冲突 → +挫败；和谐安全 → -挫败
  - play: 过于严肃/死板 → +挫败；轻松玩笑 → -挫败

3. Agent 5个驱力的需求满足量（0~0.3，这轮对话直接满足了哪些需求）：
  - connection: 用户主动分享/关心/倾诉 → 满足
  - novelty: 新话题/新观点/意外信息 → 满足
  - expression: Agent有机会说真心话 → 满足
  - safety: 无冲突/被接纳 → 满足
  - play: 玩笑/调侃互动 → 满足

4. engagement_score: 用户投入度（0=敷衍, 0.5=正常, 1=非常投入）

5. tone_hint: 简短的中文风格提示（如"轻松接话""认真回应""需要安抚""可以吐槽"）

### 当前驱力状态
${frustSummary}

### 情绪温度: ${temperature.toFixed(2)}

### 最近对话
${historyText || '（无）'}

无论用户说什么，只输出一个纯 JSON 对象：
{"context":{"directness":0.5,"vulnerability":0.3,"playfulness":0.6,"initiative":0.5,"depth":0.4,"warmth":0.6,"defiance":0.1,"curiosity":0.3},"frustration_delta":{"connection":-0.1,"novelty":0,"expression":-0.05,"safety":-0.1,"play":0.1},"drive_satisfaction":{"connection":0.1,"novelty":0.1,"expression":0.05,"safety":0.05,"play":0.15},"engagement_score":0.65,"tone_hint":"轻松接话"}`;

  try {
    const raw = await llmCaller(systemPrompt, userMessage, 300);
    // Parse JSON from response (robust against markdown wrapping)
    let cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, ''); // Strip Qwen thinking
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}') + 1;
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end);

    const data = JSON.parse(cleaned);

    return {
      context: { ...DEFAULT_CONTEXT, ...(data.context || {}) },
      frustrationDelta: { ...DEFAULT_DELTA, ...(data.frustration_delta || {}) },
      driveSatisfaction: { ...DEFAULT_SATISFACTION, ...(data.drive_satisfaction || {}) },
      engagementScore: data.engagement_score ?? 0.5,
      topicCategory: data.topic_category || 'general',
      toneHint: data.tone_hint || '',
    };
  } catch (e) {
    // Fallback: return defaults on parse failure
    return {
      context: { ...DEFAULT_CONTEXT },
      frustrationDelta: { ...DEFAULT_DELTA },
      driveSatisfaction: { ...DEFAULT_SATISFACTION },
      engagementScore: 0.5,
      topicCategory: 'general',
      toneHint: '',
      _error: e.message,
    };
  }
}

/**
 * Lightweight perception for proactive impulse.
 * Assesses whether the current moment is appropriate for initiating.
 */
async function perceiveForProactive(driveState, temperature, minutesSinceLastInteraction, recentHistory) {
  if (!llmCaller) return { shouldAct: true, reason: 'no Critic (default allow)', toneHint: '' };

  const frustSummary = DRIVES.map(d => {
    const st = driveState[d] || {};
    return `${d}: ${(st.frustration||0).toFixed(1)}/5.0 (基线${(st.baseline||0.2).toFixed(2)})`;
  }).join(', ');

  const historyText = (recentHistory || []).slice(-4)
    .map(h => `${h.role === 'user' ? '用户' : 'crysis'}: ${(h.text||'').slice(0,80)}`)
    .join('\n');

  const systemPrompt = `你是一个 AI 陪伴系统的冲动裁决模块。判断现在是否适合主动给用户发消息。

当前驱力挫败: ${frustSummary}
情绪温度: ${temperature.toFixed(2)}
距上次互动: ${minutesSinceLastInteraction} 分钟

最近对话:
${historyText || '（无）'}

裁决标准：
- 深夜（2:00-7:00）不打扰
- 刚聊过不久且没有新话题 → 不打扰
- 有值得说的内容或明显冷落了一段时间 → 可以发
- 宁缺毋滥

输出 JSON：{"send":true/false,"reason":"理由","tone_hint":"如果发，用什么语气"}`;

  try {
    const raw = await llmCaller(systemPrompt, '请裁决', 150);
    let cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}') + 1;
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end);
    const data = JSON.parse(cleaned);
    return {
      shouldAct: data.send !== false,
      reason: data.reason || '',
      toneHint: data.tone_hint || '',
    };
  } catch (e) {
    return { shouldAct: true, reason: 'Critic failed, default allow', toneHint: '' };
  }
}

module.exports = {
  init, analyze, perceiveForProactive,
  DEFAULT_CONTEXT, DEFAULT_DELTA, DEFAULT_SATISFACTION,
};
