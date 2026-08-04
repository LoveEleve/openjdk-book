# 格物致知：OpenJDK 源码分析

14 卷，~230 章。不是"深入理解"——是你可以亲手验证每一个断言。

## C++ 语法速查

* [总览 — 按出现顺序的语法索引](openjdk/vol-cxx/README.md)

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
