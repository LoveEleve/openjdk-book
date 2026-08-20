# Reasonix 源码学习范围规划

> 项目：esengine/DeepSeek-Reasonix（main-v2 基线）
> 分析目标：作为第二个 Agent 项目，重点学习“单控制器 + durable execution + 任务契约 + 上下文工程 + 审查器架构”如何被组织成一套可控系统。
> 依据：
> - `vol-agent/02-源码分析方法论.md`
> - `vol-agent/03-Agent源码前置认知桥.md`
> - `vol-agent/04-统一源码分析模板.md`
> - `vol-agent/05-五Agent源码分析范围规划.md`
> - `Agent/analysis/reasonix/00-域发现/00-reasonix-域发现.md`

---

## 一、项目基本信息

- 项目名：Reasonix
- 版本基线：`main-v2`（既有域发现基线）
- 技术栈：Go + 单静态二进制 + controller / agent / checkpoint / taskcontract / permission / memory / MCP / plugin
- 核心形态：传输无关控制器 + durable session loop + 强任务契约 + 检查点恢复 + 缓存优先上下文工程

---

## 二、项目根问题（Project Thesis）

### 1. root problems

1. **如何把 Agent 从“命令行聊天循环”提升成一个由单控制器统一驱动、可恢复、可重放、可审查的任务系统。**
2. **如何在长跑条件下，让上下文、计划、权限、检查点和恢复语义彼此一致，而不是各自为政。**
3. **如何把“计划、执行、验收、恢复”都收进一套结构化契约，而不是依赖临时文本约定。**

### 2. design theses

- 单控制器是系统逻辑层的唯一真相，不让前端各自带状态。
- 计划不是 prose，而是数据契约。
- 上下文不是自由拼接，而是缓存优先、严格边界的上下文工程。
- durable execution 不是附加恢复能力，而是执行模型本身的一部分。
- 评估器必须独立于执行器，且不能共享执行历史与上下文噪声。

### 2.5 sharpened thesis

更锋利的一句话：

> **Reasonix 的本质不是“另一个 Agent CLI”，而是把 Agent 变成一个受单控制器约束、由任务契约驱动、以 durable execution 为中心的长跑任务系统。**

这意味着：
- 对话不是主角，控制面才是主角；
- prompt 不是中心，任务契约和恢复语义才是中心；
- 前端只是入口，controller 才是唯一逻辑层。 

### 3. architectural promises

- 所有前端背后都共享同一个控制器与事件流。
- 长跑恢复依赖检查点和状态重放，而不是重新提示模型。
- 计划、权限、记忆、恢复都有显式契约边界。
- 评估与执行分离，防止模型自我宣布完成。

---

## 三、主线机制（Mainline Mechanisms）

## R-1 Controller：传输无关的单控制器控制面（核心主线）

### 为什么是主线
- 它是所有前端（TUI/HTTP/Wails）共享的逻辑层。
- 不理解它，就无法理解 Reasonix 为什么不会像普通 CLI 那样把状态分散在前端。
- 更关键的是：后面的 run loop、permission、recovery、rewind、goal eval 都不是并列模块，而是被 Controller 统一协调的控制面成员。
- 所以 Controller 必须排第一；否则读者会把后面的机制误读成很多平行子系统，而不是一个统一的任务操作系统。

### 重点源码域
- `internal/control/`
- 尤其是 `controller.go`、与 recovery / rewind / approval / goal 相关文件

### 关键问题
- 控制器如何组织命令输入和事件输出？
- 为什么它必须是 transport-agnostic？
- 为什么只有前端可以 import control？

---

## R-2 Agent 会话与 RunLoop（执行骨架）

### 为什么是主线
- 这是 Reasonix 的执行骨架。
- 决定 turn、streamedTurn、失败恢复、工具批处理与运行生命周期。

### 重点源码域
- `internal/agent/`
- `run_loop.go`
- turn orchestration 相关文件

### 关键问题
- streamed turn 怎么组织？
- 失败如何进入上下文？
- 工具批处理如何和 turn 对齐？

---

## R-3 ContextManager / compaction（缓存优先的上下文工程）

