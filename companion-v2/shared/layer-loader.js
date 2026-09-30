// ── Layer Loader ───────────────────────────────────────────
// LLM-powered topic detection for crysis persona layers.
// Falls back to keyword matching when LLM is unavailable.
//
// Layers live in: d:\888\.claude\skills\crysis_skill\layers\

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');

const LAYER_DIR = join(__dirname, '..', '..', '.claude', 'skills', 'crysis_skill', 'layers');
const SELF_PATH = join(__dirname, '..', '..', '.claude', 'skills', 'crysis_skill', 'self.md');

// ── LLM caller (injected by server.js at startup) ──────────
let _callLLM = null; // async (systemPrompt, userPrompt, maxTokens) => string

function setLLMCaller(fn) { _callLLM = fn; }

// ── File cache ────────────────────────────────────────────
let _cache = {};
function _readCached(path) {
  if (_cache[path]) return _cache[path];
  if (!existsSync(path)) return '';
  _cache[path] = readFileSync(path, 'utf-8');
  return _cache[path];
}
function flushCache() { _cache = {}; }

// ── Classification cache ───────────────────────────────────
const _classifyCache = new Map(); // text hash → { layers, time }
const CACHE_MAX = 200;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function _cacheKey(text) {
  // Simple hash: normalize and take first 80 chars
  const n = text.replace(/\s+/g, '').toLowerCase().slice(0, 80);
  return n;
}

function _cacheGet(text) {
  const key = _cacheKey(text);
  const entry = _classifyCache.get(key);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.layers;
  return null;
}

function _cacheSet(text, layers) {
  const key = _cacheKey(text);
  _classifyCache.set(key, { layers, time: Date.now() });
  // Evict oldest if too large
  if (_classifyCache.size > CACHE_MAX) {
    const oldest = [..._classifyCache.entries()]
      .sort((a, b) => a[1].time - b[1].time)[0];
    if (oldest) _classifyCache.delete(oldest[0]);
  }
}

// ── LLM classification ─────────────────────────────────────
const CLASSIFY_SYSTEM = `判断用户消息属于哪些类别，只输出ID用逗号分隔。没有就输出none。

类别：
l2 = 情绪/身体状态：任何情绪词(烦/累/丧/焦虑/崩溃/委屈/生气/难过/无语/孤独/绝望)、身体感受(疼/饿/困/渴/累/头晕/眼睛/失眠/经期)、被折磨(吐槽工作/学习/调bug)、矛盾/不安(想X又不想Y/不知道选/怕学不会/怕来不及)、无力感(算了/随便/不管了/没办法)。看到前男友/新欢/分手必标l2。
l3 = 怎么/如何/X还是Y/A还是B/你觉得/该不该/要不要/怎么办/好不好/对不对/行不行、帮我选/推荐一下、不知道选哪个、纠结/犹豫、考研/分手/offer决策。注意：名词"XX推荐"不算l3，但"给我推荐"/"帮我选"算。
l4 = 人际/社交：朋友/室友/家人/同学/前任/对象、想聊天/不想说话/社恐/吵架/冷落/分手/秀恩爱/孤独+社交
l5 = ACG：动漫/番/游戏/steam/switch/抽卡/氪金/原神/夏促
l6 = 平台/技术：B站/小红书/网易云/bug/代码/编程/网安/CTF/开发/创作/up主/视频
l7 = 写作请求：写长文/影评/分析/评论/文学创作

规则：任何情绪/身体感受/不安/矛盾一律l2。怎么/如何/好不好一律l3。前任=l2+l4。技术吐槽=l2+l6。社交矛盾=l2+l4。

输出示例: l2 / l2,l6 / l2,l3,l4 / l3,l6 / none`;

async function classifyAsync(text) {
  if (!text || text.length < 2) return [];

  // Check cache first
  const cached = _cacheGet(text);
  if (cached !== null) return cached;

  // Short messages (< 10 chars): keyword pre-check for extreme signals
  const keywordIds = _classifyFallback(text);

  // Try LLM if available, merge with keyword results for safety
  let ids;
  if (_callLLM && text.length >= 3) {
    try {
      const raw = await _callLLM(CLASSIFY_SYSTEM, `用户消息: "${text.slice(0, 500)}"`, 64);
      const llmIds = raw.replace(/[^l2-7,]/g, '').split(',').map(s => s.trim()).filter(s => /^l[2-7]$/.test(s));
      // Merge LLM + keyword (keyword catches what LLM misses on short texts)
      ids = [...new Set([...llmIds, ...keywordIds])];
    } catch (_) {
      ids = keywordIds;
    }
  } else {
    ids = keywordIds;
  }

  _cacheSet(text, ids);
  return ids;
}

