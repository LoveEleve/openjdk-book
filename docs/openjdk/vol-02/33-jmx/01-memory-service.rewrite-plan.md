# 33-jmx/01-memory-service 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JConsole/JMX 的 MemoryPool 与 MemoryManager 数据从哪里来、G1 为什么有两个 GC manager、GC 前后 usage 如何被准确发布到 JMX

## 1. 选题判断

现稿已有很强事实基础：
- `MemoryPool` 活视图与 `get_memory_usage`
- G1 Eden/Survivor/Old 三个池
- `MemoryService` 注册池和 manager
- GCMemoryManager 的 before/after 账本与双缓冲
- `management.cpp` JMX 查询入口

真正该打穿的困惑是：

**JConsole 的内存曲线到底读的是什么？MemoryPool 是实时计算还是缓存？为什么 G1 的 Young/Old 两个 manager 都挂全部三个堆池？一次 GC 结束后，JMX 为什么能同时拿到当前 usage 与 collectionUsage，而且不读到半截账本？**

## 2. 一句话顿悟

**MemoryPool 描述“哪块内存”，MemoryManager 描述“哪类操作管理它”，两者不是一对一关系。G1 的三个堆池由 G1 自己创建，MemoryService 只注册；两个 GCMemoryManager 按 GC 类型记账，却都关联全部堆池。当前 usage 每次从 G1MonitoringSupport 现算，GC 前后 usage 则由 TraceMemoryManagerStats 写进 GCStatInfo，gc_end 用锁保护的双缓冲交换发布完整账本。**

## 3. 总图

```text
G1CollectedHeap
  ├─ G1EdenPool
  ├─ G1SurvivorPool
  └─ G1OldGenPool
        ↓ MemoryService 注册
JMX / MemoryPoolMXBean.getUsage()
  management.cpp:jmm_GetMemoryPoolUsage
    └─ pool->get_memory_usage()
         └─ G1MonitoringSupport 现算

GC 生命周期
  TraceMemoryManagerStats 构造
    └─ gc_begin: before_gc_usage
  G1MonitoringSupport::update_sizes
  TraceMemoryManagerStats 析构
    └─ gc_end: after_gc_usage + last_collection_usage
                双缓冲交换 _last_gc_stat
```

## 4. 结构大纲

### 第一节：开场困惑——JConsole 曲线数据在哪

- 8 个池的组成
- G1 三个堆池 + CodeHeap 三个池 + Metaspace 两个池
- MemoryPool 与 MemoryManager 的关系不是一对一

### 第二节：两个朴素方案为什么都不对

1. 把 MemoryPool 当静态缓存
2. 把一个 GC manager 绑定一个区域

结论：Pool 是实时视图，Manager 按 GC 类型记账并可关联多个池。

### 第三节：MemoryPool——活视图与 G1 三个池

- `MemoryPool` 基类成员与纯虚 `get_memory_usage`
- G1 Eden/Survivor/Old pool
- `G1MonitoringSupport` 的 used/committed 来源
- MemoryService 只注册，池由 G1 创建

### 第四节：MemoryUsage——四元组与 undefined

- init/used/committed/max
- `(size_t)-1` 到 Java `-1`
- Eden/Survivor 不支持 usage threshold 的边界

### 第五节：MemoryManager——两个 G1 manager 为什么都管三池

- `GCMemoryManager` 统计字段
- Young/Old manager 的 GC 类型分工
- `add_pool(pool, always_affected_by_gc)` 的影响池标记
- 双向关联 Pool ↔ Manager

### 第六节：GC 账本与 JMX 查询

- `TraceMemoryManagerStats` RAII
- gc_begin/gc_end before/after usage
- GCStatInfo 双缓冲原子发布
- `management.cpp` 查询、懒创建 Java mirror、`MemoryUsage` JavaCalls 构造
- heap usage 汇总逻辑

### 第七节：误解澄清与收网

## 5. 失败方案

1. MemoryPool 启动时计算一次后永久缓存
2. Young manager 只管理 Eden/Survivor，Old manager 只管理 Old

## 6. 证据清单

- `src/hotspot/share/services/memoryPool.hpp:45-140`
- `src/hotspot/share/gc/g1/g1MemoryPool.cpp:42-88`
- `src/hotspot/share/services/memoryManager.hpp:47-183`
- `src/hotspot/share/services/memoryManager.cpp:211-313`
- `src/hotspot/share/services/memoryService.cpp:71-125`
- `src/hotspot/share/services/memoryService.cpp:147-191`
- `src/hotspot/share/services/memoryService.cpp:234-248`
- `src/hotspot/share/services/management.cpp:557-598`
- `src/hotspot/share/services/management.cpp:706-756`
- `src/hotspot/share/gc/g1/g1MonitoringSupport.cpp:182-206`
- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp:3096-3100`

## 8. 完成后 review

- 删除代码后，能否复述 Pool 是活视图、Manager 按 GC 类型记账
- 是否讲清 G1 两个 manager 都挂三池
- 是否讲清 update_sizes 必须先于 gc_end
- 是否讲清双缓冲发布和 JMX 查询链路
- 是否完成删码、禁用词、链接、`file:line`、`git diff --check` 校验