# Permission 与 WorkspaceLease：Reasonix 如何保护任务系统的副作用边界

> 项目：Reasonix（main-v2 基线）
> 角色：主线机制正文 06
> 对应范围规划：`01-Reasonix源码学习范围规划.md`
> 依据材料：
> - `Agent/analysis/reasonix/00-域发现/00-reasonix-域发现.md`
> - `Agent/analysis/reasonix/01-闭环笔记/pass2-rq8-controller.md`

---

## 零、阅读前提示

- 建议先读：
  1. `02-Controller：Reasonix 为什么要把 Agent 做成单控制器系统.md`
  2. `04-RunLoop与DurableExecution：Reasonix 如何把 Agent 变成长跑任务系统.md`
  3. `05-ContextManager与Checkpoint：Reasonix 如何在缓存与恢复之间保持长跑稳定.md`
- 推荐源码阅读路径：
  1. `internal/permission/`
  2. `internal/workspacelease/`
  3. `internal/control/controller.go`（权限与租约如何进入控制面）
  4. 相关契约测试 / 行为说明

## 一、这一章真正的问题

一个会长期运行、会改文件、会切换任务、会继续执行的 Agent 系统，真正危险的地方，不在“它能不能调用工具”，而在：

> **它什么时候不该做、在哪个工作区里不该做、谁有权继续做。**

所以这一章真正要回答的是：

1. Permission 在 Reasonix 里到底是静态规则，还是执行控制面的一部分？
2. 为什么 WorkspaceLease 不是普通文件锁？
3. 为什么读者不租约、写者租约持续到任务完成这件事这么重要？
4. 为什么权限控制和工作区一致性要一起理解，而不是分开看？

---

## 二、先给结论：Reasonix 不把“副作用能不能发生”交给工具自己决定

最容易犯的错，是把权限看成：
- 工具执行前做一个判断
- 允许就过
- 不允许就报错

这太浅了。

Reasonix 这里真正关心的是：

> **副作用行为必须被放进任务系统的控制面里，而不是留给每个工具自己零散处理。**

这意味着：
- permission 不是 leaf concern
- workspace lease 不是文件锁工具
- 两者都是 durable task system 的边界机制

这和前面章节里看到的风格完全一致：
- ContextManager 不是字符串拼接
- Goaleval 不是收尾检查器
- WorkspaceLease 也不是“顺手加个锁”

---

## 三、为什么 Permission 在 Reasonix 里不是外围模块

Reasonix 的权限系统之所以重要，不是因为“安全”这个词听起来高级，
而是因为在一个长期运行的 Agent 里，权限本身会改变执行控制流：

- 能不能继续往下做
- 要不要 ask
- 是否必须 blocked
- 哪些任务需要停下来等用户
- 哪些计划变成未经授权状态变更

所以如果你把 Permission 看成普通的 allow/deny 规则，
就会错过它真正的系统位置：

> **Permission 在 Reasonix 里是任务推进条件的一部分。**

它和：
- Controller 的命令面
- Coordinator 的 fail-closed planning
- RunLoop 的继续/停止
其实是同一类语义。

---

## 四、WorkspaceLease 为什么不是普通文件锁

这一点是 Reasonix 特别值得学的地方。

如果只从名字看，很容易觉得：
- 不就是给工作区加把锁吗？

但它真正表达的设计判断是：

> **工作区一致性不是一次文件操作的问题，而是整个任务生命周期的问题。**

Reasonix 的关键选择是：
- **读者不租约**
- **写者从第一次变更开始持有租约，直到任务完成**

这说明它关心的不是：
- 某一瞬间有没有并发写

而是：
- 这个任务从开始到验证完成期间，工作区是不是持续处于一致语义里

这和普通文件锁有本质不同。

### 普通文件锁关注的是：
- 当前这一秒谁在写

### WorkspaceLease 关注的是：
- **整个任务期间，谁拥有工作区语义的修改权**

这是更高一级的建模。

---

## 五、为什么“读者不租约、写者租约持续到任务完成”这么值钱

这条规则非常成熟，因为它说明 Reasonix 已经清楚地区分了两类行为：

### 1. Reader
- 读取、检查、review
- 不应该阻塞系统
- 也不应该获得工作区所有权

### 2. Writer
- 一旦开始变更工作区
- 其影响会扩散到：
  - review
  - verification
  - completion
  - recovery

所以它必须持续持有租约，直到任务完成。

这条设计背后的真正问题是：

> **验收 / review / verification 看到的工作区，是不是和执行期间同一个世界。**

如果写者租约只在“写的那一瞬间”持有，后面 release：
- 另一个任务可以进来修改
- review 时看到的工作区已经不是原任务那套状态
- 验证就失真了

所以这条设计真正保护的是：
> **任务期间的工作区语义一致性。**

---

## 六、为什么要把 Permission 和 WorkspaceLease 放在同一主线理解

表面上，一个是：
- 是否允许做某件事

另一个是：
- 工作区由谁占有

但它们共同在回答同一个更大的问题：

> **Agent 的副作用边界怎么被系统化管理。**

### Permission 解决：
- 允许不允许
- 需不需要审批
- 哪种任务必须停

### WorkspaceLease 解决：
- 即使允许做，工作区什么时候归谁管
- 一个任务结束前，别人能不能插进来改变语义环境

所以这两者放在一起，才能构成：
> **副作用控制 + 工作区一致性**

如果只做 Permission，不做 Lease：
- 你知道允许谁做
- 但不知道做完之后环境有没有被别人改乱

如果只做 Lease，不做 Permission：
- 你知道谁占着工作区
- 但不知道这件事本身该不该发生

