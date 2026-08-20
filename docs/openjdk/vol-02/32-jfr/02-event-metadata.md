# 02. JFR 有 130 种事件类型 — 它们怎么定义?— Event Types + Metadata

> **前置依赖**:[32-jfr/01 — JFR 怎么在每个线程上采集事件?— Recorder Engine](openjdk/vol-02/32-jfr/01-recorder-engine.md):buffer/chunk/Recorder Thread 是承载;[31-unsafe/02 — WhiteBox 与 Forte](openjdk/vol-02/31-unsafe-whitebox/02-whitebox-forte.md):采样器用的事件类
> → **后续**:[32-jfr/03 — JFR 怎么 10ms 采一次全部线程栈?— Periodic Sampling](03-periodic-sampling.md)
> 关联域: 31-02(采样)、38-perfdata(观测通道)、30-jvm-entry

`.jfr` 文件里每个事件只存**值**(字段的二进制序列,外加事件类型 id),不存字段名/类型——那太浪费。字段的 schema 集中在 chunk 的 **metadata 区**: 每个事件的名称、字段、类型、单位,全部描述一次,reader(JMC/jfr 工具)按它解析每一条事件。本篇要回答的核心问题:

1. metadata 从哪里来——是硬编码还是从文件生成?
2. C++ 事件类怎么生成——构建期还是运行期?
3. Java 侧怎么管理事件类型——内置类型和动态事件怎么共存?

答案会反复落到一句话:**metadata.xml 是唯一事实源。构建期生成 C++ 事件类,Java 侧也读同一份 XML 注册类型。运行时 Java 侧维护二进制 metadata,通过 JfrMetadataEvent 写回 native、chunk 关闭时落盘。schema 与数据分离,reader 靠 metadata 区还原一切。**

---

## 1. 开场困惑——"reader 怎么知道事件长什么样"

130+ 种事件类型,每个事件有若干字段(名称、类型、单位)。如果每条事件记录都存字段名,文件体积会膨胀几倍。JFR 的做法是: **schema 集中描述一次,数据只存值和类型 id**。

这个 schema 就是 metadata 区。但 metadata 本身从哪里来?

---

## 2. 两个朴素方案为什么都不对

### 方案一: 每个事件都存字段名

最直观的实现: 每条事件记录自描述,字段名和类型都写在事件体里。好处是 reader 不需要前置知识,缺点也是明显的: 每条事件重复写名字字符串,文件体积膨胀。

### 方案二: 硬编码格式

另一种极端: 在 reader 侧硬编码事件布局。问题: reader 版本和 JVM 版本耦合——JVM 加了新事件类型或字段,旧 reader 就看不懂。JFR 支持边录边读、跨版本分析,硬编码做不到。

正确方案: schema 集中描述一次(metadata.xml),构建期生成双方代码,运行期 metadata 随 chunk 自包含。

---

## 3. 定义源——metadata.xml

**内置事件类型**全部定义在**一个 XML 文件**(hotspot/share/jfr/metadata/metadata.xml,1168 行,**124 个 Event**)。比如 ThreadStart:

```xml
<!-- metadata.xml:29-32(截取核心,逐字) -->
  <Event name="ThreadStart" category="Java Application" label="Java Thread Start" thread="true" startTime="false" stackTrace="true">
    <Field type="Thread" name="thread" label="New Java Thread" />
    <Field type="Thread" name="parentThread" label="Parent Java Thread" />
  </Event>
```

**事件级属性**: `name`(类型名)、`category`(分类,逗号分隔的层级)、`label`(显示名)、`thread`(是否关联线程)、`startTime`(是否带起始时间)、`stackTrace`(是否默认采栈)。**字段级属性**: `type`(基础类型: long/ulong/boolean/string/Thread/Class...)、`name`、`label`、`contentType`(单位提示: millis/nanos/address/percentage——reader 据此显示单位)、`relation`(关联关系)。

**分类不是大纲的简单五组**: `category` 是层级值——"Java Virtual Machine, GC, Detailed"(23 个)、"Java Virtual Machine, Flag"(14)、"Java Application"(9)……

---

