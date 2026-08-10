# HANDOFF — OpenJDK 源码分析知识规划

> 2026-08-10 | 39/48 域完成 (81.3%) | 134 篇大纲 | v5 教学叙事标准
> Groups 1-9 全部完成 / Group 10-11 剩余 9 域
> 接收者: 新 AI | 目标: 接续完成剩余 9 域

---

## ⚡ 第一个行动

```
1. 读本交接文档（完整方法论 + 当前状态 + 缺陷档案）
2. 读 00-domain-discovery-v3.md — 48域权威清单 + 源码路径
3. 读 outlines/01-os-abstraction/01-platform-detection.md — v5 标准示范
4. 从域 41 ZIP & JIMAGE 继续（域 40 Launcher 已启动未完成——需先补完 40 大纲）
```

---

## §零 当前进度

| Group | 域范围 | 域数 | 文章 | 状态 |
|------|:--|:--:|:--:|:--:|
| 1 核心基础设施 | 01-05 | 5 | 14 | ✅ |
| 2 对象模型 | 06 | 1 | 6 | ✅ |
| 3 类加载与解释 | 07-08 | 2 | 11 | ✅ |
| 4 内存子系统 | 09-11 | 3 | 8 | ✅ |
| 5 执行引擎 | 12-15 | 4 | 13 | ✅ |
| 6 运行时核心 | 16-24 | 9 | 25 | ✅ |
| 7 GC 子系统 | 25-26 | 2 | 13 | ✅ |
| 8 Native 接口 | 27-31 | 5 | 13 | ✅ |
| 9 可观测性 | 32-39 | 8 | 21 | ✅ |
| 10 JDK Native 层 | 40-47 | 8 | 🔄 1域启动(40 Launcher) | ⏳ |
| 11 基础库 | 48 | 1 | ⬜ | ⏳ |
| **合计** | | **48** | **134** | **39/48 (81.3%)** |

### 已完成域详情表 (39域)

| 域 | 文章 | KP | 提问 | 备注 |
|:--:|:--:|:--:|:--:|------|
| 01 OS 抽象层 | 4 | 23 | 37 | v5 标准示范——最厚最佳 |
| 02 Assembler | 4 | 15 | 23 | x86 指令编码域 |
| 03 Arguments & Flags | 2 | 12 | 14 | 纯 C++ 元编程域 |
| 04 Logging | 2 | 13 | 12 | 日志管道域 |
| 05 CPU Primitives | 2 | 9 | 8 | 原子操作+SafeFetch |
| 06 OOPs | 6 | 15 | 13 | 🔴 巨型域 38K行 |
| 07 ClassFile & ClassLoader | 7 | 15 | 8 | 🔴 巨型域 46K行 |
| 08 Interpreter | 4 | 13 | 9 | 解释器+Template |
| 09 Memory 核心 | 3 | 10 | 4 | Unicode/Heap/VirtualSpace/Arena |
| 10 Metaspace | 3 | 9 | 7 | Chunk+Metablock+CDS |
| 11 CDS | 2 | 8 | 5 | Archive+mmap shared |
| 12 ci | 3 | 11 | 6 | JIT 编译数据视图 |
| 13 JIT Framework | 2 | 8 | 5 | CompileBroker+分层编译 |
| 14 C1 | 4 | 11 | 6 | Client compiler pipeline |
| 15 C2 | 8 | 16 | 6 | 🔴 巨型域 177K行——最大域 |
| 16 Code Cache | 5 | 21 | 39 | CodeBlob+nmethod+IC+Deps |
| 17 Threads | 4 | 11 | 25 | 层次+状态机+SMR+Handshake |
| 18 Safepoint | 2 | 3 | 20 | 编排+polling+verifier |
| 19 Synchronization | 4 | 9 | 21 | biased→BasicLock→ObjectMonitor |
| 20 VM Operations | 2 | 4 | 15 | VM_Operation+VMThread+PeriodicTask |
| 21 SharedRuntime | 3 | 6 | 18 | Stubs+c2i/i2c+Exception handling |
| 22 Deoptimization | 2 | 7 | 12 | Reason/Action+unpack+vframeArray |
| 23 StubRoutines | 3 | 5 | 13 | _code1/_code2+arraycopy+crypto |
| 24 Frame & Stack | 3 | 12 | 12 | Physical frame+vframe+deopt scan |
| 25 GC Framework | 6 | 10 | 16 | 🔴 巨型域 37K行 |
| 26 G1 GC | 7 | 11 | 15 | 🔴 巨型域 46K行 |
| 27 JNI | 3 | 6 | 8 | Handle三层+FastPath+Check |
| 28 JVMTI | 3 | 9 | 8 | Agent+RedefineClasses+TagMap |
| 29 MethodHandles | 2 | 3 | 6 | invoke链+x86 adapter |
| 30 JVM Entry | 3 | 6 | 8 | JVM_*API+JavaCalls+Reflection |
| 31 Unsafe | 2 | 3 | 6 | CAS/park+WhiteBox+Forte |
| 32 JFR | 6 | 8 | 10 | 🔴 巨型域 217文件 |
| 33 JMX | 3 | 7 | 6 | MemoryService+JMM接口+Notify |
| 34 NMT | 2 | 7 | 6 | MallocTracker+MemReporter |
| 35 DCmd | 2 | 3 | 5 | Framework+~30内置命令 |
| 36 Attach | 2 | 4 | 5 | Socket IPC+JDK Attach API |
| 37 Heap Dumper | 2 | 2 | 5 | hprof format+compression |
| 38 PerfData | 2 | 3 | 3 | mmap shared memory+StatSampler |
| 39 Runtime Monitoring | 2 | 5 | 3 | ServiceThread+Timer |

