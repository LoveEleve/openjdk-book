# PLAN-M16.0 - 双层痛点求解器

> 日期：2026-08-19
> 承接：M15 领域层增强 + M16 大仓验证规划
> 定位：在没有现成高质量讲解书的前提下，只凭源码生成真正能解决源码学习困难的书级结构

---

## 一、目标重述

M16.0 不是“再做一个章纲生成器”，而是做一个：

> 同时解决 **读者为什么学不会源码** 与 **Agent 为什么会把源码学坏、讲坏、跑坏** 的双层痛点求解系统。

最终目标：

- 输入：AI Key + 源码仓库 + 学习目标
- 输出：
  - 项目根问题（project thesis）
  - 主线机制（mainline mechanisms）
  - 横切专题（crosscutting tracks）
  - 认知风险（cognitive risks）
  - 书级骨架（book skeleton）
  - 章纲（syllabus）
  - 痛点覆盖报告（pain coverage report）

约束：

1. 不依赖现成好书作为运行时前提。
2. 允许现有人工成果仅作为评测基线，而不是知识依赖。
3. 章纲必须体现“学习痛点求解逻辑”，而不是“看起来合理的目录”。
4. 低质量教程式章纲必须在进入长跑前被 gate 拦下。

---

## 二、双层痛点体系

## 2.1 Reader-side Pain Points（24）

### A. 起点类

| ID | 名称 | 症状 | 需要的产物 |
|----|------|------|------------|
| R1 | 不知道入口在哪里 | 仓库太大，不知先看哪 | entrypoint / first path |
| R2 | 不知道项目在解决什么问题 | 只看到类和包，看不出系统意图 | project thesis |
| R3 | 不知道哪些是核心，哪些是外围 | 学了很多抓不住本质 | mainline vs support |

### B. 顺序类

| ID | 名称 | 症状 | 需要的产物 |
|----|------|------|------------|
| R4 | 学习顺序错误，中途卡死 | 看 A 章时发现必须先懂 B | dependency topology |
| R5 | 把 API 使用顺序误当源码理解顺序 | 教程看得懂，源码读不通 | source-order vs user-order |
| R6 | 章节颗粒度不合理 | 一章太大或太碎 | chapter clusters |

### C. 抽象类

| ID | 名称 | 症状 | 需要的产物 |
|----|------|------|------------|
| R7 | 看见模块看不见机制 | 记住类名却不懂设计 | mechanism abstraction |
| R8 | 抽象概念记不住 | EventLoop / Arena 看完就忘 | analogy anchors |
| R9 | 只会用，不懂为什么这样设计 | 会 API，不懂 trade-off | design rationale |
| R10 | 看懂局部，不懂整体 | 每个类略懂但系统为何成立仍不清楚 | architecture narrative |

### D. 横切类

| ID | 名称 | 症状 | 需要的产物 |
|----|------|------|------------|
| R11 | 横切机制被埋起来 | refcount / 背压到处都有但没整体理解 | crosscutting tracks |
| R12 | 把局部技巧误当核心机制 | HTTP / 示例代码被讲得过重 | layer classification |
| R13 | 看不到共同约束 | 多个模块受同一原则支配却没被指出 | constraint map |

### E. 风险类

| ID | 名称 | 症状 | 需要的产物 |
|----|------|------|------------|
| R14 | 只会正常路径，不会异常路径 | happy path 会讲，失败路径不会排查 | failure boundaries |
| R15 | 不知道哪里最容易误用 | API 会用，但容易踩坑 | anti-pattern catalog |
| R16 | 不知道哪里最容易泄漏/乱序/线程误用 | 出问题不知道先看哪里 | risk hotspots |

### F. 深度类

| ID | 名称 | 症状 | 需要的产物 |
|----|------|------|------------|
| R17 | 不知道重点在哪 | 每章看起来都差不多重要 | depth map |
| R18 | 深的地方没拉深，浅的地方写太多 | Allocator 和 HTTP 写得一样重 | importance ranking |
| R19 | 看似全面，实际上没抓住难点 | 目录完整，但关键深水区没讲透 | hard-point mining |