## 4. 构建期生成——metadata.xml → C++ 事件类

C++ 事件类不会在运行期生成——**构建期**由 Java 工具 `build.tools.jfr.GenerateJfrFiles` 把 XML 生成 C++ 头文件:

- 产物: **`jfrEventClasses.hpp` + `jfrEventIds.hpp`**(生成目录,不在源码树);
- 入口: `jfrEvents.hpp` 顶部注释 "Declare your event in jfr/metadata/metadata.xml."(jfrEvents.hpp:28),jfrEvents.hpp:32 `#include "jfrfiles/jfrEventClasses.hpp"`——**事件类型的新增/修改只动 XML,代码生成负责同步 C++**;
- 生成类的形态: 每个事件一个类,有**字段 setter + commit()**。使用方式在采样器里看得最清楚(jfrThreadSampler.cpp:261, jfrThreadSampler.cpp:288-300): `event->set_stackTrace(id)`(把栈轨迹 id 写进事件)、`_events[i].commit()`(写 buffer)——与 01 篇的写入链衔接。

---

## 5. Java 侧——类型库与动态事件

**metadata.xml 是唯一事实源,双端消费**: ①hotspot 构建期生成 C++ 事件类(§4);②构建时被复制进 jdk.jfr 模块的资源,运行期 `MetadataHandler` 解析它注册 **Java 侧事件类型**。

Java 侧的管理体系:

- **内置 `jdk.*` 事件**: `MetadataRepository.initializeJVMEventTypes`——`MetadataHandler` 解析 metadata.xml 后遍历 `TypeLibrary` 的 `PlatformEventType`,包成 `EventType`,检查 `@Threshold/@StackTrace/@Cutoff/@Period` 注解,周期事件挂 `RequestHook`(下一篇的主角),并建 `EventControl` 与 native 的启用位对接;
- **动态事件**(EventFactory): `EventClassBuilder` 用 **ASM 在运行期生成字节码类**("jdk.jfr.DynamicEvent"+自增 id)——用户自定义事件不用预编译;
- **metadata 二进制回传**: `JfrMetadataEvent`(jfrMetadataEvent.hpp:31-43)的注释是权威——"Metadata is continuously updated in Java as event classes are loaded / unloaded. Using update(), Java stores a binary representation back to native."——**Java 侧维护一份二进制 metadata(类型注册/注销时更新),update() 存回 native;chunk 关闭时 write() 写进文件**,偏移填进 01 篇的文件头"metadata section offset"槽。

---

## 6. 误解澄清与收网

1. **metadata 从哪里来?** 一个 XML 文件(metadata.xml)。构建期生成 C++ 事件类,运行期 Java 侧也读同一份 XML。
2. **C++ 事件类是运行期生成的吗?** 不是。构建期由 GenerateJfrFiles 生成,`jfrEvents.hpp` 一行 include 接入。
3. **Java 侧动态事件怎么实现?** `EventClassBuilder` 用 ASM 在运行期生成字节码类,不需要预编译。
4. **metadata 怎么写进 chunk?** Java 侧维护二进制 metadata,通过 `JfrMetadataEvent::update()` 存回 native,chunk 关闭时 `write()` 落盘。
5. **metadata.xml 有冲突怎么办?** 只有一个文件,hotspot 和 jdk.jfr 模块共享同一份定义。

把这一篇压成三句话:

- **metadata.xml 是唯一事实源**:124 个 Event,层级 category,event 和 field 属性。
- **构建期生成 C++ 事件类**:GenerateJfrFiles → jfrEventClasses.hpp + jfrEventIds.hpp,set_xxx + commit 两段式。
- **Java 侧管理类型**:内置类型读同一份 XML,动态事件用 ASM 生成,JfrMetadataEvent 回写 native。

下一族事件是"到点自动发生"的——`ExecutionSample`、`ThreadAllocationStatistics`、`NativeMethodSample`: 它们按**周期**触发,不靠埋桩。周期怎么定、采样怎么触发?下一篇: 周期采样。

> → [32-jfr/03 — JFR 怎么 10ms 采一次全部线程栈?— Periodic Sampling](03-periodic-sampling.md)