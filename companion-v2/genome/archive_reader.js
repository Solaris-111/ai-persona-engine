/**
 * Archive Reader v2 — 两阶段智能阅读管线
 *
 * Phase 1: 初次扫描 → 构建代码地图 → 写入 Obsidian
 * Phase 2: 按地图优先级逐文件阅读 → AI 评估 → 写笔记
 *
 * 挂在 companion-v2 tick 上，避开工作高峰期（9-12, 14-18 北京时间）
 */

const { existsSync, readFileSync, writeFileSync, statSync, readdirSync, mkdirSync } = require('fs');
const { join, extname, basename, relative, dirname } = require('path');

// ── Config ──
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || 'd:\\archive';
const OBSIDIAN_DIR = process.env.OBSIDIAN_DIR || 'D:\\888\\claude-memory-compiler';
const OBSIDIAN_READS_DIR = join(OBSIDIAN_DIR, 'ai-reads');
const READ_LOG_FILE = join(__dirname, '..', '.read-log-v2.json');
const READ_INTERVAL_MS = 15 * 60 * 1000;   // 15 min between reads
const MAP_INTERVAL_MS = 60 * 60 * 1000;    // re-scan for new dirs every hour
const MAX_CHARS_PER_READ = 3000;
const MAX_BYTES_PER_FILE = 200 * 1024;
const BATCH_SIZE = 2;                       // read up to 2 small files per tick
const MAX_RETRIES = 3;                      // retry failed reads before giving up

// ── Priority patterns (matched against path) ──
const PRIORITY_PATTERNS = [
  /[/\\]Minecraft\.java$/i,
  /[/\\]SharedConstants\.java$/i,
  /[/\\]Main\.java$/i,
  /[/\\]Server\.java$/i,
  /[/\\]Bootstrap\.java$/i,
  /[/\\]GameRenderer\.java$/i,
  /[/\\]pack\.java$/i,         // package root
  /[/\\]client[/\\]main/i,
  /[/\\]server[/\\]Main/i,
];

// ── Supported extensions ──
const TEXT_EXTS = new Set(['.md', '.txt', '.json', '.csv', '.log', '.xml', '.html', '.css', '.yaml', '.yml', '.toml']);
const CODE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.rb', '.php', '.swift', '.kt', '.scala', '.sh', '.bash', '.zsh', '.sql', '.r', '.lua', '.vim', '.el']);

// ── State ──
let state = {
  reads: [],
  fileProgress: {},
  lastReadAt: null,
  lastMapScan: null,
  totalReads: 0,
  mappedDirs: {},         // { topDir: { packages: { pkgName: [files] }, priorityFiles: [], totalFiles: N, scannedAt } }
};

