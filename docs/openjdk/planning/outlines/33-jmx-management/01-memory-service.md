# 01. JConsole 怎么知道 Eden 用了多少？— MemoryService + MemoryPool

> 🔴 Deep | 1 KP 中的内存管理
> 读者处境: JConsole 显示 heap curve——Eden 当前 200MB、Survivor 10MB、Old 300MB。这些数据来自 MemoryService——每次 GC 后更新。

> ⚠️ 写作期修正(2026-08-16,33-jmx/01 完成):
> - **池数 "~10 个" 错**: 实证(G1+jdk11)只有 **8 个 pool**——G1 Eden/Survivor/Old Gen(3)+ Metaspace + Compressed Class Space(2)+ **CodeCache 3 段**(non-nmethods/profiled nmethods/non-profiled nmethods,JDK11 分段 code cache,不是 1 个 CodeCache 池)
> - **"MemoryService 创建所有 MemoryPool" 错**: 池是 **GC 自己创建的**(G1CollectedHeap 构造 :1738-1740 new G1EdenPool 等,g1MemoryPool.cpp:42-88),MemoryService 只**注册**(set_universe_heap memoryService.cpp:71-92,universe.cpp:1105-1107 genesis 里);Metaspace/Compressed Class 由 add_metaspace_memory_pools(universe.cpp:1105),CodeHeap×3 由 add_code_heap_memory_pool(codeCache.cpp:423)
> - **"MemoryPool 追踪 usage/peak/collection" 半对**: 当前 usage **不缓存**——`get_memory_usage()` 是纯虚每次现算(memoryPool.hpp:133);`_peak_usage`/`_after_gc_usage` 才是缓存(:67-68);数据源=G1MonitoringSupport(g1MonitoringSupport.cpp:190-206 recalculate_sizes,eden_used=region 数×GrainBytes :199,old=总用量减 young :202)
> - **MemoryUsage 四元组 undefined 语义**: undefined_size()=(size_t)-1(memoryUsage.hpp:66);跨 JNI 转 jlong 有溢出保护 convert_to_jlong(:68-78);G1 Eden max=undefined、Old max=old_gen_max()=整体保留(实证 16001269760≈14.9GB=MaxHeapSize)
> - **"MemoryManager——G1 Young 管 Eden+Survivor、Old 管 Old" 错**: G1 的两个 GC manager **都管理全部 3 个堆池**(g1CollectedHeap.cpp:1742-1748),按 **GC 类型**分工——young GC 记 _memory_manager("G1 Young Generation",:2881)、full GC 记 _full_gc_memory_manager("G1 Old Generation",:1136+G1FullGCScope.hpp:55);区别=always_affected_by_gc(Old 池对 young GC false,:1748);"ZGC 可能只有一个"无源码(jdk11u 树 G1-only)
> - **实例共 4 个**(实证): G1 Young/G1 Old/Metaspace Manager/CodeCacheManager(后两个是非 GC MemoryManager,get_metaspace_memory_manager :61/get_code_cache_memory_manager :57)
> - **"gc_begin/gc_end 由 safepoint 间调用" 半对**: 真实=RAII `TraceMemoryManagerStats`(memoryService.hpp:117-154): 构造 gc_begin(记 index/start_time/before usage 快照,memoryManager.cpp:211-236)、析构 gc_end(after 快照+set_last_collection_usage+countCollection+**双缓冲交换** _last_gc_stat/_current_gc_stat :284-292);GCStatInfo=每个池 before/after 两个 usage 数组(memoryManager.hpp:88-134)
> - **时序关键(最重要)**: G1 的 g1mm()->update_sizes() 必须在 TraceMemoryManagerStats 析构前(g1CollectedHeap.cpp:3096-3100 注释)——否则 gc_end 快照到 GC 前旧值;gc_epilogue 再 track_memory_usage()(:2495)=peak 更新+LowMemoryDetector
> - **查询链路**: getUsage0 native(MemoryPoolImpl.c:44)→jmm_interface->GetMemoryPoolUsage→jmm_GetMemoryPoolUsage(management.cpp:557-567)→get_memory_usage()+create_MemoryUsage_obj(JavaCalls 构造,memoryService.cpp:234-248);池 Java 镜像懒创建+双检锁(get_memory_pool_instance memoryPool.cpp:77-138→ManagementFactoryHelper.createMemoryPool ManagementFactoryHelper.java:571-574);汇总 jmm_GetMemoryUsage(:706-754)init=InitialHeapSize/max=heap max_capacity
> - 素材: 33-jmx-pool-demo.txt(8 pool/4 manager/GC 前后对照)/33-jmx-jstat-gc.txt+33-jmx-jstat-gccapacity.txt(jstat 对照)

