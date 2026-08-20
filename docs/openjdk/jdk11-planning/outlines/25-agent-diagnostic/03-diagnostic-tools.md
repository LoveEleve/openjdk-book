# 03. 诊断工具族与生产规范 — jcmd/jstack/jmap、排查流程

> 🟡 Working | 域 25 Agent 与诊断第 3 篇 | Layer 5
> 读者处境: 生产排查——每个工具看什么、怎么用,完整排查流程。

### 1. "工具全家桶" — 各自的用途

场景: 线上出问题——先用哪个工具?

- `jcmd <pid> help`: **命令大全**(万能入口,所有 JVM 命令)
- `jstack`(JStack.java:117 attach): 线程 dump——**看线程状态/死锁/阻塞**
- `jmap`: 堆 dump/堆直方图——**看内存对象**
- `jstat`: GC/类加载统计——**看 GC 趋势**
- `jps`: 找进程;`jinfo`: JVM 参数
- 关键设计 (斜体): *"工具分工 = 问题维度"——线程(jstack)/内存(jmap)/GC(jstat)/参数(jinfo);面试"线上卡顿先用什么"——jstack 看线程,再 jmap 看内存*
- 生产: 顺序: jps 找进程 → jstack 看线程 → jstat 看 GC → jmap 看对象

### 2. "jcmd 的命令体系" — 万能入口

场景: jcmd 能执行什么?

- 命令分类: JFR(JFR.start/dump/stop,域 39)/GC(GC.class_histogram/GC.heap_dump)/线程(Thread.print)/VM(VM.flags/VM.system_properties)
- 与 jstack/jmap 的关系: jcmd Thread.print = jstack;jcmd GC.heap_dump = jmap -dump
- 内部: 全部走 attach execute(域 25 第 1 篇)
- 关键设计 (斜体): *"jcmd 是诊断的统一入口"——JDK 8+ 推荐 jcmd 优先;面试"jcmd vs jstack"——jcmd 更全(jstack 是其子集)*
- 生产: `jcmd pid help` 看可用命令——记忆负担最小化
- [关联: 域 39 JFR(jcmd 操作);域 34 DiagnosticCommand 同源]

### 3. "jstack 实战" — 线程问题排查

场景: CPU 飙高——jstack 怎么定位?

- 步骤: `top -Hp pid` 找高 CPU 线程 tid → `printf '%x' tid` 转十六进制 → `jstack pid | grep -A20 nid=0x...`
- 看什么: RUNNABLE(在跑什么代码)/BLOCKED(等锁,死锁检测)/WAITING(等事件)
- 死锁: jstack 自动检测(Found one Java-level deadlock)
- 关键设计 (斜体): *"jstack = 线程快照"——与 JFR 的持续录制互补(域 39);面试"CPU 高怎么查"——top+jstack 定位代码行*
- 生产: 多次 dump(间隔几秒)看线程是否卡死(域 12 死锁)
- [关联: 域 11 线程状态;域 12 死锁]

### 4. "排查流程规范" — 生产 SOP

场景: 完整的问题排查路径

1. **jps/jcmd** 确认进程与 JVM 版本
2. **jstack** 线程 dump(多次)——CPU/死锁/阻塞
3. **jstat** GC 统计——GC 频率/耗时(内存问题先兆)
4. **jmap** 堆直方图/堆 dump——大对象/泄漏(配合 MAT 分析,域外)
5. **JFR** 持续录制——事件回放(域 39)
- 关键设计 (斜体): *"诊断 = 多工具组合"——快照(jstack/jmap)+趋势(jstat)+回放(JFR);面试"排查思路"——按维度组合*
- 生产: 工具是"最后一公里",指标监控(域 34/39)先行
- [关联: 域 34/39 可观测性;内部卷 00-jvm-tools]

---

### 核心悬念

诊断工具收官——**异步编程的最终章**来了: `ForkJoinPool` 的 work-stealing、`CompletableFuture` 的编排魔法。这是 25 域规划的终点(域 15)——下一篇: 异步编程。

> → 下一篇: 域 15 异步编程(15-async 系列,最终域) | 关联: 域 14 线程池
