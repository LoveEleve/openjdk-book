# ContextManager 与 Checkpoint：Reasonix 如何在缓存与恢复之间保持长跑稳定

> 项目：Reasonix（main-v2 基线）
> 角色：主线机制正文 04
> 对应范围规划：`01-Reasonix源码学习范围规划.md`
> 依据材料：`Agent/analysis/reasonix/01-闭环笔记/pass2-rq4-context-manager.md`、`pass2-rq7-checkpoint.md`

---

## 零、阅读前提示

- 建议先读：
  1. `02-Controller：Reasonix 为什么要把 Agent 做成单控制器系统.md`
  2. `03-Coordinator与PlanContract：Reasonix 如何让规划不再只是 prose.md`
  3. `04-RunLoop与DurableExecution：Reasonix 如何把 Agent 变成长跑任务系统.md`
- 推荐源码阅读路径：
  1. `internal/agent/compact_*` / `context_*`
  2. `internal/checkpoint/`
  3. `internal/recovery/`
  4. `internal/trajectory/`

## 一、这一章真正的问题

Reasonix 的长跑能力，不只是因为它有 checkpoint，也不只是因为它能压缩上下文。

真正的问题是：

> **模型上下文、缓存前缀、会话状态和文件恢复边界，如何在长时间运行中保持彼此一致。**

这章需要回答：

1. 为什么 Reasonix 把 ContextManager 设成 provider-visible context 的唯一所有者？
2. 为什么 system prompt + 首个用户 turn 必须字节稳定？
3. compaction 为什么只在单一阈值触发，而且不是无限摘要循环？
4. checkpoint 为什么既保存文件状态，也保存会话回滚边界？
5. 恢复时如何防止过期计划、并发写入和重复副作用？

---

## 二、先给结论：ContextManager 和 Checkpoint 是同一条长跑主线的两端

可以把两者分别理解成：

- ContextManager：决定模型下一轮看什么
- Checkpoint：决定系统下一次恢复从哪里开始

如果两者各自独立，系统就会出现：
- 模型看见的上下文和恢复后的状态不一致
- 文件已经变了，但会话还以为没变
- 压缩后的摘要和 checkpoint 的消息边界不一致

Reasonix 的设计重点就在于：

> **上下文视图和恢复边界必须共同服从同一套 durable 状态语义。**

---

## 三、缓存优先：为什么 system prompt 前缀必须字节稳定

Reasonix 的一个核心架构原则是：

> **system prompt + 首个用户 turn 构成尽量稳定的缓存前缀。**

这不是简单的性能优化，而是整个上下文设计的最高约束。

如果每轮都重写固定前缀：
- DeepSeek / provider 的前缀缓存命中会下降
- 每轮成本增加
- 上下文语义容易发生无意义漂移

因此 Reasonix 的策略是：
- 固定前缀启动时一次性建立
- 中途变化通过 transient tail 注入
- 下一 session 再折回稳定前缀

这体现的是：

> **变化的信息放到变化层，稳定的信息不要被每轮重写。**

---

## 四、Compaction：为什么单一阈值和单次摘要比无限压缩更可靠

Reasonix 的 compaction 不是“上下文大了就一直压”。

它有明确的：
- `compact_ratio = 0.85`
- 单次摘要事务
- 摘要不做无意义 padding
- 固定前缀不压缩
- 用户关键 turn、错误、工具调用组等按规则保留

这解决的是两个相反风险：

### 风险 1：不压缩
- 上下文爆炸
- 请求失败
- 长跑无法持续

### 风险 2：过度压缩
- 设计动机丢失
- 工具协议组被拆散
- 用户原话丢失
- 模型失去任务锚点

Reasonix 的答案是：
> **压缩要有明确触发线、一次性事务和不可压缩保护集。**

---

## 五、Checkpoint 为什么保存的不只是文件

Reasonix 的 checkpoint 结构很有代表性：
- turn
- prompt
- message index
- session ID
- 文件快照
- coverage
- active writers
- mutation sequence
- session revision

特别关键的是：

### 1. MsgIndex 是会话回滚边界
这意味着它不只是恢复代码，还能恢复：
- 会话消息边界
- 对话分支
- 任务理解状态

### 2. FileSnap 保存编辑前状态和编辑后指纹
这让系统能判断：
- 当前文件是不是被外部改过
- 回滚目标是否仍然有效

### 3. checkpoint 绑定 session revision / mutation seq
这让恢复和回滚不能盲目套用旧状态。

所以 checkpoint 的本质是：
> **代码状态 + 会话状态 + 并发版本 + 覆盖范围的联合快照。**

