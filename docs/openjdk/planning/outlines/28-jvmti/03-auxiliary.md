# 03. 为每个对象打 tag — TagMap + 事件分派细节

> 🟡 Working | 2 KP 中的辅助系统
> 读者处境: agent 说 "追踪这个对象是否还被引用"→JVM 需要给每个对象标 tag。tag 存在 JvmtiTagMap 中——gc 扫描时必须维护。

### 1. "TagMap — 对象→tag 映射"

场景: JVMTI SetTag(obj, 42)→存 tag→后续 GetTag(obj)→查 mapping → FollowReferences(obj)时通过 tag 追踪。

**JvmtiTagMap** (`jvmtiTagMap.hpp:40-150 + jvmtiTagMap.cpp:100-400`):
```
tag map:
  weak hash table: oop→jlong tag
  - entry is weak reference: if oop is GC'd→entry auto-removed
  - tag persists until Explicitly SetTag(obj, 0) called
  - FollowReferences: post tag to callback(walk heap→collect tag→report to agent)
```
- 源码: `jvmtiTagMap.hpp:40-150` + `jvmtiTagMap.cpp:100-400`
- 关键设计: tag map 用 weak reference——tag 对象被 GC 回收后自动清理。notify via OBJECT_FREE event(如果 agent enabled)。tag 数据在 GC safepoint 时用 GC worker iterate→rehash→clean stale entries
- [C++: tag map iteration 是 O(N) dead→清理阶段在每个 GC cycle 的 cleanup 中执行。agent 主动 set tag→occasional O(N) rehash(很少)]

### 2. "JvmtiDeferredEventQueue — 延迟分派"

场景: app 线程触发事件→不能立即调 agent(可能 block)→推入 deferred queue→ServiceThread 后来处理。

**JvmtiDeferredEventQueue** (`jvmtiImpl.cpp:902-1000`):
```
app thread: 
  → fire_event(METHOD_ENTRY) → push to thread's _jvmti_event_queue
ServiceThread:
  → process_deferred_events → for each event in queue:
    → JvmtiEventController::post_to_agent → call agent callback
```
- 源码: `jvmtiImpl.cpp:deferred events` + `jvmtiEnvThreadState.hpp:50-100`
- 关键设计: 延迟分派的是两类: (1) 如果 event 不要求sync(agent 不在意延迟)→走 deferred path (2) 如果 event is synchronous(BREAKPOINT)→在触发点直接 dispatch。Synchronous events 暂停 app thread 直到 agent callback返回

### 3. "ResolvedMethodTable — 快速方法查找"

**ResolvedMethodTable** (`resolvedMethodTable.hpp:30-80`):
```
Hash table: Method*→quick lookup for JVMTI
  用途: 当 agent requests "breakpoint at method X"→快速找到 Method*
  无需扫描所有 InstanceKlass 的方法表
```
- 源码: `resolvedMethodTable.hpp:30-80` + `resolvedMethodTable.cpp:40-120`
- 关键设计: 每类一个 hash table(per class loader)→碰撞: chained(linked entries)。resolved 仅在 agent needs lookups 时填充(ex: SetBreakpoint→resolved method)

---

### 核心悬念

**"JvmtiTagMap 用 weak hash table 存 object→tag——GC 时自动清理。事件延迟分派: app 线程 fire→deferred queue→ServiceThread dispatch(减少 app 负担)。"** — 下一篇: 域29 MethodHandles。

> → 域29 MethodHandles
