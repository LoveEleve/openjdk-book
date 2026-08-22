# OpenCode EventV2 源码解析：commitDurableEvent 提交协议到底怎么跑

> 解析对象：`packages/core/src/event.ts`（638 行）
> 定位：OpenCode 第一卷第一份真正源码解析，验证"事件溯源提交协议 + 重放四级校验"这条核心路径。
> 关联机制分析：`opencode/02-EventV2与SessionInput：OpenCode 如何把 Agent 变成可重放的会话系统.md`

---

## 一、解析对象

- 文件名：`packages/core/src/event.ts`
- 核心模块：`EventV2`
- 核心函数：`commitDurableEvent`（line 205-352 附近）、`latestSequence`、`decodeSerializedEvent`、`readAggregate`
- 核心不变量：seq 单调连续、id 全局唯一、projector/commit 同事务、durable/live-only 分层
- 技术栈：Effect 语言（`Effect.fn`、`Effect.uninterruptible`、`Effect.die`）

---

## 二、latestSequence 查询（关键行 21-32）

```ts
export const latestSequence = Effect.fn("EventV2.latestSequence")(function* (db, aggregateID) {
  const row = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, aggregateID))
    .get()
    .pipe(Effect.orDie)
  return row?.seq ?? -1
})
```

关键点：
- `EventSequenceTable` 是每个 aggregate 的 seq 计数行（PK = aggregate_id）。
- 查询失败 `orDie`（这是协议错误，不是可恢复错误）。
- 空行返回 -1（表示还没有事件）。

---

## 三、decodeSerializedEvent（关键行 50-61）

```ts
const decodeSerializedEvent = (event: SerializedEvent): Payload => {
  const definition = Durable.get(event.type)
  if (!definition?.durable) {
    throw new InvalidDurableEventError({ type: event.type, message: `Unknown durable event type ${event.type}` })
  }
  return {
    id: event.id,
    type: definition.type,
    durable: { aggregateID: event.aggregateID, seq: event.seq, version: definition.durable.version },
    data: Schema.decodeUnknownSync(definition.data)(event.data),
  }
}
```

关键点：
- **版本解码在重放边界**：按持久化的 versioned type 找到定义，decode 为当前 schema。
- 未知 durable 类型直接抛（fail-closed，不让坏事件进投影）。

---

## 四、readAggregate 分页读（关键行 63-108）

```ts
const rows = yield* db.select().from(EventTable)
  .where(and(
    eq(EventTable.aggregate_id, input.aggregateID),
    gt(EventTable.seq, after),
    inArray(EventTable.type, Array.from(input.manifest.definitions.keys())),
  ))
  .orderBy(asc(EventTable.seq))
  .limit(input.limit + 1)   // 多取一条判断 hasMore
  .all().pipe(Effect.orDie)
const page = rows.slice(0, input.limit)
```

关键点：
- `limit + 1` 多取一条，用于计算 `hasMore`（分页）。
- 按 seq 升序读，保证重放顺序稳定。
- 只读 manifest 里已知的事件类型（忽略未知/外来类型）。

---

## 五、commitDurableEvent 提交协议（核心，line 205-352）

```
commitDurableEvent(definition, event, input?, commit?):
  1. 提取 aggregateID（line 219-227）：
     aggregateID = event.data[durable.aggregate]
     if typeof !== 'string' → die InvalidDurableEventError
     if input && input.aggregateID !== aggregateID → die Aggregate mismatch

  2. Effect.uninterruptible（line 237）：提交过程不可中断

  3. db.transaction（line 239-...）：
     a. 读 EventSequenceTable 行（line 243-248）
        latest = row?.seq ?? -1

     b. encode event.data（line 250-252）

     c. strictOwner 校验（line 254-261）：
        if input?.strictOwner && row?.ownerID && row.ownerID !== input.ownerID → die Replay owner mismatch

     d. seq <= latest 的幂等分支（line 262-290）：
        stored = EventTable 中该 (aggregate, seq) 行
        if stored.id === event.id AND type 匹配 AND data deepStrictEqual:
          → 幂等，认领无主聚合后 return（line 269-283）
        else:
          → die Replay diverged at seq（line 284-289）

     e. 非 strictOwner 的 owner 分支（line 291-293）：
        if input && row?.ownerID && row.ownerID !== input.ownerID → return（静默跳过）

     f. seq 计算（line 294-295）：
        seq = input?.seq ?? latest + 1
        if input && seq !== latest + 1 → die Sequence mismatch

     g. ...（投影器 + commit 回调 + upsert + insert 在事务内，line 300-352）
```

