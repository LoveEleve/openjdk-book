# HANDOFF — OpenJDK 源码分析知识规划

> 2026-08-09 | 15/48 域完成 (31.3%) | 52 篇大纲 | v5 教学叙事标准
> 接收者: 新 AI | 目标: 接续完成剩余 33 域

---

## ⚡ 第一个行动

```
1. 读本交接文档（完整方法论 + 当前状态）
2. 读 00-domain-discovery-v3.md — 48 域清单 + 源码路径
3. 读 outlines/01-os-abstraction/01-platform-detection.md — v5 标准示范
4. 从域 16 Code Cache 继续
```

---

## §零 当前进度

| Group | 域范围 | 篇数 | 状态 |
|------|:--|:--:|:--:|
| **1** 核心基础设施 | 01-05 OS/Assembler/Flags/Logging/CPU Primitives | 14 | ✅ |
| **2** 对象模型 | 06 OOPs | 6 | ✅ |
| **3** 类加载与解释 | 07-08 ClassFile+Interpreter | 11 | ✅ |
| **4** 内存子系统 | 09-11 Memory+Metaspace+CDS | 8 | ✅ |
| **5** 执行引擎 | 12-15 ci+JIT+C1+C2 | 13 | ✅ |
| **6** 运行时核心 | 16-24 Threads/Safepoint/Sync/VMOps/SharedRuntime/Deopt/Stubs/Frame&Stack/CPU | 0 | ⏳ |
| **7** GC 子系统 | 25-26 GC Framework (巨型域 37K行)+G1 GC (巨型域 46K行) | 0 | ⏳ |
| **8** Native 接口 | 27-31 JNI/JVMTI/MethodHandles/JVM Entry/Unsafe | 0 | ⏳ |
| **9** 可观测性 | 32-39 JFR(巨型域 217文件)+JMX/NMT/DCmd/Attach/HeapDump/PerfData/RuntimeMonitoring | 0 | ⏳ |
| **10** JDK Native 层 | 40-47 Launcher/ZIP/CoreNative/NIO&Net/Verify/Math/SAPostmortem/Instrument | 0 | ⏳ |
| **11** 基础库 | 48 Utilities & Infrastructure | 0 | ⏳ |
| **合计** | | **52** | **15/48 (31.3%)** |

**已完成域详情**:

| 域 | 文章 | KP | 提问 | 备注 |
|:--:|:--:|:--:|:--:|------|
| 01 OS 抽象层 | 4 | 23 | 37/37 | v5 标准示范——最厚最佳 |
| 02 Assembler | 4 | 15 | 23/23 | x86 指令编码域 |
| 03 Arguments & Flags | 2 | 12 | 14/14 | 纯 C++ 元编程域 |
| 04 Logging | 2 | 13 | 12/12 | 日志管道域 |
| 05 CPU Primitives | 2 | 9 | 8/8 | 原子操作+SafeFetch |
| 06 OOPs | 6 | 15 | 13/13 | 巨型域 38K行 |
| 07 ClassFile & ClassLoader | 7 | 15 | 8/8 | 巨型域 46K行 |
| 08 Interpreter | 4 | 13 | 9/9 | 解释器+Template |
| 09 Memory 核心 | 3 | 10 | 4/4 | Unicode/Heap/VirtualSpace/Arena |
| 10 Metaspace | 3 | 9 | 7/7 | Chunk+Metablock+CDS |
| 11 CDS | 2 | 8 | 5/5 | Archive+mmap shared |
| 12 ci (Compiler Interface) | 3 | 11 | 6/6 | JIT 编译数据视图 |
| 13 JIT Framework | 2 | 8 | 5/5 | CompileBroker+分层编译 |
| 14 C1 Compiler | 4 | 11 | 6/6 | Client compiler pipeline |
| 15 C2 Compiler | 8 | 16 | 6/6 | 巨型域 177K行——最大域 |

---

## §一 方法论 v5 标准

### 每篇文章的标准格式

每个机制的段落必须包含四个要素：

```
### N. 机制名 — 一句话描述

场景: [读者为什么要看这个——具体场景，一句话]
[技术描述 + file:line + 函数名]

关键设计 (斜体):
*[为什么这样实现——设计决策、tradeoff]*

[C++: ...] [x86: ...] [内核: ...]   ← 跨层标注（域相关性）
[JVM Spec: §N]                      ← JVM 规范引用（解析域）
[man N xxx]                          ← man 引用（仅 OS/系统调用域）
```

### 五维检查表

| 维度 | 检查项 |
|:--|------|
| 场景 | 每个 section 开头有"场景:"句？ |
| 源码 | 有 `file:line` + 函数名 + 调用链？ |
| 关键设计 | 有斜体"关键设计"解释 why？ |
| 跨层 | [C++:/x86:/内核:] 标注合理？ |
| 核心悬念 | 每篇末尾有核心悬念 + OUTBOUND桥？ |

