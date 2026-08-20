# 01. `jstat` 凭什么能跨进程读 JVM 数字？— `PerfData` 架构

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 HotSpot 的 PerfData 主通道：JVM 内部如何创建计数器对象，如何把它们投影到共享内存布局里，以及 Linux 上怎样用 `mmap` + backing file 把这块布局暴露给外部工具。`jstat`、jvmstat libraries、管理接口等外部消费者在这里都只作为“读方”出现；StatSampler 的周期采样逻辑放到下一篇展开。
>
> **前置依赖**：[16-code-cache/05 — JIT 为什么敢赌未来不会变？— `Dependencies` 与 `Deopt`](../16-code-cache/05-dependencies-deopt.md)
> → **后续**：[02 — `StatSampler`](02-stat-sampler.md)

如果你用过 `jstat -gc <pid> 1000`，大概都见过这样的体验：另一个进程里，JVM 每秒像秒表一样吐出一行 GC 数字，`YGC`、`YGCT`、`FGC`、`FGCT`、堆容量、代际容量……看起来仿佛监控工具随手一问，JVM 就立刻答了一句。

但 HotSpot 这里真正发生的事，和“问答式接口”差得很远。

它不是 JMX 每秒发一次请求，不是 JVM 主动往外推日志，也不是某个守护线程用 socket 给你报数。很多情况下，读方就是在另一个进程里，像读本地内存一样去读一块由 JVM 建好的共享内存区域。

这立刻逼出一个很具体的问题：**`jstat` 凭什么能在另一个进程里每秒读到 JVM 内部的 GC / 编译 / 运行时数字，而且中间既没有 socket，也没有 JVMTI/JMX 风格的请求应答？这些数字到底住在哪里，谁创建它们，什么时候对外可见，为什么看起来像普通内存读写却又不会把 JVM 搞乱？**

先把答案压成一句话：**PerfData 不是“JVM 内部计数器顺手导出一下”，而是一条刻意设计的跨进程观测通道：JVM 内部继续用 C++ 对象管理计数器语义和命名，各子系统像注册本地对象一样注册 `PerfData`；同时这些对象把值投影到一块有固定二进制布局的共享内存区里。外部工具并不理解 HotSpot 对象，只认 `PerfDataPrologue + PerfDataEntry` 这套共享协议；Linux 上再用 `mmap` + backing file 把这块内存暴露给同用户进程读取。**

把这句话记住，后面“类层次”“共享文件”“0755/0600”“无锁”这些看似分散的细节，就都能收回到同一条主线上。

## 先试两个最自然的理解，看看为什么都不对

### 朴素方案一：`jstat` 每秒都在向 JVM 发一次请求

这是最直观的第一反应。

监控工具要想拿到数字，最自然的办法就是每秒向 JVM 发送一个请求，JVM 再把当前的 GC 次数、堆大小、编译次数打包回复。很多管理接口和 RPC 系统本来也就是这么做的。

PerfData 这条通道偏偏不是这样。

如果你把它理解成“每秒来回一轮请求/应答”，就会漏掉它最关键的设计目标：**让读方尽可能像读本地内存一样廉价。**

因为 `jstat` 这类工具最典型的需求不是“拿一份语义很丰富、实时协调很严格的管理快照”，而是“高频、低成本地观察一批计数器”。对于这类需求，最贵的往往不是读几个整数本身，而是 IPC 框架、序列化、权限握手、线程切换和服务端额外工作。

PerfData 的路线恰恰是反过来的：写的一方只是继续把计数器写在某个内存槽位里，读的一方只是把同一块内存映射进自己的地址空间再读取。也就是说，它追求的不是“请求式管理接口”，而是“**共享布局式观测通道**”。

所以第一种朴素方案错在把 PerfData 想成了接口协议，而它本质上更接近内存协议。

### 朴素方案二：PerfData 就是一整块共享内存，没有 JVM 内部对象层

第二个也很自然的想法是：既然最终靠共享内存读，那 JVM 干脆直接把各种数字往共享区里写不就行了？没必要再在内部维护一套 `PerfData` 对象、工厂、列表和名字空间。

