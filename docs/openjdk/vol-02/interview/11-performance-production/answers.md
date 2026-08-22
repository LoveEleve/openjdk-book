# 11 · 性能、可观测性与生产故障：专家答案锚点

## 1. 堆内 vs 堆外需要不同的观测手段

GC 日志只覆盖堆内（Java heap）的分配、晋升和回收周期。堆外增长（线程栈、CodeCache、Metaspace、GC 辅助结构、JNI 分配、DirectBuffer）不受 GC 管理，必须用 NMT 观测。

NMT 的难点在于它必须在启动时通过 launcher 环境变量（`src/java.base/share/native/libjli/java.c:858`）开启——运行期无法补开。`MallocHeader`（`share/runtime/os.cpp:723`）把记账头嵌入所有 `os::malloc` 调用，summary 只做原子计数，detail 额外做 call-site 聚合（`share/services/mallocTracker.hpp:246`）。tracking level 只能降不能升，是因为升级意味着旧分配没有 site/header 细节，无法补历史账。

如果 NMT 没开，可以借助 `/proc/<pid>/smaps` 看 VM 区域分布、堆栈抓取配合 perf 观察分配热点，但这些手段无法精确回答“哪个调用点分配了多少”。

## 2. Per-thread buffer 让写入频率自然匹配线程繁忙度

全局缓冲 + 锁在高并发下让所有写线程串行化，每秒几千次事件就会产生显著锁竞争。按事件类型分 buffer 则冷热不均——GC 事件每秒几次，方法采样每秒几百次，大多数 buffer 闲置。

per-thread buffer 使繁忙线程写得多、空闲线程写得少，频率自然匹配。`JfrBuffer` 的 `_pos`/`_top` 双指针（`share/jfr/recorder/storage/jfrBuffer.hpp:33`）让写入线程用 bump 分配推进 `_pos`，后台线程从 `_top` 读；`_pos` 更新不需要锁，`_top` 的 volatile 保证安全性。写入线程更新 `_pos` 是普通 store，刷写线程读到的 `_pos` 偏旧是保守的安全（少读比越过写入位置安全），可见性由后续消息同步补齐。

## 3. GC 日志只回答“GC 做了什么”，不回答“谁在 STW 其他时间”

GC 日志记录的是 GC 阶段树内的暂停。但 stop-the-world（safepoint）也可能由 `-XX:+PrintSafepointStatistics`（`share/runtime/safepoint.cpp:830`）揭示。还有 JIT 编译的 `CodeCache` 清扫、偏向锁撤销、JVMTI 事件等也可能触发全局停顿。

因此如果应用每 2 秒卡一次但 GC 日志显示只有 30ms，需要检查 safepoint 统计（`PrintSafepointStatistics`），看是否由非 GC 的 VM operation 引起。JFR 的 safepoint 事件也能定位。

## 4. hs_err 是“尽力保全”，不是“普通日志”

`VMError::report_and_die`（`share/utilities/vmError.cpp:1272`）不是普通日志，因为崩溃线程可能持有任意锁，普通日志会死锁。它用 first-error CAS（`:1351`）抢令牌，后到线程只输出一行 `[thread also had an error]` 后 `infinite_sleep`。

STEP 流水线（`:422`）用 `__LINE__` 标记当前失败点——如果某一步再次崩溃，`_current_step_info` 直接告诉你是哪一节崩了。Decoder 安全模式（`share/utilities/decoder.cpp:99`）让错误线程绕过共享锁用专用实例。`-XX:ErrorLogTimeout` 和 step 超时避免报告自身无限挂起——超时时就 `os::die()` 收场。

## 5. PerfData 是共享布局协议，不是管理接口

`PerfData` 内部对象层（`share/runtime/perfData.hpp:97`）表达语义，外层 `PerfMemory` 共享布局（`share/runtime/perfMemory.hpp:62`）对外暴露固定二进制契约。`jstat` 读方通常不需要通过 JVM 服务线程，而是直接 `mmap` 共享布局（`share/runtime/perfMemory.hpp:74` 的 `PerfDataEntry` 公共契约声明）。

因此适合高频、低语义的数值观测（如 GC 计数、编译计数），但不适合需要复杂语义或安全认证的管理接口。多个进程同时读不互相干扰，因为读方只读不写；但不适合安全敏感观测，因为共享区权限控制比 socket 弱。

## 6. 从现象到源码的排查顺序是“先定界，再定位”

给定 jstack、JFR、GC 日志、NMT，合理的顺序是：

1. `jstack`/JFR 采样：看线程在哪——锁等待（`park`/`blocked`）、循环热代码、IO；
2. GC 日志：看堆分配/晋升/回收压力，确认 GC 是否为主要暂停源；
3. NMT：看堆外分配是否异常增长；
4. JFR 锁/分配/编译事件：看“为什么卡”的微观证据。

同样堆大小下 GC 频率不同的原因可能是分配速率（而不是堆大小），也可能是初始堆（`-Xms`）太小导致频繁 GC 来扩容。因此先看分配速率和 GC 原因，再调参数。

## 7. 所有观测手段共享同一条“从数值回到源码结构”的主线

JFR、JMX、GC 日志、PerfData、NMT、hs_err、SA 不是七种独立的工具，而是**七种不同暴露协议的内部状态发布通道**：

- PerfData 是共享布局协议；
- JFR 是事件流协议；
- NMT 是记账头 + 哈希表；
- hs_err 是崩溃现场保全；
- SA 是 ELF/pread/ptrace 协议。

理解这些工具的关键不是背参数，而是理解每一条通道背后的 VM 内部结构：PerfData 的 `_valuep` 指向共享区槽位、NMT 的 `MallocHeader` 嵌入分配前、JFR 的 `JfrBuffer` 双指针。专家级排查是“选择正确观测 + 反向推演源码机制”，而不是“记参数大全然后逐个试”。

## 评分锚点

- **合格**：能说清 JFR/NMT/GC logs/PerfData/hs_err 各自“看什么”。
- **良好**：能根据具体现象选择正确的观测手段，并解释为什么其他手段不适用。
- **专家级**：能用“每一条观测通道背后都有一个对应的 VM 内部结构”这一主线，把观测值反推回源码入口，并解释“观测台本身也可能成为问题源”。