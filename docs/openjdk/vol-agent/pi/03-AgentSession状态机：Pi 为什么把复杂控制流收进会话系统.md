# AgentSession 状态机：Pi 为什么把复杂控制流收进会话系统

> 项目：Pi（main 基线）
> 角色：主线机制正文 02
> 对应范围规划：`01-Pi源码学习范围规划.md`
> 依据材料：
> - `Agent/analysis/pi/01-闭环笔记/pass2-q1-agent-session.md`
> - `Agent/analysis/pi/01-闭环笔记/pass2-q2-session-manager.md`

---

## 零、阅读前提示

- 建议先读：
  1. `01-Pi源码学习范围规划.md`
  2. `02-AgentLoop：Pi 的执行骨架如何组织 turn、tools 与 continuation.md`
  3. `../03-Agent源码前置认知桥.md`
- 推荐源码阅读路径：
  1. `coding-agent/src/core/agent-session.ts`
  2. `coding-agent/src/core/session-manager.ts`
  3. `agent/test/harness/reducer.test.ts`
  4. `coding-agent/test/agent-session-concurrent.test.ts`

## 一、这一章真正的问题

上一章已经解释了：
- Pi 的 Agent loop 为什么有双入口和双层循环
- steering / follow-up / tool continuation 为什么要被分层消费

但真正的复杂度中心不在 loop 本身，而在：

> **这些执行控制流、压缩、重试、错误恢复、bash abort、扩展事件，最后是如何被统一收进一个会话级状态机里的。**

也就是说，这一章真正要回答的是：

1. 为什么 `AgentSession` 是 Pi 的真正复杂度中心？
2. 它如何承接上一章的 loop，而不把状态散落在 modes 和前端里？
3. 为什么 Pi 要用 append-only 树形 JSONL 会话，而不是普通线性消息列表？
4. 为什么 compaction、branch、label、fork、history 都必须放到 session 级来理解？

---

## 二、先给结论：Pi 的核心不是 loop，而是一个共享于多前端的会话状态机

最容易犯的错，是读完上一章就以为：
- Agent loop 就是 Pi 的核心

这会把项目看浅。

更准确的理解是：

> **Pi 的 loop 只是执行骨架，而 `AgentSession` 才是把 steering / follow-up / compaction / retry / overflow / runtime 模式收束成系统状态的中心对象。**

为什么这么说？因为：
- interactive / print / rpc 三种模式都共享它
- session manager 的树形会话存储围绕它转
- compaction 的摘要重建围绕它转
- 分支 / fork / label / context 也围绕它转

所以 `AgentSession` 在 Pi 里不是会话容器，而是：
> **会话级执行状态机。**

---

## 三、为什么“一个核心状态机 + 多个 I/O 壳”是 Pi 的第一性原则

`agent-session.ts` 的注释已经把设计说得很明白：
- 它是 shared between all run modes

这句话的价值非常高，因为它说明 Pi 一开始就在坚持：

> **前端形态不能各自重写执行语义。**

这和我们在 Reasonix 看到的单控制器哲学很接近，但表达方式不同：
- Reasonix：Controller 统一所有前端
- Pi：AgentSessionRuntime / AgentSession 统一所有 modes

它在解决的问题其实是一样的：
- 不让 UI / CLI / RPC 自己发明会话状态
- 不让多种外壳把生命周期搞出多套版本

所以在 Pi 里，前端只是壳；真正会话怎么继续、怎么压缩、怎么重试、怎么转分支，都必须回到 AgentSession。

---

## 四、为什么 steering / follow-up 最终必须收进 session 状态机

上一章我们已经知道：
- steering 是对当前执行的干预
- follow-up 是当前执行结束后的后续任务

这一章要进一步理解的是：

> **为什么这两类消息最后不能只停留在队列里，而必须进入会话状态机。**

因为如果它们只是 loop 里的临时队列：
- 压缩时会丢语义
- reload 时无法恢复
- fork / branch 后无法稳定继承
- UI 看到的状态和执行中的状态会脱节

