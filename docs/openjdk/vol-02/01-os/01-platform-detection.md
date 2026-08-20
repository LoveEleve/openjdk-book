# JVM 怎么知道自己跑在容器里？——平台探测

> 基于 `jdk11u / HotSpot / Linux / x86_64`。容器探测以 Linux cgroup 实现为主，CPU 特性与 TSC 讨论以 x86_64 为主；本文讲的是 HotSpot 当前实现，不是 JVM 规范对所有 JVM 的统一要求。
>
> 前置依赖：[卷 0 ch01——java 命令是什么](openjdk/vol-00/ch01.md)
>
> 后续：[02——虚拟内存](02-virtual-memory.md)

## 一台 96 核机器，为什么会把 JVM 带沟里

容器里最容易出现一种“看起来合理、实际上危险”的配置：宿主机有 96 个 CPU、64GB 内存，容器只被分配 2 个 CPU、2GB 内存。JVM 启动时如果只向操作系统询问“这台机器有多少核、总内存有多少”，它就会得到一个对宿主机正确、对自己错误的答案。

错误答案会沿着 JVM 的后续决策链扩散：GC 线程可能按 96 核规划，编译线程也来抢同一份 2 核配额，最大堆则可能按宿主机内存估算。最后不是“JVM 稍微保守一点”，而是进程在容器已经热起来之前就被 cgroup 送进 OOM kill。

还有另一类错误：CPU 支持什么指令、虚拟机里的时钟是否稳定、当前内核支持哪些能力。如果这些信息被当作静态常识，而不是启动时真正探测出来的状态，JIT、并发原语、GC 甚至时间线都可能建立在错误前提上。

所以平台探测不是启动日志里的装饰。它是 JVM 后续自适应决策的第一批输入。

但“探测平台”并不等于把信息打印出来。HotSpot 真正要做的是把外部环境翻译成后续子系统可以共享的内部状态：

```text
Linux / CPU / 虚拟机 / cgroup / NUMA
                │
                ▼
      HotSpot 内部的稳定状态
                │
      ┌─────────┼─────────┐
      ▼         ▼         ▼
    GC 线程   JIT 线程   堆/时间/内存策略
```

接下来只围绕四个问题走一遍：我跑在什么地盘上？CPU 会什么？我真正能用多少 CPU？我真正能吃多少内存？

## 先排除一个直觉方案：需要时再读环境

最直觉的办法是：哪个模块需要内核版本，就自己读一次；哪个模块需要 cgroup，就自己打开一次文件；CPU 指令能力也不要集中保存，用到时再临时判断。

这个方案的问题不是某一次读取很慢，而是**平台判断会失去统一状态**。不同调用方可能用不同解析方式，版本后缀可能被不同处理，cgroup v1/v2 也可能在不同路径上产生不同答案。更糟的是，平台探测通常发生在初始化和运行时决策的交界处，分散读取会让“谁先探测、谁覆盖谁、谁看到旧值”变成隐形状态机。

HotSpot 采取了相反的策略：启动早期完成探测，把原始字符串、寄存器位和 cgroup 文件内容转成可复用的数字、位图和对象。后面负责 GC、JIT、内存的代码尽量只消费这些状态，而不重新理解底层环境。

这里先记住本篇的主线：**先把环境翻译成状态，再让各子系统消费状态。**

## 第一问：我跑在谁的地盘上

### 内核版本不是日志文本，而是比较对象

Linux 的 `uname` 返回的是字符串，例如 `5.4.241` 或 `4.18.0-193.el8.x86_64`。对普通应用而言，打印这个字符串可能就够了；对 HotSpot 而言，后面会反复做版本边界判断：某个系统调用是否可用，某个 cgroup 行为是否可信，某个内核兼容分支是否需要打开。

如果每个调用方都重新拆字符串，判断逻辑就会散落。HotSpot 在 Linux 平台初始化时把版本拆成 major/minor/fix，再编码成一个 32 位整数。`_os_version` 的布局是 `0x00AABBCC`：AA 是 major，BB 是 minor，CC 是 fix（`os_linux.hpp:60-66`）。初始化入口在 `os::Linux::initialize_os_info()`，它通过 `uname` 取得 release，再用 `sscanf` 拆分版本并写入 `_os_version`（`os_linux.cpp:5253` 起）。

