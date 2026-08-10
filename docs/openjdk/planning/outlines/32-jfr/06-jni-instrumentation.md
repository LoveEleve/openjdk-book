# 06. Java 代码怎么控制 JFR？— JNI Interface + Instrumentation + DCmd

> 🟡 Working | 2 KP 中的控制接口
> 读者处境: `jcmd <pid> JFR.start` → DCmd→JNI→JfrRecorder::start()。Java 代码 `Recording::start()` → JNI call→enable event writers。

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
