# 02. 一条参数串怎样变成运行配置 —— `Arguments` 的协议、默认值与生命周期

> **前置依赖**：[01 —— 不能重启 JVM 时，采样器怎样进门](./01-build-attach.md)：知道 CLI 会把 profiler 动作和参数交给目标 agent。
> → **后续**：[03 —— fdtransfer、权限边界与 jattach 路径](./03-attach-fdtransfer.md)：回到 Linux attach 的资源桥与请求编排。
>
> 本篇基于当前 async-profiler 源码。重点是 native 参数语义中心，不把 `Arguments` 外推成所有 profiler 的通用配置模型，也不把 parse 成功等同于 JVM、perf 或事件引擎已经成功。

## 命令看起来只是字符串，真正的风险在语义分裂

场景：线上执行：

```text
asprof start,event=cpu,file=/tmp/result.html,timeout=30s
```

表面上，这只是一个动作、一个事件、一个文件名和一个时间参数拼成的逗号串。但 profiler 不能让后面的 CPU engine、输出 writer 和 JFR recorder 各自重新猜一遍这些字符串的含义。否则同一个 `30s` 可能在不同模块里被当成秒、毫秒或未经处理的文本；`event=alloc` 也可能只被当成标签，而没有打开真正的分配路径。

async-profiler 把这件事集中到 `Arguments::parse()`：

```text
CLI / C API / Java native bridge
  → command string
    → Arguments::parse()
      → 逗号 token
        → key/value + CASE 分派
          → 枚举、位标志、数值阈值、列表和派生字段
            → Profiler::runInternal / engine / writer / recorder
```

这条链要先建立两个边界：

- `arguments.cpp` 负责把输入协议解释成当前实现的运行配置。
- `arguments.h` 负责声明配置字段、枚举、默认值和供其他模块读取的方法。

因此，本篇不回答“命令行支持哪些选项”的帮助文档问题，而回答：**一条文本协议如何形成一份能被多个 native 模块共同消费的配置对象，以及这份对象在哪里仍然受生命周期和运行时能力约束。**

*关键设计（斜体）：* *参数解析不是字符串拆分的工具函数，而是外部入口与运行时模块之间的语义边界。* [模式: 统一语义中心]

## 先推演四个会让配置失真的方案

### 让 CLI、C API 和 Java API 各自解析

如果 CLI 负责解释 `-e cpu`，C API 负责解释 `event=cpu`，Java API 再维护一套便利方法到字段的映射，三条入口迟早会对默认值、错误提示和组合参数产生分歧。当前代码保留了不同入口，但让它们尽量在 native 参数模型汇合：C API 的 `asprof_execute()` 直接调用 `Arguments::parse()`（`src/asprof.cpp:26-30`），Java JNI 的 `execute0/execute1` 也都是先 `args.parse(command_str)`，再进入 `Profiler::instance()->runInternal()`（`src/javaApi.cpp:56-116`）。

这并不表示所有入口完全没有包装。CLI 仍会把短选项拼成请求片段，Java API 也有强类型便利方法；统一的是最终语义中心，而不是所有入口的表面语法。

### 把原始字符串留给每个 engine 自己解释

这会把协议复杂度扩散到 CPU、alloc、lock、wall、JFR 和 OTLP。每个模块都要知道字符串名称、单位后缀、默认值和错误处理，模块之间还会争论某个字段到底是“未设置”还是“设置为零”。解析阶段把人类写法变成枚举、位标志和数值，运行模块只消费已经形成的字段，边界才不会在每个 engine 里重复出现。

### 用全零初始化代替语义默认值

`Arguments` 中的 `0`、`-1`、`false` 并不是同一个意思。构造器让 `_timeout` 和 `_interval` 从 0 开始，让 `_alloc`、`_lock`、`_wall` 等阈值从 -1 开始；后续 parser 用“是否小于 0”判断某些事件是否被配置。若把所有字段简单清零，未配置的 lock 和显式配置为零的 wall 就会失去区别。

### 把 parse 成功当成 profiling 成功

