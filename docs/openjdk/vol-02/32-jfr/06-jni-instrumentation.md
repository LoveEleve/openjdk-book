# 06. Java 代码怎么控制 JFR?— JNI Interface + Instrumentation + DCmd

> **前置依赖**:[32-jfr/01 — JFR 怎么在每个线程上采集事件?— Recorder Engine](openjdk/vol-02/32-jfr/01-recorder-engine.md):录制生命周期(`JfrRecorder::start_recording` 等);[32-jfr/02 — JFR 有 130 种事件类型 — 它们怎么定义?— Event Types + Metadata](openjdk/vol-02/32-jfr/02-event-metadata.md):事件类与 `EventClassBuilder`;[30-jvm-entry/01 — System.currentTimeMillis() 怎么进入 JVM?— JVM Entry Points](openjdk/vol-02/30-jvm-entry/01-jvm-entry-points.md):JVM 接口的注册模式;[35-dcmd/01 — 诊断命令框架](openjdk/planning/outlines/35-dcmd/01-dcmd-framework.md):DCmd 框架
> → **后续**:[33-jmx-management/01 — JConsole 怎么知道 Eden 用了多少?— MemoryService + MemoryPool](openjdk/planning/outlines/33-jmx-management/01-memory-service.md)
> 关联域: 30-jvm-entry、28-jvmti、35-dcmd

前 5 篇拆的都是"采集引擎内部"：buffer、metadata、周期采样、二进制写出、泄漏剖析。但真正让用户感觉“JFR 可用”的不是这些内部结构，而是**控制面**：

1. Java 代码怎么调 JVM 打开/关闭录制?
2. `jdk.jfr.Event` 子类怎么被“补全”成可提交事件的类?
3. `jcmd JFR.start` 怎么进入 JFR?

这三条控制通道共享一个模式:**C++ 侧只是薄壳,真正的决策都在 Java 侧。** JNI 接口只是转发,类转换器只在类创建期补 schema,DCmd 只是把命令参数翻成 Java 对象。

---

## 1. 开场困惑——"谁在控制 JFR"

JFR 看起来像 JVM 内核的一部分——采样线程、Recorder Thread、chunk writer 都在 native 侧。但从用户视角看,它又完全是 Java API: `Recording.start()`, `Event.commit()`, `jcmd JFR.start`。这说明控制面有两层:

- **native 侧**: 提供最薄的入口,把 Java 调用转成录制状态机/事件类转换器的动作;
- **Java 侧**: 负责策略、参数解析、生命周期编排。

如果把所有决策都塞进 C++,那 JDK API 一变就得改 HotSpot;如果完全交给 Java,又没法碰底层的采样器、chunk writer、Recorder Thread。JFR 的做法是中间折中: **Java 决策 + native 执行。**

---

## 2. 两个朴素方案为什么都不对

### 方案一: 把 JFR 控制逻辑全写在 C++

这样似乎最统一——启动录制、停录制、设置阈值都在 native 里做。但这会把本应属于 `jdk.jfr` 模块的 API 语义硬编码进 HotSpot。Java 层想新增一个 Recording 选项、改一个默认值、加一个 `@Period` 解释规则,都得改 VM。

### 方案二: 把 native 层完全当哑巴

另一端是“所有控制逻辑都用 Java 做,不碰 native”。但 Recorder Thread、采样器、事件 buffer、chunk 写出都在 native 侧。Java 不可能自己直接操作这些结构,最终还是要通过 JVM 入口打洞。

正确方案就是三条通道共享的那条主线: **C++ 侧是薄壳,负责把 Java 侧的意图变成 native 动作;真正的决策(要不要启、怎么配、什么时候调)由 Java 侧完成。**

---

## 3. JNI 接口——一组薄 JVM/JNI 入口

Java 侧 `jdk.jfr.internal.JVM` 的 native 方法全部落在 `jfrJniMethod.cpp`。它们和 30-01 的 `JVM_*` 入口一样,本质上都是一组薄 JVM/JNI 入口：有的走 `JVM_ENTRY`/`JVM_ENTRY_NO_ENV`,有的走更轻量的过渡宏，但共同点都是**不做策略决策,只把 Java 侧参数搬进 native**。

这些函数的共同特点是**薄转换**:

- `jfr_set_output`：设置 chunk 输出路径;
- `jfr_set_method_sampling_interval`：把 Java 侧 period 配置落到 native 采样器;
- `jfr_emit_event`：触发普通周期事件;
- `jfr_start_recording` / `jfr_end_recording`：投 `MSG_START` / `MSG_STOP` 给 Recorder Thread。

它们不承担“策略”——不判断某个事件该不该启、不计算默认 period、不解析 JFC 配置。这些都在 Java 侧先决定好,JNI 层只做参数搬运和一次 native 调用。

这里顺便澄清两点:

1. **没有大纲想象的 `JfrJniMethod::start(JfrStartFlightRecording,...)` 类方法**。JFR 控制接口不是一套手写 OO facade,而是一组薄 JNI 入口。
2. Java↔C++ 的真正“上下文”是线程的 `JfrThreadLocal` 与全局录制状态机,不是额外塞进某个 `JfrJavaSupport` 字段里的引用。

---

## 4. 事件类转换器——类创建期的 schema 补全

用户写的 `class MyEvent extends jdk.jfr.Event` 只有字段声明。`isEnabled()/commit()/begin()/end()` 等方法不是预先写死在源码里,而是**类加载期补全**的。