// ── Obsidian write ──
function writeNoteToObsidian(entry) {
  try {
    mkdirSync(OBSIDIAN_READS_DIR, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const relPath = entry.file.replace(/\\/g, '/');

    // Stable filename based on source file, not title — so continuations update same note
    const safeName = entry.basename.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const filename = `${dateStr} - ${safeName}.md`;
    const filePath = join(OBSIDIAN_READS_DIR, filename);

    const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    if (entry.isContinuation && existsSync(filePath)) {
      // Append to existing note
      let existing = readFileSync(filePath, 'utf-8');

      // Update frontmatter chars
      existing = existing.replace(
        /^chars: \d+\/\d+/m,
        `chars: ${entry.charCount}/${entry.totalChars}`
      );
      existing = existing.replace(
        /^worth: (true|false)/m,
        `worth: ${entry.worth || true}`
      );

      // Remove old "待续读" marker
      existing = existing.replace(/ 🔄 待续读/g, '');
      const contTag = !entry.done ? ' 🔄 待续读' : '';

      const section = `\n---\n\n## 续读 · ${ts}\n\n${entry.note}\n`;
      const finalContent = existing.replace(/\n$/, '') + section;
      writeFileSync(filePath, finalContent, 'utf-8');
      return filePath;
    }

    // New note
    const tags = entry.worth ? '📌 有价值' : '⏭ 跳过';
    const contTag = !entry.done ? ' 🔄 待续读' : '';

    const content = `---
date: ${dateStr}
source: "${relPath}"
worth: ${entry.worth}
chars: ${entry.charCount}/${entry.totalChars}
tags: [ai-read${entry.worth ? ', worth-reading' : ''}]
---

# ${entry.title}

**来源：** \`${relPath}\`
**标签：** ${tags}${contTag}
**阅读时间：** ${ts}

---

${entry.note}
`;
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  } catch (e) {
    return null;
  }
}

function writeMapToObsidian(mapData) {
  try {
    mkdirSync(OBSIDIAN_READS_DIR, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `${dateStr} - 代码地图 - ${mapData.name}.md`;
    const filePath = join(OBSIDIAN_READS_DIR, filename);

    let pkgList = '';
    const sorted = Object.entries(mapData.packages).sort((a, b) => b[1].length - a[1].length);
    for (const [pkg, files] of sorted) {
      pkgList += `- **${pkg}** — ${files.length} 个文件\n`;
      // Show first 3 files as sample
      const samples = files.slice(0, 3).map(f => '  - `' + f.replace(/\\/g, '/').split('/').pop() + '`').join('\n');
      if (samples) pkgList += samples + '\n';
      if (files.length > 3) pkgList += `  - ... 还有 ${files.length - 3} 个\n`;
    }

    const priorityList = mapData.priorityFiles.length > 0
      ? mapData.priorityFiles.map(f => '- `' + f.replace(/\\/g, '/') + '`').join('\n')
      : '（无匹配的优先文件）';

    const content = `---
date: ${dateStr}
type: code-map
project: ${mapData.name}
totalFiles: ${mapData.totalFiles}
packages: ${Object.keys(mapData.packages).length}
scannedAt: ${new Date().toISOString()}
tags: [ai-read, code-map]
---

# 代码地图：${mapData.name}

**扫描时间：** ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
**总文件数：** ${mapData.totalFiles}
**包数量：** ${Object.keys(mapData.packages).length}
**优先文件：** ${mapData.priorityFiles.length} 个

---

## 优先阅读队列

${priorityList}

---

## 包结构

${pkgList}
`;
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  } catch (e) {
    return null;
  }
}

// ── Persistence ──
function loadState() {
  try {
    if (existsSync(READ_LOG_FILE)) {
      const data = JSON.parse(readFileSync(READ_LOG_FILE, 'utf-8'));
      state = { ...state, ...data };
    }
  } catch (_) {}
}

function saveState() {
  try {
    writeFileSync(READ_LOG_FILE, JSON.stringify(state, null, 2));
  } catch (_) {}
}

// ── Beijing time helpers ──
function beijingHour() {
  const now = new Date();
  const bj = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return bj.getHours();
}

function shouldSkipWorkHours() {
  const h = beijingHour();
  if (h >= 2 && h < 6) return 'sleep';
  if ((h >= 9 && h < 12) || (h >= 14 && h < 18)) return 'work_peak';
  return null;
}

function shouldAct(now, intervalMs, lastTime) {
  const skip = shouldSkipWorkHours();
  if (skip) return { ok: false, reason: skip };
  if (lastTime && (now - lastTime) < intervalMs) {
    const remain = Math.round((intervalMs - (now - lastTime)) / 60000);
    return { ok: false, reason: `cooldown(${remain}min)` };
  }
  return { ok: true, reason: null };
}

// ── Phase 1: Build code map ──
function isReadableFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  return TEXT_EXTS.has(ext) || CODE_EXTS.has(ext);
}

function findTopDirs() {
  if (!existsSync(ARCHIVE_DIR)) return [];
  const dirs = [];
  try {
    const entries = readdirSync(ARCHIVE_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        dirs.push({ name: e.name, path: join(ARCHIVE_DIR, e.name) });
      }
    }
  } catch (_) {}
  return dirs;
}

function buildCodeMap(topDir) {
  const packages = {};
  const priorityFiles = [];
  let totalFiles = 0;

  function walk(dir, pkgPrefix) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const subPkg = pkgPrefix ? pkgPrefix + '.' + entry.name : entry.name;
          walk(fullPath, subPkg);
        }
      } else if (entry.isFile() && !entry.name.startsWith('.') && isReadableFile(fullPath)) {
        try {
          const st = statSync(fullPath);
          if (st.size > MAX_BYTES_PER_FILE) continue;
          totalFiles++;

          const relPath = relative(ARCHIVE_DIR, fullPath);
          const pkg = pkgPrefix || '(root)';
          if (!packages[pkg]) packages[pkg] = [];
          packages[pkg].push(relPath);

          // Check priority
          for (const pattern of PRIORITY_PATTERNS) {
            if (pattern.test(relPath)) {
              priorityFiles.push(relPath);
              break;
            }
          }
        } catch (_) {}
      }
    }
  }

  walk(topDir.path, '');

  // Sort priority files: closer to root first, then by name
  priorityFiles.sort((a, b) => {
    const aDepth = a.split(/[/\\]/).length;
    const bDepth = b.split(/[/\\]/).length;
    if (aDepth !== bDepth) return aDepth - bDepth;
    return a.localeCompare(b);
  });

  return {
    name: topDir.name,
    path: topDir.path,
    packages,
    priorityFiles,
    totalFiles,
    scannedAt: Date.now(),
  };
}

