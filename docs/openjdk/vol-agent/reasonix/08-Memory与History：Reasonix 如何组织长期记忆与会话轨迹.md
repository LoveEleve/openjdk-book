# Memory 与 History：Reasonix 如何组织长期记忆与会话轨迹

> 项目：Reasonix（main-v2 基线）
> 角色：主线机制正文 07
> 对应范围规划：`01-Reasonix源码学习范围规划.md`
> 依据材料：`Agent/analysis/reasonix/01-闭环笔记/pass2-rq5-memory.md`

---

## 零、阅读前提示

- 建议先读：
  1. `04-RunLoop与DurableExecution：Reasonix 如何把 Agent 变成长跑任务系统.md`
  2. `05-ContextManager与Checkpoint：Reasonix 如何在缓存与恢复之间保持长跑稳定.md`
  3. `06-Goaleval与BoundedLLM：Reasonix 为什么把完成判定做成独立审查器.md`
- 推荐源码阅读路径：
  1. `internal/memory/doc.go`
  2. `internal/memory/subject.go`
  3. `internal/memory/store_v2.go`
  4. `internal/memory/recall.go`
  5. `internal/history/search.go`

## 一、这一章真正的问题

到前面几章为止，Reasonix 已经有了：
- Controller
- RunLoop
- ContextManager
- Checkpoint
- Goaleval
- Permission / WorkspaceLease

但一个长跑 Agent 系统，只解决“当前这轮怎么跑”还不够，它还必须回答：

> **过去积累下来的事实、经验、偏好和历史会话，到底怎么组织，才能在不破坏缓存稳定性的前提下帮助后续任务。**

所以这一章真正要回答的是：

1. Reasonix 的 memory 和 history 为什么要分成两层？
2. 为什么记忆要“恰好一次进前缀”，而不是每轮动态改写？
3. 为什么 subject 冲突模型对长期知识库这么重要？
4. BM25 召回、作用域覆盖、归档与老化到底在保护什么？

---

## 二、先给结论：Reasonix 的记忆不是“多存一点东西”，而是受缓存优先原则支配的长期知识系统

最容易犯的错，是把 memory 理解成：
- 一个笔记库
- 或者一个简单的检索层

这会把它看浅。

更准确的理解是：

> **Reasonix 的 memory 是一个围绕“缓存优先 + 一问题一答案 + 前缀稳定”设计的长期知识库。**

它要同时满足：
- 新 session 启动时，可以把稳定记忆恰好一次折叠进前缀
- 会话中途新增或变更记忆时，不破坏当前前缀缓存
- 同一知识点不能越积越矛盾
- 记忆可以老化、过期、归档，但不会无痕删除

所以它真正解决的不是“记忆保存”，而是：
> **在长跑 Agent 系统中，长期知识如何进入上下文而不把系统搞乱。**

---

## 三、为什么“记忆恰好一次进前缀”是 Reasonix 的第一性原则

Reasonix 在 memory 上最有代表性的判断是：

> **记忆在 session 启动时恰好一次折叠进 durable system-prompt prefix。**

这听起来像性能技巧，但本质上是架构哲学。

### 它在解决什么问题？
如果你每轮都把 memory 重新注入前缀：
- prompt bytes 改变
- provider prefix cache 命中下降
- 每轮 token 成本膨胀
- 上下文语义更容易漂移

Reasonix 的做法是：
- 启动时折进前缀一次
- 会话中途新增记忆，走 controller 的 transient tail injection
- 到下一 session 才重新沉淀进前缀

这说明它在 memory 上遵守的是：
> **稳定知识 → 稳定前缀；中途变化 → 瞬时尾部。**

这不是普通记忆系统会首先想到的设计，它明显和 ContextManager 的缓存优先哲学是同一条主线。

---

## 四、Subject 冲突模型：为什么“一问题一答案”这么关键

Reasonix 的记忆系统还有一个非常值钱的判断：

> **同一个 subject（问题），在同一 scope 下只能有一个活动答案。**

它不允许：
- 同一个知识点同时挂两三个互相打架的 memory 条目

而是要求：
- 新答案应该更新旧 fact（revision++）
- 不是再创建一个并存事实

### 这在解决什么问题？
长期运行的 Agent 最容易变坏的一种方式就是：
- 旧结论留着
- 新结论再写一个
- 最后检索时两个都召回
- 模型自己选一个

这会让系统越来越不可信。

所以 subject 冲突模型在保护的是：
> **知识库内部的一致性。**

这和我们前面讲 durable truth 的哲学一致：
- 真相不允许并列矛盾
- 更新必须显式版本化

---

## 五、Activation：为什么记忆也要分 pinned 和 relevant

并不是所有记忆都值得常驻在系统前缀里。

Reasonix 在这里明确区分：
- `pinned`
- `relevant`

### pinned
- 常驻前缀
- 是长期稳定、始终应该影响任务的知识

### relevant
- 不常驻
- 按需召回