---

## 六、意图先持久化：为什么文件发布前要先记“可能已经发布”

Reasonix 在事务发布时采取了一个非常成熟的做法：

1. 先持久化“可能已经发布”的意图
2. 再做文件 rename / publish
3. 再持久化已发布进度

这解决的是崩溃窗口：
- 如果刚好崩在 rename 前
- 恢复逻辑也能安全补偿

这条思想不是“多写一个状态字段”，而是：

> **先把恢复意图写进 durable 状态，再执行不可逆或难以判断的外部动作。**

它和两阶段提交、prepare/commit、fencing token 是同一类工程思想。

---

## 七、Prepare / Commit 重验证：为什么 preview 通过不等于可以提交

Reasonix 的回滚事务不是：
- preview 一次
- 用户确认
- 直接执行

而是：

### Prepare 阶段
检查：
- 活跃写入者
- checkpoint 是否完整
- blob 是否过期
- 工作区 token
- 文件冲突

### Commit 阶段
再次检查：
- 计划是否仍存在
- 门条件是否仍满足
- 工作区 token 是否变化
- 是否有新的写入者
- 文件是否发生冲突

这说明 Reasonix 明确承认：

> **Prepare 和 Commit 之间，世界可能已经变化。**

所以旧 preview 不能直接授权新 commit。

---

## 八、GoalEval 为什么必须和 Context / Checkpoint 一起看

Goaleval 是独立的、无工具、无历史、有限预算的审查器。

它每轮判断：
- complete
- continue
- blocked
- uncertain

这和 Context / Checkpoint 的关系是：

- ContextManager 决定审查器看见的有限证据
- GoalEval 决定任务是否可以继续
- Checkpoint 保存可以恢复的状态边界

如果没有这三者的协同：
- 模型可能在上下文失真时自我宣布完成
- 系统可能在证据过期时继续执行
- 恢复后可能沿着错误状态继续走

所以 Reasonix 的长跑不是：
> loop + checkpoint

而是：
> **context view + independent evaluation + durable recovery boundary**

---

## 九、这一章真正解决了哪些工程问题？

### 1. 如何在成本与上下文完整性之间做平衡
解法：缓存优先 + 单一 compact threshold + 保护集

### 2. 如何让上下文变化不破坏稳定前缀
解法：固定 baseline + transient tail

### 3. 如何让恢复同时覆盖文件和会话
解法：FileSnap + MsgIndex + session revision

### 4. 如何防止过期 preview 授权新的回滚
解法：Prepare/Commit 重验证 + WorkspaceToken

### 5. 如何让不可逆文件操作在崩溃后仍可补偿
解法：意图先持久化 + 逐文件进度

### 6. 如何防止评估器在无边界上下文里误判
解法：BoundedLLM + 独立上下文 + fail-closed

---

## 十、关键源码位置

| 文件 | 行数 | 核心职责 |
|------|------|----------|
| `internal/agent/context_manager.go` | 217 行 | Provider-visible context 唯一所有者 |
| `internal/agent/compact.go` | 678 行 | Compaction 核心逻辑 |
| `internal/agent/compact_projection.go` | 582 行 | 压缩投影 |
| `internal/agent/compact_commit.go` | 82 行 | 压缩提交 |
| `internal/agent/context_usage.go` | 54 行 | 上下文使用统计 |
| `internal/agent/context_status.go` | 89 行 | 上下文状态 |
| `internal/checkpoint/checkpoint.go` | 1,042 行 | 检查点核心 |
| `internal/checkpoint/transaction.go` | 1,773 行 | 事务管理（意图先持久化、逐文件发布） |
| `internal/checkpoint/barrier.go` | 153 行 | 写入协调屏障 |
| `internal/checkpoint/capture.go` | 209 行 | 指纹捕获 |
| `internal/checkpoint/blob.go` | 184 行 | BlobStore 内容寻址 |
| `internal/checkpoint/observer.go` | 287 行 | 检查点观察者 |

**阅读顺序建议**：
1. 先读 `context_manager.go`，理解缓存优先设计
2. 再读 `compact.go`，理解 compaction 触发线和单次摘要事务
3. 再读 `checkpoint.go`，理解检查点结构（Turn/Prompt/MsgIndex/Files）
4. 再读 `transaction.go` 的意图先持久化（695-708 行）和逐文件发布（678-743 行）
5. 最后读 `barrier.go`，理解 MutationBarrier 代验证

## 十一、工程问题学习点

