# 33. JConsole 怎么知道 Eden 用了多少?— MemoryService + MemoryPool

> **前置依赖**:[25-gc-framework/02 — new Object() 走到了哪？— CollectedHeap + 分配路径](openjdk/vol-02/25-gc-framework/02-collected-heap.md):G1 的堆结构(region/young/old)是这些"池"要反映的真实对象;[39-runtime-monitoring/01 — JVM 的后台线程做什么?— ServiceThread](openjdk/vol-02/39-runtime-monitoring/01-service-thread.md):GC 结束后的 JMX 通知由 ServiceThread 消费,本篇的 GCMemoryManager 是它的数据上游;[39-runtime-monitoring/02 — Timer + Monitoring Services — 高精度计时 + JMX 统计](openjdk/vol-02/39-runtime-monitoring/02-timer-stats.md):jstat 读 PerfData 是另一条读口,本篇的 JMX 查询与它对照
> → **后续**:[33-jmx/02 — JDK 怎么查询 JVM 内存状态?— JMM 接口 + JDK Management](02-jmm-interface.md)
> 关联域: 25-gc-framework(GC 内部统计)、27-jni(JavaCalls 调 Java 侧构造)、30-jvm-entry(JavaCalls)

## JConsole 的 Heap 曲线,数据在哪

[JMX 实证](planning/outlines/00-jvm-tools/materials/commands/33-jmx-pool-demo.txt)用 `ManagementFactory.getMemoryPoolMXBeans()` 列一遍:

```
== memory pools: 8
  CodeHeap 'non-nmethods'     heap=Non-heap memory ... mgrs=[CodeCacheManager]
  Metaspace                   heap=Non-heap memory ... max=undefined | mgrs=[Metaspace Manager]
  CodeHeap 'profiled nmethods' ... mgrs=[CodeCacheManager]
  Compressed Class Space      ... mgrs=[Metaspace Manager]
  G1 Eden Space               heap=Heap memory init=52428800 used=2097152 ... max=undefined
  G1 Old Gen                  heap=Heap memory init=947912704 used=0 committed=947912704 max=16001269760
  G1 Survivor Space           heap=Heap memory ... max=undefined
  CodeHeap 'non-profiled nmethods' ... mgrs=[CodeCacheManager]
== memory managers: 4
  CodeCacheManager      pools=[CodeHeap 'non-nmethods',CodeHeap 'profiled nmethods',CodeHeap 'non-profiled nmethods']
  Metaspace Manager     pools=[Metaspace,Compressed Class Space]
  G1 Young Generation   pools=[G1 Eden Space,G1 Survivor Space,G1 Old Gen]
  G1 Old Generation     pools=[G1 Eden Space,G1 Survivor Space,G1 Old Gen]
```

JConsole 的曲线就是反复调用这些 Bean 的 `getUsage()`。三个值得先记住的事实(后面逐个拆): ①池有 **8 个**不是"约 10 个";②**G1 的两个 GC Manager 都管理全部 3 个堆池**——不是"Young 管 Eden+Survivor、Old 管 Old"的分工;③分配 180MB + `System.gc()` 之后,`G1 Old Gen` 的 `used` 与 **collectionUsage** 一起变成 2853496(≈2.7MB)、`G1 Eden Space` 的 used 归零——**GC 结束的瞬间,池的数据被刷新**。这篇拆三层: 池是谁、谁记账、账本怎么在 GC 前后翻转。

## 1. MemoryPool: 池是"活的视图",不是缓存

`class MemoryPool`(memoryPool.hpp:45-140)描述一个受管内存区域,类头注释: "A memory pool represents the memory area that the VM manages...A memory pool can belong to the heap or the non-heap memory"。成员拆两类——**身份与台账**:

```cpp
// memoryPool.hpp:60-76(截取核心,逐字)
  const char*      _name;
  PoolType         _type;
  size_t           _initial_size;
  size_t           _max_size;
  bool             _available_for_allocation; // Default is true
  MemoryManager*   _managers[max_num_managers];
  int              _num_managers;
  MemoryUsage      _peak_usage;               // Peak memory usage
  MemoryUsage      _after_gc_usage;           // After GC memory usage
```

