# 03. 机器怎样读这些采样？——OTLP Profiles、手写 protobuf 与直接/离线两条转换链

> **前置依赖**：[AP-4 —— 调用栈存储与去重](../04-stack-symbols/04-storage-alloc.md)、[AP-5-01 —— FlameGraph 输出](./01-flamegraph-html.md)、[AP-5-02 —— JFR recorder](./02-jfr-recorder.md)
> → **后续**：AP-6 Java API
>
> 场景：火焰图适合人看，JFR 适合 JFR reader，但可观测性平台还需要机器可读的 profile protobuf，而且生产机不一定适合承担离线转换。
>
> 本篇基于当前 async-profiler 源码，重点讨论 native `otlp.cpp` 的直接导出路径，以及 Java converter 中 JFR→OTLP 的离线路径。这里的 OTLP 不是 Prometheus 文本，也不是 JFR 的另一层包装；当前实现输出的是 OpenTelemetry Profiles 风格的 protobuf 数据。以下结论以 `otlp.cpp`、`otlp.h`、`protobuf.h`、`profiler.cpp` 和 `converter/one/convert/JfrToOtlp.java` 为准，不把当前字段集外推为 OTLP 全量规范实现。

## 先把真正的困惑摆出来：给平台吃的数据，为什么不能继续沿用 flamegraph 或 JFR 的表示

上一章里，flamegraph 解决的是“人怎样看热点”，JFR 解决的是“JFR reader 怎样按 chunk、metadata 和 constant pool 解释事件”。这两条路都已经成立，所以一个很自然的问题就会出现：既然同一份采样数据已经能变成人看的 flamegraph，也能变成 JFR reader 能读的文件，为什么还要再折腾一份 OTLP？

答案在于消费者根本不是同一类。可观测性平台要的不是一张图，也不是一个 JFR reader 专用格式，而是一种能和 traces、metrics、logs 并列进入平台的数据协议。它关心的是：sample type 是什么，period 是什么，stack、function、thread attribute 能不能被机器稳定索引，整份 profile 能不能被跨进程、跨语言、跨系统地上传、聚合和再解释。

如果还沿用 flamegraph 的表示，就会立刻撞上一个边界：flamegraph 的核心是“前缀聚合 + 可视化布局输入”。Trie、`f/u/n` 和 HTML 模板服务的是浏览器，不服务平台索引。平台不需要 Canvas 坐标，也不关心横向宽度怎样画矩形。它需要的是另一类关系：stack 对应哪些 location，location 对应哪个 function，sample value 用什么单位，thread.name 这样的属性又挂在哪一层。

如果还沿用 JFR 的表示，也会遇到另一个边界：JFR 的 chunk、metadata、constant pool 是为 JFR reader 语义设计的。JFR 当然可以做中间格式，但那意味着所有场景都要先落一份 JFR，再在后续环境里额外跑一次 JFR→OTLP 转换。对某些离线工作流这没问题，可一旦调用方只是想在 profiling 结束时直接拿到一段“平台能吃的 profile protobuf”，那么先写 JFR 再回读 JFR，就会把本来不必存在的中间格式成本硬塞回路径里。

于是两个最朴素的方案都会暴露问题。

第一种方案，是直接把 collapsed 栈文本上传，让平台在后端自行解析字符串。这个办法最大的吸引力是“够通用、够便宜”，但它立刻失去了稳定的结构索引：function、location、thread、sample type、period 都只能从文本里再猜回来，重复字符串体积也大，平台后续的结构化聚合成本也高。

第二种方案，是统一规定“一律先生成 JFR，再由任何需要的平台自己离线转 OTLP”。这个方案确实能复用 JFR 生态，但也等于强迫所有生产环境都带着一个额外中间层生活。当前 async-profiler 明明手里已经有 `CallTraceStorage`、`FrameName` 和聚合值，却还要先落成 JFR、再读回 JFR，逻辑上并不总是划算。

第三种直觉，则是以为 OTLP 只不过是“另一种展示格式”：既然 flamegraph 有 Trie，JFR 有 cpool，那 OTLP 也许只是在这些表示外面再套一层导出器。这同样不准确。OTLP 真正在乎的不是“怎么展示”，而是“怎样把 profile 重组为一套平台可索引的 dictionary + sample 关系”。

