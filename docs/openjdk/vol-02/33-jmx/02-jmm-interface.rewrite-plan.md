# 33-jmx/02-jmm-interface 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JDK 的 management 查询为什么不是一堆 JNI 函数，而是一张 38 槽的 JMM 函数表；JVM 怎么把表交给 libmanagement/libmanagement_ext；GetLastGCStat 怎么把 01 篇的 GC 账本搬成 Java 侧的 `GcInfo`

## 1. 选题判断

现稿已有很强事实基础：
- `jmm.h` 的 `jmmInterface_1_`
- `JVM_GetManagement` + `Management::get_jmm_interface`
- `management.c` / `management_ext.c` 的 `JNI_OnLoad`
- 内存族四兄弟 (`GetMemoryPools/Managers/Usage`)
- `GetLastGCStat` 与 `jmmGCStat`
- 阈值/通知写接口 (`SetPoolSensor/SetPoolThreshold/SetGCNotificationEnabled`)

真正该打穿的困惑更集中：

**`MemoryPoolMXBean.getUsage()` 背后的 `jmm_interface->GetMemoryPoolUsage` 这张表是什么？为什么 JDK 不直接用 JNI 点对点调一堆 `JVM_*` 函数？为什么 `getLastGcInfo()` 既能拿到 8 个池的 before/after，又不在 native 侧 new 一堆 Java 对象返回？**

## 2. 一句话顿悟

**JMM 不是“若干 JNI 函数”，而是一张一次性交付的 38 槽函数表契约。`JVM_GetManagement` 做第一次握手，把 `jmm_interface` 指针交给 libmanagement / libmanagement_ext；之后 Java 侧每个管理调用都只是 `jmm_interface->槽位(...)` 的薄转发。复杂返回值（如 `GcInfo`）不靠 native 侧构造整棵对象树，而是走“调用者先准备槽位，native 侧回填”的协议。**

## 3. 总图

```text
JDK 首次触碰 ManagementFactory
  ↓ System.loadLibrary("management")
  ↓ JNI_OnLoad (management.c)
  ↓ JVM_GetManagement(JMM_VERSION)
  ↓ Management::get_jmm_interface(version)
  ↓ 返回 &jmm_interface

后续查询
  MemoryImpl.c / VMManagementImpl.c / GcInfoBuilder.c / HotSpotDiagnostic.c
    ↓ jmm_interface->GetMemoryPoolUsage / GetThreadAllocatedMemory / GetLastGCStat / DumpHeap0 ...
    ↓ management.cpp / memoryService.cpp / memoryManager.cpp
```

## 4. 结构大纲

### 第一节：开场困惑——`jmm_interface` 这张表是什么

- 从 01 篇留下的 `jmm_interface->GetMemoryPoolUsage` 切入
- 点出：JMM 是 JDK↔JVM 的“专用管理契约”，不是面向任意 native 库的 JNI 接口
- 埋主线：一次交表，后面全是薄转发

### 第二节：两个朴素方案为什么都不对

1. 每个 management API 直接绑定一个 `JVM_*` 符号
2. 每次调用都做一次 `JVM_GetManagement` 握手

结论：函数表一次交付、后续 O(1) 间接调用，既隔离版本又减少查找成本。

### 第三节：jmm.h——一份 38 槽的私有契约

- `jmmInterface_1_` 结构
- `JMM_VERSION_1/JMM_VERSION_2/JMM_VERSION`
- `jmmOptionalSupport` / `jmmLongAttribute` / `jmmBoolAttribute` / `jmmThresholdType` / `jmmGCStat`
- 与 `jni_NativeInterface` 的“结构同构、定位不同”对照

### 第四节：函数表交付——两次握手

- `JVM_GetManagement` → `Management::get_jmm_interface`
- 版本检查
- `management.c` 与 `management_ext.c` 的 `JNI_OnLoad`
- `System.loadLibrary("management")` 触发时机
- 同一张表,两个消费者

### 第五节：内存族四兄弟——薄转发闭合 01 篇

- `GetMemoryPools/Managers/PoolUsage/MemoryUsage`
- `MemoryImpl.c` 一行表调用
- 01 篇 `MemoryService` 账本在这里被 Java 侧消费

### 第六节：`GetLastGCStat`——调用者填槽,被调用者回填

- `jmmGCStat` 协议
- `GcInfoBuilder.c` 准备 before/after 数组和 ext 属性槽
- `management.cpp:jmm_GetLastGCStat` 从双缓冲账本复制
- 8 个池 × before/after 的来源

### 第七节：阈值、传感器、通知开关

- `SetPoolSensor`
- `SetPoolThreshold`
- `SetGCNotificationEnabled`
- 01/03 篇伏笔回收

### 第八节：误解澄清与收网

## 5. 失败方案必须写进正文

1. 每个 management API 直接绑定独立 `JVM_*` 符号
2. 每次调用都重复 `JVM_GetManagement` 握手

## 6. 证据清单

- `src/hotspot/share/include/jmm.h:29-37`
- `src/hotspot/share/include/jmm.h:221-343`
- `src/hotspot/share/include/jmm.h:46-55`
- `src/hotspot/share/include/jmm.h:57-115`
- `src/hotspot/share/include/jmm.h:185-195`
- `src/hotspot/share/prims/jvm.cpp:3685-3688`
- `src/hotspot/share/services/management.cpp:2232-2282`
- `src/java.management/share/native/libmanagement/management.c:38-55`
- `src/jdk.management/share/native/libmanagement_ext/management_ext.c:39-54`
- `src/java.management/share/classes/java/lang/management/ManagementFactory.java:1018-1020`
- `src/hotspot/share/services/management.cpp:470-758`
- `src/java.management/share/native/libmanagement/MemoryImpl.c:35-48`
- `src/jdk.management/share/native/libmanagement_ext/GcInfoBuilder.c:215-282`
- `src/hotspot/share/services/management.cpp:1831-1892`
- `src/hotspot/share/services/management.cpp:601-703`
- `src/hotspot/share/services/management.cpp:1893-1900`

## 7. 完成后 review

- 删除代码后，能否复述“一次交表，后续薄转发”
- 是否讲清 `GcInfo` 的回填协议
- 是否讲清 libmanagement / libmanagement_ext 共享同表
- 是否讲清阈值/传感器/通知写接口与 01/03 篇的关系
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验