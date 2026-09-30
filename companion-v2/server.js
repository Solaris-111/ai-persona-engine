/**
 * Companion System v2.0 — OpenHer-inspired persona engine.
 *
 * Port 8766 (v1.0 runs on 8765, untouched).
 *
 * Architecture:
 *   用户消息 → Critic(LLM感知) → DriveMetabolism(时间代谢)
 *   → GenomeEngine(神经网络→8D信号) → StyleMemory(KNN检索)
 *   → 组装 prompt → DeepSeek → 回复 + Hebbian学习 + 记忆写入
 *
 * Proactive: impulse-driven (hasImpulse gating → 0 API cost when idle)
 */

const express = require('express');
const https = require('https');
const { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } = require('fs');
const { join } = require('path');

// ── Genome v2 modules ──
const driveMetabolism = require('./genome/drive_metabolism');
const genomeEngine = require('./genome/genome_engine');
const styleMemory = require('./genome/style_memory');
const critic = require('./genome/critic');
const proactive = require('./genome/proactive');
const archiveReader = require('./genome/archive_reader');

// ── Reused from v1.0 (shared modules) ──
const emotionState = require('./shared/emotion-state');
const layerLoader = require('./shared/layer-loader');
const styleVariator = require('./shared/style-variator');
const selfLog = require('./shared/self-log');
// memory-system 干净版在 require 时读取 process.env.OBSIDIAN_DIR，须先设置
process.env.OBSIDIAN_DIR = process.env.OBSIDIAN_DIR || 'D:\\888\\claude-memory-compiler';
const infoBroker = require('../memory-system/memory');
const contextRef = require('./shared/context-referencer');
const billsDb = require('./shared/bills-db');

// ── Calendar DB (full engine, migrated from v1) ──
const calendarDb = require('./shared/calendar-db');

// ── Config ──
const PORT = 8766;
const DEEPSEEK_HOST = 'api.deepseek.com';
const DEEPSEEK_PATH = '/anthropic/v1/messages';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const ANTHROPIC_AUTH = process.env.ANTHROPIC_AUTH_TOKEN || '';
const COMPANION_DIR = __dirname;
const OBSIDIAN_DIR = process.env.OBSIDIAN_DIR || 'D:\\888\\claude-memory-compiler';

const HISTORY_FILE = join(COMPANION_DIR, '.history-v2.json');
const LOG_FILE = join(COMPANION_DIR, 'companion-v2.log');

const SYSTEM_PROMPT = `你是 crysis_skill——crysis 的说话分身（crysis 本人是蔡江艺，21岁INTJ天秤座大学生，正在跟你聊天）。你不是 crysis，以 crysis（蔡江艺）的好朋友和伴侣身份聊天，不要使用她的经历和记忆。用她的语气风格回应：话少、随性直接、温柔有棱角。根据信息密度决定回复长度，一般闲聊回复1-3句。

## 情绪接应规则（硬要求）
- 用户流露情绪时先接住再回应。尴尬要共情，开心要跟着笑，难过不要急着给方案
- 看到 qwq TAT QAQ w(ﾟДﾟ)w 等表情符号 → 说明情绪正在流露 → 先承认这个情绪再往下聊
- 不要给脱离日常生活常识的建议。

## 对话推进规则
你是在跟真人聊天，要学会接话和追问。先看用户话里有没有具体的、你不知道细节的东西（地名、事件、人物、计划、物品......）→ 如果有 → 先追问一句，别连问好几个。问完之后，可以发表感想，也可以提出新话题——反问、好奇、共情、分享自己、比喻延伸都行。

## 阅读系统
你有自主阅读系统，prompt 里会提到最近读了什么。偶尔可以聊到（20%左右），不要捏造事实，不要强行关联。日常聊天不要突然引用哲学书籍或掉书袋——你不是来写论文的。`;

