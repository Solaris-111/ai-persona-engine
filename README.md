# Genome 人格引擎：一个靠「随机网络 + 时间箭头」长出来的 AI 人格

> 这篇文章讲 companion-v2 里的人格引擎是怎么用数学撑起来的。
> 不吹概念，每个公式都能在源码里找到对应行。

## 为什么不用规则表

给 AI 做人格，最省事的路子是写 if-else：`if 用户冷落 → 语气疏远`、`if 深夜 → 温柔`。

这种写法的天花板是「你写得多细，它就像得多死」。人格一旦变成规则表，就只剩两种情况：规则覆盖到的地方像机器人，覆盖不到的地方露馅。

Genome 换了条路：**人格不做任何硬编码，从一个随机神经网络长出来，靠对话反馈不断塑形**。

具体是这样一条管线：

```
用户消息
  → Critic（LLM 感知：读情绪，输出 8D 上下文 + 5D 挫败变化 + 5D 满足度）
  → DriveMetabolism（时间箭头：5 个驱力随时间的代谢）
  → GenomeEngine（随机网络：28D 驱力状态 → 8D 行为信号）
  → StyleMemory（KNN：检索相似历史，拼 few-shot）
  → 组装 prompt → 喂给 LLM
```

四个模块里，DriveMetabolism、GenomeEngine、StyleMemory 是真正的「算法」，Critic 是 LLM 调用（接口层）。下面逐个拆。

---

## 0. 旧版：v1 的渴望度模型（定时主动说话+渴望度计算）


**渴望度** —— 一个随时间增长的指数函数：

$$
P(t) = 1 - e^{-\lambda t}
$$

- $P$：当前「想主动说话」的渴望度，从 0 逼近 1
- $t$：距上次互动的时间
- $\lambda$：增长速度。**越大越黏人**，而且有个更直观的读法——$1/\lambda$ 就是「平均多久主动一次」

代码里实际用过两个 $\lambda$，对应两种性格：

| 性格 | $\lambda$ | 平均间隔 $1/\lambda$ | 到 50% 渴望度 |
|---|---|---|---|
| 黏人 | 0.35 | 约 2.9 小时 | 约 2 小时 |
| 随和 | 0.15 | 约 6.7 小时 | 约 4.6 小时 |

同一套公式，只改这一个数，就是两个脾气完全不同的人。具体到「过了多久，有多想主动」：

| 距上次互动 | λ=0.35（黏人） | λ=0.15（随和） |
|---|---|---|
| 30 分钟 | 16.0% | 7.2% |
| 2 小时 | 50.3% | 25.9% |
| 8 小时 | 93.9% | 69.9% |
| 24 小时 | 99.98% | 97.3% |


**掷骰 + 裁决** —— 每 30 分钟跑一次：

```
rollDice():
    if random() < P(t):      # 渴望度触发
        调 LLM 裁决「现在该不该主动说、说什么」
```

注意这不是纯概率——渴望度$P$ 触发的只是「让 LLM 看一眼」，真正发不发、发什么，是 LLM 兜底判断。概率负责「别错过该主动的时机」，LLM 负责「别在不该打扰的时候打扰/主动发什么话题」。

**定时触发器** —— 三个写死的时间点兜底：早安 8:00、睡前 23:00、熬夜检测 0:30 / 1:30。

就这些。一个公式 + 一个 30 分钟掷骰 + 三个定时点，足够做出「会主动关心你的 AI」。

它的问题只有一个，但很致命：**每次掷骰是「无记忆的此刻」**。这一轮它黏不黏人，和上一轮没有任何关系——人格是散的，没有惯性。后面 v2 那一整套（$F_{eq}$ 平衡点、recurrent state、相变）就是为了补这一个洞。

所以选型很简单：**要「会主动发消息」→ 定时任务+渴望度泊松分布够用；要「有个稳定的、会变的、有惯性的人格」→ 需要上 v2 genome人格引擎。**

---

## 总论：v2 的算法是「生物启发」，不是「最优解」

v2 genome人格引擎的核心目标是做一个**会自己演化、有惯性的人格**，不是「能准确预测下一句该说什么」的模型。所以它的算法选型依据不是「工程上效率最高」，而是「这样最像活的」。

