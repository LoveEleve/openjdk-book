# 01. 每次 malloc 怎么被追踪到 call-site？— NMT 追踪系统

> 🔴 Deep | 1 KP 中的全栈追踪
> 读者处境: `jcmd <pid> VM.native_memory summary` — 输出按 ~30 MEMFLAGS 分类的 native 内存使用。每次 `os::malloc`/`mmap` 都会被追踪——通过嵌入 MallocHeader 在分配内存前。

> ⚠️ 写作期修正(2026-08-14, vol-02/34-nmt/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"MallocHeader {_size,_flags,_unused,_stack}" 错(重要)**: 真实=**位域打包的两个机器字**(mallocTracker.hpp:246-262,LP64 16 字节): `_size:64/_flags:8/_pos_idx:16/_bucket_idx:40`——**不存调用栈指针,只存 call-site 表索引**(detail 级别才写);minimal 级别构造直接 return,header 纯占位(连 size 都不写),release 在 `<= NMT_minimal` 时直接跳过(mallocTracker.cpp:68-70)
> - **"MallocHeader mallocTracker.hpp:40-120" 行号错**: MemoryCounter 在 :41-86,MemoryCounter/MallocMemory/MallocMemorySummary :93-237,MallocHeader 在 :246-302,MallocTracker :306-374
> - **"~30 MEMFLAGS" 错**: `enum MemoryType`(allocation.hpp:114-141)**20 类**+哨兵 mtNone→报告 "Unknown"(nmtCommon.cpp:31-51);flag 占 header 低字节(memTracker.cpp:59-61 STATIC_ASSERT <= max_jubyte)
> - **"三档 off/summary/detail" 错**: 真实**四档**(nmtCommon.hpp:35-41): NMT_off/minimal/summary/detail;minimal=shutdown 后残余态;**transition 只降不升**(memTracker.cpp:164-184,注释 "Upgrading tracking level is not supported");shutdown 只能降到 minimal(:157-162)
> - **"NativeCallStack 存 ~4-10 frame" 错**: **固定 4 帧**(NMT_TrackingStackDepth=4,nmtCommon.hpp:45,构建期决策);采集=os::get_native_stack 走帧指针链(os_posix.cpp:120-140),非 glibc backtrace;hash=帧地址求和(nativeCallStack.cpp:83-95);CURRENT_PC/CALLER_PC 宏**只有 detail 且 NMT_stack_walkable 才真抓栈**(memTracker.hpp:88-91),否则 empty_stack
> - **缺机制(重要)**: ①开关经 **launcher 环境变量 NMT_LEVEL_<pid>** 传递(java.c:825-880 SetJvmEnvironment putenv;JVM 侧 init_tracking_level memTracker.cpp:58-96 读+unsetenv :84,防泄漏子进程);tracking_level() 懒初始化(memTracker.hpp:119-127);参数解析双保险(arguments.cpp:3685-3701 check_launcher_nmt_support/verify_nmt_option);②MallocSiteTable 静态 511 桶(128*4-1,mallocSiteTable.hpp:118-122),链尾 CAS 插入(mallocSiteTable.cpp:142-185),**无删除**,表入口分配用伪调用栈防递归(:75-113/:201-205,最早 os::malloc 来自 C 运行时链接器);③AccessLock 共享/排他(计数器变负,排他后共享永拒,:128-166/cpp:243-265);④**OOM 自动降级 summary**(record_malloc_site 失败→transition_to(NMT_summary),mallocTracker.cpp:79-90);⑤header 自身记账 tracking overhead(:286 record_new_malloc_header)
> - **"VirtualMemoryTracker per-call-site 聚合" 错**: 虚拟内存**不用哈希**——形态=**按地址排序的 ReservedMemoryRegion 链表**(virtualMemoryTracker.hpp:391-418),每区域 base/size+调用栈+MEMFLAGS+**CommittedMemoryRegion 子链表**(每 commit 段有自己的栈);add 合并相邻同栈区域(:84-95,:106-157),release 从中间切割(:437-488);ThreadCritical 保护(memTracker.hpp:214);线程栈借 mtThreadStack malloc 计数器记线程数(memTracker.hpp:256-263)
> - **summary 报告数据面**: MallocMemorySummary 静态快照区按类别原子计数(mallocTracker.hpp:134-237/:55-71),malloc/arena 双计数器,报告前 make_adjustment 从 mtChunk 减 arena 大小(mallocTracker.cpp:55-59)
> - **实证**: 34-nmt-tracking-demo.txt(summary 退出报告 82 行: Total reserved=18058807559/committed=1165695239,20 类,thread #18,类内 "malloc=343389 #3287";detail 段: 虚拟内存区域+4 帧栈/malloc callsite 段 4 帧(PerfStringConstant 等)/线程栈 reserved 1048576+committed 8192;tracking overhead);jcmd-VM.native_memory.txt(未启用失败输出)
> - **悬念指向 02-nmt-report ✓**(正确,保留)

### 1. "MallocTracker — 每次 malloc 的 headers"

场景: `os::malloc(256, mtGC)` → NMT 嵌入 header → 记录 pointer+size+allocation site → MallocSiteTable hash → 按 call-site 聚合。

**MallocHeader** (`services/mallocTracker.hpp:40-120`):
```cpp
struct MallocHeader {
  size_t _size;           // 实际分配大小(不含 header)
  MEMFLAGS _flags;        // mtGC/mtCode/mtThread 等
  uint32_t _unused;
  const NativeCallStack* _stack; // allocation call-site(函数调用栈)
};
// 内存布局: [MallocHeader][user_data...]
// os::malloc → allocate header before user ptr → track
```
- 源码: `services/mallocTracker.hpp:40-120` + `mallocTracker.cpp:50-200`
- 关键设计: header 在用户指针前——user gets `ptr_to_data = header + 1`。free时: `header = (MallocHeader*)ptr_to_data - 1`→read size→dealloc。Per-call-site tracking: headers 在 MallocSiteTable 按 call-stack hash→聚合(count+total_bytes)
- [C++: `NativeCallStack` 存 ~4-10 frame(stack trace)——通过 `os::get_native_stack`(像 glibc backtrace)采集。在跟踪级别≥detail 时——每 malloc 抓一次栈→overhead ~3-5%]

### 2. "VirtualMemoryTracker — mmap/munmap"

场景: `os::reserve_memory(4MB)` → virtualMemoryTracker → record allocation site → aggregated。

**VirtualMemoryTracker** (`services/virtualMemoryTracker.hpp:40-120 + virtualMemoryTracker.cpp:50-250`):
```
VirtualMemoryTracker::add_reserved_region(base, size, flag):
  → VirtualMemoryAllocationSite(flag, site)→记录每次 reserve/commit
  → aggregated per-call-site: total reserved + total committed
```
- 源码: `services/virtualMemoryTracker.hpp:40-120` + `virtualMemoryTracker.cpp:50-250`

---

### 核心悬念

**"MallocHeader 嵌入每次 malloc 前——NMT 追踪 pointer+size+call-site。MallocSiteTable 按 call-stack hash 聚合 count+bytes。"** — 下一篇: NMT 报告。

> → [02-nmt-report.md](02-nmt-report.md)
