# dsh Inbox 源码解析：InboxTarget 双队列的增量投影如何工作

> 解析对象：`packages/core/agent/src/inbox.ts`（220 行）
> 定位：第三份真·源码解析。验证“inbox 增量投影 + 六种突变 + 持久化时序”这条路径。

---

## 一、解析对象

- 文件名：`packages/core/agent/src/inbox.ts`
- 核心类：`Inbox`
- 核心概念：`InboxTarget`（next-turn / next-step 双队列）
- 入口：`splice()` / `append()` / `prepend()` / `replace()` / `remove()` / `clear()` / `claim()`
- 出口：`session/event` 事件 + notifications（inserted / discarded / claimed）

---

## 二、状态模型（关键行 12-13）

```ts
type InboxState = Record<InboxTarget, UserMessage[]>
```

两个队列：
- `next-turn`：新 turn 输入
- `next-step`：当前 step 继续输入

---

## 三、构造函数：replay-once 投影（关键行 27-40）

```ts
constructor(session, notifications):
  state = { 'next-turn': [], 'next-step': [] }
  for event of session.events.slice(session.header.seedLength ?? 0):
    if event.type !== 'agent/inbox/spliced' → continue
    try:
      this.apply(event.data)        // 重放已持久化的 splice
    catch:
      throw new Error('invalid persisted inbox splice at seq ...')
```

关键点：
- **line 32**：`seedLength` 之前的 inbox 事件不重放（快照后的增量）。
- **line 33-34**：只重放 `agent/inbox/spliced` 事件，跳过后端无关事件。
- 这是“replay-once 投影”："Once" 的意思是：重放时只 apply 持久化 splice，不再重新触发 notifications。

---

## 四、六种突变操作（关键行）

| 操作 | 入口 | 核心行为 | 行号 |
|------|------|----------|------|
| **append** | line 86-88 | splice(target, length, 0, [message]) | line 87 |
| **prepend** | line 96-98 | splice(target, 0, 0, [message]) | line 97 |
| **replace** | line 109-114 | locate → splice(target, index, 1, [newMessage]) | line 112 |
| **remove** | line 121-126 | locate → splice(target, index, 1, []) | line 124 |
| **clear** | line 58-61 | splice(next-step, 0, all, []) → splice(next-turn, 0, all, []) | line 59-60 |
| **claim** | line 71-78 | mutate(next-step, 0, all, [], false) + if next-turn: mutate(next-turn, 0, 1, [], false) | line 72-74 |

关键点：
- **claim 的语义**（line 71-78）：总是先从 next-step 取全部，然后如果是 next-turn 目标，再从 next-turn 取 1 条。
- **claim 不触发 discard 通知**：`mutate` 第三个参数 `discardRemoved=false`。

---

## 五、splice → mutate 调用链（关键行 139-146 → 158-193）

```
splice(target, start, deleteCount, inserted)
  → mutate(target, start, deleteCount, inserted, discardRemoved=true)

mutate(target, start, deleteCount, inserted, discardRemoved):
  // 1. 坐标归一化（line 166-175）
  truncatedStart = Math.trunc(start)
  actualStart = offset < 0 ? Math.max(inbox.length + offset, 0) : Math.min(offset, inbox.length)
  actualDeleteCount = Math.min(Math.max(truncatedDeleteCount || 0, 0), inbox.length - actualStart)

  // 2. 空操作提前返回（line 176）
  if actualDeleteCount === 0 && inserted.length === 0 → return []

  // 3. 构建 splice 对象（line 177-184）
  outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' : undefined
  splice = { target, start: actualStart, inserted, ...outcome, ...removedCount }

  // 4. 校验（line 185）
  this.validate(splice)

  // 5. **先持久化，后投影**（line 186-191）
  event = this.session.append('agent/inbox/spliced', splice)  // durable commit
  removed = inbox.splice(actualStart, actualDeleteCount, ...event.data.inserted)  // 内存投影
  if discardRemoved: for message of removed → notifications.discarded(message)
  for message of event.data.inserted → notifications.inserted(message)
  return removed
```