function ensureMaps() {
  const topDirs = findTopDirs();
  let newMaps = 0;

  for (const td of topDirs) {
    if (!state.mappedDirs[td.name]) {
      const map = buildCodeMap(td);
      state.mappedDirs[td.name] = map;
      const obsPath = writeMapToObsidian(map);
      if (obsPath) newMaps++;
    }
  }

  if (newMaps > 0) {
    state.lastMapScan = Date.now();
    saveState();
  }

  return newMaps;
}

/**
 * Get a unified priority-ordered reading queue across all mapped projects.
 * Priority files first, then files in large packages, then everything else.
 */
function getReadingQueue() {
  const queue = [];

  for (const [projName, map] of Object.entries(state.mappedDirs)) {
    // 1. Priority files first
    for (const relPath of map.priorityFiles) {
      const fullPath = join(ARCHIVE_DIR, relPath);
      if (!isFilePending(fullPath)) continue;
      queue.push({ path: fullPath, priority: 0, source: `${projName}/priority` });
    }

    // 2. Large packages next (sorted by file count desc)
    const sortedPkgs = Object.entries(map.packages)
      .sort((a, b) => b[1].length - a[1].length);

    for (const [pkgName, files] of sortedPkgs) {
      // Skip if this pkg was already covered by priorityFiles
      for (const relPath of files) {
        const fullPath = join(ARCHIVE_DIR, relPath);
        if (!isFilePending(fullPath)) continue;
        // Check if not already in queue
        if (queue.find(q => q.path === fullPath)) continue;
        queue.push({ path: fullPath, priority: 1, source: `${projName}/${pkgName}` });
      }
    }
  }

  return queue;
}

function isFilePending(fullPath) {
  // Already fully read?
  const prog = state.fileProgress[fullPath];
  if (prog && prog.done) return false;
  // File still exists?
  if (!existsSync(fullPath)) return false;
  try {
    const st = statSync(fullPath);
    if (st.size > MAX_BYTES_PER_FILE) return false;
  } catch (_) { return false; }
  return true;
}

// ── Import / boilerplate skip ──
const IMPORT_RE = /^\s*import\s+/;
const PACKAGE_RE = /^\s*package\s+/;
const COMMENT_RE = /^\s*(\/\/|\/\*|\*|#)/;

function isBoilerplate(line) {
  const t = line.trim();
  return !t || COMMENT_RE.test(t) || PACKAGE_RE.test(t) || IMPORT_RE.test(t);
}

function findFirstRealLine(raw) {
  const lines = raw.split('\n');
  let pos = 0;
  for (const line of lines) {
    if (!isBoilerplate(line)) return pos;
    pos += line.length + 1; // +1 for \n
  }
  return -1; // entire file is boilerplate
}

// ── Phase 2: Read files ──
function readContent(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const prog = state.fileProgress[filePath];
    let startPos = (prog && !prog.done) ? prog.readChars : 0;
    let skipped = 0;

    // New file: scan past import/package/comment block
    const ext = extname(filePath).toLowerCase();
    if (CODE_EXTS.has(ext) && startPos === 0 && !prog) {
      const codeStart = findFirstRealLine(raw);
      if (codeStart > 0) {
        skipped = codeStart;
        startPos = codeStart;
      }
    }

    // Content fully read but LLM evaluation failed — re-read from start for re-evaluation
    let reEval = false;
    if (startPos >= raw.length && prog && !prog.done) {
      startPos = 0;
      skipped = 0;
      reEval = true;
    }

    const chunk = raw.slice(startPos, startPos + MAX_CHARS_PER_READ);
    const newPos = reEval ? raw.length : startPos + chunk.length;
    const done = newPos >= raw.length;

    return {
      text: chunk,
      totalChars: raw.length,
      readChars: newPos,
      done,
      isContinuation: reEval ? false : (startPos > 0),
      skippedImport: skipped > 0,
      skippedChars: skipped,
      mtime: statSync(filePath).mtimeMs,
    };
  } catch (e) {
    return null;
  }
}

