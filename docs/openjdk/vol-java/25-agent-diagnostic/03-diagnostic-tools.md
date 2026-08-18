# 03. 诊断工具族与生产规范 — jcmd/jstack/jmap、排查流程

> **前置依赖**: [25-agent-diagnostic/01 — Attach 机制](01-attach-mechanism.md)(attach 通道)、[25-agent-diagnostic/02 — Instrumentation](02-instrumentation.md)(agent 能力)
> → **后续**: 域 32 Unsafe 与本地内存(按写作顺序)
> 关联: [34-jmx/06 — JMX 生产实践](../34-jmx/06-production-practice.md)(远程管理)、[39-jfr/06 — JFR 生产实践](../39-jfr/06-production-practice.md)(持续录制)

## 出问题时先拿什么看

诊断工具不是同一个东西换不同名字,而是按问题维度分工: 线程、堆、GC、参数、持续事件回放。

## 1. "工具全家桶" — 各自的用途

### 1.1 命令入口

- `jcmd`(`sun/tools/jcmd/JCmd.java:52`)——统一入口
- `jstack`(`sun/tools/jstack/JStack.java:43`)——线程快照
- `jmap`(`sun/tools/jmap/JMap.java:49`)——堆直方图/heap dump
- `jstat`(`sun/tools/jstat/Jstat.java:44`)——GC/类加载统计趋势

### 1.2 维度分工

- 线程卡顿/死锁/高 CPU → 先 `jstack`
- 内存膨胀/对象分布 → `jmap`
- GC 频率、晋升、停顿趋势 → `jstat`
- 命令全集与一站式入口 → `jcmd`

关键设计(斜体):*"工具分工 = 问题维度"——线程看栈,内存看堆,GC 看趋势,命令入口统一到 jcmd。面试"线上卡顿先用什么": 通常先 jstack,再看 jstat/jmap。*

## 2. "jcmd 的命令体系" — 万能入口

### 2.1 attach 客户端

`JCmd.main`(`JCmd.java:52`)最终会 `VirtualMachine.attach(pid)`(`:114`) 连接目标 JVM,再通过 attach 命令通道执行诊断命令。

这让 `jcmd` 成为统一入口: JFR、线程、GC、VM 参数都能从这里下发。

### 2.2 与其他工具关系

- `jcmd Thread.print` 与 `jstack` 在“线程快照”维度重合
- `jcmd GC.heap_dump` / `GC.class_histogram` 与 `jmap` 的功能交叉
- `jcmd pid help` 可以列出目标 JVM 当前支持的命令集合

关键设计(斜体):*"jcmd = 诊断的统一入口"——能力来自 Attach + 目标 JVM 命令执行,不是硬编码在客户端里。面试"jcmd vs jstack": jcmd 更像总控台,jstack 是专用前端。*

## 3. "jstack 实战" — 线程问题排查

### 3.1 定位高 CPU 线程

`JStack.main`(`JStack.java:43`)同样通过 `VirtualMachine.attach(pid)`(`:117`)连到目标 JVM。生产常见路径是:

1. `top -Hp <pid>` 找高 CPU 线程
2. 把线程号转十六进制
3. 用 `jstack` 查对应 `nid=0x...` 的 Java 栈

### 3.2 看什么

- `RUNNABLE`——在跑什么代码
- `BLOCKED`——卡在锁竞争
- `WAITING/TIMED_WAITING`——等待条件、IO、sleep、park
- 自动死锁检测——直接给出 Java 级死锁

关键设计(斜体):*"jstack = 线程快照"——它不告诉你趋势,但能告诉你“这一刻线程都在干什么”。生产常常多次采样对比,而不是只看一次 dump。*

## 4. "排查流程规范" — 快照 + 趋势 + 回放

### 4.1 一条常用 SOP

1. `jps/jcmd` 确认目标进程与版本
2. `jstack` 连续多次 dump——看线程状态、锁与热点代码
3. `jstat` 观察 GC 趋势——看频率、代际变化、是否异常抖动
4. `jmap` 看直方图/heap dump——分析大对象与泄漏路径
5. `JFR` 持续录制——补足快照之外的事件回放

### 4.2 工具组合

- `jstack/jmap` 偏**快照**
- `jstat` 偏**趋势**
- `JFR` 偏**持续回放**
- `JMX` 偏**远程管理与监控接口**

关键设计(斜体):*"诊断 = 多工具组合"——快照解决“现在怎么了”,趋势解决“最近一直怎样”,回放解决“刚才发生了什么”。面试"排查思路": 按维度组合,不要迷信单工具。*

## 本域收官

域 25 到这里收官: Attach 负责接通管理通道,Instrumentation 负责热增强能力,工具族负责把这些能力变成生产排查动作。下一步按写作顺序进入 Unsafe 与本地内存。