第四种误解，是把仓库里的 native `otlp.cpp` 和 `JfrToOtlp.java` 看成重复劳动：既然都能生成 OTLP，为啥不留一个就好？这也正是后文要讲清的另一条主线：它们共享目标协议，但不共享中间表示，也不服务同一类部署路径。

所以本篇真正要回答的问题，不是“怎么把 protobuf 字节写出来”，而是：为什么同一份 `CallTraceSample` 在进入平台生态时，必须被重排成 dictionary 和 sample 关系；以及为什么 async-profiler 同时保留 native 直出与 JFR→OTLP 离线转换两条链。

可以先把两条 OTLP 路压成一张总图：

```text
直接导出路径
  CallTraceStorage.collectSamples()
    → FrameName
      → Otlp::Recorder.recordStacks()
        → dictionary: stack/function/location/attribute/string
          → _samples_info
            → recordOtlpProfile()
              → ProtoBuffer
                → Writer

离线转换路径
  JFR file
    → JfrReader / JfrToOtlp.java
      → 从 JFR 事件重建 profile model
        → OTLP protobuf
```

*关键设计（斜体）：* *async-profiler 不把 OTLP 当成“另一张图”，也不把它当成 JFR 的附属壳，而是把它当成 profile 协议：native 路径直接从 `CallTraceSample` 建立 dictionary 和 sample 关系；需要离线工作流时，再由 `JfrToOtlp.java` 从 JFR 走第二条链。*[模式: 协议导出 + 在线直出 / 离线转换双路径]

先记住本文的总领：OTLP 不是换一种展示皮肤，而是换一种机器协议。后面所有实现细节，都是围绕“怎样把采样重排成平台能稳定索引的 profile 结构”展开的。

## 第一层：为什么 OTLP 输出仍然直接从 `Profiler::dump()` 和 `CallTraceStorage` 起步

当前 OTLP 并不是一个完全独立于 profiler 主流程的后处理工具。和 flamegraph、JFR 一样，它首先仍然是 `Profiler::dump()` 分派出来的一种输出格式。`OUTPUT_OTLP` 进入 `dumpOtlp()`，再从当前内存态的 `CallTraceStorage` 出发（`src/profiler.cpp:1439-1445`）。

`dumpOtlp()` 的步骤很短，但恰好把定位说得很清楚：

1. 创建 `FrameName`，并关闭 `STYLE_ANNOTATE`；
2. 创建 `Otlp::Recorder`，传入 active engine、起始时间和持续时间；
3. 从 `_call_trace_storage.collectSamples()` 取 `CallTraceSample*` 列表；
4. 根据 `args._counter == COUNTER_SAMPLES` 决定这一轮输出看 samples 还是 counter；
5. 调用 `recorder.write(out)` 写二进制（`src/profiler.cpp:1439-1445`）。

```text
Arguments::_output = OUTPUT_OTLP
  → dumpOtlp()
    → FrameName
    → Otlp::Recorder(engine, fn, start_nanos, duration_nanos)
    → collectSamples(call_trace_samples)
    → record(..., use_samples?)
    → Writer
```

这里的关键不在于“入口也在 dump 里”，而在于它没有绕到 JFR 去。也就是说，native OTLP 直出明确拒绝了“所有 OTLP 都必须从 JFR 解析回来”这个中间层假设。只要调用者要的是一份平台可读的 profile protobuf，而当前进程手里已经有 `CallTraceStorage`，那么最直接的做法就是从这里起步，而不是先人为制造另一份中间表示。

这一点在 API 形态上也非常明显。`AsyncProfiler.dumpOtlp(Counter counter)` 直接返回 `byte[]`，内部调用的是 `execute1("otlp,...")`（`src/api/one/profiler/AsyncProfiler.java:241-252`）。对外它根本不打算把 OTLP 伪装成字符串输出，也不打算让上层再自己去拼 protobuf。它从一开始就把 OTLP 定义成“机器消费的二进制载荷”。

所以这一步真正建立的边界是：OTLP 不是离线工具的专属功能，它首先就是 profiler 的一种原生导出格式。离线路径存在，但不是这条直出路径的前提。

## 第二层：为什么 async-profiler 要手写最小 protobuf 子集，而不是引入完整 runtime

一旦决定要直接导出 OTLP，下一个问题就是：这些字节到底怎么写？这里最容易掉进去的直觉是：既然目标是 protobuf，那就上一个通用 protobuf runtime、用生成代码直接拼消息对象不就行了？