// ── AI reader ──
async function evaluateAndNote(llmCaller, filePath, textInfo, mapContext) {
  const fname = basename(filePath);
  const contLabel = textInfo.isContinuation ? '（续上次未读完的部分）' : '';
  const progressLabel = textInfo.done ? '' : `（全文共 ${textInfo.totalChars} 字，本次仅读了前 ${textInfo.readChars} 字，还有剩余待下次续读）`;
  const ctxLabel = mapContext ? `\n代码库上下文：${mapContext}\n` : '';

  const prompt = `你是一个有好奇心的读者。下面是刚从资料库中抽到的一篇内容${contLabel}。
${ctxLabel}
文件名：${fname}
${progressLabel}

=== 内容 ===
${textInfo.text}
=== 结束 ===

读完后请判断：
1. 是否值得记录？（纯配置、依赖列表、重复内容、毫无新信息的不值得）
2. 如果值得，写一段读后感——不是复述原文，是你的感受和想法。长度由信息密度决定。

输出 JSON（不要 markdown 包裹）：
{"worth": true/false, "title": "给你的简短标题", "note": "读后感（不值得时写原因，一句带过）"}`;

  try {
    const raw = await llmCaller(prompt, '', 500);
    if (!raw) return { worth: false, title: fname, note: '（读取失败）' };

    let cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').replace(/<think>[\s\S]*?<\/think>/g, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}') + 1;
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end);

    const result = JSON.parse(cleaned);
    return {
      worth: !!result.worth,
      title: result.title || fname,
      note: result.note || '（无笔记）',
    };
  } catch (e) {
    const cleaned = (raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (cleaned && cleaned.length > 5) {
      return { worth: true, title: fname, note: cleaned.slice(0, 500) };
    }
    return { worth: false, title: fname, note: '（解析失败: ' + e.message + '）' };
  }
}

function saveEntry(filePath, textInfo, evaluation) {
  const isCont = textInfo.isContinuation || false;
  const entry = {
    file: filePath,
    basename: basename(filePath),
    time: new Date().toISOString(),
    title: evaluation.title,
    note: evaluation.note,
    worth: evaluation.worth,
    charCount: textInfo.readChars,
    totalChars: textInfo.totalChars,
    done: textInfo.done,
    isContinuation: isCont,
  };

  if (textInfo.done) {
    state.fileProgress[filePath] = { readChars: textInfo.readChars, totalChars: textInfo.totalChars, done: true };
  } else {
    state.fileProgress[filePath] = { readChars: textInfo.readChars, totalChars: textInfo.totalChars, done: false };
  }

  state.reads.push(entry);
  state.totalReads++;
  state.lastReadAt = Date.now();

  const obsPath = writeNoteToObsidian(entry);
  if (obsPath) entry._obsidianPath = obsPath;

  if (state.reads.length > 500) state.reads = state.reads.slice(-500);

  // Clean up old done entries
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [fp, prog] of Object.entries(state.fileProgress)) {
    if (prog.done) {
      const readEntry = state.reads.find(r => r.file === fp && r.done);
      if (readEntry && new Date(readEntry.time).getTime() < weekAgo) {
        delete state.fileProgress[fp];
      }
    }
  }

  saveState();
  return entry;
}