`_peak_usage` 与 `_after_gc_usage` 是**记账缓存**(记录峰值与"最近一次 GC 后"的快照);而当前使用量**不缓存**——`virtual MemoryUsage get_memory_usage() = 0;`(:133)是纯虚函数,每次查询**现算**。这是全篇最核心的设计: *池不是统计快照的容器,而是"区域统计的活视图"*——GC 内部数字变,池的读数就变。

**池的类层次**(memoryPool.hpp:142-171)只有四个子类:

- `CollectedMemoryPool`(:142)——"被 GC 回收"的堆池;`is_collected_pool()` 为 true 才支持 `getCollectionUsage()`(实证里 Metaspace/CodeHeap 的 collectionUsage 是 n/a 就是这个原因);
- `CodeHeapPool`(:149)——包一个 CodeHeap(16 域的代码缓存),`used_in_bytes()` 直接读 `_codeHeap->allocated_capacity()`;
- `MetaspacePool`(:158)与 `CompressedKlassSpacePool`(:166)——元空间与压缩类指针空间,used/committed 从 `MetaspaceUtils` 现算(memoryPool.cpp:196-219),max 看是否设了 `MaxMetaspaceSize`(:205-208,未设则 undefined)。

那 G1 的 Eden/Survivor/Old 池呢?——**它们不在 services/ 目录,而是 G1 自己定义的**(gc/g1/g1MemoryPool.cpp)。`G1EdenPool`/`G1SurvivorPool`/`G1OldGenPool`(:42-88)都继承 `G1MemoryPoolSuper`→`CollectedMemoryPool`:

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

`used_in_bytes()` 是 `_g1mm->eden_space_used()`(g1MemoryPool.hpp:72-73)——数据源是 `G1MonitoringSupport`(g1MonitoringSupport.cpp:182-206 `recalculate_sizes`): **young 区已提交的 region 数量 × region 大小**(`_eden_used = eden_list_length * HeapRegion::GrainBytes` :199),Old 的 used 是"堆总用量减去 young"(`subtract_up_to_zero(_overall_used, _eden_used + _survivor_used)` :202)。注意 max: G1EdenPool/G1SurvivorPool 传 `_undefined_max`、G1OldGenPool 传 `g1h->g1mm()->old_gen_max()`(=整体保留容量)——所以实证里 Eden max=undefined、Old max=16001269760(≈14.9GB=MaxHeapSize)。

**池是谁建的?**——GC 堆。`G1CollectedHeap` 构造时 `_eden_pool = new G1EdenPool(this)` 等三个(g1CollectedHeap.cpp:1738-1740);`MemoryService` 只负责**注册**(把池收进自己的列表)。注册发生在启动早期(universe_post_init 里,universe.cpp:1002/:1105-1107;该函数在 init_globals 中调用,init.cpp:141): `MemoryService::add_metaspace_memory_pools()`(Metaspace Manager + Metaspace 池 + Compressed Class Space 池)+ `set_universe_heap(Universe::heap())`——后者调 `heap->memory_pools()` 取 G1 的三个池收进 `_pools_list`(memoryService.cpp:71-92)。CodeCache 的三个池是 CodeCache 初始化每个 CodeHeap 时注册的(`add_code_heap_memory_pool`,codeCache.cpp:423;JDK11 把 CodeCache 分成 non-nmethods/profiled/non-profiled 三段,所以 CodeCache 是 **3 个池**,大纲假设的"1 个 CodeCache 池、共约 10 个池"与实测(8 个)不符)。

## 2. MemoryUsage: 四元组与 undefined 的语义

每个池的 `get_memory_usage()` 返回一个 `MemoryUsage`(memoryUsage.hpp:47-84)——四个 `size_t`:

```cpp
// memoryUsage.hpp:30-45(截取核心,逐字)
//  initSize - represents the initial amount of memory (in bytes) that
//     the Java virtual machine requests from the operating system
//     for memory management.  The Java virtual machine may request
//     additional memory from the operating system later when appropriate.
//     Its value may be undefined.
//  used      - represents the amount of memory currently used (in bytes).
//  committed - represents the amount of memory (in bytes) that is
//     guaranteed to be available for use by the Java virtual machine.
...
//  maxSize   - represents the maximum amount of memory (in bytes)
//     that can be used for memory management. The maximum amount of
//     memory for memory management could be less than the amount of
//     committed memory.  Its value may be undefined.
```