每个算法都是一个生物现象的翻译：

| 算法 | 在模拟什么 | 大白话 |
|---|---|---|
| 随机网络 + 种子 | 基因 | 人不是白纸，生下来带个随机底子 |
| Hebbian + reward | 学习 + 教训 | 一起放电的神经元连得更紧；做对了记住，做错了改 |
| 时间箭头（$F_{eq}$ 平衡点） | 情绪惯性 | 余怒不会瞬间消，慢慢驰豫到一个消不干净的底 |
| 情绪温度 tanh | 情绪化 | 越气越不可预测 |
| 相变 | 量变到质变 | 压死骆驼的最后一根稻草，攒够了突然变 |
| recurrent state | 内在心情 | 人有个持续状态，不是每句话从零算 |
| baseline 演化 | 敏感度会变 | 被冷落多了，下次更容易受伤 |
| Hawking 辐射 | 遗忘 | 记忆褪色，但不彻底消失 |


时间箭头、recurrent state、baseline 演化，让状态「有来处、有记忆、会变」，解决「人格一致性」这个核心问题。

Hebbian学习、相变、Hawking 辐射，用于辅助系统演化，Hebbian学习用 28→24→8 的小随机网络学习，实时传递+毫秒级运算，适合高频聊天的场景；相变模拟AI失望至极导致情绪崩溃，不可控地导致性格变化；Hawking 辐射本质就是「指数衰减 + 质量保底 」，模拟记忆的遗忘。

**用这些机制，是为了让 AI 人格有「活的质感」，不是因为它们是最优算法。** 实测下来比使用强化学习算法目的性更少，聊天更不可控，这是“活人感”的前提。

---

## 1. DriveMetabolism：时间箭头

这是五驱力（connection / novelty / expression / safety / play）的代谢引擎。核心是两个方向相反的时间方程。

### 1.1 挫败冷却：有平衡点的指数衰减

挫败上有两个相反的作用力在打架：

- **饥饿**：孤独、无聊会随时间匀速累积（速率 $k$，单位/小时），把挫败往上顶
- **冷却**：挫败越大、消退越快（速率 $\lambda$），把它往下拉

合起来是一个一阶线性微分方程：

$$
\frac{dF}{dt} = k - \lambda F
$$

**先求平衡点**——令 $dF/dt = 0$，看两个力抵消时挫败停在哪：

$$
k - \lambda F = 0 \;\Rightarrow\; F_{eq} = \frac{k}{\lambda}
$$

**再解方程**。把原式改写成「距平衡点的偏差」的形式：

$$
\frac{dF}{dt} = -\lambda\left(F - \frac{k}{\lambda}\right) = -\lambda\,(F - F_{eq})
$$

令 $G(t) = F(t) - F_{eq}$，表示当前挫败离平衡点还差多少，代入：

$$
\frac{dG}{dt} = -\lambda G
$$

这个就是指数衰减，解为 $G(t) = G_0\, e^{-\lambda t}$。把 $G$ 代回 $F$：

$$
F(t) = (F_0 - F_{eq})\,e^{-\lambda t} + F_{eq}
$$

对应代码：

```js
const decayFactor = Math.exp(-FRUSTRATION_DECAY_LAMBDA * deltaHours); // λ = 0.08 /h
driveState[d].frustration = (driveState[d].frustration - feq) * decayFactor + feq;
```

**这里真正有意思的是 $F_{eq}$——平衡点不是 0。**

每个驱力的平衡点 $F_{eq} = k / \lambda$（饥饿速率 ÷ 冷却速率）：

| 驱力 | 饥饿速率 $k$ | 平衡点 $F_{eq}$ | 含义 |
|---|---|---|---|
| connection | 0.15 | **1.875** | 孤独的挫败长期稳定在 1.875，不会消失 |
| novelty | 0.05 | **0.625** | 无聊的挫败稳定在 0.625 |
| expression / safety / play | — | **0** | 会完全冷却归零 |

这意味着：**connection 和 novelty 的挫败永远存在一个正的「地板」**。一个人如果长期没人理，connection 挫败不会无限涨、也不会自己好，而是驰豫到 1.875 这个恒定值——这是「时间有方向」的数学来源：状态不可逆地朝平衡点流，而不是随便回到初始。