当前实现没有这么做，而是刻意把“写到哪里”和“按什么 wire format 写”拆开。`Writer` 负责前者：统一提供 `write(const char*, size_t)` 接口，`FileWriter`、`BufferWriter`、`CallbackWriter` 分别面向文件、内存和回调（`src/writer.h:13-96`、`src/writer.cpp:43-107`）。这解决的是输出介质问题。

OTLP 还要再解决“按什么二进制规则组织这些字节”。这里 async-profiler 没有引入重量级 protobuf 依赖，而是自己实现了一个极小的 `ProtoBuffer`。它只提供当前 writer 真的需要的 primitives：

- `field(index, u64)` / `fieldFixed64(...)` 写 varint 或 fixed64 字段；
- `field(index, const char*, len)` 写长度前缀的 bytes/string；
- `startMessage()` / `commitMessage()` 处理嵌套 message；
- `putVarInt()` 和 `varIntSize()` 处理变长整数（`src/protobuf.h:25-57`）。

这看上去像是在“重复造 protobuf 轮子”，但实际更接近“只造当前真的要滚的那一小段轮子”。因为 async-profiler 在这里的诉求非常窄：它不需要一个完整的 schema 运行时，不需要 `.proto` 代码生成，也不需要把整套 OTel protobuf 对象模型完整搬进 native 输出层。它只需要足够把当前这份 OTLP Profiles 风格结构稳定地编码出来。

如果引入完整 runtime，会发生什么？一方面，依赖、对象模型、构建复杂度和版本耦合都上来了；另一方面，当前 writer 其实并不想先建立一棵庞大的“内存消息对象树”再统一序列化，它更接近手写协议、边组织边落字节。也就是说，完整 runtime 并不是不能用，而是在这个问题上太重了。

所以这里的失败方案不是“protobuf 运行时错误”，而是“为一个很窄的协议子集付出远超需要的对象模型和依赖复杂度”。当前实现的取舍更像 JFR writer 的延续：不引入笨重格式库，只保留当前协议真正需要的最小编码能力。

### `otlp.h` 为什么不是普通头文件，而是当前实现的字段字典

手写 `ProtoBuffer` 之后，另一个容易被轻描淡写的点是 `otlp.h`。它没有声明真正的 protobuf message class，而是用 namespace 常量把各级字段号写死：

- `ProfilesData::resource_profiles = 1`、`dictionary = 2`；
- `ProfilesDictionary` 里有 mapping/location/function/link/string/attribute/stack 表；
- `Profile` 里有 sample_type、samples、time_unix_nano、duration_nano、period_type、period；
- `Sample`、`Location`、`Function`、`Line`、`KeyValueAndUnit`、`AnyValue` 等也各自有 field number（`src/otlp.h:24-97`）。

这意味着 `otlp.cpp` 不是“碰巧按某个顺序写字段”，而是在显式兑现一套字段编号契约。字段号不是内部实现细节，而是 wire format 本身的一部分；改它不是重构，而是兼容性变更。

所以这里真正成立的，不是“我们有个 protobuf helper”，而是“我们用最小 protobuf 编码器 + 常量化字段字典，手写了一份目标协议”。这一点如果没立住，后面 dictionary 和 sample body 的关系也会显得只是“随便选的结构”，而不是协议设计。

*关键设计（斜体）：* *对 async-profiler 来说，protobuf 不是内存对象模型，而是“字段号 + wire type + 嵌套 message”的字节契约；`ProtoBuffer` 提供编码原语，`otlp.h` 提供字段字典，二者共同承担 schema 角色。*[模式: 手写 wire protocol + 常量化字段字典]

到这里先记住一句话：async-profiler 这里并没有“接入 protobuf 生态”，而是在 native 侧手写了一份足够小、刚好够用的 OTLP wire-format 子集。

## 第三层：为什么 native OTLP 必须先写 dictionary，而不是先写 sample body

一旦进入真正的 OTLP 结构，最核心的问题就来了：为什么 native 路径不是像普通日志那样“来一条 sample 写一条 sample”，而是要先写 `ProfilesData.dictionary`？

原因其实和 JFR 的 constant pool 很像：高重复度对象不应该在每条 sample 里一遍遍重写。要是每个 sample 都带完整函数名、线程名、栈字符串、甚至位置关系，那么 OTLP 载荷很快就会退化成另一种 collapsed 文本：可读也许还在，但结构索引与压缩收益都会迅速流失。

