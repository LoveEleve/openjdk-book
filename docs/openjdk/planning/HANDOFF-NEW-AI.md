# HANDOFF — OpenJDK 源码分析知识规划 (最终版)

> 2026-08-10 | **49/49 域完成 (100%)** | 158 篇大纲 | v5 教学叙事标准
> 新增: 域 00 JVM 工具层(探索前置域)——先用工具再看内部,为写作积累实证
> 全量 Groups 1-11 全部完成 | P0+P1+P2 全部清偿 | 31 修复
> 接收者: 新 AI | 目标: **进入文章写作阶段**

---

## ⚡ 第一个行动

```
1. 读本交接文档
2. 读 00-domain-discovery-v3.md — 49域权威清单(含域 00 工具层)
3. 读 outlines/01-os-abstraction/01-platform-detection.md — v5 标准示范文章
4. 从 §二 每域产出物清单找到任一域 → 读 KP → 读大纲 → 对照方法论展开文章
5. 文章写作: 每域 KP→大纲→文章 → 参见 §一 方法论 §三 Pipeline
```

---

## §零 当前进度

| Group | 域范围 | 域数 | 大纲 | 状态 |
|------|:--|:--:|:--:|:--:|
| 1 核心基础设施 | 01-05 | 5 | 14 | ✅ |
| 2 对象模型 | 06 | 1 | 6 | ✅ |
| 3 类加载与解释 | 07-08 | 2 | 11 | ✅ |
| 4 内存子系统 | 09-11 | 3 | 8 | ✅ |
| 5 执行引擎 | 12-15 | 4 | 17 | ✅ |
| 6 运行时核心 | 16-24 | 9 | 28 | ✅ |
| 7 GC 子系统 | 25-26 | 2 | 13 | ✅ |
| 8 Native 接口 | 27-31 | 5 | 13 | ✅ |
| 9 可观测性 | 32-39 | 8 | 21 | ✅ |
| 10 JDK Native 层 | 40-47 | 8 | 17 | ✅ |
| 11 基础库 | 48 | 1 | 4 | ✅ |
| **合计** | | **49** | **158** | **49/49 (100%)** |

### 已完成域详情表 (49域)

| 00 JVM 工具层 | 6 | 14 | 20 | 🟢 工具探索前置域——JMC/jcmd/MAT/JITWatch/jhsdb/jconsole 六篇,关联 18 个实现域 |

| 域 | 文章 | KP | 提问 | 备注 |
|:--:|:--:|:--:|:--:|------|
| 01 OS 抽象层 | 4 | 23 | 37 | v5 标准示范——含 §05 方案选择(extra chapter) |
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
| 15 C2 | 8 | 16 | 25 | 🔴 巨型域 177K行——03-08重写(v5达标) |
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
| 32 JFR | 6 | 8 | 12 | 🔴 巨型域 217文件——05深化(41→71行) |
| 33 JMX | 3 | 7 | 6 | MemoryService+JMM接口+Notify |
| 34 NMT | 2 | 7 | 6 | MallocTracker+MemReporter |
| 35 DCmd | 2 | 3 | 5 | Framework+~30内置命令 |
| 36 Attach | 2 | 4 | 5 | Socket IPC+JDK Attach API |
| 37 Heap Dumper | 2 | 2 | 8 | hprof format+compression |
| 38 PerfData | 2 | 3 | 8 | mmap shared memory+StatSampler |
| 39 Runtime Monitoring | 2 | 5 | 8 | ServiceThread+Timer |
| 40 Launcher | 2 | 5 | 12 | libjli→LoadJavaVM→InvokeMain |
| 41 ZIP & JIMAGE | 2 | 5 | 12 | Central Directory+MPH mmap |
| 42 Core Native | 3 | 5 | 8 | jni_util+Process+fork→exec+ClassLoader |
| 43 NIO & Net | 3 | 5 | 8 | PlainSocket+epoll+UDP+DNS+inotify |
| 44 Class Verification | 2 | 5 | 8 | ClassVerifier+StackMapTable+9种类型 |
| 45 Math Library | 2 | 5 | 8 | Payne-Hanek+fast_sin+StubRoutines |
| 46 SA Postmortem | 1 | 5 | 8 | core dump→ELF→ptrace→oop iterate |
| 47 Instrumentation | 2 | 8 | 8 | JPLISAgent→JVMTI ClassFileLoadHook |
| 48 Utilities | 4 | 8 | 8 | vmError+ConcurrentHashTable+outputStream+UTF-8 |

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

### 巨型域拆分规则

