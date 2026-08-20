# 33. JConsole 怎么知道 Eden 用了多少?— MemoryService + MemoryPool

> **前置依赖**:[25-gc-framework/02 — new Object() 走到了哪？— CollectedHeap + 分配路径](openjdk/vol-02/25-gc-framework/02-collected-heap.md):G1 的堆结构(region/young/old)是这些“池”要反映的真实对象;[39-runtime-monitoring/01 — JVM 的后台线程做什么?— ServiceThread](openjdk/vol-02/39-runtime-monitoring/01-service-thread.md):GC 结束后的 JMX 通知由 ServiceThread 消费,本篇的 GCMemoryManager 是它的数据上游;[39-runtime-monitoring/02 — Timer + Monitoring Services — 高精度计时 + JMX 统计](openjdk/vol-02/39-runtime-monitoring/02-timer-stats.md):jstat 读 PerfData 是另一条读口,本篇的 JMX 查询与它对照
> → **后续**:[33-jmx/02 — JDK 怎么查询 JVM 内存状态?— JMM 接口 + JDK Management](02-jmm-interface.md)
> 关联域: 25-gc-framework(GC 内部统计)、27-jni(JavaCalls 调 Java 侧构造)、30-jvm-entry(JavaCalls)

JConsole 的 Heap 曲线看起来像一张“实时仪表盘”: Eden、Survivor、Old、Metaspace 各有一条线,GC 一结束立刻回落。但这背后不是某个后台线程在不停刷新一张缓存表。本篇要回答的核心问题:

1. `MemoryPoolMXBean.getUsage()` 读到的数字到底从哪来——现算还是缓存?
2. 为什么 G1 的两个 `MemoryManager` 都“管理”全部三个堆池?
3. 一次 GC 结束后,`getUsage()` 与 `getCollectionUsage()` 为什么能同时拿到一致的新账本,而不是半新半旧?

答案会反复落到一句话:**Pool 描述“哪块内存”，Manager 描述“哪类操作管理它”，两者不是一对一关系。当前 usage 每次现算，GC 前后 usage 则由 TraceMemoryManagerStats 写进 GCStatInfo，gc_end 用锁保护的双缓冲交换原子发布完整账本。**

---

## 1. 开场困惑——JConsole 曲线数据在哪

JMX 实证里 `ManagementFactory.getMemoryPoolMXBeans()` 会列出 8 个池:

- 3 个 CodeHeap 池;
- Metaspace + Compressed Class Space;
- G1 Eden / Survivor / Old 三个堆池。

很多人第一反应是: 每个池是不是 JVM 启动时建一个“统计对象”，后台线程不停往里写当前 used/committed, JConsole 只是读缓存?如果是这样,GC 前后那一瞬间最容易出错——Eden 已经清空了,Old 还没更新,UI 会看到半截状态。

先给结论闭个环: 这 8 个池 = 3(CodeHeap)+2(Metaspace)+3(G1 heap)。源码的设计恰好不是缓存方案。`MemoryPool` 不是“静态缓存”，而是**活的视图**: 当前 usage 每次查询都现算;只有 peak / after-GC 这类“账本”才缓存下来。JMX 读的是“当前视图”+“最近一次完整发布的 GC 账本”两套数据。

---

## 2. 两个朴素方案为什么都不对

### 方案一: 把 MemoryPool 当静态缓存

如果池对象里永久缓存 `used/committed/max`,后台线程周期性刷新,确实很好理解。但 GC 内部统计变化的速度比后台线程调度快得多,而且不同池的更新顺序必须和 GC 生命周期精确对齐。用周期刷新只会得到延迟、抖动和半旧状态。

### 方案二: 一个 GC manager 只绑定一个区域

直觉上,“G1 Young Generation” manager 应该只管 Eden/Survivor,“G1 Old Generation” manager 只管 Old。但这不符合 JMX 的问题模型。`MemoryManagerMXBean` 不是在回答“这个区域属于谁”，而是在回答“这次 GC 影响了哪些池”。一次 Young GC 不会搬 Old 对象,但它依然可能改变 Old 的 `collectionUsage` 语义边界;Full GC 更是影响全部堆池。所以 manager 的维度是 **GC 类型**,不是 **区域归属**。

