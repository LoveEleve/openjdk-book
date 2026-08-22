# 08 · 启动器、工具与 Attach 体系：专家答案锚点

## 1. launcher 的价值是把“创建 JVM”拆成可移植的两层协议

`java` 进程启动时，操作系统先执行的是 launcher，而不是 JVM 本体。`main.c`（`src/java.base/share/native/launcher/main.c:97`）负责收集参数、展开 `JDK_JAVA_OPTIONS` 和 `@argfile`，再把结果交给 JLI；`share/native/libjli/java.c`（`src/java.base/share/native/libjli/java.c:241`）负责跨平台主流程；`java_md_solinux.c`（`src/java.base/unix/native/libjli/java_md_solinux.c:304`、`:553`）负责 Unix/Linux 平台上的 JRE 定位、`jvm.cfg` 读取、JVM 类型选择和 `dlopen`/`dlsym`。

这样做的核心不是“代码分层优雅”，而是把 VM 实现与启动器/部署环境解耦：launcher 可以根据当前 JRE 布局、平台约束和参数语义选择具体 `libjvm.so`，再通过 `InvocationFunctions` 调 JNI 入口。若把 JVM 静态焊死进 launcher，发行版替换、JVM 变体选择和平台适配会显著变僵。

## 2. Attach 的设计目标是零常驻、局部可达、同用户安全

Attach 默认不是常驻端口服务，而是按需唤醒：客户端先写 `.attach_pid<pid>`，再发 `SIGQUIT`；Signal Dispatcher 看到双条件成立，才让 Attach Listener 初始化 Unix domain socket。没有触发文件时，同一个 `SIGQUIT` 仍然保留线程转储语义。服务端操作循环从 `share/services/attachListener.cpp:344` 进入，Linux socket 建立在 `src/hotspot/os/linux/attachListener_linux.cpp:181`，按需触发条件在 `:528` 一带成立；客户端侧 Java 封装可从 `src/jdk.attach/linux/classes/sun/tools/attach/VirtualMachineImpl.java:76` 进入。

这套设计同时解决三件事：

- **零常驻开销**：没有 attach 需求时，不需要监听线程和 socket；
- **本地安全边界**：Unix domain socket 避免暴露 TCP 端口；
- **同用户访问控制**：文件权限 + `SO_PEERCRED` 做两层校验。

所以 attach 不是“又一种管理接口”，而是一条刻意压缩攻击面和常驻成本的本地诊断通道。

## 3. DCmd Framework 把 transport、命令发现和参数语义拆开

AttachListener 里的 `jcmd` 入口几乎不理解命令，只把整串文本交给 `DCmd::parse_and_execute`（`share/services/attachListener.cpp:198`）。真正的命令系统由三层组成：

- source/export flags：决定这条命令能否经 AttachAPI、MBean 或 Internal 暴露；
- `CmdLine`/`DCmdArgIter`：把文本协议拆成命令名、引号、`key=value` 和位置参数；
- factory/parser/command object：把文本命令映射成执行对象。

如果没有这层框架，Attach、MBean 和内部入口就会各自维护一套解析和权限模型，命令语义会不断分叉。它的本质是：**Attach 负责送命令，DCmd 负责理解命令。**

## 4. HeapDumper 选择 safepoint，是因为 object ID 就是地址

HotSpot 的 hprof dump 不是逻辑对象序列化，而是把当前堆对象按固定记录格式写成一条二进制流。JDK 11u 中 object ID 直接使用地址，Class ID 直接使用 mirror 地址；这条执行链从 `share/services/heapDumper.cpp:1477` 和 `:1775` 一带进入。只要 dump 期间对象还能并发移动，这个 ID 协议就会立刻失效。

因此 HeapDumper 必须在 safepoint 内进行：先 `ensure_parsability`，必要时做 Full GC，再由 VM 线程主导遍历对象图；并行 worker 主要帮忙写文件，而不是让 mutator 并发继续改变堆。`-dump:live` 只是是否在 dump 前主动做 GC，不改变“堆快照必须在 stop-the-world 一致窗口内生成”这一核心事实。

## 5. PerfData 的本质是“对象语义层 + 共享布局层”双层设计

PerfData 不等于一块共享内存，也不等于一次管理请求。JVM 内部先用 `PerfData`、`PerfLongCounter`、`PerfStringVariable` 等对象表达语义：名字、单位、可变性、常量/采样/变量分类（`share/runtime/perfData.hpp:97`、`share/runtime/perfData.cpp:40`）；然后把这些对象投影到 `PerfMemory` 共享区，由 `PerfDataPrologue + PerfDataEntry` 对外形成稳定布局契约（`share/runtime/perfMemory.hpp:62`、`:74`）。

因此 `jstat` 的读方通常不需要通过 JVM 线程回答问题，而是直接 mmap 这块共享布局并读取。这个设计最适合“高频、低语义、低侵入”的数值观测：它牺牲的是复杂管理语义，换来的是近似本地内存读取的成本。

## 6. NMT 必须把追踪点埋在最早的 native 分配路径里

NMT 要回答的是“哪些 native 分配活着、按什么类别、来自哪个调用点”。如果等 JVM 已经跑起来再开启，就会漏掉早期最重要的 native 分配，账本从第一天起就不完整。所以 launcher 先把 `NativeMemoryTracking` 级别塞进环境变量（`src/java.base/share/native/libjli/java.c:858`），JVM 在最早的 tracking 查询时取走并立即清除（`share/services/memTracker.cpp:58`）。

`MallocHeader` 方案说明 NMT 的真正设计重心是**把记账透明地嵌入所有 `os::malloc` 路径，而不要求调用方改写自己的分配协议**。summary 只做原子计数，detail 再额外做 call-site 聚合；而 tracking level 只能降不能升，是因为升级意味着旧分配没有 site/header 细节，运行时无法补历史账。

## 7. 这几条工具链路的共同模式

Launcher、Attach、DCmd、HeapDumper、PerfData、NMT 共同体现了 HotSpot 在工具链上的一个核心哲学：

```text
尽量提前布点
  → 尽量让运行期热路径只付最小代价
  → 在需要观测时再通过协议、快照或共享布局恢复语义
```

这就是为什么：

- launcher 先选好 VM 再进入 JNI；
- attach 先建立 transport，再把命令解释交给 DCmd；
- HeapDumper 只在需要时进入一次 stop-the-world 快照；
- PerfData 让读方直接读共享布局；
- NMT 把 header 和 site 索引埋进分配路径，而不是等故障出现才逆推出来源。

这些机制不能互相替代，因为它们面向的不是同一种问题：有的是命令协议，有的是共享布局协议，有的是一致性快照协议，有的是内存追踪协议。专家级回答必须先说清“这条工具链要解决什么观测问题”，再讨论它为什么选中了当前协议。

## 评分锚点

- **合格**：能说清 launcher、attach、jcmd、heap dump、perfdata、NMT 各自的主要职责。
- **良好**：能指出 transport 与语义分离、共享布局与对象模型分离、stop-the-world 快照的必要性。
- **专家级**：能把这些工具统一到“最小运行期开销 + 可恢复观测语义”的设计哲学下，并清楚说明它们为什么不能互相替换。
