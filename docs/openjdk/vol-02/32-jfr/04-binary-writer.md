# 04. .jfr 文件是什么格式?— Binary Writer + Chunk Format

> **前置依赖**:[32-jfr/01 — JFR 怎么在每个线程上采集事件?— Recorder Engine](openjdk/vol-02/32-jfr/01-recorder-engine.md):文件头与轮转的实证;[32-jfr/02 — JFR 有 130 种事件类型 — 它们怎么定义?— Event Types + Metadata](openjdk/vol-02/32-jfr/02-event-metadata.md):metadata 区的内容;[32-jfr/03 — JFR 怎么 10ms 采一次全部线程栈?— Periodic Sampling](openjdk/vol-02/32-jfr/03-periodic-sampling.md):栈常量池的落盘
> → **后续**:[32-jfr/05 — 泄漏剖析](05-leak-profiler.md)
> 关联域: 48-utilities、04-logging

## 二进制流怎么还原成事件

32-01 的 xxd 证明了文件头("FLR"+版本+6 头槽),32-02/03 证明了 metadata 区与栈常量池——这篇补**中间层**: 事件/检查点/字符串在字节流里怎么编码(writer 管线),reader 怎么按同样的规则还原([实证:](planning/outlines/00-jvm-tools/materials/commands/32-jfr-binary-demo.txt) `jfr print --xml` 把 `jdk.CPULoad` 还原成 `jvmUser/machineTotal` 等字段值)。

## 1. Writer 管线: 一个模板,三副面孔

JFR 的写出不在"某个 jfrBinaryWriter.cpp"里——它是 **`WriterHost` 模板**(jfrWriterHost.hpp/inline),参数化三件事:

```cpp
// jfrWriterHost.inline.hpp:84-89(截取核心,逐字)
inline u1* WriterHost<BE, IE, WriterPolicyImpl>::write(const T* value, size_t len, u1* pos) {
  assert(value != NULL, "invariant");
  assert(len > 0, "invariant");
  assert(pos != NULL, "invariant");
  return _compressed_integers ? IE::write(value, len, pos) : BE::write(value, len, pos);
}
```

- **BE**(大端编码器,`BigEndianEncoderImpl`,jfrEncoders.hpp:52): 固定宽度大端——浮点/布尔/长度头用 `be_write`(jfrWriterHost.inline.hpp:118);
- **IE**(整数编码器): 默认 `Varint128EncoderImpl`(jfrEncoders.hpp:159)——见 §2;
- **存储策略**: 事件写进 JfrBuffer(`JfrEventWriter`)、检查点写常量池(`JfrCheckpointWriter`)、chunk 写文件(`JfrChunkWriter`)——同一套编码,三种落地。

`_compressed_integers` 由构造时决定(jfrWriterHost.inline.hpp:140-142),值来自 `JfrOptionSet::compressed_integers()`——**恒为 true**(jfrOptionSet.cpp:146-149,注释 "Set this to false for debugging purposes"),即"压缩整数"是 JFR 文件的默认格式,不可配置。

## 2. Varint128: 7 位一组 + 扩展位

变长整数编码(jfrEncoders.hpp:159-210,名字 **Varint128**,与 LEB128 同族——大纲的 `jfrLeb128.hpp` 不存在):

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

**每字节 7 位数据 + 第 8 位(0x80)扩展标记**: 值 < 128 一字节;大值每 128 进位一字节——时间戳增量、事件 type id、字符串长度这类小值通常 1-2 字节。writer 的尺寸余量注释还点出一个陷阱(jfrWriterHost.inline.hpp:145-153): **负值最费字节**——s1 的 -1 要编码成 `0xff 0x0f`(2 字节),所以 `size_safety_cushion = 1` 预留。reader 侧按同样规则解码: 每字节取低 7 位,高位为 1 就续下一字节。

## 3. 字符串: 编码标记 + 长度 + 字节

字符串有五种形态(`JfrStringEncoding`,jfrEncoding.hpp: `NULL_STRING=0/EMPTY_STRING/STRING_CONSTANT/UTF8/UTF16/LATIN1`)——**空串、常量池引用、两种 Unicode、Latin1 各有一个编码字节**,先写标记再写内容:

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
  ...
```

`write_utf16`(:107-114)同构(UTF16 标记+长度+数据)。**常量池引用(STRING_CONSTANT)**由检查点层在写字符串时按需登记: 相同字符串在常量池登记一次,事件里只写引用——与 32-03 的栈去重同构(值去重 + 事件引用 id)。

## 4. chunk 结构回顾

结合 32-01 的实证,一个 chunk 的完整布局是:

```
[文件头: "FLR\0" + 版本 2.0 + 6×8 头槽(chunk_size/checkpoint 偏移/metadata 偏移/
         start nanos/duration/start ticks)+ 频率 + compressed 标志]
[initial checkpoint: 常量池(线程/类/栈轨迹/字符串)]
[metadata: 事件类型 schema(32-02)]
[事件数据: [type_id][时间戳][字段...]——整数字段 Varint128,字符串编码标记+长度+数据]
[chunk 结束: 写回头部偏移,轮转(32-01)]
```

每 chunk 自包含(头+常量池+metadata),`jfr print`/JMC 可以从任意 chunk 开始解析——streaming 与随机访问的前提。

## 核心悬念

二进制层拆完: 写出一套 `WriterHost` 模板(大端固定宽 + Varint128 变长 + 存储策略),压缩整数是默认格式(恒 true 不可关),字符串按编码标记(NULL/常量/UTF8/UTF16/LATIN1)+长度+数据写,事件体=type_id+时间戳+字段——reader 按同一规则还原([实证](planning/outlines/00-jvm-tools/materials/commands/32-jfr-binary-demo.txt) `jfr print --xml` 的字段值就是这么来的)。chunk 自包含使 .jfr 可流式消费、可随机访问。

但 JFR 还有一个重量级的附加子系统没拆: **泄漏剖析(Leak Profiler)**——它利用 JFR 的事件与栈信息定位"对象从哪泄漏"(老年代对象/路径追踪),有自己的采样与检查点通道。下一篇: 泄漏剖析。

> → [32-jfr/05 — 泄漏剖析](05-leak-profiler.md)
