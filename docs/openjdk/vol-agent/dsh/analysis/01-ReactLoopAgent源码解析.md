# dsh ReactLoopAgent 源码解析：Phase 状态机与 turn/step 双层循环到底怎么跑

> 解析对象：`packages/core/agent-loop/src/agent.ts`（496 行）
> 定位：这是 dsh 第一卷第一份“真正源码解析”样板，验证逐行、逐状态、逐调用链的解析能力。
> 关联机制分析：`dsh/02-AgentLoop：dsh 如何用 Cordis 插件框架组织 Agent 执行.md`

---

## 一、解析对象

- 文件名：`packages/core/agent-loop/src/agent.ts`
- 核心类：`ReactLoopAgent implements Agent`
- 核心状态：`Phase`（idle / maintenance / running）
- 入口：`send()` / `followup()` / `steer()` / `inject()` / `cancel()` / `runMaintenance()`
- 出口事件：`turn/end`、`step/end`、`agent/status`、`agent/error`

---

## 二、Phase 状态机的定义（关键行 38-46）

```ts
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }
```

### 三个状态各自的职责

| 状态 | 何时进入 | 携带的数据 | 何时离开 |
|------|----------|-----------|----------|
| `idle` | 初始化 / driver 收敛 | `lastTurn` | `send` + `wakeup` 开 driver |
| `maintenance` | `runMaintenance()` | abort / lastTurn / wakeRequested | job 完成 |
| `running` | `wakeDriver()` | abort / turn / step / wakeRequested | `turn()` 返回 false，`kick()` finally |

关键点：
- `status` getter（line 99-101）把 `idle` 和 `maintenance` 都归为 `'idle'`，只有 `running` 才是 `'running'`。
- `setPhase`（line 104-111）只在 status 真实变化时 emit `agent/status` 事件。

---

## 三、wakeDriver 调用链（line 113-120 → 172-193）

触发入口：`send(message, target, wakeup)`

```
send(message, target, wakeup)
  → wakeAfterAbort 分类（line 116）——captured before splice，防 reentrant cancel 重分类
  → this.inbox.splice(resolvedTarget, Infinity, 0, [message])（line 118）
  → if (wakeup) this.wakeDriver(wakingAfterAbort)（line 119）
```

`wakeDriver`（line 172-193）：

```
if phase.kind !== 'idle'
  → reason = phase.abort.signal.reason
  → if reason?.kind !== 'disposed' && (maintenance || wakeAfterAbort)
       → phase.wakeRequested = true   // latch for replay at convergence
  → return                          // 无论 latch 与否都不开 driver
if idle
  → this.activityDone = driver.promise
  → setPhase({ kind: 'running', ... })
  → loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
```

关键行：
- **line 116**：`wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted` —— 这是“wake 不能加入已 abort 的活动”的核心判断。
- **line 178**：`if (reason?.kind !== 'disposed' && (maintenance || wakeAfterAbort))` —— disposed 时绝不 latch，teardown 不等待模型 turn。

---

## 四、kick → turn 主循环（line 210-330）

`kick()`（line 210-223）：

```
while (await this.turn()) {}
finally:
  if (phase.kind === 'running') {
    setPhase({ kind: 'idle', lastTurn: turn })
    if (wakeRequested && inbox.hasPending) this.wakeDriver()
  }
```

`turn()`（line 246-330）核心状态流：

