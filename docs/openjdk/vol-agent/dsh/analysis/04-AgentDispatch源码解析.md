# dsh AgentDispatch 源码解析：融合分派器如何保证 subject 与 scope key 不分歧

> 解析对象：`packages/core/agent/src/dispatch.ts`（176 行）
> 定位：第四份真·源码解析。验证"agent 事件分派 + 类型级 subject 注入"这条路径。

---

## 一、解析对象

- 文件名：`packages/core/agent/src/dispatch.ts`
- 核心函数：`agentEvents`、`agentCarrier`、`emitAgentEvent`、`assembleContextFor`
- 核心类型：`AgentSubjectEvent`、`AgentEventDispatch`
- 核心问题：如何让"agent 事件的 scope key"和"payload 里的 agent"永不分歧

---

## 二、AgentSubjectEvent 类型级过滤（关键行 28-47）

```ts
export type AgentSubjectEvent = {
  [K in keyof Events]: Events[K] extends (this: Scoped<Agent>, ...args: infer P) => unknown
    ? P extends [infer Payload, ...unknown[]]
      ? Payload extends { agent: Agent } ? K : never
      : never
    : never
}[keyof Events]
```

关键点：
- **三个条件必须同时满足**：
  1. handler 的 `this` 是 `Scoped<Agent>`（scope carrier 契约）
  2. handler 的第一个参数是 payload
  3. payload 携带 `agent: Agent`
- 这排除了 "零参数事件" 和 "payload 恰好带 agent 但 this 不是 Scoped" 的事件。
- `AgentSubjectEvent` 是 keyof 过滤结果，只留下真正 subject 是 agent 的事件名。

---

## 三、agentCarrier / agentEvents（关键行 94-149）

```ts
export function agentCarrier(agent: Agent): Scoped<Agent> {
  return scopeTarget(agent, agent)   // scope key = agent，carrier = agent
}
```

### fuse（line 113-118）

```ts
const fused = <K>(payload: PayloadRest<K>): PayloadOf<K> =>
  ({ ...payload, agent } as PayloadOf<K>)   // spread 在前，agent 覆盖最后
```

关键点：
- **line 117**：spread 在前，agent 在后。即使调用方的 payload 结构上恰好带 `agent` 字段，也无法覆盖注入的 subject。
- 这是"subject 与 scope key 不能分歧"的代码级保证。

### emit（line 120-137）

```ts
emit(name, payload):
  args = [carrier, name, fused(payload)]
  callbacks = ctx.events.dispatch('emit', args)
  for callback of callbacks:
    try:
      returned = callback(...args)
      void Promise.resolve(returned).catch(error => logWarn)
    catch(error):
      logWarn
```

关键点：
- **不用 Cordis emit 的 Array.map**（line 121-124 注释）：原生 Cartes 的一个同步 throw 会饿死后续监听器，且返回的 promise 被丢弃。
- 改为自己控制回调集合，同步 throw 和 promise rejection 独立 contain。

### serial / waterfall（line 138-147）

```ts
serial(name, payload) → ctx.serial(carrier, name, fused(payload))
waterfall(name, payload, ...rest) → ctx.waterfall(carrier, name, fused(payload), ...rest)
```

关键点：
- 传给 Cordis 的是 `(thisArg, name, payload, ...rest)` 四/五元组。
- 通过一次 contained、shape-preserving cast 绕过 TS 对泛型 Tail 的处理（line 108-112 注释）。

---

## 四、emitAgentEvent / assembleContextFor（关键行 158-176）

```ts
emitAgentEvent(ctx, agent, name, payload):
  agentEvents(ctx, agent).emit(name, payload)   // 无保留 dispatcher，一次分配

assembleContextFor(agent, signal?):
  return { agent, scope: agent, ...signal }      // 把 agent 和 scope 一起绑定
```

关键点：
- `assembleContextFor` 保证 prompt 组装时 agent 和 scope 一起传入，agene-scoped prompt/tool 贡献不会被静默漏掉。

---

## 四.5、调用链

```
agentEvents(ctx, agent, carrier)                          // line 107
  → fused(payload) = { ...payload, agent }                // line 113-118（subject 注入）
  → 返回 { emit, serial, waterfall } 三方法               // line 119-148

emit(name, payload):
  → fused(payload) → { ...payload, agent }
  → ctx.events.dispatch('emit', [carrier, name, payload])  // line 126
  → for callback of callbacks（独立 contain 失败）          // line 127-136

serial(name, payload):
  → fused(payload) → { ...payload, agent }
  → ctx.serial(carrier, name, payload)                    // line 140-141

waterfall(name, payload, ...rest):
  → fused(payload) → { ...payload, agent }
  → ctx.waterfall(carrier, name, payload, ...rest)        // line 145-146
```

---

## 四.6、状态转换（dispatch 的三种模式）

| 模式 | 调用方式 | 等待？ | 错误隔离 | 关键行 |
|------|----------|--------|----------|--------|
| emit | `dispatch.emit(name, payload)` | 否 | 同步 throw + promise rejection 独立 contain | line 120-137 |
| serial | `dispatch.serial(name, payload)` | 是 | 无（Cordis serial 本身有序） | line 138-142 |
| waterfall | `dispatch.waterfall(name, payload, ...rest)` | 否 | 监听器不调 next = 短路 | line 143-147 |

---

## 四.7、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| callback 同步 throw | `callback(...args)` 抛 | 129-135 | `logWarn`，不影响其他 callback |
| callback 返回 rejected promise | `Promise.resolve(returned).catch` | 130-132 | `logWarn`，不 propagate |
| payload 自带 agent 字段 | 结构上 `{ agent, ... }` 合法 | 117 | spread 在前，仍被 `{ ...payload, agent }` 覆盖 |
| 零参数事件 | `Params<F>` 不是 `[payload, ...]` | 31 | 被 `AgentSubjectEvent` 过滤掉 |
| 非 Scoped this 事件 | `this` 不是 `Scoped<Agent>` | 29 | 被 `AgentSubjectEvent` 过滤掉 |

---

## 四.8、数据流

```
调用方（dispatch.emit / serial / waterfall）
  → fused(payload) = { ...payload, agent }   // subject 注入
  → Cordis 分派（emit / serial / waterfall）
  → 监听器（this = carrier, payload = fused）
  → 返回值 / 无返回值
```

- 输入来源：Agent / agent-loop 调用方
- 传递路径：`fused` → Cordis 分派 → 监听器
- 输出去向：监听器返回值（waterfall）或 void（emit）

---

## 五、测试契约

| 测试 | 覆盖 |
|------|------|
| `packages/core/agent-loop/tests/agent.spec.ts` | agent 事件分派、subject 注入 |

---

## 六、总结

### 核心结论
1. `AgentSubjectEvent` 类型级过滤：this 必须是 `Scoped<Agent>`，payload 必须携带 `agent` 字段。
2. `fused` 用 spread-前-agent-后保证 subject 注入不可被调用方覆盖。
3. emit 不用 Cordis 原生 Array.map（同步 throw 会饿死监听器），改为自己 contain 失败。

### 可迁移点
- "类型级 subject 注入 + 运行时 spread 覆盖"：把 scope key 和 payload 字段绑定，避免两个来源分歧。
- 事件分派的失败 contain：同步 throw 和 promise rejection 独立处理，一个监听器不会饿死后续监听器。

### 易错点
- 以为用 `ctx.emit` 就够（其实原生实现会饿死监听器）。
- 误以为 payload 里带 agent 字段就能当 subject（类型级 `this` 检查会把它排除）。