// ── Main tick ──
async function tick(llmCaller) {
  const now = Date.now();

  // ── Phase 1: Check for new projects to map ──
  const mapGate = shouldAct(now, MAP_INTERVAL_MS, state.lastMapScan);
  if (mapGate.ok) {
    const newMaps = ensureMaps();
    if (newMaps > 0) {
      return { acted: true, phase: 'map', newMaps, reason: `scanned ${newMaps} new project(s)` };
    }
    state.lastMapScan = now;
    saveState();
  }

  // ── Phase 2: Read files ──
  const readGate = shouldAct(now, READ_INTERVAL_MS, state.lastReadAt);
  if (!readGate.ok) return { acted: false, reason: readGate.reason };

  const queue = getReadingQueue();
  if (queue.length === 0) {
    state.lastReadAt = now;
    saveState();
    return { acted: false, reason: 'queue_empty' };
  }

  // Batch: read up to BATCH_SIZE files per tick
  let skippedBatch = 0;
  const results = [];
  for (let i = 0; i < BATCH_SIZE && i < queue.length; i++) {
    const item = queue[i];
    const textInfo = readContent(item.path);
    if (!textInfo) {
      const retries = ((state.fileProgress[item.path] || {}).retries || 0) + 1;
      state.fileProgress[item.path] = { readChars: 0, totalChars: 0, done: retries >= MAX_RETRIES, retries };
      if (retries >= MAX_RETRIES) {
        state.reads.push({ file: item.path, basename: basename(item.path), time: new Date().toISOString(), title: '（读取失败）', note: '重试 ' + MAX_RETRIES + ' 次后放弃。', worth: false, charCount: 0, totalChars: 0, done: true });
        state.totalReads++;
      }
      state.lastReadAt = Date.now();
      saveState();
      continue;
    }

    // Auto-skipped import block — no LLM call needed
    if (textInfo.skippedImport) {
      const fname = basename(item.path);
      const tag = textInfo.isContinuation ? '' : '';
      state.fileProgress[item.path] = { readChars: textInfo.readChars, totalChars: textInfo.totalChars, done: textInfo.done };
      state.reads.push({
        file: item.path, basename: fname,
        time: new Date().toISOString(),
        title: fname + ' (import区)',
        note: '跳过 ' + textInfo.skippedChars + ' 字 import 声明，自动推进到代码区。',
        worth: false, charCount: textInfo.readChars,
        totalChars: textInfo.totalChars, done: textInfo.done,
      });
      state.totalReads++;
      state.lastReadAt = Date.now();
      skippedBatch++;
      saveState();
      continue;
    }

    if (!textInfo.text || textInfo.text.trim().length < 10) {
      const retries = ((state.fileProgress[item.path] || {}).retries || 0) + 1;
      state.fileProgress[item.path] = { readChars: 0, totalChars: 0, done: retries >= MAX_RETRIES, retries };
      if (retries >= MAX_RETRIES) {
        state.reads.push({ file: item.path, basename: basename(item.path), time: new Date().toISOString(), title: '（内容过短）', note: '重试 ' + MAX_RETRIES + ' 次后内容仍不足。', worth: false, charCount: 0, totalChars: 0, done: true });
        state.totalReads++;
      }
      state.lastReadAt = Date.now();
      saveState();
      continue;
    }

    const projName = item.source.split('/')[0];
    const mapData = state.mappedDirs[projName];
    const mapContext = mapData
      ? `项目: ${mapData.name}, 总${mapData.totalFiles}文件, 包: ${item.source}`
      : null;

    const evaluation = await evaluateAndNote(llmCaller, item.path, textInfo, mapContext);

    // LLM failed — don't mark done, retry later
    if (evaluation.note === '（读取失败）') {
      const retries = ((state.fileProgress[item.path] || {}).retries || 0) + 1;
      const giveUp = retries >= MAX_RETRIES;
      state.fileProgress[item.path] = { ...state.fileProgress[item.path], retries, done: giveUp };
      if (giveUp) {
        state.reads.push({ file: item.path, basename: basename(item.path), time: new Date().toISOString(), title: '（LLM失败）', note: '重试 ' + MAX_RETRIES + ' 次后仍无法读取。', worth: false, charCount: 0, totalChars: textInfo.totalChars, done: true });
        state.totalReads++;
      }
      state.lastReadAt = Date.now();
      saveState();
      continue;
    }

    const entry = saveEntry(item.path, textInfo, evaluation);
    // Clear retries on success
    if (state.fileProgress[item.path]) state.fileProgress[item.path].retries = 0;
    results.push({
      file: basename(item.path),
      title: evaluation.title,
      worth: evaluation.worth,
      notePreview: evaluation.note.slice(0, 60),
      done: textInfo.done,
    });
  }

  return {
    acted: results.length > 0,
    phase: 'read',
    batch: results,
    queueRemaining: queue.length - results.length,
  };
}

// ── Public API ──
function getReadLog(limit = 50) {
  const mappedProjects = Object.entries(state.mappedDirs).map(([name, m]) => ({
    name,
    totalFiles: m.totalFiles,
    packages: Object.keys(m.packages).length,
    priorityFiles: m.priorityFiles.length,
    scannedAt: m.scannedAt,
  }));

  return {
    reads: state.reads.slice(-limit).reverse(),
    totalReads: state.totalReads,
    lastReadAt: state.lastReadAt,
    lastMapScan: state.lastMapScan,
    mappedProjects,
    activeWindows: '6:00-8:59, 12:00-13:59, 18:00-次日1:59 (北京时间)',
    silentWindows: '9:00-11:59, 14:00-17:59 (工作高峰), 2:00-5:59 (睡眠)',
    archiveDir: ARCHIVE_DIR,
    intervalMin: READ_INTERVAL_MS / 60000,
    batchSize: BATCH_SIZE,
  };
}

// ── Init ──
loadState();
// Auto-map on first load
ensureMaps();

module.exports = {
  tick,
  getReadLog,
  loadState,
  saveState,
  ARCHIVE_DIR,
};
