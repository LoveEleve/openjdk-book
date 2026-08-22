# dsh Surface 投影源码解析：模型可见视图如何在事件日志上折叠出来

> 解析对象：`packages/core/session/src/surface.ts`（460 行）
> 定位：第二份真·源码解析样板，验证“投影 + 折叠 + 替换”这条核心路径怎么跑。
> 关联机制分析：`dsh/02-Session日志：dsh 如何把模型可见即已记录做成运行时不变量.md`

---

## 一、解析对象

- 文件名：`packages/core/session/src/surface.ts`
- 核心概念：Surface（事件日志上的模型可见投影）
- 核心函数：`deriveEventMessage`、`foldSurface`、`SurfaceManager`
- 核心点：Surface 不是事件总线，而是“3 类事件 → LLM 消息”的确定性投影
- 关联不变量：模型可见 ⟺ 已记录

---

## 二、三条窄化函数（关键行 15-68）

```ts
const SURFACE_EVENT_TYPES = new Set<string>([
  'user/message', 'assistant/message', 'tool/result',
])
```

- `isSurfaceEligibleType(type)`（line 26-28）：只查 type 在不在 3 类中
- `isSurfaceEvent(event)`（line 35-38）：type 合法 **且** surfaceOp defined
- `isReplacementSurfaceEvent(event)`（line 64-68）：surfaceOp !== 'append'（即 replace）

关键点：
- 运行时守卫（line 187-193）：非 surface-eligible 事件若带 surfaceOp / sourceEventSeqs → 直接 throw。
- 这是“防 union 拓宽绕过”的双保险：即使 TS 类型被拓宽，运行时也拒。

---

## 三、deriveEventMessage：单事件投影规则（关键行 83-114）

```
switch event.type:
  'user/message'        → return event.data（verbatim 直通）
  'assistant/message'   → if content.length === 0 return null（只承载 usage 的 step）
                           return event.data.message
  'tool/result'         → return event.data.message
  default               → return null（边界、chunk、usage、error 都是 trace/replay 数据）
```

关键点：
- **line 103**：空 content 的 assistant/message 只承载 max-tokens step 的 usage，不投影成 content-less assistant turn。
- **line 110**：merge-extensible union，故意不用 assertNever，因为插件可以扩展事件类型。
- 注释强调：`user/message` 是 verbatim 直通，framing 是调用方责任，不是投影函数的责任。

---

## 四、surfaceOp 校验：surfaceOpOf（关键行 185-208）

```
isSurfaceEligibleType?
  否 + surfaceOp defined → throw
  否 + sourceEventSeqs defined → throw
  是 + surfaceOp undefined → throw（surface-eligible 必须带 marker）
  是 + surfaceOp === 'append' → return 'append'
  是 + surfaceOp 非对象 / null / array → throw
  是 + 非 isReplaceOp → throw
```

关键点：
- **line 197-199**：surface-eligible 事件必须显式携带 surfaceOp marker，否则运行时拒绝。
- **line 201-206**：replace op 必须精确是 `{ op, start, end }` 三键形状，start/end 必须是非负安全整数。

这种校验和 `planSurfaceEvent` 一起，保证了**追加不变性**：任何事件要么是合法 append，要么是合法 replace，否则直接拒。

---

## 五、foldSurface：全量折叠（关键行 387-395）

```
createFoldState()
for [index, event] of events.entries():
  replacement = applySurfaceEvent(state, event, index, events, 0)
  if replacement !== undefined: replacements.push(replacement)
return { nodes: [...state.nodes], replacements }
```

`applySurfaceEvent` → `planSurfaceEvent` → `applySurfacePlan`：

**planSurfaceEvent**（line 321-347）：
1. `event.seq !== expectedSeq` → throw（不连续）
2. `surfaceOpOf(event)` → undefined 则跳过
3. `'append'` → `assertProvenance(event, [])` → 返回 append plan
4. `'replace'` → `replacementRange(state, op)`（找 startIdx/endIdx）
5. `assertProvenance(event, range.shadowedSeqs)`
6. `assertToolResultRewrite(...)`
7. 返回 replace plan

**applySurfacePlan**（line 362-379）：
```
append → state.nodes.push(seq)
replace → state.nodes.splice(startIdx, endIdx - startIdx + 1, plan.seq); replaceGeneration++
```

---

## 六、replacementRange 与 assertion 细节（关键行）

| 函数 | 关键行 | 校验内容 |
|------|--------|----------|
| `replacementRange` | 246-266 | start/end seq 必须在 surface 中、startIdx ≤ endIdx |
| `assertProvenance` | 211-243 | sourceEventSeqs 必须是数组、非空(除 assistant/message)、无重复、都≥当前seq、必须包含每个被 shadow 的节点 |
| `assertToolResultRewrite` | 287-318 | tool/result replace 只能改 content；必须恰好重写一个当前节点；其余字段必须 deep-equal（用不含 content 的 message 比较）|
| `isDeepEqualJson` | 273-284 | 浏览器安全的 JSON 深度相等（替代 node:util isDeepStrictEqual）|

这些 assertion 是“可重建性”的代码级保证：**重放后跟原请求完全一致的投影**，坏事件在重放边界直接 throw。

---

## 六.5、调用链（全量折叠）