这个想法只对了一半。

对外看，PerfData 确实最终表现为一块固定布局的共享区；但 JVM 内部并不是直接拿那块共享区当“业务对象模型”来用。源码从一开始就把这两层明确分开了：`PerfData` 是 C++ 对象体系，`PerfMemory` 才是对外共享的布局容器。`PerfData` 本身还有 `_valuep` 指针，专门指向共享区里自己对应的数据槽位。`share/runtime/perfData.hpp:289`

为什么要这么分？因为 JVM 内部需要的是：

- 计数器的名字空间；
- 单位、可变性、支持级别这些语义属性；
- 各子系统各自注册对象的统一工厂；
- sampled / constants / all 这类内部组织方式；
- 在共享区不足时还能退回 C heap，保证 JVM 功能不被观测通道拖死。

这些需求都说明，**JVM 内部依然需要“对象语义层”；共享区只是它对外公开的投影视图。**

所以第二种朴素方案的问题在于：它把“对内对象模型”和“对外共享布局”混成了一层。

这两个失败方案合起来，正好引出 PerfData 的正式设计：**对象在 JVM 内，值在共享区，布局是公共契约。**

## 计数器对象：为什么 JVM 内部还要保留一套 C++ 对象模型

先看 JVM 内部这一层。

`perfData.hpp` 的大段注释一开头就把类型层次讲得很清楚：`PerfData` 是抽象基类，下面先按值类型分成 `PerfLong` 和 `PerfByteArray`，再按可变性分成 `PerfLongConstant`、`PerfLongVariable`、`PerfLongCounter`、`PerfStringVariable`、`PerfStringConstant` 等。`share/runtime/perfData.hpp:97`

这说明 PerfData 在 JVM 内部首先是一套**带语义的对象体系**，不是一个“值槽位编号管理器”。

### 可变性和单位不是装饰字段

`PerfData` 里最重要的两个维度就是 `Variability` 和 `Units`。

`Variability` 有三种：

- `V_Constant`
- `V_Monotonic`
- `V_Variable`。`share/runtime/perfData.hpp:252`

`Units` 则有：

- `U_None`
- `U_Bytes`
- `U_Ticks`
- `U_Events`
- `U_String`
- `U_Hertz`。`share/runtime/perfData.hpp:261`

这两组字段特别值得重视，因为它们说明 PerfData 不是“统一拿 long 存点数再让外部自己猜意义”，而是在对象层就把“这个值是单调计数器还是普通变量”“这个值是字节、时钟 tick、事件数还是字符串”固定下来。

这层语义一方面服务 JVM 内部自己管理计数器，另一方面也会被写进共享布局，成为读方解释数据的依据。

### `PerfDataManager` 为什么像注册表而不是采样器

`PerfDataManager` 在 `perfData.cpp` 里维护了几组核心列表：`_all`、`_sampled`、`_constants`。`share/runtime/perfData.cpp:40`

这件事很容易被忽略，但它其实已经暴露了 PerfData 的内部组织哲学：JVM 不是“先有一块共享内存，后面零散往里塞东西”，而是有一个统一的对象注册中心，负责把不同子系统创建出来的计数器收进统一管理范围。

也就是说，PerfData 更像“**带对外投影能力的统一对象注册表**”，而不是一个只存在于共享区视角里的平面字典。

这也是后面能支持 constants、sampled counters、普通变量、字节数组等不同族群统一对外的前提。

## 共享布局：为什么对外只暴露 `Prologue + Entry`

JVM 内部有对象层，对外则是另一套完全不同的视角。

外部工具并不理解 `PerfLongCounter`、`PerfStringConstant` 这些 C++ 类型。它们看到的只是 `PerfMemory` 区域里的固定二进制布局。

### 共享区开头为什么先放 `PerfDataPrologue`

`perfMemory.hpp` 里先定义的是 `PerfDataPrologue`。它带着：

- `magic`
- `byte_order`
- `major_version` / `minor_version`
- `accessible`
- `used`
- `overflow`
- `mod_time_stamp`
- `entry_offset`
- `num_entries`。`share/runtime/perfMemory.hpp:62`