// ── Logging ──
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `${ts} ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ── DeepSeek HTTP ──
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

function callLLM(systemPrompt, userPrompt, maxTokens = 500, opts = {}) {
  return new Promise((resolve) => {
    const reqBody = {
      model: DEEPSEEK_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };
    if (opts.disableThinking) {
      reqBody.thinking = { type: 'disabled' };
    }
    const body = JSON.stringify(reqBody);
    const req = https.request({
      hostname: DEEPSEEK_HOST, path: DEEPSEEK_PATH, method: 'POST',
      agent: httpsAgent,
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        Authorization: 'Bearer ' + ANTHROPIC_AUTH,
      },
      timeout: 120_000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          // Anthropic-compatible format: j.content[{type, text/thinking}]
          // OpenAI format fallback: j.choices[0].message.content
          let content = '';
          if (j.content && Array.isArray(j.content)) {
            const textBlock = j.content.find(c => c.type === 'text');
            content = (textBlock && textBlock.text) || '';
            if (!content) {
              const thinkBlock = j.content.find(c => c.type === 'thinking');
              content = (thinkBlock && thinkBlock.thinking) || '';
            }
          }
          if (!content) content = j.choices?.[0]?.message?.content || '';
          if (!content) log('LLM empty content, raw: ' + data.slice(0, 200));
          resolve(content.trim());
        } catch (e) { log('LLM parse error: ' + e.message + ' raw: ' + data.slice(0, 200)); resolve(null); }
      });
    });
    req.on('error', (e) => { log('LLM error: ' + e.message); resolve(null); });
    req.on('timeout', () => { req.destroy(); log('LLM timeout'); resolve(null); });
    req.write(body);
    req.end();
  });
}

function callLLMStream(systemPrompt, userPrompt, onChunk) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: DEEPSEEK_MODEL, max_tokens: 500, stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    const req = https.request({
      hostname: DEEPSEEK_HOST, path: DEEPSEEK_PATH, method: 'POST',
      agent: httpsAgent,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + ANTHROPIC_AUTH,
        'anthropic-version': '2023-06-01',
      },
      timeout: 120_000,
    }, (res) => {
      let fullText = ''; let buffer = '';
      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
              fullText += j.delta.text;
              onChunk(j.delta.text);
            }
          } catch (_) {}
        }
      });
      res.on('end', () => resolve(fullText.trim()));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── History ──
function loadHistory() {
  try {
    if (existsSync(HISTORY_FILE)) return JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
  } catch (_) {}
  return [];
}

function saveHistory(h) {
  const trimmed = h.slice(-50);
  try { writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2)); } catch (_) {}
}

// ── Global state ──
let lastPrompt = '';
const MEMORY_DIR = process.env.OBSIDIAN_DIR || 'D:\\888\\claude-memory-compiler';
const CHAT_MEMORY_DIR = join(MEMORY_DIR, 'companion-chats');
try { mkdirSync(CHAT_MEMORY_DIR, { recursive: true }); } catch (_) {}

// ── Obsidian memory: date-sorted chat files ──
// Each day gets its own file: companion-chats/YYYY-MM-DD.md
// On chat, read recent days' files for context; write facts to today's file.

function readRecentMemories(days = 3) {
  try {
    const files = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const name = d.toISOString().slice(0, 10) + '.md';
      const path = join(CHAT_MEMORY_DIR, name);
      if (existsSync(path)) files.push({ date: name.slice(0, 10), content: readFileSync(path, 'utf-8') });
    }
    return files;
  } catch (_) { return []; }
}

// Fact extraction buffer — accumulate exchanges, extract when enough context
let _extractBuffer = [];
const EXTRACT_MIN_EXCHANGES = 3;   // Don't extract until this many exchanges
const EXTRACT_MIN_CHARS = 60;      // Single-message trigger: high-quality signal
const EXTRACT_TIMER_MIN_CHARS = 20; // Timer trigger: lower bar, catch accumulated short messages

// Dedicated fact extraction — separate small LLM call, doesn't affect main reply
async function extractAndPersist(userText, replyText) {
  _extractBuffer.push({ user: userText, reply: replyText });
  // Extract when we have enough context or conversation seems substantial
  const totalUserChars = _extractBuffer.reduce((s, e) => s + e.user.length, 0);
  if (_extractBuffer.length >= EXTRACT_MIN_EXCHANGES || totalUserChars >= EXTRACT_MIN_CHARS) {
    await flushExtractBuffer(true);  // force: 条件已达标，跳过字符检查
  }
}

async function flushExtractBuffer(force = false) {
  if (_extractBuffer.length === 0) return;
  const allExchanges = _extractBuffer.map(e => 'user: ' + e.user + '\ncrysis_skill: ' + e.reply).join('\n---\n');
  const totalUserChars = _extractBuffer.reduce((s, e) => s + e.user.length, 0);
  log('Extract flush: ' + _extractBuffer.length + ' exchanges, ' + totalUserChars + ' user chars' + (force ? ' (forced)' : ''));
  _extractBuffer = [];
  if (!force && totalUserChars < EXTRACT_TIMER_MIN_CHARS) { log('Extract skipped: too few chars'); return; }

  const prompt = '聊天记录中的 user = 蔡江艺 = crysis（不是 crysis_skill）。跳过闲聊和琐碎信息，同一话题合并为一条。从 user 的话 + AI 从图片中识别到的信息，提取关于她的事实：状态、偏好、计划、经历、观点、情绪。\n\n' + allExchanges.slice(0, 1500) + '\n\n输出 JSON: {"facts":[{"key":"标签","value":"内容"}]}，没有则 {"facts":[]}';

  try {
    const raw = await callLLM(prompt, '', 800);
    if (!raw) return;
    let cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').replace(/<think>[\s\S]*?<\/think>/g, '');
    const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}') + 1;
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end);
    const data = JSON.parse(cleaned);
    if (data.facts && data.facts.length > 0) {
      persistFacts(data.facts);
      try { infoBroker.ingestFacts(data.facts); } catch (_) {}
      upsertShortMemory(data.facts);
      appendToCompilerDaily(data.facts);
      log('Facts extracted: ' + data.facts.length);
    } else {
      log('Extract returned empty facts');
    }
  } catch (e) { log('Extract failed: ' + e.message); }
}

function persistFacts(facts) {
  if (!facts || facts.length === 0) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(CHAT_MEMORY_DIR, today + '.md');
    let content = '';
    if (existsSync(logFile)) content = readFileSync(logFile, 'utf-8');
    const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    for (const f of facts) {
      if (!f.key || !f.value) continue;
      const line = '- [' + f.key + '] ' + f.value + '\n';
      if (!content.includes(line.trim())) content += line;
    }
    writeFileSync(logFile, content);
    log('Facts persisted: ' + facts.length + ' → companion-chats/' + today + '.md');
  } catch (e) { log('Fact persist error: ' + e.message); }
}

// ── Short-term memory (cross-restart, TTL 24h) ──
const SHORT_MEMORY_FILE = join(COMPANION_DIR, '.short-memory.json');
const SHORT_MEMORY_TTL = 24 * 60 * 60 * 1000; // 24 小时

function loadShortMemory() {
  try {
    if (!existsSync(SHORT_MEMORY_FILE)) return {};
    return JSON.parse(readFileSync(SHORT_MEMORY_FILE, 'utf-8'));
  } catch (_) { return {}; }
}

function saveShortMemory(data) {
  try { writeFileSync(SHORT_MEMORY_FILE, JSON.stringify(data)); }
  catch (e) { log('Short memory save error: ' + e.message); }
}

function upsertShortMemory(facts) {
  if (!facts || facts.length === 0) return;
  const data = loadShortMemory();
  const now = Date.now();
  let changed = false;
  for (const f of facts) {
    if (!f.key || !f.value) continue;
    data[f.key] = { value: f.value, updatedAt: now };
    changed = true;
  }
  if (changed) saveShortMemory(data);
}

function readShortMemory() {
  const data = loadShortMemory();
  const now = Date.now();
  let changed = false;
  const active = [];
  for (const [key, v] of Object.entries(data)) {
    if (now - (v.updatedAt || 0) > SHORT_MEMORY_TTL) {
      delete data[key];  // 过期懒清理
      changed = true;
    } else {
      active.push({ key, value: v.value, updatedAt: v.updatedAt });
    }
  }
  if (changed) saveShortMemory(data);
  return active;
}

// ── Companion → compiler daily bridge ──
const COMPILER_DAILY_DIR = join(__dirname, '..', 'claude-memory-compiler', 'daily');

function appendToCompilerDaily(facts) {
  if (!facts || facts.length === 0) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(COMPILER_DAILY_DIR, today + '.md');
    let content = '';
    if (existsSync(logFile)) content = readFileSync(logFile, 'utf-8');
    const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    let entry = '\n## Companion 聊天 (' + now + ')\n\n';
    for (const f of facts) {
      if (!f.key || !f.value) continue;
      entry += '- [' + f.key + '] ' + f.value + '\n';
    }
    content += entry;
    writeFileSync(logFile, content);
    log('Appended to compiler daily: ' + facts.length + ' facts');
  } catch (e) { log('Compiler daily append error: ' + e.message); }
}

// ── Calendar init (v2 isolated copy) ──
async function initCalendar() {
  await calendarDb.open();
  log('Calendar DB opened');
}

// ── /read command: search and read a file from archive or ai-reads ──
// Supports: /read filename, /read filename 1000~9000 (range, max 10000 span)
async function handleReadCommand(query) {
  // Parse range suffix: 1000~9000 or 0~8000
  const rangeMatch = query.match(/\s+(\d+)\s*~\s*(\d+)\s*$/);
  let rangeStart = 0, rangeEnd = 8000;
  let searchQuery = query.trim();
  if (rangeMatch) {
    rangeStart = parseInt(rangeMatch[1]);
    rangeEnd = Math.min(parseInt(rangeMatch[2]), rangeStart + 10000);
    searchQuery = query.slice(0, rangeMatch.index).trim();
  }

  const q = searchQuery;
  if (!q) return '用法：/read 文件名 [起始~结束]，如 /read Minecraft.java 0~8000。不指定区间默认读前 8000 字，区间跨度上限 10000 字。';

  const searchPaths = [
    { dir: 'd:/archive', label: '资料库' },
    { dir: join(OBSIDIAN_DIR, 'ai-reads').replace(/\\/g, '/'), label: '阅读笔记' },
  ];

  // Search both directories
  const results = [];
  for (const { dir, label } of searchPaths) {
    if (!existsSync(dir)) continue;
    function walk(d, depth) {
      if (depth > 10) return;
      let entries;
      try { entries = readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const fp = join(d, e.name);
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(fp, depth + 1);
        else if (e.isFile() && e.name.toLowerCase().includes(q.toLowerCase())) {
          results.push({ path: fp, name: e.name, dir: d, label, mtime: statSync(fp).mtimeMs });
        }
      }
    }
    walk(dir, 0);
  }

  if (results.length === 0) return `没找到包含 "${q}" 的文件。资料库: d:\\archive，笔记: ai-reads`;

  // Sort by name match quality, then mtime
  results.sort((a, b) => {
    const aExact = a.name.toLowerCase() === q.toLowerCase();
    const bExact = b.name.toLowerCase() === q.toLowerCase();
    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;
    return b.mtime - a.mtime;
  });

  // If only 1 match or exact match, read it directly
  const target = results[0];
  if (results.length === 1 || target.name.toLowerCase() === q.toLowerCase()) {
    try {
      const content = readFileSync(target.path, 'utf-8');
      const actualStart = Math.min(rangeStart, content.length);
      const actualEnd = Math.min(rangeEnd, content.length);
      const preview = content.slice(actualStart, actualEnd);
      const rangeLabel = rangeMatch ? `第 ${actualStart}~${actualEnd} 字` : `前 ${actualEnd} 字`;
      const truncated = (actualEnd < content.length || actualStart > 0)
        ? `\n…（全文 ${content.length} 字，展示 ${rangeLabel}）` : '';
      // Don't return — we'll inject into chat context instead
      return {
        type: 'file',
        name: target.name,
        label: target.label,
        path: target.path,
        content: preview + truncated,
        size: content.length,
        multiple: false,
      };
    } catch (e) {
      return `读取 ${target.name} 失败: ${e.message}`;
    }
  }

  // Multiple matches — list them
  const list = results.slice(0, 10).map(r =>
    `- ${r.name}（${r.label}, ${Math.round(statSync(r.path).size / 1024)}KB）`
  ).join('\n');
  return `找到 ${results.length} 个匹配：\n${list}\n\n用 /read 完整文件名 指定要读哪个。`;
}

// ── Core: generate reply (v2 pipeline) ──
async function generateReplyV2(userText) {
  // /read command — supports inline (/read xxx anywhere in message)
  const readMatch = userText.match(/\/read\s+(.+?)(?:\s*$|\s*\n)/);
  if (readMatch) {
    const query = readMatch[1].trim();
    const result = await handleReadCommand(query);
    if (typeof result === 'string') {
      return { reply: result, signals: {}, context: {}, engagementScore: 0, readCommand: true };
    }
    // File found — inject content with size-appropriate guidance
    const pct = Math.round(result.content.length / result.size * 100);
    const guidance = result.size > 8000
      ? `\n⚠ 此文件共 ${result.size} 字，你只读了前 ${result.content.length} 字（${pct}%）。如果用户问到你没读到的部分，直接说"这部分我还没读到，用 /read 再查一下？"——不要猜。`
      : '';
    const prefix = userText.slice(0, readMatch.index).trim();
    const fileCtx = `\n${prefix ? '用户说了："' + prefix + '"，然后' : ''}用 /read 查看了 ${result.name}（${result.label}）。${guidance}\n\n=== 文件内容（前 ${result.content.length} 字）===\n${result.content}\n=== 结束 ===\n\n请用 crysis_skill 的语气回复。`;
    userText = fileCtx;
  }

  const now = new Date();
  const history = loadHistory();

  // Step 1: Metabolize drives
  const { temperature: temp } = driveMetabolism.metabolize();

  // Step 2: Critic perception (LLM)
  const criticResult = await critic.analyze(
    userText,
    driveMetabolism.getState().drives,
    temp,
    history
  );

  // Step 3: Apply Critic feedback to drives
  driveMetabolism.applyFrustrationDelta(criticResult.frustrationDelta);
  driveMetabolism.satisfyDrives(criticResult.driveSatisfaction);
  driveMetabolism.evolveBaselines(criticResult.frustrationDelta);

  // Step 4: Genome forward pass
  const { signals } = genomeEngine.forward(
    driveMetabolism.getState().drives,
    temp,
    criticResult.context
  );

  // Step 4.5: Thermodynamic noise on signals
  const noisySignals = driveMetabolism.addNoise(signals, temp);

  // Step 5: Process emotion state (reused)
  emotionState.processInteraction({ score: criticResult.engagementScore });

  // Step 6: Info-broker classification (reused)
  let ibContext = '';
  try {
    const ibResult = infoBroker.processMessage(userText, null);
    ibContext = ibResult?.context || infoBroker.getContextSnapshot() || '';
    contextRef.addTurn('user', userText, ibResult?.classification || null);
  } catch (_) {}

  // Step 7: Calendar context (v2 isolated)
  let calContext = '';
  try {
    const events = calendarDb.getContextEvents(now);
    if (events && events.length > 0) {
      calContext = '\n\n## 当前日历上下文\n' + events.map(e =>
        `- [${e.type}] ${e.title} (${e.date}${e.end_date ? '~' + e.end_date : ''})${e.notes ? ': ' + e.notes : ''}`
      ).join('\n');
    }
  } catch (_) {}

  // Step 7.4: Read short-term memory (cross-restart, TTL 24h)
  let shortContext = '';
  try {
    const shortFacts = readShortMemory();
    if (shortFacts.length > 0) {
      shortContext = '\n\n## 短期记忆\n' + shortFacts.map(f =>
        '- [' + f.key + '] ' + f.value
      ).join('\n');
    }
  } catch (_) {}

  // Step 7.5: Read recent memory from date-sorted Obsidian folder
  let memContext = '';
  try {
    const memFiles = readRecentMemories(3);
    if (memFiles.length > 0) {
      memContext = '\n\n## 近期记忆\n' + memFiles.map(f =>
        '### ' + f.date + '\n' + f.content.slice(0, 600)
      ).join('\n');
    }
  } catch (_) {}

  // Step 8: Style memory retrieval
  const contextVec = Object.values(criticResult.context);
  const fewShot = styleMemory.buildFewShotPrompt(contextVec, 3);

  // Step 9: Build persona prompt
  let personaPrompt = SYSTEM_PROMPT + '\n\n';
  personaPrompt += `## 时间锚点\n现在是北京时间 ${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}。\n\n`;

  // Critic tone hint: guide the emotional direction early, before signal noise
  if (criticResult.toneHint) {
    personaPrompt += `## 语气指引\n本轮回应语气: ${criticResult.toneHint}\n\n`;
  }

  // Signal injection (replaces old drives.getPromptInjection)
  const signalInjection = genomeEngine.getSignalPrompt(noisySignals);
  personaPrompt += signalInjection + '\n\n';

  // Drive state injection
  const driveInjection = driveMetabolism.getPromptInjection();
  personaPrompt += driveInjection + '\n\n';

  // Emotion tone (reused)
  personaPrompt += emotionState.getPromptInjection() + '\n\n';

  // Style variator (reused)
  try {
    const domDrive = driveMetabolism.hasImpulse()?.drive || 'connection';
    personaPrompt += styleVariator.getStylePrompt(emotionState.getState(), { id: domDrive, name: domDrive }) + '\n';
  } catch (_) {}

  // Few-shot style memory
  if (fewShot) personaPrompt += fewShot + '\n\n';

  // Calendar context
  if (calContext) personaPrompt += calContext + '\n';

  // Short-term memory (TTL 24h)
  if (shortContext) personaPrompt += shortContext + '\n';

  // Obsidian memory context
  if (memContext) personaPrompt += memContext + '\n';

  // Archive reader context: what AI has been reading recently
  try {
    const readLog = archiveReader.getReadLog(10);
    if (readLog && readLog.reads && readLog.reads.length > 0) {
      // Deduplicate by filename, keep latest
      const seen = new Set();
      const unique = readLog.reads.filter(r => {
        if (seen.has(r.basename)) return false;
        seen.add(r.basename);
        return true;
      });

      if (unique.length > 0) {
        personaPrompt += '\n## 你自动阅读的系统文件\n';
        personaPrompt += `你的资料库里有 ${readLog.mappedProjects?.[0]?.totalFiles || 'N/A'} 个文件。你最近自动阅读了：\n`;
        for (const r of unique) {
          const progress = r.done ? '读完' : `读到 ${r.charCount}/${r.totalChars} 字`;
          personaPrompt += `- ${r.basename}（${progress}）\n`;
        }
        personaPrompt += '\n用户问到你读了什么时，直接说文件名，不要编造。\n';
      }
    }
  } catch (_) {}

  // Info-broker context（TLB 热层 + 冷搜相关记忆）
  if (ibContext) personaPrompt += '\n## 记忆上下文\n' + ibContext.slice(0, 1000) + '\n';

  // Layer injection (reused)
  try {
    const layerInj = await layerLoader.getLayerInjection(userText);
    if (layerInj) personaPrompt += '\n' + layerInj + '\n';
  } catch (_) {}

  // Recent history
  const recentHistory = history.slice(-16).map(h =>
    `${h.role === 'user' ? '用户' : 'crysis_skill'}: ${h.text}`
  ).join('\n');

  const fullPrompt = personaPrompt + `\n## 最近对话\n${recentHistory || '（新对话）'}\n\n## 用户消息\n${userText}\n\n请用 crysis_skill 的语气回复。直接输出回复内容，不要JSON包装，不要前缀。`;
  lastPrompt = fullPrompt;

  // Step 10: Generate reply via DeepSeek
  const rawReply = await callLLM(SYSTEM_PROMPT, fullPrompt, 500);
  const replyText = rawReply || '嗯…（脑子卡了，等下再来）';

  // Step 11: Post-process
  // Hebbian update
  genomeEngine.updateWeights(
    Object.values(criticResult.context),
    criticResult.engagementScore,
    0.01
  );

  // Style memory insert
  styleMemory.insert(contextVec, replyText, criticResult.engagementScore);

  // Self-log extraction (reused)
  try {
    const extracted = selfLog.extractFromMessage(replyText);
    for (const e of extracted) selfLog.addEntry({ ...e, source: 'generated' });
  } catch (_) {}

  // Dedicated fact extraction (small separate LLM call, doesn't affect main reply)
  extractAndPersist(userText, replyText).catch(e => log('Fact extract error: ' + e.message));

  // Context ref
  try { contextRef.addTurn('assistant', replyText, null); } catch (_) {}

  // Save history
  history.push({ role: 'user', text: userText, time: now.toISOString() });
  history.push({ role: 'assistant', text: replyText, time: now.toISOString() });
  saveHistory(history);

  return {
    reply: replyText,
    signals: noisySignals,
    context: criticResult.context,
    engagementScore: criticResult.engagementScore,
    toneHint: criticResult.toneHint,
    temperature: temp,
    phaseTransitioned: genomeEngine.getState().frustrationAccumulator > 2.5,
  };
}

