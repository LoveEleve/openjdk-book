# OpenCode 横向对比锚点

> 用途：从 OpenCode 第一卷中抽出后续对比 `Reasonix / Pi / Hermes / dsh` 时可直接复用的比较维度、核心标签与迁移价值。

---

## 一、OpenCode 的整体画像

一句话定义：

> **OpenCode 是一个把 Agent 会话做成 durable session runtime，并进一步平台化为协议节点的系统。**

它的特点不是“某一个点做得特别炫”，而是：
- 真相源
- 执行骨架
- 工具协议
- 上下文工程
- 权限控制
- 会话外壳
- 协议外化
- 扩展系统
- 可观测与录制

这几层拼得非常完整。

所以后面横向对比时，OpenCode 更适合扮演：
> **“现代 Agent runtime 全景样本”**

---

## 二、最核心的 10 个对比锚点

## O-A1 真相源形态

### OpenCode 的做法
- EventV2 + SessionInput
- 输入先入 durable inbox
- 事件是版本化契约
- durable / live-only 明确分层
- projector 与 commit 同事务

### 对比问题
- 其他项目有没有明确 durable truth？
- 输入是消息还是 inbox？
- 事件是日志，还是契约？
- replay 是真 replay，还是状态恢复近似？

### OpenCode 的标签
- **durable truth first**

---

## O-A2 执行骨架

### OpenCode 的做法
- 双层循环
  - 外层：会话级工作
  - 内层：turn 级 continuation
- runTurn 7 步明确分阶段
- compaction 作为控制流转移
- 崩溃前先失败化 running/pending 工具

### 对比问题
- 其他项目是单循环还是双循环？
- continuation 如何建模？
- 中断 / 压缩 / 恢复是否进入执行协议？

### OpenCode 的标签
- **会话级工作与 turn 级 continuation 分离**

---

## O-A3 工具协议

### OpenCode 的做法
- tool = opaque runtime handle
- settlement pipeline：decode → execute → encode → project → bound
- stale rejection
- output store
- application tools / location tools 分层

### 对比问题
- 其他项目里的 tool call 是“协议能力”还是“函数调用包装”？
- 有没有 stale rejection / bounded output / output store？
- 工具作用域和生命周期怎么定义？

### OpenCode 的标签
- **工具不是函数，而是协议能力**

---

## O-A4 上下文工程

### OpenCode 的做法
- SystemContext = source algebra
- initialize / reconcile / replace
- Unavailable = stale-while-revalidate
- Context Epoch
- compaction 与执行骨架协同

### 对比问题
- 其他项目对 context 的理解是字符串、消息列表，还是状态机？
- 有没有 baseline / snapshot / replace 语义？
- compaction 是“删点历史”还是“执行语义的一部分”？

### OpenCode 的标签
- **context as state machine**

---

## O-A5 权限与副作用控制

### OpenCode 的做法
- action / resource / effect
- ask / assert 双 API
- pending permission = 会话状态
- saved approvals
- deny 优先

### 对比问题
- 其他项目的权限系统是静态配置、临时弹窗，还是运行时控制面？
- approval 是否 durable？
- deny 是否真正不可被历史批准覆盖？

### OpenCode 的标签
- **permission as control plane**

---

## O-A6 会话可见外壳

### OpenCode 的做法
- projector = 消息状态机
- assistant 作为 step 容器
- tool state 进入可见消息模型
- history 是过滤后的视图定义
- facade 定义对外操作面

### 对比问题
- 其他项目的会话视图是 durable truth 投影出来的，还是临时消息堆出来的？
- history / message / state 是否一致？

### OpenCode 的标签
- **projected session view**

---

## O-A7 协议外化能力

### OpenCode 的做法
- MCP 三传输
- 19 方法能力面
- OAuth / DCR / callback
- URL 绑定凭证
- pending auth commit

### 对比问题
- 其他项目是否有强协议外化能力？
- 是本地 Agent，还是在走平台节点化路线？
- 认证是不是一等公民？

### OpenCode 的标签
- **protocolized control plane**

---

## O-A8 扩展能力系统

### OpenCode 的做法
- skill discovery 六重校验
- skill guidance 只暴露索引
- skill 正文按需加载
- plugin lifecycle：plan → resolve → load
- move session 与扩展系统绑定在 location/project/runtime 语义里