`parse()` 只负责配置形成。之后仍可能在 `Profiler::runInternal()` 中因为没有事件、多个事件与非 JFR 输出组合、JVM 能力、fdtransfer、perf 权限或输出文件失败而返回错误。配置有效只是进入运行时检查的前提，不是最终成功。

这四个失败方案共同说明：

```text
输入语法统一
  ≠ 所有入口表面相同
  ≠ 所有字段只有一个默认值
  ≠ 解析成功就是采样成功
```

## 第一层：`Arguments::parse()` 先把字符串变成可处理的 token

### 原始参数为什么要复制

`Arguments::parse()` 位于 `src/arguments.cpp:41-60`。如果传入参数为空，函数直接返回 `Error::OK`（`:42-44`）。有参数时，它先计算长度，释放旧的 `_buf`，再分配 `len + EXTRA_BUF_SIZE + 1` 字节并把输入复制到缓冲区（`:46-52`）。

复制不是为了保留一份漂亮的原始文本，而是为了允许后续解析直接修改这份副本。`strtok()` 会把分隔符改写成字符串结束符；如果直接修改调用方传入的只读字符串，解析器就会把协议拆解动作变成内存写入风险。

### 逗号与等号分别表达什么

从 `arguments.cpp:56-60` 开始，解析器循环执行：

1. 用逗号找到一个参数片段。
2. 在片段中寻找第一个 `=`。
3. 有 `=` 时把左侧变成 key，右侧作为 value；没有 `=` 时，整个片段就是无值标志。
4. 计算 key 的 hash，进入 `SWITCH(arg)` 与 `CASE("...")` 分派。

所以 `start`、`threads`、`reverse` 这种布尔/动作 token 与 `event=cpu`、`file=/tmp/result.html` 这种键值 token 可以共存。逗号是协议的一级边界，等号是参数内部的二级边界。

这里还有一个容易漏掉的失败路径：CASE 表的 `DEFAULT()` 并不立即返回错误，而是在 `arguments.cpp:405-407` 把第一个未知参数保存到 `_unknown_arg`。它本身不会让 `parse()` 失败；真正的提示发生在 `Log::open(args)` 时，由 `src/log.cpp:28-33` 输出 `Unknown argument: ...`。另一方面，已知参数但 value 非法、重复 event 或必填值为空这类语义错误，会先写入 `msg`；整个参数串解析完成后，函数在 `:410-412` 才返回 `Error`。这种顺序让 `log` 等后续选项仍有机会被解析并用于错误输出，但也意味着“遇到错误立即停止”不是当前实现。

> 路标：这一层只建立 token 和错误收集机制。接下来要看的不是 CASE 表有多长，而是不同类别的 token 如何改变不同类型的运行字段。

*关键设计（斜体）：* *解析器先建立可修改的协议副本，再统一分派 key/value；它把语法问题集中处理，避免运行模块再次切字符串。* [模式: 破坏性 token 化 + 集中分派]

## 第二层：为什么动作、输出和计数器不能混成一个字段

### 动作决定运行时要做什么

`Action` 在 `src/arguments.h:30-40` 定义了 `ACTION_NONE`、`ACTION_START`、`ACTION_RESUME`、`ACTION_STOP`、`ACTION_DUMP`、`ACTION_STATUS`、`ACTION_METRICS`、`ACTION_LIST` 和 `ACTION_VERSION`。`arguments.cpp:62-84` 把对应文本写入 `_action`。

这些值不是输出格式，也不是事件类别。`Profiler::runInternal()` 在 `src/profiler.cpp:1570-1649` 按 `_action` 分派：start/resume 进入 `start()`，stop 进入 `stop()`，dump 进入 `dump()`，status/metrics/list/version 则分别执行查询或输出逻辑。

因此，同一个 output 选项放在不同 action 后面，运行含义也不同。`Arguments` 保存的是“这次请求要做什么”的动作状态，而不是“这次采样观察什么”的事件状态。

### 输出决定结果交给谁消费

