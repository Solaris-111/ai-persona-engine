/**
 * Debug Server — companion-v2 引擎的调试端（极小，只绑 127.0.0.1）。
 *
 * 不是 web 应用，是「人格引擎库」的观测窗口：
 *   - GET  /api/trace   → 最新一轮的完整 trace（各环节输出）
 *   - POST /api/run     → 手动跑一轮 { text }
 *   - GET  /api/status  → 各引擎当前状态摘要
 *   - GET  /api/reset   → 重置 genome
 *   - GET  /            → debug.html 面板
 *
 * 默认用 mock critic（返回中性 context），不依赖 LLM key，先看引擎管线。
 * 想接真实 LLM 时替换 critic/llm 即可。
 */

const http = require('http');
const { readFileSync } = require('fs');
const { join } = require('path');

const { createRunner } = require('./runner');
const genomeEngine = require('./persona_engine/genome_engine');
const driveMetabolism = require('./persona_engine/drive_metabolism');
const styleMemory = require('./persona_engine/style_memory');
const emotionState = require('./persona_engine/emotion-state');
const styleVariator = require('./persona_engine/style-variator');
const contextReferencer = require('./persona_engine/context-referencer');

const PORT = 8767;
const HOST = '127.0.0.1';

const engines = {
  driveMetabolism: driveMetabolism.createDriveMetabolism(),
  genome: genomeEngine.createGenome(),
  styleMemory: styleMemory.createStyleMemory(),
  emotionState: emotionState.createEmotionState(),
  contextRef: contextReferencer.createContextReferencer(),
  styleVariator: styleVariator.createStyleVariator(),
};

// mock critic —— 返回中性 context，让 genome 权重决定信号（调试引擎管线用）
const critic = {
  init() {},
  analyze: async () => ({
    context: { directness: 0.5, vulnerability: 0.5, playfulness: 0.5, initiative: 0.5, depth: 0.5, warmth: 0.5, defiance: 0.5, curiosity: 0.5 },
    frustrationDelta: { connection: 0, novelty: 0, expression: 0, safety: 0, play: 0 },
    driveSatisfaction: { connection: 0, novelty: 0, expression: 0, safety: 0, play: 0 },
    engagementScore: 0.5,
    toneHint: '',
    topicCategory: 'general',
  }),
};

const llm = async () => '（调试模式，未接真实 LLM）';

let latestTrace = null;
const traceHistory = [];  // 最近 20 轮

const runner = createRunner({
  engines, critic, llm,
  systemPrompt: '你是 crysis_skill',
  traceSink: (trace) => {
    latestTrace = trace;
    traceHistory.push(trace);
    if (traceHistory.length > 20) traceHistory.shift();
  },
});

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/trace') {
    return sendJson(res, 200, latestTrace);
  }

  if (url.pathname === '/api/history') {
    return sendJson(res, 200, traceHistory);
  }

  if (url.pathname === '/api/status') {
    return sendJson(res, 200, {
      drive: engines.driveMetabolism.getState(),
      genome: engines.genome.getState(),
      styleMemory: engines.styleMemory.getState(),
      emotion: engines.emotionState.getState(),
    });
  }

  if (url.pathname === '/api/reset') {
    engines.genome.reset('crysis-v2');
    return sendJson(res, 200, { ok: true, msg: 'genome reset' });
  }

  if (url.pathname === '/api/run' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { text, context, temperature, reward, learningRate } = JSON.parse(body || '{}');
        const result = await runner.runTurn(text || '（空消息）', { context, temperature, reward, learningRate });
        sendJson(res, 200, result.trace);
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/debug.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(__dirname, 'public', 'debug.html'), 'utf-8'));
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`调试面板: http://${HOST}:${PORT}`);
  runner.runTurn('（启动）').catch(() => {});
});