### 跨层标注规则（域类型相关）

- **OS 域**: [C++]/[内核]/[x86]/[man N] 四层
- **编译器域**: [C++]/[x86] 两层
- **纯数据结构域**: [C++] 一层
- **JVM 解析域**: [C++]/[JVM Spec:] 两层
- **man 引用**: 仅在涉及 POSIX/系统调用域使用——不套用到所有域

### 质量度量

- 不以行数比——以 KP 是否讲透（四要素齐全）为准
- 每篇完成后自查四要素

---

## §二 目录结构

```
planning/
├── 00-domain-discovery-v3.md      ← 48域权威清单
├── HANDOFF-NEW-AI.md               ← 本文件
├── knowledge-planning/            ← 逐域KP（15个 .md）
│   ├── 01-os-abstraction.md
│   └── 15-c2-compiler.md
├── outlines/                      ← 逐域大纲（15子目录 + 52篇）
│   ├── 01-os-abstraction/ (4篇)
│   ├── ...
│   └── 15-c2-compiler/ (8篇)
└── _archive/                      ← 废弃旧版全部文件
```

---

## §三 已知质量模式

1. **连续写域疲劳**: 越往后域越薄——每3域自查一次密度
2. **域 15 C2 初版崩溃**: 03-08 初版仅 19-23 行——已补全到 ~50 行——仍比域1薄——但 C2 域176K行内容更多——讲透即可
3. **man 引用域类型相关**: 不要在所有域机械套用 man 引用——OOPs/CDS/Logging 不需要
4. **以 KP 讲透为目标**: 不跨域比行数——只看每个 KP 的四要素

---

## §四 剩余域（33 域）

| 优先级 | Group | 域数 | 首个域 |
|:--:|------|:--:|------|
| 1 | Group 6 运行时核心 | 9 | 16 Code Cache |
| 2 | Group 7 GC | 2 | 25 GC Framework |
| 3 | Group 8-10 | 21 | 27-47 |

---

## §五 每域产出物清单

每个域完成后必须存在以下文件：

```
knowledge-planning/{编号}-{域}.md      ← 四章: 01提取→01聚合→02深度→03聚类
outlines/{编号}-{域}/                   ← 子目录
├── 01-{标题}.md                        ← 每篇独立大纲 (v5 教学叙事)
├── 02-{标题}.md
├── ...
└── completeness-questions.md           ← ≥5身份全视角验证
```

每个域的 `knowledge-planning/{域}.md` 必须包含四章：
- `## 01 逐源提取` — 逐源文件→机制表 (Source File/Mechanism/Confidence)
- `## 02 聚合` — P1(≥5文件)/P2(2-4)/P3(1) 跨文件汇总
- `## 03 深度分类` — 🔴Deep/🟡Working/🟢Surface (每项有"为什么")
- `## 04 聚类` — 依赖图+教学顺序+文章拆分建议

巨型域 (源码 >30000行 或 文件 >100): 需拆 6-8 篇。已知巨型域: C2(177K行), G1(46K行), GC Framework(37K行), OOPs(38K行), ClassFile(46K行), JFR(217文件)。C2 已按 8 篇拆分——给其他巨型域作参考。

---

## §六 启动命令与关键路径

```bash
# 域清单（48域——含源码路径/规模/平台层/巨型域识别）
cat planning/00-domain-discovery-v3.md

# v5 标准示范（域1 第一篇——最厚最佳——作为标准模板）
cat outlines/01-os-abstraction/01-platform-detection.md

# 方法论文档（完整 v5 规则——教+审+跨层）
cat methodology/zh/01-三层循环框架.md      # 含教学叙事设计6要素

# JDK 源码（三个位置都要读）
/data/workspace/jdk11u/src/hotspot/share/   # HotSpot C++ (Group 1-9)
/data/workspace/jdk11u/src/hotspot/cpu/x86/ # CPU 平台层（别漏）
/data/workspace/jdk11u/src/hotspot/os/      # OS 平台层
/data/workspace/jdk11u/src/hotspot/os_cpu/  # os/cpu 交叉平台层
/data/workspace/jdk11u/src/java.base/       # JDK Native (Group 10)
/data/workspace/jdk11u/src/jdk.hotspot.agent/
/data/workspace/jdk11u/src/java.instrument/
/data/workspace/jdk11u/src/jdk.management/
```

**从域 16 Code Cache 继续。每个域: KP→outlines (逐篇独立文件)→questions。每3域自查密度——对照域1标准示范检查四要素齐全。**