Pi 把它们收进 AgentSession，等于在做：
- 会话级输入控制面
- 而不是回合级临时变量管理

这件事的真正价值是：
> **会话不是消息容器，而是控制流容器。**

---

## 五、Compaction 为什么在 Pi 里是“摘要重建上下文”，不是删消息

Pi 的 compaction 设计和 OpenCode / Reasonix 有共鸣，但风格又不一样。

它真正的动作不是：
- 删掉旧消息

而是：
1. 生成 compaction summary 条目
2. 再基于摘要条目 + 保留尾巴 + 新消息重建上下文
3. 最后替换内存里的 `agent.state.messages`

这说明它在解决的是：

> **如何让历史继续存在，但让模型只看“摘要化后仍然有执行意义”的视图。**

这里最重要的不是压缩算法，而是：
- 压缩结果如何被会话状态机正式承认
- 压缩前后的消息视图怎么切换
- 压缩是否成为 session 历史的一部分

所以在 Pi 里，compaction 已经不是“优化项”，而是：
> **会话状态转换的一种正式操作。**

---

## 六、为什么 SessionManager 不是简单持久化，而是树形会话真相层

Pi 的另一个非常值钱的设计，是它没有把会话存成：
- 线性消息数组
- 覆盖式 JSON

而是：
- JSONL 追加写
- 树形条目结构
- `leaf` 指针追踪当前分支位置
- branch / branchSummary / createBranchedSession / labels

这意味着：

> **Pi 从一开始就承认：会话不是线性的，它会分叉，会回退，会导出单线成果。**

### 这在解决什么问题？
- 分析过程中走错了，不该改历史，而该 branch
- 同一棵历史树里，需要保留不同探索路径
- 最终又可能从一条分支导出一条“干净的会话主线”

这很像代码里的：
- branch
- summary
- fork
- label

所以 SessionManager 在 Pi 里不是存档层，而是：
> **会话树与探索路径的真相层。**

---

## 七、为什么 `custom` / `label` / `session_info` 这些条目很关键

在很多系统里，所有数据最后都被强行塞进 message 流里。

Pi 的成熟点在于：
- 它允许会话文件里有 message 之外的条目类型
- 并明确规定它们是不是参与 LLM 上下文

特别是：

### `custom`
- 可持久化扩展状态
- 但不进入 LLM 上下文

### `label`
- 给任意条目打标签
- 帮助后续结构化回看、筛选、导出

### `session_info`
- 元数据
- 同样不进入上下文

这说明 Pi 已经清楚地区分了：
- **系统状态**
- **LLM 可见状态**

这和 OpenCode 的 ToolOutputStore、Reasonix 的 memory/history 分层是同一类成熟设计。

---

## 八、为什么 Pi 的状态机值得单独学

如果只看 loop，你看到的是：
- 继续不继续
- 工具调不调

但在 AgentSession 里，你看到的其实是：
- steering
- follow-up
- pending
- compaction
- overflow recovery
- retry
- bash abort
- runtime hot reload
- extension runner

这些东西共同说明：

> **Pi 真正想解决的不是“如何完成一轮”，而是“会话在长时间、多形态、可中断、可压缩、可分叉条件下如何稳定演进”。**

这就是为什么它会成为 Pi 的复杂度中心。

---

## 九、这一章真正解决了哪些工程问题？

### 1. 如何让多前端共用一个执行语义核心
Pi 的解法：AgentSession / AgentSessionRuntime

### 2. 如何把 steering / follow-up / compaction / retry 收进统一会话状态机
Pi 的解法：AgentSession 大状态机

### 3. 如何把会话历史从线性流升级成树形探索结构
Pi 的解法：SessionManager JSONL + parentId + leaf + branch

### 4. 如何让压缩变成会话级状态转换，而不是临时优化
Pi 的解法：compaction summary + 上下文重建

### 5. 如何让扩展状态和会话标签持久化，但不污染 LLM 上下文
Pi 的解法：custom / label / session_info 条目类型分层

