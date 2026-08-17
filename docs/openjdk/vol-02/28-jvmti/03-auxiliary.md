# 03. 为每个对象打 tag — TagMap + 事件分派细节

> **前置依赖**:[28-jvmti/01 — JVMTI Agent 怎么工作？— Agent 架构与事件系统](openjdk/vol-02/28-jvmti/01-agent-architecture.md):env/capability(44 位,`can_tag_objects`/`can_generate_object_free_events` 在 always 集)/事件系统/延迟队列(§5 已拆 4 类编译事件)已讲;[28-jvmti/02 — 怎么不重启 JVM 替换一个类的字节码？— RedefineClasses](openjdk/vol-02/28-jvmti/02-redefine-classes.md):`ResolvedMethodTable::adjust_method_entries` 与 jmethodID 重定向已讲;[25-gc-framework/03 — 引用到底怎么处理?— Reference Processing](openjdk/vol-02/25-gc-framework/03-reference-processing.md):弱/软/幻影引用处理的 GC 阶段;[27-jni/01 — jobject 在 JVM 内部怎么存的?— JNI Handle 系统](openjdk/vol-02/27-jni/01-handle-system.md):weak 引用语义
> → **后续**:[29-mh/01 — invokeExact 怎么做到 50x faster than reflection？— MH invoke 链路](openjdk/vol-02/29-mh/01-invoke-chain.md)
> 关联域: 28-jvmti(接口层)、25-gc-framework(弱处理/堆遍历)、29-mh(ResolvedMethodTable 的消费方)

## 给对象贴上"外部身份"

agent 想追踪"这个对象还活着吗"——JVM 给对象打 **tag**(一个 jlong 值,与对象一一关联)。tag 存在哪、tag 的对象被 GC 了怎么办、怎么按 tag 找回对象、怎么遍历堆——这是 JvmtiTagMap 的职责。本篇是 28 域收官篇,拆三块: **tag 系统**(§1)、**事件分派的两个细节**(§2: 单步/断点的重复过滤与 ObjectFree 事件)、**ResolvedMethodTable**(§3: 一个被大纲误读为 JVMTI 内部表的 JSR-292 桥)。

## 1. TagMap — 对象的 jlong 标签

### 1.1 结构: 每 env 一个哈希表

大纲说 "weak hash table: oop→jlong tag;entry is weak reference...auto-removed"——半对。真实结构(jvmtiTagMap.hpp:41-53): **每个 JvmtiEnv 一个 tag map**,成员是 `_env/_lock/_hashmap/_free_entries`(free list 上限 4096);map 是**普通哈希表**,"弱"的是**条目里的 oop 访问方式**:

```cpp
// jvmtiTagMap.cpp:71-116(截取核心,逐字)
class JvmtiTagHashmapEntry : public CHeapObj<mtInternal> {
 private:
  friend class JvmtiTagMap;

  oop _object;                          // tagged object
  jlong _tag;                           // the tag
  JvmtiTagHashmapEntry* _next;          // next on the list
  ...
 public:

  // accessor methods
  inline oop* object_addr() { return &_object; }
  inline oop object()       { return NativeAccess<ON_PHANTOM_OOP_REF>::oop_load(object_addr()); }
  // Peek at the object without keeping it alive. The returned object must be
  // kept alive using a normal access if it leaks out of a thread transition from VM.
  inline oop object_peek()  {
    return NativeAccess<ON_PHANTOM_OOP_REF | AS_NO_KEEPALIVE>::oop_load(object_addr());
  }
```

`_object` 是普通 oop 字段,但**读写走 `ON_PHANTOM_OOP_REF` 语义的 NativeAccess**——tag 不延长对象生命(phantom 级),GC 扫描也不把它当强引用。哈希表本身(JvmtiTagHashmap,jvmtiTagMap.cpp:136-244): 桶数组+链,`hash = (addr >> 3) % size`(LP64,:194),**负载因子默认 4.0**(:166,即 400% 才扩容,注释里的 "0.75" 只是说明性文字),扩容时全量 re-hash(:207-244)。

### 1.2 set/get: 一把锁 + 增删改查

`set_tag`/`get_tag`(jvmtiTagMap.cpp:738-777)是热路径(注释 "This function is performance critical...Mutex...will be a hot lock"): **每 map 一把 `_lock`**,`find` 后三态——不在→`create_entry`+`add`;在且 tag≠0→`set_tag` 更新;**在且 tag=0→`remove`+`destroy_entry`**(tag 归零即删除,解除标记的常规方式)。`create_entry` 优先取 env 的 free list(:494-512,已删条目复用)。

JVMTI 侧入口 `JvmtiEnv::SetTag/GetTag`(jvmtiEnv.cpp:1933/:1924): 校验对象后 `JvmtiTagMap::tag_map_for(this)`(**懒创建**,jvmtiTagMap.cpp:529-541)——**不 SetTag 就不建 map**——能力声明只置标志不分配结构(28-01 §2 的"能力只是位"在此兑现;update() 里 can_tag_objects 的唯一副作用是 set_can_walk_any_space,jvmtiManageCapabilities.cpp:340-341)。

