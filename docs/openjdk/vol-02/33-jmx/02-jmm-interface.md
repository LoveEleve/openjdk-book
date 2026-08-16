# 02. JDK 怎么查询 JVM 内存状态？— JMM 接口 + JDK Management

> **前置依赖**:[33-jmx/01 — JConsole 怎么知道 Eden 用了多少？— MemoryService + MemoryPool](openjdk/vol-02/33-jmx/01-memory-service.md):池与账本已拆,本篇补上查询链的最后一段(01 篇的 `jmm_interface->GetMemoryPoolUsage` 函数表从哪来);[30-jvm-entry/01 — System.currentTimeMillis() 怎么进入 JVM?— JVM Entry Points](openjdk/vol-02/30-jvm-entry/01-jvm-entry-points.md):JVM_* 导出函数与 jvm.h:38-55(三段注释)的约定,本篇的 JVM_GetManagement 是其中之一;[27-jni/03 — JNI 调用参数错了——JVM 怎么检测?— JNI Check + 平台层](openjdk/vol-02/27-jni/03-jni-check-platform.md):JNI 函数表接口的先例(jni_NativeInterface),本篇的函数表与它同构
> → **后续**:[33-jmx/03 — 内存快满时怎么得到通知？— GC Notifier + LowMemory + Flags](03-gc-notifier-flags.md)
> 关联域: 27-jni(函数表接口)、30-jvm-entry(JVM_ENTRY 家族)、37-heap-dumper(DumpHeap0)、35-dcmd(DiagnosticCommand)

## 一次查询,三次握手

01 篇留了个尾巴: `jmm_interface->GetMemoryPoolUsage` 这条链的**函数表本身**是什么?[JMM 实证](planning/outlines/00-jvm-tools/materials/commands/33-jmx-jmm-demo.txt)先把这张表"摸"一遍——同一个 `ManagementFactory` 入口,四条互不相干的路径:

```
isVerbose before=false
isVerbose after=true
[0.102s][info][gc] GC(0) Pause Full (System.gc()) 35M->1M(34M) 4.269ms
allocated delta after 1MB = 1048592
threadAllocatedBytes for current = 30000864
GC G1 Young Generation count=0 time=0ms
  lastGcInfo=null (no GC yet)
GC G1 Old Generation count=1 time=6ms
  lastGcInfo=id=1 duration=7ms beforePools=8 afterPools=8
```

四条路径分别是: ①`MemoryMXBean.setVerbose(true)` 之后 `System.gc()` 的日志直接打到 stdout(`[0.102s][info][gc] GC(0)...`)——这是 **SetBoolAttribute** 槽的副作用;②`getCurrentThreadAllocatedBytes` 分配 1MB 前后差 1048592 字节——**GetThreadAllocatedMemory** 槽;③`GarbageCollectorMXBean.getLastGcInfo()` 返回 `id=1 duration=7ms beforePools=8 afterPools=8`——**GetLastGCStat** 槽(需要 jdk.management 模块)。它们共用一张函数表。这篇拆: 表长什么样、表怎么交付、表怎么被消费。

## 1. jmm.h: 一份函数表契约

`jmm.h:29-37`(share/include/jmm.h:349 行)头注释开门见山: "This is a private interface used by JDK for JVM monitoring and management"(:29-37)——**它是 JDK 与 JVM 之间的私有契约,不是公开 API**。文件不声明"几十个函数",而是声明**一份函数指针结构体** `struct jmmInterface_1_`(:221-343,typedef 名 JmmInterface):

```cpp
// jmm.h:221-249(截取核心,逐字)
typedef struct jmmInterface_1_ {
  void*        reserved1;
  jlong        (JNICALL *GetOneThreadAllocatedMemory)
                                                 (JNIEnv *env,
                                                  jlong thread_id);

  jint         (JNICALL *GetVersion)             (JNIEnv *env);

  jint         (JNICALL *GetOptionalSupport)     (JNIEnv *env,
                                                  jmmOptionalSupport* support_ptr);

  jint         (JNICALL *GetThreadInfo)          (JNIEnv *env,
                                                  jlongArray ids,
                                                  jint maxDepth,
                                                  jobjectArray infoArray);

  jobjectArray (JNICALL *GetMemoryPools)         (JNIEnv* env, jobject mgr);

  jobjectArray (JNICALL *GetMemoryManagers)      (JNIEnv* env, jobject pool);

  jobject      (JNICALL *GetMemoryPoolUsage)     (JNIEnv* env, jobject pool);
  jobject      (JNICALL *GetPeakMemoryPoolUsage) (JNIEnv* env, jobject pool);
...
  jobject      (JNICALL *GetMemoryUsage)         (JNIEnv* env, jboolean heap);
```

