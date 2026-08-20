# Reasonix 横向对比锚点

> 用途：从 Reasonix 第一卷中抽出后续对比 Pi / Hermes / dsh 时可直接复用的比较维度、核心标签与迁移价值。

---

## 一、Reasonix 的整体画像

一句话定义：

> **Reasonix 是一个把 Agent 做成"受单控制器驱动、由任务契约约束、以缓存优先上下文和独立审查器为安全边界"的长跑任务系统。**

它的特点不是"某一个点做得特别炫"，而是：
- 单控制器
- 确定性 planner route
- 缓存优先上下文
- 独立 evaluator fail-closed
- 任务契约结构化
- 工作区租约
- 记忆冲突模型

这几层拼得非常完整。

所以后面横向对比时，Reasonix 更适合扮演：
> **"受控任务系统"样本**

---

## 二、最核心的 10 个对比锚点

## R-A1 控制面形态

### Reasonix 的做法
- 单控制器 Controller
- 所有前端共享同一逻辑层
- 命令面 / 事件面分离

### 对比问题
- 其他项目有没有统一控制面？
- 前端是否各自带状态？
- 命令和事件是否分离？

### Reasonix 的标签
- **单控制器统一控制面**

---

## R-A2 规划与执行边界

### Reasonix 的做法
- Coordinator + PlanContract
- 确定性 planner route（4 路由 + 3 深度）
- Planner/Executor 交接防注入
- planFacts / mutationEscapesPlan

### 对比问题
- 其他项目有没有显式 planner？
- 计划是 prose 还是数据契约？
- 规划层能不能污染执行层？

### Reasonix 的标签
- **计划是数据契约，不是 prose**

---

## R-A3 执行骨架

### Reasonix 的做法
- RunLoop + TurnOrchestrator
- session 级 jobs
- 缺失推理恢复（不盲目重跑工具）

### 对比问题
- 其他项目的 loop 是对话循环还是任务骨架？
- 工具失败后怎么处理？
- 有没有 session 级任务容器？

### Reasonix 的标签
- **长跑任务骨架**

---

## R-A4 上下文工程

### Reasonix 的做法
- 缓存优先
- system prompt + 首个用户 turn 字节稳定
- compact_ratio 0.85 单次摘要事务
- transient tail injection

### 对比问题
- 其他项目对上下文的理解是自由拼接还是缓存优先？
- 前缀稳定性如何？
- 压缩是控制流转移还是附属功能？

### Reasonix 的标签
- **缓存优先上下文工程**

---

## R-A5 完成判定

### Reasonix 的做法
- Goaleval 独立审查器
- BoundedLLM 有界调用
- 无工具 / 无历史 / 独立 usage source
- nil evaluator fail-closed
- 四态 outcome（complete / continue / blocked / uncertain）

### 对比问题
- 其他项目的完成判定是模型自我宣布还是独立审查？
- 评估器有没有自己的有界调用基础设施？
- 评估失败时默认继续还是暂停？

### Reasonix 的标签
- **独立审查器 + fail-closed**

---

## R-A6 副作用边界

### Reasonix 的做法
- Permission
- WorkspaceLease（reader 不租约，writer 持续到任务完成）

### 对比问题
- 其他项目有没有工作区租约？
- 权限和租约是否进入任务控制面？
- 验收 / review 期间工作区一致性怎么保护？

### Reasonix 的标签
- **任务级工作区一致性**

---

## R-A7 长期知识

### Reasonix 的做法
- Subject 冲突模型（一问题一答案）
- pinned / relevant 分层
- freshness / archive
- BM25 召回 + 相对分数地板
- 项目覆盖全局但都保留可见

### 对比问题
- 其他项目有没有知识冲突模型？
- 记忆是无限膨胀还是有老化机制？
- 自动召回的知识有没有权威性标注？

### Reasonix 的标签
- **结构化长期知识系统**

---

## R-A8 任务契约

### Reasonix 的做法
- TaskSpec（goal / scope / non_goals / allowed_operations / success_criteria）
- stale_count / pivot_count
- nextRequiredAction
- Finding source 溯源

### 对比问题
- 其他项目的任务目标是文本还是数据契约？
- 有没有停滞检测和转向策略？
- 有没有"什么时候该问人"的量化标准？

