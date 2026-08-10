# 方案选择：OpenJDK HotSpot 38 域

> ⚠️ **待知识规划验证** — A/B/C/D 方案需基于深度分类结果重新判定。见 `HANDOFF-REDO.md`。
> 方法论/04 方案选择决策树 | 2026-08-07
> 输入：`00-domain-list.md` 域清单 + 拓扑排序

## 判定规则

| 优先级 | 设计决策 | 方案 | 通过 |
|--------|:--:|:--:|------|
| 🔴 | 任意 | **A** | Pass 0→1→2→3 + 时空溯源 + 极简复现 |
| 🟡 | 是 | **B** | Pass 0→1→2（Pass 3 可选） |
| 🟡 | 简单机制 | **C** | Pass 0→1 + 简略 Pass 2 |
| 🟡 | 胶水/枚举 | **D** | Pass 1 简略扫描 |

**特殊规则**：
- Hub 升级：🟡 被 ≥10 域依赖 → 升级 A
- 叶子域：🟡 零下游依赖 → 最低 B

---

## 🔴 → A（17 域 — 全深度强制）

| # | 域 | 方案 | Hub? | 备注 |
|:--:|-----|:--:|:--:|------|
| 1 | OS 抽象层 | **A** | ✅ | 所有 37 域的基础 |
| 2 | Assembler | **A** | ✅ | Hub 升级（≥10 域依赖）|
| 3 | OOPs（对象模型） | **A** | ✅ | 类型系统基础 |
| 4 | 线程管理 | **A** | ✅ | 并发基础 |
| 5 | 同步 (ObjectMonitor) | **A** | ✅ | |
| 6 | 安全点 (Safepoint) | **A** | ✅ | |
| 7 | 堆 / Universe | **A** | ✅ | TLAB/PLAB/压缩指针 |
| 8 | GC 框架 | **A** | ✅ | 屏障/引用/工作分发 |
| 9 | G1 GC | **A** | — | 45692 行，强制拆多篇 |
| 10 | 元空间 (Metaspace) | **A** | — | |
| 11 | ClassFile / 类加载 | **A** | ✅ | 含 linkResolver 2229 行 |
| 12 | 解释器 | **A** | ✅ | 双解释器架构 |
| 13 | JIT 编译框架 | **A** | ✅ | 含 methodData 4338 行 |
| 14 | C1 编译器 | **A** | — | 41074 行 |
| 15 | C2 编译器 | **A** | — | 139595 行 |
| 16 | CodeCache | **A** | — | |
| 17 | MethodHandles (JSR 292) | **A** | — | |

## 🟡 → B（20 域 — 标准分析）

| # | 域 | 方案 | 备注 |
|:--:|-----|:--:|------|
| 18 | StubRoutines | **B** | 桩程序生成 + 调用约定 |
| 19 | VTable/InlineCache | **B** | 虚方法分派优化 |
| 20 | ci (Compiler Interface) | **B** | 74 文件 |
| 21 | JNI 层 | **B** | 句柄管理 + local frame |
| 22 | Arguments/Flags | **B** | 工效学 + 约束验证 |
| 23 | Logging | **B** | 统一日志框架 |
| 24 | Java Class Mirrors | **B** | 6421 行 |
| 25 | VM Operations | **B** | 80+ VM_OP + 双优先级队列 |
| 26 | SymbolTable/StringTable | **B** | ConcurrentHashTable |
| 27 | SharedRuntime | **B** | 3216 行 |
| 28 | Deoptimization | **B** | 2422 行 |
| 29 | Reference Processing | **B** | SoftReference LRU |
| 30 | PerfData/jstat | **B** | mmap 共享内存 |
| 31 | CDS | **B** | 归档格式 + AppCDS，3700+ 行 |
| 32 | JVMTI | **B** | Agent 协议 + 事件模型 |
| 33 | JMX/Management | **B** | MBean 监控 |
| 34 | Attach API | **B** | DCmd 框架 |
| 35 | NMT | **B** | malloc 拦截 + 三档追踪 |
| 36 | HeapDumper | **B** | HPROF 格式 + 压缩 |
| 37 | JFR | **B** | 215 文件，强制拆多篇 |

## 🟡 → B（JDK Native 桥接层 — 5 域）

| # | 域 | 方案 | 备注 |
|:--:|-----|:--:|------|
| 38 | ServiceThread | **C** | — |
| 39 | Launcher (libjli) | **B** | JVM 启动入口 |
| 40 | ZIP/JIMAGE | **B** | 类文件物理 I/O |
| 41 | Core Native (libjava) | **B** | System/Class/String native 桥 |
| 42 | NIO Network (libnio/libnet) | **B** | epoll/DirectByteBuffer |
| 43 | SA Postmortem (libsaproc) | **B** | ptrace/core dump 诊断 |

## 🟡 → C（1 域 — 简单机制）

| # | 域 | 方案 | 理由 |
|:--:|-----|:--:|------|
| 38 | ServiceThread | **C** | 单后台线程出队任务，机制简单 |

---

## 汇总

| 方案 | 域数 | 占比 |
|:--:|:--:|:--:|
| A（全深度） | 17 | 40% |
| B（标准） | 25 | 58% |
| C（浅层） | 1 | 2% |
| **合计** | **43** | |

**A 方案域执行顺序（拓扑排序）**：

```
OS → Assembler → OOPs → Threads → Synchronization → Safepoint
  → GC Framework → G1 GC → Heap/Universe → Metaspace
  → ClassFile/ClassLoader → CodeCache → Interpreter
  → JIT Framework → C1 Compiler → C2 Compiler
  → MethodHandles
```

**强制拆分（≥6 闭环笔记）**：G1 GC (45692行)、JFR (215文件)、ClassFile (含 linkResolver/verification/linking)、C2 (139595行)

---

*方案选择完成。下一步：书级全局规划（读者基线 + 前置知识域 + 域间叙事连接 + 全局目录）*