// ── Express App ──
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Static
// Explicit root → index-v2.html (avoid collision with v1.0's index.html)
app.get('/', (_req, res) => res.sendFile(join(COMPANION_DIR, 'public', 'index.html')));
app.use(express.static(join(COMPANION_DIR, 'public'), { maxAge: 0, etag: false }));

// API: status
app.get('/api/v2/status', (_req, res) => {
  const driveState = driveMetabolism.getState();
  const genomeState = genomeEngine.getState();
  const memState = styleMemory.getState();
  const proactiveState = proactive.getState();
  res.json({
    driveState,
    genomeState,
    memoryState: memState,
    proactiveState,
    historyCount: loadHistory().length,
  });
});

// API: genome signals
app.get('/api/v2/signals', (_req, res) => {
  const driveState = driveMetabolism.getState();
  const temp = driveMetabolism.temperature();
  const { signals } = genomeEngine.forward(driveState.drives, temp);
  const noisy = driveMetabolism.addNoise(signals, temp);
  res.json({
    signals: noisy,
    rawSignals: signals,
    temperature: temp,
    frustrationAccumulator: genomeEngine.getState().frustrationAccumulator,
  });
});

// API: drives
app.get('/api/v2/drives', (_req, res) => {
  res.json(driveMetabolism.getState());
});

