# 02. jcmd 可以做什么？— 内置命令详解

> 🟡 Working | 1 KP 中的命令清单
> 读者处境: jcmd 有 ~30 个 DCmd——从 VM.version(版本信息)到 GC.run(触发GC)到 Thread.print(线程dump)——每个命令都是 DCmd 子类。

### 1. "高频命令"

场景: `jcmd <pid> VM.flags` — 查询所有 JVM flags→`jcmd <pid> VM.set_flag PrintGC true` — 运行时改 flag。

**核心 DCmd 列表** (`services/diagnosticCommand.hpp:40-300`):
```
VM:
  VM.version     → JVM 版本信息
  VM.flags       → 所有 JVM flags(含 -XX:)
  VM.uptime      → JVM 运行时间
  VM.set_flag    → 运行时改 flag(可写的 flags)
  VM.system_properties → Java 系统属性

Thread:
  Thread.print   → 所有 Java 线程栈 dump(含 native frames)

GC:
  GC.run         → 触发 Full GC(java.lang.System.gc())
  GC.class_histogram → 全堆类 histogram(实例数+字节数)

NMT:
  VM.native_memory → NMT 报告(summary/detail/baseline/diff)

JFR:
  JFR.start/stop/dump/check → JFR recording 控制
```
- 源码: `services/diagnosticCommand.hpp:40-300` + `diagnosticCommand.cpp:50-800`
- 关键设计: 大部分 DCmd 是 thin wrapper on existing VM functions——`GC.run` → `Universe::heap()->collect(GCCause::_dcmd_gc_run)`。`VM.flags` → iterate Flag::flags table→print each
- [C++: `DCmdWithParser` 是带参数的 DCmd 子类(out+help)。`VM.set_flag` 通过 `WriteableFlags::set_flag(name, value)`(域33)实现——修改 JVM 内标志 at runtime]

### 2. "jcmd 与 JMX 的区别"

场景: 线上 JVM CPU 100% — 需要快速诊断。jcmd 本地 attach(无网络端口)比 JMX 远程连接更快更安全。

| jcmd | JMX |
|------|------|
| JVM 本地 attach | 远程 JMX connection(port based) |
| DCmd text protocol | JMX MBean operations |
| 低开销(attach via signal/thread_db) | 高开销(RMI/TCP+authentication) |
| 用于快速诊断 | 用于监控集成 |

---

### 核心悬念

**"jcmd ~30 内置 DCmd——VM/Thread/GC/NMT/JFR 五大类。DCmd 是 thin wrapper on existing VM functions。"** — 下一篇: 域36 Attach。

> → 域36 Attach
