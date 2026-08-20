# 32-jfr/04-binary-writer 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 .jfr 的二进制流怎么编码——WriterHost 模板、Varint128、字符串编码、chunk 自包含结构

## 1. 选题判断

现稿已有很强事实基础：
- `WriterHost` 模板参数化三件事
- `Varint128EncoderImpl`
- `JfrStringEncoding` 五种形态
- chunk 结构回顾

核心困惑：**reader 怎么从二进制流还原出字段值？整数为什么用 Varint128？字符串怎么编码？chunk 为什么可以自包含、边录边读？**

## 2. 一句话顿悟

**JFR 的二进制流靠一套统一的 `WriterHost` 模板写出：整数默认 Varint128（7 位一组 + 扩展位），浮点/布尔大端固定宽，字符串先写编码标记再写长度和数据。chunk 的文件头、常量池、metadata、事件体构成自包含块，关闭时回填偏移，因此 reader 可以从任意 chunk 开始解析。**

## 3. 总图

```text
WriterHost<BE, IE, WriterPolicy>
  BE  → 大端固定宽 (float/double/bool/原始字节)
  IE  → Varint128 变长整数
  WriterPolicy → 写到 JfrBuffer / checkpoint / chunk 文件

事件体
  [u4 event_size][type_id][timestamp][field...]

字符串
  [encoding_tag][len][bytes]
  tag = NULL / EMPTY / CONSTANT / UTF8 / UTF16 / LATIN1

chunk
  [FLR\0 + version + 6×8 头槽 + frequency + flags]
  [initial checkpoint]
  [metadata]
  [event data]
  [close: write_header 回填偏移]
```

## 4. 结构大纲

### 第一节：开场困惑——"reader 怎么还原字段值"

目标约 800 字。

- 从 `.jfr` 只是一串字节切入
- 埋主线：writer/reader 共享一套模板与编码约定

### 第二节：两个朴素方案为什么都不对

目标约 1000 字。

1. 全部固定宽编码（空间浪费大）
2. 每种事件自定义 writer（实现分裂）

### 第三节：WriterHost 模板——一个模板,三副面孔

目标约 1500 字。

- `WriterHost<BE, IE, WriterPolicy>`
- 大端固定宽、Varint128、不同存储策略
- `_compressed_integers` 恒 true

### 第四节：Varint128——7 位一组 + 扩展位

目标约 1200 字。

- 小值 1 字节,大值多字节
- 负值最费字节
- reader 对称解码

### 第五节：字符串——编码标记 + 长度 + 字节

目标约 1200 字。

- `JfrStringEncoding` 五种形态
- `write_utf8` / `write_utf16`
- `STRING_CONSTANT` 与常量池引用

### 第六节：chunk 结构——为什么能自包含

目标约 1500 字。

- 文件头 + initial checkpoint + metadata + event data
- 关闭时回填
- 自包含支持随机访问/流式消费

### 第七节：误解澄清与收网

目标约 1000 字。

## 5. 失败方案

1. 全部固定宽编码
2. 每种事件自定义 writer

## 6. 证据清单

- `src/hotspot/share/jfr/writers/jfrWriterHost.inline.hpp:84-89`
- `src/hotspot/share/jfr/recorder/storage/jfrBuffer.hpp:33-57`
- `src/hotspot/share/jfr/support/jfrTypeManager.hpp` (if needed)
- `src/hotspot/share/jfr/utilities/jfrEncoders.hpp:159-213`
- `src/hotspot/share/jfr/writers/jfrWriterHost.inline.hpp:92-100`
- `src/hotspot/share/jfr/writers/jfrWriterHost.inline.hpp:107-114`
- `src/hotspot/share/jfr/recorder/repository/jfrChunkWriter.cpp:54-70`
- `src/hotspot/share/jfr/recorder/repository/jfrChunkWriter.cpp:84-98`
- `src/hotspot/share/jfr/recorder/storage/jfrEventWriterHost.inline.hpp:56-76`

## 7. 完成后 review

- 删除代码后，能否复述 WriterHost + Varint128 + 字符串 + chunk 自包含
- 是否讲清 chunk 关闭时回填
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验