所以这一章真正要学的，不是“Pi 会话很多功能”，而是：

> **Pi 如何把 Agent 的执行、历史、分叉、压缩、标签和扩展状态统一进同一个会话状态机。**

---

## 十、读者最容易学错的地方

### 错觉 1：AgentSession 只是会话容器
错。它是会话级控制流和状态机的核心。

### 错觉 2：SessionManager 只是把消息写进 JSONL
错。它实际上在维护一棵会话树。

### 错觉 3：compaction 只是压缩历史
错。它会重建上下文并改变当前可见状态。

### 错觉 4：branch 只是复制会话
错。它在保护“试错但不改历史”的探索语义。

### 错觉 5：custom/label 只是元数据
错。它们在区分“系统状态”和“LLM 可见状态”上非常关键。

---

## 十一、分析边界

### 为什么这里不先深入每种前端模式
因为这一章要先回答“共享内核如何成立”，而不是每个外壳怎么渲染。

### 为什么这里不先展开 provider 细节
因为 Pi 的 provider 层是另一条主线，这一章先聚焦会话状态机和会话树真相层。

### 为什么测试是关键证据
AgentSession 的价值大量体现在并发、压缩、归约、分支、异常恢复这些行为契约里，不看测试很容易低估它的复杂度。

---

## 十二、读者分层路由

### beginner
先抓住：
1. Pi 的核心不只是 loop，而是会话状态机
2. 会话不是线性的，而会分叉
3. compaction 会重建上下文，而不是单纯删历史

### intermediate
重点看：
- AgentSession 大状态机
- SessionManager 的 JSONL 树模型
- compaction summary 和上下文重建
- custom / label / session_info 分层

### advanced
重点看：
- steering / follow-up / pending 的会话级语义
- branch / createBranchedSession 的探索路径哲学
- 为什么会话树比消息流更适合长期分析型 Agent

---

## 十三、迁移清单

### 可迁移思想 1：一个核心状态机 + 多个 I/O 壳
- 可迁移到：interactive / print / rpc 并存的 Agent
- 前提：需要共享执行语义
- 不适合直接照搬到：单一前端、无多形态需求的系统

### 可迁移思想 2：会话历史树而不是线性消息流
- 可迁移到：需要探索、回退、分叉、导出单线成果的分析型 Agent
- 前提：系统允许多分支探索
- 不适合直接照搬到：简单问答型系统

### 可迁移思想 3：custom / label / session_info 与 message 分层
- 可迁移到：需要持久化扩展状态但不想污染模型上下文的系统
- 前提：系统状态和 LLM 可见状态可分离
- 不适合直接照搬到：极简单无扩展系统

### 可迁移思想 4：compaction 作为状态转换而不是工具函数
- 可迁移到：长跑、上下文敏感的 Agent
- 前提：压缩结果需要正式进入会话历史
- 不适合直接照搬到：没有持久会话层的小系统

---

## 十四、自测问题

1. 为什么说 Pi 的核心复杂度中心不在 loop，而在 AgentSession？
2. 为什么 SessionManager 的价值不只是 JSONL 落盘，而是树形会话真相层？
3. 为什么 compaction 在 Pi 里是会话状态转换，而不只是压缩历史？
4. 为什么 `custom` / `label` / `session_info` 这些条目类型很关键？
5. 为什么 branch / fork / createBranchedSession 对分析型 Agent 特别重要？

---

## 十五、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释为什么 Pi 要把复杂控制流统一收进会话状态机，而不是散在 loop 和前端里。
2. 说清 JSONL 树形会话模型比线性消息流多解决了什么问题。
3. 理解 compaction、branch、label、custom entry 在会话系统里的系统角色。
4. 理解 Pi 为什么更像一个“共享运行时 + 会话树系统”，而不只是一个会调模型的 CLI。
5. 用自己的话说明：Pi 如何把执行、历史、分叉、压缩和扩展状态收进同一个会话外壳里。

如果还做不到这些，就说明这章还没真正学懂。
