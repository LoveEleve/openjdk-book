# 04. Java 世界为什么没有另一套 profiler —— `execute0`、`execute1`、RegisterNatives 与 JNI 桥

> **前置依赖**：[03 —— 采样拿到的是地址，为什么最后能看到 Java 方法名](./03-vmstructs-stackwalk.md)：知道 JVM 集成已经把事件、栈和地址恢复接进 native 内核。
> → **后续**：进入 AP-4 栈行走与符号解析
>
> 本篇基于当前 async-profiler 源码。重点是 Java 世界如何把字符串命令、快捷入口和 helper 接到 native profiler 内核上，不把 Java API 误写成另一套独立实现。

## Java API 看起来像一层完整封装，但真正执行仍然在 native

场景：Arthas、业务代码或某个 Java 工具直接调用：

```java
AsyncProfiler.getInstance().execute("start,event=cpu")
```

如果只看 Java 侧，很容易产生一个错觉：好像 async-profiler 在 JVM 内部还有一套 Java 版 profiler，`execute()`、`start()`、`dumpCollapsed()` 这些方法只是在 Java 世界里转来转去。源码不是这样组织的。

真正的桥接链更像：

```text
AsyncProfiler.java / Recording.java
  → start0 / stop0 / execute0 / execute1 / getSamples / filterThread0
    → javaApi.cpp
      → Arguments or direct Profiler entry
        → Profiler::runInternal / start / stop / ThreadFilter / RecordingAPI
          → native engine / recorder / output
```

这条链说明，Java API 并不拥有另一套采样内核。它的职责主要是：

- 把 Java 的 `String`、`byte[]`、`Thread`、`ByteBuffer`、异常体系接到 native；
- 选择“这次结果要走字符串、字节数组、文件还是 DirectByteBuffer”；
- 在 shaded 场景里找到真正的 AsyncProfiler 类并绑定 native 方法。

因此，本篇真正要回答的不是“Java API 有哪些方法”，而是：**为什么 Java 世界看起来像一层完整 API，但参数语义、真正执行和结果产生仍然在 native 侧。**

*关键设计（斜体）：* *Java API bridge 统一的是 Java 世界的载体和契约，不是 profiler 内核；参数和执行真相仍然在 native。* [模式: Java 世界做桥，native 世界执行业务]

## 先推翻四个最容易把 Java API 讲错的直觉

### Java API 就是另一套 profiler 实现

不是。`execute0` / `execute1` 会重新进入 `Arguments::parse()` 与 `Profiler::runInternal()`；`start0` / `stop0` 则直接调用 `Profiler::start()` / `stop()`。Java 侧没有另起一套采样器，它只是选择“如何把命令和结果送进/带出 native”。

### `execute0`、`execute1`、`start0`、`stop0` 只是同一入口的不同重载

也不是。它们分成了两类：

- `execute0/execute1`：字符串协议入口，重新走 `Arguments::parse()`；
- `start0/stop0/getSamples/filterThread0/Recording helper`：强类型快捷入口，直接操作 profiler 状态或辅助结构。

把这两类混成“同一套路”之后，就会解释不清为什么 `execute1` 禁止 output file、为什么 `start0` 根本不经过 `Arguments::parse()`。

### `execute0` 有文件时应该像无文件时一样返回完整文本

源码明确不是这样。它的返回契约是：

- 无 output file：通过 `BufferWriter` 收集文本，再返回 Java `String`；
- 有 output file：结果通过文件落盘，Java 返回值只给 `"OK"`。

这不是“偷懒”，而是桥接契约：既然结果已经明确以文件形式交付，返回值就不再承担完整内容载体。

### RegisterNatives 直接靠固定 JNI 类名就够了

对非 shaded 场景似乎没问题，但 async-profiler 还要支持 Java API 类被重命名、搬包甚至被嵌到其他工具里。当前实现因此没有把“真正要注册到哪个 Java 类”写死在 native 侧，而是运行时沿 `System.load()` / `System.loadLibrary()` 栈往回找真实类。

## 第一层：为什么字符串入口和强类型快捷入口必须并存

### `execute0` / `execute1`：字符串协议入口

`src/javaApi.cpp:55-125` 的 `execute0` / `execute1` 代表的是“把 Java 侧命令串重新送回 native 协议中心”。两者共同点是：

- `GetStringUTFChars` 取出 Java 字符串；
- `Arguments args;` 后调用 `args.parse(command_str)`；
- `ReleaseStringUTFChars` 释放 Java 侧副本；
- `Log::open(args)` 后再进入 `Profiler::runInternal(args, out)`。

也就是说，字符串协议在 Java 侧并没有被重新解释一次。真正的参数语义仍然回到我们前面几篇已经建立过的 `Arguments::parse()`。

### `start0` / `stop0`：强类型快捷入口

`src/javaApi.cpp:25-53` 的 `start0` / `stop0` 则明显不一样：

