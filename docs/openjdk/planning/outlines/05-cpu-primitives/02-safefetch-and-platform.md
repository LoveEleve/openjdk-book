# 02. RegisterMap + JavaFrameAnchor — GC 怎么找到栈上的引用？

> 🟡 Working | 9 KP 中的 3 个辅助机制
> 读者处境: GC roots 除了 static fields——还有栈上的局部变量。GC 怎么知道 R12 是 String 不是 int？

### 1. JavaFrameAnchor — JNI 边界的栈保存

场景: Java 代码调了 native 方法——C 代码运行中——GC 发生了。GC 需要找到 Java 栈帧中所有 OOP——但 CPU 的 sp/rbp 现在是 C 代码的栈帧。Java 的 sp/rbp 去哪了？

**last_Java_sp / last_Java_fp** (`javaFrameAnchor.hpp:34`):
- 进入 JNI 调用前——JVM 保存 Java 栈帧的 sp (stack pointer) 和 fp (frame pointer) 到 JavaFrameAnchor
- [x86: rsp (stack pointer——栈顶，向低地址增长) + rbp (frame pointer——调用者的 rsp)。JNI 调用: `call` 进 C→C 代码 push rbp→mov rbp, rsp——rbp 现在是 C 栈帧的基址——Java 的 rbp 被保存在 `last_Java_fp`]
- GC 根扫描: 从 last_Java_sp 向上扫栈 (向高地址)=遍历 Java 栈帧→找所有含 OOP 的栈槽→`oopDesc::is_oop()` 验证

### 2. RegisterMap — 寄存器类型标记

**RegisterMap** (`registerMap.hpp:50`):
- 每个寄存器 (rax, rbx, ..., r15, xmm0-xmm15) 有一个 bit——标记是否含 OOP
- JIT 编译时 C2 的 register allocator (PhaseChaitin) 已知每个寄存器的类型: OOP 用 r12-r15, int/long 用 r8-r11
- [x86: C2 register allocation——`PhaseChaitin::Register_Allocate` 生成 RegisterMap bitmap——每 bit 对应一个物理寄存器。OOP 寄存器=GC root——GC 扫描所有标记为 OOP 的寄存器]
- 寄存器 spilling: 物理寄存器不够→OOP 被 spill 到栈上——RegisterMap 也标记栈槽——“r12 的 OOP 被 spill 到 [rbp-32]”

### 3. Prefetch + ICache + TSC

**prefetch_read / prefetch_write** (`prefetch.inline.hpp:28-35`):
- PREFETCHT0: 预取到所有 cache level—会反复用 (temporal)
- PREFETCHNTA: 预取到 L2 但绕过 L3—只用一次 (non-temporal)
- [x86: PREFETCH 是 CPU hint——CPU 可以忽略。不保证数据加载——只预热 cache line 状态 (MESI→Shared)。典型用法: GC card scan 时预取下一行 card table——减少 linear scan 的 cache miss]
- JVM 中 GC barrier: 写 card entry 后调用 prefetch——预取下 64B 的 card entry

**ICache::flush** (`icache_x86.hpp:28`):
- x86: no-op——串行化指令自动刷新 ICache
- ARM: ISB (指令同步屏障) + DSB (数据同步屏障)—必须显式
- [x86: self-modifying code——JIT 生成 nmethod 后——clflush 清除旧代码的 L1 ICache——下次执行从 L2/L3 重新取——自动拿到新代码]

**TSC** (`rdtsc_x86.hpp:35`):
- rdtsc: 自 CPU 上电以来的 cycle 计数——用作高精度时间戳
- [x86: rdtsc vs rdtscp——rdtscp 额外返回 IA32_TSC_AUX MSR (CPU 核心 ID)——告诉你在哪个 socket 读的 TSC。多 socket TSC 不同步——socket0 可能比 socket1 快 100 cycles]
- JVM 使用: `os::elapsed_counter()` → TSC/HPET → GC 阶段计时、JFR 事件时间戳

---

### 核心悬念

**"GC 怎么知道 R12 是 String 而不是 int？——JIT 编译时 C2 register allocator 生成的 RegisterMap。"** — 编译器知道每个寄存器的最终用途。OOP 寄存器被 GC 当根扫描——int/long 寄存器被忽略。JavaFrameAnchor 桥接 JNI 边界的栈帧切换——没有它，GC 在 native 调用中找不到 Java 的栈上引用。Domain 1-5 的全部基础设施——OS/汇编/配置/日志/原子操作——现在汇入 Domain 6: Java 对象到底是什么。

> → domain 6: [OOPs — oopDesc / Klass / markOop / compressedOop](../06-oops/01-object-model.md)
