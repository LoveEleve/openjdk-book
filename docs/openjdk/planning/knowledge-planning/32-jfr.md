# 域 32: JFR — 知识规划

> 源码: jfr/ (217文件/34828行/10子目录) | 🔴 巨型域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| jfr/recorder/ (76文件) | **JFR Recorder Engine**: JfrRecorder(global singleton), recording lifecycle(start/stop/dump), chunk rotation(writer→file), JfrChunkWriter(write events→chunk→binary file), JfrStorage(global buffer→thread local buffer per EventType), JfrStacktrace(栈追踪repository), JfrStringPool(字符串去重池), JfrTraceId(traceid per class/method) | High |
| jfr/metadata/ (3文件) + 70+ EventType classes | **JFR Event Metadata**: ~130 event types(ExecutionSample/ThreadPark/GarbageCollection/ObjectAllocationInNewTLAB/JavaExceptionThrow/...), JfrEventClassTransformer(bytecode instrumentation for event), MetadataWriter(serialize event metadata to chunk), JfrTypeSystem(自定义类型:百分比/地址/频率/时间间隔) | High |
| jfr/periodic/ (15文件) + jfr/periodic/sampling/ | **Periodic Events + Sampling**: JfrThreadSampler(per-thread JFR采样), JfrThreadDumpEvent(周期性线程dump), JfrCPUTimeEvent, JfrNativeMemoryUsageEvent等 ~20 periodic events | High |
| jfr/leakprofiler/ (47文件) | **Memory Leak Profiler**: leak detection chains(OldObjectSample→find path to GC root), checkpoint(old object checkpoint), sampling(sample allocation events), utilities | Medium |
| jfr/jni/ (12文件) | **JFR JNI Interface**: C++→Java JFR查询(setting/get event/start/stop via JNI), JfrJavaSupport(thread local JFR reference) | Medium |
| jfr/writers/ (20文件) + jfr/utilities/ (20文件) + jfr/support/ (15文件) | **Writer + Utilities**: JfrBinaryWriter(binary encoding: variable-length LEB128 encoding for values), JfrCompressedWriter(压缩输出), utility macros for event recording(JfrEventMacros) | Medium |
| jfr/instrumentation/ (4文件) | **Bytecode Instrumentation**: JfrClassAdapter(ASM bytecode manipulation—inject JFR event hook at method entry/exit for JFR采样), JfrMethodEventReader | Low |
| jfr/dcmd/ (2文件) | **DCmd Interface**: JfrDCmd(start/stop/dump via jcmd), diagnostic command parsing | Low |

*8 知识点*

## 02 聚合 — P1/P2/P3

### P1 (≥5)
| KP | 出现文件 |
|----|---------|
| Recorder Engine (record/stop/dump) | jfr/recorder/*(76), jfr/jni/*, jfr/writers/*, jfr/metadata/*, jfr/periodic/* |

### P2 (2-4)
| KP | 出现文件 |
|----|---------|
| Event Types + Metadata | jfr/metadata/*, EventType classes(70+,分布在整个jfr/中), jfr/writers/*(metadata serialize) |
| Periodic Sampling | jfr/periodic/*, jfr/leakprofiler/sampling/*, jfr/jni/* |

### P3 (1-2)
| KP | 文件 |
|----|------|
| Leak Profiler | jfr/leakprofiler/(47) |
| Bytecode Instrumentation | jfr/instrumentation/(4) |
| DCmd | jfr/dcmd/(2) |

## 03 深度分类

### 🔴 Deep (3 KP)
| KP | 为什么 🔴 |
|----|---------|
| Recorder Engine (JfrRecorder + JfrStorage) | JFR 的核心——JfrRecorder 管理 recording 生命周期(start/stop/rotate/dump)。JfrStorage 做 per-event-type thread-local buffer——每个线程有 per-EventType 的写buffer→满时 switch 到 global buffer→global buffer→chunk writer→file。线程本地 buffer 消除全局竞争——写 JFR event 在hot path 是 ~15 cycles(单 store 到 TL buffer)。chunk rotation 让 JFR 可以在 recording 中间 dump partial data |
| Event Type System + Metadata (~130 types) | JFR 的 key abstraction——不是固定格式——每 event type 有 schema(字段名:类型)。metadata 在 chunk 开头序列化为 binary→reader 根据 metadata 解析 chunk。class bytecode instrumentation: JfrEventClassTransformer 用 ASM 注入 event hook——类在加载时被 transform→所有 allocation/NPE/thread park 被 hook |
| Periodic Sampling + Stacktrace | JfrThreadSampler 定期(~10ms)采全部线程栈→生成 ExecutionSample event。Per-thread sampler 用 AsyncGetCallTrace(安全点外)→采集线程栈→存traceid→dedup via JfrStackTraceRepository。Leak profiler 用此采 allocation→找 old object→trace path to GC root |

### 🟡 Working (2 KP)
| KP | 说明 | 为什么 🟡 |
|----|------|------|
| Binary Writer (LEB128 encoding) | chunk format: constant pool→metadata→events。Value encoding 用 variable-length LEB128 | 编码细节——理解 JFR 架构不需要 |
| JNI Interface | start/stop/dump via JNI→C++ call | thin wrapper on Recorder Engine |

### 🟢 Surface (3 KP)
| KP | 说明 |
|----|------|
| Leak Profiler | OldObjectSample + path to root |
| Bytecode Instrumentation | ASM 注入 |
| DCmd | jcmd wrapper |

## 04 聚类 — 6篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | JFR Recorder Engine | "JFR 怎么在每个线程上采集事件？怎么写进 chunk file？" |
| 2 | Event Types + Metadata | "JFR 有 130 种事件类型——它们怎么定义？reader 怎么解析？" |
| 3 | Periodic Sampling + Stacktrace | "JFR 怎么 10ms 采一次全部线程栈而不影响性能？" |
| 4 | Binary Writer + Chunk Format | "JFR 的 .jfr 文件是什么格式？怎么用 LEB128 压缩？" |
| 5 | Leak Profiler + Allocation Sampling | "JFR 怎么找到内存泄漏的 GC root？" |
| 6 | JNI Interface + Instrumentation + DCmd | "Java 代码怎么控制 JFR？字节码注入怎么工作？" |