`Output` 在 `arguments.h:72-81` 定义了 `OUTPUT_NONE`、`OUTPUT_TEXT`、`OUTPUT_COLLAPSED`、`OUTPUT_FLAMEGRAPH`、`OUTPUT_TREE`、`OUTPUT_JFR` 和 `OUTPUT_OTLP` 等值，解析器在 `arguments.cpp:86-124` 处理 `collapsed`、`flamegraph`、`tree`、`jfr`、`jfropts`、`traces`、`flat` 和 `otlp`。

这里的 `jfropts` 值得单独注意：它不仅把 `_output` 设为 JFR，还可能把数字选项写入 `_jfr_options`，或识别 `mem` 设置 `IN_MEMORY`。`jfrsync` 也会把输出设为 JFR，并设置 `JFR_SYNC_OPTS` 与 `_jfr_sync`。因此“输出格式”有时同时携带 recorder 的运行设置，不能只理解成文件后缀。

如果用户只给了 `file` 而没有显式 output，parse 在 `arguments.cpp:419-426` 调用 `detectOutputFormat()`：`.html` 选择 flamegraph，`.jfr` 选择 JFR，`.collapsed`/`.folded` 选择 collapsed，`.svg` 选择已经过时的 SVG，否则选择 text；同时设置默认的 text dump 数量。没有 action 但已经形成 output 时，`:428-429` 会把 action 推导成 `ACTION_DUMP`。

这两个推导说明 parse 不只是“把输入写进字段”：它还根据字段组合补出后续运行所需的默认动作和输出。

### `samples` 与 `total` 决定计数语义

`Counter` 在 `arguments.h:42-45` 定义为 `COUNTER_SAMPLES` 和 `COUNTER_TOTAL`，对应 `arguments.cpp:125-129` 的两个 token。它们不改变事件来源，而是改变输出阶段选择样本次数还是累计值。把 counter 与 action、output 或 event 混成一类，会让后续火焰图和 JFR 的数值语义失真。

## 第三层：为什么 `event` 不能只存成一个字符串

### `cpu` 与 `event=cpu` 的落点不同

`arguments.cpp:147-162` 处理 `event=value`。`alloc`、`nativemem`、`lock` 和 `nativelock` 会分别初始化对应阈值字段；其他事件名通常进入 `_event`，但如果已经存在事件且没有 `_all`，会返回 `Duplicate event argument`。

而单独的 `cpu` token 在 `arguments.cpp:204-209` 直接把 `_event` 设为 `EVENT_CPU`。因此不能笼统写成“所有事件都写入 `_event`”：当前实现对 allocation、native memory、lock 和 native lock 使用字段阈值表示是否启用，并可能同时保留其他事件状态。更重要的是，`_event` 本身并不等于“事件类别”。在 `eventMask()` 里，只要 `_event != NULL`，就会设置 `EC_CPU` 位（`src/arguments.h:309-316`）；这意味着 `_event` 同时承载了 CPU、perf 或其他字符串事件名，而后端分类仍然先把它们收进 CPU 这一大类。输入字符串、字段承载和运行类别必须分开看。

### 一个事件如何影响默认阈值

例如 `event=lock` 在 `:154-155` 发现 `_lock < 0` 时设置 `DEFAULT_LOCK_INTERVAL`；独立的 `lock` 参数在 `:192-193` 则走另一个 CASE，允许无值时使用默认阈值，或用 `parseUnits(value, NANOS)` 解析显式等待时间。`event=alloc` 会把 `_alloc` 从未配置状态推进到 0；`alloc=512k` 则在 `:177-178` 直接写入字节阈值。两者最后都可能让 allocation 路径启用，但它们进入 parser 的协议分支和默认值补齐逻辑并不相同。

`all` 更能说明事件不是单字段。`arguments.cpp:211-235` 先设置 `_all` 与 `_live`，再按当前平台补齐 wall、alloc、lock、nativelock、nativemem、proc 和 CPU 的默认状态。Linux 条件还会影响 `_proc` 与 `_event` 的补齐；随后 `eventMask()` 再根据这些字段是否被推进到有效值，把它们收成多个 `EventCategory` 位。把 `all` 解释成“事件名为 all”会完全丢掉这条“字段补齐 → 位集合”链。

