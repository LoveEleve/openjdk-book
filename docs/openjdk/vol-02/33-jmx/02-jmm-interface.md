# 02. JDK 怎么查询 JVM 内存状态？— JMM 接口 + JDK Management

> **前置依赖**:[33-jmx/01 — JConsole 怎么知道 Eden 用了多少？— MemoryService + MemoryPool](openjdk/vol-02/33-jmx/01-memory-service.md):池与账本已拆,本篇补上查询链的最后一段(01 篇的 `jmm_interface->GetMemoryPoolUsage` 函数表从哪来);[30-jvm-entry/01 — System.currentTimeMillis() 怎么进入 JVM?— JVM Entry Points](openjdk/vol-02/30-jvm-entry/01-jvm-entry-points.md):JVM_* 导出函数与 jvm.h:38-55(三段注释)的约定,本篇的 `JVM_GetManagement` 是其中之一;[27-jni/03 — JNI 调用参数错了——JVM 怎么检测?— JNI Check + 平台层](openjdk/vol-02/27-jni/03-jni-check-platform.md):JNI 函数表接口的先例(`jni_NativeInterface`),本篇的函数表与它同构
> → **后续**:[33-jmx/03 — 内存快满时怎么得到通知？— GC Notifier + LowMemory + Flags](03-gc-notifier-flags.md)
> 关联域: 27-jni(函数表接口)、30-jvm-entry(JVM_ENTRY 家族)、37-heap-dumper(DumpHeap0)、35-dcmd(DiagnosticCommand)

01 篇留了个尾巴: `jmm_interface->GetMemoryPoolUsage` 这条链的**函数表本身**是什么? 同一个 `ManagementFactory` 入口,其实能走出完全不同的几条管理链:

- `MemoryPoolMXBean.getUsage()` → `GetMemoryPoolUsage`
- `MemoryMXBean.setVerbose(true)` → `SetBoolAttribute`
- `ThreadMXBean.getCurrentThreadAllocatedBytes()` → `GetThreadAllocatedMemory`
- `GarbageCollectorMXBean.getLastGcInfo()` → `GetLastGCStat`

这些查询彼此毫不相干,却共用一张函数表。本篇要回答的核心问题:

1. JMM 这张表是什么——为什么 JDK 不直接绑一堆 `JVM_*` 符号?
2. JVM 怎么把表交给 libmanagement / libmanagement_ext?
3. `getLastGcInfo()` 为什么能拿到 8 个池的 before/after,却不是 native 侧 new 一堆 Java 对象树返回?

答案会反复落到一句话:**JMM 不是“若干 JNI 函数”，而是一张一次性交付的 38 槽函数表契约。`JVM_GetManagement` 做第一次握手，把 `jmm_interface` 指针交给 libmanagement / libmanagement_ext；之后 Java 侧每个管理调用都只是 `jmm_interface->槽位(...)` 的薄转发。复杂返回值（如 `GcInfo`）走“调用者先准备槽位，native 侧回填”的协议。**

---

## 1. 开场困惑——`jmm_interface` 这张表是什么

JNI 那边有一张 `jni_NativeInterface` 表,`JNIEnv*->functions` 靠它接所有 JNI 调用。JMM 则是 JDK 的 management 库和 JVM 之间的另一张表。它不是给“任意 native 库”用的,而是专门给 `java.management` / `jdk.management` 模块用的**私有契约**。

如果把每个管理能力都做成一个单独的 `JVM_*` 符号,当然也能工作——但一旦管理接口扩展,HotSpot 和 JDK 就要靠越来越多的导出符号保持同步。JMM 选择把这些能力收成**一张固定版本的函数表**,一次性交付,后续调用只做间接跳转。

---

## 2. 两个朴素方案为什么都不对

### 方案一: 每个 management API 直接绑定一个 `JVM_*` 符号

这样做的好处是调用路径短、没有额外的表间接。但坏处也明显:

- JDK 和 JVM 的管理接口必须靠一堆导出符号逐个对齐;
- 一旦新增/删改管理能力,双方就要同步维护更多链接约定;
- `java.management` 与 `jdk.management` 这种分层模块也难共享同一批底层能力。

JMM 的表模式把“接口集合”整体版本化,而不是让 38 个能力散成 38 个独立导出符号。

### 方案二: 每次调用都重新做一次 `JVM_GetManagement` 握手

反过来,如果每次 `MemoryPoolMXBean.getUsage()` 都先 `JVM_GetManagement(JMM_VERSION)` 取一次表指针,功能上也没问题。但这是纯浪费: 这张表是进程级单例,一次拿到之后就不会变。把这个握手搬到库加载时,后续调用就只剩一个函数指针跳转。