这组字段非常像一段“小型文件头”或“共享段头”。它的职责不是保存业务计数器，而是告诉读方：

- 这块区域是不是 PerfData；
- 字节序和版本是否匹配；
- 现在是否已经 ready to access；
- 有多少条目；
- 第一条 entry 从哪里开始；
- 结构最近有没有发生变化。

换句话说，外部工具先要确认“**这是一块什么东西、能不能现在读、从哪开始遍历**”，然后才轮到真正的计数器内容。

### `PerfDataEntry` 为什么是公共契约而不是实现细节

紧跟在 prologue 后面的就是一串 `PerfDataEntry`。源码注释把这件事说得非常直白：`PerfDataEntry` 定义的是 PerfData memory region 里 entry 的固定部分，而且 `PerfDataBuffer` Java libraries 是知道这个结构的；如果这个结构变了，读方库也得跟着改。`share/runtime/perfMemory.hpp:74`

这句话其实等于明文宣布：**`PerfDataEntry` 不是 HotSpot 私有布局，而是跨进程、跨语言的对外契约。**

它的固定头里包括：

- `entry_length`
- `name_offset`
- `vector_length`
- `data_type`
- `flags`
- `data_units`
- `data_variability`
- `data_offset`。`share/runtime/perfMemory.hpp:79`

后面再跟可变长 body：名字、padding、真正数据。

所以外部 Java 侧不是在“调用 HotSpot API”，而是在**直接解析 HotSpot 保证稳定的共享内存布局**。

这就是 PerfData 和很多管理接口最大的不同：对象层是 JVM 的私事，布局层才是公共协议。

## 对象与值分离：为什么 `_valuep` 指向共享区才是关键

到这里终于能说全篇最重要的那层分工了。

`PerfData` 对象本身在 JVM 里是 C heap 对象，但它的 `_valuep` 指向共享区中自己对应的数据区域。`share/runtime/perfData.hpp:289`

这意味着一个 PerfData 计数器在 JVM 内部其实有两张脸：

- 对内，它是一个带名字、单位、可变性、辅助方法的 C++ 对象；
- 对外，它只是共享布局里某个 entry 的 data slot。

这层对象/值分离，正是 PerfData 架构最核心的工程技巧。

### `create_entry` 真正在做什么

`PerfData::create_entry()` 很适合拿来读这条设计主线。

它先根据名字长度、固定头大小、数据元素长度计算整条 entry 的总大小；然后专门把尺寸对齐到 8 字节边界，注释直接说这是为了按 8 字节单位分配。`share/runtime/perfData.cpp:125`、`share/runtime/perfData.cpp:136`

接着它去 `PerfMemory::alloc(size)` 申请共享区空间；如果拿不到，就退回 C heap，并把 `_on_c_heap` 设为 true。`share/runtime/perfData.cpp:141`

最后，它把 header 写进共享区，把 `_pdep` 指向 entry，把 `_valuep` 指向 data field，再调用 `PerfMemory::mark_updated()` 更新结构时间戳。`share/runtime/perfData.cpp:162`、`share/runtime/perfMemory.cpp:235`

这整个流程最值得记住的不是填了哪些字段，而是它说明了：**创建一个 PerfData 对象的同时，也在对外共享区里投影出一个公共视图。**

### 为什么共享区不够时退回 C heap 很重要

`create_entry()` 在 PerfMemory 不够用时不会让 JVM 直接失败，而是退回 C heap。`share/runtime/perfData.cpp:141`

这条分支特别重要，因为它说明 PerfData 的优先级排序非常清楚：

- 对 JVM 来说，观测通道是“最好有”；
- 但它绝不能反过来绑架 JVM 的生存。

退回 C heap 后，这个计数器对象在 JVM 内部仍然能用；只是因为不在共享区里，外部工具就看不到它了。

所以 PerfData 架构从一开始就承认：**对内语义完整性比对外可观测性更优先。**

## 谁在创建这些计数器：不是中心批量生产，而是子系统各自注册

