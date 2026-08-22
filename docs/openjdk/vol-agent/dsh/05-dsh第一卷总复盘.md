# dsh 第一卷总复盘

> 覆盖范围：
> 1. AgentLoop / ReactLoopAgent
> 2. Session 日志 / Surface 投影
> 3. Cordis 插件框架
> 4. 已完成的源码解析样本（ReactLoopAgent / Surface / Inbox / Dispatch）

---

## 一、这一卷到底在讲什么？

如果只看单篇标题，你会觉得 dsh 这一卷在讲：
- AgentLoop
- Session 日志
- Cordis
- 插件
- 事件
- 投影

但把这些内容真正收回来，dsh 第一卷其实只在讲一件事：

> **dsh 如何把 Agent 做成一个“框架即产品”的系统：没有特权核心，所有行为都由 Cordis 插件、Session 事件源和能力缝共同定义。**

也就是：dsh 不是“又一个会调模型的 Agent”，而是：

```text
Cordis 插件运行时
  ↓
ReactLoopAgent / AgentLoop
  ↓
Session 事件源
  ↓
Surface 模型可见投影
  ↓
能力缝 / provider / consumer
  ↓
持久化 / 投影 / 共享执行世界
```

它和另外四个项目最大的差异，不在功能列表，而在架构立场：
> dsh 选择了“一切皆插件”。

---

## 二、dsh 最值得记住的 5 个系统判断

## 1. 没有特权核心，扩展就是在旁边挂插件

dsh 的最强烈架构判断是：
- AgentLoop 是插件
- Session 是插件
- 工具是插件
- provider 是插件
- 持久化也是插件

这意味着它不是“有一个大核心，再给核心挂扩展”，而是：
> **框架本身就是插件运行时。**

---

## 2. 模型可见即已记录，不是事后审计

dsh 的 Session 主线最值钱的地方是：
- 新模型可见输入，必须等于新 session 事件
- 新 session 事件，也必须能被 Surface 投影回模型视图

所以日志不是附属品，而是：
> **模型上下文的真相层。**

---

## 3. AgentLoop 不是单体循环，而是一组事件瀑布

dsh 的 ReactLoopAgent 当然也有 turn/step 双层，但它比其他项目更进一步：
- 请求是 waterfall
- 工具是 waterfall
- 状态变化通过事件分派
- next-turn / next-step 也以事件边界驱动

这意味着它的 loop 不是 while 的花样，而是：
> **事件驱动的 Agent 运行时。**

---

## 4. Cordis 的价值不是 DI，而是可逆插件运行时

如果把 Cordis 当 ioc 容器，就会把 dsh 看浅。

Cordis 真正提供的是：
- 类型化事件
- inject 依赖声明
- emit / waterfall / serial / parallel 分派
- 可逆效果和 fiber 生命周期

所以它解决的不是“怎么拿依赖”，而是：
> **怎么让插件被安全安装、短路、热切换和回滚。**

---

## 5. 能力缝比具体 provider 更重要

dsh 最值得学的不是某个 shell provider 或 storage provider，
而是它的三角色：
- Service Definition
- Provider
- Consumer

这让 dsh 可以：
- 换 provider
- 换执行世界
- 换产品行为

所以能力缝不是接口抽象，而是：
> **换 provider 就能换产品形态的架构手柄。**

---

## 三、dsh 最值得迁移的思想

### 1. 一切皆插件
不要先建一个特权核心，再想办法打补丁扩展。

### 2. 事件源直接定义模型视图
让“模型可见历史”和“持久化历史”共享同一真相层。

### 3. 事件分派模式就是语义契约
emit / waterfall / serial / parallel 不只是实现细节。

### 4. 注册 = 可逆效果
扩展系统要从一开始就考虑 unload / reload / teardown。

### 5. 能力缝三角色
把服务定义、提供者和消费者分开，才能让能力真正可替换。

### 6. 共享执行世界
fs / subprocess / shell / sandbox 最好共享同一世界边界，而不是各自维护一套状态。

---

## 四、dsh 和其他项目的关系

| 维度 | OpenCode | Reasonix | Pi | Hermes | dsh |
|------|----------|----------|----|--------|-----|
| 核心差异 | 事件溯源 runtime | 受控任务系统 | 共享运行时内核 | 多平台长期代理 | 插件运行时框架 |
| 执行骨架 | SessionRunner | Controller / RunLoop | AgentSession | AIAgent / GatewayRunner | ReactLoopAgent |
| 控制语义 | durable 事件 + queue | control plane + evaluator | 显式会话状态机 | ledger + verify + judge | Cordis 事件瀑布 |
| 真相层 | EventV2 | checkpoint / evidence | session tree / facts | ledgers / evidence | session event log |
| 扩展方式 | plugin / skills | contracts / jobs | harness/core 分层 | adapters / ledgers | everything is plugin |

---

## 五、一句话结论

dsh 第一卷最本质的收获，不是“插件很多”，而是：

> **它展示了一个 Agent 系统如何通过插件运行时、事件源真相层和能力缝，把产品行为从特权核心里释放出来，变成一个真正可替换、可组合、可投影的框架。**
