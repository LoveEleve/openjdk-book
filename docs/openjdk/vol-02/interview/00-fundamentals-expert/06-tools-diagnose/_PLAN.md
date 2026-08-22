# 06-tools-diagnose · JVM 工具与故障排查

## 覆盖域（vol-02）

`36-attach`（AttachListener/Attach API）、`35-dcmd`（DCmd Framework）、`37-heap-dumper`（HeapDumper）、`38-perfdata`（PerfData）、`34-nmt`（NMT）、`32-jfr`（JFR Recorder）、`33-jmx`（MemoryService/JMM）、`46-sa-postmortem`（SA）、`48-utilities`（vmError）、`08-tools-launcher-attach`（intervie 域）、`11-performance-production`（intervie 域）

## 题目清单

1. attch 是怎么工作的？——文件 + SIGQUIT 双条件触发；Unix domain socket；按需启动
2. jcmd 和 jmap 的命令怎么进入 JVM？——AttachListener → DCmd::parse_and_execute
3. JFR 为什么开销低？——per-thread buffer + `_pos`/`_top` 双指针；无锁写入
4. 什么是 NMT？怎么追踪 native 内存？——`MallocHeader` 嵌入所有 `os::malloc`；summary 原子计数，detail 加 call-site 表
5. 什么是 PerfData？jstat 为什么能跨进程读？——共享布局协议；`mmap` 读不打扰 JVM
6. hs_err 文件怎么读？——first-error CAS、STEP 流水线、Decoder 安全模式；可查到的走 Java NPE，查不到的走 crash
7. `jstack` 和 `jmap` 在 safepoint 内做什么？——HeapDumper 是 VM_Operation：`ensure_parsability` → 可选 Full GC → 并行写
8. jstack 的线程状态（RUNNABLE/BLOCKED/WAITING/TIMED_WAITING）怎么看？—— 线程状态 vs 操作系统状态；`monitor` 等待 vs `park` 等待；死锁环标识
9. CPU 飙高怎么排查？——`top -H` 找线程 → `jstack` 看对应栈帧 → 热点代码/GC 线程/轮询
10. 内存飙高/泄漏怎么排查？——`jmap -histo` 看对象计数 → `jmap -dump` 取堆 → MAT 分析；`GC overhead limit exceeded`
11. 线程有哪六种状态？与 `Thread.State` 怎么对应？——`NEW/RUNNABLE/BLOCKED/WAITING/TIMED_WAITING/TERMINATED`；`RUNNABLE` 覆盖 OS 的 running+ready

## 回答框架提示

本组是"烂大街"里最容易漏的——很多面试者没用过 NMT/JFR/PerfData，只背过 JDK 工具的名字。进程/OS 视角：去看 `/proc/<pid>/smaps` 和 NMT 的对应关系；`jstat` 不走 socket 直接 mmap 共享区。版本差异：JDK 9 后 RMI 不再周期调 `System.gc()`；JDK 11 的 JFR 默认可用。

## 常见高概率追问

- "你线上遇到过 CPU 100% 吗？怎么确认是不是 GC 引起的？" → 先看 GC 日志，再 `top -H`+jstack 交叉验证
- "堆快照文件太大打不开怎么办？" → `jmap -dump:live` 先 Full GC 减体积；`-XX:HeapDumpPath`；MAT 只加载需要部分

## 回答框架提示

本组是"烂大街"里最容易漏的——很多面试者没用过 NMT/JFR/PerfData，只背过 JDK 工具的名字。进程/OS 视角：去看 `/proc/<pid>/smaps` 和 NMT 的对应关系；`jstat` 不走 socket 直接 mmap 共享区。版本差异：JDK 9 后 RMI 不再周期调 `System.gc()`；JDK 11 的 JFR 默认可用。