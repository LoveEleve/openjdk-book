# 04. Codec 怎么把 Java 对象变成 Redis 能存的字节

> **前置依赖**: R-1(Config.setCodec 全局设置)
> → **后续**: R-5 RMap(Codec 在 map 操作中实际使用)

## 困惑：`bucket.set(myObject)` 之后，Redis 里存的是什么？

直觉上，存的是 `myObject.toString()` 或者 Java 序列化的字节。但仔细想想：如果 A 服务用 JSON 写入，B 服务用 Kryo 读取，能读出来吗？

## 为什么不行：不能只用一个 `toString()`

`toString()` 只返回类名 + 哈希值，不是完整的对象数据。Java 的 `Serializable` 接口虽然能序列化，但体积大、跨语言不可读。所以 Redisson 需要一套可插拔的编解码体系。

## 分层拆解

### 1. Codec 接口：6 个方法

`client/codec/Codec.java`：

```java
public interface Codec {
    Decoder<Object> getMapValueDecoder();
    Encoder getMapValueEncoder();
    Decoder<Object> getMapKeyDecoder();
    Encoder getMapKeyEncoder();
    Decoder<Object> getValueDecoder();
    Encoder getValueEncoder();
}
```

6 个方法分两组：**map 系列**（Hash 的 field/value 编码）和**普通系列**（非 Hash 结构的值编码）。`Decoder` 和 `Encoder` 是 `client/protocol/` 下的函数式接口。

### 2. 5 种内置实现

- **JsonJacksonCodec**（默认，236 行）：`new ObjectMapper()` 构造，可读性好，跨语言
- **Kryo5Codec**（246 行）：高性能二进制，仅 Java 可读
- **SnappyCodecV2** / **LZ4CodecV2**：在基础编码上再压缩
- **SerializationCodec**：JDK `java.io.Serializable`

### 3. 全局 vs 单结构

`config.setCodec(new JsonJacksonCodec())` 全局设置。`getMap("key", codec)` 单结构覆盖。Redis 中存的是字节，用什么 Codec 可解取决于写入时选择的 Codec——读错 Codec 会解码异常。

## 收网

Codec 6 个方法覆盖 value/map-key/map-value 三类场景。5 种实现覆盖 JSON/二进制/压缩。Redis 中存的是字节，Codec 选择决定能否正确读写。

## 下篇

R-5 RMap 分布式映射。
ENDOFFILE