### 1.3 GC 集成: 弱处理阶段的清理

tag 的对象死了怎么办?**tag map 的清理挂在 GC 的弱处理阶段**——`WeakProcessor::weak_oops_do`(weakProcessor.cpp:38)调用链: `JvmtiExport::weak_oops_do`(jvmtiExport.cpp:2616)→`JvmtiTagMap::weak_oops_do`(jvmtiTagMap.cpp:3317,遍历所有 env 的 map)→`do_weak_oops`(:3335):

```cpp
// jvmtiTagMap.cpp:3361-3386(截取核心,逐字)
  for (int pos = 0; pos < size; ++pos) {
    JvmtiTagHashmapEntry* entry = table[pos];
    JvmtiTagHashmapEntry* prev = NULL;

    while (entry != NULL) {
      JvmtiTagHashmapEntry* next = entry->next();

      // has object been GC'ed
      if (!is_alive->do_object_b(entry->object_raw())) {
        // grab the tag
        jlong tag = entry->tag();
        guarantee(tag != 0, "checking");

        // remove GC'ed entry from hashmap and return the
        // entry to the free list
        hashmap->remove(prev, pos, entry);
        destroy_entry(entry);

        // post the event to the profiler
        if (post_object_free) {
          JvmtiExport::post_object_free(env(), tag);
        }
```

每个 entry 三态: ①`is_alive` 判死 → 删除+入 free list+**可选的 OBJECT_FREE 事件**;②活着且 `f->do_oop` 更新了引用(压缩 oop/移动 GC)→ **按新地址 re-hash 换桶**(:3389-3407,新位置靠后的 entry 用 `delayed_add` 暂存,遍历结束后统一插回——注释 "Delay adding this entry to it's new position as we'd end up hitting it again during this iteration",防本次遍历重复命中;`moved` 计数);③没动 → 保持。

*关键设计: "弱"的落点。tag map 不参与可达性——`is_alive` 判死、死条目即删,天然与 GC 结果一致(发布瞬时有一次 `keep_alive` 防 SATB 竞态,create_entry :499);对象移动由 `do_oop` 更新+re-hash 跟上。这与 27-jni/01 的 JNI weak 同处 WeakProcessor 的弱处理阶段(weakProcessor.cpp:36-41 同一调用链,`JNIHandles::weak_oops_do` 与 `JvmtiExport::weak_oops_do` 相邻),但 tag map 更进一步——对象死后还发 ObjectFree 事件,agent 得以知道"那个被标记的对象没了"。*

[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/28-jvmti-tagmap-demo.txt)(素材 A/B): SetTag 3 个对象→GetObjectsWithTags 精确返回→丢弃强引用+`ForceGarbageCollection`(jvmtiEnv.cpp:1954,`GCCause::_jvmti_force_gc`)→ **ObjectFree 回调 3 次,tag=1002/2002/3003 精确匹配**;`-Xlog:jvmti+objecttagging=trace` 看到 `do_weak_oops` 的日志 **`(3->0, 3 freed, 0 total moves)`**(:3427-3428,entry_count 3→0/清除 3/无移动);之后 GetObjectsWithTags 返回 0。

### 1.4 堆遍历: 借用 mark 位的标记

IterateThroughHeap/FollowReferences 是 tag 的进阶——**按条件遍历堆/追踪引用图**。两者都是 `Heap_lock` + **VM 操作**(safepoint 内做堆遍历): `VM_HeapIterateOperation`(iterate_through_heap :1511-1528)与 `VM_HeapWalkOperation`(:2663-3300,FollowReferences :3301-3314)。两个关键机制:

1. **ObjectMarker**(:1654-1734): 遍历时**借用对象的 mark 位做 visited 标记**——"有趣"的 header(有锁/identity hash 的)先保存到数组,遍历完恢复(:1694-1720);这是"不改堆结构做 BFS"的技巧;
2. **VM_HeapWalkOperation::doit**(:3233-3298): 初始对象为空 → `collect_stack_roots`(先栈,性能) + `collect_simple_roots`(静态/JNI 等 GC roots);非空 → 从该对象开始;之后 visit_stack 显式栈 BFS,按对象类型 `iterate_over_*` 沿引用边推进。

filter 语义有个**反直觉坑**(素材 C 实测): `JVMTI_HEAP_FILTER_TAGGED` 传进去回调 **43650 个(全部 untagged 对象)**,`UNTAGGED` 才回调 3 个 tagged——`is_filtered_by_heap_filter`(jvmtiTagMap.cpp:1017-1034)注释明写 **"filter out tagged objects"**: **filter 位是"要排除的类别"**,不是"要包含的类别"。

## 2. 事件分派细节 — 28-01 的两个补全

28-01 §5 已拆延迟队列的真相(4 类编译事件;方法级事件同步发布)。本篇补两个未展开的细节:

### 2.1 单步/断点的重复过滤