---

## 3. MemoryPool——活视图与 G1 三个池

`MemoryPool` 的类头和成员一眼就能看出它分成两类信息: **身份** 与 **账本**。核心成员(memoryPool.hpp:60-68):

```cpp
// memoryPool.hpp:60-68(截取核心,逐字)
const char*      _name;
PoolType         _type;
size_t           _initial_size;
size_t           _max_size;
bool             _available_for_allocation;
MemoryManager*   _managers[max_num_managers];
int              _num_managers;
MemoryUsage      _peak_usage;
MemoryUsage      _after_gc_usage;
```

这里最重要的设计是 `get_memory_usage()`(memoryPool.hpp:133)是**纯虚函数**。也就是说:**当前使用量不缓存,每次查询都现算。** `_peak_usage` 和 `_after_gc_usage` 只负责峰值与“最近一次 GC 后”的快照。

### G1 三个堆池不是 services 层定义的

G1 的 Eden/Survivor/Old 池不在 services 目录,而是 G1 自己定义的(`g1MemoryPool.cpp`):

```cpp
// g1MemoryPool.cpp:49-56(截取核心,逐字)
MemoryUsage G1EdenPool::get_memory_usage() {
  size_t initial_sz = initial_size();
  size_t max_sz     = max_size();
  size_t used       = used_in_bytes();
  size_t committed  = _g1mm->eden_space_committed();

  return MemoryUsage(initial_sz, used, committed, max_sz);
}
```

`used_in_bytes()` 的数据源是 `G1MonitoringSupport`。它按 region 计数现算:

- Eden used = `eden_list_length * HeapRegion::GrainBytes`
- Survivor used = `survivor_list_length * HeapRegion::GrainBytes`
- Old used = `overall_used - eden_used - survivor_used`

所以 JConsole 里的 G1 三条线并不是某个后台缓存表,而是**G1 当前 region 统计的投影**。

关于 max 的语义值得说清: `G1OldGenPool` 的 max 来自 `old_gen_max()`——它不是“当前 Old 区已提交大小”，而是 JMX 暴露给 Old 池的理论上限，因此实证里会接近 `MaxHeapSize`；而 `G1EdenPool`/`G1SurvivorPool` 构造时传 `_undefined_max`，所以它们在 JConsole 里显示 undefined。

### 池是谁建的

池是 GC 堆自己建的。`G1CollectedHeap` 构造时就 new 出三个池(`g1CollectedHeap.cpp:1742-1748` 之前的构造链): `_eden_pool`、`_survivor_pool`、`_old_pool`。`MemoryService` 只负责把 `heap->memory_pools()` 收进自己的 `_pools_list`(memoryService.cpp:71-92),并顺手初始化对应的 memory manager。

换句话说: **GC 知道“现实中的堆长什么样”，MemoryService 只是把这个现实注册给 JMX。**

---

## 4. MemoryUsage——四元组与 undefined

每个池的 `get_memory_usage()` 返回一个 `MemoryUsage`(memoryUsage.hpp:30-45)——四元组(后面查询链路里 `create_MemoryUsage_obj` 构造 Java `MemoryUsage` 时,传的就是这四元组对应的四个 long 参数):

- `init`：JVM 启动时向 OS 请求的量;
- `used`：当前用掉;
- `committed`：已提交且**保证可用**的量(不是“当前物理占用”的另一种说法);
- `max`：理论上限。

“未定义”是第一类状态,不是错误。`MemoryUsage::undefined_size()` 返回 `(size_t)-1`;跨 JNI 边界时 `convert_to_jlong` 会把它映射成 Java 侧的 `-1L`。这就是为什么 JConsole 里 G1 Eden / Survivor 的 max 常常显示 undefined,而 Old / Metaspace 可能有明确上限。

