# 02. JFR 有 130 种事件类型 — 它们怎么定义？— Event Types + Metadata

> 🔴 Deep | 3 KP 中的类型系统
> 读者处境: JFR recording 包含 130+ 种事件——从 `jdk.ExecutionSample`(每栈采样)到 `jdk.GarbageCollection`(GC 详情)到 `jdk.ObjectAllocationInNewTLAB`(每次 TLAB 分配)。每个事件的 schema(字段:类型)存在 chunk metadata 中——reader 据此解析。

> ⚠️ 写作期修正(2026-08-14, vol-02/32-jfr/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"jfrMetadataEventClass.cpp code generation" 编造**: 生成工具=构建期 Java 工具 **build.tools.jfr.GenerateJfrFiles**(make/hotspot/gensrc/GensrcJfr.gmk),metadata.xml+xsd → gensrc/jfrfiles/**jfrEventClasses.hpp+jfrEventIds.hpp**(不在源码树,所以大纲的 "jfrEventClasses.hpp:30-120 enum" 看不到源码=生成物);入口 jfrEvents.hpp:28 注释 "Declare your event in jfr/metadata/metadata.xml."+:32 include
> - **"TRACE_REQUEST_COMMIT 宏" 编造**: jdk11u grep 零命中;事件提交=生成类的 set_xxx+commit()(实证 jfrThreadSampler.cpp:264 set_stackTrace/:288-300 commit)
> - **"~5-10 条 C++ 指令" 无依据**(删除)
> - **分类错**: 不是简单五组;metadata.xml 的 category 是**层级值**("Java Virtual Machine, GC, Detailed" 23 个/"Java Virtual Machine, Flag" 14/"Java Application" 9/"Java Virtual Machine, Runtime, Safepoint" 6/"Operating System, Processor" 5...)
> - **metadata.xml 双端消费(重要,大纲缺)**: ①hotspot 构建期生成 C++ 事件类;②**复制进 jdk.jfr 模块资源 /jdk/jfr/internal/types/metadata.xml**(make/copy/Copy-jdk.jfr.gmk),运行期 **MetadataHandler.java:218 解析**注册 Java 侧事件类型——Java 的 jdk.* 事件与 C++ native 事件同一份定义
> - **Java 侧管理**: MetadataRepository.initializeJVMEventTypes(MetadataRepository.java:66-86: PlatformEventType→EventType→@Threshold/@StackTrace/@Cutoff/@Period 注解检查→RequestHook(周期)+EventControl(native 启用位));动态事件=EventClassBuilder.java:45(ASM 生成 "jdk.jfr.DynamicEvent"+id);JfrMetadataEvent(jfrMetadataEvent.hpp:31-43): "Metadata is continuously updated in Java...update(), Java stores a binary representation back to native",chunk 关闭 write(metadata 偏移填 32-01 文件头的 metadata section offset 槽)
> - **事件数**: metadata.xml **124 个 Event**(1168 行);运行期 jfr summary 读出 **143 个 jdk.\* 类型**(含 Java 侧注册)
> - **悬念指向 03 ✓**(正确,保留)
> - **实证**: 32-jfr-metadata-demo.txt(jfr print --events 按 metadata 解析实例/category 层级统计/生成链/事件类使用)

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