### Reasonix 的标签
- **任务目标结构化 + 停滞检测**

---

## R-A9 恢复与迁移

### Reasonix 的做法
- Checkpoint（FileSnap + MsgIndex + session revision）
- 意图先持久化
- Prepare/Commit 重验证
- WorkspaceToken 代验证
- epoch 保护迁移

### 对比问题
- 其他项目的 checkpoint 保存什么？
- 恢复时文件和会话状态是否一起恢复？
- 有没有防过期 preview 授权新 commit 的机制？

### Reasonix 的标签
- **原子恢复与代验证**

---

## R-A10 审查器架构模式

### Reasonix 的做法
- Goaleval + BoundedLLM + Recovery Reviewer 共享有界调用基础设施
- Guardian 长活守卫
- 每种审查器有独立 PolicyPrompt + UsageSource

### 对比问题
- 其他项目有没有统一的审查器基础设施？
- 有没有多种审查器共享同一 bounded call 模式？
- 审查器的失败语义是什么？

### Reasonix 的标签
- **共享审查器基础设施**

---

## 三、Reasonix 最强的地方

### 1. 控制哲学成熟
单控制器 + 确定性路由 + fail-closed evaluator，整套控制面非常完整。

### 2. 任务契约深度
TaskSpec + PlanContract + stale/pivot/nextRequiredAction，把任务从"描述"提升成"可计算对象"。

### 3. 缓存优先上下文
system prompt 前缀字节稳定 + transient tail，这是长跑 Agent 的成本控制核心。

### 4. 独立审查器
Goaleval + BoundedLLM，把"是否完成"从模型自我判断提升成独立许可条件。

### 5. 工作区一致性
WorkspaceLease 的 reader/writer 分离 + 任务级持续租约，保护 review/verify/completion 边界。

---

## 四、Reasonix 的代价与局限

### 1. 系统复杂度高
Controller + Coordinator + RunLoop + ContextManager + Goaleval + WorkspaceLease + Memory + TaskSpec，组件很多。

### 2. 学习门槛高
如果没有 durable execution / 任务系统 / 状态机背景，很容易被淹没。

### 3. 不是所有设计都适合照搬
例如：
- 单控制器模式对多进程分布式系统可能过重
- 缓存优先对不依赖 prefix cache 的 provider 收益较小
- TaskSpec 对极简一次性任务可能过重

---

## 五、哪些思想最值得迁移到自己的系统？

优先级最高的迁移思想：

1. 单控制器统一控制面
2. 计划是数据契约，不是 prose
3. 确定性 planner route
4. Planner/Executor 交接防注入
5. 缓存优先上下文
6. Evaluator 独立 + fail-closed
7. 任务停滞/转向量化（stale_count / pivot_count）
8. 范围扩张才审批（NeedsApproval）
9. 工作区租约按任务生命周期持有
10. 记忆 subject 冲突模型

---

## 六、哪些东西不要盲抄？

1. 不要盲抄单控制器模式
   - 如果系统需要多进程分布式，Controller 模式可能过重。
2. 不要盲抄完整 PlanContract 体系
   - 如果任务极简，不需要这么重的计划对象。
3. 不要盲抄 BoundedLLM 共享基础设施
   - 如果只有一个审查器，不需要独立的 bounded call 层。
4. 不要盲抄 WorkspaceLease
   - 如果系统不修改工作区，租约收益有限。

---

## 七、Reasonix 对后续 3 个项目的比较问题

后面看 `Pi / Hermes / dsh` 时，每次都应该带着这 10 个问题去比：

1. 控制面是单控制器还是分布式？
2. 计划有没有数据契约？
3. 上下文是缓存优先还是自由拼接？
4. 完成判定有没有独立审查器？
5. 任务有没有停滞检测和转向策略？
6. 工作区一致性怎么保护？
7. 长期知识怎么组织？
8. Planner/Executor 交接怎么防污染？
9. 恢复时文件和会话状态是否一起恢复？
10. 有没有共享审查器基础设施？

---

## 八、一句话结论

如果只用一句话概括 Reasonix：

> **它代表了"受控任务系统"的工程化版本——不是最轻的、也不一定最灵活，但它把单控制器、任务契约、缓存优先上下文、独立审查器、副作用边界和停滞检测这些关键控制面都做成了系统。**
