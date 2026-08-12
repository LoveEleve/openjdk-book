# 02. RegisterMap + JavaFrameAnchor — GC 怎么找到栈上的引用？

> **前置依赖**：[01 — 原子与屏障](01-atomic-and-memory-order.md)：机器层原语；[01-os/03 — 线程](openjdk/vol-02/01-os/03-threads-and-sync.md)：线程栈
> → **后续**：域 06 [OOPs — 对象模型](openjdk/vol-02/06-oops/01-object-model.md)
> 关联域: 24-frame(栈遍历)、25-gc(根扫描)、15-c2(寄存器分配)

## GC 根扫描的一道难题:R12 里到底是 String 还是 int?

GC 找根(roots)时,除了 static 字段,还要扫**每个线程栈上的局部变量**——里面可能有对象的引用。但 GC 面对的是两件事:

1. **寄存器和栈槽的原始值**——就一堆 64 位数字,谁知道哪一个是对象指针?
2. **JNI 边界**——Java 调了 native 方法,C 代码正在跑,CPU 的 rsp/rbp 已经是 C 栈帧的了,Java 的栈帧去哪了?

这一篇的两个主角就是回答这两个问题的:`RegisterMap`(值在哪、哪个是 OOP)和 `JavaFrameAnchor`(Java 帧在 native 调用中存哪了)。

## 1. JavaFrameAnchor:JNI 边界的"锚"

### 场景:GC 时,Java 的 sp/rbp 在哪?

Java 代码调 native 方法(`System.currentTimeMillis()` 这种)——线程进入 C 世界。此时如果 GC 发生,它需要遍历这个线程的 **Java 栈帧**——但 CPU 的 rsp/rbp 现在指向 **C 栈帧**(`call` 进 C 后,C 代码 `push rbp; mov rbp, rsp` 已经把 Java 的帧指针覆盖了)。

Java 的栈帧信息必须**在进入 native 之前保存**——存在 `JavaFrameAnchor` 里(`javaFrameAnchor.hpp:58-71`):

```cpp
// javaFrameAnchor.hpp:58-71(截取核心字段,注释逐字)
// Whenever _last_Java_sp != NULL other anchor fields MUST be valid!
intptr_t* volatile _last_Java_sp;   // :62 —— Java 栈帧的 sp

// Whenever we call from Java to native we can not be assured that the return
// address that composes the last_Java_frame will be in an accessible location
// so calls from Java to native store that pc (or one good enough to locate
// the oopmap) in the frame anchor.
volatile  address _last_Java_pc;    // :71 —— 返回地址(pc)
```

- [x86: rsp 是栈顶(向低地址增长),rbp 是帧基址。JNI 调用进入 C 后 `push rbp; mov rbp, rsp`——rbp 变成 C 帧的基址,Java 的 rbp 被保存在 `last_Java_fp`(平台扩展字段)]
- [C++: 注释第一句是契约——"只要 _last_Java_sp != NULL,锚的其他字段必须有效"。GC 扫描时只信这个锚,不信 CPU 寄存器]

GC 根扫描的路径: 从 `last_Java_sp` 向上(向高地址)遍历 Java 栈帧,每个帧按 oop map 找含 OOP 的槽,用 `oopDesc::is_oop()` 验证。

**关键设计 (斜体)**: *为什么要在进入 native 前保存而不是事后恢复?GC 可能在任何时刻发生(包括 C 代码中间)——事后没法恢复"进入前"的栈状态。锚是"进入前快照":把 Java 帧的位置钉在 anchor 里,C 代码随便折腾栈,GC 只认锚。*

## 2. RegisterMap:寄存器与栈槽的"位置表"

### 真实机制:不是"OOP 位图",是"位置表 + 有效性位图"

很多资料说 RegisterMap 是"每个寄存器一个 bit 标记是否含 OOP"——**看源码不是这样**(`registerMap.hpp:63-105`):

```cpp
// registerMap.hpp:63 起(截取核心字段)
class RegisterMap : public StackObj {
  enum {
    reg_count = ConcreteRegisterImpl::number_of_registers,
    ...
  };
 private:
  intptr_t*    _location[reg_count];        // 每个寄存器的值在哪(寄存器本身 or spill 栈槽)
  LocationValidType _location_valid[...];   // 位图:哪些位置是有效的
  bool        _include_argument_oops;       // 是否含 argument oop 位置
  ...
  address location(VMReg reg) const { ... } // 查某寄存器值的位置
```