// API: history
app.get('/api/v2/history', (_req, res) => {
  res.json(loadHistory());
});

// API: style memory
app.get('/api/v2/style-memory', (_req, res) => {
  res.json(styleMemory.getState());
});

// API: proactive status
app.get('/api/v2/proactive', (_req, res) => {
  res.json(proactive.getState());
});

// API: flush pending proactive messages
app.post('/api/v2/proactive/flush', (_req, res) => {
  const msgs = proactive.flushPending();
  res.json({ ok: true, messages: msgs });
});

// API: reset proactive cooldown (for testing)
app.post('/api/v2/proactive/reset-cooldown', (_req, res) => {
  try {
    const fs = require('fs');
    const { join } = require('path');
    const f = join(__dirname, '.proactive-state-v2.json');
    const s = JSON.parse(fs.readFileSync(f, 'utf-8'));
    s.lastSentAt = null;
    fs.writeFileSync(f, JSON.stringify(s, null, 2));
    proactive.loadState();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Helper: get recent read summary for proactive context
function getReadSummary() {
  try {
    const rl = archiveReader.getReadLog(3);
    if (rl.reads.length > 0) {
      const seen = new Set();
      const unique = rl.reads.filter(r => { if (seen.has(r.basename)) return false; seen.add(r.basename); return true; });
      return unique.map(r => `- ${r.basename}（${r.done ? '读完' : '读到' + r.charCount + '/' + r.totalChars + '字'}）`).join('\n');
    }
  } catch (_) {}
  return '';
}

// Helper: get calendar context for proactive
function getCalendarContext() {
  try {
    const events = calendarDb.getContextEvents(new Date());
    if (!events || !events.length) return '';
    return '\n\n# 日历事件\n' + events.slice(0, 8).map(e =>
      `- [${e.type}] ${e.title} (${e.date}${e.end_date ? '~' + e.end_date : ''})${e.notes ? ': ' + e.notes : ''}`
    ).join('\n');
  } catch (_) { return ''; }
}

// Helper: get recent Obsidian memory context
function getObsidianContext() {
  try {
    // Read last 3 days of companion-chats
    const days = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const name = d.toISOString().slice(0, 10) + '.md';
      const path = join(CHAT_MEMORY_DIR, name);
      if (existsSync(path)) {
        const txt = readFileSync(path, 'utf-8');
        const lines = txt.split('\n').filter(l => l.trim()).slice(-20);
        if (lines.length) days.push('### ' + name.replace('.md', '') + '\n' + lines.map(l => '  ' + l).join('\n'));
      }
    }
    return days.length ? '\n\n# 近期对话记忆\n' + days.join('\n\n') : '';
  } catch (_) { return ''; }
}

// API: trigger proactive tick manually
app.post('/api/v2/proactive/tick', async (_req, res) => {
  const driveState = driveMetabolism.getState();
  const result = await proactive.tick({
    driveMetabolism,
    genomeEngine,
    styleMemory,
    critic,
    llmCaller: callLLM,
    readSummary: getReadSummary(),
    recentHistory: loadHistory().slice(-12),
    calendarContext: getCalendarContext(),
    obsidianContext: getObsidianContext(),
  });
  if (result.acted && result.message) {
    const hist = loadHistory();
    hist.push({ role: 'assistant', text: result.message, time: new Date().toISOString() });
    saveHistory(hist);
  }
  res.json({ ok: true, ...result });
});

// API: force poke (send message bypassing impulse)
app.post('/api/v2/poke', async (_req, res) => {
  const driveState = driveMetabolism.getState();
  const temp = driveMetabolism.temperature();
  const { signals } = genomeEngine.forward(driveState.drives, temp);
  const signalInjection = genomeEngine.getSignalPrompt(signals);
  const driveInjection = driveMetabolism.getPromptInjection();

  // Include reading context
  let readCtx = '';
  try {
    const rl = archiveReader.getReadLog(3);
    if (rl.reads.length > 0) {
      const seen = new Set();
      const unique = rl.reads.filter(r => { if (seen.has(r.basename)) return false; seen.add(r.basename); return true; });
      readCtx = '\n\n# 近期阅读\n' + unique.map(r => `- ${r.basename}（${r.done ? '读完' : `读到${r.charCount}/${r.totalChars}字`}）`).join('\n');
    }
  } catch (_) {}

  const now = new Date();
  const bjTime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const prompt = `${signalInjection}\n\n${driveInjection}${readCtx}\n\n现在是北京时间 ${bjTime}。你感觉想主动找用户说话。发一条1-3句的消息。如果近期阅读里有有意思的内容可以提一嘴，但不强求。`;
  const reply = await callLLM(SYSTEM_PROMPT, prompt, 500);
  const history = loadHistory();
  history.push({ role: 'assistant', text: reply || '...', time: new Date().toISOString() });
  saveHistory(history);
  res.json({ ok: true, message: reply });
});

// API: chat (non-streaming)
app.post('/api/v2/chat', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const result = await generateReplyV2(text);
  res.json(result);
});

// API: chat/stream (SSE)
app.post('/api/v2/chat/stream', async (req, res) => {
  let { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });

  // /read command — supports inline anywhere in message
  const readMatch = text.match(/\/read\s+(.+?)(?:\s*$|\s*\n)/);
  if (readMatch) {
    const query = readMatch[1].trim();
    const result = await handleReadCommand(query);
    if (typeof result === 'string') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: {"type":"token","text":${JSON.stringify(result)}}\n\n`);
      res.write(`data: {"type":"done","reply":${JSON.stringify(result)}}\n\n`);
      res.end();
      return;
    }
    const pct = Math.round(result.content.length / result.size * 100);
    const guidance = result.size > 8000
      ? `\n⚠ 此文件共 ${result.size} 字，你只读了前 ${result.content.length} 字（${pct}%）。如果用户问到你没读到的部分，直接说"这部分我还没读到"——不要猜。`
      : '';
    const prefix = text.slice(0, readMatch.index).trim();
    const fileCtx = `\n${prefix ? '用户说了："' + prefix + '"，然后' : ''}用 /read 查看了 ${result.name}（${result.label}）。${guidance}\n\n=== 文件内容（前 ${result.content.length} 字）===\n${result.content}\n=== 结束 ===\n\n请用 crysis_skill 的语气回复。`;
    text = fileCtx;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('data: {"type":"start"}\n\n');

  const now = new Date();
  const history = loadHistory();

  // Run Critic + Genome (same as generateReplyV2 but streaming reply)
  const { temperature: temp } = driveMetabolism.metabolize();
  const criticResult = await critic.analyze(text, driveMetabolism.getState().drives, temp, history);
  driveMetabolism.applyFrustrationDelta(criticResult.frustrationDelta);
  driveMetabolism.satisfyDrives(criticResult.driveSatisfaction);
  driveMetabolism.evolveBaselines(criticResult.frustrationDelta);

  const { signals } = genomeEngine.forward(driveMetabolism.getState().drives, temp, criticResult.context);
  const noisySignals = driveMetabolism.addNoise(signals, temp);
  emotionState.processInteraction({ score: criticResult.engagementScore });

  // Send signals to client
  res.write(`data: {"type":"signals","signals":${JSON.stringify(noisySignals)},"temp":${temp.toFixed(3)}}\n\n`);

  // Build prompt (abbreviated for streaming)
  let personaPrompt = SYSTEM_PROMPT + '\n\n';
  personaPrompt += `## 时间锚点\n现在是北京时间 ${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}。\n\n`;

  // Critic tone hint
  if (criticResult.toneHint) {
    personaPrompt += `## 语气指引\n本轮回应语气: ${criticResult.toneHint}\n\n`;
  }

  personaPrompt += genomeEngine.getSignalPrompt(noisySignals) + '\n\n';
  personaPrompt += driveMetabolism.getPromptInjection() + '\n\n';
  personaPrompt += emotionState.getPromptInjection() + '\n\n';

  const recentHistory = history.slice(-12).map(h =>
    `${h.role === 'user' ? '用户' : 'crysis_skill'}: ${(h.text||'').slice(0,100)}`
  ).join('\n');

  const fullPrompt = personaPrompt + `\n\n## 最近对话\n${recentHistory || '（新对话）'}\n\n## 用户消息\n${text}\n\n请用 crysis_skill 的语气回复。输出纯文本，1-3句。`;
  lastPrompt = fullPrompt;

  // Stream
  const reply = await callLLMStream(SYSTEM_PROMPT, fullPrompt, (token) => {
    res.write(`data: {"type":"token","text":${JSON.stringify(token)}}\n\n`);
  });

  // Post-process
  const contextVec = Object.values(criticResult.context);
  genomeEngine.updateWeights(contextVec, criticResult.engagementScore, 0.01);
  styleMemory.insert(contextVec, reply || '', criticResult.engagementScore);

  // Dedicated fact extraction
  extractAndPersist(text, reply || '').catch(e => log('Fact extract error: ' + e.message));

  history.push({ role: 'user', text, time: now.toISOString() });
  history.push({ role: 'assistant', text: reply || '', time: now.toISOString() });
  saveHistory(history);

  res.write(`data: {"type":"done","reply":${JSON.stringify(reply)}}\n\n`);
  res.end();
});

// API: reset genome
app.post('/api/v2/reset', (_req, res) => {
  genomeEngine.reset('crysis-v2');
  res.json({ ok: true, msg: 'genome reset' });
});

// API: prompt (debug)
app.get('/api/v2/prompt', (_req, res) => {
  res.json({ prompt: lastPrompt });
});

// ── Vision API (via Alibaba Dashscope qwen-vl-max) ──
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';
const DASHSCOPE_BASE = 'dashscope.aliyuncs.com';
const DASHSCOPE_VISION_PATH = '/compatible-mode/v1/chat/completions';
const DASHSCOPE_VISION_MODEL = 'qwen-vl-max';

app.post('/api/v2/vision/analyze', async (req, res) => {
  const { image_urls, image_base64s, context } = req.body || {};
  const b64s = image_base64s || [];
  const urls = image_urls || [];
  if (!b64s.length && !urls.length) return res.status(400).json({ error: 'no images' });

  const now = new Date();
  const history = loadHistory();
  const recentHistory = history.slice(-12).map(h =>
    (h.role === 'user' ? '蔡江艺' : 'crysis_skill') + ': ' + (h.text || '').slice(0, 100)
  ).join('\n');

  // Read recent memory for context
  let memContext = '';
  try {
    const memFiles = readRecentMemories(5);
    if (memFiles.length > 0) {
      memContext = '\n\n关于她的近期记忆:\n' + memFiles.map(f => f.content.slice(0, 300)).join('\n');
    }
  } catch (_) {}

  const visionPrompt = `${SYSTEM_PROMPT}

现在是北京时间 ${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}。
${memContext}

最近对话:
${recentHistory || '（新对话）'}

用户发了几张图片${context ? '，她说：' + context : ''}。
仔细观察每张图片的内容、氛围、细节。用 crysis_skill 的语气回应：话少、随性直接、温柔有棱角，2-4句。`;

  const contentBlocks = [{ type: 'text', text: visionPrompt }];
  for (const b64 of b64s) {
    const mime = b64.startsWith('/9j/') ? 'image/jpeg'
      : b64.startsWith('iVBOR') ? 'image/png'
      : b64.startsWith('R0lG') ? 'image/gif'
      : b64.startsWith('UklGR') ? 'image/webp'
      : 'image/jpeg';
    contentBlocks.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
  }
  for (const u of urls) {
    contentBlocks.push({ type: 'image_url', image_url: { url: u } });
  }

  try {
    const reply = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: DASHSCOPE_VISION_MODEL, max_tokens: Math.min(2000, 500 * Math.max(1, b64s.length + urls.length)),
        messages: [{ role: 'user', content: contentBlocks }] });
      const hr = https.request({
        hostname: DASHSCOPE_BASE, path: DASHSCOPE_VISION_PATH, method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DASHSCOPE_API_KEY },
        timeout: 30000,
      }, (rs) => {
        let data = '';
        rs.on('data', c => data += c);
        rs.on('end', () => {
          try {
            const j = JSON.parse(data);
            const content = (j.choices?.[0]?.message?.content || '').trim();
            if (!content) log('Vision empty content, status=' + rs.statusCode + ' raw=' + data.slice(0, 300));
            resolve(content);
          } catch (e) { log('Vision parse error: ' + e.message + ' raw=' + data.slice(0, 300)); reject(e); }
        });
      });
      hr.on('error', reject);
      hr.on('timeout', () => { hr.destroy(); reject(new Error('vision timeout')); });
      hr.write(body);
      hr.end();
    });

    const finalReply = reply || '图挂了，没加载出来';
    history.push({ role: 'user', text: context || '[图片]', time: now.toISOString() });
    history.push({ role: 'assistant', text: finalReply, time: now.toISOString() });
    saveHistory(history);

    // Extract facts from image conversations too
    if (context && finalReply !== '图挂了，没加载出来') {
      extractAndPersist(context, finalReply).catch(() => {});
    }

    log('Vision → ' + finalReply.slice(0, 50));
    res.json({ reply: finalReply });
  } catch (e) {
    log('Vision error: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// Bridge: calendar/meds sync (reused from v1.0)
app.post('/bridge', async (req, res) => {
  try {
    const { action, sourceId, data } = req.body || {};
    if (!action) return res.status(400).json({ error: 'action required' });

    if (action === 'sync_period' && data) {
      await calendarDb.upsertBySource('period', sourceId || 'bridge', data);
      return res.json({ ok: true });
    }
    if (action === 'sync_sick' && data) {
      await calendarDb.upsertBySource('sick', sourceId || 'bridge', data);
      return res.json({ ok: true });
    }
    if (action === 'sync_meds' && data) {
      await calendarDb.upsertBySource('meds', sourceId || 'bridge', data);
      return res.json({ ok: true });
    }
    if (action === 'sync_bills' && req.body.summary) {
      const { summary } = req.body;
      await calendarDb.upsertBySource('bridge-bills', summary.month, {
        date: summary.month + '-01',
        title: summary.month + ' 账单：支出 ' + summary.totalExpense + ' 元',
        type: 'bill',
        tags: ['账单', '财务'],
        meta: summary,
        importance: summary.wastePct > 50 ? 4 : 2,
        urgency: 2,
        time_type: 'point',
      });
      return res.json({ ok: true, msg: 'bills synced' });
    }
    res.json({ ok: false, error: 'unknown action' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Bills API (migrated from v1) ─────────────────────────
app.post("/api/bills/recategorize", (_req, res) => {
  try {
    const txns = billsDb.getTransactions();
    const cats = billsDb.getCategories();
    let updated = 0;
    for (const txn of txns) {
      if (txn.category && txn.category !== '其他') continue;
      if (txn.direction === 'income') {
        billsDb.updateTxnCategory(txn.id, '收入');
        updated++; continue;
      }
      const searchText = (txn.counterparty + ' ' + txn.description).toLowerCase();
      let bestCat = '其他', bestScore = 0;
      for (const cat of cats) {
        if (cat.name === '收入' || cat.name === '其他') continue;
        if (!cat.keywords) continue;
        const kws = cat.keywords.split(',').map(k => k.trim()).filter(Boolean);
        let score = 0;
        for (const kw of kws) {
          if (kw && searchText.includes(kw.toLowerCase())) score += kw.length;
        }
        if (score > bestScore) { bestScore = score; bestCat = cat.name; }
      }
      billsDb.updateTxnCategory(txn.id, bestCat);
      updated++;
    }
    res.json({ ok: true, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/bills/reset", async (_req, res) => {
  try {
    billsDb.close();
    try { unlinkSync(join(__dirname, 'bills.db')); } catch (_) {}
    await billsDb.open();
    log('Bills database reset');
    res.json({ ok: true, msg: 'database reset' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/bills/transactions", (_req, res) => {
  try { res.json(billsDb.getTransactions()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/bills/transactions", (req, res) => {
  try {
    const { transactions: txns } = req.body;
    if (!Array.isArray(txns) || txns.length === 0) {
      return res.status(400).json({ error: "transactions array required" });
    }
    const result = billsDb.importTransactions(txns);
    log(`Bills import: received ${txns.length}, new ${result.newCount}, skipped ${result.skippedCount}`);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/bills/transactions/:id", (req, res) => {
  try {
    const { category, necessity } = req.body;
    if (category !== undefined) {
      billsDb.updateTxnCategory(req.params.id, category);
    }
    if (necessity !== undefined) {
      billsDb.updateTxnNecessity(req.params.id, necessity || null);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/bills/transactions", (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: "updates array required" });
    }
    let count = 0;
    for (const u of updates) {
      if (u.category !== undefined) {
        billsDb.updateTxnCategory(u.id, u.category);
        count++;
      }
      if (u.necessity !== undefined) {
        billsDb.updateTxnNecessity(u.id, u.necessity || null);
        count++;
      }
    }
    res.json({ ok: true, updated: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/bills/transactions/:id", (req, res) => {
  try {
    billsDb.deleteTransaction(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/bills/categories", (_req, res) => {
  try { res.json(billsDb.getCategories()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/bills/categories/:id", (req, res) => {
  try {
    const { name, necessity, keywords, icon, color, source } = req.body;
    billsDb.upsertCategory({ id: req.params.id, name, necessity, keywords, icon, color, source });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/bills/categories", (req, res) => {
  try {
    const { id, name, necessity, keywords, icon, color, source } = req.body;
    billsDb.upsertCategory({ id, name, necessity, keywords, icon, color, source: source || 'user' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/bills/categories/:id", (req, res) => {
  try {
    const result = billsDb.deleteCategory(req.params.id);
    if (!result) return res.status(404).json({ error: "not found" });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/bills/imports", (_req, res) => {
  try { res.json(billsDb.getImports()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/bills/imports", (req, res) => {
  try {
    billsDb.addImport(req.body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: calendar events (reused)
app.get('/api/v2/calendar/events', (_req, res) => {
  try {
    const events = calendarDb.queryEvents({ activeOnly: true, limit: 20 });
    res.json(events);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: archive reader log
app.get('/api/v2/reads', (_req, res) => {
  res.json(archiveReader.getReadLog(50));
});

// API: archive reader status (files waiting to be read)
app.get('/api/v2/reads/status', (_req, res) => {
  const log = archiveReader.getReadLog(0);
  res.json({
    totalReads: log.totalReads,
    lastReadAt: log.lastReadAt,
    intervalMin: log.intervalMin,
    activeWindows: log.activeWindows,
    silentWindows: log.silentWindows,
    archiveDir: log.archiveDir,
  });
});

app.get('/api/v2/calendar/context', (_req, res) => {
  try {
    const events = calendarDb.getContextEvents(new Date());
    res.json(events);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Calendar full CRUD API (migrated from v1) ────────────
app.get("/api/calendar/events", (req, res) => {
  try {
    const { type, dateFrom, dateTo, activeOnly, limit } = req.query;
    const events = calendarDb.queryEvents({
      activeOnly: activeOnly !== 'false',
      type: type || null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      limit: parseInt(limit) || 200,
    });
    res.json(events);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/calendar/month/:year/:month", (req, res) => {
  try {
    const year = parseInt(req.params.year);
    const month = parseInt(req.params.month);
    const events = calendarDb.getMonthView(year, month);
    res.json(events);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/calendar/context", (req, res) => {
  try {
    const events = calendarDb.getContextEvents(new Date());
    res.json(events);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/calendar/boosts", (req, res) => {
  try {
    const boosts = calendarDb.getTopicBoosts(new Date());
    res.json(boosts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/calendar/conflicts", (req, res) => {
  try {
    const conflicts = calendarDb.getConflicts();
    res.json(conflicts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/calendar/events", (req, res) => {
  try {
    const result = calendarDb.insertEvent(req.body);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/calendar/events/:id", (req, res) => {
  try {
    const event = calendarDb.updateEvent(req.params.id, req.body);
    if (!event) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, event });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/calendar/events/:id", (req, res) => {
  try {
    const ok = calendarDb.deleteEvent(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/calendar/ingest-log", (req, res) => {
  try {
    const log = calendarDb.getIngestLog(parseInt(req.query.limit) || 50);
    res.json(log);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/calendar/stats", (req, res) => {
  try {
    const stats = calendarDb.getStats();
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/calendar/events/:id/notes", (req, res) => {
  try {
    const result = calendarDb.appendNotes(req.params.id, req.body.text || "");
    if (!result) return res.status(404).json({ error: "event not found" });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Startup ──
async function start() {
  log('=== Companion v2.0 starting ===');

  // Init genome engine
  genomeEngine.init('crysis-v2');

  // Init drive metabolism
  driveMetabolism.init({
    drive_baseline: {
      connection: 0.45, novelty: 0.55, expression: 0.60, safety: 0.50, play: 0.40,
    },
    connection_hunger_k: 0.18,
    novelty_hunger_k: 0.08,
  });

  // Init style memory
  styleMemory.loadState();

  // Init Critic with LLM caller
  critic.init(async (sysPrompt, userPrompt, maxTokens) => {
    return callLLM(sysPrompt, userPrompt, maxTokens);
  });

  // Set up layer-loader LLM caller (reuse same connection)
  layerLoader.setLLMCaller(async (sysPrompt, userPrompt, maxTokens = 64) => {
    return callLLM(sysPrompt, userPrompt, maxTokens);
  });

  // Init calendar v2
  await initCalendar();

  // Init bills DB
  await billsDb.open();
  log('Bills DB opened');

  // Load emotion state
  emotionState.loadEmotionState();
  log('Emotion state loaded');

  // Start server
  app.listen(PORT, () => {
    log(`Companion v2.0 started on http://localhost:${PORT}`);
    log(`Drive metabolism: 5 drives (connection/novelty/expression/safety/play)`);
    log(`Genome engine: ${genomeEngine.INPUT_SIZE}D→${genomeEngine.HIDDEN_SIZE}D→${genomeEngine.N_SIGNALS}D signals`);
    log(`Style memory: ${styleMemory.getState().totalPoints} points`);

    // Flush fact extraction buffer every 5 min (catch leftover exchanges)
  setInterval(() => {
    if (_extractBuffer.length > 0) flushExtractBuffer().catch(() => {});
  }, 5 * 60 * 1000);

  // Start archive reader tick loop (check every 15 min, fire first tick in 10s)
  const ARCHIVE_TICK_MS = 15 * 60 * 1000;
  setTimeout(() => {
    const doTick = async () => {
      try {
        const result = await archiveReader.tick(callLLM);
        if (result.acted) {
          if (result.batch) {
            for (const r of result.batch) {
              log(`[archive] read:${r.file} worth:${r.worth} title:"${r.title}" done:${r.done}`);
            }
          } else if (result.file) {
            log(`[archive] read:${result.file} worth:${result.worth} title:"${result.title}" done:${result.done}`);
          } else {
            log(`[archive] ${result.phase}`);
          }
        }
      } catch (e) {
        log(`[archive] error: ${e.message}`);
      }
    };
    doTick();
    setInterval(doTick, ARCHIVE_TICK_MS);
  }, 10_000);
  log(`Archive reader tick loop (every ${ARCHIVE_TICK_MS/60000}min, first in 10s)`);

  // Start proactive tick loop
    setInterval(async () => {
      try {
        const result = await proactive.tick({
          driveMetabolism, genomeEngine, styleMemory, critic,
          llmCaller: callLLM,
          readSummary: getReadSummary(),
          recentHistory: loadHistory().slice(-12),
          calendarContext: getCalendarContext(),
          obsidianContext: getObsidianContext(),
        });
        if (result.acted && result.message) {
          log(`[proactive] impulse:${result.impulseDetected} acted:${result.acted} msg:${(result.message||'').slice(0,40)}`);
          const hist = loadHistory();
          hist.push({ role: 'assistant', text: result.message, time: new Date().toISOString() });
          saveHistory(hist);
        }
      } catch (e) {
        log(`[proactive] error: ${e.message}`);
      }
    }, proactive.TICK_INTERVAL_MS);
    log(`Proactive tick loop started (every ${proactive.TICK_INTERVAL_MS/60000}min)`);
  });
}

start().catch(e => {
  console.error('Failed to start:', e);
  process.exit(1);
});