### 1. "MemoryPool — ~10 个池" ⚠️ 实测 8 个;池由 GC 创建,MemoryService 只注册

场景: JVM 启动后 GC 堆创建自己的 MemoryPool→MemoryService 注册进列表→每个 pool 追踪 usage/peak/collection。

**MemoryPool 类层次** (`memoryPool.hpp:45-171`):
```
MemoryPool(基类,memoryPool.hpp:45)——纯虚 get_memory_usage()=每次现算(:133);_peak_usage/_after_gc_usage 缓存(:67-68)
├── CollectedMemoryPool(:142)   — 堆池,is_collected_pool() 才支持 collectionUsage
├── CodeHeapPool(:149)          — 包 CodeHeap,used=allocated_capacity()(:155)
├── MetaspacePool(:158)         — MetaspaceUtils 现算,未设 MaxMetaspaceSize 则 max=undefined
└── CompressedKlassSpacePool(:166)
G1 的池不在 services/: G1EdenPool/G1SurvivorPool/G1OldGenPool(g1MemoryPool.cpp:42-88,used=region 数×GrainBytes)
```
- 源码: `memoryPool.hpp:45-171` + `g1MemoryPool.cpp:42-88` + `memoryService.cpp:71-125`(注册)
- 关键设计: 池是"区域统计的活视图"——当前 usage 不缓存,GC 内部数字变读数就变;G1 池在 G1CollectedHeap 构造时创建(g1CollectedHeap.cpp:1738-1740),注册在 genesis(universe.cpp:1105-1107)
- [C++: `MemoryPool::record_peak_memory_usage()`(memoryPool.cpp:144-153)取 max 记峰值;`_after_gc_usage` 由 gc_end 里 `set_last_collection_usage()` 刷新;Metaspace/CodeCache 峰值各自 track(spaceManager.cpp:164-169/memoryService.hpp:85-90)]

### 2. "MemoryManager — G1/ZGC/Parallel 各一个" ⚠️ 按 GC 类型分工,不分区域

**MemoryManager** (`memoryManager.hpp:47-86` + GCMemoryManager :136-183):
```
MemoryManager(基类): 名字+池数组(max_num_pools=10);非 GC 实例=Metaspace Manager/CodeCacheManager(:57-63)
GCMemoryManager: _num_collections/_accumulated_timer/GCStatInfo 双缓冲/_notification_enabled
实例 4 个(实证): G1 Young Generation / G1 Old Generation / Metaspace Manager / CodeCacheManager
```
- 源码: `memoryManager.hpp:47-183` + `g1CollectedHeap.cpp:1424-1425/:1742-1748` + `memoryService.cpp:102-108`
- 关键设计: G1 两个 GC manager 都管理全部 3 个堆池,young GC 记 Young、full GC 记 Old(g1CollectedHeap.cpp:2881/:1136);gc_begin/gc_end 由 TraceMemoryManagerStats RAII 驱动(memoryService.cpp:250-296)——记录 GC 时间、收集次数、各 pool before/after usage
- [C++: 双缓冲 GCStatInfo 交换(gc_end :284-292)原子发布"最近一次 GC",读端 get_last_gc_stat(:300-312)同锁;低内存检测入口 detect_after_gc_memory 在 gc_end(:274-278)]

---

### 核心悬念

**"MemoryService 是注册表——8 个池由 GC 创建;GCMemoryManager 按 GC 类型记账,双缓冲发布;JMX 经 JMM 函数表查询(jmm_GetMemoryPoolUsage),池 Java 镜像懒创建。"** — 下一篇: JMM 接口。

> → [02-jmm-interface.md](02-jmm-interface.md)
