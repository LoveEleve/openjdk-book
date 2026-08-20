# SessionFacade 与 Snapshot：OpenCode 如何把内部真相变成可恢复的会话外壳

> 项目：OpenCode (`v1.18.18` 基线)
> 角色：主线机制正文 09
> 对应范围规划：`01-OpenCode源码学习范围规划.md`
> 依据材料：
> - `Agent/analysis/opencode/01-闭环笔记/q10-session-facade.md`
> - `Agent/analysis/opencode/01-闭环笔记/q16-snapshot.md`

---

## 零、阅读前提示

- 建议先读：
  1. `00-OpenCode主线总图.md`
  2. `02-EventV2与SessionInput...`
  3. `03-SessionRunner与SessionExecution...`
  4. `07-SessionProjector与History...`
- 推荐源码阅读路径：
  1. `packages/core/src/session.ts`
  2. `packages/core/src/session/history.ts`
  3. `packages/core/src/session/revert.ts`
  4. `packages/core/src/snapshot.ts`
  5. `packages/core/test/session-create.test.ts` / `session-history.*` / `move-session.*`

## 一、这一章真正的问题

前面几章一直在讲 OpenCode 的内部控制面：
- durable truth
- 执行骨架
- 工具结算
- 上下文工程
- 权限控制
- 可见会话投影

但对用户来说，最后真正接触到的是一个更“像产品”的对象：

- 我怎么创建一个 session？
- 我怎么看它的消息、history、context？
- 我怎么恢复、打断、回滚、切换模型/agent？
- 系统怎么保证这些外部操作不会破坏内部真相？

所以这一章真正要回答的是：

> **OpenCode 如何把底层的 durable execution 内核封装成一个“可读、可恢复、可回滚”的会话外壳。**

---

## 二、先给结论：Session Facade 不是 API 包装层，而是“受约束的外部操作面”

最容易犯的错，是把 `session.ts` 理解成：
- 把几个底层函数包起来
- 暴露给外面一个简单接口

这会把它看得太浅。

更准确的理解是：

> **Session Facade 是 V2 全部外部操作的唯一入口。**

这意味着：
- 它不是“方便调用一下”
- 而是要负责定义：
  - 什么操作存在
  - 什么操作未实现但必须显式报错
  - 什么操作是幂等的
  - 什么操作会触发 wake / resume / revert
  - 外部看到的 history / messages / events 到底遵守什么规则

所以它更像：
> **Agent 会话系统的公共控制面。**

---

## 三、为什么 create / prompt / list 这些操作值得认真看

在普通系统里，这些接口很容易被看成无聊 CRUD。

OpenCode 不是这样。

### create
它不是简单 insert session，而是：
- 如果同 ID 已存在，返回现有
- 并发创建时，投影竞态失败后再重读已有结果

这说明 create 真正要保证的是：
> **会话身份的幂等性与外部可见一致性。**

### prompt
它不是“往消息里加一句话”，而是：
- 先 admit 到收件箱
- 再根据参数决定要不要 wake execution
- 并且 admit 本身不能被打断

这说明 prompt 不是文本附加，而是：
> **对 durable 输入和执行推进的复合操作。**

### list
它也不只是“查数据库”，而是：
- 要支持 anchor-based 分页
- previous 方向时还要反转顺序
- 搜索按标题 LIKE
- 顺序不能因为新消息插入而乱掉

这里反映的是：
> **会话列表本身也需要稳定顺序语义。**

---

## 四、History 为什么是“视图定义”，不是简单消息查询

OpenCode 的 `history.ts` 特别值得学，因为它回答了一个通常会被忽略的问题：

> **用户应该看到哪些历史消息，哪些应该被过滤掉？**

这不是 UI 选择，而是系统语义定义。

### 关键规则 1：compaction 之前的消息被替换
如果已经 compaction 了，旧历史不应该原样再暴露，因为系统已经承认：
- 那部分上下文被 summary / baseline 替换了

### 关键规则 2：baseline 之前的 system 消息不再重复进 history
因为它们已经是当前上下文基线的一部分。

### 关键规则 3：baseline 之后的 system 更新必须保留
因为这些是时间序更新，不是初始背景。

所以 OpenCode 的 history 不是“全量消息列表”，而是：
> **经过 compaction 和 baseline 语义过滤后的用户可见历史。**

这很成熟，因为它避免了：
- 用户看到一堆系统噪声
- runner 看到的上下文和用户理解到的历史不一致

---

## 五、为什么分页必须按 seq，而不是按时间戳

这和前面 projector 那一章的逻辑一脉相承。

OpenCode 不信任：
- 本地时间戳
- 客户端顺序
- 流式到达顺序

它优先信任：
- durable event seq

所以：
- messages 分页按 seq 做 anchor
- previous 时反转
- 这样新消息插入时，不会把老分页语义搞乱

这件事值钱的地方在于：
> **它把“分页”也纳入了 durable truth 的秩序里。**

也就是说，这里不是简单“数据库分页技巧”，而是：
- 产品层行为
- 服从底层事件真相顺序

---

## 六、Snapshot 为什么不是附加功能，而是“运行历史的可操作版本”

`snapshot.ts` 这一层也很容易被低估。

很多人会把 snapshot 理解成：
- 备份一下当前文件
- 方便撤销

OpenCode 不止如此。

它做的是：
- 复用 git tree 作为快照对象
- 利用 git 的内容寻址做天然去重
- 允许 preview / restore / checkout / files / diff
- 并且把 step 前后的 changed files 挂回执行事件里

所以 Snapshot 在这里的价值是：

### 1. 它不是无结构备份
而是有路径、有树、有 diff、有 preview 的结构化快照。