四个字段的语义: `init`=JVM 启动时向 OS 请求的量;`used`=当前用掉;`committed`=**保证可用**(=已提交,≥init);`max`=理论上限。"未定义"是**一等公民**: `static size_t undefined_size() { return (size_t) -1; }`(:66)——size_t 全 1 即 -1。实证对照: G1 Old Gen `init=947912704`(≈904MB)=启动时堆提交;`Metaspace max=undefined`(没设 MaxMetaspaceSize);`CodeHeap 'non-nmethods' max=8183808`=该段 CodeHeap 的 max_capacity。

四元组跨 JNI 边界转 jlong 时有个 64 位陷阱: `convert_to_jlong`(:68-78)把 undefined 映射为 **-1L**,并 `MIN2(val, max_jlong)` 截断——头注释 "In the 64-bit vm, a size_t can overflow a jlong (which is signed)"。*设计要点: max=undefined 不是错误状态,而是"这个区域没有硬上限"的显式表达*——Java 侧的 `MemoryUsage.getMax()` 返回 -1;它还与"阈值支持"呼应: G1 的 Eden/Survivor 池构造时 `support_usage_threshold=false`(g1MemoryPool.cpp:47),阈值参数在创建 Java 镜像时以 -1 传入(表示不支持,memoryPool.cpp:87-88)。

## 3. MemoryManager: 记账人

池描述"哪块内存",`MemoryManager` 描述"谁管理它"。`class MemoryManager`(memoryManager.hpp:47-86)只有名字加一个池数组(`_pools[max_num_pools=10]`);真正的记账能力在子类 `GCMemoryManager`(:136-183):

```cpp
// memoryManager.hpp:138-147(截取核心,逐字)
  // TODO: We should unify the GCCounter and GCMemoryManager statistic
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

它记四类账: 收集次数(`_num_collections`)、累计 GC 时间(`_accumulated_timer`,39-02 的 elapsedTimer 家族)、**最近一次 GC 的完整账本**(`_last_gc_stat`/`_current_gc_stat`,下节拆)、GC 结束通知开关(`_notification_enabled`,03 篇的 GC 通知由它门控)。

**实例就 4 个**(实证): G1 两个 + Metaspace Manager + CodeCacheManager。后两个是**非 GC 的 MemoryManager**(`is_gc_memory_manager()` 返回 false)——`MemoryManager::get_metaspace_memory_manager()`(:61-63,名字就叫 "Metaspace Manager")和 `get_code_cache_memory_manager()`(:57-59,名字 "CodeCacheManager")在注册池时顺手创建(memoryService.cpp:102-108 首次注册 CodeHeap 池时建 CodeCacheManager,以后三个池共享一个)。它们不上 GC 的账: gc_count/gc_time 这类方法只属于 GCMemoryManager。

**G1 的两个 GC Manager 不是按"区域"分工,而是按"GC 类型"分工**: `_memory_manager("G1 Young Generation", "end of minor GC")` 与 `_full_gc_memory_manager("G1 Old Generation", "end of major GC")`(g1CollectedHeap.cpp:1424-1425)——年轻代 GC(Evacuation Pause)的 `TraceMemoryManagerStats tms(&_memory_manager, gc_cause(), ...)`(:2881)记到 Young;Full GC 则经 `G1FullCollector(this, &_full_gc_memory_manager, ...)`(:1136)+ `G1FullGCScope` 里的 `TraceMemoryManagerStats _memory_stats`(g1FullGCScope.hpp:55)记到 Old。两个 manager 都 `add_pool` 了全部 3 个堆池(:1742-1748)——区别在第三个参数 `always_affected_by_gc`: Old 池对 Young GC 是 false(memoryManager.hpp:156-159 的表在 gc_end 里决定要不要刷新 Old 池的 collection usage)。

**双向关联**: `add_pool` 时 manager 记池(`_pools[_num_pools++]`),同时 `pool->add_manager(this)`(memoryManager.cpp:46-55)——所以 JMX 侧既问"这个池归谁管"也问"这个 manager 管哪些池",都是 O(1) 查数组。*管理对象本身也是堆对象*,`_memory_pool_obj`/`_memory_mgr_obj` 是 volatile instanceOop,由 GC 扫描保活(`MemoryService::oops_do` memoryService.cpp:193-204)——下面会看到它们的 Java 镜像怎么创建。

## 4. GC 的账本: gc_begin/gc_end 与双缓冲

GC 两侧的打点由一个 RAII 对象完成——`TraceMemoryManagerStats`(memoryService.hpp:117-154): 构造调 `MemoryService::gc_begin`,析构调 `MemoryService::gc_end`(memoryService.cpp:250-296)。G1 年轻代 GC 里它在 `gc_prologue` 前创建(注释 :3097-3098 "as an active TraceMemoryManagerStats object...so that the G1 memory pools are updated before any GC notifications are raised")。

`GCMemoryManager::gc_begin`(memoryManager.cpp:211-236)做三件事: 累计计时器 start;`_current_gc_stat` 记 index(=_num_collections+1)与开始时间戳;**快照所有池的 GC 前 usage**(`set_before_gc_usage(i, usage)`,顺带发 dtrace 探针)。`gc_end`(:241-298)对称: 停止计时、记结束时间、快照 GC 后 usage、对受影响的池 `set_last_collection_usage` + 触发低内存检测(`LowMemoryDetector::detect_after_gc_memory`,03 篇拆)、`_num_collections++`。

**账本载体 GCStatInfo**(memoryManager.hpp:88-134)是"一次 GC 的全部内存账": 索引、起止时间、以及**每个池的 before/after usage 两个数组**(`_before_gc_usage_array`/`_after_gc_usage_array`,按 MemoryService 的池列表顺序)。双缓冲交换在 gc_end 的 countCollection 分支:

```cpp
// memoryManager.cpp:285-292(截取核心,逐字)
    {
      MutexLockerEx ml(_last_gc_lock, Mutex::_no_safepoint_check_flag);
      GCStatInfo *tmp = _last_gc_stat;
      _last_gc_stat = _current_gc_stat;
      _current_gc_stat = tmp;
      // reset the current stat for diagnosability purposes
      _current_gc_stat->clear();
    }
