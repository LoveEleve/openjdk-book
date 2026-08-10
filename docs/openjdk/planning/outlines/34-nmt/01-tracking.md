# 01. 每次 malloc 怎么被追踪到 call-site？— NMT 追踪系统

> 🔴 Deep | 1 KP 中的全栈追踪
> 读者处境: `jcmd <pid> VM.native_memory summary` — 输出按 ~30 MEMFLAGS 分类的 native 内存使用。每次 `os::malloc`/`mmap` 都会被追踪——通过嵌入 MallocHeader 在分配内存前。

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
