# 08 · 启动器、工具与 Attach 体系：深度题目

## 1. `java MyApp` 为什么不是“直接调用 JNI_CreateJavaVM”这么简单？

`java` 可执行文件从命令行启动应用时，为什么要先经过 launcher、JLI、JRE/JVM 路径选择、`jvm.cfg`、`dlopen`/`dlsym`，而不是 main 里直接链接 `JNI_CreateJavaVM`？

回答必须覆盖：

- `main.c`、`share/native/libjli/java.c`、`java_md_solinux.c` 的分层职责；
- `JDK_JAVA_OPTIONS`、`@argfile` 预处理为什么发生在进入 JLI 之前；
- `CreateExecutionEnvironment` 为什么要先选 VM 类型和路径，再走应用模式解析；
- `LoadJavaVM` 如何把 launcher 与 `libjvm.so` 解耦；
- 为什么 launcher 本身要承担一部分参数和平台兼容工作，而不是全部丢给 VM。

追问：如果把 JVM 静态链接进 launcher，会失去哪些部署、版本和平台弹性？如果先完整解析应用参数再选 VM，会在哪类选项上出问题？

源码入口：`src/java.base/share/native/launcher/main.c:97`、`src/java.base/share/native/libjli/java.c:241`、`src/java.base/unix/native/libjli/java_md_solinux.c:304`、`src/java.base/unix/native/libjli/java_md_solinux.c:553`。

## 2. Attach 为什么要靠“文件 + 信号 + Unix domain socket”三段式，而不是一个常驻端口？

`jcmd`、`jmap`、`jstack` 要进入活 JVM，为什么 HotSpot 默认不常驻监听，而是按需创建 `.attach_pid`、发送 `SIGQUIT`、再建立 `.java_pid<pid>` socket？

回答必须覆盖：

- attach-on-demand 的零常驻开销目标；
- `.attach_pid` 文件与 `SIGQUIT` 的双条件握手语义；
- Signal Dispatcher 与 Attach Listener 的职责分工；
- 为什么使用 Unix domain socket 而不是 TCP 端口；
- 0600 权限和 `SO_PEERCRED` 的两层安全检查。

追问：如果只发信号不写文件，为什么应该退回线程转储而不是 attach？如果 socket 文件被删了但 JVM 还活着，为什么后续信号可以触发重建？

源码入口：`share/services/attachListener.cpp:344`、`os/linux/os_linux.cpp`（信号分发由平台实现触发到 VM 路径）、`src/jdk.attach/linux/classes/sun/tools/attach/VirtualMachineImpl.java:76`、`src/hotspot/os/linux/attachListener_linux.cpp:181`、`src/hotspot/os/linux/attachListener_linux.cpp:528`。

## 3. 为什么 `jcmd` 的命令字符串到了 JVM 里还要再过一层 DCmd Framework？

Attach 已经把命令送进 JVM，为什么不直接在 AttachListener 里对 `Thread.print`、`VM.native_memory`、`GC.heap_info` 做 if/else 分发？

回答必须覆盖：

- Attach 层为什么只做 transport，不做命令语义；
- `DCmd_Source_AttachAPI`、`DCmd_Source_MBean`、`DCmd_Source_Internal` 的导出面分层；
- `CmdLine`、`DCmdArgIter`、`DCmdParser` 如何把文本协议转成统一对象模型；
- option 与 positional argument 的不同解析规则；
- 框架为什么需要支持多入口而不仅仅是 jcmd 一条路。

追问：如果命令框架直接用 `strtok` 拆空格，会在哪类引号、`key=value` 或脚本输入场景失败？如果 source 不参与 factory 过滤，会把哪类内部命令错误暴露出去？

源码入口：`share/services/attachListener.cpp:198`、`share/services/diagnosticFramework.hpp:36`、`share/services/diagnosticFramework.hpp:52`、`share/services/diagnosticFramework.cpp:67`。

## 4. HeapDumper 为什么必须是 VM_Operation，而不是边跑应用边并发扫堆？