数一遍槽位: `reserved1` + **37 个函数指针 = 38 槽**——从 GetOneThreadAllocatedMemory 到 SetDiagnosticFrameworkNotificationEnabled(:223-342)。版本常量在文件开头(:46-55): JMM_VERSION_1=0x20010000(JDK 6 起)一路到 **JMM_VERSION_2=0x20020000(JDK 10 加),当前 JMM_VERSION=JMM_VERSION_2**——契约变了就 bump 版本(头注释 :33-37)。附带的结构/枚举还有: `jmmOptionalSupport`(9 个能力位,:57-68)、`jmmLongAttribute` 枚举(:70-107,从类加载计数 1 到 OS 属性 202)、`jmmBoolAttribute` 枚举(21-25,:109-115)、`jmmThresholdType`(901-904,03 篇的传感器类型)、`jmmGCStat`(:185-195,GC 账本载体)、`dcmdInfo`/`dcmdArgInfo`(诊断命令,35 域)。

两个与 JNI 函数表的对照点。**第一,结构同构**: 27-jni/03 拆过 JNI 的 `jni_NativeInterface`(jni.cpp:3528)——JDK 侧 native 代码也是拿一个函数指针表间接调用。**第二,定位不同**: JNI 是"任意 native 库 ↔ JVM"的通用桥;JMM 是"JDK 的 management 库 ↔ JVM"的专用桥——jmm.h:30 头注释自己写了 "private interface used by JDK"。

*关键设计: JMM 接口 = 一份纯数据(函数指针数组),没有 JNI 的注册/查找机制*——JNI 函数是 libjvm 导出的符号按需解析(30-jvm-entry/02),JMM 是**整个表一次交付**。

## 2. 函数表的交付: 两次握手

表在 JVM 侧,是一个全局数组 `jmm_interface`(management.cpp:2232-2273,38 个槽与 jmm.h:221-343 一一对应,首槽 NULL)。JDK 怎么拿到?**`JVM_GetManagement`**(jvm.cpp:3686)——30-jvm-entry/01 的 JVM_* 家族成员:

```cpp
// jvm.cpp:3685-3688(截取核心,逐字)
// JVM monitoring and management support
JVM_ENTRY_NO_ENV(void*, JVM_GetManagement(jint version))
  return Management::get_jmm_interface(version);
JVM_END
```

`Management::get_jmm_interface`(management.cpp:2275-2282)做**版本检查**: 传入的 version == JMM_VERSION 才返回 `&jmm_interface`,否则 NULL——整个实现包在 `#if INCLUDE_MANAGEMENT` 里(不带 management 的构建直接返回 NULL)。JDK 侧拿表在**库加载时**(libmanagement 的 JNI_OnLoad,management.c:39-54):

```cpp
// management.c:38-55(截取核心,逐字)
JNIEXPORT jint JNICALL
   DEF_JNI_OnLoad(JavaVM *vm, void *reserved) {
    JNIEnv* env;

    jvm = vm;
    if ((*vm)->GetEnv(vm, (void**) &env, JNI_VERSION_1_2) != JNI_OK) {
        return JNI_ERR;
    }

    jmm_interface = (JmmInterface*) JVM_GetManagement(JMM_VERSION);
    if (jmm_interface == NULL) {
        JNU_ThrowInternalError(env, "Unsupported Management version");
        return JNI_ERR;
    }

    jmm_version = jmm_interface->GetVersion(env);
    return (*env)->GetVersion(env);
}
```

触发点在 Java 侧 `java.lang.management.ManagementFactory` 的静态块(ManagementFactory.java:1018-1020): `System.loadLibrary("management")`——**第一次触碰 ManagementFactory 任何 API 时库才加载,函数表才就位**。加载后 `jmm_interface`/`jmm_version` 是 libmanagement 的全局指针;`jmm_version` 还被 `VMManagementImpl.getVersion0`(VMManagementImpl.c:35-41)解包成 "2.0"(major/minor 从 0x20020000 拆位)。