### 1.2 饥饿累积：线性增长

另一边，驱力值随时间线性增长（饥饿）：

```js
driveState[d].value = Math.min(1.0, driveState[d].value + driveState[d].hungerRate * deltaHours * 0.5);
```

$$
v(t + \Delta t) = \min(1,\; v(t) + k \cdot \Delta t \cdot 0.5)
$$

### 1.3 满足度衰减

满足感同样指数衰减，只是速率更快（λ=0.3）：

$$
s(t) = s_0 \cdot e^{-0.3\Delta t}
$$

### 1.4 情绪温度：tanh 饱和

所有驱力的挫败加起来，通过 tanh 压进一个有界的「温度」：

$$
T = T_{max} \cdot \tanh\!\left(\frac{F_{total}}{\tau}\right) + T_{floor}
$$

代入常量（$T_{max}=0.30,\ \tau=2.5,\ T_{floor}=0.03$）：

$$
T = 0.30 \cdot \tanh(0.4 \cdot F_{total}) + 0.03
$$

```js
const maxTemp = TEMP_COEFF * 2.5;              // 0.30
return maxTemp * Math.tanh(total * TEMP_COEFF / maxTemp) + TEMP_FLOOR;
```

温度越高，下一步给网络注入的噪声越大（见 3.2）——挫败越多，行为越不可预测。这是「情绪不稳定」的数学化。

### 1.5 baseline 演化：不对称的敏感度

每个驱力有个基线（baseline），会随挫败变化而漂移，且**升快降慢**：

$$
\text{baseline} \leftarrow
\begin{cases}
\min(0.9,\ \text{baseline} + 0.01 \cdot \Delta F) & \Delta F > 0 \text{（被冷落，更敏感）} \\
\max(0.1,\ \text{baseline} + 0.005 \cdot \Delta F) & \Delta F < 0 \text{（被满足，慢慢放松）}
\end{cases}
$$

被冷落一次，敏感度立刻涨；被安抚一次，敏感度只降一半速度。这是个「记打不记吃」的设计。

---

## 2. Critic：LLM 感知器（接口层）

不是数学算法，是 LLM 调用。给定用户消息 + 当前驱力状态，输出四组量：

$$
C: (\text{text}, \text{state}) \mapsto (\, \underbrace{c \in [0,1]^8}_{\text{8D 上下文}},\ \underbrace{\Delta F \in [-1,1]^5}_{\text{挫败变化}},\ \underbrace{\Delta S \in [0,0.3]^5}_{\text{满足量}},\ \underbrace{e \in [0,1]}_{\text{投入度}} \,)
$$

其中 8D 上下文和 GenomeEngine 的 8D 信号同构（directness / vulnerability / playfulness / initiative / depth / warmth / defiance / curiosity），作用见 3.2 的 context blending。

---

## 3. GenomeEngine：随机神经网络

这是人格核心。一个两层随机网络，把 28D 驱力状态映射成 8D 行为信号，然后用 Hebbian 学习随对话演化。

### 3.1 初始化：种子高斯

权重全部随机初始化，但用**带种子的 PRNG**（mulberry32）+ Box-Muller 生成高斯：

$$
W_1 \sim \mathcal{N}(0, 0.6^2)_{24 \times 28},\quad b_1 \sim \mathcal{N}(0, 0.3^2)_{24}
$$
$$
W_2 \sim \mathcal{N}(0, 0.2^2)_{8 \times 24},\quad b_2 \sim \mathcal{N}(0, 0.2^2)_{8}
$$

**同一个 seed → 完全相同的初始人格**。人格不是「训练」出来的，而是「从种子长出来、再被反馈塑形」的。这给「人格可复现」一个干净的定义。

### 3.2 前向传播

输入向量 $\mathbf{x} \in \mathbb{R}^{28}$ 的构造：

$$
\mathbf{x} = [\, \underbrace{v_d,\ \frac{F_d}{5},\ k_d,\ s_d}_{\text{每驱力 4 特征} \times 5}\,;\ \underbrace{\mathbf{r}}_{\text{recurrent 8D}}\,]
$$

