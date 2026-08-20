# 04. .jfr 文件是什么格式?— Binary Writer + Chunk Format

> **前置依赖**:[32-jfr/01 — JFR 怎么在每个线程上采集事件?— Recorder Engine](openjdk/vol-02/32-jfr/01-recorder-engine.md):文件头与轮转的实证;[32-jfr/02 — JFR 有 130 种事件类型 — 它们怎么定义?— Event Types + Metadata](openjdk/vol-02/32-jfr/02-event-metadata.md):metadata 区的内容;[32-jfr/03 — JFR 怎么 10ms 采一次全部线程栈?— Periodic Sampling](openjdk/vol-02/32-jfr/03-periodic-sampling.md):栈常量池的落盘
> → **后续**:[32-jfr/05 — 泄漏剖析](05-leak-profiler.md)
> 关联域: 48-utilities、04-logging

32-01 的 hexdump 证明了文件头("FLR"+版本+6 个头槽),32-02/03 证明了 metadata 区与栈常量池——但 reader 到底怎么从二进制流里还原出 `jdk.CPULoad.jvmUser` 这种字段值?本篇要回答的核心问题:

1. writer 用什么统一模板把字段写成二进制?
2. 整数为什么用 Varint128,字符串怎么编码?
3. chunk 为什么能自包含、边录边读?

答案会反复落到一句话:**JFR 的二进制流靠一套统一的 `WriterHost` 模板写出：整数默认 Varint128（7 位一组 + 扩展位），浮点/布尔大端固定宽，字符串先写编码标记再写长度和数据。chunk 的文件头、常量池、metadata、事件体构成自包含块，关闭时回填偏移，因此 reader 可以从任意 chunk 开始解析。**

---

## 1. 开场困惑——"reader 怎么还原字段值"

`.jfr` 文件里每个事件只存**值**(字段的二进制序列,外加事件类型 id),不存字段名/类型——那太浪费。字段的 schema 集中在 chunk 的 **metadata 区**: 每个事件的名称、字段、类型、单位,全部描述一次,reader(JMC/jfr 工具)按它解析每一条事件。

问题是: 这些“值”在文件里是什么编码? 整数有没有变长? 字符串怎么分空串/常量池/UTF8/UTF16? 这些规则如果不统一，reader 根本没法还原。

---

## 2. 两个朴素方案为什么都不对

### 方案一: 全部固定宽编码

最直接的编码是: int 一律 4 字节,long 一律 8 字节,字符串一律 UTF16。reader 好实现,但文件会膨胀。JFR 的事件里有大量小整数——事件类型 id、字符串长度、栈深度、时间戳增量——绝大多数都 < 128,用 8 字节存是浪费。

### 方案二: 每种事件自定义 writer

另一种极端是: 每个事件类型各写各的序列化逻辑。这样似乎最省空间,但实现会分裂——130+ 种事件各自定义 writer/reader,metadata 也失去统一语义。JFR 的设计恰是相反: **一个 WriterHost 模板,统一编码规则,不同事件只填 metadata**。

---

## 3. WriterHost 模板——一个模板,三副面孔

JFR 的写出不在某个 `jfrBinaryWriter.cpp` 里——它是 **`WriterHost` 模板**(jfrWriterHost.inline.hpp),参数化三件事:

```cpp
// jfrWriterHost.inline.hpp:84-89(截取核心,逐字)
inline u1* WriterHost<BE, IE, WriterPolicyImpl>::write(const T* value, size_t len, u1* pos) {
  assert(value != NULL, "invariant");
  assert(len > 0, "invariant");
  assert(pos != NULL, "invariant");
  return _compressed_integers ? IE::write(value, len, pos) : BE::write(value, len, pos);
}
```

- **BE**(`BigEndianEncoderImpl`): 固定宽大端——浮点/布尔/原始字节走这条路;
- **IE**(整数编码器): 默认 `Varint128EncoderImpl`——见下一节;
- **WriterPolicy**: 决定写到哪——事件写进 JfrBuffer(`JfrEventWriter`),检查点写常量池(`JfrCheckpointWriter`),chunk 写文件(`JfrChunkWriter`)。

`_compressed_integers` 由构造时决定(jfrWriterHost.inline.hpp:140-142),值来自 `JfrOptionSet::compressed_integers()`——**产品默认恒为 true**(jfrOptionSet.cpp:146-149,注释 "Set this to false for debugging purposes")。所以: **压缩整数是 JFR 文件的默认格式,reader 也必须按它解码**;对常规用户没有关闭入口,只为调试/诊断场景保留例外。

---

## 4. Varint128——7 位一组 + 扩展位

变长整数编码(`Varint128EncoderImpl`,jfrEncoders.hpp:159-213):