### G. 时间维度类

| ID | 名称 | 症状 | 需要的产物 |
|----|------|------|------------|
| R20 | 把兼容层当核心机制 | 历史包袱和主干机制混淆 | evolution track |
| R21 | 不知道某实现是历史产物还是主路径 | 理解重心放错 | version-aware notes |

### H. 迁移与输出类

| ID | 名称 | 症状 | 需要的产物 |
|----|------|------|------------|
| R22 | 学完 A，不会迁移到 B | 换项目就失效 | transferable concepts |
| R23 | 看着懂，讲不出来 | 复述不了原理 | self-test / explain-back |
| R24 | 不知道这套知识对自己目标有什么意义 | 学了很多但目标脱节 | goal mapping / exam map |

---

## 2.2 Agent-side Failure Points（12）

### A. 误判类

| ID | 名称 | 失真现象 | 需要的护栏 |
|----|------|----------|------------|
| A1 | 把高频出现误判为核心机制 | 公共工具/胶水层被当主机制 | 核心性判别 ≠ 频次判别 |
| A2 | 教程常识覆盖源码事实 | 一看到 Netty 就生成 Echo/HTTP 入门目录 | 常识先验抑制器 |
| A3 | 把命名像误判为职责像 | `Manager`/`Context` 这种命名误导分类 | 命名-职责去耦 |
| A4 | 把局部复杂误判为全局重要 | 局部大类抢走主线地位 | 局部复杂度 vs 全局中心性 |

### B. 路径依赖类

| ID | 名称 | 失真现象 | 需要的护栏 |
|----|------|----------|------------|
| A5 | 找到第一个入口后就围着它打转 | 旁路子系统被长期遗漏 | 入口锚定偏差矫正 |
| A6 | 早期结论不断自我强化 | 形成错误叙事后一路自证 | 叙事漂移检测 |
| A7 | 早期章纲反过来污染后续判断 | 新机制只能硬塞进已有章 | 章纲可重构能力 |

### C. 上下文失真类

| ID | 名称 | 失真现象 | 需要的护栏 |
|----|------|----------|------------|
| A8 | 压缩后丢掉设计动机 | 保留事实，丢了 why | rationale 不可压缩锚点 |
| A9 | 长跑后丢掉全书主线 | 各章局部正确，但全书散掉 | book coherence anchor |
| A10 | 领域层模块彼此打架 | analogy / exam-map / perspective / evolution 抢上下文 | 领域层冲突调度器 |

### D. 输出伪优雅类

| ID | 名称 | 失真现象 | 需要的护栏 |
|----|------|----------|------------|
| A11 | 写得像书，但没解决读者痛点 | 形式好看，认知收益低 | 痛点覆盖验收门 |
| A12 | 证据不足仍强行结构化输出 | 看起来合理，实际是幻觉补全 | 证据不足 fail-soft |

---

## 三、系统架构（8 个子系统）

### 子系统 1：Pain Registry

文件建议：
- `src/learning/pain-points.ts`

职责：
- 正式登记 24 个 reader pain points 与 12 个 agent failure points。
- 每个模块都必须能回答：它在缓解哪些 pain points。

关键结构：

```ts
interface ReaderPainPoint {
  id: string;
  name: string;
  category: string;
  symptom: string;
  root_cause: string;
  required_outputs: string[];
  mitigation_modules: string[];
}

interface AgentFailurePoint {
  id: string;
  name: string;
  category: string;
  symptom: string;
  root_cause: string;
  mitigation_modules: string[];
  guardrails: string[];
}
```

### 子系统 2：Project Thesis Extractor

文件建议：
- `src/discovery/project-thesis.ts`

职责：
- 从源码中先抽“项目根问题”，而不是先抽目录。
- 输出根问题、设计论题、架构承诺。

产物：

```ts
interface ProjectThesis {
  root_problems: string[];
  design_theses: string[];
  architectural_promises: string[];
}
```

### 子系统 3：Mainline Mechanisms + Crosscutting Tracks

