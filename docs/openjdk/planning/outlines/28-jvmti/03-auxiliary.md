# 03. 为每个对象打 tag — TagMap + 事件分派细节

> 🟡 Working | 2 KP 中的辅助系统
> 读者处境: agent 说 "追踪这个对象是否还被引用"→JVM 需要给每个对象标 tag。tag 存在 JvmtiTagMap 中——gc 扫描时必须维护。

### 1. "TagMap — 对象→tag 映射"
> ⚠️ 写作期修正(2026-08-16, vol-02/28-jvmti/03 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"weak hash table...entry is weak reference...auto-removed" 半对(重要)**: 真实=**普通哈希表**+条目里 oop 以 **phantom 语义访问**(jvmtiTagMap.cpp JvmtiTagHashmapEntry :71-116 `NativeAccess<ON_PHANTOM_OOP_REF>` :92)——tag 不延长对象生命;**清理不是"自动"而是 GC 弱处理阶段显式做**: weakProcessor.cpp:36-41 的 WeakProcessor::weak_oops_do 调用链→JvmtiExport::weak_oops_do(jvmtiExport.cpp:2616)→JvmtiTagMap::weak_oops_do(jvmtiTagMap.cpp:3317)→do_weak_oops(:3335): is_alive 判死→删除+free list+**可选 OBJECT_FREE 事件**;活着且对象移动→f->do_oop+**re-hash 换桶**(:3389-3407,delayed_add 防本次遍历重复命中)
> - **"JvmtiTagMap(jvmtiTagMap.hpp:40-150)" 半对**: hpp 128 行;每 env 一个(类 :41-53: _env/_lock/_hashmap/_free_entries,max_free_entries=4096);tag_map_for 懒创建(:529-541,不 SetTag 不建 map)
> - **哈希表细节**: JvmtiTagHashmap(:136-244): hash=(addr>>3)%size(LP64 :194)/**负载因子默认 4.0**(:166,注释 0.75 是说明文字)/扩容全量 re-hash(:207-244)
> - **set/get 三态**(set_tag :738-767): 不在→create_entry+add;在且 tag≠0→更新;**tag=0→remove+destroy(解除标记唯一方式)**;每 map 一把 Mutex(热路径注释 :735-737)
> - **堆遍历(大纲漏)**: IterateThroughHeap=VM_HeapIterateOperation(iterate_through_heap :1511-1528);FollowReferences=VM_HeapWalkOperation(VM 操作 safepoint 内 BFS,:2663-3300;doit :3233-3298 初始对象空→collect_stack_roots+collect_simple_roots/非空→从对象开始;**ObjectMarker 借用对象 mark 位做 visited**,保存"有趣" header 遍历后恢复(:1654-1734));**filter 反直觉**: JVMTI_HEAP_FILTER_TAGGED=**排除** tagged(is_filtered_by_heap_filter :1017-1034 "filter out tagged objects";实测 TAGGED 传 43650 untagged 回调/UNTAGGED 才 3 个)
> - **ObjectFree 事件**: post_object_free(jvmtiExport.cpp:1461-1474) safepoint 内发,**回调只有 tag 无对象引用**(对象已死);required 能力 can_generate_object_free_events(jvmti.xml:13683)
> - **实证**: SetTag 3 对象→GetObjectsWithTags 精确→forceGC(ForceGarbageCollection jvmtiEnv.cpp:1954 _jvmti_force_gc)→ObjectFree×3 tag 精确匹配;objecttagging 日志 "(3->0, 3 freed, 0 total moves)"(:3427-3428)

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
> ⚠️ 写作期修正(2026-08-16, vol-02/28-jvmti/03 已按真实源码成文):
> - **本节内容已在 28-01 §5 彻底拆过(重要)**: JvmtiDeferredEvent/Queue 只服务 4 类编译事件(compiled_method_load/unload/dynamic_code_generated/class_unload),jvmtiImpl.hpp:454-549;方法级事件同步发布+interp_only;ServiceThread 队列(serviceThread.cpp:43/:105-128)与 GenerateEvents per-thread 补发(jvmtiCodeBlobEvents.cpp:224-250)——**本篇不再重复,改为补两个细节**
> - **本篇 §2 实际内容(事件分派细节)**: ①单步/断点重复过滤——JvmtiEnvThreadState 的 _current_method_id/_current_bci/_breakpoint_posted/_single_stepping_posted(jvmtiEnvThreadState.hpp:115-118)+compare_and_set_current_location(jvmtiEnvThreadState.cpp:154-191): 同位置 BREAKPOINT 仅当"上次发过断点且上次单步过"才跳过(post_raw_breakpoint jvmtiExport.cpp:1163 `!breakpoint_posted()` 门控),SINGLE_STEP 同位置直接跳过;②ObjectFree 事件=GC 清理时刻的死亡通知(§1.3,只有 tag 无对象)

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
> ⚠️ 写作期修正(2026-08-16, vol-02/28-jvmti/03 已按真实源码成文):
> - **大纲整节错(重要)**: 不是 "Method*→quick lookup for JVMTI"/"breakpoint 查找"/"per class loader 表"——真实=**java.lang.invoke.ResolvedMethodName(方法句柄解析产物)↔ JVM Method* 的映射表**,用途注释(resolvedMethodTable.hpp:33-34)="This is needed for redefinition to replace Method* with redefined versions"
> - **结构**: 单例(静态 _the_table hpp:54)/1007 桶/通用 Hashtable 子类(hpp:49);条目 ClassLoaderWeakHandle 弱引用 oop(hpp:40)
> - **填充**: java_lang_invoke_ResolvedMethodName::find_resolved_method(javaClasses.cpp:3800-3821): 查表(find_method :119)→无则 new ResolvedMethodName oop(vmtarget=Method*/vmholder=java_mirror 保活)→add_method(:124);清理 unlink(:155,oop 被回收的条目)
> - **与 28-02 衔接**: adjust_method_entries(resolvedMethodTable.cpp:204-241)在 redefine 时改 vmtarget 旧→新,句柄持有者无感知(无需重解析)

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
> ⚠️ 悬念机制描述已过期(2026-08-16): tag map 是普通哈希表+phantom oop+GC 弱处理显式清理(非"自动");延迟队列只服务编译事件(28-01 已证)。正确总结见正文"核心悬念";下一篇 29-mh/01(标题="invokeExact 怎么做到 50x faster than reflection？— MH invoke 链路",目录 29-method-handles)。

> → [01-invoke-chain.md](01-invoke-chain.md)