关键入口不在 Java 代码里,而是在 klass 创建钩子:

```cpp
// klassFactory.cpp:216-222(截取核心,逐字)
  if (result->should_store_fingerprint()) {
    result->store_fingerprint(stream->compute_fingerprint());
  }

  JFR_ONLY(ON_KLASS_CREATION(result, parser, THREAD);)
```

`ON_KLASS_CREATION`(jfrKlassExtension.hpp:41)对**带事件标记的类**(`IS_EVENT_KLASS`,即 `jdk.jfr.Event` 子类)调 `JfrEventClassTransformer::on_klass_creation`。它干的不是“在方法入口插一段埋桩代码”,而是更早的一步: **先生成新的类字节,再重新解析成事件类版本的 `InstanceKlass`**。是否进一步走 eager instrumentation,还要看录制状态与 `force_instrumentation` 分支。核心动作包括:

- `create_new_bytes_for_event_klass`：生成替换后的 class bytes;
- 重新解析出新的 InstanceKlass;
- 打上 `JdkJfrEvent::tag_as` 标记。

注入的内容是**事件类 schema**: 5 个方法壳(`commit/isEnabled/begin/end/shouldCommit` 等,空方法体字节 `empty_void_method_code_attribute`)与 3 个字段(EventHandler 等)。

但这还不是最终形态。**真正的方法体**在“急切注入”时由 Java 侧 `EventInstrumentation` 用 ASM 生成——`JfrUpcalls::new_bytes_eager_instrumentation` 把类字节交给 Java,拿回注入后的字节。也就是说:

- native 侧负责在类加载链路里发现“这是个事件类”,并把 schema 形状补齐;
- Java 侧负责真正的字节码织入。

因此,转换器**只动事件类本身**,不是“对所有 JFR 相关类统一插桩”。非事件类零改动,零开销。

---

## 5. DCmd——`jcmd` 进来后先回 Java

`jcmd <pid> JFR.start ...` 最终落地是 `JfrStartFlightRecordingDCmd`(jfrDcmds.hpp:83,`name()` 返回 `"JFR.start"`)。它的 `execute`(jfrDcmds.cpp:376)干的其实也是“薄壳 + 转发”:

```cpp
// jfrDcmds.cpp:376-397(截取核心,逐字)
void JfrStartFlightRecordingDCmd::execute(DCmdSource source, TRAPS) {
  DEBUG_ONLY(JfrJavaSupport::check_java_thread_in_vm(THREAD));
  ...
  JavaValue result(T_OBJECT);
  JfrJavaArguments constructor_args(&result);
  constructor_args.set_klass("jdk/jfr/internal/dcmd/DCmdStart", THREAD);
  const oop dcmd = construct_dcmd_instance(&constructor_args, CHECK);
  Handle h_dcmd_instance(THREAD, dcmd);
  ...
  jstring name = NULL;
  if (_name.is_set() && _name.value() != NULL) {
    name = JfrJavaSupport::new_string(_name.value(), CHECK);
  }
  ...
```

它把命令行参数翻成 Java 对象(`jstring`/`Long` 等),构造 **`jdk.jfr.internal.dcmd.DCmdStart`** 实例,再经 **JavaCalls** 调 Java 的 `run()`。之后就是 Java 侧的逻辑:`Recording.start()` → JNI 接口 → `jfr_start_recording` → `JfrRecorder::start_recording` 投 `MSG_START`。

所以 **DCmd 只负责参数形状的翻译,决策全在 Java 侧**——和 JNI 接口完全同构。

---

## 6. 误解澄清与收网

1. **Java 代码控制 JFR 是不是直接操作 native 结构?** 不是。Java 侧通过一组薄 JNI 入口把意图传给 native,Recorder Thread/采样器/状态机仍在 native 里执行。
2. **事件类转换器是不是在方法入口插埋桩?** 不是。它在类创建期重写 class bytes,补齐事件类 schema;真正的方法体由 Java 侧 `EventInstrumentation` 用 ASM 生成。
3. **DCmd 是不是直接在 C++ 里启动录制?** 不是。C++ 侧只把参数翻成 Java 对象,再调 `DCmdStart.run()`;录制策略与默认值在 Java 侧。
4. **三条控制通道是不是三套完全不同的机制?** 不是。共同模式都是“薄 C++ 壳 + Java 侧决策”。
5. **非事件类会不会被 JFR 转换器改写?** 不会。只有 `jdk.jfr.Event` 子类命中 `IS_EVENT_KLASS` 才会被改写。

把这一篇压成三句话:

- **JNI 接口**是一张 JVM 入口表,只做参数搬运和薄转换。
- **事件类转换器**在类加载期补 schema,真正的方法体由 Java 侧 ASM 生成。
- **DCmd** 只负责把命令参数翻成 Java 对象,再交给 Java 侧 `DCmdStart.run()` 决策。

32 域收官。JFR 之外还有一套**管理面**: `jconsole`/JMX 怎么拿到 JVM 的运行时信息(内存/线程/GC 计数器),`ManagementFactory` 的 JVM 侧实现是什么?下一篇: JMX & Management。

> → [33-jmx-management/01 — JConsole 怎么知道 Eden 用了多少?— MemoryService + MemoryPool](openjdk/planning/outlines/33-jmx-management/01-memory-service.md)