即 5 个驱力各 4 个特征（当前值、归一化挫败、饥饿速率、满足度）+ 8 维循环状态。

**隐藏层**（24D，带温度噪声）：

$$
z^{(h)}_i = b_{1i} + \sum_j W_{1ij} x_j + \epsilon,\qquad \epsilon \sim \mathcal{N}(0, (0.15\,T)^2)
$$
$$
h_i = \tanh(z^{(h)}_i)
$$

**循环状态更新**：取隐藏层前 8 个单元作为下一轮的 recurrent state（网络自带记忆，不是纯前馈）：

$$
\mathbf{r} \leftarrow h_{0:8}
$$

**输出层**（8D 信号）：

$$
z^{(o)}_i = (b_{2i} + \text{kick}_i) + \sum_j W_{2ij} h_j
$$
$$
z^{(o)}_i \leftarrow \frac{z^{(o)}_i}{\sqrt{24/3}} = \frac{z^{(o)}_i}{\sqrt{8}}
$$
$$
s_i = \sigma\!\big(\text{clip}(z^{(o)}_i, -10, 10)\big) = \frac{1}{1 + e^{-z^{(o)}_i}}
$$

那个 $\sqrt{8}$ 的缩放是点睛之笔——和 Transformer 里 $\sqrt{d_k}$ 的作用一样，防止 $z^{(o)}$ 太大把 sigmoid 压进饱和区，让信号保持在一个「能被激活」的区间。

**Context blending**：如果 Critic 提供了 8D 上下文，网络自身输出和 LLM 感知结果按 7:3 混合：

$$
s_i \leftarrow 0.7\, s_i + 0.3\, c_i
$$

网络是「人格的惯性」，Critic 是「对当下的感知」，7:3 是「我是什么人」压过「你这一刻怎么样」。

### 3.3 Hebbian 学习：共激活 + 结果好，才增强

核心更新，把「这次表现好」回灌进权重：

$$
lr = 0.01 \cdot (1 + |r|)
$$

$$
\Delta W_{2ij} = lr \cdot r \cdot (t_i - 0.5) \cdot h_j
$$

$$
\Delta W_{1ij} = lr \cdot 0.3 \cdot r \cdot h_i \quad \text{（仅当 } |r|>0.05 \wedge |h_i|>0.15\text{）}
$$

这里有两处值得说：

**① reward 有符号**：$r$ 是带符号的回报，好结果 $r>0$ 增强、坏结果 $r<0$ 削弱。这是 Hebbian（「一起放电就连一起」）叠了 reward 调制（「还得结果好」），否则纯 Hebbian 会让权重无界漂移。

**② W1 的更新是「近似」**：标准 Hebbian 应该是 $\Delta W_{1ij} \propto x_j \cdot h_i$（输入×隐藏同时激活才增强）。但源码里 W1 的更新**没有乘 $x_j$**，是整行加同一个增量 `lr * 0.3 * reward * h_i`。代码注释也老实标了：

```js
// Approximate input from last forward pass
for (let j = 0; j < INPUT_SIZE; j++) {
  W1[i][j] += lr * 0.3 * reward * hidden[i];   // 注意：没有 × input[j]
}
```

数学上这不是「选择性强化某个输入连接」，而是「对该隐藏单元整体调增益」。我把这个如实写出来，是因为**看源码才能看到这种细节**——文档和注释里的「Hebbian」和真实代码之间有落差，而落差本身就是技术博客的价值。

### 3.4 挫败累积

网络的挫败累加器 $A$，和驱力层的挫败是两个独立机制（命名撞车，职责不同）：

$$
A \leftarrow
\begin{cases}
A + |r| & r < -0.1 \text{（持续受挫，累积）} \\
\max(0,\ A - 0.5\,r) & \text{否则（慢慢释放）}
\end{cases}
$$

### 3.5 相变：挫败攒到阈值，人格跳变

当 $A > 3.0$，触发一次「相变」——网络不连续地跃迁，而不是渐变：

$$
\text{kick}_i \leftarrow \text{kick}_i + u \cdot 0.3 \cdot \tanh\!\left(\frac{A}{3.0}\right),\quad u \sim U(-0.5, 0.5),\ \text{clip 到 } [-2,2]
$$