- `start0` 接收 `event`、`interval`、`reset` 三个强类型参数；
- 对 `alloc`、`lock` 这类事件直接写 `_alloc`、`_lock`；
- 其他事件走 `_event = event_str` 与 `_interval = interval`；
- 最后直接调用 `Profiler::instance()->start(args, reset)`；
- `stop0` 则直接调用 `Profiler::instance()->stop()`。

这说明 Java bridge 同时维护了两种入口哲学：

```text
字符串入口：把 native 协议原样带回去
强类型入口：为高频 API 提供更窄、更直接的桥
```

这两种入口并存不是重复，而是在桥接层做 API 取舍：复杂组合和完整参数语义继续交给字符串协议；高频 start/stop 则提供更少类型转换、更少命令拼接的快捷路。

*关键设计（斜体）：* *Java bridge 既保留完整字符串协议，也为少量高频动作提供强类型快捷桥；两者共享 native 内核，但不共享参数承载方式。* [模式: 协议入口 + 快捷入口并存]

## 第二层：`execute0` 与 `execute1` 的区别不在“命令”，而在输出契约

### `execute0`：文本或文件二选一

`Java_one_profiler_AsyncProfiler_execute0()` 位于 `src/javaApi.cpp:55-94`。它的顺序是：

1. 解析命令；
2. 参数错误直接抛 `IllegalArgumentException`；
3. `Log::open(args)`；
4. 若 `!args.hasOutputFile()`，用 `BufferWriter` 执行 `Profiler::runInternal()`，成功后把缓冲转成 Java `String`；
5. 否则用 `FileWriter` 执行同一内核，成功后只返回 `"OK"`；
6. 失败则抛 `IllegalStateException` 或 `IOException`。

这里最值得强调的是“有文件时只返回 `OK`”这条边界。它不是 profiler 结果被截断，而是 JNI 桥在说：当前这次调用的结果交付通道已经是文件，Java 返回值只承担操作成功的确认。

### `execute1`：返回值就是唯一二进制结果通道

`Java_one_profiler_AsyncProfiler_execute1()` 在 `src/javaApi.cpp:96-125` 仍然先 parse command，但在真正运行前多了一条非常硬的限制：

```cpp
if (args.hasOutputFile()) {
    throwNew(..., "execute1 calls should not specify an output file argument");
    return NULL;
}
```

之后它固定使用 `BufferWriter`，跑完 `Profiler::runInternal()` 后创建 Java `byte[]` 把内容拷回去。也就是说：

- `execute0` 允许“文本内存返回”或“文件返回”；
- `execute1` 强制“二进制内容只能经返回值带回 Java”。

这不是实现细节，而是 API 契约。否则调用者根本无法知道“返回值”和“文件输出”到底谁才是这次调用的权威结果载体。

### 异常映射也是桥的一部分

这两个函数还一起定义了 Java 世界里可见的错误模型：

- parse 失败 → `IllegalArgumentException`；
- 文件打不开 → `IOException`；
- native 执行失败 → `IllegalStateException`。

因此 JNI 桥并不只做类型转换，它还把 native world 的失败语义翻译成 Java 调用方可预期的异常边界。

## 第三层：不是所有 Java native 方法都要走 `Arguments::parse()`

前面已经建立过一个关键边界：`execute0/execute1` 是字符串协议入口，但这不代表所有 Java native 方法都要先 parse 一条命令串。

`src/javaApi.cpp` 里还同时导出了：

- `getSamples()`（`:127-130`）：直接读 `Profiler::instance()->total_samples()`；
- `filterThread0()`（`:132-147`）：把 Java `Thread` 转成 native thread id，再操作 `ThreadFilter`；
- `Recording.registerNatives()`（`:149-152`）：转给 `RecordingAPI::registerNatives()`；
- `Recording.getThreadLocalBuffer()`（`:154-158`）：把 native `asprof_thread_local_data` 视图暴露成 `DirectByteBuffer`；
- `Recording.emitSpan()`（`:160-173`）：把 Java span 事件转成 `recordEventOnly(SPAN, &event)`。

这些 helper 的共同点是：它们共享同一个 profiler 内核和状态，但不共享同一条参数承载方式。

例如 `filterThread0()` 并不解析命令串，而是：

1. 若 thread 为 null，就对当前线程取 native id；
2. 否则通过 `VMThread::nativeThreadId(env, thread)` 桥到 native thread id；
3. 然后直接对 `ThreadFilter` 执行 add/remove。

这说明 Java bridge 的真正统一点不是“所有 API 都走 Arguments”，而是：**所有 API 最终都在操作同一个 native profiler 状态，只是桥接输入形式不同。**

## 第四层：RegisterNatives 为什么一定要运行时找真实 AsyncProfiler 类

### 直接写死 JNI 类名为什么不够

`src/javaApi.cpp:177-191` 先定义了 `profiler_natives[]` 与 `recording_natives[]` 两张表。这一步还不特殊，真正特别的是 `JavaAPI::registerNatives()`（`javaApi.cpp:196-224`）。

当前实现没有简单地假设“native 一定要注册到 `one/profiler/AsyncProfiler` 这个固定类名”。相反，它先：

