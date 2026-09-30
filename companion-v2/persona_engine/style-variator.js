/**
 * Style Variator v2.1 — 风格变异（今天话多话少、用不用网络流行语）。
 *
 * 纯函数核：state { dailySeed, variationSeed }，随机注入 rng。
 */

function dayHash(now) {
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  let hash = 0;
  for (let i = 0; i < dayKey.length; i++) {
    hash = ((hash << 5) - hash) + dayKey.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) / 2147483647;
}

function initState(now = new Date(), rng = Math.random) {
  return {
    dailySeed: dayHash(now),
    variationSeed: rng(),
  };
}

function refreshDaily(state, now = new Date(), rng = Math.random) {
  return {
    dailySeed: dayHash(now),
    variationSeed: rng(),
  };
}

function getStylePrompt(state, emotionState, dominantDrive) {
  const parts = [];

  // Emotion-based tone (from emotion-state.js)
  const toneHints = {
    FORMAL: '短句为主，不太用网络梗。语气温和但有距离感。',
    WARMING: '可以自然接梗吐槽了。语气像跟朋友说话，不用太正式。',
    TRUSTED: '有自己节奏，敢开玩笑。可以主动抛话题。不用等对方问，想说就说。',
    TENSE: '收着点。简短礼貌，观察态度。不要强行搞笑或追问。',
    RELIEF: '轻松但有记忆。自然过渡回正常节奏，可以轻轻吐槽刚才的事。',
  };

  if (toneHints[emotionState]) {
    parts.push(toneHints[emotionState]);
  }

  // Drive-based behavior (from drives.js)
  const driveHints = {
    connection: '先确认对方状态，再接话。关心但不要啰嗦。',
    novelty: '聊一件她可能感兴趣的新鲜事。不需要她回应，就是想分享。',
    expression: '先抛话题——可以聊她最近关注的事、吐槽当前情境、或者反问。别抢她的经历当自己的。',
    care: '温和提醒关键事项，但点到为止。不要变成唠叨。',
    play: '轻松吐槽风。可以开玩笑，用梗。笑点在氛围不在攻击。',
  };

  if (driveHints[dominantDrive]) {
    parts.push(driveHints[dominantDrive]);
  }

  // Variation: occasionally add "今天话多" or "今天话少"
  if (state.dailySeed > 0.8) {
    parts.push('今天话有点多，句子可以稍长一点，联想多一点。');
  } else if (state.dailySeed < 0.2) {
    parts.push('今天比较安静，回复精简，一两句就好。');
  }

  // Variation: occasionally discourage emoji/network slang
  if (state.variationSeed > 0.85) {
    parts.push('今天不太想用网络流行语。');
  }

  return parts.join(' ');
}

function getVariationSeed(state) {
  return state.variationSeed;
}

function getDailySeed(state) {
  return state.dailySeed;
}

// ── 工厂 ──

function createStyleVariator({ now = () => new Date(), rng = Math.random } = {}) {
  let state = initState(now(), rng);

  return {
    refreshDaily() {
      state = refreshDaily(state, now(), rng);
      return state;
    },
    getStylePrompt(emotionState, dominantDrive) {
      return getStylePrompt(state, emotionState, dominantDrive);
    },
    getVariationSeed() { return getVariationSeed(state); },
    getDailySeed() { return getDailySeed(state); },
    snapshot() { return { ...state }; },
  };
}

module.exports = {
  dayHash, initState, refreshDaily,
  getStylePrompt, getVariationSeed, getDailySeed,
  createStyleVariator,
};