这不是为了让整数看起来比字符串高级，而是为了把“环境文本”变成“可以统一比较的内部状态”。以后代码只需要比较编码后的版本，不需要每次面对发行版后缀，也不需要各自定义解析规则。

### 虚拟化探测关心的不是品牌，而是行为

HotSpot 还维护 `VirtualizationType`，用来区分 XenHVM、KVM、VMWare、HyperV 等环境（`abstract_vm_version.hpp:31-41`）。这里容易产生一个误解：虚拟化探测是不是只是为了在日志里显示“当前跑在 KVM”？

真正重要的是虚拟化可能改变硬件行为，尤其是时间和 CPU 计数器的表现。JVM 的 GC 日志、JFR 和各种延迟统计都依赖时间测量；虚拟机暂停、恢复、迁移或 TSC 虚拟化策略，可能让“读到了一个时间值”与“这个时间值适合做单调耗时测量”不是一回事。

因此虚拟化类型属于平台策略输入，而不是硬件品牌信息。它帮助 HotSpot 在时间源和平台路径上保持边界意识。

## 第二问：这颗 CPU 到底会什么

### CPU 特性是一张能力位图

x86 CPU 通过 `cpuid` 返回能力位。HotSpot 在 `VM_Version` 中把这些能力整理到 `_features` 位图，再由 `supports_*` 方法提供统一查询（`abstract_vm_version.hpp:139-152`；`vm_version_x86.cpp:464` 附近）。

这张位图的价值不在于“记录一长串 CPU 参数”，而在于让后续代码可以用同一种方式问能力：支持不支持某条原子指令？能不能生成 AVX？是否具备 AES-NI？

```text
cpuid 返回寄存器位
          │
          ▼
      _features 位图
          │
   ┌──────┼──────┐
   ▼      ▼      ▼
supports  JIT指令  加密/并发路径
```

例如 `supports_cx8`、`supports_atomic_getset4`、`supports_atomic_getset8` 等查询在 `abstract_vm_version.hpp:56-67` 定义。调用方不需要知道 cpuid 的寄存器布局，只需要问“这条能力是否可用”。

### 为什么不在每个调用点临时执行 cpuid

第一，能力检测的结果在一个 JVM 进程生命周期内通常不会改变；第二，统一位图能让 JIT、并发原语和加密 intrinsic 使用同一个判断口径；第三，调用点只依赖稳定的 getter，平台差异被隔离在 `VM_Version` 初始化路径中。

如果探测错了，风险也比“某个功能不可用”大：JIT 可能生成当前 CPU 不支持的指令，原子操作可能选择错误实现，性能路径可能在不适合的硬件上开启。因此 CPU 探测必须是一次可信的启动事实，而不是分散在热路径里的猜测。

## 第三问：我有多少 CPU，和宿主机有多少 CPU 不是一回事

### 两个答案必须同时保留

HotSpot 同时区分机器处理器数量和当前 JVM 可用的 active processor count。前者回答“系统配置了多少 CPU”，后者回答“当前运行环境允许我按多少 CPU 做并行决策”（`os.hpp:232-281`；`os.cpp:1744` 附近）。

这两个数字不是重复字段：

```text
processor_count          = 机器/宿主机视角
active_processor_count    = JVM 当前可用视角
```

GC 并行度、JIT 编译线程和其他并发任务不能盲目使用宿主机的 CPU 数。容器的 CPU 配额才是 JVM 需要遵守的实际边界。

### cgroup quota 如何变成 CPU 数

cgroup CPU bandwidth 通常由 `cfs_quota_us` 和 `cfs_period_us` 表示：一个周期内允许使用多少 CPU 时间，以及周期长度是多少。HotSpot 读取这些值，计算可用 CPU 数。典型例子是 period=100ms、quota=200ms，意味着一个周期可获得 200ms CPU 时间，约等于 2 个 CPU 配额。

这一计算的关键不是把 quota 当物理核心数，而是把“时间预算”翻译成并行决策可以使用的规模。quota 不存在、无限或不可用时，HotSpot 才回到其他处理器数量来源。对应实现分支位于 `cgroupSubsystem_linux.cpp` 的 active processor count 逻辑（`cgroupSubsystem_linux.cpp:519`、`:555`）。