| 工程问题 | Reasonix 的解法 | 代价 | 可迁移到 |
|----------|----------------|------|----------|
| 如何在成本与上下文完整性之间做平衡 | 缓存优先 + compact_ratio 0.85 + 保护集 | 需要维护固定前缀和 transient tail | 依赖 prefix cache 的 Agent |
| 如何让上下文变化不破坏稳定前缀 | system prompt + 首用户 turn 字节稳定 + transient tail injection | 变更不能立即反映到前缀 | 长跑 Agent |
| 如何让恢复同时覆盖文件和会话 | FileSnap + MsgIndex + session revision | 检查点更重 | 会修改工作区的 Agent |
| 如何防止过期 preview 授权新 commit | Prepare/Commit 重验证 + WorkspaceToken | 回滚流程更复杂 | 并发修改场景 |
| 如何让不可逆文件操作在崩溃后仍可补偿 | 意图先持久化 + 逐文件进度 | 每步都要持久化 | 有副作用的执行系统 |

## 十二、读者分层路由

### 错觉 1：ContextManager 只是 prompt 拼接器
错，它是 provider-visible context 的唯一维护者。

### 错觉 2：compact_ratio 是性能参数
错，它决定长跑上下文何时进入状态转换。

### 错觉 3：checkpoint 只是文件备份
错，它还保存消息边界、覆盖范围、并发版本和恢复语义。

### 错觉 4：preview 通过就可以 commit
错，prepare 和 commit 之间必须重验证。

### 错觉 5：Goaleval 只要看最终文本就够了
错，它必须使用有界、独立、不带执行噪声的证据视图。

---

## 十一、分析边界

### 为什么这里不先展开 Memory / History
因为这一章重点是上下文与恢复边界；memory/history 的检索策略应该在后续知识层单独分析。

### 为什么不把所有 checkpoint 文件逐个展开
因为第一轮先建立联合快照与事务边界，具体 blob / barrier / observer 可作为源码解析专题。

### 为什么测试和故障注入必须读
checkpoint 的正确性不是看正常路径，而是看 rename 前崩溃、提交前状态变化、blob 过期和并发写入这些失败路径。

---

## 十二、读者分层路由

### beginner
先抓住：
1. ContextManager 决定模型看什么
2. Checkpoint 决定恢复从哪里开始
3. GoalEval 决定能不能继续

### intermediate
重点看：
- prefix stability
- compact threshold
- snapshot / message boundary
- prepare / commit revalidation

### advanced
重点看：
- 意图先持久化
- WorkspaceToken 代验证
- 事务目标 Restore / Forward 分离
- BoundedLLM 的证据预算与 fail-closed

---

## 十三、迁移清单

### 可迁移思想 1：上下文固定前缀与变化尾部隔离
- 适合：依赖 prompt cache、长跑、多轮 Agent
- 前提：系统能区分稳定基线和会话内变化
- 不适合：每轮上下文都完全不同的短任务

### 可迁移思想 2：checkpoint 同时保存代码和会话边界
- 适合：会修改工作区并需要 continue / rewind 的 Agent
- 前提：文件状态和对话状态必须一起恢复
- 不适合：纯只读分析器

### 可迁移思想 3：Prepare / Commit 之间重新验证
- 适合：任何存在并发修改或延迟提交的事务系统
- 前提：preview 与 commit 不是同一个原子调用
- 不适合：没有外部状态变化的纯函数流程

### 可迁移思想 4：证据有界、审查独立、失败默认暂停
- 适合：无人值守 Agent / 自动验收器
- 前提：错误继续的代价高于暂停
- 不适合：低风险、可随意重试的实验任务

---

## 十四、自测问题

1. 为什么 Reasonix 要把 ContextManager 设成 provider-visible context 的唯一所有者？
2. 为什么固定前缀和 transient tail 必须分开？
3. 为什么 checkpoint 要同时保存文件和消息边界？
4. 为什么 prepare 通过后，commit 还必须重验证？
5. 为什么 GoalEval 必须使用有界、独立的证据视图？

---

## 十五、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释 Reasonix 如何在缓存成本、上下文完整性和长跑恢复之间做平衡。
2. 说清 ContextManager、Checkpoint、GoalEval 三者如何共同构成 durable execution 的稳定边界。
3. 理解为什么“保存文件”不等于“保存可恢复状态”。
4. 理解意图先持久化、prepare/commit 重验证和 workspace token 的工程意义。
5. 用自己的话说明：Reasonix 为什么能把 Agent 长跑中的上下文、文件、评估和恢复放进同一个状态系统。

如果还做不到这些，就说明这章还没真正学懂。
