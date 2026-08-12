# HANDOFF — OpenJDK 源码分析 — 全量知识规划重做
> ⚠️ **已废弃(规划期文档,2026-08-12 起)**: 写作阶段唯一交接入口是 `../SESSION-HANDOFF.md`,本文件仅作规划历史参考。

> 2026-08-08 v4 | 域发现已从头重做（48 域，v3.3）| §零 方法论不变 | §一→§三 已更新
> **从域 01 OS 抽象层开始逐源提取，48 域全做，一个不漏。**

---

## ⚡ 第一个行动

```
步骤 1: 读本交接文档的 §零（完整方法论规则）
步骤 2: 读 00-domain-discovery-v3.md — 48 域权威清单（含源码路径/规模/平台层）
步骤 3: 读格式参考 — knowledge-planning/ 目录内格式模板
步骤 4: 从域 01 OS 抽象层开始 — 逐源提取
```

---

## §零 必须遵守的完整方法论文档

> 以下规则从方法论文档完整提取。新 AI 不需要先去读方法论文档——本手册即执行标准。

### 0.1 正确流程 vs 前 AI 的错误流程

```
正确流程:
  域发现 → 知识规划(逐源提取→聚合→深度分类→聚类) → 方案选择 → 书级规划 → Per-Article Outline
           ↑ 前 AI 从这里跳过了

错误流程（前 AI 做的）:
  域发现 → 方案选择 → Per-Article Outline
```

**为什么不能跳**：域发现告诉你"G1 GC 是一个域"——但 G1 GC 有 45692 行源码 / 195 个文件。不先做逐源提取→聚合→分类→聚类，就无法判断一个域该拆成多少篇文章、每篇覆盖什么。前 AI 的 G1 GC 只有 1 篇 57 行大纲就是跳步的后果。

### 0.2 知识规划四步法（knowledge-planning/05 — 源码项目版）

#### 第一步：逐源提取

从每个源文件/核心类提取机制（知识点的源码等价物）。

```
产出格式:
| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| heapRegion.hpp:191 | HeapRegion — G1 堆分配基本单元 | High |
| g1ConcurrentMark.hpp | SATB 并发标记算法 | High |
| g1Policy.hpp | GC 周期编排与预测模型 | Medium |
```

**置信度**：
- High: 从类声明/方法体直接读取
- Medium: 从类名推断但未读方法体验证
- Low: 从类名猜测，需后续读源码确认

**什么算机制**：独立的数据结构设计、算法实现、跨组件交互协议。
**什么不算**：getter/setter、纯工具类（如 GrowableArray）、构建配置。

#### 第二步：聚合（跨文件去重）

```
同一机制出现在 ≥5 个文件 → P1（系统级共识）
同一机制出现在 2-4 个文件 → P2（局部重要）
同一机制仅在 1 个文件 → P3（评估是否为独立知识点）
```

#### 第三步：深度分类

```
🔴 Deep: 承载核心设计决策的机制
🟡 Working: 有设计决策但非核心
🟢 Surface: 机制性了解即可
```

判断标准（来自 methodology/03-分析深度标准）：
- 必须深挖：数据结构选择、并发策略、内存管理策略、压缩/编码选择、异常处理策略
- 可以跳过：getter/setter、日志打印、纯转发 delegate
- 深度不足信号：描述全是"做了什么"没有"为什么这样做"

#### 第四步：聚类（教学顺序）

按概念依赖排序。画出域内依赖图。确定文章拆分边界。

```
示例 — G1 GC 聚类：
  Cluster A: Region 模型 (6 KP) — 无前置依赖
  Cluster B: Young GC (5 KP) — 依赖 A
  Cluster C: 并发标记 (8 KP) — 依赖 A+B
  Cluster D: RSet + Refinement (6 KP) — 依赖 A+C
  Cluster E: Mixed GC + Full GC (7 KP) — 依赖全部

  教学顺序: A → B → C → D → E
  拆分: A+B = 1篇, C = 1篇, D = 1篇, E = 1篇...
```

### 0.3 巨型域拆分规则

**判定条件**: 源码行数 ≥ 30000，或文件数 ≥ 100，或聚类后自然产生 8+ 个子主题。