这条设计非常重要，因为如果不分层：
- memory 会无限膨胀
- 前缀会越来越重
- 当前任务会被大量低价值旧知识污染

所以 pinned / relevant 的真正意义是：
> **长期知识也必须有上下文经济学。**

这和 OpenCode 的 output store / skill guidance 分层，其实是同一类思想：
- 所有东西都不该默认进入主上下文

---

## 六、为什么 Freshness / ExpiresAt / LastVerifiedAt 是核心，而不是附属字段

很多系统里的记忆，只解决：
- 如何保存
- 如何检索

Reasonix 还解决：
- **什么时候这条知识已经不值得再信任**

所以它引入了：
- `Volatility`
- `ExpiresAt`
- `LastVerifiedAt`
- freshness 分类

这说明它不把记忆看成永远正确，而是承认：
> **知识也有保质期。**

这对于 Agent 系统特别重要，因为：
- 环境会变
- 配置会变
- 用户偏好会变
- 项目事实会变

如果没有 freshness 模型，memory 很快就会变成：
- 越存越多
- 越召回越错

所以 freshness 真正在解决的是：
> **长期记忆的老化与可继续信任性。**

---

## 七、为什么 BM25 检索与作用域覆盖值得单独讲

Reasonix 的 recall 不是“搜一下字符串”，而是：
- QueryTerms
- 文档频率
- BM25 打分
- 相对分数地板
- 稳定排序

这说明它真正关心的不是：
- 能不能搜到

而是：
- 能不能只把最相关的一小撮拉进来
- 避免尾部噪音污染 prompt

此外，它还有一条很重要的规则：

> **项目级 fact 可以覆盖全局 fact，但两者都仍然保留在管理面可见。**

这条规则很值钱，因为它把：
- 使用时的作用域优先级
- 和知识库内部的可追踪性
分开了。

也就是说：
- 运行时看项目级覆盖
- 管理面仍能看到全局和项目级并存

这是非常成熟的知识层设计。

---

## 八、为什么 Archive 软删除比直接删掉更重要

Reasonix 对旧记忆的处理不是：
- 直接 delete

而是：
- 移到 `.archive/`

这意味着它承认：
> **错误记忆、过期记忆、被替代记忆仍然是系统历史的一部分。**

这很重要，因为如果你直接删：
- 后面很难解释为什么系统以前会这样判断
- 错误知识会失去可追踪性

所以 archive 的价值不是“保留备份”，而是：
> **给知识系统保留演化轨迹。**

---

## 九、Memory 和 History 为什么必须分两层

这是这章最关键的结构判断之一。

### Memory
- 持久化事实
- subject 冲突模型
- frontmatter 文件
- 前缀注入 / relevant 召回

### History
- 原始会话轨迹
- BM25 搜索
- Around 上下文窗口
- JSONL / catalog

这两层不能混。

因为它们解决的是两种完全不同的问题：

### Memory 解决：
- 系统应该长期记住什么事实

### History 解决：
- 系统以前具体说过什么、做过什么

如果把两者混成一个库：
- 会话噪音会污染长期知识
- 长期知识会失去结构化约束

所以 Reasonix 在这里做的其实是：
> **“事实层”和“轨迹层”的分离。**

这是非常值得迁移的设计。

---

## 十、这一章真正解决了哪些工程问题？

### 1. 如何让长期记忆进入系统，但不破坏缓存稳定性
Reasonix 的解法：记忆恰好一次进前缀，变化走 transient tail

### 2. 如何防止知识库内部积累互相矛盾的事实
Reasonix 的解法：Subject 冲突模型，一问题一答案

### 3. 如何让记忆系统具备上下文经济学
Reasonix 的解法：Activation 分层（pinned / relevant）

### 4. 如何让记忆承认自己会过期
Reasonix 的解法：freshness / volatility / expiresAt / lastVerifiedAt

### 5. 如何把“事实存储”和“会话轨迹”拆开
Reasonix 的解法：memory 层 vs history 层

所以这一章最值得学的，不是“Reasonix 也有 memory”，而是：

> **它把长期知识、作用域优先级、老化机制、检索和轨迹回溯，组合成了一套相对完整的知识系统。**

---

## 十一、关键源码位置

| 文件 | 行数 | 核心职责 |
|------|------|----------|
| `internal/memory/doc.go` | 66 行 | 记忆架构总纲：缓存优先、两层记忆模型 |
| `internal/memory/subject.go` | 90 行 | Subject 知识冲突模型：一问题一答案 |
| `internal/memory/store_v2.go` | — | Memory 结构、写入校验、pinned 预算、乐观并发 |
| `internal/memory/recall.go` | 110-174 行 | BM25 检索、相对分数地板、ShadowHits 影子排名 |
| `internal/memory/activation.go` | 44 行 | pinned vs relevant 分层 |
| `internal/memory/freshness.go` | — | 事实老化、过期、续期 |
| `internal/memory/auto_recall.go` | 24 行 | 自动召回的低权威声明 |
| `internal/memory/render.go` | — | frontmatter 标准格式 |
| `internal/history/search.go` | — | History 会话检索（BM25 + Around 上下文窗口）|