```
foldSurface(events)                       // line 387
  → for [index, event] of events.entries()
  → applySurfaceEvent(state, event, index, events, 0)    // line 350
  → planSurfaceEvent(state, event, expectedSeq, ...)     // line 321（先校验不突变）
      ├─ event.seq !== expectedSeq → throw               // line 328
      ├─ surfaceOpOf(event) → undefined → 跳过           // line 331-332
      ├─ 'append' → assertProvenance → append plan       // line 333-335
      └─ 'replace' → replacementRange → assertProvenance
                      → assertToolResultRewrite → replace plan  // line 337-346
  → applySurfacePlan(state, plan)                        // line 362（再落状态）
      ├─ append  → nodes.push(seq)                       // line 366-367
      └─ replace → splice(nodes, startIdx..endIdx, seq)
                    replaceGeneration += 1                // line 368-370
```

增量折叠 `SurfaceManager`（line 398-460）：
```
validateNext(event)  → _processDelta() → planSurfaceEvent 只校验
_processDelta()      → applySurfacePlan 用已校验 plan / applySurfaceEvent 兜底
```

---

## 六.6、状态转换（surface fold state）

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| `nodes` 空 | `createFoldState()` | 第一个 surface event | line 163-165 |
| append 追加 | 事件 surfaceOp=`'append'` | `nodes.push(seq)` | line 366-367 |
| replace 替换 | 事件 surfaceOp=`{op:'replace',start,end}` | `splice(startIdx..endIdx, seq)` | line 368-370 |
| `replaceGeneration` | replace 提交 | `+= 1`（单调） | line 370 |

关键点：
- `nodes` 是**模型可见顺序**，不是只在事件序。
- 每个 replace 会把被遮蔽范围从 nodes 中移除并插入新 seq。

---

## 六.7、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| surface-eligible | type ∈ 3 类 | 26-28 | 进 next 判断 |
| surfaceOp 缺失 | eligible 但无 marker | 197-199 | throw |
| append vs replace | `op === 'append'` vs 对象 | 200-207 | 两种 plan |
| replace 范围 | start/end ∈ nodes 且 startIdx ≤ endIdx | 250-259 | 否则 throw |
| sourceEventSeqs | 必须包含 shadowedSeqs | 239-242 | 否则 throw |
| tool-result 最少改写 | 只允许改 content | 294-316 | 否则 throw |

---

## 七、SurfaceManager：增量折叠（关键行 398-460）

```
constructor(log, baseSeq=0):
  _state = createFoldState()
  _lastProcessedSeq = baseSeq - 1
  _pendingPlan = undefined

validateNext(event):
  if _lastProcessedSeq 落后 → _processDelta()
  expectedSeq = baseSeq + log.length
  _pendingPlan = { event, expectedSeq, plan: planSurfaceEvent(_state, event, expectedSeq, log, baseSeq) }

_processDelta():
  for seq from _lastProcessedSeq+1 to tailSeq:
    event = log[seq - baseSeq]
    if pending?.event === event && pending.expectedSeq === seq:
      applySurfacePlan(_state, pending.plan)      // 复用已校验 plan
    else:
      applySurfaceEvent(_state, event, ...)        // 未预校验，重新过边界
    if pending && pending.expectedSeq <= seq: _pendingPlan = undefined
    _lastProcessedSeq = seq
```

关键点：
- **validateNext 只校验不改状态**：候选事件未进 log 前，先算出 plan，等进入 log 后再提交。
- **line 451**：如果 pending 的事件确实进入了 log，复用已校验的 plan，不重复校验。
- 这保证了增量折叠和全量折叠产出**完全一致**的 surface。

---

## 六.8、数据流

```
事件（任意 event.type）
  → isSurfaceEligibleType?（3 类才可能投影）
  → surfaceOpOf（append / replace 校验）
  → deriveEventMessage（事件 → LLM 消息，或 null）
      ├─ user/message     → event.data（verbatim）
      ├─ assistant/message → message（跳过空 content）
      └─ tool/result      → message
  → foldSurface / SurfaceManager
  → nodes（模型可见 seq 列表）→ 后续 deriveMessages 按序重建消息
```

- 输入来源：session 事件日志（追加）。
- 传递路径：event → 校验 → 投影（deriveEventMessage）→ 折叠（nodes）。
- 输出去向：`deriveMessages()` 重建的请求消息（模型请求、durable history、delivery 共享同一 frozen message）。

---

## 八、测试契约

| 测试文件 | 覆盖 |
|----------|------|
| `packages/core/session/tests/session.spec.ts` | surfaceOp 运行时守卫、sourceEventSeqs、tool-result rewrite 限制、replace 范围校验 |
| `packages/core/session/tests/surface.spec.ts`（若存在） | append / replace / 复杂折叠 |

（注：`session.spec.ts:498` 是 surfaceOp 运行时守卫的回归测试——union 拓宽绕过类型层后运行时仍拒。）

---

## 九、总结

### 核心结论
1. Surface 不是事件总线，而是**确定性投影**：3 类事件 → LLM 消息，其余是 trace/replay 数据。
2. “模型可见 ⟺ 已记录”在这个文件里落地为**追加不变性 + JSON 严格性 + 深冻结**的代码级约束。
3. `foldSurface` 全量折叠和 `SurfaceManager` 增量折叠产出**严格一致**的视图，因为共享同一 `planSurfaceEvent` 校验。
4. 浏览器安全：`isDeepEqualJson` 替代 node:util，保持 subpath 可以被 vite 打包。

### 可迁移点
- “事件本地校验 + 延迟提交”两阶段（validateNext → applySurfacePlan）值得复制：先证明合法，再进入真相。
- “替换只允许改 content”这种最小改写约束，防止 replace 偷改语义。

### 易错点
- 把 `assistant/message` 的空 content 当正常消息（其实只承载 usage）。
- 误以为 replace 是“编辑器操作”（其实是模型可见阴影，人类转写仍看 append-origin 事件）。