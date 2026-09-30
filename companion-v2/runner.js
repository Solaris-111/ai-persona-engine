/**
 * Runner v2 — 一轮对话的完整管线（从 server.js 抽出）。
 *
 * 命令式编排：把纯函数内核串起来 + 调 LLM + 落盘，
 * 返回完整 trace（每环节输出）供调试器观测 —— 这是 ③ 挂探针的数据来源。
 *
 * 依赖注入：
 *   - engines：各引擎工厂实例（driveMetabolism/genome/styleMemory/emotionState/contextRef/styleVariator）
 *   - critic + llm：感知器 + LLM 调用器
 *   - contextProviders：可选背景上下文注入（日历/记忆/阅读…），不传跳过
 */

const { buildFewShotPrompt } = require('./persona_engine/style_memory');
const { addNoise } = require('./persona_engine/drive_metabolism');

function createRunner({
  engines = {},
  critic = null,
  llm = null,
  systemPrompt = '',
  contextProviders = [],   // [{ name, fetch: async (userText, now) => string }]
  selfLog = null,          // { extractFromMessage(text), addEntry(e) }
  history = null,          // { load(), save(h) }
  now = () => new Date(),
  traceSink = null,        // 每轮跑完回调 (trace) => void，探针落盘/广播用
} = {}) {
  const { driveMetabolism, genome, styleMemory, emotionState, contextRef, styleVariator } = engines;

  if (critic && typeof critic.init === 'function') critic.init(llm);

  async function runTurn(userMessage, opts = {}) {
    const { context: injectedContext, temperature: injectedTemp, reward: injectedReward, learningRate } = opts;
    const t = now();
    const hist = history?.load ? history.load() : [];
    const trace = { timestamp: t.toISOString(), userMessage };

    // Step 1: Metabolize drives（时间箭头）
    const m = driveMetabolism.metabolize();
    trace.metabolize = { deltaHours: m.deltaHours, temperature: m.temperature, totalFrustration: m.totalFrustration };

    // Step 2: Critic perception（LLM → 8D context + 挫败 delta + 满足 + 投入度）
    const criticResult = await critic.analyze(userMessage, driveMetabolism.getState().drives, m.temperature, hist);
    if (injectedContext) criticResult.context = { ...criticResult.context, ...injectedContext };
    if (injectedReward !== undefined) criticResult.engagementScore = injectedReward;
    trace.critic = criticResult;

    // Step 3: Apply Critic feedback to drives
    driveMetabolism.applyFrustrationDelta(criticResult.frustrationDelta);
    driveMetabolism.satisfyDrives(criticResult.driveSatisfaction);
    driveMetabolism.evolveBaselines(criticResult.frustrationDelta);
    trace.drives = driveMetabolism.getState();

    // Step 4: Genome forward pass（5D → 8D 信号）
    const temp = injectedTemp !== undefined ? injectedTemp : m.temperature;
    const fwd = genome.forward(driveMetabolism.getState().drives, temp, criticResult.context);
    trace.genome = {
      signals: fwd.signals,
      input: fwd.raw.input,
      hidden: fwd.raw.hidden,
      rawSignals: fwd.raw.rawSignals,
    };

    // Step 4.5: Thermodynamic noise on signals
    const noisySignals = addNoise(fwd.signals, temp);
    trace.noisySignals = noisySignals;

    // Step 5: Emotion state machine
    const emo = emotionState.processInteraction({ score: criticResult.engagementScore });
    trace.emotion = emo;

    // Step 8: Style memory recall（KNN few-shot）
    const contextVec = Object.values(criticResult.context);
    const recalled = styleMemory.retrieve(contextVec, 3);
    trace.styleRecall = recalled;
    const styleRecallPrompt = buildFewShotPrompt(recalled, 'zh');

    // Step 9: Build persona prompt
    let personaPrompt = systemPrompt + '\n\n';
    personaPrompt += `## 时间锚点\n现在是北京时间 ${t.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}。\n\n`;

    if (criticResult.toneHint) {
      personaPrompt += `## 语气指引\n本轮回应语气: ${criticResult.toneHint}\n\n`;
    }

    personaPrompt += genome.getSignalPrompt(noisySignals) + '\n\n';
    personaPrompt += driveMetabolism.getPromptInjection() + '\n\n';
    personaPrompt += emotionState.getPromptInjection() + '\n\n';

    // Style variator（修正原 server.js 传参 bug：传字符串而非对象）
    try {
      const domDrive = driveMetabolism.hasImpulse()?.drive || 'connection';
      personaPrompt += styleVariator.getStylePrompt(emotionState.getState().current, domDrive) + '\n';
    } catch (_) {}

    if (styleRecallPrompt) personaPrompt += styleRecallPrompt + '\n\n';

    // 可选背景上下文注入
    for (const provider of contextProviders) {
      try {
        const ctx = await provider.fetch(userMessage, t);
        if (ctx) personaPrompt += ctx + '\n';
      } catch (_) {}
    }

    // Recent history
    const recentHistory = hist.slice(-16).map(h =>
      `${h.role === 'user' ? '用户' : 'crysis_skill'}: ${h.text}`
    ).join('\n');

    const fullPrompt = personaPrompt + `\n## 最近对话\n${recentHistory || '（新对话）'}\n\n## 用户消息\n${userMessage}\n\n请用 crysis_skill 的语气回复。直接输出回复内容，不要JSON包装，不要前缀。`;
    trace.prompt = fullPrompt;

    // Step 10: Generate reply via LLM
    const rawReply = llm ? await llm(systemPrompt, fullPrompt, 500) : '';
    const replyText = rawReply || '嗯…（脑子卡了，等下再来）';
    trace.reply = replyText;

    // Step 11: Post-process（Hebbian + style 写入 + self-log + context ref）
    const wu = genome.updateWeights(contextVec, criticResult.engagementScore, learningRate !== undefined ? learningRate : 0.01);
    const si = styleMemory.insert(contextVec, replyText, criticResult.engagementScore);
    trace.postProcess = {
      phaseTransitioned: wu.phaseTransitioned,
      interactionCount: genome.getState().interactionCount,
      styleInserted: !!si,
    };

    if (selfLog) {
      try {
        const extracted = selfLog.extractFromMessage(replyText);
        for (const e of extracted) selfLog.addEntry({ ...e, source: 'generated' });
      } catch (_) {}
    }

    if (contextRef) {
      try {
        contextRef.addTurn('user', userMessage, null);
        contextRef.addTurn('assistant', replyText, null);
      } catch (_) {}
    }

    if (history && history.save) {
      const h = hist.slice();
      h.push({ role: 'user', text: userMessage, time: t.toISOString() });
      h.push({ role: 'assistant', text: replyText, time: t.toISOString() });
      history.save(h);
    }

    if (traceSink) { try { traceSink(trace); } catch (_) {} }

    return { reply: replyText, trace };
  }

  return { runTurn };
}

// 探针落盘：把最新 trace 写到文件（面板读取）
function fileTraceSink(filePath) {
  const { writeFileSync } = require('fs');
  return (trace) => {
    try { writeFileSync(filePath, JSON.stringify(trace, null, 2)); } catch (_) {}
  };
}

module.exports = { createRunner, fileTraceSink };