1. 用 JVMTI `GetStackTrace` 拿当前调用栈；
2. 找到 `System.load()` 或 `System.loadLibrary()` 所在的帧；
3. 看它的下一帧属于哪个真实 Java 类；
4. 再对这个运行时找到的类逐个 `RegisterNatives`。

### 这是 shaded 兼容，不是炫技

这样做的理由在注释里已经写得很直白：AsyncProfiler 类可能被重命名或移动包位置（shaded）。如果 native 侧把类名写死，就会出现：

- Java 侧已经把类复制到另一个包；
- 类加载成功、`System.load` 也成功；
- 但 native 仍然执着地往旧类名上找方法。

`RegisterNatives` 把“真正注册到哪个类”变成运行时发现的问题，而不是编译期硬编码的问题。对 shaded、嵌入式、工具集成场景来说，这正是桥接层最重要的兼容动作之一。

*关键设计（斜体）：* *RegisterNatives 解耦的是“native 实现函数名”和“Java 类的实际包名/重命名结果”；类身份在运行时发现，而不是写死。* [模式: 运行时类发现 + 显式 native 注册]

## 第五层：Java API 与 C API 共享的是 profiler 内核，不共享的是载体

C API 的 `asprof_execute()` 位于 `src/asprof.cpp:26-52`：

- 构造 `Arguments`；
- `parse(command)`；
- `Log::open(args)`；
- 无文件时走 `CallbackWriter`；
- 有文件时走 `FileWriter`；
- 最终调用 `Profiler::instance()->runInternal(args, out)`。

把它和 Java 的 `execute0/execute1` 放在一起看，会发现共享关系非常清楚：

```text
Java execute0/1: jstring → Arguments → Profiler::runInternal → String/byte[]/file
C API:          const char* → Arguments → Profiler::runInternal → callback/file
```

共享的是：

- `Arguments::parse()` 这一条参数协议中心；
- `Profiler::runInternal()` 这一条真正执行内核；
- engine、recorder、writer 之后的 native 实现。

不共享的是：

- Java 世界的异常类型与返回值契约；
- C API 的回调函数和错误字符串模型；
- Java 特有的 `Thread` / `ByteBuffer` / `RegisterNatives` / shaded 类发现问题。

因此最准确的说法是：**Java API 和 C API 是不同语言载体上的桥，但它们都把调用者重新接到了同一个 native profiler 内核上。**

## 第六层：AP-3 的 Java bridge 收口——Java 世界只是桥，参数和执行真相仍在 native

把整篇压缩成一句话：

```text
Java 层负责承载 String / byte[] / Thread / ByteBuffer / 异常；
native 层负责 Arguments、Profiler、engine、recorder 和 output 真正执行。
```

换一种不看图的复述方式：

- `execute0/execute1` 让 Java 命令串重新回到 native 参数协议；
- `start0/stop0` 给高频动作提供强类型快捷桥；
- `getSamples` / `filterThread0` / `Recording` helper 暴露的是 profiler 现有状态与辅助能力；
- `RegisterNatives` 解决 shaded 和真实类绑定；
- C API 与 Java API 共享 profiler 内核，但不共享语言侧载体。

本篇的一句话困惑是：**为什么 Java API 看起来像一层完整 profiler 封装，但真正执行仍然必须回到 native？**

本篇的一句话顿悟是：**因为 Java bridge 解决的是载体问题，而不是执行问题：字符串命令、强类型入口、线程过滤、Recording helper 和 shaded 类发现都只是在把 Java 世界重新接回 `Arguments` 与 `Profiler` 这条 native 事实主链。**

*关键设计（斜体）：* *Java API 的价值在于“把 Java 调用方接上 native 真相”，而不是在 Java 侧复制一份 profiler。* [模式: 载体桥接，内核复用]

[跨层标注：JNI——`jstring`/`byte[]`/`Thread`/`ByteBuffer` 与 native 类型转换；`Arguments`——字符串协议真相仍在 native；`Profiler::runInternal` / `start` / `stop`——统一执行内核；`ThreadFilter` / `RecordingAPI`——桥接 helper；JVMTI `GetStackTrace` / `GetMethodDeclaringClass`——shaded 场景下的真实类发现]

## 后续：JVM 集成层收束后，进入 AP-4 地址、符号与帧命名

到这里，AP-3 JVM 集成已经把：

- Agent_OnLoad / Agent_OnAttach；
- JVMTI capabilities / callbacks / notifications；
- BytecodeRewriter；
- VMStructs / walkers / CodeCache；
- Java API bridge；

都接到了同一个 native profiler 内核上。

下一层进入 AP-4，不再问“Java 世界怎么调用 profiler”，而要开始问：

- 一个 native 地址怎样映射成符号；
- 一个 Java/JIT frame 怎样变成类名、方法名、line/bci 或类型后缀；
- 为什么最终火焰图上的帧名还能保留 Java/native/JIT 的边界。

**→ 后续：进入 AP-4 栈行走、符号解析与帧命名。**
