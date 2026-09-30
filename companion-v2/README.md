# companion-v2 — 人格引擎库 + 调试器

> 定位：从「web 陪伴应用」降级为「**人格引擎库**」——NN 版人格引擎（`persona_engine/`）+ 可观测调试器。
> 未来作为底层组件被内嵌（调试器 / 其他 AI 应用 / 操作系统），聊天主入口在 Claude Code 侧。

## 目录结构

```
companion-v2/
├── persona_engine/          ← NN 版人格引擎（6 个纯内核模块）
│   ├── genome_engine.js      神经网络（5D→8D 信号 + Hebbian + 相变）
│   ├── drive_metabolism.js   驱力代谢（时间箭头 + 情绪温度）
│   ├── style_memory.js       风格记忆（KNN + 结晶 + 蒸发）
│   ├── emotion-state.js      关系状态机（FORMAL/WARMING/TRUSTED/TENSE/RELIEF）
│   ├── style-variator.js     风格变异（话多话少 / 用不用梗）
│   └── context-referencer.js 话题线程追踪
├── genome/                  ← 感知 + 编排 + 阅读（非内核）
│   ├── critic.js             LLM 感知器（8D context + 挫败 delta）
│   ├── proactive.js          主动消息编排
│   └── archive_reader.js     读代码库 → 写 Obsidian（重 IO）
├── shared/                  ← 数据 + 表达层
│   ├── bills-db.js / calendar-db.js   账单 / 日历（sql.js）
│   ├── layer-loader.js                 skill 层加载（表达层）
│   └── self-log.js                     crysis_skill 说过的话记录
├── runner.js                ← 编排：runTurn 把内核串成一轮对话
├── debug-server.js          ← 调试端（只绑 127.0.0.1）
├── public/debug.html        ← 调试面板
└── server.js                ← 退役（旧 web 服务，待删）
```

## 架构：三层 + 编排 + 调试端

```
内核（persona_engine/，纯函数 + 工厂，内在状态）
   ↑ 被 runner 编排
runner.js（一轮对话：metabolize → critic → genome → styleMemory → prompt → LLM）
   ↑ 被调试端驱动
debug-server.js + debug.html（观测窗口，读 trace 渲染）
```

三层分工（呼应人格引擎三层：引擎管状态 / skill 管表达 / 记忆管背景）：

- **内核** `persona_engine/`：纯函数核，零外部依赖，谁都能 `require` 走
- **外围** `genome/` + `shared/`：感知（critic）、编排（proactive）、数据（bills/calendar）、表达（layer/self-log）
- **编排** `runner.js`：把内核串起来，返回完整 trace

## 核心设计：函数式内核 + 命令式外壳

每个内核模块拆两层：

- **纯函数核**：`(state, input) → newState`，不碰文件、不碰全局、随机走 `rng` 参数、时钟走 `now` 参数
- **工厂**：`createXxx({ storage, rng, clock })` 持有 state + 持久化 + 注入随机源，对外接口与旧版单例一致

收益：**可观测**（每环输入输出）、**可实例化**（开多个引擎，多引擎可插拔的地基）、**可复现**（种子注入随机/时钟）。

```js
const { initState, forward, updateWeights } = require('./persona_engine/genome_engine');
const { mulberry32 } = require('./persona_engine/genome_engine');

let state = initState('crysis-v2');
const r = forward(state, driveState, 0.05, context, mulberry32(42)); // 纯函数，同种子可复现
state = r.state;
const w = updateWeights(state, signals, reward, 0.01, mulberry32(7));
```

## 快速开始（调试器）

```bash
node debug-server.js
# 浏览器开 http://127.0.0.1:8767
```

端点：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/trace` | 最新一轮完整 trace |
| POST | `/api/run` | 手动跑一轮 `{ text }` |
| GET | `/api/status` | 各引擎状态摘要 |
| GET | `/api/reset` | 重置 genome |
| GET | `/` | 调试面板 |

## 纯函数 API 速查

| 模块 | 纯函数 | 工厂 |
|---|---|---|
| genome_engine | `initState(seed)` `forward(state, drives, temp, ctx, rng)` `updateWeights(state, target, reward, lr, rng)` | `createGenome({seed, storage, rng})` |
| drive_metabolism | `metabolize(state, now)` `applyFrustrationDelta(state, delta)` `satisfyDrives(state, sat)` `evolveBaselines(state, delta)` `addNoise(signals, temp, rng)` | `createDriveMetabolism({engineParams, storage})` |
| style_memory | `insert(state, ctx, msg, reward)` `retrieve(state, query, k)` `decay(state)` `buildFewShotPrompt(points, lang)` | `createStyleMemory({storage, clock})` |
| emotion-state | `processInteraction(state, scoreResult, now)` | `createEmotionState({storage, clock})` |
| style-variator | `getStylePrompt(state, emotion, drive)` `refreshDaily(state, now, rng)` | `createStyleVariator({now, rng})` |
| context-referencer | `addTurn(state, role, text, topicId, now)` `getActiveThread(state, now)` | `createContextReferencer({now})` |

## runner：runTurn + trace

`createRunner({ engines, critic, llm, systemPrompt, traceSink, ... }).runTurn(userMessage)` 跑一轮，返回：

```js
{
  reply,
  trace: {
    timestamp, userMessage,
    metabolize: { deltaHours, temperature, totalFrustration },
    critic: { context, frustrationDelta, driveSatisfaction, engagementScore, toneHint },
    drives: { drives, temperature, impulse },
    genome: { signals, input, hidden, rawSignals },
    noisySignals, emotion, styleRecall, prompt, reply,
    postProcess: { phaseTransitioned, interactionCount, styleInserted },
  }
}
```

`trace` 就是探针数据，`traceSink` 每轮回调（落盘/广播）。

## 持久化

引擎状态存在 companion-v2 根目录的 `.xxx-v2.json`（`storage` 可注入，调试传 `{ load:()=>null, save:()=>{} }` 走内存态）。

## 路线图

- [ ] **⑤ 加"调"**：面板改参数 / 注入场景 / 单步回放（现在只"能看见"，还不能"调"）
- [ ] **RL 版引擎**：`persona_engine/` 旁边并列，NN 管无目标、RL 管有目标
- [ ] **多引擎调度器**：按场景切 NN/RL
- [ ] **删 server.js**（旧 web 服务）
