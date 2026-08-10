# 02. JFR 有 130 种事件类型 — 它们怎么定义？— Event Types + Metadata

> 🔴 Deep | 3 KP 中的类型系统
> 读者处境: JFR recording 包含 130+ 种事件——从 `jdk.ExecutionSample`(每栈采样)到 `jdk.GarbageCollection`(GC 详情)到 `jdk.ObjectAllocationInNewTLAB`(每次 TLAB 分配)。每个事件的 schema(字段:类型)存在 chunk metadata 中——reader 据此解析。

### 1. "Event Type — schema + metadata"

场景: JMC(JDK Mission Control) 打开 .jfr 文件→需要知道每种 event 的字段名和类型。这些信息不在每 event 中(浪费)，而在 chunk metadata header 中。

**Event Type 定义** (`jfr/metadata/metadata.xml`):
```xml
<Event name="jdk.GarbageCollection" category="GC" label="Garbage Collection">
  <Field name="gcId" type="uint" label="GC Identifier"/>
  <Field name="name"  type="string" label="GC Name"/>
  <Field name="sumOfPauses" type="duration" contentType="timespan" label="Sum of Pauses"/>
</Event>
```
- 源码: `jfr/metadata/metadata.xml` ~130 event type definitions + `jfr/metadata/jfrMetadataEventClass.cpp` code generation
- 关键设计: XML metadata 在编译时转成 C++ source→每个 event type 是一个 class(继承 JfrEvent)→自动生成字段 getter/setter。Event Type 的字段有 "contentType"(timespan/percentage/frequency)—reader 据此显示单位
- [C++: 生成的 JfrEvent subclass 有 per-field `set_fieldName(value)` methods + `commit()` method(write event to buffer)。宏 `TRACE_REQUEST_COMMIT(event)` 生成全 inline commit 路径]

### 2. "130 types — high-level categories"

场景: JMC 用这些类型分组显示——GC/Memory/Thread/IO/Java——让用户快速定位问题类别。

**Event 分类** (`jfr/metadata/metadata.xml:60-150 + jfr/jfrEventClasses.hpp:30-120`):
```
Memory: ObjectAllocationInNewTLAB, ObjectAllocationOutsideTLAB,
        GarbageCollection, GCPhasePause, GCPhaseConcurrent
Stack:  ExecutionSample, NativeMethodSample
Thread: ThreadStart, ThreadEnd, ThreadPark, ThreadSleep
IO:     FileRead, FileWrite, SocketRead, SocketWrite
Java:   JavaExceptionThrow, JavaErrorThrow, JavaMonitorEnter, JavaMonitorWait
JVM:    ClassLoad, ClassDefine, CodeCache, BiasedLockRevocation
```
- 源码: `jfr/metadata/metadata.xml:category groups` + `jfr/jfrEventClasses.hpp:30-120` enum
- 关键设计: JFR event 是 per-event commit——不是在 JNI 函数中 write event——event write 在 hotspot 代码中 inline(`EventExecutionSample::commit()`)。每个 event 的 commit 路径是 ~5-10 条 C++ 指令(STORE到 thread-local buffer)

---

### 核心悬念

**"JFR event type 系统用 XML metadata→C++ class 生成。130+ types 分 GC/Memory/Thread/IO/Java 五大类——per-event inline commit。"** — 下一篇: Periodic Sampling + Stacktrace。

> → [03-periodic-sampling.md](03-periodic-sampling.md)