这也解释了阈值支持的差异: G1EdenPool / G1SurvivorPool 构造时 `support_usage_threshold=false`,而 G1OldGenPool 是 true。Eden/Survivor 是高度波动的瞬时区域,对它们做 usage threshold 语义不稳;Old 才是更有意义的长期监控目标。

---

## 5. MemoryManager——两个 G1 manager 为什么都管三池

`MemoryManager` 只描述“谁管理这些池”，自己并不记 GC 账。注意它的池数组是**定长小数组**（`_pools[max_num_pools=10]`，memoryManager.hpp:49-55），不是动态 growable 容器——services 层用固定上限的朴素结构承担 8 池/4 manager 这种规模，这就是“8 个池、4 个 manager”能成立的前提。`MemoryPool` / `MemoryManager` 各自还持有一个 **volatile instanceOop** (`_memory_pool_obj` / `_memory_mgr_obj`) 作为 Java mirror；第一次查询时懒创建,之后由 `MemoryService::oops_do`(memoryService.cpp:193-204) 扫描保活。真正的记账在 `GCMemoryManager` 里(memoryManager.hpp:138-147):

```cpp
// memoryManager.hpp:138-147(截取核心,逐字)
size_t       _num_collections;
elapsedTimer _accumulated_timer;
GCStatInfo*  _last_gc_stat;
Mutex*       _last_gc_lock;
GCStatInfo*  _current_gc_stat;
int          _num_gc_threads;
volatile bool _notification_enabled;
const char*  _gc_end_message;
bool         _pool_always_affected_by_gc[MemoryManager::max_num_pools];
```

它记四类账:

- GC 次数;
- 累计 GC 时间;
- 最近一次 GC 的 before/after 完整账本;
- 通知开关。

### G1 的两个 manager 按 GC 类型分工

`G1CollectedHeap` 构造时创建两个 manager(`g1CollectedHeap.cpp:1424-1425`):

- `_memory_manager("G1 Young Generation", "end of minor GC")`
- `_full_gc_memory_manager("G1 Old Generation", "end of major GC")`

它们不是按区域分工,而是按 **GC 类型** 分工:

- Young/Evacuation Pause 的账记到 `G1 Young Generation`
- Full GC 的账记到 `G1 Old Generation`

但两个 manager 都会 `add_pool` 全部三个堆池。区别只在 `always_affected_by_gc` 标志: Old 池对 Young GC 不是总受影响,而 Eden/Survivor 对 Young GC 是总受影响。这样 JMX 问“这个 manager 管哪些池”时,两个 manager 都会返回全部堆池;问“这次 GC 后哪些池的 collectionUsage 要刷新”时,由 `always_affected_by_gc` 决定。

### 双向关联

`add_pool` 时 manager 记住 pool,同时 `pool->add_manager(this)`。所以 JMX 侧既能问“这个池归谁管”,也能问“这个 manager 管哪些池”,两边都是 O(1) 查数组。

---

## 6. GC 账本与 JMX 查询——before/after + 双缓冲发布

### TraceMemoryManagerStats: RAII 把账挂在 GC 两侧

GC 两侧的打点由 `TraceMemoryManagerStats` 做 RAII。构造调 `MemoryService::gc_begin`,析构调 `MemoryService::gc_end`。

`gc_begin`(memoryManager.cpp:211-236):

- 启累计计时器;
- 记录 `_current_gc_stat` 的索引和开始时间;
- **快照所有池的 GC 前 usage** 到 `before_gc_usage_array`。

`gc_end`(memoryManager.cpp:241-298):

- 停累计计时器;
- 记录结束时间;
- **快照所有池的 GC 后 usage** 到 `after_gc_usage_array`;
- 对受影响池 `set_last_collection_usage(usage)`;
- `_num_collections++`;
- 用 `_last_gc_lock` 保护,交换 `_last_gc_stat` / `_current_gc_stat` 双缓冲。

双缓冲交换就是这几行:

```cpp
// memoryManager.cpp:285-292(截取核心,逐字)
{
  MutexLockerEx ml(_last_gc_lock, Mutex::_no_safepoint_check_flag);
  GCStatInfo *tmp = _last_gc_stat;
  _last_gc_stat = _current_gc_stat;
  _current_gc_stat = tmp;
  _current_gc_stat->clear();
}
```