所以当前实现选择的是 dictionary-first。`recordProfilesDictionary()` 先调用 `recordStacks()` 建立 stack/function/thread universe，再依次写：dummy `mapping_table`、占位的 `link_table[0]`、`function_table`、`location_table`、`attribute_table` 和 `string_table`，最后再提交整个 dictionary message（`src/otlp.cpp:11-70`）。

```text
ProfilesData
  ├─ dictionary
  │   ├─ stack_table
  │   ├─ mapping_table
  │   ├─ link_table
  │   ├─ function_table
  │   ├─ location_table
  │   ├─ attribute_table
  │   └─ string_table
  └─ resource_profiles
      └─ scope_profiles
          └─ profiles
              └─ samples
```

这一步的核心，不是“表很多”，而是它明确把高重复度对象从 sample body 里抽走了。sample 本身后面只需要说：我引用哪条 stack、带哪个 attribute、值是多少。其余文本与关系，让 dictionary 统一承担。

### 当前这些 dummy 项为什么不是“完整 exporter 语义”

这里必须把一个非常容易被夸大的边界讲透。当前实现确实会写 `mapping_table`、`link_table`、`attribute_table`，但这些并不意味着它已经完整覆盖了 OTLP 的 mapping/link/resource 语义。

源码里写得非常直白：

- `mapping_table` 目前只写一个空 mapping，并注明“Not currently used, but required by some parsers”（`src/otlp.cpp:16-19`）；
- `link_table[0]` 只放一个 zero-filled trace/span ID，原因也是 parser 兼容性（`src/otlp.cpp:20-26`）；
- `attribute_table` 当前“only threads for now”，也就是只给线程名准备 attribute（`src/otlp.cpp:50-63`）；
- `location_table[0]` 必须是零值，后续 location 统一用 dummy `mapping_index = 0`，源码里甚至还留着 “TODO: set to the proper mapping when new mappings are added” 的注释（`src/otlp.cpp:35-48`）。

因此更准确的说法，不是“async-profiler 已经构建了完整 OTel exporter 语义”，而是“它为了当前解析器生态和当前需求，主动补了一个最小兼容字典”。这份字典足够让当前 profile 被解析、被索引、被测试通过，但并不等于已经完整建模了 mapping、link 或 rich resource 语义。

这正是这一节必须打透的失败方案：看到 `mapping_table`、`link_table`、`attribute_table` 这些名字，很容易自动脑补成“完整支持”。但当前实现做的其实是最小可解析集合，而不是全量 exporter 语义覆盖。

所以这一步真正要记住的是：dictionary-first 不只是为了压缩重复，也是为了把“当前实现到底提供了哪些结构语义”明确地固定下来。

## 第四层：为什么 `recordStacks()` 第一次遍历 trace 时，不直接把 sample body 一起写完

讲完 dictionary-first，真正的关键设计还在下一步：`recordStacks()` 为什么不在第一次扫过 `CallTraceSample` 时，顺手把 sample body 也写了？反正这时候 stack、thread、samples、counter 看起来都已经在手里了。

当前实现没有这么做，而是故意拆成两段。`recordStacks()` 先遍历 `CallTraceSample*`，取出 `CallTrace`，过滤掉 `trace == NULL`、被 `_fn.excludeTrace(trace)` 排除的条目，以及 `cts->samples == 0` 的条目（`src/otlp.cpp:72-81`）。对每条被接受的 trace，它先写一条新的 `stack_table` message。遍历每一帧时，如果遇到 `BCI_THREAD_ID`，就把这帧转成线程名索引 `_thread_names.indexOf(_fn.name(...))`；其余帧则通过 `_functions.indexOf(_fn.name(...))` 拿到函数索引，并把这个索引写进当前 stack 的 location 列表（`src/otlp.cpp:83-99`）。

这一点本身已经在说明：当前 location 语义并不是一个富含地址/文件/行号的世界，而更接近“函数名索引驱动的位置表”。后面 `location_table` 也只是把 `function_index` 再写回去（`src/otlp.cpp:35-48`）。这和 JFR 那种 `CallTrace -> MethodInfo -> line/bci/type` 的细粒度恢复明显不是一条路。

### `_samples_info` 为什么必须存在