CPU shares 又是另一种语义：它是相对权重，不是硬配额。一个 cgroup 的 shares 多，并不意味着它获得固定数量的核心。因此 shares、quota、online CPU 必须区别对待，不能把任意一个数都当成“可用核数”。

### NUMA 是 CPU 探测的延长线

处理器数量还不够。多路机器上，CPU 与内存存在 NUMA 亲和关系。HotSpot 通过 CPU 到 NUMA node 的映射，并在可用时动态解析 libnuma（`os_linux.hpp:272-306`；`os_linux.cpp:3423`），为后续内存分配和 heap region 布局提供拓扑信息。

这里的设计取舍很明确：libnuma 不是所有运行环境的必备依赖，所以 HotSpot 用运行时符号解析，而不是让进程在启动时因为缺少 libnuma 直接链接失败。能力可用就增强，能力不可用就保持可运行。

## 第四问：我到底能吃多少内存

### 物理内存不是容器上限

如果 JVM 只读物理内存，它会把宿主机的 64GB 当成自己的上限；但容器可能只有 2GB。HotSpot 需要先识别 cgroup 文件系统类型，再选择对应实现。

`CgroupSubsystemFactory` 根据 `/sys/fs/cgroup` 的布局创建 v1 或 v2 子系统（`cgroupSubsystem_linux.hpp:244-268`；`cgroupSubsystem_linux.cpp:59`）：

```text
cgroup 文件系统
      │
 ┌────┴────┐
 v1       v2
独立控制器 统一层级
```

v1 常见的内存文件是 `memory.limit_in_bytes`，v2 则是 `memory.max`。两者对外表达的是类似的约束，但路径、挂载和无限值表示不同。把这些差异封装在子系统层，后面的堆大小逻辑就不必知道自己面对的是 v1 还是 v2（`cgroupV1Subsystem_linux.cpp:91` 附近）。

### shares 不是 quota

`cpu.shares` 表示相对权重，不能直接等价成固定核数。HotSpot 对 shares 做标准化，避免不同编排系统使用不同基准值时把底层数值直接泄漏给上层决策（`cgroupV1Subsystem_linux.cpp:285` 附近）。

这也是平台探测中反复出现的模式：底层接口各有语义，HotSpot 先把它们转换成统一的运行时概念，后面的决策只消费转换后的结果。

### 为什么要缓存 cgroup 指标

cgroup 文件读取不是免费的。如果每次创建对象、计算堆策略或查询资源都重新打开并解析文件，探测本身会变成开销来源。HotSpot 用 `CachedMetric` 保存上次读取值、读取时间和 TTL（`cgroupSubsystem_linux.hpp:213`；`osContainer_linux.hpp:35`），在 20ms 窗口内复用结果。

20ms 不是“永远正确”的承诺，而是一次工程折中：容器配额变化不需要纳秒级反映，而重复系统读取的成本可以被压低。平台信息需要足够新，但不值得每次都付出完整 syscall/文件解析代价。

## 收网：平台探测是整卷后续决策的初始条件

现在把四类输入合在一起：

```text
内核/虚拟化 ──┐
CPU能力      ├─> HotSpot稳定状态 ─> GC/JIT/堆/时间/NUMA
可用CPU      ┤
cgroup内存   ─┘
```

平台探测回答的不是“JVM 的环境信息是什么”，而是“后面的 JVM 决策应该相信哪些输入”。

- GC 线程数需要 active processor count，而不是宿主机核心数
- JIT 需要 CPU feature bitmask，而不是假设所有 x86 都支持同样指令
- 堆大小需要容器 memory limit，而不是宿主机物理内存
- 时间测量需要考虑虚拟化与平台时钟边界
- NUMA 布局需要处理 CPU 与内存节点的关系

如果删掉本文所有代码，主线仍然成立：JVM 先把外部环境翻译成可计算状态，再让后续子系统消费这些状态。代码的作用，是证明这套翻译分别落在 `_os_version`、`_features`、active processor count、cgroup subsystem 和 CachedMetric 上。

