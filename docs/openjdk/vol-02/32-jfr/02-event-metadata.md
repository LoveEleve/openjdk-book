# 02. JFR 有 130 种事件类型 — 它们怎么定义?— Event Types + Metadata

> **前置依赖**:[32-jfr/01 — JFR 怎么在每个线程上采集事件?— Recorder Engine](openjdk/vol-02/32-jfr/01-recorder-engine.md):buffer/chunk/Recorder Thread 是承载;[31-unsafe/02 — WhiteBox 与 Forte](openjdk/vol-02/31-unsafe-whitebox/02-whitebox-forte.md):采样器用的事件类
> → **后续**:[32-jfr/03 — JFR 怎么 10ms 采一次全部线程栈?— Periodic Sampling](03-periodic-sampling.md)
> 关联域: 31-02(采样)、38-perfdata(观测通道)、30-jvm-entry

## reader 怎么知道 130+ 种事件长什么样

`.jfr` 文件里每个事件只存**值**(字段的二进制序列,外加事件类型 id),不存字段名/类型——那太浪费。字段的 schema 集中在 chunk 的 **metadata 区**: 每个事件的名称、字段、类型、单位(时间/百分比/地址)、标签,全部描述一次,reader(JMC/jfr 工具)按它解析每一条事件。[实证:](openjdk/planning/outlines/00-jvm-tools/materials/commands/32-jfr-metadata-demo.txt) `jfr print --events 'jdk.ThreadStart'` 输出 `thread = "main" (javaThreadId = 1)`——**字段名从 metadata 来,值从事件体来**。这篇拆 metadata 的源头(metadata.xml)、生成链(构建期代码生成)、Java 侧管理,以及分类。

## 1. 定义源: metadata.xml

**内置事件类型**全部定义在**一个 XML 文件**(hotspot/share/jfr/metadata/metadata.xml,1168 行,**124 个 Event**),比如 ThreadStart:

```xml
<!-- metadata.xml:29-32(截取核心,逐字) -->
  <Event name="ThreadStart" category="Java Application" label="Java Thread Start" thread="true" startTime="false" stackTrace="true">
    <Field type="Thread" name="thread" label="New Java Thread" />
    <Field type="Thread" name="parentThread" label="Parent Java Thread" />
  </Event>
```

**事件级属性**: `name`(类型名)、`category`(分类,逗号分隔的层级)、`label`(显示名)、`thread`(是否关联线程)、`startTime`(是否带起始时间)、`stackTrace`(是否默认采栈)。**字段级属性**: `type`(基础类型: long/ulong/boolean/string/Thread/Class...)、`name`、`label`、`contentType`(单位提示: millis/nanos/address/percentage——reader 据此显示单位)、`relation`(关联关系,如 `JavaMonitorAddress` 让 reader 把 wait/enter 事件的地址关联到同一监视器)。**分类不是大纲的简单五组**: [实证:](openjdk/planning/outlines/00-jvm-tools/materials/commands/32-jfr-metadata-demo.txt) `category` 是层级值——"Java Virtual Machine, GC, Detailed"(23 个)、"Java Virtual Machine, Flag"(14)、"Java Application"(9)、"Java Virtual Machine, Runtime, Safepoint"(6)、"Operating System, Processor"(5)……

## 2. 构建期生成: metadata.xml → C++ 事件类

C++ 事件类不会在运行期生成——**构建期**由 Java 工具 `build.tools.jfr.GenerateJfrFiles` 把 XML 生成 C++ 头文件(make/hotspot/gensrc/GensrcJfr.gmk: `TOOL_JFR_GEN := ... build.tools.jfr.GenerateJfrFiles`,输出到 `gensrc/jfrfiles/`):