**阅读顺序建议**：
1. 先读 `doc.go`（1-16 行），理解缓存优先的极致设计
2. 再读 `subject.go`，理解"一问题一答案"冲突模型
3. 再读 `store_v2.go` 的 `validateSave`，理解 pinned 预算和乐观并发
4. 再读 `recall.go`，理解 BM25 召回和相对分数地板
5. 最后读 `history/search.go`，理解 Memory 与 History 的分工

## 十二、工程问题学习点

| 工程问题 | Reasonix 的解法 | 代价 | 可迁移到 |
|----------|----------------|------|----------|
| 如何让长期记忆进入系统但不破坏缓存稳定性 | 记忆恰好一次进前缀 + transient tail injection | 变更不能立即反映到前缀 | 依赖 prefix cache 的 Agent |
| 如何防止知识库内部积累矛盾事实 | Subject 冲突模型（一问题一答案） | 新答案必须更新旧 fact，不能并存 | 长期知识库型 Agent |
| 如何让记忆系统具备上下文经济学 | Activation 分层（pinned / relevant） | 需要判断哪些知识值得常驻 | 上下文预算敏感的系统 |
| 如何让记忆承认自己会过期 | freshness / volatility / expiresAt / lastVerifiedAt | 需要维护过期和续期逻辑 | 长期运行的 Agent |
| 如何把"事实存储"和"会话轨迹"拆开 | Memory 层 vs History 层 | 需要维护两套检索系统 | 既要长期知识又要历史回放的系统 |

## 十三、读者分层路由

### 错觉 1：memory 就是笔记库
错。它是受缓存优先和冲突模型约束的知识系统。

### 错觉 2：session 中途更新记忆，就应该立即改前缀
错。Reasonix 刻意避免破坏当前前缀缓存。

### 错觉 3：subject 只是标签
错。subject 决定一问题一答案的知识冲突模型。

### 错觉 4：history 和 memory 差不多
错。一个是事实层，一个是轨迹层。

### 错觉 5：archive 只是垃圾桶
错。它在保留知识演化轨迹。

---

## 十二、分析边界

### 为什么这里不先讲 instruction 文档加载细节
因为这一章重点是 memory / history 的知识组织模型，不是 standing instructions 本身的文件加载实现。

### 为什么 BM25 是核心而不是细节
因为如果 recall 没有 relevance ranking，长期记忆会迅速变成提示噪音。

### 为什么这里必须把 archive / freshness 讲进去
因为长期知识系统的难点不在“存下来”，而在“如何不被旧知识反噬”。

---

## 十三、读者分层路由

### beginner
先抓住：
1. memory 不是聊天历史
2. history 不是长期知识库
3. 记忆不是每轮都重写前缀

### intermediate
重点看：
- subject 冲突模型
- pinned / relevant
- freshness / archive
- BM25 / scope override

### advanced
重点看：
- 缓存优先前缀哲学
- 记忆与上下文工程的耦合
- “事实层 vs 轨迹层”分离的长期系统价值

---

## 十四、迁移清单

### 可迁移思想 1：记忆恰好一次进前缀
- 可迁移到：任何成本敏感、前缀缓存敏感的 Agent
- 前提：存在稳定前缀和 transient tail 的区分
- 不适合直接照搬到：不依赖缓存、会话极短的系统

### 可迁移思想 2：一问题一答案（subject 冲突模型）
- 可迁移到：任何长期知识库型 Agent
- 前提：需要防止矛盾事实并存
- 不适合直接照搬到：完全无结构笔记系统

### 可迁移思想 3：事实层与轨迹层分离
- 可迁移到：既要长期知识又要历史回放的系统
- 前提：事实和原始轨迹有不同消费路径
- 不适合直接照搬到：只做短期对话记忆的轻量系统

### 可迁移思想 4：archive + freshness
- 可迁移到：长期运行、环境会变化的 Agent
- 前提：知识会过期、会被替换、需要审计
- 不适合直接照搬到：静态知识库或短生命周期系统

---

## 十五、自测问题

1. 为什么 Reasonix 的记忆不能每轮都重写前缀？
2. 为什么 subject 冲突模型能防止知识库越来越不可信？
3. pinned 和 relevant 分层在解决什么问题？
4. 为什么 memory 和 history 必须分成两层？
5. 为什么 archive / freshness 对长期 Agent 知识系统很关键？

---

## 十六、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释 Reasonix 为什么把记忆系统设计成缓存优先知识系统，而不是普通笔记库。
2. 说清 subject 冲突模型、一问题一答案的意义。
3. 理解 memory / history / archive / freshness 各自负责什么。
4. 理解作用域覆盖和 BM25 召回为什么对长期运行的 Agent 很重要。
5. 用自己的话说明：Reasonix 是如何把长期知识、临时会话和历史轨迹拆开又协同起来的。

如果还做不到这些，就说明这章还没真正学懂。