`jmap -dump` 为什么要进入 safepoint、先 `ensure_parsability`、可选 Full GC，再由 VM 线程主导遍历、worker 线程辅助写文件？

回答必须覆盖：

- 堆转储要求对象地址和对象图在遍历期间满足什么一致性；
- 地址即 object ID 的设计为什么迫使 dump 发生在对象不会并发移动的窗口；
- `-dump:live` 的 pre-GC 与 GCLocker 边界；
- VM 线程和 WorkGang 在 dump 中分别承担什么；
- 为什么 hprof 记录流设计与执行模型强相关。

追问：如果让应用线程继续跑，而 dumper 只靠读锁或读屏障观察对象，会先坏在对象移动、字段一致性还是 ID 稳定性？

源码入口：`share/services/heapDumper.cpp:1477`、`share/services/heapDumper.cpp:1775`、`share/services/heapDumper.cpp:1809`、`share/services/attachListener.cpp:220`。

## 5. PerfData 为什么是一条“共享布局协议”，而不是管理接口？

`jstat` 能跨进程读 GC/编译/运行时计数器，为什么 HotSpot 选择 `PerfData` + `mmap` backing file，而不是 socket、JMX 或 attach 请求-应答？

回答必须覆盖：

- JVM 内部 `PerfData` 对象层与对外 `PerfMemory` 共享布局层的区别；
- `PerfDataPrologue` 与 `PerfDataEntry` 为什么是公共二进制契约；
- `PerfDataManager` 更像注册表而不是采样线程；
- 共享内存通道如何降低高频读方成本；
- `StatSampler` 与共享布局的关系为什么是“写方刷新”，不是“读方 RPC”。

追问：如果把 PerfData 改成每秒向 JVM 请求一次，会在哪些成本上退化？如果直接把共享区当 JVM 内部对象模型来用，会失去哪层语义与容错能力？

源码入口：`share/runtime/perfData.hpp:97`、`share/runtime/perfData.cpp:40`、`share/runtime/perfMemory.hpp:62`、`share/runtime/perfMemory.hpp:74`。

## 6. NMT 为什么必须在“第一次 malloc 之前”就知道追踪级别？

Native Memory Tracking 为什么不能像很多诊断功能一样运行时再打开？launcher 环境变量、MallocHeader、summary/detail 两级路径分别在解决什么问题？

回答必须覆盖：

- 为什么早期分配一旦漏记，后续 detail 报告就失去基线；
- launcher 预先写入 `NMT_LEVEL_<pid>` 的必要性；
- `MallocHeader` 如何把大小、类别和可选 site 索引嵌到用户指针前；
- summary 路径和 detail 路径的成本差异；
- 为什么 tracking level 只能降不能升。

追问：如果 detail 模式每次 free 都重新抓栈，会在哪个维度上无法承受？如果 header 不存 site 索引而存完整栈，会怎样放大追踪本身的内存成本？

源码入口：`src/java.base/share/native/libjli/java.c:858`、`share/services/memTracker.cpp:58`、`share/runtime/os.cpp:723`、`share/services/mallocTracker.hpp:246`、`share/services/mallocSiteTable.cpp:142`。

## 7. 这些工具通道的共同本质是什么？

Launcher、Attach、DCmd、HeapDumper、PerfData、NMT 看起来分属不同层。把它们放在一起时，真正应该抓住的共同设计模式是什么？

回答必须覆盖：

- transport 与语义分离；
- 运行期对象模型与对外协议布局分离；
- 为“高频观测、低侵入、失败可退化”做的权衡；
- 为什么很多工具路径都刻意避免把复杂逻辑放进 mutator 热路径；
- 为什么诊断能力经常以“提早布点 + 运行时最小代价 + 读取时恢复语义”的方式设计。

追问：哪几条路径更像共享布局协议，哪几条更像命令协议，哪几条更像 stop-the-world 快照协议？为什么它们不能互相替代？

源码入口：`src/java.base/share/native/libjli/java.c:241`、`share/services/attachListener.cpp:198`、`share/services/heapDumper.cpp:1775`、`share/runtime/perfMemory.hpp:62`、`share/services/memTracker.cpp:164`。