RegisterMap 回答的是**"值在哪"**:寄存器可能被 spill 到栈上(`_location[r12] = rbp-32` 表示"r12 的值在栈偏移 -32 处"),`_location_valid` 位图标记哪些记录有效。而**"哪个位置是 OOP"由帧的 oop map 回答**——两者配合:RegisterMap 找到值的位置,oop map 标记哪个位置是引用。

- [x86: C2 的寄存器分配器(PhaseChaitin)在编译时就知道每个物理寄存器的最终用途:OOP 用 r12-r15、int/long 用 r8-r11。寄存器不够时 OOP 被 spill 到栈——RegisterMap 记下"r12 的 OOP 现在在 [rbp-32]"]

GC 根扫描的完整链路: `RegisterMap` 给"值在哪" → 帧的 oop map 给"哪是 OOP" → 是 OOP 的槽进根集合。**两个表缺一不可**。

## 3. Prefetch、ICache、TSC:三个"硬件小工具"

### Prefetch:给 CPU 一个提示

`Prefetch::read/write`(`os_cpu/linux_x86/prefetch_linux_x86.inline.hpp:28-45`):

```cpp
// os_cpu/linux_x86/prefetch_linux_x86.inline.hpp:33-42(截取核心)
inline void Prefetch::read (void *loc, intx interval) {
#ifdef AMD64
  __asm__ ("prefetcht0 (%0,%1,1)" : : "r" (loc), "r" (interval));
#endif
}
inline void Prefetch::write(void *loc, intx interval) {
#ifdef AMD64
  // Do not use the 3dnow prefetchw instruction.  It isn't supported on em64t.
  //  __asm__ ("prefetchw (%0,%1,1)" : : "r" (loc), "r" (interval));
  __asm__ ("prefetcht0 (%0,%1,1)" : : "r" (loc), "r" (interval));
#endif
}
```

注意注释:**read 和 write 都用的 `prefetcht0`,而且特意不用 3dnow 的 `prefetchw`**——em64t(Intel 64)不支持。大纲和资料常提的 `prefetchnta`(non-temporal)在这份实现里不存在。

- [x86: PREFETCH 是 CPU hint——可以忽略,不保证数据加载,只是预热 cache line 状态。典型用法:GC card scan 时预取下一行 card table,减少线性扫描的 cache miss]
- JVM 里:GC barrier 写 card entry 后调 prefetch,预取下一 64B 的 card entry(域 25 的伏笔)

### ICache::flush:x86 的 no-op

`icache_x86.hpp:28-40` 的注释把答案写得很直白:

```cpp
// icache_x86.hpp:28-40(注释逐字)
// On the x86, this is a no-op -- the I-cache is guaranteed to be consistent
// after the next jump, and the VM never modifies instructions directly ahead
// of the instruction fetch path.
```

x86 的指令缓存**自动一致**——`ICache::flush` 走默认实现(no-op),JIT 生成 nmethod 后,下一次跳转自动取到新指令。ARM 则必须显式 `ISB`(指令同步屏障)+ `DSB`(数据同步屏障)——**同一个接口,一个平台 no-op、一个平台两条指令**——又是"语义接口 + 平台实现"的模式。

### TSC:rdtsc 与高精度计时

`rdtsc_x86.hpp:31-44` 提供 `rdtsc()` 接口(留给需要自 CPU 上电 cycle 计数的场景);JVM 的高精度计时主力是 `os::elapsed_counter()`(os_linux.cpp:1435)——它走 `javaTimeNanos()`(os_linux.cpp:1555)的 `clock_gettime(CLOCK_MONOTONIC)`(单调时钟,纳秒级),GC 阶段计时、JFR 事件时间戳都基于它。

- [x86: rdtsc 读 TSC(自 CPU 上电的 cycle 计数);rdtscp 额外返回 CPU 核心 ID(IA32_TSC_AUX MSR)——多 socket 的 TSC 不同步,socket0 可能比 socket1 快 ~100 cycles,跨核计时需注意。这也是 JVM 默认用 clock_gettime 而非 rdtsc 的原因之一]
- [man 2 clock_gettime]

## 核心悬念

"GC 怎么知道 R12 是 String 而不是 int?——JIT 编译时 C2 寄存器分配器生成的信息,配合 RegisterMap 的位置表和帧的 oop map。" 编译器知道每个寄存器的最终用途;JavaFrameAnchor 桥接 JNI 边界的栈帧切换——没有它,GC 在 native 调用中找不到 Java 的栈上引用。域 1-5 的全部基础设施——OS、汇编、配置、日志、原子操作——现在汇入一个更大的问题:**Java 对象到底是什么?**

> → 域 06 [OOPs — oopDesc / Klass / markOop / compressedOop](openjdk/vol-02/06-oops/01-object-model.md)