### `eventMask()` 把字段重新收成后端类别

`Arguments::eventMask()` 位于 `src/arguments.h:309-316`。它根据 `_event`、各类阈值是否大于等于 0，以及 `_trace` 是否为空，分别设置 `EC_CPU`、`EC_ALLOC`、`EC_LOCK`、`EC_WALL`、`EC_NATIVEMEM`、`EC_NATIVELOCK` 和 `EC_TRACE` 位。

这建立了两个不同层次：

```text
输入 token / 字段派生
  → Arguments 内部状态
    → eventMask()
      → EventCategory 位集合
        → Profiler / Engine / JFR
```

`_event` 不是 `eventMask()`，`eventMask()` 也不是某个具体 engine。前者是部分输入语义，后者是供运行时分流的类别集合。`Profiler::runInternal()` 之后还会检查 `_event_mask` 是否为零、是否同时包含多个事件以及输出格式是否允许多事件（`src/profiler.cpp:883-890`）。所以 event 解析完成后仍有运行时组合校验。

*关键设计（斜体）：* *参数层先允许用多个字段表达事件语义，再用 `eventMask()` 把这些字段压缩成后端可分流的类别位；输入表达与运行分类不是同一个对象。* [模式: 派生配置 + 位掩码桥接]

## 第四层：单位归一化不是装饰，而是边界检查

### `parseUnits()` 的四步

`Arguments::parseUnits()` 位于 `src/arguments.cpp:529-550`。它先用 `strtol()` 读取数字部分，再查看数字后面的单个字符：无后缀时直接返回数字；后缀为大写字母时先转小写；之后在线性 `Multiplier` 表中寻找匹配符号，找到后返回乘积，否则返回 `-1`。

倍率表在 `arguments.h:120-128`：

- `NANOS`：`n`、`u`、`m`、`s`，归一化到纳秒；
- `BYTES`：`b`、`k`、`m`、`g`，按 1024 倍率处理；
- `SECONDS`：`s`、`m`、`h`、`d`；
- `UNIVERSAL`：当前实现允许的一组混合后缀。

因此 `10ms` 在 parse 层成为数值，`512k` 也不再由后续 engine 自己判断单位。但要注意：`parseUnits()` 只接受一个后缀字符，多个后缀或不认识的字符会返回 `-1`；具体调用方是否检查 `-1`，决定错误是否被返回给用户。`chunksize`、`chunktime`、`interval` 这类字段会立即检查并返回 `Invalid ...` 错误；`memlimit` 在 `arguments.cpp:174-175` 则直接把 `long` 结果赋给 `size_t`，没有同样的 `< 0` 拦截。也就是说，“单位非法”并不是 parse 层统一报错的强保证，错误是否显性暴露取决于具体字段的调用点。

### 不同字段使用不同倍率表

`chunksize` 使用 `BYTES`，`chunktime` 使用 `SECONDS`；`lock`、`nativelock` 和 `wall` 使用 `NANOS`；`interval` 使用 `UNIVERSAL`。同一个字母在不同上下文中的意义可能不同，例如 `m` 在 `NANOS` 中是毫秒，在 `SECONDS` 中是分钟。单位不是全局字符串替换，而是由字段选择的倍率表决定。

### `timeout` 的冒号路径只能讲到实现边界

`parseTimeout()` 在 `src/arguments.cpp:553-563` 先查找冒号。没有冒号时，它调用 `parseUnits(str, SECONDS)`；有冒号时，则从字符串中读取小时、分钟和可选秒，并按 `0xff000000 | hh << 16 | mm << 8 | ss` 打包返回。

这可以确定两件事：

- `timeout=30s` 走相对秒数的单位解析。
- 带冒号的输入走当前实现的时分秒打包路径，而不是普通的单位乘法。

消费点在 `Profiler::start()`：`profiler.cpp:1064-1067` 会把 `_timeout` 和 `_loop` 交给 `addTimeout()`，生成 `_stop_time` 和 `_loop_time`。这说明 timeout 最终确实进入启动后的计时逻辑；但仅凭 `parseTimeout()` 与这里的调用关系，仍不足以把所有带冒号输入写成某一种完整业务语义。本篇只把它写到“特殊编码 + 由 `addTimeout()` 消费”的实现边界。