**同一张表,两个消费者**: libmanagement(java.management 模块)与 libmanagement_ext(jdk.management 模块)都各自 `JVM_GetManagement(JMM_VERSION)`(management_ext.c:39-54,代码几乎相同)。区别在谁加载它们: libmanagement 由 ManagementFactory 加载(基础 MXBean);libmanagement_ext 由 jdk.management 模块的 PlatformMBeanProviderImpl 静态块加载(PlatformMBeanProviderImpl.java:55-59,扩展 MXBean: HotSpotDiagnostic/GcInfo/Flag 等)。01 篇实证里 `createGarbageCollector` 检查 `GarbageCollectorExtImpl` 是否存在(memoryManager.cpp:83-87)——就是检测 jdk.management 是否已加载。

## 3. 内存族: 查询链的最后一跳

01 篇从 `getUsage()` 追到 `jmm_GetMemoryPoolUsage`(management.cpp:557-568);本篇把内存族四兄弟放一起看:

- **GetMemoryPools**(`jmm_GetMemoryPools` :470-512): 参数 obj==NULL 枚举**全部**池,否则按传入的 manager 过滤(`mgr->get_memory_pool(i)`);返回 `MemoryPoolMXBean[]`——数组里每个元素就是 01 篇的懒创建实例;
- **GetMemoryManagers**(:514-546): 对称——枚举全部 manager 或按池过滤;
- **GetMemoryPoolUsage / GetPeakMemoryPoolUsage / GetPoolCollectionUsage**(:557-599): 01 篇已拆,现算 usage/峰值/GC 后快照;
- **GetMemoryUsage**(`jmm_GetMemoryUsage` :706-758): 汇总——遍历池求和、undefined 传染(任一池 undefined 则整体 -1)、`init=InitialHeapSize`/`max=Universe::heap()->max_capacity()`。

四兄弟的 JDK 侧封装薄到极致——每个 native 方法就是一行表调用(MemoryImpl.c:35-48):

```cpp
// MemoryImpl.c:35-48(截取核心,逐字)
JNIEXPORT jobject JNICALL Java_sun_management_MemoryImpl_getMemoryPools0
  (JNIEnv *env, jclass dummy) {
    return jmm_interface->GetMemoryPools(env, NULL);
}

JNIEXPORT jobject JNICALL Java_sun_management_MemoryImpl_getMemoryManagers0
  (JNIEnv *env, jclass dummy) {
    return jmm_interface->GetMemoryManagers(env, NULL);
}

JNIEXPORT jobject JNICALL Java_sun_management_MemoryImpl_getMemoryUsage0
  (JNIEnv *env, jobject dummy, jboolean heap) {
    return jmm_interface->GetMemoryUsage(env, heap);
}
```

内存族之外,同表还有几路值得认识的兄弟(实证都触发了): **SetBoolAttribute**(`jmm_SetBoolAttribute` :778,实证 setVerbose(true)→ `LogConfiguration::configure_stdout(gc)` 打出 `[0.102s][info][gc] GC(0)...`);**GetThreadAllocatedMemory**(:2126,实证 1MB 分配 delta=1048592);**GetLastGCStat**(:1831,下节拆);以及 DumpThreads(:1141)/GetVMGlobals(:1504)/ExecuteDiagnosticCommand(:2032,35 域)等。*关键设计: 38 个槽就是 JDK 想从 JVM 看到的全部管理面*——JMM 没有"扩展注册"机制,新能力要么加槽(bump 版本),要么像 35 域的诊断命令那样走"通用字符串接口"。

## 4. 扩展接口: libmanagement_ext 与 GcInfo

jdk.management 模块的 native 在 `jdk.management/share/native/libmanagement_ext/`——七个文件: management_ext.c:39(表交付,JNI_OnLoad)与 management_ext.h:39(同款 JNI_OnLoad)+ DiagnosticCommandImpl.c:45(诊断命令)+ Flag.c:46(VM flags)+ GarbageCollectorExtImpl.c:39(GC 扩展)+ **GcInfoBuilder.c:234**(GC 详情)+ HotSpotDiagnostic.c:35(heap dump/flag 查询)。大纲假设的 "management_ext.cpp" 不存在。各文件都是"一行表调用": HotSpotDiagnostic.c:35 `jmm_interface->DumpHeap0(env, outputfile, live)`(37 域实证过的 JMX dumpHeap 就是它)、DiagnosticCommandImpl.c:45/:250 的 GetDiagnosticCommands/ExecuteDiagnosticCommand 等。