### 为什么是主线
- Reasonix 最突出的差异之一就是它对“缓存优先上下文工程”的强调。
- 不理解这一点，会错过它与其他 Agent 项目的关键分界线。

### 重点源码域
- `internal/agent/compact_*`
- `internal/agent/context_*`
- 与 ContextManager 直接相关的实现

### 关键问题
- 为什么系统 prompt 前缀必须字节稳定？
- compact_ratio 0.85 是什么语义？
- 为什么只做单次摘要事务？

---

## R-4 PlanContract / TaskContract / AutoResearch（结构化任务契约）

### 为什么是主线
- Reasonix 最值钱的一层之一，就是把计划和任务做成数据契约。
- 这是“不是靠 prose 管任务”的关键证明。

### 重点源码域
- `internal/plancontract/`
- `internal/taskcontract/`
- `internal/autoresearch/`

### 关键问题
- 为什么“计划是数据不是 prose”？
- TaskSpec 里 goal / scope / non_goals / success_criteria / allowed_operations 为什么都要显式化？
- stale_count / pivot_count 在控制什么？

---

## R-5 Checkpoint / Recovery（持久执行与恢复语义）

### 为什么是主线
- 这是 durable execution 是否成立的关键。
- 没有它，Reasonix 只是一个会跑的 Agent，不是一个能恢复的 Agent。

### 重点源码域
- `internal/checkpoint/`
- `internal/recovery/`
- `control/recovery.go`

### 关键问题
- checkpoint 怎么原子写？
- barrier / blob / transaction 是怎么配合的？
- 恢复时哪些状态是从 checkpoint 来，哪些状态是重放出来的？

---

## R-6 Goaleval + BoundedLLM（独立验收器）

### 为什么是主线
- 这是 Reasonix 区别于“模型自己说自己完成”的关键层。
- 它很适合拿来和我们当前产品的 evaluator 概念对照。

### 重点源码域
- `internal/goaleval/`
- `internal/boundedllm/`

### 关键问题
- 为什么评估器必须独立？
- 为什么无工具 / 无历史 / 无压缩很重要？
- BoundedLLM 在这里起什么作用？

---

## R-7 Permission / WorkspaceLease（执行边界控制）

### 为什么是主线
- Reasonix 对“工作区租约”和“权限边界”的处理很有代表性。
- 它不是只有 permission，还有写者租约、读者不租约这些工程边界。

### 重点源码域
- `internal/permission/`
- `internal/workspacelease/`

### 关键问题
- 为什么读者不租约、写者租约持续到任务完成？
- 这和普通文件锁有什么不同？
- 它在保护什么验证语义？

---

## 四、横切专题（Crosscutting Tracks）

## R-X1 缓存优先（KV Cache / Prefix Stability）
- Reasonix 最独特、也最值得优先抬高的横切专题之一。
- 不只是 context 模块，而是影响 planner / executor / prompt / model route 的全局原则。
- 它不是“优化项”，而是架构哲学：系统 prompt 前缀必须字节稳定，任何无谓重写都会直接伤害运行成本与持续执行能力。

## R-X2 Durable Execution
- checkpoint / recovery / state / input / history 全都被这一条主线约束。

## R-X3 计划即数据契约
- 不是某一章的内容，而是全系统的组织哲学。

## R-X4 独立审查器架构
- goaleval / guardian / boundedllm 共同构成“执行器之外的判断层”。

## R-X5 写者租约与工作区一致性
- 它不是单独的锁技术，而是保证 review / verify / write 不互相污染的系统级约束。

---

## 五、认知风险点（Cognitive Risks）

### 1. 错觉：Controller 只是命令分发器
- 实际风险：低估它作为“统一控制面”的地位。
- 应纠正为：Controller 是所有前端共用的唯一逻辑层，不懂它就会把后续模块看散。

### 2. 错觉：PlanContract 只是结构化文档
- 实际风险：忽略计划是执行、验收、恢复的结构化契约。
- 应纠正为：Plan 是运行控制的一部分，不是写给人看的附加说明。

### 3. 错觉：ContextManager 只是 prompt 拼接器
- 实际风险：看不到缓存优先和摘要事务的设计意义。
- 应纠正为：ContextManager 在控制“模型到底看见什么”，是成本和正确性的共同边界。