**OpenJDK 中的巨型域**（详见 `00-domain-discovery-v3.md` 巨型域汇总）:

| 域 | 源码量 | 应拆分 |
|:--:|:--:|:--:|
| C2 Compiler (域15) | ~176,000行/136文件 | 8-10 篇 |
| G1 GC (域26) | ~46,000行/197文件 | 8-10 篇 |
| GC Framework (域25) | ~37,000行/184文件 | 8 篇 |
| OOPs (域6) | 38,424行/87文件 | 6-8 篇 |
| ClassFile (域7) | 46,169行/75文件 | 6-8 篇 |
| JFR (域32) | 34,828行/217文件 | 6-8 篇 |
| Assembler (域2) | ~28,200行 | 评估（接近阈值） |

**巨型域要求**: 每篇独立知识规划文件。每篇至少 30 个知识点。每篇独立验证。

### 0.4 知识规划产出格式

每个域的知识规划文件必须包含四个章节：

```markdown
# 域名称 — 知识规划

> 源码路径: xxx | 源码量: xxx 行/xxx 文件

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| ... | ... | ... |

*N 个知识点*

## 01 聚合 — 跨文件汇总

### P1 — 系统级共识 (≥5 文件)
| KP | 出现文件 |
|----|---------|

### P2 — 局部重要 (2-4 文件)
| KP | 出现文件 |

### P3 — 孤立 (1 文件)
| KP | 文件 |

## 02 深度分类

### 🔴 Deep
| KP | 为什么🔴 |
|----|---------|

### 🟡 Working
| KP | 说明 |

### 🟢 Surface
| KP | 放在哪 |

## 03 聚类

### Cluster A: {名称} (N KP)
- KP1, KP2, ...

### Cluster B: {名称} (N KP)
依赖: Cluster A

### 教学顺序
A → B → C → D → E

### 文章拆分建议
每 Cluster 对应 1-2 篇文章
```

### 0.5 Per-Article Outline 格式 — TOC 格式

基于知识规划产出的大纲，**必须是 TOC 格式，不能是叙事散文**。

```markdown
# 域名称 — 大纲

### 1. 核心机制 — 一句话描述
  - 子项 — 解释 (SourceFile.java:NNN)
  - 子项 — 解释 (SourceFile.java:NNN)

### 2. 机制二 — 一句话描述
  - 子项 (SourceFile.java:NNN)

---
### 核心悬念
"一句话的核心问题"
```

**禁止**：叙事散文格式（"概念依赖链"/"叙事顺序"/"问题引入"/"收束"等章节）。
**必须**：分层编号 + 简短描述 + 源码锚点内联 + 核心悬念。

### 0.6 最终产出物标准

每阶段完成时必须存在的文件：

**规划阶段**:
```
knowledge-planning/{域编号}-{域名称}.md  ← 知识规划（四章完整）
outlines/{域编号}-{域名称}.md            ← Per-Article Outline（TOC 格式）
```

**巨型域额外**:
```
outlines/{域编号}-{域名称}/01-{标题}.md
outlines/{域编号}-{域名称}/02-{标题}.md  ...
```

### 0.7 不要做的

- ❌ 不要跳过任何域——48 域全做，从域 01 开始
- ❌ 不要漏掉 Group 10 的 JDK Native 域（源码不在 hotspot/share/ 下，在 java.base/ 等模块）
- ❌ 不要写成叙事散文——知识规划是表格格式
- ❌ 不要在旧大纲上修补——从头做知识规划
- ❌ 不要相信前 AI 的 🔴/🟡 分类（所有分类必须由逐源提取重新验证）
- ❌ 不要只看 share/ 层——每个域必须检查 cpu/x86 和 unix/linux 平台层

---

## §一 域清单 → 见 `00-domain-discovery-v3.md`（48 域）

> **旧 43 域清单已废弃**。v3.3 域清单基于：
> - 5 Agent 并行深审（48 项结构性发现）
> - runtime/ 173 文件逐文件归属验证
> - BUILD 系统交叉验证（773 .cpp vs 域清单）
> - FINAL 全树扫描（13 个 JDK 模块逐模块检查）
> - 6 轮递进审查收敛至零遗漏