每写完一条 stack，`recordStacks()` 并不会立刻去写 sample body，而是把 `samples`、`counter` 和 `thread_name_index` 先压进 `_samples_info`（`src/otlp.cpp:98-99`）。也就是说，第一次遍历 trace 解决的是“这份 profile 里有哪些 stack/function/thread universe”，而不是“每条 sample 最终该长什么样”。

```text
CallTraceSample
  → stack_table[N]
  → SampleInfo{samples, counter, thread_name_index}

recordOtlpProfile()
  → Sample.stack_index = N
  → Sample.attribute_indices = thread_name_index
  → Sample.values = samples 或 counter
```

为什么不能第一次遍历时就把 sample body 顺手写完？因为 sample body 不是孤立的。它依赖前面 dictionary 已经稳定下来：stack index 要等 stack_table 的顺序确定，attribute index 要等 thread attribute 已经进字典，sample_type/period/value 语义还要等 profile header 确定。要是第一次遍历就直接落 sample body，你要么得提前假设这些索引和 profile 语义都已稳定，要么就得接受后面再回头 patch 更多位置。

当前实现选择的是更稳的一条路：第一遍只建立 universe，第二遍再写关系。这让 dictionary 与 sample body 的职责非常清晰：前者定义“你可以引用哪些对象”，后者定义“每条 sample 引用了哪些对象、值是多少”。

所以 `_samples_info` 不是一个无奈的临时数组，而正是 dictionary-first 设计的桥。它把“对象 universe 的建立”和“sample 关系体的最终落盘”隔开了。

### `samples == 0` 的边界为什么必须讲清

这里还有一个很容易被顺手说错的小边界：`recordStacks()` 过滤的是 `cts->samples == 0`，不是“最终被选中的值是不是 0”（`src/otlp.cpp:81`）。

这意味着，如果调用者最后选择的是 `counter`，而某个 sample 恰好 `samples > 0`、`counter == 0`，它依然会进入 dictionary，也依然会在 `_samples_info` 里占一位；只是等到 `recordOtlpProfile()` 时，最终 `values` 可能写成 0。这个边界不能擅自改写成“OTLP 会自动跳过 value 为 0 的 counter 样本”。

也就是说，当前实现真正决定“这个 stack 是否进入 universe”的门槛，是有没有样本身份，而不是当前输出维度下的最终 value 是否非零。这是实现策略，不是读者可以凭直觉脑补掉的细节。

## 第五层：`recordOtlpProfile()` 为什么要同时区分 sample_type 与 period_type

等 dictionary 和 `_samples_info` 都准备好了，`recordOtlpProfile()` 才真正开始写 profile body。这里最容易混淆的，是 sample value 单位和采样器自身周期语义。

`Recorder` 构造时，已经把 engine 的 `type()`、`units()` 以及字符串 `count` 放进 `_strings`，同时记录 `_start_nanos`、`_duration_nanos` 和 `engine->interval()` 作为 `_period`（`src/otlp.h:105-145`）。真正写 profile 时，又会先写 `time_unix_nano`、`duration_nano`、`sample_type`、`period_type`、`period`，再逐条写 `samples[]`（`src/otlp.cpp:109-145`）。

这一步必须先把两个概念拆开：

1. `sample_type` 说的是“这一条 sample 的 value 代表什么单位”；
2. `period_type/period` 说的是“底层采样引擎按什么周期或单位工作”。

当前实现的规则是：

- 如果调用者要求的是 `samples` 聚合，那么 `sample_type.unit` 用 `count`；
- 否则 `sample_type.unit` 用 engine 自己的 `units()`；
- `period_type` 始终使用 engine 的 `type()` 与 `units()`；
- `_period` 若非正数，则兜底写 1（`src/otlp.cpp:115-117`、`src/otlp.cpp:140-141`）。

这也是为什么测试会显式盯住这些字段。`test/test/otlp/OtlpTests.java:23` 会检查直接 OTLP 下 `sampleType = itimer/count`、`periodType = itimer/ns`；`test/test/otlp/OtlpTests.java:38` 会检查 total 模式下 `sampleType` 变成 `itimer/ns`；`test/test/otlp/OtlpTests.java:53` 则会检查从 JFR 转出来的 OTLP 是否保留 `period = 20ms` 和 `periodType = cpu/nanoseconds`。这些测试其实都在强调：平台不是只关心“值是多少”，还关心“这个值按什么单位解释、采样器本来按什么周期运转”。