Reasonix 两边都做了，这就是成熟之处。

---

## 七、这章真正解决了哪些工程问题？

### 1. 如何让副作用不是“工具能跑就跑”
Reasonix 的解法：permission 进入控制面和任务语义

### 2. 如何保证工作区在任务期间保持一致
Reasonix 的解法：写者租约持续到任务完成

### 3. 如何让 review / verify 不被并发写污染
Reasonix 的解法：读者不租约，写者独占语义路径

### 4. 如何把“权限”和“环境占有权”同时纳入执行系统
Reasonix 的解法：Permission + WorkspaceLease 双边界模型

这说明这章的价值不是“看一套权限代码”，而是：

> **理解一个长跑 Agent 任务系统，如何把副作用边界真正工程化。**

---

## 八、读者最容易学错的地方

### 错觉 1：Permission 就是 allow/deny 工具判断
错。它会改变执行控制流和任务状态。

### 错觉 2：WorkspaceLease 就是文件锁
错。它在保护整个任务生命周期中的工作区一致性。

### 错觉 3：只要当前写操作受控，后面 verify 就自然可靠
错。没有持续租约，verify 看到的工作区可能已经变了。

### 错觉 4：读者也该租约，否则会乱
错。Reasonix 特意区分 reader / writer，是为了让观察层尽量不阻塞系统。

---

## 九、关键源码位置

| 文件 | 行数 | 核心职责 |
|------|------|----------|
| `internal/permission/` | — | 权限系统：per-call Policy（allow/ask/deny）|
| `internal/workspacelease/lease.go` | — | 工作区租约：reader/writer 分离、任务级持续租约 |
| `internal/control/controller.go` | 6,276 行 | Controller 中的权限集成和租约管理 |

**阅读顺序建议**：
1. 先读 `permission/` 目录，理解权限规则模型
2. 再读 `workspacelease/lease.go`，理解 reader/writer 分离
3. 再读 `controller.go` 中权限和租约相关的集成点

## 十、工程问题学习点

| 工程问题 | Reasonix 的解法 | 代价 | 可迁移到 |
|----------|----------------|------|----------|
| 如何让副作用不是"工具能跑就跑" | permission 进入控制面和任务语义 | 权限判断增加执行路径复杂度 | 有副作用的 Agent |
| 如何保证工作区在任务期间保持一致 | 写者租约持续到任务完成 | 写者持有租约期间其他写操作被阻塞 | 会修改工作区的系统 |
| 如何让 review / verify 不被并发写污染 | 读者不租约，写者独占语义路径 | 需要区分 reader/writer | 有验证阶段的系统 |
| 如何把"权限"和"环境占有权"同时纳入执行系统 | Permission + WorkspaceLease 双边界模型 | 系统更复杂 | 需要完整副作用控制的系统 |

## 十一、读者分层路由

### 为什么这里不先展开具体 shell / proc 细节
因为这章重点是副作用边界建模，而不是某个命令怎么执行。

### 为什么这里不先深挖 sandbox 实现细节
因为第一轮先要回答“为什么需要边界”，以及“边界怎样进入控制面”；隔离实现可以放后续专题。

### 为什么测试 / 行为语义比 API 更重要
因为 Permission / WorkspaceLease 的价值不在接口，而在：
- 谁先拿到控制权
- 控制权持续多久
- 谁在什么条件下必须停

---

## 十、读者分层路由

### beginner
先抓住：
1. Permission 决定“能不能继续做”
2. WorkspaceLease 决定“谁在整个任务期间拥有工作区修改权”
3. 这两者加起来才叫副作用边界

### intermediate
重点看：
- 为什么 reader 不租约
- 为什么 writer 持续到任务完成
- 为什么 verify / review 会被工作区变化污染

### advanced
重点看：
- Permission 如何改变执行控制流
- Lease 如何保护 durable verification 语义
- 为什么这套设计更像任务系统，而不是普通工具框架

---

## 十一、迁移清单

### 可迁移思想 1：权限进入控制面
- 可迁移到：任何会自主继续、会写文件、会跑命令的 Agent 系统
- 前提：权限失败必须改变执行语义，而不只是报错
- 不适合直接照搬到：纯只读分析器

### 可迁移思想 2：工作区租约按任务生命周期持有
- 可迁移到：任何需要 review / verify / completion 一致性的长跑系统
- 前提：写入和验证在同一工作区语义上发生
- 不适合直接照搬到：完全无持久工作区的系统

### 可迁移思想 3：reader / writer 分离
- 可迁移到：读多写少、且验证敏感的系统
- 前提：观察不应成为阻塞主路径的主要来源
- 不适合直接照搬到：强串行、无并发的极简系统

---

## 十二、自测问题

1. 为什么 Reasonix 的副作用边界不能只靠 permission？
2. 为什么 WorkspaceLease 不是普通文件锁？
3. 为什么 writer 的租约必须持续到任务完成，而不是写完一个文件就释放？
4. 为什么 verify / review 的可靠性取决于工作区一致性？
5. 为什么这章其实在讲“任务系统边界”，而不是“安全模块”？

---

## 十三、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释为什么 Reasonix 要同时做 Permission 和 WorkspaceLease。
2. 说清 reader / writer 分离背后的工程意义。
3. 理解为什么工作区一致性是 durable execution 的一部分。
4. 理解副作用边界为什么不只是安全问题，也是验证与恢复问题。
5. 用自己的话说明：Reasonix 如何把“允许做什么”和“谁在多长时间内拥有环境控制权”统一进任务系统里。

如果还做不到这些，就说明这章还没真正学懂。
