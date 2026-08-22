# Session 日志：dsh 如何把“模型可见即已记录”做成运行时不变量

> 项目：dsh（dsh-root v0.1.0-rc.5）
> 角色：主线机制正文 02
> 对应范围规划：`01-dsh源码学习范围规划.md`
> 依据材料：`Agent/analysis/deepseek-harness/01-闭环笔记/q1-session-log.md`

---

## 零、阅读前提示

- 建议先读：
  1. `02-AgentLoop：dsh 如何用 Cordis 插件框架组织 Agent 执行.md`
  2. `../03-Agent源码前置认知桥.md`
- 推荐源码阅读路径：
  1. `packages/core/session/src/index.ts`
  2. `packages/core/session/src/types.ts`
  3. `packages/core/session/src/surface.ts`
  4. `packages/core/session/tests/session.spec.ts`

## 一、这一章真正的问题

dsh 有一个和其他 4 个项目非常不同的第一性原理：

> **模型可见 ⟺ 已记录。**

这意味着：
- 新模型可见输入 ⟹ 新 session 事件
- 新 session 事件 ⟹ 模型历史视图随之更新

所以这一章真正要回答的是：

1. 为什么 dsh 要把“模型可见即已记录”做成运行时不变量，而不是事后审计？
2. SessionEventMap 声明合并如何工作？
3. Surface 投影如何把 3 种事件转成 LLM 消息？
4. 为什么追加不变性和 JSON 严格性是“可重建性”的基础？

---

## 二、先给结论：dsh 的 Session 日志不是“事件总线”，而是“事件源 + 插件可消费事件流 + 模型可见视图”的三合一

最容易犯的错，是把 dsh 的 Session 日志看成普通事件总线。

这不对。

dsh 的 Session 日志是：
- 追加写事件源（一切持久状态的唯一真相）
- 插件可消费事件流（通过 session/event 订阅）
- 模型可见视图（Surface 投影）

这三者不是分离的，而是同一个东西。

---

## 三、为什么事件四类（created/disposed/event/flush）是核心设计

dsh 的 Session 日志定义了四类事件，这不是分类癖好，而是设计决策：

### session/created
- 同步 throw veto 并回滚
- 配对的 disposal
- detach 请求推迟

### session/disposed
- 离开 store
- 含发布回滚
- 监听器失败记录并隔离

### session/event
- post-commit fire-and-forget append feed
- 快照在 log push 前解析
- 回调在 push 后

### session/flush
- 并行耐久性检查点
- 每个监听器运行
- 调用方等待全部
- 无 waterfall veto

为什么这四类很关键？
因为持久化是插件关注点——核心只发事件，JSONL/SQLite/标题/遥测全是订阅者。

---

## 四、为什么 SessionEventMap 声明合并很重要

dsh 的 SessionEventMap 不是写死的，而是通过 `declare module` 声明的：

```ts
interface SessionEventMap {
  'turn/start': { turn }
  'turn/end': { turn; reason: TurnEndReason }
  'user/message': UserMessage
  'assistant/message': { turn; step; message: AssistantMessage; usage? }
  'tool/call': { turn; step; callId; name; arguments }
}
```

插件可以扩展它：
```ts
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'my-plugin/event': { ... }
  }
}
```

这意味着事件类型系统是可扩展的，而不是写死的。

---

## 五、为什么 Surface 投影是“模型可见视图”的定义

dsh 的 Surface 不是“把事件渲染成文本”，而是“定义模型可见视图”。

3 种事件会被投影：
- user/message → verbatim 直通
- assistant/message → data.message（空 content 跳过）
- tool/result → data.message

其他事件（turn/step 边界、chunk、usage、error）只是 trace/replay 数据，不参与模型可见视图。

而且 Surface 有两种操作：
- append：追加
- replace：替换阴影

这解决的是：模型可见的 surface 和日志前缀重建的请求完全一致。

---

## 六、为什么追加不变性和 JSON 严格性是 dsh 的基石

dsh 的测试契约提供了一系列关键保证：

### 追加不变性
- deriveMessages() 返回的消息是 deep-frozen 的
- 消费方突变 → TypeError
- 返回数组是调用方快照，但永不达缓存/日志

### JSON 严格性
- BigInt / 函数 / Symbol / Map / undefined / Infinity / 稀疏数组 → 拒绝
- 密集数组含非序列化元素 → 拒绝
- 嵌套非序列化 / 循环引用 → 拒绝
- 全部不入日志

### 深冻结
- seed/append 事件深冻结
- 迭代冻结嵌套恢复
- 缓存数组快照不随 append 增长

这些保证说明：dsh 的 Session 日志不只是“可以持久化”，而是“可以被任何后端安全地持久化”。

---

## 七、这一章真正解决了哪些工程问题？

### 1. 如何让“模型可见即已记录”成为不变量
dsh 的解法：Session 日志 + Surface 投影

### 2. 如何让事件类型系统可扩展
dsh 的解法：SessionEventMap 声明合并

### 3. 如何让模型可见视图和日志视图一致
dsh 的解法：Surface 投影 + append/replace 阴影

### 4. 如何让日志可以被任何后端安全持久化
dsh 的解法：JSON 严格性 + 追加不变性 + 深冻结

---

## 八、读者最容易学错的地方

### 错觉 1：Session 日志是事件总线
错。它是事件源 + 插件可消费事件流 + 模型可见视图的三合一。

### 错觉 2：持久化是核心的一部分
错。dsh 的核心只发事件，持久化是插件。

### 错觉 3：Surface 是渲染层
错。它是模型可见视图的定义。

### 错觉 4：JSON 严格性是偏执
错。它是可重建性的基础。

---

## 九、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释 dsh 为什么把“模型可见即已记录”做成运行时不变量。
2. 说清四类事件各自解决什么问题。
3. 理解 SessionEventMap 声明合并为什么重要。
4. 理解 Surface 投影如何定义模型可见视图。
5. 理解为什么 JSON 严格性和追加不变性是 dsh 的基石。

如果还做不到这些，就说明这章还没真正学懂。
