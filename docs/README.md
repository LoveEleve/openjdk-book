<div class="home-mug">
<span class="home-rain">0 1 1 0 1 0 1 1<br>1 0 0 1 0 1 0 0<br>1 1 0 0 1 0 1 1<br>0 0 1 1 0 1 0 0<br>1 0 1 0 1 1 0 1</span>
<svg viewBox="0 0 80 100" width="70" height="88">
  <defs><style>.s{fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:2.2;}</style></defs>
  <!-- Tux - Linux 企鹅 -->
  <ellipse class="s" cx="40" cy="65" rx="28" ry="30" stroke-width="2"/>
  <ellipse class="s" cx="40" cy="60" rx="16" ry="19" opacity=".7" stroke-width="1.2"/>
  <!-- 嘴 -->
  <path class="s" d="M30 38L40 42L50 38" stroke-width="1.8"/>
  <!-- 眼睛 -->
  <circle cx="33" cy="32" r="2.5" fill="currentColor"/>
  <circle cx="47" cy="32" r="2.5" fill="currentColor"/>
  <!-- 脚 -->
  <ellipse class="s" cx="26" cy="92" rx="10" ry="5" stroke-width="2"/>
  <ellipse class="s" cx="54" cy="92" rx="10" ry="5" stroke-width="2"/>
</svg>
</div>

# 格物致知：OpenJDK 源码分析

## 卷 0 · 地基

* [第一章 — java 命令到底是什么](openjdk/vol-00/ch01.md) — 一个 C 编译出来的可执行文件
* [第二章 — 编译你自己的 JDK](openjdk/vol-00/ch02.md) — configure → make → 你的第一个 JDK
* [第三章 — make 到底做了什么](openjdk/vol-00/ch03.md) — 8 阶段流水线拆解 make 的 1 分 31 秒
* [第四章 — jdk11u-copy：裁剪、CMake 与 IDE](openjdk/vol-00/ch04.md) — 从 Make 到 CMake，秒级增量编译

## 卷 1 · 启动

* [第一章 — Launcher Chain](openjdk/vol-01/ch01) — main.c → JLI_Launch → dlopen → dlsym
* [第二章 — JavaMain → InitializeJVM](openjdk/vol-01/ch02.md) — JavaMainArgs 解包 → CreateJavaVM 调用
* [第三章 — JNI_CreateJavaVM](openjdk/vol-01/ch03/01-overview.md) — Atomic::xchg 守卫 → Threads::create_vm
  * [3.1 概览：进程线程模型 + _inner 全貌](openjdk/vol-01/ch03/01-overview.md)
  * [3.2 Threads::create_vm 总览](openjdk/vol-01/ch03/02-threads-create-vm.md)
  * [3.3 前置初始化](openjdk/vol-01/ch03/03-preamble-init.md)
  * [3.4 参数解析](openjdk/vol-01/ch03/04-args-parse.md)
  * [3.5 OS 后初始化](openjdk/vol-01/ch03/05-os-init2.md)
  * [3.6 第一个 JavaThread：主线程登记](openjdk/vol-01/ch03/06-main-thread-create.md)
  * [前置概念：三套 Handle 体系](openjdk/vol-01/ch03/background/handles-all.md)
  * [前置概念：Thread-SMR](openjdk/vol-01/ch03/background/smr.md)
  * [前置概念：_oops_do_parity — GC 并行标记的去重锁](openjdk/vol-01/ch03/background/oops-do-parity.md)
  * [前置概念：GlobalCounter — RCU 风格的宽限期等待](openjdk/vol-01/ch03/background/global-counter.md)
  * [前置概念：_SR_lock — 线程自我挂起的信号锁](openjdk/vol-01/ch03/background/suspend-resume.md)
  * [前置概念：ThreadSafepointState — 线程安全点状态机](openjdk/vol-01/ch03/background/safepoint-state.md)
  * [前置概念：Parker — Unsafe.park/unpark 的底层实现](openjdk/vol-01/ch03/background/parker.md)
  * [前置概念：主线程附着 — set_as_starting_thread](openjdk/vol-01/ch03/background/attach-main-thread.md)