**关键设计**: 最近一次完成的 GC 账本必须一次性发布。双缓冲让“发布”退化成一个受锁保护的指针交换,读者永远看到完整账本,不会读到半截 before/after。

### update_sizes 必须先于 gc_end

对 G1 来说,内部统计要先更新,池的账本才能读对。源码特意强调这句(`g1CollectedHeap.cpp:3096-3100`):

```cpp
// g1CollectedHeap.cpp:3096-3100(截取核心,逐字)
// ... so that the G1 memory pools are updated
// before any GC notifications are raised.
g1mm()->update_sizes();
```

如果 `gc_end` 在 `update_sizes()` 之前读 `get_memory_usage()`,取到的还是 GC 前的旧 region 计数。**先 update_sizes,再 gc_end** 是这篇最重要的时序。

### JMX 查询链路

`MemoryPoolMXBean.getUsage()` 的 native 侧入口是 `jmm_GetMemoryPoolUsage`(management.cpp:557-568):

```cpp
// management.cpp:557-568(截取核心,逐字)
JVM_ENTRY(jobject, jmm_GetMemoryPoolUsage(JNIEnv* env, jobject obj))
  ResourceMark rm(THREAD);

  MemoryPool* pool = get_memory_pool_from_jobject(obj, CHECK_NULL);
  if (pool != NULL) {
    MemoryUsage usage = pool->get_memory_usage();
    Handle h = MemoryService::create_MemoryUsage_obj(usage, CHECK_NULL);
    return JNIHandles::make_local(env, h());
```

两点值得注意:

1. **池的 Java mirror 是懒创建的**：第一次被枚举/查询时才通过 `get_memory_pool_instance()` 去调 Java 侧 `ManagementFactoryHelper.createMemoryPool(...)`；
2. **`MemoryUsage` 对象也是查询时现构造的**：`create_MemoryUsage_obj`(memoryService.cpp:234-248)用 `JavaCalls::construct_new_instance` 现做一个 `java.lang.management.MemoryUsage`。

也就是说,JConsole 看到的不是“后台刷好的 Java 对象”，而是**查询时现算 + 现装箱**的结果。

`MemoryMXBean.getHeapMemoryUsage()` 则是汇总: `jmm_GetMemoryUsage`(management.cpp:706-756)遍历全部 heap pool 累加 used/committed,`init=InitialHeapSize`,`max=Universe::heap()->max_capacity()`。任一池 undefined,整体就 -1。

---

## 7. 误解澄清与收网

1. **MemoryPool 是缓存吗?** 不是。当前 usage 每次现算,只缓存 peak 和 after-GC usage。
2. **G1 Young/Old manager 是按区域分工吗?** 不是。按 GC 类型分工,但都挂全部三个堆池。
3. **为什么 JMX 能同时读到当前 usage 和 collectionUsage?** 因为前者是活视图现算,后者是 gc_end 发布的最近一次完整账本。
4. **为什么 update_sizes 的顺序这么重要?** 因为 pool 的 current usage 直接读 G1MonitoringSupport,内部统计不先更新,账本就会读旧值。
5. **JConsole 的 Java 对象是后台维护的吗?** 不是。池 mirror 懒创建,`MemoryUsage` 对象查询时现构造。

把这一篇压成三句话:

- **Pool 是活视图,Manager 是记账人**——两者不是一对一关系。
- **G1 两个 manager 都挂三池**，区别在按 GC 类型记账和 `always_affected_by_gc` 标志。
- **GC 账本靠 RAII + 双缓冲发布**，而当前 usage 每次现算,所以 JMX 既能看到“现在”,也能看到“最近一次 GC 后”。

下一篇: JMM 接口与 JDK Management——那张 `jmm_interface` 函数表到底从哪里来、JDK 侧怎么通过它查询 JVM 状态。

> → [33-jmx/02 — JDK 怎么查询 JVM 内存状态?— JMM 接口 + JDK Management](02-jmm-interface.md)