### 4. 错觉：checkpoint 只是顺手存一下状态
- 实际风险：看不到 durable execution 语义。
- 应纠正为：checkpoint 是长期运行、恢复和继续执行的正式协议节点。

### 5. 错觉：Goaleval 只是收尾验证器
- 实际风险：看不到“独立评估器”这层结构性意义。
- 应纠正为：Goaleval 是执行器之外的独立判断层，用来阻止模型自我宣布完成。

### 6. 错觉：WorkspaceLease 就是普通文件锁
- 实际风险：错过读者/写者分离和任务完成语义。
- 应纠正为：它在保护 review / verify / write 阶段的工作区一致性，而不是单次文件互斥。

---

## 六、分析边界

### UI 要不要进主线？
- **不要。**
- TUI / Wails / HTTP 前端只是入口层，不是第一轮主线。

### 非 Linux 平台要不要进主线？
- **不要。**
- `_windows.go` 等平台分支默认后置。

### benchmark 要不要进主线？
- **第一轮不要。**
- 可以作为性能补充证据，但不抢主线。

### test 代码要不要关心？
- **要。**
- 特别是：checkpoint、goal eval、permission、context manager 的契约测试。

### plugin / MCP 要不要进第一轮主线？
- **后段再进。**
- 理由不是它们不重要，而是如果 controller / run loop / context / task contract / checkpoint / evaluator 这条主线没先站稳，插件和协议层只会退化成接口清单。
- 第一轮先回答“系统如何成立”，第二轮再回答“系统如何被扩展和外化”。

---

## 七、前置认知桥

读 Reasonix 前，建议先具备：
- Agent loop / turn / continuation 基本理解
- context window / compaction 基本理解
- tool protocol / evaluator 基本理解
- checkpoint / replay / resume 基本理解

如果没有，先读：
- `vol-agent/03-Agent源码前置认知桥.md`

---

## 八、工程问题学习点

Reasonix 值得学的工程问题，不是“怎么调模型”，而是：

1. 如何用单控制器统一所有前端逻辑
2. 如何把计划从 prose 升级成数据契约
3. 如何让上下文工程服从缓存优先原则
4. 如何把评估器做成执行器之外的独立系统
5. 如何把 checkpoint / recovery 做成 durable execution 的一部分
6. 如何用 workspace lease 保护写入和验证边界

---

## 九、第一轮学习顺序建议

1. Controller
2. Agent / RunLoop
3. ContextManager / compaction
4. PlanContract + TaskContract + AutoResearch
5. Checkpoint + Recovery
6. Goaleval + BoundedLLM
7. Permission + WorkspaceLease
8. Memory / History / SessionCatalog
9. MCP / Plugin / Extension（后段）

---

## 十、Reasonix 第一卷预期书级结构

如果第一轮分析做对，Reasonix 这一卷最终应该长成：

1. Controller：统一控制面与前端无关逻辑层
2. RunLoop：durable execution 的执行骨架
3. ContextManager：缓存优先的上下文工程
4. PlanContract / TaskContract / AutoResearch：计划即数据契约
5. Checkpoint / Recovery：长跑与恢复语义
6. Goaleval / BoundedLLM：独立审查器与完成判定
7. Permission / WorkspaceLease：副作用边界与工作区一致性
8. Memory / History / SessionCatalog：知识与历史的可检索外壳
9. MCP / Plugin / Extension：控制面的外化与扩展
10. 失败边界、演进与迁移总结

这意味着：
- 第一卷不是“功能介绍”，而是“一个受控制器驱动的长跑任务系统如何成立”。
- 后续每篇正文都应该服务于这条主线，而不是把模块并列展开。

## 十一、第一轮完成标准

Reasonix 只有同时满足以下条件，才算完成第一轮源码分析：

- 有项目根问题
- 有主线机制清单
- 有横切专题
- 有认知风险点
- 有分析边界
- 有前置认知桥
- 每个核心域有机制闭环
- 有测试证据支撑边界判断
- 有工程问题学习点
- 有后续书级结构建议

不允许以“包很多、文件很多、controller 很大”作为完成标准。