**48 域分级概览**（详细源码路径/规模/聚类见 `00-domain-discovery-v3.md`）：

### 一、核心基础设施（6 域）
1. OS 抽象层 | 2. Assembler | 3. Arguments & Flags | 4. Logging | 5. CPU Primitives [新建] | 48. Utilities & Infrastructure [新建]

### 二、对象模型（1 域）
6. OOPs 🔴

### 三、类加载与解释（2 域）
7. ClassFile & ClassLoader 🔴 | 8. Interpreter

### 四、内存子系统（3 域）
9. Memory 核心 | 10. Metaspace | 11. CDS

### 五、执行引擎（5 域）
12. Compiler Interface (ci) | 13. JIT Framework | 14. C1 编译器 | 15. C2 编译器 🔴 | 16. Code Cache

### 六、运行时核心（8 域）
17. Threads | 18. Safepoint | 19. Synchronization | 20. VM Operations | 21. Shared Runtime | 22. Deoptimization | 23. Stub Routines | 24. Frame & Stack Walking [新建]

### 七、GC 子系统（2 域）
25. GC Framework 🔴 | 26. G1 GC 🔴

### 八、Native 接口（5 域）
27. JNI | 28. JVMTI | 29. Method Handles | 30. JVM Entry Points | 31. Unsafe & WhiteBox & Forte

### 九、可观测性（8 域）
32. JFR 🔴 | 33. JMX & Management | 34. NMT | 35. Diagnostic Commands | 36. Attach API | 37. Heap Dumper | 38. PerfData | 39. Runtime Monitoring

### 十、JDK JVM 运行时 Native 层（8 域）
40. Launcher (libjli) | 41. ZIP & JIMAGE | 42. Core Native (libjava) | 43. NIO & Net | 44. Class Verification | 45. Math Library | 46. SA Postmortem | 47. Instrumentation Agent

---

## §二 现有资产

| 文件 | 用途 |
|------|------|
| `00-domain-discovery-v3.md` | **48 域权威清单** — 含源码路径/规模/平台层/巨型域/变更记录 |
| `knowledge-planning/` | 空目录，待填 48 域知识规划文件 |
| `outlines/` | 空目录，待填 48 域 TOC 大纲 |
| `_archive/` | 全部旧版文件（v2 域发现、旧 43 域大纲、旧知识规划） |
| `planning/_archive/G1-GC-completeness-questions.md` | 79 题全视角验证 — G1 知识规划完成后参考 |

---

## §三 启动命令

```bash
# JDK 源码（三个位置都要读！）
/data/workspace/jdk11u/src/hotspot/share/     # HotSpot C++ (Group 1-9)
/data/workspace/jdk11u/src/hotspot/cpu/x86/   # CPU 平台层（每个域的镜像——别漏）
/data/workspace/jdk11u/src/hotspot/os/        # OS 平台层
/data/workspace/jdk11u/src/hotspot/os_cpu/    # os/cpu 交叉平台层
/data/workspace/jdk11u/src/java.base/          # JDK Native (Group 10)
/data/workspace/jdk11u/src/jdk.hotspot.agent/  # SA Postmortem
/data/workspace/jdk11u/src/java.instrument/    # Instrumentation Agent
/data/workspace/jdk11u/src/jdk.management/     # JMX Native 桥接

# 域清单（48 域）
/data/workspace/source-code/openjdk-book/docs/openjdk/planning/00-domain-discovery-v3.md

# 知识规划 + 大纲目录（空，待填充）
/data/workspace/source-code/openjdk-book/docs/openjdk/planning/knowledge-planning/
/data/workspace/source-code/openjdk-book/docs/openjdk/planning/outlines/

# 方法论文档
/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/talk-method/source-code-analysis/methodology/zh/
/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/talk-method/knowledge-planning/methodology/zh/
```

**从域 01 OS 抽象层开始逐源提取。48 域全做，一个不漏。每个域必须同时检查 share/ + cpu/x86 + os/ + os_cpu/ + unix/linux 平台层。**