如果只看共享布局，很容易误以为这些条目是某个中心模块一次性批量造好的。

实际不是。更准确地说，PerfData 更像一个统一注册基础设施，各子系统在自己初始化或运行阶段，各自把需要暴露的计数器注册进来。

### GC 子系统的例子：`sun.gc.collector.*`

`CollectorCounters` 是一个很典型的例子。它先通过 `PerfDataManager::name_space("collector", ordinal)` 算出像 `sun.gc.collector.0` 这样的名字空间，然后分别创建：

- `name`
- `invocations`
- `time`
- `lastEntryTime`
- `lastExitTime`。`share/gc/shared/collectorCounters.cpp:37`

这说明 GC 侧并不是“把一份结构体丢给 PerfData”，而是按自己理解的监控语义，一条条注册合适类型的对象：有的是字符串常量，有的是事件计数器，有的是可变 tick 值。

### Runtime / OS 的例子：`javaCommand` 与 `hrt.ticks`

`StatSampler` 一侧也很典型。

它会直接创建 `sun.rt.javaCommand` 这样的字符串常量，用来记录启动命令行；还会创建 `sun.os.hrt.ticks` 这样的 sampled counter，用高精度时间 helper 作为取样来源。`share/runtime/statSampler.cpp:322`、`share/runtime/statSampler.cpp:356`

这再次说明 PerfData 不是“GC 专用计数器区”，而是一个统一命名和共享框架，不同子系统在其上各自投影自己的观测语义。

### 名字空间为什么也属于对象层责任

`PerfDataManager::_name_spaces` 里预定义了 `java.*`、`com.sun.*`、`sun.*` 以及 `java.gc`、`sun.gc`、`java.rt`、`sun.os` 这类子系统名字空间。`share/runtime/perfData.cpp:40`

这说明支持级别、稳定性约定、本地对象名字、对外共享名字，其实在对象层就已经确定了。共享布局只是把这些名字复制给读方，并不负责为它们发明意义。

所以 PerfData 这条通道虽然对外看像共享内存，但对内仍然是一套**强语义的注册系统**。

## Linux 共享内存实现：为什么是 `/tmp/hsperfdata_<user>/<pid>` + `mmap`

前面讲的是“共享什么”。现在看“怎么共享”。

Linux 上这条通道并没有使用 System V shared memory 那种传统名字空间，而是非常务实地选择了：**用文件系统做名字空间，再用 `mmap` 共享实际页。**

`perfMemory_linux.cpp` 的注释说得很清楚：Solaris 和 Linux 的共享内存实现使用 `mmap` 接口配合 backing store file 来实现 named shared memory，用文件系统作为共享内存名字空间能跨平台，而且 Java 应用也容易通过普通文件 API 处理。`os/linux/perfMemory_linux.cpp:127`

### 为什么路径长成 `/tmp/hsperfdata_<user>/<pid>`

Linux 侧默认路径就在用户专属的 `/tmp/hsperfdata_<user>/<pid>` 之下；容器场景还会通过 `/proc/{vmid}/root/tmp/...` 去定位。`os/linux/perfMemory_linux.cpp:142`

这条路径设计很有味道：它不是把 perf 数据藏进某个只有 JVM 自己知道的匿名段，而是故意给外部工具留了一个“**按用户再按 pid 发现 JVM 实例**”的名字空间。

换句话说，文件在这里既是 backing store，也是“怎么找到这台 JVM”的入口。

### 目录 0755、文件 0600：为什么这组权限很关键

创建目录时，源码明确用 0755 权限。注释也写明了这点。`os/linux/perfMemory_linux.cpp:850`

创建文件时，则通过 `open(filename, O_RDWR|O_CREAT|O_NOFOLLOW, S_IRUSR|S_IWUSR)` 只给 owner 0600 权限。`os/linux/perfMemory_linux.cpp:909`

这组权限组合是刻意的，不是随手拍的：

- 目录公开，是为了让同一台机器上的工具能发现“有哪些 JVM 在跑”；
- 文件私有，是为了让真正的数据只有同 uid 的进程能读取，而写入仍由拥有这块映射的 JVM 一侧负责。

