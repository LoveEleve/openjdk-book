# 32-jfr/02-event-metadata 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JFR 的 130+ 种事件类型怎么定义、怎么生成 C++ 事件类、Java 侧怎么管理

## 1. 选题判断

现稿已有很强事实基础：
- metadata.xml 定义源（124 个 Event）
- 构建期 GenerateJfrFiles 生成 C++ 头文件
- Java 侧 TypeLibrary / MetadataRepository
- JfrMetadataEvent 二进制 metadata 回传

核心困惑：**`.jfr` 文件里每个事件只存值和类型 id，不存字段名——reader 怎么知道 130+ 种事件长什么样？metadata 从哪里来、怎么生成、怎么写进 chunk？**

## 2. 一句话顿悟

**metadata.xml 是唯一事实源。构建期由 GenerateJfrFiles 生成 C++ 事件类（jfrEventClasses.hpp + jfrEventIds.hpp），Java 侧也读同一份 XML 注册类型。运行时 Java 侧维护二进制 metadata，通过 JfrMetadataEvent 写回 native、chunk 关闭时落盘。reader 靠 metadata 区还原一切。**

## 3. 总图

```text
metadata.xml (124 个 Event, 层级 category)
  ├─ 构建期 → GenerateJfrFiles → jfrEventClasses.hpp + jfrEventIds.hpp
  │                               → C++ 事件类 (set_xxx + commit)
  └─ 运行期 → jdk.jfr 复制 → MetadataHandler 解析
               → TypeLibrary → MetadataRepository
               → JfrMetadataEvent → 二进制 metadata 回写 native
               → chunk 关闭时落盘
```

## 4. 结构大纲

### 第一节：开场困惑——"reader 怎么知道事件长什么样"

目标约 800 字。

- 从 `.jfr` 只存值和类型 id 切入
- 埋主线：metadata 集中描述，schema 与数据分离

### 第二节：两个朴素方案

目标约 1000 字。

1. 每个事件都存字段名（空间浪费大）
2. 用硬编码格式（reader 和 JVM 版本耦合）

### 第三节：metadata.xml 定义源

目标约 1500 字。

- 124 个 Event，层级 category
- 事件级属性 / 字段级属性

### 第四节：构建期生成

目标约 1500 字。

- GenerateJfrFiles → jfrEventClasses.hpp + jfrEventIds.hpp
- C++ 事件类：set_xxx + commit

### 第五节：Java 侧管理

目标约 1500 字。

- TypeLibrary / MetadataRepository
- 动态事件（EventFactory + ASM）
- JfrMetadataEvent 二进制回写

### 第六节：误解澄清与收网

目标约 1000 字。

## 5. 失败方案

1. 每个事件都存字段名
2. 硬编码格式

## 6. 证据清单

- metadata.xml 在 `src/hotspot/share/jfr/metadata/metadata.xml`
- `src/hotspot/share/jfr/metadata/jfrEvents.hpp:28,32`
- `src/hotspot/share/jfr/recorder/checkpoint/jfrMetadataEvent.hpp:31-43`
- `src/hotspot/share/jfr/samplers/jfrThreadSampler.cpp:264,288-300`

## 7. 完成后 review

- 删除代码后，能否复述"metadata.xml 是唯一事实源"
- 是否讲清构建期和运行期两条路径
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验