文件建议：
- `src/discovery/mainline-mechanisms.ts`
- `src/discovery/crosscutting-tracks.ts`

职责：
- 主机制：系统为什么成立。
- 横切机制：多个主机制背后的共同约束。

产物：

```ts
interface MainlineMechanism {
  id: string;
  subject: string;
  why_core: string[];
  prerequisite_ids: string[];
  complexity_score: number;
  centrality_score: number;
}

interface CrosscuttingTrack {
  id: string;
  name: string;
  touches: string[];
  why_hard: string[];
}
```

### 子系统 4：Cognitive Risk Extractor

文件建议：
- `src/learning/cognitive-risks.ts`

职责：
- 找出最容易让读者“看起来懂了，其实没懂”的地方。
- 找出最容易误用、泄漏、归因错误的地方。

产物：

```ts
interface CognitiveRisk {
  id: string;
  mechanism_ids: string[];
  risk_type: "misuse" | "misread" | "debugging-blindspot";
  why_risky: string;
  mitigation: string[];
}
```

### 子系统 5：Book Skeleton Generator

文件建议：
- `src/spec/book-skeleton.ts`

职责：
- 先生成一本书的骨架，而不是直接生成章节目录。

产物：

```ts
interface BookSkeleton {
  thesis: ProjectThesis;
  mainline_mechanisms: MainlineMechanism[];
  crosscutting_tracks: CrosscuttingTrack[];
  cognitive_risks: CognitiveRisk[];
  depth_map: DepthDecision[];
  goal_mapping: GoalMapping;
  rationale: string[];
}
```

### 子系统 6：Syllabus Builder

文件建议：
- `src/spec/syllabus.ts`

职责：
- 从 skeleton 长出章节，但每章都要带 role、rationale 和 pain point coverage。

产物：

```ts
interface ChapterPlan {
  id: number;
  title: string;
  depth: "A" | "B" | "C";
  role: "mainline" | "crosscutting" | "risk" | "evolution" | "application";
  kps: string[];
  prereqs: number[];
  rationale: string;
  pain_points_covered: string[];
}
```

### 子系统 7：Pain Coverage Gate

文件建议：
- `src/spec/painpoint-gate.ts`

职责：
- 阻止“教程味重、深度塌缩、主线缺失、横切缺失”的 spec 进入长跑。

检查项：
- 关键 reader pain points 是否覆盖
- 关键 agent failure points 是否被 guard
- 是否有横切专题
- 是否有失败边界章
- 是否有演进/迁移/自测章
- 是否全部是 B 深度
- 是否教程味过重
- 是否主线机制缺失

### 子系统 8：Syllabus Refiner

文件建议：
- `src/spec/syllabus-refiner.ts`

职责：
- 当 Pain Coverage Gate 发现问题时，不是直接失败，而是自动重排、拆章、升深度、补专题。

---

## 四、Netty 作为验证对象时的理想结构

如果 M16.0 做对，Netty 不应长出“概述/入门/HTTP服务器”这种弱目录，而应长出：

### 卷一：为什么 Netty 能成立（执行骨架）
1. EventLoop / EventExecutor：统一执行模型 `A`
2. Channel / Unsafe：I/O 边界与生命周期 `A`
3. Pipeline / HandlerContext：事件传播主链 `A`

### 卷二：为什么 Netty 能高效（内存与发送）
4. ByteBuf：索引模型、所有权与引用计数 `A`
5. PooledByteBufAllocator：Arena / Chunk / Subpage `A`
6. OutboundBuffer / write / flush：发送路径与背压 `A`
7. 零拷贝与文件发送 `B`

### 卷三：为什么 Netty 可控（异步与横切机制）
8. Promise / Future / task queue：异步控制回路 `A/B`
9. FastThreadLocal / Recycler / LeakDetector：横切工程机制 `A/B`
10. 线程亲和、背压、引用计数：横切理解专题 `A/B`

### 卷四：系统如何被装配
11. Bootstrap / ServerBootstrap / ChannelInitializer `B`
12. Codec：协议抽象如何建立在主线机制上 `B`
13. HTTP / HTTP2 / timeout / websocket `C`

