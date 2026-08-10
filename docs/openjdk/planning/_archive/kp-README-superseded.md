# knowledge-planning/ — 知识规划目录

> 此目录存放每个域的**知识规划文件**——逐源提取 → 聚合 → 深度分类 → 聚类。
> 这是 Per-Article Outline 的**前置步骤**。此目录必须在写大纲之前完整填充。

---

## 目录结构

```
knowledge-planning/
├── README.md           ← 本文件
├── vol-01/             ← 地基卷 (8域: OS/Assembler/OOPs/Arguments/Logging/PerfData/JavaClasses/JNI)
├── vol-02/             ← 并发卷 (4域: Threads/Safepoint/VM Ops/Synchronization)
├── vol-03/             ← 内存卷 (9域: GC框架/Reference/Heap/Metaspace/SymbolTable/CodeCache/StubRoutines/G1/CDS)
├── vol-04/             ← 执行卷 (10域: ClassFile→Interpreter→VTable→ci→JIT→SharedRuntime→C1→C2→Deopt→MH)
├── vol-05/             ← 可观测卷 (7域: JVMTI/JMX/NMT/Attach/HeapDumper/ServiceThread/JFR)
└── vol-06/             ← JDK Native卷 (5域: Launcher/ZIP-JIMAGE/CoreNative/NIO-Network/SA-Postmortem)
```

## 每卷应包含的文件

每个域对应一个 `.md` 文件，包含完整知识规划：

```
vol-03/20-g1-gc.md
  ## 01 逐源提取 — 从源文件提取知识点
    | Source File | Inferred Knowledge Point | Confidence |
  
  ## 01 聚合 — 跨文件去重
    P1/P2/P3 分级（出现文件数 ≥5 = P1, 2-4 = P2, 1 = P3）
  
  ## 02 深度分类
    🔴 Deep（承载核心设计决策）
    🟡 Working（有设计决策但非核心）
    🟢 Surface（机制性了解即可）
  
  ## 03 聚类 — 教学顺序
    机制边界定义 + 依赖图 + 教学顺序
```

## 当前状态

| 卷 | 域数 | 知识规划 | 说明 |
|------|:--:|:--:|------|
| vol-01 | 8 | ❌ 0/8 | 待从源码逐文件提取 |
| vol-02 | 4 | ❌ 0/4 | 待从源码逐文件提取 |
| vol-03 | 9 | ❌ 0/9 | 最需要——G1 GC 45692行/195文件，必须先知识规划 |
| vol-04 | 10 | ❌ 0/10 | 大纲质量最高但缺知识规划 |
| vol-05 | 7 | ❌ 0/7 | B/C 域，知识规划可简化 |
| vol-06 | 5 | ❌ 0/5 | B 域，知识规划可简化 |

**43 域全部缺少知识规划。优先从 vol-03 的 G1 GC 开始——这是最大的缺口。**

## 格式参考

完整的知识规划格式参考内功修炼目录：
```
/data/workspace/source-code/book/成长之路/tmp-question/程序员从入门到放弃之路/规划/内功修炼/01-OS内核.md
```

源码项目的知识规划方法论：
```
methodology/knowledge-planning/zh/05-源码分析项目的知识规划.md
```