### sample body 为什么只写索引和值，不再重复写字符串

有了 `_samples_info` 之后，`recordOtlpProfile()` 写每条 sample 就很直接了：

- `Sample::stack_index = i + 1`，因为 `stack_table[0]` 预留给空栈；
- 如果有线程属性，就写 `Sample::attribute_indices = thread_name_index`；
- `Sample::values = si.samples` 或 `si.counter`，取决于当前选择（`src/otlp.cpp:119-129`）。

```text
dictionary 先定义：
  stack_table[1] = stack A
  attribute_table[3] = thread.name = "GC Thread#0"

sample body 再引用：
  stack_index = 1
  attribute_indices = 3
  values = 42
```

这再次说明 OTLP 的关键不是“把所有人类文本塞进每条 sample”，而是让 dictionary 承担高重复度对象，让 sample body 只承担关系和值。也正因为如此，测试里才能从 OTLP 再逆推出 collapsed：`test/test/otlp/OtlpTests.java:110` 会把 dictionary 中的 stack/location/function 重新拼回字符串栈，并验证它和原始 profile 的热点路径一致。

### 当前实现为什么只写一个 profile

`record()` 现在只创建一个 `resource_profiles`、一个 `scope_profiles`，再在其中写一个 profile（`src/otlp.cpp:134-145`）。这里没有按线程、按事件类别、按资源属性拆出多个 profile，也没有填丰富的 resource metadata。这个边界必须守住：当前实现可以说是“生成一个最小可消费的 OTLP profile”，但不能夸写成“完整多资源、多 scope 的通用 exporter”。

## 第六层：为什么仓库里还必须保留 `JfrToOtlp.java`

如果 native `otlp.cpp` 已经可以直接从内存里的 `CallTraceSample` 生成 OTLP，那么仓库里为什么还要保留 `JfrToOtlp.java`？答案不是重复造轮子，而是部署路径不同。

native 直出适合一种场景：profile 刚结束，调用方立刻就想拿到一段平台可消费的 protobuf，最好直接通过 `dumpOtlp()` 的 `byte[]` 返回，或者通过文件、回调、网络再往外送。这条路依赖的是进程内还活着的 `CallTraceStorage`、`FrameName` 和 active engine。

而 `JfrToOtlp.java` 服务的是另一种场景：目标机已经只保存了 JFR，或者 profiling 和后处理本来就不在一台机器上，后续想在分析机、批处理流程或 converter 工具链里再导出 OTLP。这时你手里已经没有 `CallTraceStorage` 了，只有 JFR event stream。于是只能从 JFR 里重建 profile model，再编码成 OTLP。

测试正好把这两条链的消费者压力拉得很具体。`test/test/otlp/OtlpTests.java:58` 会从 JFR 转 OTLP 再检查 period；`test/test/otlp/OtlpTests.java:81` 会检查 thread.name；`test/test/otlp/OtlpTests.java:106` 会把 JFR→OTLP 结果再还原成 collapsed，验证热点路径依旧正确。也就是说，离线路径不是“另一种随便转转”的附属工具，而是在证明：两条链虽然中间表示不同，但最终落到平台协议上时，必须保住同样的核心语义。

从 converter 侧的源码名字也能看出，它面对的是另一种中间世界。`JfrToOtlp.java` 维护的是 chunk-private cache、JFR reader 状态和自己的一套 OTLP 常量（搜索结果已显示 `chunk-private cache`、`functionPool`、`attributesPool` 等）。这说明它不是 native writer 的 JNI 包装层，而是面对“JFR 已经成为既成事实”时的一套独立转换器。

所以这里必须把一个失败方案彻底打掉：`otlp.cpp` 和 `JfrToOtlp.java` 不是同一实现的在线/离线包装。它们共享目标协议，但不共享中间表示；一个从 `CallTraceStorage` 出发，一个从 JFR event stream 出发。

这里的架构分工，其实和前两篇正好收成一条线：

- flamegraph：native 直接生成给人看的 HTML；
- JFR：native 直接生成给 JFR reader 读的 chunk 文件；
- OTLP：native 直接生成给 OTel 生态消费的 protobuf；
- converter：补上“先落 JFR，后离线转 OTLP”的物理分离工作流。

