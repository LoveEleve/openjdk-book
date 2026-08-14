# 06. Java 代码怎么控制 JFR？— JNI Interface + Instrumentation + DCmd

> 🟡 Working | 2 KP 中的控制接口
> 读者处境: `jcmd <pid> JFR.start` → DCmd→JNI→JfrRecorder::start()。Java 代码 `Recording::start()` → JNI call→enable event writers。

> ⚠️ 写作期修正(2026-08-14, vol-02/32-jfr/06 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"JfrClassAdapter::transform" 编造**: 真实=**JfrEventClassTransformer::on_klass_creation**(jfrEventClassTransformer.cpp:1515);调用点=klassFactory.cpp:222 `JFR_ONLY(ON_KLASS_CREATION(result, parser, THREAD);)`(宏定义 jfrKlassExtension.hpp:41,IS_EVENT_KLASS 检查 trace_id 事件标记)——**类文件解析层拦截 jdk.jfr.Event 子类首次加载**,重写类字节(create_new_bytes_for_event_klass)→新 InstanceKlass 替换+JdkJfrEvent::tag_as(:1515-1535);日志字符串 "JfrClassAdapter: unable to create ClassFileStream"(:1522)是"JfrClassAdapter"名的唯一来源
> - **"ASM 注入 hook 在方法入口" 错**: 注入的是**事件类 schema**——5 方法壳(commit/begin/end/isEnabled/shouldCommit,空方法体字节 empty_void_method_code_attribute :120-145)+3 字段(EventHandler,:60-61 number_of_new_methods=5/number_of_new_fields=3);**急切模式**调 Java 侧 EventInstrumentation(EventInstrumentation.java:60 "Class responsible for adding instrumentation to a subclass of Event",ASM 生成方法体)经 JfrUpcalls::new_bytes_eager_instrumentation(jfrUpcalls.cpp:146;Jfr::is_recording()||force_instrumentation 时 :1406-1428)
> - **"仅 ~20 JFR-required 类" 无依据**(删除): 转换器只动 jdk.jfr.Event 子类,非事件类零改动
> - **"JfrJniMethod::start(JfrStartFlightRecording)" 半对**: jfrJniMethod.cpp 是 **JVM_ENTRY_NO_ENV 函数表**(jfr_set_output/jfr_set_method_sampling_interval/jfr_emit_event/jfr_end_recording...),无 JfrJniMethod::start/dump 类方法;JfrStartFlightRecordingDCmd 在 dcmd(jfrDcmds.hpp:83)
> - **"JfrJavaSupport::thread_local_jfr_ref" 编造**: 不存在;Java↔C++ 上下文=JfrThreadLocal+录制状态机
> - **"JfrDCmd" 编造**: 真实=JfrStartFlightRecordingDCmd 等 5 个(jfrDcmds.hpp:30-141);execute(jfrDcmds.cpp:376-...)=参数翻译→构造 jdk/jfr/internal/dcmd/DCmdStart 实例→JavaCalls 调 Java run()→Recording.start()→JVM 接口
> - **悬念指向 33 ✓**(33-jmx-management 实际目录)
> - **实证**: 32-jfr-jni-instrumentation-demo.txt(转换器/JNI 表/DCmd 链核对)

### 1. "JNI Interface — Java↔C++ 控制"

场景: JDK 代码 `jdk.jfr.Recording.start()` → native call → JNI → C++ JfrRecorder::start()。

**JfrJni** (`jfr/jni/jfrJniMethod.cpp:40-300`):
```
JfrJniMethod::start(JfrStartFlightRecording, ...):
  → JfrRecorder::start(settings) → enable per-thread buffers
JfrJniMethod::stop():
  → JfrRecorder::stop() → drain buffers → finalize chunk
JfrJniMethod::dump():
  → JfrRecorder::dump() → force rotation → write chunk
```
- 源码: `jfr/jni/jfrJniMethod.cpp:40-300` + `jfr/jni/jfrJniMethod.hpp:30-80`
- 关键设计: JNI layer 是 thin translation——Java→C++ 的 settings 转换(JFR settings → internal type system)。JNI entry 在 _thread_in_native 状态→需 state transition 到 _thread_in_vm
- [C++: JfrJniMethod 用 `JfrJavaSupport` 访问 per-thread JFR references——`JfrJavaSupport::thread_local_jfr_ref(thread)` 返回当前线程的 JFR 上下文]

### 2. "Bytecode Instrumentation — ASM 注入"

场景: JFR needs class loading events → inject hook at ClassLoader.defineClass() entry.

**JfrClassTransformer** (`jfr/instrumentation/jfrClassAdapter.cpp:40-250`):
```
Class loading:
  → JfrClassAdapter::transform(class_bytes):
    → ASM visitor: visitMethod → inject JFR hook at entry:
      if (JFR_enabled) JfrEvent::commit(event_type, this, method_id)
    → return modified class_bytes
```
- 源码: `jfr/instrumentation/jfrClassAdapter.cpp:40-250`
- 关键设计: ASM 注入是选择性的——仅 ~20 JFR-required 类(如 ClassLoader/Object monitor 方法)才被 transform。大部分类不用注入——减少 overhead

### 3. "DCmd — 命令行控制"

场景: `jcmd 1234 JFR.start name=recording settings=profile` → diagnostic command → parse → start JFR。

**JfrDCmd** (`jfr/dcmd/jfrDcmd.cpp:40-200`):
```
jcmd <pid> JFR.start name=recording settings=profile
  → JfrDCmd::execute() → parse arguments → JfrJniMethod::start()
```
- 源码: `jfr/dcmd/jfrDcmd.cpp:40-200`

---

### 核心悬念

**"JNI→JfrRecorder(Java↔C++控制), ASM bytecode injection(~20 classes), DCmd(jcmd start/stop/dump)。"** — 下一篇: 域33 JMX & Management。

> → 域33 JMX & Management