关键点（幂等分支是精髓）：
- **line 269-273 幂等判断**：同时满足 id 相同、type 相同（版本化）、data 深度相等 → 视为幂等重放。
- **line 274-281 认领无主聚合**：幂等重放时如果无 owner，可认领（非 strictOwner）。
- **line 284-289 分叉检测**：seq 相同但内容不同 → die，绝不覆盖历史。

---

## 五.5、调用链

```
commitDurableEvent(definition, event, input?, commit?)     // line 205
  → 提取 aggregateID（event.data[durable.aggregate]）       // line 219-227
  → Effect.uninterruptible                                 // line 237
  → db.transaction(...)                                     // line 240
      → 读 EventSequenceTable（latest = row?.seq ?? -1）    // line 243-248
      → encode event.data                                   // line 250-252
      → strictOwner 校验                                    // line 254-261
      → 幂等分支（line 262-290）或分叉抛 die
      → 非 strictOwner 静默跳过（line 291-293）
      → seq 计算（line 294-295）
      → 执行 projector（line 300-322）
      → 执行 commit 回调（line 323）
      → upsert EventSequenceTable + insert EventTable（line 324-348）
  → 通知顺序（line 369-395）：projectors → listeners → typed pubsub → all pubsub
```

---

## 五.6、状态转换（提交协议内的 event_sequence 行）

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| -1（无 seq） | 首次提交 | `upsert EventSequenceTable` | line 249 |
| `latest` | 已有事件 | `INSERT EventTable` | line 249 |
| `latest + 1` | 下一事件 | seq 分配 | line 294 |
| 幂等重放 | 同 seq + 同 id + 同 data | 认领无主聚合后 return | line 269-283 |
| 分叉 | 同 seq + 不同 data | die（绝不覆盖） | line 284-289 |
| owner 锁定 | `row.ownerID` 被设置 | 主换 owner | line 254-261 |

---

## 五.7、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| 幂等 | `stored.id === event.id && type 匹配 && data deepStrictEqual` | 269-273 | 认领无主聚合后 return |
| 分叉 | 同 seq 但 id/type/data 不全同 | 284-289 | die Replay diverged |
| strictOwner 冲突 | 已有 owner 且不同 | 254-261 | die Replay owner mismatch |
| 非 strict 冲突 | 已有 owner 且不同 | 291-293 | return（静默跳过） |
| seq 不连续 | `input.seq !== latest + 1` | 295-298 | die Sequence mismatch |
| aggregate 不匹配 | `input.aggregateID !== aggregateID` | 228-235 | die Aggregate mismatch |

---

## 五.8、数据流

```
调用方（publish / replay）
  → commitDurableEvent
  → db.transaction（校验 seq → 执行 projector → commit 回调 → 落库）
  → 事件通知（projectors → listeners → pubsub）
  → EventTable 持久化
```

- 输入来源：`publish()` / `replay()` / `replayAll()`
- 传递路径：event → 校验 → 事务（projector + commit + 落库）→ 通知
- 输出去向：`EventTable` 行 + `EventSequenceTable` 行 + listeners（typed pubsub / all pubsub）

---

## 六、测试契约

| 测试文件 | 覆盖 |
|----------|------|
| `packages/core/test/event.test.ts` | 提交协议、幂等、分叉、owner 栅栏、seq 校验 |
| `packages/core/test/session-runner-recorded.test.ts` | 结合 runner 的 replay 行为 |

---

## 七、总结

### 核心结论
1. `commitDurableEvent` 把"校验 seq → 校验 owner → 跑 projector → 跑 commit 回调 → 落库"全部包进**同一个数据库事务**，保证事件真相和投影一致。
2. 幂等分支（line 262-290）是最关键的边界：
   - 同 seq + 同 id + 同 data = 幂等重放（无操作，但可认领）
   - 同 seq + 不同数据 = die Replay diverged（绝不覆盖）
3. `Effect.uninterruptible` 保证提交过程的原子性（取消不能打断已经开始的提交）。

### 可迁移点
- "先持久化意图、再执行外部副作用"（与 Commitment Fence 同族）
- "幂等重放 = 需要同 id + 同 type + 同 data 三因素"

### 易错点
- 把 `Effect.orDie` 当成普通错误（其实是协议级错误，调用方不该 recover）。
- 误以为幂等重放会自动认领所有旧聚合（只在无 owner 且非 strictOwner 时认领）。