*关键设计（斜体）：* *格式层不是单选题，而是围绕不同消费者保留多条导出链；native 直出与离线转换共享目标协议，但不共享中间表示，也不服务同一类部署场景。*[模式: 多消费者导出 + 在线/离线分离]

## 常见误解与实现边界

**误解一：OTLP 输出就是 Prometheus、pprof 或某种文本 profile。** 当前实现输出的是 protobuf 编码的 OTLP Profiles 风格数据，通过 `ProtoBuffer` 和字段号常量拼接二进制，不是文本 exposition。

**误解二：OTLP 只能从 JFR 转出来。** 当前 native `dumpOtlp()` 直接消费 `CallTraceStorage`；`JfrToOtlp.java` 只是另一条离线路径。

**误解三：dummy mapping、zero link、thread-only attributes 说明实现已经完整覆盖 OTLP exporter 语义。** 当前实现只写最小兼容字典，不等于完整 mapping/link/resource 建模。

**误解四：`recordStacks()` 第一次遍历 trace 时完全可以顺手把 sample body 一起写完。** 当前设计要先稳定 dictionary universe，再让 sample body 引用这些索引；`_samples_info` 正是两阶段构造的桥。

**误解五：`stack_table` 里的 location 已经包含完整地址/文件/行号信息。** 当前实现更接近“函数名索引驱动的位置表”；它没有像 JFR 那样在 writer 阶段恢复 line/bci/type 的细粒度元数据。

**误解六：切换 `counter` 后，所有 0 值样本都会被自动过滤。** 当前 `recordStacks()` 过滤的是 `samples == 0`，不是最终选中的 `counter` 值。

**误解七：native `otlp.cpp` 和 `JfrToOtlp.java` 只是同一套 writer 的两层包装。** 两者共享目标协议，但一个吃 `CallTraceStorage`，一个吃 JFR，不共享中间表示。

## 收网：OTLP 真正做的是把采样重排成平台可索引的 profile 协议

如果把整条链压成一句话，OTLP 不是把 flamegraph 或 JFR 再换个壳输出，而是把采样结果重新排成“dictionary 定义对象 universe，sample body 只引用关系和值”的机器协议。平台最终读到的，不再是人类视图或 JFR reader 视图，而是一份更适合聚合、索引和跨系统传输的 profile 模型。

```text
CallTraceStorage.collectSamples()
  → FrameName：名称、线程帧、过滤
    → Otlp::Recorder.recordStacks()
      → stack_table / function_table / attribute_table / string_table
        → _samples_info 缓存 values + thread attribute
          → recordOtlpProfile()
            → sample_type / period_type / period / samples
              → ProtoBuffer
                → Writer
```

到这里，主线只发生了三件事。

第一，native 侧先把高重复度对象拆成 dictionary，所以平台看到的不是重复栈字符串，而是一套可引用的 stack/function/location/attribute/string universe。

第二，sample body 不再重复写人类文本，只承担 stack/attribute 索引、value 以及 sample_type/period 语义。

第三，native 直出与 JFR→OTLP converter 不是同一实现的两层包装，而是两条面向不同部署场景的导出链：共享目标协议，不共享中间表示。

*关键设计（斜体）：* *OTLP 导出把 profile 看成“字典 + sample 关系”的协议对象：先建立 object universe，再让 sample body 只写索引、单位、周期和值。*[模式: dictionary-first encoding + sample indirection]

**本篇的一句话困惑**：async-profiler 怎样把内存中的调用栈样本直接变成可被 OTLP/可观测性平台消费的 profile 数据？

**本篇的一句话顿悟**：它不经过 HTML 或 JFR 中转，而是直接把 `CallTraceSample` 编码成 OTLP Profiles 的 dictionary、stack、function、attribute 和 sample 消息；需要离线工作流时，仓库再提供独立的 JFR→OTLP converter。

AP-5 至此收束：同一份采样数据已经分别落成给人看的 flamegraph、给 JFR reader 读的 chunk 文件，以及给 OTel 生态吃的 protobuf profile。下一卷进入 AP-6，观察 Java API 如何把这些 native 输出能力桥接到 `AsyncProfiler.execute()`、`dumpOtlp()`、`execute1()` 等上层入口。

[跨层标注：C++ `CallTraceStorage`/`FrameName`；protobuf wire format；OTLP Profiles dictionary/sample schema；Writer 抽象；Java API `dumpOtlp()`；Java converter `JfrToOtlp`; 直接导出 vs 离线转换]