```cpp
// jfrEncoders.hpp:199-213(截取核心,逐字)
static const u1 ext_bit = 0x80;
#define GREATER_THAN_OR_EQUAL_TO_128(v) (((u8)(~(ext_bit - 1)) & (v)))
#define LESS_THAN_128(v) !GREATER_THAN_OR_EQUAL_TO_128(v)
...
inline size_t Varint128EncoderImpl::encode(T value, u1* dest) {
  assert(dest != NULL, "invariant");

  const u8 v = to_u8(value);

  if (LESS_THAN_128(v)) {
    *dest = static_cast<u1>(v); // set bit 0-6, no extension
    ...
```

**每字节 7 位数据 + 第 8 位(0x80)扩展标记**: 值 < 128 一字节;大值每 128 进位一字节。时间戳增量、事件 type id、字符串长度这类小值通常 1-2 字节。

writer 的尺寸余量注释还点出一个陷阱(jfrWriterHost.inline.hpp:145-153): **负值最费字节**——`s1` 的 -1 要编码成 `0xff 0x0f`(2 字节),所以 `size_safety_cushion = 1` 预留。reader 侧按同样规则解码: 每字节取低 7 位,高位为 1 就续下一字节。

---

## 5. 字符串——编码标记 + 长度 + 字节

字符串有五种形态（`JfrStringEncoding`, jfrEncoding.hpp:32-38）: `NULL_STRING=0/EMPTY_STRING/STRING_CONSTANT/UTF8/UTF16/LATIN1`——**空串、常量池引用、两种 Unicode、Latin1 各有一个编码字节**,先写标记再写内容:

```cpp
// jfrWriterHost.inline.hpp:92-100(截取核心,逐字)
void WriterHost<BE, IE, WriterPolicyImpl>::write_utf8(const char* value) {
  if (NULL == value) {
    // only write encoding byte indicating NULL string
    write<u1>(NULL_STRING);
    return;
  }
  write<u1>(UTF8); // designate encoding
  const jint len = MIN2<jint>(max_jint, (jint)strlen(value));
  write(len);
```

`write_utf16`(:107-114)同构(UTF16 标记+长度+数据)。

**STRING_CONSTANT(常量池引用)**用于线程/类/符号这类常量池条目的字符串: 值在检查点登记一次,事件侧只写引用——与 32-03 的栈去重同构(值去重 + 事件引用 id)。

---

## 6. chunk 结构——为什么能自包含

结合 32-01 的实证,一个 chunk 的完整布局是:

```
[文件头: "FLR\0" + 版本 2.0 + 6×8 头槽(chunk_size/checkpoint 偏移/metadata 偏移/
         start nanos/duration/start ticks)+ 频率 + compressed 标志]
[initial checkpoint: 常量池(线程/类/栈轨迹/字符串)]
[metadata: 事件类型 schema(32-02)]
[事件数据: [u4 事件大小][type_id][时间戳][字段...]——大小槽在 begin 时预留、end 时回填
         (jfrEventWriterHost.inline.hpp:56-76),整数字段 Varint128,字符串=编码标记+长度+数据]
[chunk 结束: 写回头部偏移,轮转(32-01)]
```

`JfrChunkWriter::open`(jfrChunkWriter.cpp:54-70)写文件头,`write_header`(:84-98)在 chunk 关闭时回填 6 个头槽。**每个 chunk 自包含**(头+常量池+metadata),`jfr print`/JMC 可以从任意 chunk 开始解析——streaming 与随机访问的前提。

---

## 7. 误解澄清与收网

1. **reader 怎么知道字段名?** metadata 区。事件体只存值和类型 id,不存字段名。
2. **整数一律固定宽吗?** 不是。默认 Varint128,小值 1-2 字节。
3. **字符串一律 UTF16 吗?** 不是。有 5 种编码形态,包括 NULL/EMPTY/CONSTANT/UTF8/UTF16/LATIN1。
4. **chunk 头是写入时一次性完成的吗?** 不是。打开时预留,关闭时 `write_header` 回填偏移和大小。
5. **为什么 chunk 能随机访问?** 因为每个 chunk 自包含(文件头+常量池+metadata+事件体)。

把这一篇压成三句话:

- **WriterHost 一个模板,三副面孔**:大端固定宽 + Varint128 + 不同存储策略。
- **字符串先写编码标记再写长度和数据**,常量池字符串只写引用。
- **chunk 自包含并在关闭时回填头部**,因此 `.jfr` 可流式消费、可随机访问。

下一篇: 泄漏剖析——JFR 怎样利用事件与栈信息定位对象从哪泄漏。

> → [32-jfr/05 — 泄漏剖析](05-leak-profiler.md)