## 第五层：默认值、保存与运行时消费

### 默认值表达“未配置”与“配置为零”的区别

`Arguments` 的字段和构造器位于 `src/arguments.h:150-288`。几个关键默认值是：

- `_action = ACTION_NONE`、`_output = OUTPUT_NONE`：尚未选择动作和输出；
- `_timeout = 0`、`_loop = 0`、`_interval = 0`：时间类字段的初始值；
- `_alloc`、`_nativemem`、`_lock`、`_nativelock`、`_wall`、`_proc = -1`：对应事件/阈值尚未配置；
- `_jstackdepth` 和 `_truncated_stack_depth = DEFAULT_JSTACKDEPTH`；
- `_chunk_size` 与 `_chunk_time` 使用明确的 JFR 分块默认值；
- `_threads`、`_sched`、`_live`、`_fdtransfer` 等布尔字段初始为 false。

这不是为了让对象看起来整齐，而是为了让 parser 和 `eventMask()` 能区分“没有启用某个事件”和“已经启用但阈值为零”。例如 `_alloc >= 0` 才会进入 allocation 位；若构造器把它默认为 0，profiler 创建出来就会误以为 alloc 已开启。

### `Arguments` 不是天然不可变快照

parse 完成后，后续运行模块确实主要通过字段读取配置；但不能把它夸成“天然不可变、天然线程安全”的快照。`arguments.cpp:17-18` 定义了 `_global_args`，用于保存最近一次 start/resume 命令的参数；`Profiler::start()` 在 `profiler.cpp:911-912` 会调用 `args.save()`，而 `Arguments::save()` 本身在 `arguments.cpp:596-601` 做的是浅拷贝 `_global_args = *this`，随后把当前对象的 `_shared` 设为 true。

这意味着保存动作不是“深复制出一份完全独立的新配置对象”。`_buf`、基于 `_buf` 的字符串指针以及 vector 中保存的指针关系都要放在同一个生命周期里理解；析构函数之所以在 `arguments.cpp:592-594` 检查 `_shared`，正是为了避免重复释放共享的 `_buf`。此外，`Arguments` 自己还拥有文件模式展开能力，`file()` 在 `arguments.cpp:435-439` 会根据 `%p`、`%t`、`%n` 等模式生成实际文件名。它是“集中承载配置的 C++ 对象”，而不是脱离生命周期后自动安全共享的不可变值对象。

### parse 后还有一整层运行时检查

`Profiler::runInternal()` 在 `src/profiler.cpp:1570-1649` 根据 action 选择 start、stop、dump、status、metrics、list 或 version。start/resume 会进入 `start()`；而在真正进入 `runInternal()` 之前，`Profiler::run()` 还可能在 `profiler.cpp:1652-1663` 先决定使用 `LogWriter` 还是打开输出文件。也就是说，配置消费本身就分成外层输出文件打开和内层 action 分派两层。

`start()` 里的 `profiler.cpp:883-890` 例如会拒绝没有 profiling event 的配置；多个事件只有 JFR 输出允许；alloc、lock、trace 等事件在非 Java 进程上也会被拒绝。fdtransfer 连接则在 `profiler.cpp:897-901` 继续检查。因此“parse 之后的运行时校验”不能都压成同一个函数名：有些发生在 `run()` 的输出打开层，有些发生在 `start()` 的能力与资源层。由此得到一条必须保留的边界：

```text
parse 成功
  → 运行时 action 分派
    → JVM / 平台 / perf / 输出能力检查
      → engine 启动或 dump/status 等具体动作
```

*关键设计（斜体）：* *`Arguments` 负责把配置语义集中起来，但不替代运行时能力检查；配置有效只是进入 profiler 生命周期的门票。* [模式: 配置形成与能力校验分离]

## 第六层：枚举顺序怎样变成跨文件契约

### `CStack` 不只是本文件的枚举