所以 PerfData 这里的隔离不是靠“别人看不到目录”，而是靠“**别人即使知道文件名，也没有读文件内容的权限**”；而 Linux attach 路径本身也只支持只读映射。

### 为什么还要 `is_directory_secure` / `is_file_secure` 和 `flock`

有了目录和文件权限还不够。实现里还会显式做安全检查，防止目录或文件被 symlink 等手段劫持。`os/linux/perfMemory_linux.cpp:850` 这一段就已经把 `is_directory_secure`、后续 `is_file_secure` 串起来了。

另外，容器场景下不同进程可能共享同一个 `/tmp`，甚至 pid 还可能撞车。所以实现里还专门加了 `flock` 竞争逻辑：多个容器化进程若争同一个 perfdata 文件，只允许赢得 `flock()` 的那个进程继续写，其余进程放弃 PerfData。注释把这个意图写得非常直白。`os/linux/perfMemory_linux.cpp:935`

这说明 PerfData 通道并不是“随便 mmap 一个文件就完事”，而是对命名空间冲突和文件系统攻击面都有明确防守。

### `mmap_create_shared`：最终还是回到共享页

真正把这套文件名字空间变成共享内存的是 `mmap_create_shared()`。

它会：

- 取得当前 pid；
- 算出用户目录和共享文件名；
- 清理 stale 文件；
- 创建共享文件；
- 最后用 `mmap(..., PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0)` 建立映射。`os/linux/perfMemory_linux.cpp:1050`

这就把我们最开头的疑问彻底落地了：`jstat` 之所以能“像读普通内存一样”看到 JVM 数字，不是因为两个进程 magically 共享对象，而是因为**它们各自都把同一个 backing file 映射到了自己的地址空间里**。

对象层是各自的，物理页才是共享的。

## 可见性与“无锁”边界：为什么普通读写就够了

到这里最后还剩一个最容易被神化的问题：既然两个进程都在碰同一块内存，为什么不需要复杂锁协议？

先说结论：PerfData 这里的“无锁”是真的，但它的含义必须讲窄，不能吹成“完全不在乎可见性和结构边界”。

### 对于标量计数器，为什么写得像普通内存就够了

PerfData 的很多核心读数本来就是标量 long 计数器、单调事件数、tick 计数或简单变量。`create_entry()` 又明确把 data slot 按 8 字节边界对齐。`share/runtime/perfData.cpp:136`

这使得在本文讨论的 `Linux / x86_64` 当前实现里，对齐的 64 位写足够自然和廉价。更关键的是，很多计数器本来就允许读到“稍旧但自洽”的值：比如 GC 次数、累计耗时、容量这类指标，高频观测需要的是低成本和最终可见，不是某种事务级快照一致性。

所以 PerfData 这里的工程取舍是：**让写方像更新普通内存一样便宜，让读方容忍少量时间上的滞后。**

### 真正需要协议的不是值更新，而是“结构什么时候能读”

但这不代表整块共享区完全没有协议。

真正需要明确边界的是：

- 这块区域什么时候 ready to access；
- 结构发生变化时，读方怎样察觉。

前者靠 `accessible`。`Management::record_vm_startup_time()` 在 VM 启动时把关键启动计数器填好后，调用 `PerfMemory::set_accessible(true)`。`share/services/management.cpp:205`

后者靠 `mark_updated()`，它会把 `mod_time_stamp` 更新成当前 `os::elapsed_counter()`。`share/runtime/perfMemory.cpp:235`

这两样东西说明 PerfData 的“无锁”真正边界是：

- 对于单个标量值的日常更新，不引入重型同步；
- 但对于“这块共享布局是否已经就绪”“条目结构刚刚变过没有”，仍然提供明确的状态位和时间戳辅助。

也就是说，它省掉的是热路径的重同步，不是省掉一切可见性约束。

## 到这里为止，主线其实只发生了五件事

如果前面信息比较多，这里先把整件事压回五个动作：

