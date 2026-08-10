# 书级全局规划：OpenJDK HotSpot 源码分析

> ⚠️ **待知识规划验证** — 域序和卷结构需聚类后重排。见 `HANDOFF-REDO.md`。
> 2026-08-07 | 基于 00-domain-list.md 拓扑排序 + 04-approach-selection.md 方案选择
> 读者基线：JVM 使用者（懂 Java、用过 JVM），需补 C++/x86 汇编基础

---

## 目录结构

```
Vol-00  前置准备 — C++ 入门 + x86 汇编 + 编译 JDK
  
Vol-01  地基（拓扑 Layer 0-1，9 域）
  01 | OS 抽象层 🔴 A
  02 | Assembler 🔴 A (Hub)
  03 | OOPs 对象模型 🔴 A
  04 | Arguments/Flags 🟡 B
  05 | Logging 🟡 B
  06 | PerfData/jstat 🟡 B
  07 | Java Class Mirrors 🟡 B
  08 | JNI 层 🟡 B

Vol-02  并发骨架（拓扑 Layer 2-3，4 域）
  09 | 线程管理 🔴 A
  10 | 安全点 Safepoint 🔴 A
  11 | VM Operations 🟡 B
  12 | 同步 ObjectMonitor 🔴 A

Vol-03  内存管理（拓扑 Layer 3-5，9 域）
  13 | GC 框架 🔴 A
  14 | Reference Processing 🟡 B
  15 | 堆 / Universe 🔴 A
  16 | Metaspace 🔴 A
  17 | SymbolTable/StringTable 🟡 B
  18 | CodeCache 🔴 A
  19 | StubRoutines 🟡 B
  20 | G1 GC 🔴 A
  21 | CDS 🟡 B

Vol-04  类加载与执行（拓扑 Layer 5-7，10 域）
  22 | ClassFile / ClassLoader 🔴 A
  23 | Interpreter 🔴 A
  24 | VTable/InlineCache 🟡 B
  25 | ci Compiler Interface 🟡 B
  26 | JIT Framework 🔴 A
  27 | SharedRuntime 🟡 B
  28 | C1 Compiler 🔴 A
  29 | C2 Compiler 🔴 A
  30 | Deoptimization 🟡 B
  31 | MethodHandles 🔴 A

Vol-05  可观测性（拓扑 Layer 1-8，7 域）
  32 | JVMTI 🟡 B
  33 | JMX/Management 🟡 B
  34 | NMT 🟡 B
  35 | Attach API 🟡 B
  36 | HeapDumper 🟡 B
  37 | ServiceThread 🟡 C
  38 | JFR 🟡 B

Vol-06  JDK Native 桥接层（5 域 — JDK侧 native 代码，JNI/Unsafe/Intrinsic 与 HotSpot 耦合）
  39 | Launcher (libjli.so) 🟡 B
  40 | ZIP/JIMAGE (类文件 I/O) 🟡 B
  41 | Core Native (libjava.so) 🟡 B
  42 | NIO Network (libnio/libnet) 🟡 B
  43 | SA Postmortem (libsaproc) 🟡 B
```

## 各卷概况

| 卷 | 域数 | 🔴A | 🟡B | 🟡C | 核心问题 |
|------|:--:|:--:|:--:|:--:|------|
| 00 前置 | — | — | — | — | 怎么编译JDK？C++/汇编够用就行 |
| 01 地基 | 9 | 3 | 6 | 0 | JVM 的基础零件是什么？ |
| 02 并发 | 4 | 3 | 1 | 0 | 线程/锁/暂停怎么工作？ |
| 03 内存 | 9 | 5 | 4 | 0 | 对象怎么存、怎么分、怎么回收？ |
| 04 执行 | 10 | 5 | 5 | 0 | 字节码怎么变成CPU指令？ |
| 05 可观测 | 7 | 0 | 6 | 1 | jstack/jmap/jstat背后是什么？ |
| **06 JDK Native** | **5** | **0** | **5** | **0** | `java`命令怎么启动JVM？class字节从哪读？NIO epoll怎么工作？ |

## 叙事连接

```
vol-00: "JDK 编译不出来，源码没法看" → 编译 JDK
  ↓
vol-01: "23KB 的 java 命令怎么启动 164MB 的 JVM？" → 地基
  ↓
vol-02: "JVM 活了，多个线程怎么协调？" → 并发骨架
  ↓
vol-03: "对象创建后去哪了？内存怎么管？" → 内存管理
  ↓
vol-04: "代码怎么变成 CPU 指令？冷热方法怎么区分？" → 执行引擎
  ↓
vol-05: "线上出问题怎么看 JVM 内部状态？" → 可观测
```

## 执行顺序

按卷顺序逐域执行，卷内按拓扑排序。每个域执行：
1. Pass 0 读上下文（issue/PR/release notes）
2. Pass 1 扫轮廓（继承树 + 元素分解 + ≥5 标记问题）
3. Pass 2 盯关键点（≥3 闭环笔记）
4. **A 方案** → Pass 3 写文章 + 时空溯源 + 极简复现
5. **B 方案** → Pass 3 可选（≥5 标记问题才写文章）
6. **C 方案** → 简略 Pass 2 即终稿

**强制拆分（≥6 闭环笔记）**：G1 GC、JFR、ClassFile、C2

---

*书级规划完成。下一步：vol-01 第 1 个域（OS 抽象层）Pass 0。*