```
if phase.kind !== 'running' → throwError
signal.throwIfAborted()
turn = phase.turn + 1
session.append('turn/start', { turn })
phase.turn = turn

while (true):
  signal.throwIfAborted()
  step = phase.step + 1
  decision = await this.preStep(target, { turn, step })   // line 266

  if decision.kind === 'reject' → turnEnds = { kind: 'blocked' }; return false
  if turnEnds && decision.messages.length === 0 → break
  if phase.step === 0 && decision.messages.length === 0
    → turnEnds = { kind: 'completed' }; return false      // 0-step turn 也记录

  session.append('step/start', { turn, step })
  for message of decision.messages → session.append('user/message', message, { surfaceOp: 'append' })
  stepEnd = await this.step(decision.assembly)             // line 287
  if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd   // max-tokens sticky
  session.append('step/end', { turn, step })

  if turnEnds && inbox.nextStep.length === 0 → dispatch.serial('agent/turn-stopping', { turn, signal })
  if turnEnds && inbox.nextStep.length === 0 → break
  target = 'next-step'

finally:
  session.append('turn/end', { turn, reason: turnEnds! })
```

关键行：
- **line 287-290**：max-tokens 是粘性的——一旦任一步命中上限，后面的正常完成步不得把 turn 结局降级。
- **line 296**：`agent/turn-stopping` 是 serial 分派（不是 waterfall）。
- **line 324-329**：如果 inbox 还有 pending，则换新 AbortController、清 wakeRequested、重置 step=0，返回 true 继续下一 turn。

---

## 五、step 执行（line 332-401）

```
step(assembly):
  if phase.kind !== 'running' → throwError
  system = renderPrompt(assembly)

  while (true):
    { request, preparedCall } = await this.buildRequest(turn, step, tools, system, deriveMessages(), signal)
    assembler = new BlockAssembler()
    stream = preparedCall?.stream(request) ?? llm.stream(request)
    for chunk of stream:
      signal.throwIfAborted()
      chunkSeqs.push(session.append('assistant/chunk', { turn, step, chunk }).seq)
      assembler.push(chunk)

    finish = assembler.finish
    if finish.kind === 'error' || 'aborted':
      action = waterfall('agent/request-error', ...)
      if action?.kind !== 'retry' → throw LlmError
      continue                                          // 重试

    message = createAssistantMessage(...)
    session.append('assistant/message', {...}, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })

    if finish.kind === 'max-tokens' → return { kind: 'max-tokens' }
    toolCalls = message.content.filter(block => block.type === 'tool-call')
    if toolCalls.length === 0 → return { kind: 'completed' }
    { concluded } = await executeToolCalls(this.loopCtx, turn, step, toolCalls, ...)
    return concluded ? { kind: 'completed' } : null
```

关键行：
- **line 391**：max-tokens 语义精确——截断 step 不调度工具。
- **line 393-394**：无工具调用 → completed。
- **line 395-399**：`executeToolCalls` 返回 `concluded`，决定 step end reason。

---

## 六、buildRequest（line 407-495）

```
persistedHeader = session.requestHeader()
route = { provider: options.provider, model: options.model }
reasoningEffort = 仅当 persistedConfig 的 provider/model 与 route 一致且非 adapterDefaults 时才还原

seedConfig = deepFreeze(structuredClone(
  requestHeaderLogged
    ? requestProposal(persistedHeader)      // 移除 adapter-derived 值
    : { ...route, ...reasoningEffort, ...maxTokens }
))

proposedConfig = waterfall('agent/request', { turn, step, signal }, () => seedConfig)
if !proposedConfig.provider || !proposedConfig.model → throwError

preparedCall = await llm.prepareCall(proposedConfig, signal)
config = preparedCall?.config ?? proposedConfig    // NO_ADAPTER 时走 middleware 值

header = canonicalHeader({ config, ...adapterDefaults, ...system, ...tools })
if !requestHeaderLogged → append('request/header', reason:'initial'|'resume')
else if baseline undefined || !headerEquals(baseline, header) → append('request/header', reason:'change')

request = markAgentLoopRequest(deepFreeze({ ...header.config, messages: boundaryMessages, ... }))
return { request, ...preparedCall }
```

关键行：
- **line 54-61**：`requestProposal()` 移除 adapter-derived 值（reasoningEffort / maxTokens），让插件重新提议。
- **line 443-444**：provider/model 缺失 → 抛错。
- **line 464-470**：request header reason 区分 initial / resume / change。

---