```

*关键设计: "最近一次完成的 GC"必须原子发布*——GC 是 VM 线程上的串行事件,但 JMX 查询线程随时在读 `_last_gc_stat`(读端 `get_last_gc_stat` :300-312 也持同一把 `_last_gc_lock`);双缓冲让"发布"只是一个指针交换,读者永远看到完整的账本。GC 还没结束时 `get_last_gc_stat` 返回 0(`gc_index()==0` 表示还没有完成过 GC,注释 :177-178 "Zero signifies no gc has taken place")。

**更新的顺序是这篇最重要的时序**: G1 年轻代 GC 结束处(g1CollectedHeap.cpp:3096-3100)——

```cpp
// g1CollectedHeap.cpp:3096-3100(截取核心,逐字)
    // We must call G1MonitoringSupport::update_sizes() in the same scoping level
    // as an active TraceMemoryManagerStats object (i.e. before the destructor for the
    // TraceMemoryManagerStats is called) so that the G1 memory pools are updated
    // before any GC notifications are raised.
    g1mm()->update_sizes();
```

`update_sizes()`(重算 eden/survivor/old 的 region 计数,即 recalculate_sizes)必须发生在 `TraceMemoryManagerStats` 析构(**即 gc_end,即 after usage 快照**)之前——否则 gc_end 读到的 `get_memory_usage()` 还是 GC 前的旧值。池的"活视图"设计在这里兑现: *数据源(G1 内部统计)先更新,记账(池的 usage)后读取,顺序保证账本一致性*。GC 收尾再补一刀: `gc_epilogue` 里 `MemoryService::track_memory_usage()`(g1CollectedHeap.cpp:2495)= 遍历所有池 `record_peak_memory_usage()`(memoryPool.cpp:144-153,取 max 记峰值)+ `LowMemoryDetector::detect_low_memory()`(03 篇的阈值检测入口)。非堆池的峰值是各自更新的: Metaspace 每次分配/释放经 `track_metaspace_memory_usage`(metaspace/spaceManager.cpp:164-169),CodeCache 在 blob 分配/释放后(memoryService.hpp:85-90 + codeBlob.cpp 各处)。

## 5. 查询链路: JMX 请求怎么落到池上

JConsole 调 `MemoryPoolMXBean.getUsage()` → Java 侧 `MemoryPoolImpl.getUsage0()`(native,MemoryPoolImpl.c:44)→ 通过 **JMM 函数表** `jmm_interface->GetMemoryPoolUsage(env, pool)`(02 篇拆 JMM 全貌)→ 对应 `jmm_GetMemoryPoolUsage`(management.cpp:557-567):

```cpp
// management.cpp:557-567(截取核心,逐字)
JVM_ENTRY(jobject, jmm_GetMemoryPoolUsage(JNIEnv* env, jobject obj))
  ResourceMark rm(THREAD);

  MemoryPool* pool = get_memory_pool_from_jobject(obj, CHECK_NULL);
  if (pool != NULL) {
    MemoryUsage usage = pool->get_memory_usage();
    Handle h = MemoryService::create_MemoryUsage_obj(usage, CHECK_NULL);
    return JNIHandles::make_local(env, h());
```

两件值得注意的事。**第一,池的 Java 镜像(pool 参数)是懒创建的**: 第一次被 JMX 枚举/查询(jmm_GetMemoryPools 或本函数)时才调 `get_memory_pool_instance`(memoryPool.cpp:77-138)——经 `JavaCalls::call_static` 调 `sun.management.ManagementFactoryHelper.createMemoryPool(name, isHeap, usageThreshold, gcThreshold)`(ManagementFactoryHelper.java:571-574,`new MemoryPoolImpl(...)`)。懒创建+双检锁(`_memory_pool_obj` 判空→建→`OrderAccess::release_store` 发布,:80-134): *启动时零开销,只在第一次被 JMX 触碰时建堆对象*;并发时多余的实例直接 GC 掉(注释 "Extra pool instances will just be gc'ed")。**第二,`create_MemoryUsage_obj`(memoryService.cpp:234-248)用 JavaCalls 构造 `java.lang.management.MemoryUsage`**——四个 jlong 参数,签名 `long_long_long_long_void_signature`——即"每个池的 usage 对象都是新构造的,查询时现算现装"。

`MemoryMXBean.getHeapMemoryUsage()`(JConsole 顶部那条曲线)则是**汇总**: `jmm_GetMemoryUsage`(management.cpp:706-754)遍历所有 heap 池把 used/committed 求和,`init=InitialHeapSize`、`max=Universe::heap()->max_capacity()`,任一池 undefined 则整体 -1。所以 Heap 曲线 = 三个 G1 池之和,曲线上的"锯齿"(每次 GC 后回落)正是 §4 的时序保证的数据。

与 39-02 的 jstat 对照: jstat 直接读 hsperf 文件的 PerfData 计数器(GC 计数/区域容量,是"推"的数据);**JMX 这条是"拉"的**——查询时从 GC 内部统计现算。两条读口各自独立记录在本篇素材里(33-jmx-jstat-gc.txt 与 33-jmx-pool-demo.txt),底层同源: region 计数与 GC 计数。

## 核心悬念

MemoryService 拆完: 池是"活的视图"(`get_memory_usage()` 每次现算),8 个池由 GC 自己创建、MemoryService 只注册;MemoryUsage 四元组用 undefined(-1)表达"无上限";GCMemoryManager 按 GC 类型分工(G1 Young/Old 都管全部 3 个堆池),`TraceMemoryManagerStats` RAII 在 GC 两侧记 before/after 账本,双缓冲原子发布"最近一次 GC";**更新顺序(先 update_sizes 后 gc_end)保证账本与内部统计一致**;JMX 查询经 JMM 函数表落到池上,Java 镜像懒创建。但查询链路只露了一角: 那条 `jmm_interface->GetMemoryPoolUsage` 函数表是怎么来的?JVM 怎么把 C 函数数组交给 JDK 的 libmanagement?池上的 usageThreshold 阈值、"内存快满"通知又怎么触发?下一篇: JMM 接口与 JDK Management。

> → [33-jmx/02 — JDK 怎么查询 JVM 内存状态?— JMM 接口 + JDK Management](02-jmm-interface.md)