- 源码 >30000 行或文件 >100 → 巨型域
- 巨型域需拆 6-8 篇
- **分段写作策略**: 先写3-4篇→pause自查(grep四要素)→补齐→再写3-4篇
- 已知巨型域: C2(177K行), G1(46K行), GC Framework(37K行), OOPs(38K行), ClassFile(46K行), JFR(217文件)

---

## §二 目录结构 + 每域产出物

```
planning/
├── 00-domain-discovery-v3.md       ← 49域权威清单(含域 00 工具层)
├── HANDOFF-NEW-AI.md               ← 本文件
├── knowledge-planning/             ← 48个 KP（逐域四章）
├── outlines/                       ← 48个子目录 + 152篇大纲
└── _archive/                       ← 废弃旧版全部文件
```

每个域的标准产出物:
```
knowledge-planning/{编号}-{域}.md      ← 四章: 01提取→02聚合→03分类→04聚类
outlines/{编号}-{域}/                   ← 子目录
├── 01-{标题}.md                        ← v5 教学叙事大纲
├── 02-{标题}.md
├── ...
└── completeness-questions.md           ← ≥5身份全视角验证
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

---

## §四 缺陷档案（关键类型 + 检测方法）

### 文字描述源锚 (最高发)
**检测**: `grep -cP '\(.*\.(hpp|cpp):(?!\d)' outlines/{域}/0*.md` — 任何匹配 → 修复

### grep-only 假审查
grep全绿≠内容没问题。必须逐行Read每篇文章全部内容。

### 跨层不一致
KP说🔴但对应文章标记🟡 — 读KP 🔴表→提取文章编号→grep文章类型→对比

### 巨型域塌方
巨型域(6+篇)初版系统性塌方——必须分段写作(先3-4篇→pause自查→继续3-4篇)

### API推断编造 (新增)
AI凭"通用知识"写实现方式(vfork vs fork, GET_FD vs getFD)——必须grep源码验证

### 实现路径编造 (新增)
AI凭合理推断编造完整实现路径(StrictMath→StubRoutines实际→fdlibm jsin)

### 尾段疲劳
Group最后2-3域一次性产出——每域单独写(不连续)→每域自查→合格才继续

---

## §五 启动命令与准则

```bash
# v5 标准示范文章
cat outlines/01-os-abstraction/01-platform-detection.md

# JDK 源码
/data/workspace/jdk11u/src/hotspot/share/   # HotSpot C++ (Group 1-9)
/data/workspace/jdk11u/src/java.base/       # JDK Native (Group 10)
```

**文章写作准则**:
- 每域从 KP §04 聚类 → 读大纲 → 展开为完整文章
- 大纲40行 → 文章300-500行（扩展场景叙述、填代码片段、加图解）
- 域01第一篇作为标准示范
- 不要一次写多篇——逐篇写完→自查→继续

---

## §六 关键教训（不可忘记）

1. **深审 = 逐行Read ≥ grep统计**: grep全绿≠内容没问题
2. **grep文字描述源锚**: `\(.*\.(hpp|cpp):(?!\d)` — 最高发缺陷类型
3. **巨型域分段写**: 先3-4→pause→自查→继续3-4
4. **Group尾段别赶**: 剩余2-3域时每域单独写
5. **源码验证不可跳过**: AI自写也会编造——不因"自己写的"跳过验证
6. **API推断编造**: 不凭通用知识写实现——必须grep源码

---

## §七 完成态验证清单

```
✅ 48/48 knowledge-planning/*.md 存在
✅ 48/48 outlines/{域}/ 目录存在
✅ 48/48 completeness-questions.md 存在
✅ 全量文字锚 = 0
✅ 全量 KP P1/P2/P3 = 3 (除01=5章v5示范)
✅ 全量 KP 🔴🟡🟢 分级标注存在
✅ 域15 C2 03-08 全部 v5 达标
✅ 域37-39 跨层标注已补齐
✅ 域32 JFR 05 深化完成
```

---

## §八 改动记录

| 日期 | 变更 |
|------|------|
| 2026-08-10 | 初版 (39/48, 134篇) |
| 2026-08-10 | P0 三域完成 (40/41/15-03-08) |
| 2026-08-10 | P1 六域深化 (37-39/32/26/25) |
| 2026-08-10 | P2 七域启动 (42-48) |
| 2026-08-10 | 全量审计14处质量债清偿 (KP章+文字锚+P1P2P3) |
| 2026-08-10 | **最终版: 48/48域, 152篇大纲, 全量达标** |