## 七、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| `idle` | 构造 / driver 收敛（`kick` finally） | `send`+`wakeup` 调 `wakeDriver` | line 93 / 219 |
| `maintenance` | `runMaintenance()` 被调用 | job 完成，回 `idle` | line 145-151 |
| `running` | `wakeDriver` 在 idle 时开 driver | `kick` finally 收敛回 `idle{lastTurn: turn}` | line 185-191 / 219 |
| turn 内 step | `preStep` 通过，`session.append('step/start')` | `step/end` 写入 | line 279-292 |
| turn 结束 | `turnEnds` 非空且 nextStep 空 | `turn/end` 写入，返回 false | line 296-319 |

关键点：
- `idle` / `maintenance` 在 status 层面都是 `'idle'`（line 99-101）。
- 每个 `running` 收敛后若 inbox 有 pending 会重新 `wakeDriver`（line 220），形成 turn 循环。

---

## 八、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| pre-step reject | `decision.kind === 'reject'` | 267 | `turnEnds = { kind: 'blocked' }`，关 turn |
| 0-step 完成 | `phase.step === 0 && decision.messages.length === 0` | 274-277 | `turnEnds = completed`，关 turn 且记录 |
| max-tokens 粘性 | `turnEnds !== null && turnEnds.kind === 'max-tokens'` | 290 | 后面正常步不降级 |
| turn-stopping | `turnEnds && inbox.nextStep.length === 0` | 296-299 | serial 分发后 break |
| 重试 | `agent/request-error` 返回 `{ kind: 'retry' }` | 367-370 | `continue` 重新 buildRequest |
| 截断 | `finish.kind === 'max-tokens'` | 391 | return max-tokens，**不调度工具** |
| 完成 | `toolCalls.length === 0` | 393-394 | return completed |
| 有下一 turn | `inbox.hasPending` | 324-329 | 换新 controller、重置 step、return true |

---

## 九、数据流

```
输入（send/steer/followup/inject）
  → Inbox（next-turn / next-step 双队列）
  → preStep.claim(target, turn) 取消息
  → 组装 messages（claim + runtime context）
  → buildRequest → llm.stream
  → assistant/chunk* → BlockAssembler → assistant/message
  → 提取 tool-call → executeToolCalls
  → tool/result* 回注 inbox/session
  → turn/end（reason 决定下一步）
```

- 输入来源：`send()` / `steer()` / `followup()` / `inject()`
- 传递路径：inbox → preStep → session(claim) → model(request) → assistant → tools
- 输出去向：`turn/end` 事件 + `inbox.claim` 的后续消息

---

## 十、测试契约

| 测试文件 | 覆盖内容 |
|----------|----------|
| `packages/core/agent-loop/tests/agent.spec.ts` | Phase / turn / step 状态流 |
| `packages/core/agent-loop/tests/cancel.spec.ts` | cancel 语义、abort 后 wake |
| `packages/core/agent-loop/tests/loop.spec.ts` | 运行时上下文、steering、inject、max-tokens、pre-step 时序 |

---

## 十一、总结

### 核心结论
1. `ReactLoopAgent` 不是单体 while 循环，而是 `Phase` 状态机驱动、被 `kick()` 收敛、逐 turn/step 推进的事件驱动执行器。
2. 两个隐蔽但关键的语义：
   - **wakeAfterAbort 分类在线程插入前捕获**（line 116），防 reentrant cancel 重分类。
   - **max-tokens 粘性**（line 287-290），防后续正常步降级 turn 结局。
3. `agent/turn-stopping` 用 serial 分派，`agent/pre-step` / `agent/request` 用 waterfall，`agent/inbox/*` 用 emit。

### 易错点
- 把 `maintenance` 当成 `running`（其实 status 返回 idle）。
- 以为 0-step turn 不记录（其实会写 turn/end，reason 是 completed/blocked）。
- 忽略 `wakeRequested` latch 逻辑（disposed 场景不 latch）。