JMM 的做法正是这样: **第一次加载管理库时握手一次,拿到 `jmm_interface` 后存在全局静态变量里,后续所有管理查询共享它。**

---

## 3. `jmm.h`——一份 38 槽的私有契约

`jmm.h:29-37` 的头注释开门见山: “This is a private interface used by JDK for JVM monitoring and management”——**它是 JDK 与 JVM 之间的私有契约,不是公开 API**。

文件不声明“几十个函数”,而是声明**一份函数指针结构体** `struct jmmInterface_1_`(typedef 名 `JmmInterface`):

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
  ...
```

数一遍槽位: `reserved1` + **37 个函数指针 = 38 槽**。这里的 38 槽不是 38 个可调用函数，`reserved1` 只是结构布局保留位。版本常量在文件开头(:46-55):

- `JMM_VERSION_1 = 0x20010000`
- `JMM_VERSION_2 = 0x20020000`
- 当前 `JMM_VERSION = JMM_VERSION_2`

契约变了就 bump 版本。附带的结构/枚举还有:

- `jmmOptionalSupport`：9 个能力位
- `jmmLongAttribute` / `jmmBoolAttribute`：管理属性枚举
- `jmmThresholdType`：阈值类型
- `jmmGCStat`：GC 账本载体
- `dcmdInfo` / `dcmdArgInfo`：诊断命令描述

和 27-jni/03 的对照点很清晰:

- **结构同构**: 都是“一张表 + 若干槽位”；
- **定位不同**: JNI 是任意 native 库 ↔ JVM 的通用桥,`JMM` 是 JDK 的 management 模块 ↔ JVM 的专用桥。

---

## 4. 函数表的交付——两次握手

JMM 表在 JVM 侧,就是一个全局数组 `jmm_interface`(management.cpp:2232-2273,38 个槽与 `jmm.h` 一一对应,首槽 NULL)。JDK 怎么拿到它?靠 **`JVM_GetManagement`**:

```cpp
// jvm.cpp:3685-3688(截取核心,逐字)
// JVM monitoring and management support
JVM_ENTRY_NO_ENV(void*, JVM_GetManagement(jint version))
  return Management::get_jmm_interface(version);
JVM_END
```

`Management::get_jmm_interface`(management.cpp:2275-2282)只做**版本检查**: 传入的 `version == JMM_VERSION` 才返回 `&jmm_interface`,否则返回 NULL。整个实现包在 `#if INCLUDE_MANAGEMENT` 里——不带 management 的构建连表都不给。

JDK 侧拿表发生在**库加载时**。libmanagement 的 `JNI_OnLoad`(management.c:38-55):

```cpp
// management.c:38-55(截取核心,逐字)
JNIEXPORT jint JNICALL
   DEF_JNI_OnLoad(JavaVM *vm, void *reserved) {
    JNIEnv* env;
    ...
    jmm_interface = (JmmInterface*) JVM_GetManagement(JMM_VERSION);
    if (jmm_interface == NULL) {
        JNU_ThrowInternalError(env, "Unsupported Management version");
        return JNI_ERR;
    }

    jmm_version = jmm_interface->GetVersion(env);
    return (*env)->GetVersion(env);
}
```

触发点在 Java 侧 `ManagementFactory` 的静态块: `System.loadLibrary("management")`。也就是——**第一次触碰 ManagementFactory 任何 API 时库才加载,函数表才就位。**

同一张表有**两个消费者**:

- libmanagement (`java.management`)：基础 MXBean
- libmanagement_ext (`jdk.management`)：扩展 MXBean (`GcInfo` / `HotSpotDiagnostic` / flags / diagnostic command)

它们各自 `JNI_OnLoad`,但都调用同一个 `JVM_GetManagement(JMM_VERSION)` 拿表。

---

## 5. 内存族四兄弟——薄转发闭合 01 篇

01 篇从 `MemoryPoolMXBean.getUsage()` 追到 `jmm_GetMemoryPoolUsage`。把内存族四兄弟放一起看:

- `GetMemoryPools`(`jmm_GetMemoryPools`): 参数 obj==NULL 枚举**全部**池,否则按 manager 过滤;
- `GetMemoryManagers`(`jmm_GetMemoryManagers`): 对称,枚举全部 manager 或按池过滤;
- `GetMemoryPoolUsage / GetPeakMemoryPoolUsage / GetPoolCollectionUsage`: 01 篇已拆,分别取当前 usage / 峰值 / GC 后 usage;
- `GetMemoryUsage`(`jmm_GetMemoryUsage`): 汇总全部 heap 或 non-heap pool,任一池 undefined 则整体 -1。