### 域 40 状态（已启动，未完成）

**域 40 Launcher**: KP 已写 (40-launcher.md)，2篇大纲已启动：
- `outlines/40-launcher/01-launch-flow.md` (已写)
- `outlines/40-launcher/02-args-platform.md` (已写)
- 还需: completeness-questions + 自查

### 域 41-48 状态（未启动）

| 域 | 名称 | 文件 | 行数 | 预估文章 |
|:--:|------|:--:|:--:|:--:|
| 41 | ZIP & JIMAGE | 17 | ~5400 | 2 |
| 42 | Core Native (libjava) | 77 | ~15000 | 3-4 |
| 43 | NIO & Net | 55 | ~17500 | 3-4 |
| 44 | Class Verification | 4 | ~5000 | 2 |
| 45 | Math Library | 59 | ~6400 | 2 |
| 46 | SA Postmortem | 12 | ~3900 | 1 |
| 47 | Instrumentation | 22 | ~5300 | 2 |
| 48 | Utilities | 101 | ~25400 | 4-5 |

---

## §一 方法论 v5 标准（内联完整版）

### 每篇文章的标准格式

每个机制的段落必须包含四个要素：

```
### N. 机制名 — 一句话描述

场景: [读者为什么要看这个——具体场景，一句话]
[技术描述 + file:line + 函数名]

关键设计 (斜体):
*[为什么这样实现——设计决策、tradeoff]*

[C++: ...] [x86: ...] [内核: ...]   ← 跨层标注（域类型相关）
[JVM Spec: §N]                      ← JVM 规范引用（解析域）
[man N xxx]                          ← man 引用（仅 OS/系统调用域）
```

### 五维检查表

| 维度 | 检查项 |
|:--|------|
| 场景 | 每个 section 开头有"场景:"句？ |
| 源码 | 有 `file:line` + 函数名 + 调用链？（禁止`:key logic`/`:groups`等文字描述） |
| 关键设计 | 有"关键设计"解释 why？ |
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

### 教学叙事设计六要素

1. **读者处境分析** — 读者站在哪里？他已知道什么？
2. **核心叙事线** — 用什么场景/故事串联所有 KP？从简单→复杂→总结
3. **比喻锚点** — 每个 🔴 机制的日常类比
4. **Aha Moment** — 读者读完这篇会突然明白什么？
5. **What→Why→How 顺序** — 先直觉→再原因→最后实现
6. **跨层知识嵌入** — [C++:/x86:/内核:] 标注

### 巨型域拆分规则

- 源码 >30000 行或文件 >100 → 巨型域
- 巨型域需拆 6-8 篇
- **分段写作策略**: 先写3-4篇→pause自查(grep四要素)→补齐→再写3-4篇
- 已知巨型域: C2(177K行), G1(46K行), GC Framework(37K行), OOPs(38K行), ClassFile(46K行), JFR(217文件)

---

## §二 目录结构