// ── Keyword fallback (when LLM unavailable) ─────────────────
function _classifyFallback(text) {
  return classify(text); // reuse the sync keyword function
}

// ── Keyword-based classify (sync, fallback + debug) ────────
const L2_EMOTION = [
  /难过|伤心|不开心|好累|心累|焦虑|烦躁|压力|崩[亏溃]|受不了|绝望|无助|烦死|烦[躁闷]|讨厌|无语|虐[心了]|太虐|好虐|麻[了烦]|服了|孤独|寂寞|纠结/,
  /生气|气死|恼怒|委屈|想哭|哭[了过]|深夜|半夜|凌晨|想去?死|不想活|活不下去|没意[思义]|死了算了|丧|emo|抑郁/,
  /安慰|抱抱|摸摸|没事[的了]|会好[起的]|辛苦了|心疼/,
  /情绪|心情|状态不好|不舒服|失眠|睡不[着好]|头晕|发[烧热]|浑身|没[劲力]气/,
  /生病|头[疼痛]|肚子[疼痛]|发烧|感冒|咳嗽|经[期痛]|大姨妈|姨妈/,
  /好[饿困渴累冷热疼痛]|被[说骂喷批嘲]|被吐槽|挨[说骂批]|不想动|动不了|起不来|爬不起|不想[玩看听做干搞]|不知道选|怕学不|怕来不及/,
  /眼睛.*[瞎疼累花酸胀干]|眼[睛]?.*[花酸疼胀干瞎]/,
  /前男友|前女友|分手|新[欢女]|出轨|绿[了帽]/,
  // 隐含情绪
  /搞[了到一].*[没不好错]|全[是都]报错|整[得我].*[疯死]|折腾|折[磨腾].*[半一]/,
  /一[下上][午天晚]|一整[天晚]|整个[周月]|搞死|累[死坏倒]|打不过|玩不[下去]|卡关/,
  /算了|随便|不管了|没办法|就这样|爱[咋怎]/,
  /想.*又[不想怕].*|又[不想怕]/,
];

const L3_DECISION = [
  /你觉得|怎么看|怎么想|给[个点]建议|推荐|建[议言]|好不好|对不对|行不行|帮我[选挑看]/,
  /怎么(?!样[了呀啊]|[样]).|怎么样才能|怎么样可以|如何|选选|选一[下个]|不知道选|哪个/,
  /值[得不]值|要不要|该不该|合[不适]适|划[算不]算/,
  /还是|或者.*选|二选一|纠结|犹豫/,
  /原则|价值观|底[线限]|对不[对起]|应[不该]该/,
];

const L4_SOCIAL = [
  /朋友|同学|室友|舍友|同事|老师|导师|家人|父母|爸妈/,
  /社交|人际|相处|关[系于]|社[恐交]|尬|尴尬/,
  /不回[复消]|怎么[回说]|不知道怎么[接回]|冷[场战]|吵架/,
  /约会|谈恋爱|对象|男朋友|女朋友|前任|前女友|前男友|暧昧|暗恋|秀恩爱|分手/,
  /想[找人]聊|不想[说讲话]|不想跟.*[说话聊]|一个人呆|独[处居]|没[人有]说话/,
];

const L5_ACG = [
  /番|动漫|动画|漫画|追[番剧]|补番|新番|[老新旧]番|追.*[番剧]/,
  /游戏|steam|switch|ps[45]|ns|手游|抽卡|氪金|出货/,
  /角色|人设|剧情|神作|霸权|二[三次]元|ACG|cos|同人|ooc|OC|世界观/,
  /b[站站]|bili|看[了过].*[番剧集话]/,
  /原神|星铁|崩[铁坏]|明日方舟|赛马娘|fate|fgo|塞尔达|老头环|法环|王国之泪|荒野之息|旷野之息|博德|bg3|艾尔登/,
];

