# Vol-02 深度面试与推演题

这不是 HotSpot 名词问答，也不是把“什么是 GC”“什么是 safepoint”换一种方式再问一遍。

本题库面向需要解释源码、定位现象、判断约束和做设计取舍的高级工程师。每道题都要求完成一条闭环：

```text
现象
  → 约束
  → 角色与状态
  → 源码调用链
  → 反事实推演
  → 可验证实验
```

## 版本边界

- 基线：OpenJDK 11u。
- 具体平台默认以 Linux / x86_64 为主。
- 题目中的类名、函数名和源码位置应以对应文章和当前源码树为准。
- JDK 17/21 的结构变化不能直接套用本题答案。

## 如何使用

不要先看答案再背结论。建议每题先在纸上写出：

1. 这套机制试图保护什么不变量；
2. 谁在什么时刻拥有修改权；
3. 哪一步必须停顿、加锁、进入 VM 或依赖 safepoint；
4. 如果删除其中一个状态、队列或索引，最先坏在哪里；
5. 如何用日志、WhiteBox、jcmd、JFR、gdb 或最小程序证明判断。

回答达到专家水平，至少要包含：

- 一个具体源码入口和至少一个精确 `file:line`；
- 一条跨文件调用链；
- 一个失败方案及失败原因；
- 一个边界条件；
- 一个可执行验证方案。

当前首批文件是“高难度问题提纲”，不是标准答案卷。后续每组题目应继续补充独立的 `answers.md`，内容包括：结论、源码证据、关键不变量、常见误答、追问分支、验证实验和评分锚点。只有题目与答案都完成后，才算该主题真正收官。

## 题库导航

- [00 · 烂大街问题，专家级答案：JVM 基础面试题](00-fundamentals-expert/README.md) — 常见 JVM 面试题，以专家级深度回答，而非八股

### 第一批：HotSpot 核心主线

- [01 · 对象、内存与 GC](01-object-gc/README.md) — 高难度题目提纲已建立，答案卷待补
- [02 · 线程、Safepoint 与同步](02-thread-safepoint/README.md) — 高难度题目提纲已建立，答案卷待补
- [03 · 解释器、JIT、帧与 CodeCache](03-interpreter-jit-codecache/README.md) — 高难度题目提纲已建立，答案卷待补
- [04 · JNI、JVMTI、JFR 与诊断](04-jni-jvmti-diagnostics/README.md) — 高难度题目提纲已建立，答案卷待补

### 第二批：OpenJDK 全景主题

第二批不是第一批的重复拆分，而是补足外围知识与边界专题：

- `01-object-gc` 关注对象头、引用关系、RSet 和 GC 不变量；`13-memory-metaspace` 关注地址空间、分配器、Metaspace/Chunk 和 CDS 映射。
- `04-jni-jvmti-diagnostics` 关注 VM 内部如何发布和恢复状态；`11-performance-production` 关注如何从线上现象选择观测手段并反推实现。
- `03-interpreter-jit-codecache` 关注执行协议；`14-jvmci-graal` 关注替代编译器如何接入这条协议。
- `02-thread-safepoint` 关注 VM 线程协调；`16-jmm-varhandle` 关注 Java 语言内存模型与库层并发语义。
- `08-tools-launcher-attach` 关注工具如何进入 JVM；`17-vm-lifecycle-shutdown` 关注 JVM 如何建立、运行并结束。
- `01-object-gc` 关注对象与 GC 工作集；`18-references-finalization` 关注引用处理器如何决定对象生命周期的最后阶段。

以下主题仍需保持边界意识：`07-jdk-libraries-modules` 只提供类库与 VM 的连接面，不等于覆盖完整 Java 类库；`16-jmm-varhandle` 不等于覆盖 `java.util.concurrent` 的所有实现；`06-gc-collectors` 的规划覆盖面大于当前 Vol-02 正文中已深入的 G1。

- [05 · 类加载、链接与 CDS](05-classloading-cds/README.md) — 目录已建立，题目待填充
- [06 · GC 收集器与回收策略](06-gc-collectors/README.md) — 目录已建立，题目待填充
- [07 · JDK 类库、模块与运行时资源](07-jdk-libraries-modules/README.md) — 目录已建立，题目待填充
- [08 · 启动器、工具与 Attach 体系](08-tools-launcher-attach/README.md) — 目录已建立，题目待填充
- [09 · 平台、构建与可移植性](09-platforms-build-portability/README.md) — 目录已建立，题目待填充
- [10 · 安全、验证与运行时约束](10-security-verification/README.md) — 目录已建立，题目待填充
- [11 · 性能、可观测性与生产故障](11-performance-production/README.md) — 目录已建立，题目待填充
- [12 · OpenJDK 工程实践与源码推理](12-openjdk-engineering/README.md) — 目录已建立，题目待填充
- [13 · 内存分配、Metaspace 与 CDS 内存模型](13-memory-metaspace/README.md) — 目录已建立，题目待填充
- [14 · JVMCI、Graal 与替代编译器路径](14-jvmci-graal/README.md) — 目录已建立，题目待填充
- [15 · 异常、反射、StackWalk 与运行时调用边界](15-exceptions-reflection/README.md) — 目录已建立，题目待填充
- [16 · Java 内存模型、VarHandle 与并发原语](16-jmm-varhandle/README.md) — 目录已建立，题目待填充
- [17 · JVM 生命周期、初始化与退出](17-vm-lifecycle-shutdown/README.md) — 目录已建立，题目待填充
- [18 · ReferenceProcessor、Finalizer 与对象生命周期](18-references-finalization/README.md) — 目录已建立，题目待填充

## 面试官使用方式

### 判断“背过”还是“理解了”

先问主问题，再沿追问树连续改变一个约束：

- 把并发改成单线程；
- 把 Young GC 改成 Mixed GC；
- 把解释执行改成 C2 编译；
- 把活 JVM 改成 core；
- 把启动 agent 改成运行时 attach；
- 把 Linux/x86_64 改成另一个平台；
- 把正常路径改成失败、超时、竞争或重入路径。

如果答案只会复述正常路径，说明还没有理解机制的边界。

### 评分维度

| 维度 | 不合格 | 合格 | 专家级 |
|---|---|---|---|
| 事实 | 背 API 或类名 | 能说出主要流程 | 能落到源码入口和真实状态 |
| 因果 | 只说“为了性能/安全” | 能说出直接原因 | 能说明约束、替代方案和代价 |
| 并发 | 忽略线程时序 | 能说出锁或 barrier | 能解释发布、可见性、重入和失败恢复 |
| 版本 | 把 JDK 8/11/21 混用 | 知道存在差异 | 能指出差异改变了哪条调用链 |
| 验证 | 没有验证 | 能给出命令 | 能设计最小实验并预测现象 |

## 关联正文

题目不替代正文。先用 [卷 2 首页](../README.md) 选择阅读路线，再回到对应专题文章核对源码证据。