JDK 侧封装薄到极致——每个 native 方法就是一行表调用(MemoryImpl.c:35-48):

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

这里要回想 01 篇的结论: pool mirror 是懒创建的,`MemoryUsage` Java 对象查询时现构造。所以 JMM 表做的不是“重新实现一遍内存统计”,而只是把 01 篇那套 pool/manager/usage 账本搬给 Java 侧。

---

## 6. `GetLastGCStat`——调用者填槽,被调用者回填

这是全篇最有意思的协议。`getLastGcInfo()` 不是让 native 侧直接 `new GcInfo(...)` 再返回对象树,而是走 **调用者先填槽,被调用者回填** 的协议。

Java 侧 `GcInfoBuilder.getLastGcInfo0`(GcInfoBuilder.c:215-282)先准备:

- before/after 两个 `MemoryUsage` 对象数组;
- 扩展属性槽(`gc_ext_attribute_values`);
- 一个 `jmmGCStat` 结构体,把这些槽位的指针先放进去。

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
      ...
```

hotspot 端 `jmm_GetLastGCStat`(management.cpp:1831-1892)拿着这些槽,从 01 篇的**双缓冲账本**复制数据:

- `mgr->get_last_gc_stat(&stat)` 先把 `_last_gc_stat` 拷进临时 `GCStatInfo`
- GC 还没发生过 → `gc_index()==0` → 调用方得到 null；这也是 Java 侧 `lastGcInfo == null` 的直接判据
- 否则逐池构造 `MemoryUsage` 填进 before/after 数组

这就是为什么实证里 `lastGcInfo=id=1 duration=7ms beforePools=8 afterPools=8`: **8 个池 × before/after 各一份**,正是 01 篇账本的形状。JMM 只是把它按协议搬过来。

---

## 7. 阈值、传感器、通知开关——JMM 不止读,还管订阅

表里还有一组“写接口”,把 01/03 篇的伏笔缝起来:

- **SetPoolSensor**(`jmm_SetPoolSensor`): 把 Java 侧 `sun.management.Sensor` 对象挂到 pool 的 `_usage_sensor` / `_gc_usage_sensor`
- **SetPoolThreshold**(`jmm_SetPoolThreshold`): 设置 usage/gc usage 阈值
- **SetGCNotificationEnabled**(`jmm_SetGCNotificationEnabled`): 打开 GCMemoryManager 的 `_notification_enabled`

01 篇看到 `GCMemoryManager::gc_end` 里 `if (is_notification_enabled()) GCNotifier::pushNotification(...)`，真正的“开关”就在这里。这也是 JMM 和普通 `JVM_*` 最大的区别: **它不只读状态,还负责安装监控器和订阅者。**

---

## 8. 误解澄清与收网

1. **JMM 是一堆独立 JNI 函数吗?** 不是。它是一张 38 槽的函数表,一次性交付,后续所有调用都是 `jmm_interface->槽位(...)`。
2. **每次查询都要重新 `JVM_GetManagement` 吗?** 不需要。`JNI_OnLoad` 时拿一次,存在 libmanagement / libmanagement_ext 的全局静态变量里。
3. **为什么复杂返回值不直接在 native 侧 new 对象树?** 因为像 `GcInfo` 这种结构有 before/after 两个数组和扩展属性,最省的协议是“调用者先准备槽位,被调用者回填”。
4. **libmanagement 和 libmanagement_ext 是两套不同接口吗?** 不是。两个库共享同一张 JMM 表,只是消费的槽位不同。
5. **JMM 只负责读状态吗?** 不是。传感器、阈值、GC 通知开关都是它写进去的。

把这一篇压成三句话:

- **JMM 是一张 38 槽的私有函数表契约**,不是若干点对点 JNI 函数。
- **`JVM_GetManagement` 在库加载时交表一次**,后续 libmanagement / libmanagement_ext 全靠 `jmm_interface` 薄转发。
- **复杂数据走“调用者填槽,被调用者回填”协议**,`GcInfo` 只是 01 篇双缓冲 GC 账本的 Java 侧搬运结果。

下一篇: 内存快满时怎么得到通知——GC Notifier、LowMemory 检测与 Flags。

> → [33-jmx/03 — 内存快满时怎么得到通知？— GC Notifier + LowMemory + Flags](03-gc-notifier-flags.md)