`CStack` 在 `arguments.h:58-64` 中定义 `default/no/fp/dwarf/vm` 五个顺序值，紧接着的注释要求枚举变化时同步 `FlightRecorder`。`flightRecorder.cpp:76` 的 `SETTING_CSTACK` 数组正是按这个顺序提供字符串；`writeSettings()` 在 `flightRecorder.cpp:645-650` 用 `args._cstack` 作为数组下标写入 JFR setting。

这是一条具体的跨文件索引契约：改变枚举顺序而不改变 `SETTING_CSTACK`，JFR 文件里的 `cstack` 文本就会对应错误。它不是抽象地“所有地方都依赖 enum”，而是一个可回查的数组下标关系。

### `EventCategory` 同时连接 mask、rate limit 与 JFR

`EventCategory` 在 `arguments.h:96-106` 依次列出 CPU、alloc、lock、wall、native memory、native lock、trace、span，并以 `EC_CATEGORIES` 作为数量边界。`eventMask()` 用这些值建立位集合；`parseRateLimit()` 在 `arguments.cpp:565-588` 又把字符串中的类别名映射到 `_rate_limit[category]`。

JFR sync 路径还在 `flightRecorder.cpp:1451-1454` 把 `args.eventMask()` 与 JFR option 位移后的结果合并成 `event_mask`，再传给 Java 侧 `JfrSync`。因此 EventCategory 的顺序同时影响多个整数编码和数组索引。

但这里应保持判断强度：源码足以证明它们是当前实现中的跨文件编号契约，不能仅凭这些用法就把它们统称为公开 ABI。它们更接近内部协议；修改时必须同步 parser、rate limit、JFR 和消费方。

## 收网：参数解析形成配置，但不负责替代整个 profiler

把这篇压缩成一张图：

```text
逗号协议
  → Arguments::parse：复制、切分、分派、错误收集
    → Action / Output / Counter：请求与消费语义
    → event 字段：阈值、列表、默认值和平台派生
    → parseUnits / parseTimeout：数值编码与单位边界
    → constructor / save / global args：生命周期承载
      → eventMask / runInternal
        → JVM、平台、perf、engine 和 writer 的运行时检查
          → start / dump / status / output
```

本篇的一句话困惑是：**一条混合了动作、事件、单位和输出的命令字符串，怎样不会在多个 native 模块之间失去一致语义？**

本篇的一句话顿悟是：**当前实现把协议解释集中在 `Arguments::parse()`：它不只切 token，还会形成枚举、阈值、列表、默认动作和事件位；但 `Arguments` 只是配置承载，最终能否启动仍要经过 profiler 的 JVM、平台、资源和输出检查。**

必须保留的三个边界是：

1. `_event`、事件阈值字段和 `eventMask()` 是三个不同层次。
2. `Arguments` 不是天然不可变或线程安全对象，而是参与 start/resume/stop 生命周期的 C++ 配置对象。
3. parse 成功只能说明输入通过了当前解析规则，不能说明采样已经开始。

*关键设计（斜体）：* *把人类协议收束成配置对象，再把配置对象交给运行时能力检查；参数语义与采样能力因此保持分层。* [模式: 协议归一化 + 生命周期承载 + 运行时校验]

[跨层标注：C++ `Arguments`——协议和配置对象；`eventMask()`——输入状态到后端类别的位掩码桥；JFR `SETTING_CSTACK`/`EventCategory`——跨文件内部编号契约；Profiler——运行时 action、能力和资源检查；engine/writer/recorder——配置消费方]

## 下一篇：fdtransfer 如何把低层资源交给目标进程

参数对象已经形成，下一篇回到启动链的 Linux 特有边界：

- `--fdtransfer` 为什么要创建 Unix socket；
- 辅助进程如何校验请求者和目标 TID；
- `perf_event_open`、perf buffer 映射和 `SCM_RIGHTS` 如何组成权限桥；
- 为什么这条路径不能与 JVM attach 或参数解析混为同一层。

**→ 下一篇：[fdtransfer、权限边界与 jattach 路径](./03-attach-fdtransfer.md)。**
