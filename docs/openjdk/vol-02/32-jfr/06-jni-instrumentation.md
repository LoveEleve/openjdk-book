# 06. Java 代码怎么控制 JFR?— JNI Interface + Instrumentation + DCmd

> **前置依赖**:[32-jfr/01 — JFR 怎么在每个线程上采集事件?— Recorder Engine](openjdk/vol-02/32-jfr/01-recorder-engine.md):录制生命周期(JfrRecorder::start_recording 等);[32-jfr/02 — JFR 有 130 种事件类型 — 它们怎么定义?— Event Types + Metadata](openjdk/vol-02/32-jfr/02-event-metadata.md):事件类与 EventClassBuilder;[30-jvm-entry/01 — System.currentTimeMillis() 怎么进入 JVM?— JVM Entry Points](openjdk/vol-02/30-jvm-entry/01-jvm-entry-points.md):JVM 接口的注册模式;[35-dcmd/01 — 诊断命令框架](openjdk/planning/outlines/35-dcmd/01-dcmd-framework.md):DCmd 框架
> → **后续**:[33-jmx-management/01 — JConsole 怎么知道 Eden 用了多少?— MemoryService + MemoryPool](openjdk/planning/outlines/33-jmx-management/01-memory-service.md)
> 关联域: 30-jvm-entry、28-jvmti、35-dcmd

## 谁在控制 JFR

前 5 篇拆的都是"采集引擎内部";这篇补**控制面**的三条通道: ①Java 代码怎么调 JVM(JNI 接口);②`jdk.jfr.Event` 子类怎么被"补全"(类加载期的转换器);③`jcmd JFR.start` 怎么进来(DCmd)。三条通道共享一个模式: **C++ 侧是薄壳,决策在 Java 侧**。

## 1. JNI 接口: 一张 JVM_ENTRY 函数表

Java 侧 `jdk.jfr.internal.JVM` 的 native 方法全部落在 `jfrJniMethod.cpp`——与 30-01 的 `JVM_*` 同款模式: `JVM_ENTRY_NO_ENV` 包一层、`JfrJniMethodRegistration` 注册、Java 侧声明。函数都是"薄转换": `jfr_set_output`(设置 chunk 路径)、`jfr_set_method_sampling_interval`(32-03 的采样间隔)、`jfr_emit_event`(32-03 的周期事件)、`jfr_end_recording`(投 MSG_STOP 消息,32-01)。**没有大纲想象的 `JfrJniMethod::start(JfrStartFlightRecording,...)` 类方法**,也没有 `JfrJavaSupport::thread_local_jfr_ref`——Java↔C++ 的"上下文"就是线程的 `JfrThreadLocal`(32-01)与录制状态机(32-01 的 `start_recording`/`stop_recording` 投消息)。

## 2. 事件类转换器: 类加载期的 schema 补全

用户写的 `class MyEvent extends jdk.jfr.Event` 只有字段声明——`isEnabled()/commit()` 等方法体是**类加载时补全**的([实证:](planning/outlines/00-jvm-tools/materials/commands/32-jfr-jni-instrumentation-demo.txt) 转换器/JNI 表/DCmd 链核对)。机制不是大纲的 "JfrClassAdapter 在方法入口插桩",而是**类文件解析层的 Klass 替换**(jfrEventClassTransformer.cpp):

```cpp
// klassFactory.cpp:216-222(截取核心,逐字)

  if (result->should_store_fingerprint()) {
    result->store_fingerprint(stream->compute_fingerprint());
  }

  JFR_ONLY(ON_KLASS_CREATION(result, parser, THREAD);)
```

`ON_KLASS_CREATION`(jfrKlassExtension.hpp:41)对**带事件标记的类**(`IS_EVENT_KLASS`,即 jdk.jfr.Event 子类)调 `JfrEventClassTransformer::on_klass_creation`(:1515)——重写类文件字节(`create_new_bytes_for_event_klass`)、重新解析出新的 InstanceKlass 替换原类、打上 `JdkJfrEvent::tag_as` 标记。注入的内容是**事件类 schema**: 5 个方法壳(`commit/isEnabled/begin/end/shouldCommit` 等,空方法体字节 `empty_void_method_code_attribute`,:120-145)与 3 个字段(EventHandler 等,:60-61 的 `number_of_new_methods=5/number_of_new_fields=3`)。**真正的方法体**在"急切注入"时由 **Java 侧 `EventInstrumentation`**(jdk.jfr/internal/EventInstrumentation.java:60,"Class responsible for adding instrumentation to a subclass of Event")用 ASM 生成——`JfrUpcalls::new_bytes_eager_instrumentation`(jfrUpcalls.cpp:146)把类字节交给 Java,拿回注入后的字节(JfrRecording 中或 `force_instrumentation` 时,:1406-1428)。**转换器只动事件类本身,不是"~20 个 JFR-required 类"的插桩**——非事件类零改动,零开销。

## 3. DCmd: jcmd 进来后先回 Java

`jcmd <pid> JFR.start name=recording settings=profile` 的落地是 `JfrStartFlightRecordingDCmd`(jfrDcmds.hpp:83,`name()` 返回 "JFR.start")——**不是大纲的 "JfrDCmd"**。它的 `execute`(jfrDcmds.cpp:376)是"参数翻译 + 转 Java":

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

把 DCmd 参数转成 Java 对象(`jstring`/`Long` 等),构造 **`jdk.jfr.internal.dcmd.DCmdStart` 实例**,经 **JavaCalls**(30-02 的桥)调用 Java 的 `run()`——之后就是 Java 侧的事(`Recording.start()` → JVM 接口 → `jfr_start_recording` → `JfrRecorder::start_recording` 投 MSG_START)。**DCmd 只负责参数形状的翻译,决策全在 Java 侧**——与 JNI 接口同构。

## 核心悬念

控制面拆完: 三条通道都是"薄 C++ 壳 + Java 侧决策"——JNI 接口是一张 JVM_ENTRY_NO_ENV 函数表(设置/采样间隔/发事件/停录制都是薄转换);事件类转换器在类文件解析层拦截 jdk.jfr.Event 子类,重写字节补全 schema(5 方法壳+3 字段,急切模式调 Java 的 EventInstrumentation 用 ASM 生成方法体);DCmd 把参数翻译成 Java 对象后转 `DCmdStart.run()`。三者汇到同一个录制状态机(32-01)。

32 域收官。JFR 之外还有一套**管理面**: JMX 与 Management——`jcmd` 之外,`jconsole`/JMX 怎么拿到 JVM 的运行时信息(内存/线程/GC 计数器),`ManagementFactory` 的 JVM 侧实现是什么?下一篇: 域 33 JMX & Management。

> → [33-jmx-management/01 — JConsole 怎么知道 Eden 用了多少?— MemoryService + MemoryPool](openjdk/planning/outlines/33-jmx-management/01-memory-service.md)