* [第四章 — init.cpp 全局初始化](openjdk/vol-01/ch04/01-overview.md) — init_globals() 30 项核心子系统初始化
  * [4.1 init_globals() 总览](openjdk/vol-01/ch04/01-overview.md)
  * [4.2 management_init — JMX 子系统的 C++ 侧地基](openjdk/vol-01/ch04/02-management.md)
  * [4.3 bytecodes_init — JVM 字节码表的初始化](openjdk/vol-01/ch04/03-bytecodes.md)
  * [4.4 classLoader_init1 边界 + os_init_globals 空实现](openjdk/vol-01/ch04/04-classloader-boundary.md)
  * [4.5 四个 trivial 函数合并](openjdk/vol-01/ch04/05-trivial-merged.md)
* [第五章 — 编译策略选择 + CICompilerCount](openjdk/vol-01/ch05/01-policy-selection.md) — Serial vs Parallel vs G1，根据 VM 配置决定 GC 编译策略

* [第六章 — CodeCache 内存管理初始化](openjdk/vol-01/ch06/01-heap-layout.md) — CollectedHeap 的初始堆地址空间

* [第七章 — CPU 特性检测](openjdk/vol-01/ch07/01-cpuid.md) — VM_Version::get_processor_features()

* [第八章 — StubRoutines 运行时桩生成](openjdk/vol-01/ch08.md)
  * [8.1 什么是 Stub——JVM 中为什么需要手写汇编桩](openjdk/vol-01/ch08/01-stub-what-is.md)
  * [8.2 StubRoutines——stub 入口点的全局索引表](openjdk/vol-01/ch08/02-stubroutines-table.md)
  * [8.3 CodeCache、BufferBlob——可执行内存从哪来](openjdk/vol-01/ch08/03-bufferblob-create.md)
  * [8.4 机器码写入的四层抽象——从 __ push(rbp) 到 *_end = 0x55](openjdk/vol-01/ch08/04-code-writing-chain.md)
  * [8.5 StubGenerator——十七个桩的一次性代码工厂](openjdk/vol-01/ch08/05-stubgenerator.md)
  * [8.6 initialize1 完整知识体系](openjdk/vol-01/ch08/06-initialize1-full.md)

* [第九章 — JVM 运行时世界的 Genesis](openjdk/vol-01/ch09.md)
  * [9.1 Universe 初始化总览 + 基本类型系统创建](openjdk/vol-01/ch09/01-universe-init-overview.md)
  * [9.2 前置概念：OopStorage——不绑 HandleMark 的 oop 槽位池](openjdk/vol-01/ch09/02-oopstorage.md)
  * [9.3 ClassLoaderData 与空类加载器初始化](openjdk/vol-01/ch09/03-classloader-data-null.md)
  * [9.4 硬编码偏移量——C++ 怎么读一个还没加载的类的字段](openjdk/vol-01/ch09/04-javaclasses-offsets.md)
  * [9.5 JVM 启动参数的编译期约束系统](openjdk/vol-01/ch09/05-jvmflag-constraints.md)
  * [9.6 辅助子系统：PerfData/MetaspaceCounters/AOTLoader](openjdk/vol-01/ch09/06-auxiliary-trivial.md)
  * [9.7 Metaspace——类元数据的 Native Memory 管理器](openjdk/vol-01/ch09/07-metaspace.md)