1. 各子系统在 JVM 内部创建带语义的 `PerfData` 对象，而不是直接手写共享内存槽；
2. 这些对象把自己的值投影到 `PerfMemory` 里的 `PerfDataEntry` 数据区；
3. 外部工具只认 `PerfDataPrologue + PerfDataEntry` 这套固定共享布局；
4. Linux 用 `/tmp/hsperfdata_<user>/<pid>` 这套 backing file + `mmap` 实现跨进程共享；
5. 日常值更新尽量保持普通内存写，结构就绪和变更则靠 `accessible` 与 `mod_time_stamp` 兜底。

只要这五步还在脑子里，PerfData 就不会再看起来像“几个计数器 + 一个 mmap 文件”的松散拼接。

## 常见误解澄清

### 误解一：PerfData 就是另一种 JMX

不是。

JMX 是接口式管理通道；PerfData 更像共享布局式观测通道。读方主要不是在发请求，而是在映射并解析同一块内存区域。

### 误解二：外部工具理解的是 HotSpot 的 C++ 对象

不对。

外部工具只理解 `PerfDataPrologue` 和 `PerfDataEntry` 这套二进制布局；`PerfLongCounter`、`PerfStringConstant` 这些对象层细节只存在于 JVM 内部。`share/runtime/perfMemory.hpp:74`

### 误解三：共享内存不足会让 JVM 功能失效

不会。

共享区不足时，计数器对象可以退回 C heap，JVM 继续跑，只是外部 PerfData 读方看不到这些条目。`share/runtime/perfData.cpp:141`

### 误解四：目录 0755 就表示任何用户都能读性能数据

不对。

目录公开只是为了发现文件名；真正的数据文件是 0600，owner 在文件权限上具备读写资格，但外部 attach 路径实际按只读方式打开映射。`os/linux/perfMemory_linux.cpp:850`、`os/linux/perfMemory_linux.cpp:909`、`os/linux/perfMemory_linux.cpp:1181`

### 误解五：“无锁”就等于完全没有可见性协议

不是。

无锁主要指计数器热路径不引入重同步；结构是否 ready 和是否发生过布局更新，仍然靠 `accessible` 和 `mod_time_stamp` 明确表达。`share/services/management.cpp:205`、`share/runtime/perfMemory.cpp:235`

## 收网：PerfData 的本质，是“本地对象 + 公共布局 + 共享映射”三层分工

现在再回头看最开头那个问题，答案已经能收成一张总图了。

```text
JVM 内部
  子系统创建 PerfData 对象
    ├─ GC counters
    ├─ Runtime / OS counters
    └─ sampled helpers
        ↓
  PerfData 对象 (C heap)
    └─ _valuep 指向 PerfMemory 里的 data slot

共享通道
  PerfMemory
    ├─ Prologue: magic / version / accessible / used / entry_offset / num_entries
    └─ Entry[] : name + units + variability + data
        ↓
Linux 实现
  /tmp/hsperfdata_<user>/<pid>
    └─ mmap(MAP_SHARED)

外部工具
  jstat / jvmstat libraries
    └─ 只解析共享布局，不碰 JVM 内部对象
```

把它再压成三句话：

- JVM 内部靠 `PerfData` 对象保留计数器语义和注册体系；
- 对外靠 `PerfDataPrologue + PerfDataEntry` 暴露稳定二进制布局；
- Linux 再用 backing file + `mmap` 把这套布局变成同用户进程可直接读取的共享视图。

所以 `jstat` 之所以看起来像“隔空读 JVM 内存”，不是因为它会特殊调用 HotSpot 内部对象。

真正的原因是 HotSpot 从一开始就把这条观测通道设计成了：**对象语义留在 JVM 内，值布局公开到共享区，读方只解析布局，不打扰写方。**

下一篇就顺着这条通道继续往下走。到这里，我们已经知道计数器怎么建、怎么住进共享区、怎么对外可见；但还有一个问题没回答：那些 sampled counters 是谁在定期刷新？它和业务线程怎么解耦？为什么 `jstat` 看到的某些值像实时，而某些值又明显带采样味道？下一篇展开 `StatSampler`。

> → [02-stat-sampler.md](02-stat-sampler.md)