SingleStep/Breakpoint 是 per-thread 事件,同一位置可能重复触发(指令重写、断点后单步、单步撞断点)。`JvmtiEnvThreadState` 维护"上次位置"(jvmtiEnvThreadState.hpp:115-118: `_current_method_id/_current_bci/_breakpoint_posted/_single_stepping_posted`),`compare_and_set_current_location`(jvmtiEnvThreadState.cpp:154-191)过滤:

```
同一 (method, bci):
  BREAKPOINT: 仅当"上次发过断点且上次单步过"(两个标志都真)才跳过——
              注释 "If we previously posted a breakpoint event at this location
              and if we also single stepped at this location then we skip the
              duplicate breakpoint"(post_raw_breakpoint :1163 `!breakpoint_posted()`
              才发回调,发完 set_breakpoint_posted)
  SINGLE_STEP: 同位置直接跳过(post_single_step 同样 `!single_stepping_posted()` 门控)
不同位置: 更新 _current_*,两个 posted 标志清零 → 发
```

*关键设计: "发过就不发"的去重表。单步/断点以字节码位置为键,靠 per-env×per-thread 的小状态记住上一次,避免 agent 收到同一个断点两次——这是 28-01 三级 bitset 之外的"事件质量"机制。*

### 2.2 ObjectFree 事件: 只有 tag,没有对象

§1.3 的清理路径里,`JvmtiExport::post_object_free`(jvmtiExport.cpp:1461-1474)在 **safepoint 内**发事件,回调签名 `(jvmtiEnv*, jlong tag)`——**没有 JNIEnv,没有对象引用**(对象已死,给引用也没用),只有 tag。这是"事件发生在 GC 清理时刻"的实例: 与 27-jni/01 的 JNI weak 清理同处 WeakProcessor 阶段(weakProcessor.cpp:36-41 同一调用链),但 agent 拿到的是**死亡通知**而非保活机会。

## 3. ResolvedMethodTable — 大纲整节误读的 JSR-292 桥

大纲说它 "Method*→quick lookup for JVMTI;breakpoint at method X→快速找到 Method*;每类一个 hash table(per class loader)"——**全错**。真实的类头注释(resolvedMethodTable.hpp:32-34)就是它的全部用途:

```cpp
// resolvedMethodTable.hpp:32-34(截取核心,逐字)
// Hashtable to record Method* used in ResolvedMethods, via. ResolvedMethod oops.
// This is needed for redefinition to replace Method* with redefined versions.
```

它是 **`java.lang.invoke.ResolvedMethodName`(方法句柄解析产物)与 JVM Method* 的映射表**——单例(静态 `_the_table`,hpp:54)、1007 桶、通用 Hashtable 子类(hpp:49)。用途注释点破一切: **给 RedefineClasses 用**——28-02 已讲 `adjust_method_entries`(resolvedMethodTable.cpp:204-241)在 redefine 时把 vmtarget 从旧 Method* 换成新的;本篇补它怎么被填:

- Java 侧方法句柄解析 → `java_lang_invoke_ResolvedMethodName::find_resolved_method`(javaClasses.cpp:3800-3821): 查表(`find_method` :119)→ 无则 new 一个 ResolvedMethodName oop(**vmtarget=Method*\*,vmholder=java_mirror 保活** meta 不被卸载)→ `add_method`(:124)入表;
- 表条目弱引用其 oop(**ClassLoaderWeakHandle**,hpp:40),ResolvedMethodName oop 被回收的条目由 `unlink`(:155)清理;
- `set_vmtarget`(:3795-3799,注释 "Used by redefinition to change Method* to new Method* with same hash")——redefine 后方法句柄自动指向新方法,**无需重解析**。

*关键设计: 方法句柄是"方法的稳定句柄"——它不能因 redefine 而失效。ResolvedMethodTable 把 (ResolvedMethodName oop ↔ Method*) 的关系登记在案,redefine 时按表改写,句柄持有者无感知。这也是它为什么不在"JVMTI 内部设施"而在 JSR-292 的桥上的原因——大纲把它当断点查找表,是"名字像内部表"的误读。*

## 核心悬念

28 域收官。辅助设施到齐: **TagMap**(每 env 一个哈希表,phantom 语义的 oop 槽位、SetTag/GetTag 三态、GC 弱处理阶段清死条目+ObjectFree 通知、对象移动 re-hash、mark 位借用的堆遍历、反直觉的 filter 语义)、**事件细节**(单步/断点位置去重、ObjectFree 只有 tag 的死亡通知)、**ResolvedMethodTable**(方法句柄↔Method* 的登记表,redefine 的自动改写通道)。——最后一节埋了线索: **方法句柄解析产物的 ResolvedMethodName 是"方法的稳定句柄"**。Java 层调用 MethodHandle 时,invokedynamic 怎么找到它?签名多态调用怎么分派?下一篇: 方法句柄。

> → [29-mh/01 — invokeExact 怎么做到 50x faster than reflection？— MH invoke 链路](openjdk/vol-02/29-mh/01-invoke-chain.md)