const L6_ONLINE = [
  /b[站站]|bilibili|小红书|红书|xhs|网易云|微博|抖音|快手/,
  /网[络安]|安全|漏洞|CTF|capture the flag|渗透|逆向|pwn|web安全/,
  /代码|编程|写[代码码]|程序|开发|开源|github|git|bug|debug|调[了]?.*(bug|错|代码)|报错|修[了复]|部署|服务器/,
  /视频|专栏|创作|up主|同人|写[了篇个]|粉丝|播放|弹幕|评论[区]/,
  /技术|工[具程]|脚本|自动化|AI|人工智能|大模型/,
  /半夜.*[刷看]|凌晨.*[刷看]|熬夜.*[刷看]|刷.*B[站站]/,
];

const L7_WRITING = [
  /写[一一个篇段首些个]|帮我写|帮我润[色改]|写.*教程|写.*指南|改[改写一]下.*文|扩[写充]|缩[写减]/,
  /写[作文评论章析]|长[文评]|深[度析入]|详[细尽]/,
  /[评点分析].*[作品番剧电影书]/,
  /创作|写[诗曲歌]|散[文笔]|小[说讲]|故[事情]/,
  /文学|小说|诗歌|随笔|评论|分析/,
];

function _matchAny(text, patterns) {
  for (const p of patterns) {
    if (p.test(text)) return true;
  }
  return false;
}

function _isLateNight() {
  const h = new Date().getHours();
  return h >= 23 || h <= 5;
}

function classify(text) {
  const layers = [];
  if (_matchAny(text, L2_EMOTION) || _isLateNight()) layers.push('l2');
  if (_matchAny(text, L3_DECISION)) layers.push('l3');
  if (_matchAny(text, L4_SOCIAL)) layers.push('l4');
  if (_matchAny(text, L5_ACG)) layers.push('l5');
  if (_matchAny(text, L6_ONLINE)) layers.push('l6');
  if (_matchAny(text, L7_WRITING) || text.length > 500) layers.push('l7');
  return layers;
}

// ── Content loading ────────────────────────────────────────
function _stripFrontmatter(md) {
  if (!md) return '';
  return md.replace(/^---[\s\S]*?---\n*/, '').trim();
}

function loadLayers(layerIds) {
  const parts = [];

  const selfMd = _readCached(SELF_PATH);
  if (selfMd) {
    parts.push('## crysis 的背景（蔡江艺的个人信息）\n' + _stripFrontmatter(selfMd));
  }

  const fileMap = {
    l2: { file: 'layer-2-emotion.md', title: '## 情感回应参考\n以下描述 crysis 的情感模式，用于理解她此刻可能的情绪反应方式' },
    l3: { file: 'layer-3-decision.md', title: '## 决策思维参考\n以下描述 crysis 的思维模式，用于理解她做选择时的分析框架' },
    l4: { file: 'layer-4-social.md', title: '## 人际行为参考\n以下描述 crysis 的社交风格，用于理解她的人际互动方式' },
    l5: { file: 'layer-5-acg.md', title: '## ACG背景参考\n以下描述 crysis 的二次元背景，用于接ACG梗和话题' },
    l6: { file: 'layer-6-online.md', title: '## 网络身份参考\n以下描述 crysis 的平台和技术背景，用于理解她的创作和技术视角' },
    l7: { file: 'layer-7-writing.md', title: '## 写作指南\ncrysis 的写作风格参考。她需要你按以下方式组织长文' },
  };

  for (const id of layerIds) {
    const cfg = fileMap[id];
    if (!cfg) continue;
    const content = _readCached(join(LAYER_DIR, cfg.file));
    if (content) {
      parts.push(cfg.title + '\n' + _stripFrontmatter(content));
    }
  }

  return parts.join('\n\n');
}

// ── Async prompt injection ─────────────────────────────────
async function getLayerInjection(userText) {
  if (!userText) return '';
  const ids = await classifyAsync(userText);
  if (ids.length === 0) return '';
  const content = loadLayers(ids);
  if (!content) return '';

  return `\n\n## 补充知识（根据当前话题加载：${ids.join(',')}）\n${content}\n\n**注意**：以上是蔡江艺（crysis）的背景信息和思维模式，不是你自己的。用这些来更好地回应她，但不要代入第一人称复述。`;
}

module.exports = { setLLMCaller, classify, classifyAsync, loadLayers, flushCache, getLayerInjection };
