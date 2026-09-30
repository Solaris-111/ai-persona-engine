const { existsSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

const SELF_LOG_FILE = join(__dirname, '.self-log.json');
const MAX_ENTRIES = 500;

let logEntries = [];

function loadSelfLog() {
  try {
    if (existsSync(SELF_LOG_FILE)) {
      const data = JSON.parse(readFileSync(SELF_LOG_FILE, 'utf-8'));
      if (Array.isArray(data)) logEntries = data;
    }
  } catch (_) { logEntries = []; }
}

function saveSelfLog() {
  try {
    if (logEntries.length > MAX_ENTRIES) logEntries = logEntries.slice(0, MAX_ENTRIES);
    writeFileSync(SELF_LOG_FILE, JSON.stringify(logEntries, null, 2));
  } catch (_) {}
}

function addEntry(entry) {
  const now = new Date().toISOString();
  const e = {
    time: entry.time || now,
    type: entry.type || 'observation',
    content: entry.content || '',
    source: entry.source || 'manual',
    ...(entry.relatedTopic ? { relatedTopic: entry.relatedTopic } : {}),
    ...(entry.tags ? { tags: entry.tags } : {}),
  };
  // Deduplicate: same type + similar content within 2 hours
  const twoHours = 2 * 60 * 60 * 1000;
  const cutoff = Date.now() - twoHours;
  const dup = logEntries.find(x =>
    x.type === e.type &&
    x.content === e.content &&
    new Date(x.time).getTime() > cutoff
  );
  if (dup) return dup;
  logEntries.unshift(e);
  saveSelfLog();
  return e;
}

function queryLog({ type, limit = 20, since, topic, source } = {}) {
  let result = [...logEntries];
  if (type) result = result.filter(e => e.type === type);
  if (source) result = result.filter(e => e.source === source);
  if (topic) result = result.filter(e => e.relatedTopic === topic);
  if (since) {
    const sinceMs = new Date(since).getTime();
    result = result.filter(e => new Date(e.time).getTime() >= sinceMs);
  }
  return result.slice(0, Math.min(limit, 100));
}

function getStats() {
  const counts = {};
  for (const e of logEntries) {
    counts[e.type] = (counts[e.type] || 0) + 1;
  }
  const total = logEntries.length;
  const last24h = logEntries.filter(e => Date.now() - new Date(e.time).getTime() < 24 * 3600_000).length;
  return { total, last24h, byType: counts };
}

// Regex patterns to extract self-knowledge from crysis_skill's own messages
const EXTRACTION_PATTERNS = [
  { regex: /吃了?[：:]?\s*(.+?)(?:[，。！？,]|$)/, type: 'food' },
  { regex: /(?:点的?了?|外卖)\s*(.+?)(?:外卖|到了|，|。|！|？|$)/, type: 'food' },
  { regex: /在?(?:食堂|餐厅|饭店|小店)吃了?\s*(.+?)(?:[，。！？,]|$)/, type: 'food' },
  { regex: /看了?(?:一[集话])?\s*(.+?)(?:[，。！？,]|$)/, type: 'media' },
  { regex: /在追\s*(.+?)(?:[，。！？,]|$)/, type: 'media' },
  { regex: /在玩\s*(.+?)(?:[，。！？,]|$)/, type: 'media' },
  { regex: /刷(?:B站|Bilibili|bilibili|小红书)\s*(?:看到|刷到)?\s*(.+?)(?:[，。！？,]|$)/, type: 'media' },
  { regex: /去了?\s*(.+?)(?:[，。！？,]|$)/, type: 'activity' },
  { regex: /在\s*(图书馆|教室|实验室|医院|青旅|宿舍)\s*(.+?)?(?:[，。！？,]|$)/, type: 'activity' },
  { regex: /(?:感觉|觉得)\s*(.+?)(?:[，。！？,]|$)/, type: 'thought' },
  { regex: /在想\s*(.+?)(?:[，。！？,]|$)/, type: 'thought' },
  { regex: /天气\s*(.+?)(?:[，。！？,]|$)/, type: 'weather' },
  { regex: /外面\s*(.+?)(?:[，。！？,]|$)/, type: 'weather' },
];

function extractFromMessage(text) {
  if (!text || typeof text !== 'string') return [];
  const results = [];
  for (const { regex, type } of EXTRACTION_PATTERNS) {
    const m = text.match(regex);
    if (m && m[1] && m[1].trim().length >= 1 && m[1].trim().length < 60) {
      const content = m[1].trim();
      // Skip if content is basically noise
      if (/^[的了呢吗啊呀哦嗯吧]$/.test(content)) continue;
      if (/^(有点|有点|一些|一下)/.test(content) && content.length < 5) continue;
      results.push({ type, content });
      break; // Take first match only
    }
  }
  return results;
}

function getRecentContext(maxEntries = 6, relevantToTopic = null) {
  const cutoff = Date.now() - 48 * 3600_000;
  let recent = logEntries.filter(e => new Date(e.time).getTime() >= cutoff);
  if (relevantToTopic) {
    // Prefer entries related to the topic, but also include others
    const related = recent.filter(e => e.relatedTopic === relevantToTopic);
    const unrelated = recent.filter(e => e.relatedTopic !== relevantToTopic);
    recent = [...related, ...unrelated];
  }
  return recent.slice(0, maxEntries);
}

// Format entries for persona prompt injection
function formatForPrompt(entries) {
  if (!entries || entries.length === 0) return '';
  const lines = entries.map(e => {
    const relTime = fmtRelative(e.time);
    return `- ${e.content}（${relTime}）`;
  });
  return `\n## crysis_skill 最近说的话\n${lines.join('\n')}\n这些是你（crysis_skill）之前说过的话，保持连贯性，但不要用"我"复述这些内容。\n`;
}

function fmtRelative(isoTime) {
  const diff = Date.now() - new Date(isoTime).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.round(hours / 24);
  return `${days}天前`;
}

module.exports = {
  loadSelfLog,
  addEntry,
  queryLog,
  getStats,
  extractFromMessage,
  getRecentContext,
  formatForPrompt,
};
