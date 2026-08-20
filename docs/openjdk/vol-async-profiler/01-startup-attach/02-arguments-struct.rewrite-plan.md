# 02-arguments-struct 重写规划

> 状态：正文已重写，deep review 修订中
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“参数解析器与字段清单”重写成一篇围绕“同一条命令协议如何在边界处保留语义、在运行时变成可校验配置”的机制文章

## 1. 选题判断

这篇值得独立成篇，但不能继续写成 `arguments.cpp` CASE 表和 `arguments.h` 字段目录。它真正的闭环问题是：CLI、C API 和 Java/native 入口怎样把人类参数交给同一个解析器；解析器如何处理动作、事件、输出、单位、默认值和错误；以及为什么后续 engine 不应继续解释原始字符串。

本篇只讲参数语义中心与配置对象的形成，不提前展开 event engine 如何消费字段，也不把 `Arguments` 写成严格不可变或天然线程安全的对象。当前实现还包含 `_global_args` 保存、`save()`、临时日志和 start/stop 生命周期，正文必须按源码能证明的强度表述。

## 2. 读者困惑

用户输入 `asprof start,event=cpu,file=/tmp/result.html,timeout=30s`，这些字符串到底在哪里变成真正的运行配置？

- 为什么动作和输出都混在一条逗号串里？
- `cpu`、`alloc`、`lock` 为什么不是简单字符串，而会改变多个字段和默认阈值？
- `10ms`、`512k`、`30s` 如何归一化，非法单位在哪里失败？
- `Arguments` 是一次解析后的只读快照，还是 profiler 生命周期中可保存、复用和修改的状态对象？
- 为什么枚举顺序会影响 JFR、rate limit 和其他跨文件逻辑？
- 参数解析成功是否等于这次 profiling 一定能启动？

## 3. 一句话顿悟

**`Arguments::parse()` 不是把字符串简单拆成字段，而是在一个统一逗号协议上完成动作选择、事件派生、单位归一化、默认值补齐和错误积累；`Arguments` 是后续 native 模块共享的配置载体，但它的生命周期、保存和校验仍属于当前 profiler 实现，不应被夸写成抽象不可变对象。**

总图：

```text
CLI / C API / Java native bridge
  → command string
    → Arguments::parse
      → strtok comma segments
        → key/value + CASE dispatch
          → enum / bit flags / numeric thresholds / vectors
            → parse-time defaults and validation
              → Profiler::runInternal / engine / writer / recorder
```

## 4. 版本与范围边界

- 基于当前 async-profiler 源码，所有行号写作时重新核对。
- `arguments.cpp` 是当前 native 参数语义中心，但不同入口可能在进入它之前做少量包装或直接传入不同命令串。
- `Arguments` 是 C++ 对象，不直接宣称“不可变”“并发安全”；正文应区分 parse 阶段、`save()` 后的复用和运行阶段读取。
- `event=cpu`、`event=alloc` 等输入的最终效果可能是设置多个字段，不应简化为只写 `_event`。
- `parseTimeout()` 的冒号格式是当前实现的打包编码；是否在运行时被解释为某种绝对时刻，要以调用方和 stop 逻辑源码为准。
- `SHORT_ENUM` 只适用于标记的枚举，`Style` 和 `JfrOption` 是不同的存储形态。
- 枚举顺序存在跨文件契约，但不能笼统称为 ABI；需要分别给出 `CStack`/FlightRecorder、`EventCategory`/rate limit/JFR 等证据。

## 5. 现稿方法论差距审计

- 从参数清单开篇，缺少“同一字符串为什么要由 native 统一解释”的事故困惑。
- 失败方案不足：每个入口各写 parser、把 event 当字符串一路传递、每个 engine 自己解析单位、用全零初始化代替语义默认值、把 parse 成功当成 profiling 成功。
- `_event = "cpu"` 的表述与当前 `CASE("cpu")` 实现不符；alloc/lock 等事件还会设置阈值字段。
- “Arguments 是不可变、可并发读取快照”的表述强于源码证据；需要纳入 `_global_args`、`save()` 和 `runInternal()` 生命周期。
- `timeout` 绝对时间的解释需要补调用方证据，不能只根据 `parseTimeout()` 的位打包推断用户语义。
- `SHORT_ENUM`、跨文件枚举契约和 `eventMask()` 目前没有形成一张角色/状态图。
- 文章缺少“解析错误、未知参数、重复 event、默认值补齐”作为失败路径。

## 6. 重写策略

1. 以线上命令“看似合法但启动失败/结果不对”的场景开篇。
2. 推演并否定：各入口各自解析、运行层持续比较字符串、全零默认值、parse 成功即启动成功。
3. 给出协议总图：入口包装 → 逗号 token → CASE 分派 → 派生字段/默认值/错误 → 生命周期消费。
4. 分层讲解：
   - `parse()` 如何保护原始字符串并拆分 token；
   - 动作/输出/事件如何进入枚举和字段；
   - event 的派生语义与 `eventMask()`；
   - 单位、timeout、ratelimit 的归一化和失败；
   - 构造器默认值、`save()` 与运行时消费边界；
   - 枚举顺序如何成为跨文件契约。