### 对比问题
- 其他项目的扩展系统是外挂，还是 runtime 能力输入？
- skill / plugin 是否有安全更新和作用域边界？

### OpenCode 的标签
- **capability system with lifecycle**

---

## O-A9 会话恢复 / 回滚 / 搬家

### OpenCode 的做法
- snapshot 使用 git tree
- revert 是三操作协议
- move session 是事件驱动的状态迁移
- changed files 进入 step 结果

### 对比问题
- 其他项目能不能真正做到“恢复 / 回滚 / 空间迁移”？
- 还是只是重启后重新问模型？

### OpenCode 的标签
- **operable session history**

---

## O-A10 可观测与录制

### OpenCode 的做法
- runID 贯穿 logs / traces / instance id
- OTLP logs + traces
- recorder + redaction + unsafe cassette reject
- websocket 也纳入录制

### 对比问题
- 其他项目的 observability 是日志级，还是运行资产级？
- recorder 是否考虑 secret safety？
- tracing 是否真正连通？

### OpenCode 的标签
- **observability as product infrastructure**

---

## 三、OpenCode 最强的地方

### 1. 完整性
OpenCode 最强的不是单点，而是：
> **几乎把一个产品级 Agent runtime 该有的控制面都拼齐了。**

### 2. 上下文工程成熟度
SystemContext / Context Epoch / Compaction 这条线非常强。

### 3. 工具协议成熟度
Tool settlement、stale rejection、output store 都很工程化。

### 4. 会话 durability
EventV2 + SessionInput + projector + facade 这条 durable session 主线很完整。

### 5. 平台化方向清晰
MCP / protocol / sdk / plugin 显示它不是只想做本地工具。

---

## 四、OpenCode 的代价与局限

### 1. 复杂度很高
它不是一个“容易一眼读懂”的项目。很多模块都不是独立理解，而是彼此强耦合在控制面上。

### 2. 学习门槛高
如果读者没有 Agent / context / tool protocol 背景，很容易被淹没。

### 3. 不是所有设计都适合照搬
例如：
- EventV2 的完整 durable machinery
- plugin / protocol / MCP 的平台化外化
- output store / recorder / pending auth commit

这些对更小、更轻的 Agent 系统可能太重。

---

## 五、哪些思想最值得迁移到自己的系统？

优先级最高的迁移思想：

1. 输入先 durable 化，再进入执行
2. 事件是版本化契约，而不是自由 JSON
3. 会话执行拆成会话级工作和 turn 级 continuation
4. 工具走 settlement pipeline，而不是函数直调
5. context 是状态机，而不是 prompt 字符串
6. permission 是控制面，而不是弹窗逻辑
7. 历史是视图定义，而不是全量消息导出
8. 录制资产写盘前先过 secret gate

---

## 六、哪些东西不要盲抄？

1. 不要盲抄整套 MCP / protocol / sdk 生态
   - 如果产品还没到平台化阶段，会过重。
2. 不要盲抄所有 auth / callback / DCR 逻辑
   - 没有外部协议接入需求时，成本太高。
3. 不要盲抄过细的 plugin lifecycle
   - 小系统先把能力边界讲清楚再谈复杂生命周期。
4. 不要盲抄所有可观测层
   - runID / structured logs 很值钱，但 recorder / websocket 录制不一定是第一优先级。

---

## 七、OpenCode 对后续 4 个项目的比较问题

后面看 `Reasonix / Pi / Hermes / dsh` 时，每次都应该带着这 10 个问题去比：

1. 真相源是不是 durable inbox + event model？
2. 执行骨架是怎么组织的？
3. tool protocol 有多强？
4. context engineering 有多深？
5. permission / sandbox 是控制面还是附属功能？
6. 会话视图是不是投影出来的？
7. 它有没有协议外化能力？
8. 扩展系统是外挂还是 runtime 能力输入？
9. 恢复 / 回滚 / snapshot 能力有多强？
10. observability 是日志级还是系统资产级？

---

## 八、一句话结论

如果只用一句话概括 OpenCode：

> **它代表了“现代 Agent runtime 的完整工程化版本”——不是最轻的、也不一定最简单，但它把 durable session、tool protocol、context engineering、permission、protocol externalization 和 observability 这些关键控制面都做成了系统。**