### 卷五：真正难学和真正值钱的部分
14. 高风险误区：哪里最容易学错 / 用错 / 泄漏 `A/B`
15. 历史演进：哪些是核心，哪些是兼容层 `B`
16. 可迁移思想：从 Netty 带走什么 `B`
17. 费曼式自测：如何确认自己真的学会了 `B`

---

## 五、实施顺序

### Phase 1：Pain Registry
- 建立 24 + 12 的正式数据结构。
- 给现有模块补“覆盖哪些痛点”的映射。

### Phase 2：Project Thesis + Mainline/Crosscutting
- 先回答“项目为什么存在”。
- 再回答“靠哪些主机制成立”。
- 再回答“哪些约束横切全局”。

### Phase 3：Cognitive Risk Extractor
- 找最容易学坏、讲坏、误用的点。

### Phase 4：Book Skeleton
- 不是先列目录，而是先列 thesis / mainline / tracks / risks / depth map。

### Phase 5：Syllabus Builder
- 从 skeleton 长章节。
- 每章必须带 `role / rationale / pain_points_covered`。

### Phase 6：Pain Coverage Gate + Refiner
- 拦下低质量 spec。
- 自动重构、补专题、升深度、调顺序。

### Phase 7：Netty 无基线验证
- 不依赖 `vol-netty`。
- 让系统直接从源码长出一版书级结构。
- 再与人工结果做对比评估。

---

## 六、完成标准

M16.0 完成必须同时满足：

1. 不依赖任何现成高质量讲解书。
2. 只给源码仓库，也能生成书级结构。
3. 输出不再是教程味目录。
4. 有 project thesis。
5. 有 mainline mechanisms。
6. 有 crosscutting tracks。
7. 有 cognitive risks。
8. 有 A/B/C 深度分层。
9. 每章明确覆盖哪些 pain points。
10. spec 必须通过 pain coverage gate。
11. 在 Netty 这种真实项目上，结构质量明显优于常识型目录。

---

## 七、与现有 M11-M15 的关系

- M11 评测体系：用于评估 M16.0 输出质量。
- M12 记忆与技能：为 thesis / mechanisms / tracks 提供已有知识底座。
- M13 理解路径与写作蓝图：承接更高质量的章节结构。
- M14 存储与检索：支撑大仓发现、缓存和索引。
- M15 analogy / exam-map / perspective / evolution：作为 skeleton 的输入材料，而不是孤立模块。

M16.0 是一个 **统摄层**：把前面的能力从“模块功能”统一提升为“书级结构生成能力”。

---

## 八、建议新增文件

| 文件 | 用途 |
|------|------|
| `src/learning/pain-points.ts` | 24 + 12 痛点注册表 |
| `src/discovery/project-thesis.ts` | 项目根问题识别 |
| `src/discovery/mainline-mechanisms.ts` | 主机制抽取 |
| `src/discovery/crosscutting-tracks.ts` | 横切机制抽取 |
| `src/learning/cognitive-risks.ts` | 认知风险抽取 |
| `src/spec/book-skeleton.ts` | 书级骨架生成 |
| `src/spec/painpoint-gate.ts` | 痛点覆盖质量门 |
| `src/spec/syllabus-refiner.ts` | 章纲自动重构 |
| `tests/pain-points.test.ts` | 痛点注册表测试 |
| `tests/project-thesis.test.ts` | 项目论题测试 |
| `tests/book-skeleton.test.ts` | 书级骨架测试 |
| `tests/painpoint-gate.test.ts` | 章纲质量门测试 |

---

## 九、结论

M16.0 的真正价值，不是“生成一个更好目录”，而是：

> 把“源码学习为什么难”与“Agent 为什么会把学习过程做坏”同时纳入系统建模，
> 最终让 Agent 在没有现成好书的情况下，也能长出一本真正有教学价值的源码学习书。

这一步如果做成，用户就真的只需要：
- AI Key
- 源码仓库
- 目标（book/interview/self_study）

剩下的核心认知工程，都由 Agent 自己承担。