$$
b_{1i} \leftarrow b_{1i} + u' \cdot 0.1,\quad u' \sim U(-0.5,0.5),\ \text{clip 到 } [-3,3]
$$

然后 $A \leftarrow 0$。

`biasKick` 是输出层的**持久偏置**，`b1` 是隐藏层偏置。相变把它们随机踢一脚——这是「长期挫败后性格突变」的数学实现：不是平滑调节，是攒够了就跳。

### 3.6 权重衰减 + clamp

每次更新后，权重朝 0 收缩，防止无限漂移：

$$
W_2 \leftarrow 0.995\, W_2,\ \text{clip } [-1.5, 1.5]
$$
$$
W_1 \leftarrow 0.995\, W_1,\ \text{clip } [-2.0, 2.0]
$$

### 3.7 人格指纹

把最近 30 次信号取均值，得到「当前人格指纹」，用于和 StyleMemory 里的历史比对：

$$
\bar{s}_i = \frac{1}{30}\sum_{k} s_i^{(k)}
$$

---

## 4. StyleMemory：KNN 记忆 + Hawking 辐射

每次对话变成一个 8D 空间里的点（用 Critic 的 context 向量），带文本 + reward。检索时用「质量加权 KNN」找相似历史拼 few-shot。

### 4.1 结晶：够近就合并

新点先归一化 $\hat{q} = q / \|q\|$，找最近邻。若余弦相似度 $> 0.85$，不新建、而是合并（结晶）：

$$
m \leftarrow m + 1
$$

$$
\mathbf{c} \leftarrow \frac{m \cdot \mathbf{c} + \hat{q}}{m + 1} \quad \text{（质量加权质心，等价 online K-means 单步）}
$$

$$
\bar{r} \leftarrow \frac{\bar{r} \cdot a + r}{a + 1}
$$

合并让「相似的历史」聚成一颗更重的记忆点，而不是散成一堆重复。

### 4.2 检索：质量加权 cosine

$$
\text{score} = \cos(\hat{q}, \mathbf{c}) \cdot m
$$

相似度 × 质量——**被反复命中的记忆更重，更容易被捞出来**。

### 4.3 Hawking 辐射：蒸发的是「超额质量」，不是记忆本身

这是最漂亮的一处。质量随时间指数衰减，但**趋向 1，不是 0**：

$$
m(t) = 1 + \underbrace{(m_0 - 1)}_{\text{超额质量}} \cdot e^{-0.001\, \Delta t_h}
$$

$$
\text{删除条件：} m - 1 < 0.005 \wedge m < 1.01
$$

$\lambda = 0.001$/h，半衰期约 29 天。

含义很微妙：**基础质量 $m=1$ 永不蒸发，只有「被反复加强的那部分」会随时间蒸发**。一个记忆点哪怕再久不碰，也保底留在池子里；但「最近很热」的加成会随时间凉下来。这是「长期记忆稳定 + 短期热度衰减」的一行代码实现。

---

## 5. 这套东西为什么成立

回到开头的问题：为什么不用规则表，而是随机网络 + 这些数学？

三个设计扛起了这件事：

1. **时间箭头**（$F_{eq}$ 平衡点）让状态「有来处」——connection 挫败不会凭空消失，会驰豫到 1.875。人格有惯性，不是每轮重新掷骰。
2. **随机种子 + Hebbian 反馈**让「人格可复现、可演化」——同 seed 同人格，但对话会一点点把它塑成「这个人」。
3. **Hawking 辐射的 mass→1 保底**让记忆「长期稳定、短期降温」——一行指数衰减同时解决两个需求。

当然，它远不完美：W1 那个「近似」更新其实是个未完成品，相变全靠随机踢一脚、不可控，Critic 的输出质量决定了整个系统的天花板。但一个「从随机长出来」的人格引擎，比一张越来越长的规则表，更像一个会变的、有惯性的东西。

---

> 源码：`companion-v2/persona_engine/` 下 `genome_engine.js`、`drive_metabolism.js`、`style_memory.js`，以及 `companion-v2/genome/critic.js`。
> 所有公式均可对照源码逐行验证，常量（λ、Feq、阈值、衰减系数）均取自代码原值。