本篇解决的是“JVM 如何看清脚下”。下一篇进入另一个问题：**看清之后，JVM 如何向 OS 要到一块虚拟地址空间，又如何把地址空间变成可提交的内存？**

## 几个容易把平台探测想错的地方

### 物理核数不是“假的”，但也不是唯一答案

看到 `processor_count` 和 `active_processor_count`，很容易把其中一个理解成“真实值”，另一个理解成“修正后的值”。这其实把两个观察角度混在了一起。

物理机的处理器数量仍然有价值。HotSpot 需要知道机器本身的拓扑，也需要在没有容器限制时知道可用的并行规模。但容器环境额外引入了一个边界：当前进程的 CPU 时间预算可能小于机器的硬件容量。因此，一个数字服务于硬件拓扑，另一个数字服务于当前运行约束。

这也是为什么 cgroup 的 `active_processor_count()` 不是简单返回 quota。源码还要综合宿主机可见 CPU、quota、shares，以及 `PreferContainerQuotaForCPUCount` 这样的策略开关，最后取限制后的结果（`cgroupSubsystem_linux.cpp:555-605`）。当 quota 和 shares 同时存在时，HotSpot 还要根据配置决定偏好 quota，还是取两者最小值。

**关键设计：** *平台探测不是找一个“唯一真相”，而是保存不同语义的输入，再由具体决策选择需要的视角。*

### cgroup 版本差异不是换一个文件名

v1 和 v2 的差异也不只是 `memory.limit_in_bytes` 与 `memory.max` 两个文件名不同。它们的控制器组织、无限值表示和 CPU/内存接口布局都不同。如果把路径读取散落到堆大小、线程数、监控等调用方，未来切换 cgroup 版本时就必须改动所有调用方。

`CgroupSubsystemFactory` 把文件系统形态识别集中起来，然后创建 v1 或 v2 的实现对象。上层只调用“读取内存限制”“读取 active processor count”这样的抽象接口。这样做的收益不是少写几个 if，而是把版本差异限制在平台适配层，不让它传播到 GC、JIT 和内存策略。

### 缓存 TTL 不等于平台状态永远不变

20ms 缓存还容易被误读成“HotSpot 认为容器配置不会变”。真实含义更保守：平台指标允许在一个很短的窗口内复用，避免频繁读取；窗口到期后仍然会重新检查。

`CachedMetric` 保存上次值、上次读取时间和 TTL；调用方先判断是否需要重新读取，未过期就返回缓存值，过期才重新计算并更新缓存（`cgroupSubsystem_linux.hpp:213`；`osContainer_linux.hpp:35`）。这是“有限陈旧”与“每次系统调用”之间的折中，而不是把动态配置当成静态常量。

如果一个指标只在启动时消费，初始 active processor count 可以固定；如果一个指标允许运行中重新读取，则缓存只影响读取频率。两者不能混为一谈。

### CPU feature bitmask 也不是“检测到就一定启用”

CPU 位图描述的是硬件能力，不等于每条高级指令最终都会被 HotSpot 使用。后续还可能受到 JVM flags、操作系统支持、编译器策略和平台安全边界影响。

因此更准确的链路是：

```text
硬件 cpuid
  -> HotSpot _features
  -> supports_* 查询
  -> flags / JIT / intrinsic 再做最终策略选择
```

这条链解释了为什么平台探测应当和参数解析、JIT、GC 分层：探测层负责回答“能力存在吗”，策略层负责回答“当前场景要不要使用”。如果把这两层合并，读者很容易把“CPU 支持 AVX”误解成“所有代码路径都会使用 AVX”。

## 一张最终总图

到这里，平台探测可以收束成五个动作：

```text
1. uname / cpuid / cgroup / NUMA 提供原始事实
2. HotSpot 在平台层集中解析这些事实
3. 解析结果进入版本整数、CPU 位图、active CPU、memory limit、拓扑对象
4. GC/JIT/堆/时间/NUMA 等子系统只消费稳定状态
5. 运行中的动态指标通过有限 TTL 重新读取，而不是无限缓存
```

这条链也说明了平台探测的边界：它不是 GC 调优本身，不是 JIT 编译本身，也不是虚拟内存分配本身；它提供这些机制作出正确决策所需要的初始输入。