关键点：
- **line 186**：`session.append` 先于内存变异——**session/event 观察者看到的是 pre-splice 状态**。
- **line 187**：`event.data.inserted` 来自已持久化的事件，不是原始 `inserted` 参数（持久化可能改写）。
- **line 188-191**：discard 和 insert 通知按顺序发出。

---

## 六、validate 校验（关键行 203-219）

```ts
validate(splice):
  // 1. 坐标边界
  if !safeInteger(start) || start < 0 || start > inbox.length → throw
  if !safeInteger(removedCount) || removedCount < 0 || start + removedCount > inbox.length → throw

  // 2. identity 不重复
  candidate = inbox.toSpliced(start, removedCount, ...inserted)
  ids = new Set<string>()
  for message of (target === 'next-turn' ? [...candidate, ...nextStep] : [...nextTurn, ...candidate]):
    if ids.has(message.id) → throw('message already pending')
    ids.add(message.id)
```

关键点：
- **line 213-216**：next-turn 插入时，也要检查 next-step 队列是否已有同 id。反之亦然。双队列之间 id 不重复。

---

## 七、状态转换（双队列长度变化）

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 空队列 | 构造 / claim 取空 | `append` / `prepend` | line 26-27 |
| 有 pending | `append` / `prepend` 后 | `claim` 取空 | line 86-98 |
| 被 claim | `claim(target, turn)` 调用 | 取走全部 next-step + 1 next-turn | line 71-78 |
| 被 replace | `replace(id, msg)` 命中 | splice 1 条 | line 109-114 |
| 被 clear | `clear()` 调 | 两队列全清 | line 58-61 |

---

## 八、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| 空操作 | `actualDeleteCount === 0 && inserted.length === 0` | 176 | `return []`，不写事件 |
| 坐标负偏移 | `offset < 0` | 168-169 | `Math.max(inbox.length + offset, 0)` |
| 坐标越上界 | `offset > inbox.length` | 170 | `Math.min(offset, inbox.length)` |
| claim 是否 consume next-turn | `target === 'next-turn'` | 73 | 取 1 条 next-turn |
| replace 是否命中 | `locate(id)` 返回 undefined | 111 | `return false` |
| 双队列 id 重复 | `ids.has(message.id)` | 216 | throw |

---

## 九、数据流

```
输入（send / steer / followup / inject / replace / remove）
  → splice 归一化坐标（line 166-175）
  → validate 校验（坐标边界 + id 不重复）
  → session.append('agent/inbox/spliced', ...)   // **先持久化**
  → inbox.splice(actualStart, ...)                  // **后投影**
  → notifications（discarded / inserted / claimed）
  → claim 输出 UserMessage[] → AgentLoop
```

- 输入来源：`send()` / `steer()` / `followup()` / `inject()` / `replace()` / `remove()` / `clear()`
- 传递路径：inbox 双队列 → `mutate`（持久化先于投影）→ session 事件 + notifications
- 输出去向：`claim()` 返回的 `UserMessage[]`（给 AgentLoop 做 preStep 输入）

---

## 十、测试契约

| 测试 | 覆盖 |
|------|------|
| `packages/core/agent/tests/agent.spec.ts` | Inbox 与 AgentLoop 的交互 |
| `packages/core/agent-loop/tests/loop.spec.ts` | steering / inject / inbox 边界 |

---

## 八、总结

### 核心结论
1. Inbox 是“replay-once 投影”：重放时只 apply 持久化 splice，不重复触发 notifications。
2. 持久化先于内存投影：`session.append` 在 `inbox.splice` 之前，所以 `session/event` 观察者看到的是 pre-splice 状态。
3. 双队列 id 不重复：next-turn 和 next-step 之间共享 id 命名空间，插入时互检。

### 可迁移点
- “先持久化、后通知”的时序契约：持久化先于内存变异，观察者看到的永远是持久化 commit 前的状态。
- 坐标归一化（line 166-175）：负数 start 表示从尾偏移，类似 `Array.prototype.splice` 但更严格。

### 易错点
- 把 `claim` 当成普通 splice（其实不触发 discard 通知）。
- 误以为 `append` 和 `prepend` 只是不同 splice 参数（其实它们语义不同：append 追加到尾，prepend 插入到头）。