- 产物: **`jfrEventClasses.hpp` + `jfrEventIds.hpp`**(生成目录,不在源码树——大纲的 "jfrEventClasses.hpp:30-120 enum" 看不到源码,因为它就是生成物);
- 入口: `jfrEvents.hpp` 顶部注释 "Declare your event in jfr/metadata/metadata.xml."(:28),:32 `#include "jfrfiles/jfrEventClasses.hpp"`——**事件类型的新增/修改只动 XML,代码生成负责同步 C++**;
- 生成类的形态: 每个事件一个类,有**字段 setter + commit()**。使用方式在采样器里看得最清楚(jfrThreadSampler.cpp:264/:288-300): `event->set_stackTrace(id)`(把栈轨迹 id 写进事件)、`_events[i].commit()`(写 buffer)——与 32-01 的写入链衔接。大纲的 `TRACE_REQUEST_COMMIT` 宏在 jdk11u 里**不存在**(grep 零命中)。

## 3. Java 侧: 类型库与动态事件

**metadata.xml 是唯一事实源,双端消费**: ①hotspot 构建期生成 C++ 事件类(§2);②构建时被复制进 jdk.jfr 模块的资源(`/jdk/jfr/internal/types/metadata.xml`,make/copy/Copy-jdk.jfr.gmk),运行期 `MetadataHandler`(:218 解析它)注册 **Java 侧事件类型**——所以 Java 侧的 `jdk.*` 事件与 C++ 的 native 事件来自同一份定义。Java 侧的管理体系:

- **内置 `jdk.*` 事件**: `MetadataRepository.initializeJVMEventTypes`(jdk.jfr/internal/MetadataRepository.java:66-86)——`MetadataHandler` 解析 metadata.xml 后遍历 `TypeLibrary` 的 `PlatformEventType`,包成 `EventType`,检查 `@Threshold/@StackTrace/@Cutoff/@Period` 注解(决定"这个事件要带时长/栈/周期"),周期事件挂 `RequestHook`(下一篇的主角),并建 `EventControl` 与 native 的启用位对接(32-01 的 JfrEventSetting);
- **动态事件**(EventFactory): `EventClassBuilder`(jdk.jfr/internal/EventClassBuilder.java:45)用 **ASM 在运行期生成字节码类**("jdk.jfr.DynamicEvent"+自增 id)——jdk.jfr 的用户自定义事件不用预编译;
- **metadata 二进制回传**: `JfrMetadataEvent`(jfrMetadataEvent.hpp:31-43)的注释是权威——"Metadata is continuously updated in Java as event classes are loaded / unloaded. Using update(), Java stores a binary representation back to native."——**Java 侧维护一份二进制 metadata(类型注册/注销时更新),update() 存回 native;chunk 关闭时 write() 写进文件**,偏移填进 32-01 的文件头"metadata section offset"槽。这就是为什么 `jfr summary`/`jfr print` 能读出 143 种类型与字段(XML 的 124 个内置 + Java 侧注册的其余类型)。

## 核心悬念

事件类型系统拆完: 定义在 metadata.xml(124 个 Event,层级 category,contentType 单位提示);构建期由 GenerateJfrFiles 生成 C++ 事件类(jfrEvents.hpp 一行 include 接入,set_xxx+commit 两段式使用);Java 侧 TypeLibrary/MetadataRepository 管内置类型(注解→能力标志→EventControl/RequestHook),EventClassBuilder 用 ASM 造动态类,二进制 metadata 经 JfrMetadataEvent 存回 native、chunk 关闭落盘——**schema 与数据分离,reader 靠 metadata 区还原一切**。

但有一族事件是"到点自动发生"的——`ExecutionSample`、`ThreadAllocationStatistics`、`NativeMethodSample`: 它们按**周期**触发,不靠埋桩。周期怎么定、采样怎么触发(以及和 31-02 采样器的关系)?下一篇: 周期采样与栈轨迹。

> → [32-jfr/03 — JFR 怎么 10ms 采一次全部线程栈?— Periodic Sampling](03-periodic-sampling.md)
