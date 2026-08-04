# 会话交接文档

## 当前进度

正在逐行讲解 `G1CollectedHeap::initialize()`（`g1CollectedHeap.cpp:1533-1735`）。

### 已完成的章节

| 章节 | 内容 | 行数 |
|------|------|------|
| 01 | initialize_heap 五阶段全景 | ~500 |
| 02 | G1CollectorPolicy 构造（Region 大小 + RSet 容量） | ~300 |
| 03 | ReservedSpace mmap | ~150 |
| 04 | create_heap — G1Policy 构造（Analytics/MMU/IHOP） | ~400 |
| **04a** | **G1CollectedHeap 构造函数（每字段详解）** | **~770** |
| 05 | initialize() 上半段——CardTable + 写屏障 + 6 Mapper + HRM | ~900 |
| 06 | RemSet + BOT + CSet 快速测试 + Humongous 回收 | ~950 |
| **07** | **G1ConcurrentMark 构造函数（位图/CMThread/CMTask/MarkStack）** | **~1289** |
| 08 | expand——commit 物理内存 + 创建 HeapRegion + 入空闲列表 | ~296 |
| **09** | **g1_policy()->init()——绑定 _g1h + 首次算 young_list_target_length** | **~185** |

### 待写的章节

| 计划 | 内容 | 行数（预估） |
|------|------|------------|
| 10 | 队列系统初始化：SATB + DCQ × 2 + ConcurrentRefinement + YoungGenSampling | ~400 |
| 11 | Dummy Region + G1AllocRegion::setup + init_mutator_alloc_region + MonitoringSupport + 收尾 | ~400 |

**10 如何开始**：
1. 先读源码 `/data/workspace/jdk11u/src/hotspot/share/gc/g1/g1CollectedHeap.cpp:1679-1707`
2. 用 Agent 工具深度探索 5 个初始化方法各自做了什么
3. 参照标杆文章 `07-g1-concurrent-mark-creation.md` 的结构和深度撰写
4. 文件名 `10-queue-system-init.md`，前置依赖标注 `[ch09/09](09-g1-policy-init.md)`

**11 如何开始**：
1. 源码区间 `g1CollectedHeap.cpp:1709-1734`——Dummy Region 创建、G1AllocRegion::setup、init_mutator_alloc_region、G1MonitoringSupport、G1StringDedup、preserved_marks_set.init、CSet.initialize
2. G1AllocRegion 的内部结构在 04a §4.1 已详细讲过——11 重点在 setup + init 流程，不需要再展开 AllocRegion 本身
3. 文件名 `11-allocator-ready-and-cleanup.md`，前置依赖标注 `[ch09/10](10-queue-system-init.md)`

## 写作标准

两篇标杆文章：**07**（1289 行）和 **04a**（770 行）。标准：

1. **依赖驱动排序**——A 依赖 B 就先写 B，禁止前向引用
2. **从问题出发**——先说"为什么需要"，再说"源码怎么实现"
3. **源码 + 解释**——贴关键代码片段 + 逐行注释，不贴模板代码和死代码
4. **构造/运行时分离**——本文是构造时创建了什么，运行时行为点到为止
5. **每句陈述有源码行号**——用户问"确定吗"立刻查源码核实
6. **讲不通就删除**——不要硬塞没建立依赖的内容

## 关键约定

- 生产环境 `-Xms = -Xmx`，堆不动态扩缩
- 默认 `_adaptive_size = true`，不手动设 NewSize/MaxNewSize
- 默认 `AlwaysPreTouch = false`
- 代码中不展示断言和不会执行的错误分支
- 标签"阅读提示"用于"首次可跳过"的复杂细节

## 已完成的重构

- 04a 从 318→770 行，经历了从"初始化列表 vs 构造体"到"逻辑分组"的彻底重排。`bot_updates = false` 的原因经过反复核实——最终确认是因为 Young Region 全量扫描不需要 BOT，和 bitmap/并发标记无关
- 07 反复修了标记周期 7 步、SATB、STS 机制、dual-bitmap 等多个难点
- 08 展开了 HRM 内部两层 commit 追踪、`_bot_part` 初始化、BOT 指数编码
- 09 虽然短但细节多——`_young_list_target_length` 和 `_young_list_max_length` 的计算被 debug 实测验证（8GB 堆：target=102, max=108），G1YoungGenSizer 默认分支（SizerDefaults）需要仔细核实（初始 min/max 为 0，百分比计算在 `adjust_max_new_size` 中首次执行）

## 写作指南

见 `/data/workspace/LoveEleve.github.io/docs/openjdk/WRITING-GUIDELINES.md`。

## 下一步

写 **10**——队列系统初始化，覆盖 `g1CollectedHeap.cpp:1679-1707`：

- SATBMarkQueueSet::initialize()
- initialize_concurrent_refinement()
- initialize_young_gen_sampling_thread()
- G1BarrierSet::dirty_card_queue_set().initialize()
- G1CollectedHeap::dirty_card_queue_set().initialize()

**如何开始**：
1. 先读源码 `/data/workspace/jdk11u/src/hotspot/share/gc/g1/g1CollectedHeap.cpp:1679-1707`
2. 用 Agent 工具深度探索 5 个初始化方法各自做了什么
3. 参照标杆文章 `/data/workspace/LoveEleve.github.io/docs/openjdk/vol-01/ch09/07-g1-concurrent-mark-creation.md` 的结构和深度撰写
4. 文件命名 `10-queue-system-init.md`，放在 `/data/workspace/LoveEleve.github.io/docs/openjdk/vol-01/ch09/` 目录
5. 前置依赖标注 `[ch09/09](09-g1-policy-init.md)`