* [第十章 — G1 GC 初始化全链路](openjdk/vol-01/ch10/01-initialize-heap-overview.md)
  * [10.1 前置概念：initialize_heap() 五步全景](openjdk/vol-01/ch10/01-initialize-heap-overview.md)
  * [10.2 G1 的 Region 大小是怎么确定的](openjdk/vol-01/ch10/02-g1-region-policy.md)
  * [10.3 堆从哪来——mmap 双阶段预约](openjdk/vol-01/ch10/03-reservedspace-mmap.md)
  * [10.4 G1CollectedHeap 构造函数——堆对象空壳的创建](openjdk/vol-01/ch10/04a-g1-heap-constructor.md)
  * [10.5 G1 的写前/写后双重屏障](openjdk/vol-01/ch10/04-heap-policy-construction.md)
  * [10.6 initialize() 上半段：reserve + 写屏障 + Mapper + HRM](openjdk/vol-01/ch10/05-memory-layout-mapper.md)
  * [10.7 跨 Region 引用——RemSet + BOT + CSet](openjdk/vol-01/ch10/06-remset-bot.md)
  * [10.8 并发标记引擎初始化](openjdk/vol-01/ch10/07-g1-concurrent-mark-creation.md)
  * [10.9 expand——commit 物理内存，分配 Region](openjdk/vol-01/ch10/08-expand-heap-regions.md)
  * [10.10 策略引擎绑定堆与 CSet](openjdk/vol-01/ch10/09-g1-policy-init.md)
  * [10.11 队列系统初始化——SATB + 双 DCQ + ConcurrentRefinement](openjdk/vol-01/ch10/10-queue-system-init.md)
  * [10.12 分配器就位 + 收尾](openjdk/vol-01/ch10/11-allocator-ready-and-cleanup.md)

* [第十一章 — LatestMethodCache](openjdk/vol-01/ch11/01-latest-method-cache.md) — O(n)→O(1) 的方法查找缓存

* [第十二章 — 符号表/字符串表/方法表](openjdk/vol-01/ch12.md) — 三张哈希表的创建
  * [12.1 SymbolTable 初始化——经典链表哈希表](openjdk/vol-01/ch12/01-symbol-table-create.md)
  * [12.2 StringTable 初始化——并发无锁 + 弱引用](openjdk/vol-01/ch12/02-string-table-create.md)
  * [12.3 ResolvedMethodTable 初始化——经典表 + 弱引用](openjdk/vol-01/ch12/03-resolved-method-table-create.md)

* [第十三章 — init_globals 门面初始化](openjdk/vol-01/ch13/01-init-globals-facade.md) — GC 屏障桩、JIT 阈值、标志位与寄存器名

* [第十四章 — 解释器模板系统上架](openjdk/vol-01/ch14/01-interpreter-init.md) — interpreter_init 与 templateTable_init

## 卷 2 · 对象 — Java 的 C++ 真身

oop / Klass / markOop / 压缩指针 — 每个 Java 对象在 C++ 里的精确映射

## 卷 3 · 类加载 — .class 到 Klass

ClassFileParser / SystemDictionary / CDS — 类是怎么进入 JVM 的

## 卷 4 · 解释器 — 字节码执行

TemplateInterpreter / codelet / 256 字节码 — 解释执行的全路径

## 卷 5 · C1 编译器 — 快速执行路径

8 Phase 快速编译管线 — HIR 构建 → LinearScan 寄存器分配

## 卷 6 · C2 编译器 — 极致性能

Sea-of-Nodes / GVN / 内联 / 逃逸分析 / Chaitin 寄存器分配

## 卷 7 · 代码管理 — CodeCache / nmethod / Deopt

编译产物的生老病死 — 从 CodeCache 分配到 Sweeper 回收

## 卷 8 · G1 GC — 内存的生死轮回

Region / TAMS / SATB / RSet / Young GC / Mixed GC / Full GC — G1 的全部秘密

## 卷 9 · 多 GC 对比 — 全景视野

Serial / Parallel / CMS / G1 / ZGC / Shenandoah — 6 种 GC 的设计哲学对比

## 卷 10 · 线程与锁 — 并发根基

ObjectMonitor / 偏向锁 / ParkEvent — synchronized 的完整 C++ 实现

## 卷 11 · Safepoint + 信号处理

Polling Page / VM_Operation / libjsig — JVM 如何安全地暂停整个世界

## 卷 12 · 边界 — JNI / JVMTI / Unsafe / JPMS

JVM 与外部世界的所有桥梁 — 从 231 个 JNI 函数到模块系统

## 卷 13 · 诊断与定制 — UL / JMX / JFR / SA / 构建

让 JVM 告诉你它在做什么 — 日志 / 监控 / 飞行记录 / 事后调试 / 定制裁剪