### 2. 它让“这一步改了什么”变成可审计对象
这对 Agent 特别重要，因为很多时候真正想知道的不是：
- 最终结果是什么
而是：
- **这一轮执行到底改了什么**

### 3. 它让 revert 不是黑箱回退
因为 revert 可以：
- stage
- clear
- commit
- 并绑定具体文件集

这说明 snapshot 在 OpenCode 里不是“恢复按钮”，而是：
> **可操作的会话历史层。**

---

## 七、为什么 MoveSession / Revert / Snapshot 应该放在一起理解

表面上：
- move session
- revert
- snapshot
似乎是三个功能。

但它们共同回答的是：

> **会话不是只会向前跑，它还要在空间（location）和时间（history）两个维度上被安全地移动、查看和回退。**

### MoveSession
回答：
- 会话和 project / location 的绑定如何迁移？

### Snapshot
回答：
- 执行前后状态如何被捕获、对比、预览？

### Revert
回答：
- 用户如何把这些快照差异转化为受控回滚操作？

这三者合在一起，才形成：
> **会话可恢复、可审计、可回退的外壳能力。**

---

## 八、这一章真正解决了哪些工程问题？

### 1. 如何把底层复杂控制面封装成稳定会话操作面
OpenCode 的解法：Session Facade

### 2. 如何保证 history 既可读，又不和当前上下文真相冲突
OpenCode 的解法：history filtering based on compaction + baseline

### 3. 如何让分页、消息顺序、历史视图服从 durable truth
OpenCode 的解法：seq-based anchor + durable event order

### 4. 如何把“改了哪些文件”纳入可审计状态
OpenCode 的解法：snapshot capture + changed files 进入 step 结果

### 5. 如何提供安全的回滚与搬家能力
OpenCode 的解法：move session + revert state + snapshot diff/preview/restore

所以这一章最值得学的不是“外部接口长什么样”，而是：

> **一个成熟 Agent 系统，如何把内部真相层封装成用户真正可操作的会话外壳，而不破坏一致性。**

---

## 九、读者最容易学错的地方

### 误区 1：把 Session Facade 当 API 薄包装
错。它定义的是外部操作面和行为契约。

### 误区 2：把 history 当全量消息列表
错。它是经过 compaction / baseline 过滤后的视图定义。

### 误区 3：把 snapshot 当简单备份
错。它是结构化、可 diff、可 preview、可 restore 的历史层。

### 误区 4：把 revert 当一个按钮功能
错。它是基于 snapshot state machine 的受控回退协议。

### 误区 5：把 move session 看成目录切换
错。它在处理会话与 location/project 的绑定迁移。

---

## 十、分析边界

### 为什么这里不先深入 UI / TUI / Web 的会话展示
因为这一章关心的是“会话如何被定义、分页、恢复、回退”，不是界面如何渲染它。

### 为什么这里不先展开 git 实现细节
因为第一轮重点是 snapshot 作为 Agent 历史层的系统角色，而不是 git plumbing 本身。

### 为什么测试仍然是关键证据
create 幂等、history 过滤、分页锚点、move session 边界，这些行为契约很多必须从测试里确认。

---

## 十一、读者分层路由

### beginner
先抓住：
1. Session Facade 不是 CRUD 接口，而是外部控制面
2. history 不是全量历史，而是有过滤规则的视图
3. snapshot / revert 不是附属功能，而是恢复和审计能力

### intermediate
重点看：
- create / prompt / list / history / messages
- baseline / compaction 过滤规则
- seq anchor 分页
- snapshot / revert / move session 语义

### advanced
重点看：
- 为什么对外会话视图必须服从事件真相顺序
- why snapshot 选择 git tree 而不是自建 CAS
- move / revert / snapshot 如何与 event/session runtime 联动

---

## 十二、迁移清单

### 可迁移思想 1：History 是过滤后的视图定义，不是原始日志导出
- 可迁移到：任何有 compaction / baseline / replay 的 Agent 系统
- 前提：存在 durable truth 和用户可见视图的分层
- 不能照搬的点：简单 chat app 不需要这么复杂的历史过滤

### 可迁移思想 2：分页也服从 durable seq
- 可迁移到：需要 continue / replay / resume 的会话系统
- 前提：有统一事件顺序
- 不能照搬的点：没有 durable event 层的系统无法直接复制

### 可迁移思想 3：snapshot = 可操作历史层
- 可迁移到：任何会修改文件、需要回退和审计的 Agent 系统
- 前提：副作用必须能被结构化追踪
- 不能照搬的点：纯只读 Agent 可能不需要完整 snapshot 体系

### 可迁移思想 4：外部控制面必须显式定义“未实现但属于契约的操作”
- 可迁移到：正在渐进演进的大型 Agent runtime
- 前提：系统允许先立契约再补实现
- 不能照搬的点：短命实验项目没必要有这么强的契约外壳

---

## 十三、自测问题

1. 为什么 Session Facade 不应该被理解成 API 薄包装？
2. 为什么 history 不能直接把所有消息原样倒给用户？
3. 为什么分页要按 seq 而不是时间戳？
4. 为什么 snapshot 在 Agent 系统里不只是备份，而是历史操作层？
5. 为什么 move session / revert / snapshot 应该放在一起理解？

---

## 十四、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释为什么 OpenCode 需要一个受约束的 Session Facade。
2. 说清 compaction / baseline 为什么会影响 history 视图。
3. 理解为什么消息分页必须服从 durable seq。
4. 理解 snapshot / revert / move session 共同构成什么能力层。
5. 用自己的话说明：OpenCode 如何把内部 durable execution 真相，变成用户真正可操作的会话外壳。

如果还做不到这些，就说明这章还没真正学懂。
