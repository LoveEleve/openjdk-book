# 04. .jfr 文件是什么格式？— Binary Writer + Chunk Format

> 🟡 Working | 2 KP 中的文件格式
> 读者处境: `recording.dump("flight.jfr")` → JFR 把 recording 写到 .jfr 文件。这个文件是二进制 chunk 格式——header+constant pool+metadata+events——用 LEB128 编码压缩。

### 1. "Chunk format — 文件结构"

场景: JMC 打开 100MB .jfr 文件 → 不是 sequential scan——是用 chunk boundaries 做随机访问——找到感兴趣的 time range → 解析对应 chunk。

**Chunk layout** (`jfr/writers/jfrBinaryWriter.cpp:40-200`):
```
[Chunk Header: magic(0xCAFEBABE)+version+major/minor+size]
[Constant Pool: string/integer/class refs used in events]
[Metadata: event type schemas(名字+字段:类型)]
[Event Data: inline event records]
  [event_type_id][timestamp][fields...]
[Chunk Footer: checksum]
```
- 源码: `jfr/writers/jfrBinaryWriter.cpp:40-200` + `jfr/writers/jfrChunkWriter.cpp:50-250`
- 关键设计: 每 chunk 自主序列化——metadata 和 constant pool 每 chunk 重新写→reader 不需跨 chunk 状态。Chunk 之间无依赖→reader 可从 recording 的任意中间 chunk 开始解析
- [C++: chunk header 在 `jfrChunkWriter.cpp:80-150` 写——magic check 让 reader 快速验证文件类型。constant pool 和 metadata 在每 chunk 开头重复——允许 recording streaming——reader 在 recording 进行中就能读已完成的 chunk]

### 2. "LEB128 — 变长编码"

场景: timestamp delta 通常是 ~100ns(two events within same thread)—存成 32-bit = wasteful。LEB128 让 100 只需要 1 byte。

**LEB128 encoding** (`jfr/utilities/jfrLeb128.hpp/cpp`):
```
整数值编码: 7 bits data + 1 bit continue(if more bytes follow)
  value < 128: 1 byte(1/4 of 32-bit)
  value < 16K: 2 bytes(1/2)
  value < 2M:  3 bytes
```
- 源码: `jfr/utilities/jfrLeb128.hpp:30-80` + `jfrLeb128.cpp:40-120`
- 关键设计: JFR 用 LEB128 编码所有整数值——小值(timestamp delta, event type id)平均 ~1-2 字节→压缩比 ~3-5x vs fixed 32-bit。recording 100MB 数据可能只 ~25MB 在磁盘上

### 3. "Writer pipeline"

**Writer pipeline** (`jfr/writers/jfrChunkWriter.cpp:200-400`):
```
JfrEvent::commit() → JfrStorage::write(buffer) → LEB128 encode values
  → buffer full → JfrChunkWriter::write_chunk
    → header + constant pool + metadata + events → chunk file
      → rotation(size > chunk_size_limit) → new chunk
```
- 源码: `jfr/writers/jfrChunkWriter.cpp:200-400` rotation logic

---

### 核心悬念

**"JFR .jfr 文件是 chunk 格式: header+constant pool+metadata+LEB128 events。每 chunk 自主—无跨 chunk 依赖——支持 streaming/随机访问。"** — 下一篇: Leak Profiler。

> → [05-leak-profiler.md](05-leak-profiler.md)