```
planning/
├── 00-domain-discovery-v3.md       ← 48域权威清单
├── HANDOFF-NEW-AI.md               ← 本文件（交接文档）
├── knowledge-planning/             ← 逐域KP（40个 .md）
│   ├── 01-os-abstraction.md
│   └── 40-launcher.md
├── outlines/                       ← 逐域大纲（47子目录 + 134篇）
│   ├── 01-os-abstraction/ (4篇)
│   ├── ...
│   └── 40-launcher/ (2篇)
└── _archive/                       ← 废弃旧版全部文件
```

**JDK 源码路径**:
```bash
/data/workspace/jdk11u/src/hotspot/share/     # HotSpot C++ (Group 1-9)
/data/workspace/jdk11u/src/hotspot/cpu/x86/   # CPU 平台层（别漏）
/data/workspace/jdk11u/src/hotspot/os/        # OS 平台层
/data/workspace/jdk11u/src/hotspot/os_cpu/    # os/cpu 交叉平台层
/data/workspace/jdk11u/src/java.base/         # JDK Native (Group 10)
/data/workspace/jdk11u/src/jdk.hotspot.agent/
/data/workspace/jdk11u/src/java.instrument/
/data/workspace/jdk11u/src/jdk.management/
```

---

## §三 Pipeline (每域标准流程)

```
1. 读域发现文档 → 探索源码目录
2. knowledge-planning/{编号}-{域}.md — 四章
   - ## 01 逐源提取: 源文件 → 机制 + Confidence
   - ## 02 聚合: P1(≥5文件)/P2(2-4)/P3(1)
   - ## 03 深度分类: 🔴Deep/🟡Working/🟢Surface（每项含"为什么"）
   - ## 04 聚类: 依赖图 + 教学顺序 + 文章拆分
3. outlines/{编号}-{域}/ — 逐篇 v5 大纲（独立文件）
4. outlines/{编号}-{域}/completeness-questions.md — ≥5身份
5. 自查: grep四要素 + 文字锚检测 + 跨层一致性 + 逐行Read
```

**完成标准（每域必须全做）**:

| 步骤 | 文件名 | 关键检查 |
|:--:|------|------|
| 2 | knowledge-planning/*.md | 四章完整(## 01-04) + P1/P2/P3 + 🔴🟡🟢含"为什么" |
| 3 | outlines/*/0*.md | 每篇: 读者处境 + 场景句(每节) + 源码锚点(file:line) + 关键设计 + [C++/x86] + 核心悬念 + 桥 |
| 4 | outlines/*/completeness-questions.md | ≥5身份/≥8问(普通域)/≥15问(大域)/≥25问(巨型域) |
| 5 | grep自查 | 场景>0, 源码>0, 关键设计>0, 跨层>0, 文字锚=0, KP章节=4, P1P2P3=3 |

---

## §四 缺陷档案（所有已知缺陷类型 + 检测方法）

### A. 尾篇薄度 (Domain 16-17)

**现象**: 域内最后一篇文章（interface/辅助机制类）源码锚点和跨层标注显著低于前几篇。

**检测**: `grep -c '\(.*\.(hpp|cpp):' outlines/*/0*.md | tail -1` — 最后一篇若 < 全域平均 70% → 补全

**历史**: 域16 04(源码2→6)、域17 04(源码2→6)

### B. 尾段薄度 (Domain 18)

**现象**: 文章最后一个 section 比前面薄（~10行 vs 15-20行）

**检测**: 逐行Read每篇→检查最后一个 section 的行数

**历史**: 域18 §3 JNI Critical Native 10→22行

### C. grep-only 假审查 (Domain 20)

**现象**: 只跑 grep 四要素统计，看到数字全绿就宣称"零修复通过"→实际有重复行/源锚缺失/内容省略

**检测**: 必须逐行Read每篇文章全部内容——不是grep statistics

**历史**: 域20 3处grep盲区(编辑残留/源锚缺失/省略18步)

### D. 文章内语义矛盾 (Domain 21)

**现象**: 同一段落内前后两句矛盾（如 "long占两个slot...一个slot"）

**检测**: 逐行读时检查相邻句子的逻辑一致性

**历史**: 域21 02§3 long slots前后矛盾

### E. 跨文章源锚行号冲突 (Domain 22-23)

**现象**: 同一域的不同文章引用同一源文件相同行号范围但描述不同机制

**检测**: `grep -ohP 'file\.(hpp|cpp):\d+-\d+' outlines/{域}/0*.md | sort | uniq -d` — 有重叠 → 验证修正

**历史**: 域22 01+02共用deoptimization.cpp:200-350 / 域23 01:200-350与02:300-600重叠

### F. 文字描述源锚 (Domain 29-35, 高复发 ~13处)

**现象**: 源锚用文字描述(`:key logic`/`:allocate_instance`/`:groups`)而非实际行号

**检测**: `grep -cP '\(.*\.(hpp|cpp):(?!\d)' outlines/{域}/0*.md` — 任何匹配 → 修复为实际行号

**历史**: 域29(3处)/域30(1处)/域31(2处)/域32(7处)/域33(2处)/域35(2处)

### G. KP 章节层级降级 (Domain 26)

**现象**: KP编辑时 ##03 深度分类 被降级为 ###03（成为二级章节的子节）

**检测**: `grep -n '^## 0' knowledge-planning/{域}.md` — 必须输出4行(01-04)

**历史**: 域26 修复P1P2P3时手动补回 ##03

### H. KP P1/P2/P3 省略 (Domain 25-26)

**现象**: KP聚合章节标注"省略（巨型域层级关系明确）"

**规则**: 任何域都不能省略聚合表——即使巨型域也必须P1/P2/P3三表

### I. 跨层类型不一致 (Domain 26)

**现象**: KP说某个KP是🔴但对应文章标记了🟡

**检测**: 读KP 🔴表→提取文章编号→grep文章类型→对比

**历史**: 域26 06-g1-barrier 标记🟡但KP分类🔴 → 统一为🔴

### J. 巨型域初版塌方 (Domain 15/26/32, 3次)

**现象**: 巨型域(6+篇)初版系统性塌方——场景/跨层/源锚全面坍塌

**规则**: 巨型域必须分段写作(先3-4篇→pause自查→继续3-4篇)

**历史**: 域15 C2(348行初版全崩)、域26 G1(348行→重写433行)、域32 JFR(273行→修复292行)

### K. 尾段疲劳 (Group 9 域37-39)

**现象**: Group最后2-3域一次性产出——全部偏薄(缺源锚/关键设计/跨层)

**防御**: Group剩余2-3域时，每域单独写(不连续)→每域自查→合格才继续

### L. 反引号源锚假阴性 (Domain 25/33)

**现象**: 源锚用反引号格式(`file.hpp:100-200`)→grep正则`\(file:line`不匹配→grep显示0

**规则**: backtick是正确的markdown写法——不改变源锚格式。在审查报告中标注"grep假阴性"并人工交叉验证

---

## §五 每域产出物清单

每个域完成后必须存在以下文件：

```
knowledge-planning/{编号}-{域}.md      ← 四章: 01提取→02聚合→03分类→04聚类
outlines/{编号}-{域}/                   ← 子目录
├── 01-{标题}.md                        ← 每篇独立大纲 (v5 教学叙事)
├── 02-{标题}.md
├── ...
└── completeness-questions.md           ← ≥5身份全视角验证
```

---

## §六 启动命令与关键路径

```bash
# 域清单（48域——含源码路径/规模/平台层/巨型域识别）
cat planning/00-domain-discovery-v3.md

# v5 标准示范（域1 第一篇——最厚最佳——作为标准模板）
cat outlines/01-os-abstraction/01-platform-detection.md

# JDK 源码
/data/workspace/jdk11u/src/hotspot/share/   # HotSpot C++ (Group 1-9)
/data/workspace/jdk11u/src/hotspot/cpu/x86/ # CPU 平台层
/data/workspace/jdk11u/src/hotspot/os/      # OS 平台层
```

**Group 10 剩余域**: 域40 Launcher 需补全(2篇大纲+提问+自查)→域41-47逐域推进→域48 Utilities

---

## §七 关键教训（不可忘记）

1. **深审 = 逐行Read ≥ grep统计**: grep全绿≠内容没问题。必须逐行读每篇文章全部内容。
2. **grep '***.hpp|*.cpp***:': **检测文字描述源锚（如`:key logic`非`:40-250`）
3. **grep '^## 0'***: **检测KP章节层级降级
4. **巨型域分段写**: 先3-4→pause→自查→继续3-4。不要一次写完6+篇
5. **Group尾段别赶**: 剩余2-3域时每域单独写，不连续产出
6. **源锚格式**: 统一用反引号 `file:line`——这是正确的markdown写法。grep检测用宽松模式
7. **零修复域不=零问题**: 连续零修复后审查深度会递减——保持逐行read
8. **同域跨文章源锚不能重叠**: 写完所有文章后grep对照源文件引用范围