5. 收网时明确：parse 是配置形成阶段，不等于 JVM 能力、perf 权限、engine 或输出都成功。

## 7. 结构大纲

### 第一节：事故开场——命令字符串看起来正确，profiler 却可能拒绝启动

回答：参数从哪里开始有语义、为什么本篇不是帮助文档、解析成功和运行成功为何不同。

预估字数：800-1000

### 第二节：先排除四个直觉方案——各入口解析、字符串贯穿、全零默认值、解析成功即运行成功

回答：为什么要统一语义中心、为什么单位不能散落在 engine、为什么 `-1/0/false` 都可能有不同含义、为什么 parse 后仍有能力和资源检查。

预估字数：1400-1800

### 第三节：第一层——`Arguments::parse()` 把命令串变成 token 流

证据：`arguments.cpp:41-60`。

回答：可修改缓冲区、逗号分段、可选 value、CASE hash dispatch、错误消息与未知参数边界。

预估字数：1400-1700

### 第四节：第二层——动作、输出和事件不是同一种字段

证据：`arguments.cpp:60-235`、`arguments.h:30-106`。

回答：Action/Output/Counter 的不同职责；`cpu`、`alloc`、`lock`、`all` 如何派生多个配置字段；`eventMask()` 如何把字段映射成后端事件集合。

预估字数：1800-2200

### 第五节：第三层——单位归一化与 timeout 编码

证据：`arguments.cpp:529-563`、`arguments.h:120-128`。

回答：数字、后缀、大小写、倍率、非法输入；timeout 无冒号与有冒号路径的实现边界；不把位打包直接写成完整业务语义。

预估字数：1500-1900

### 第六节：第四层——默认值、保存与运行时生命周期

证据：`arguments.h:225-288`、`arguments.cpp:428-429`、`profiler.cpp:1570-1663`、`arguments.cpp:17-18`。

回答：显式默认值的差异；无 action 时输出如何推导 dump；`_global_args`/`save()` 如何参与 start/resume/stop；为什么不能把对象简单称为不可变快照。

预估字数：1700-2100

### 第七节：第五层——枚举与数组怎样变成跨文件契约

证据：`arguments.h:57-106`、`flightRecorder.cpp:76`、`:646-649`、`arguments.cpp:565-588`、`flightRecorder.cpp:1451`。

回答：CStack 与 JFR setting、EventCategory 与 rate limit/JFR event category 的对应关系；哪些修改必须同步，哪些不能泛化为 ABI。

预估字数：1300-1700

### 第八节：收网——解析形成配置，但不替代运行时能力检查

必须区分：字符串协议、配置对象、JVM/OS 能力、engine 启动、record/output；桥接下一篇 fdtransfer/attach 或事件引擎，以实际目录顺序为准。

预估字数：800-1000

## 8. 必须展开的失败方案

1. CLI、Java API、C API 各自维护一套参数解释器。
2. 把原始字符串留给每个 engine/writer 自己解析。
3. 用全零初始化替代 `-1`、默认 interval、默认 depth 等语义默认值。
4. 把 `event=alloc/lock/all` 误解成只设置一个 event 字符串。
5. 把 parse 返回成功当作 JVM 能力、perf 权限和 profiling 已成功。

## 9. 证据清单

- `src/arguments.cpp:41-60`：解析缓冲区、token 和 CASE 分派。
- `src/arguments.cpp:62-235`：动作、输出、事件和派生字段。
- `src/arguments.cpp:529-563`：单位与 timeout。
- `src/arguments.h:30-106`：枚举、位标志和跨文件注释。
- `src/arguments.h:150-288`：字段与默认值。
- `src/arguments.h:300-319`：`hasOutputFile()`、`eventMask()`、静态解析函数。
- `src/arguments.cpp:428-429`：无 action 时从 output 推导 dump。
- `src/arguments.cpp:17-18`、`src/profiler.cpp:1570-1663`：配置保存与运行消费。
- `src/flightRecorder.cpp:76`、`:646-649`、`:1451`：JFR 配置契约。
- `src/arguments.cpp:565-588`：rate limit 类别映射。

## 10. 完成后检查

1. 删除代码块后仍能复述“协议 → 配置 → 生命周期 → 运行时消费”。
2. 至少展开 4 个失败方案。
3. 不把 `_event`、`eventMask()`、派生阈值写成同一件事。
4. 不把 `Arguments` 夸写成天然不可变或线程安全对象。
5. 不把 timeout 位编码直接推导为完整绝对时间语义。
6. 每个 `file:line` 重新核对，禁用词和相对链接通过。