GcInfo 是最值得拆的一条——**它是 03 篇 GC 通知的数据体**。`GarbageCollectorExtImpl.getLastGcInfo()`(GarbageCollectorExtImpl.java:68-69)→ `GcInfoBuilder.getLastGcInfo0`(GcInfoBuilder.c:199-234):

```cpp
// GcInfoBuilder.c:215-240(截取核心,逐字)
    gc_stat.usage_before_gc = usageBeforeGC;
    gc_stat.usage_after_gc = usageAfterGC;
    gc_stat.gc_ext_attribute_values_size = ext_att_count;
    if (ext_att_count > 0) {
        gc_stat.gc_ext_attribute_values = (jvalue*) malloc((size_t)ext_att_count *
                                                           sizeof(jvalue));
...
    jmm_interface->GetLastGCStat(env, gc, &gc_stat);
    if (gc_stat.gc_index == 0) {
        if (gc_stat.gc_ext_attribute_values != NULL) {
            free(gc_stat.gc_ext_attribute_values);
        }
        return 0;
    }
```

注意**调用者先填、被调用者回填**的协议: Java 侧把 before/after 两个 MemoryUsage 对象数组和扩展属性槽**预先放进 `jmmGCStat` 结构**(jmm.h:185-195 注释 "Caller has to set the following fields...")——hotspot 端的 `jmm_GetLastGCStat`(management.cpp:1831-1892)拿着这些槽,从 01 篇的**双缓冲账本**复制数据: `mgr->get_last_gc_stat(&stat)`(:1845,GC 还没发生返回 0 → 调用方得到 null,实证 `lastGcInfo=null (no GC yet)`)→ 逐池构造 MemoryUsage 填进数组(:1862-1883,还处理 survivor 池 GC 后 max 为 0 的特殊情况)——**表调用返回后,Java 侧再把 jvalue 按类型逐个写回**(GcInfoBuilder.c:255-282 的 switch 'Z'/'B'/'C'/'S'/'I'/'J'/'F'/'D')。实证输出 `id=1 duration=7ms beforePools=8 afterPools=8`——**8 个池 × before/after 各一份**,正是 01 篇账本的形状。

## 5. 传感器与阈值: 03 篇的伏笔

表里还有一组"写"接口,01 篇提过池上有 `_usage_sensor`/`_gc_usage_sensor` 与阈值,接线就在这张表: **SetPoolSensor**(`jmm_SetPoolSensor` :601-643)把 Java 侧 `sun.management.Sensor` 对象挂到池的传感器槽(high/low 共用一个);**SetPoolThreshold**(`jmm_SetPoolThreshold` :644-703)设置阈值(负数/超 size_t 拒绝);**SetGCNotificationEnabled**(:1893-1900)开关 GCMemoryManager 的 `_notification_enabled`——01 篇 gc_end 里 `if (is_notification_enabled()) GCNotifier::pushNotification` 的门就是它。*设计意图: JMM 不止"读",还管"订阅"*——阈值/传感器的数据结构(01 篇)与触发逻辑(03 篇)在这里被 JMM 缝在一起。

## 核心悬念

JMM 接口拆完: 一张 38 槽的函数指针表(jmm.h:221 `struct jmmInterface_1_`)是 JDK↔JVM 的管理契约;`JVM_GetManagement`(jvm.cpp:3686)+ 版本检查交付表,JDK 侧在 `System.loadLibrary("management")` 的 JNI_OnLoad 里收表(management.c:39-54);libmanagement 与 libmanagement_ext 共享同一张表——内存族四兄弟闭合了 01 篇的查询链,GetLastGCStat 用"调用者填槽"协议把双缓冲账本搬成 GcInfo,SetPoolSensor/SetPoolThreshold/SetGCNotificationEnabled 则埋下通知系统的线。但"订阅"说了没做完: 阈值设了之后,**谁在什么时候检查**?检查通过**哪个线程**回调 Java 的 Sensor?GC 通知的 GcInfo 怎么发出去?下一篇: GC Notifier + LowMemory + Flags。

> → [33-jmx/03 — 内存快满时怎么得到通知？— GC Notifier + LowMemory + Flags](03-gc-notifier-flags.md)
