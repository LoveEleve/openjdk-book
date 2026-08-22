# 篇：01 Codec 序列化体系：Encoder / Decoder 与 7 种内置实现

- 域：`R-3 Codec 序列化体系`
- 卷：`vol-redisson`
- 目标：回答 Redisson 怎么把 Java 对象序列化成 Redis 可存储的数据，以及各种 Codec 的取舍。

## 前置依赖

- HARD：已读 `R-1 Redisson 主类与连接管理`（知道 Config 设置全局 Codec）。

## 读者问题

1. `Codec` 接口定义了哪两个方法？
2. Redis 内存中实际存的是什么格式？
3. JsonJacksonCodec（默认）和其他 6 种实现各有什么取舍？
4. `config.setCodec()` 全局设置和 `getMap("key", codec)` 单结构指定的区别？

## 主结论

`Codec` 接口位于 `client/codec/Codec.java`，定义了 **Encoder（序列化）+ Decoder（反序列化）** 抽象。所有数据结构通过 Codec 存取数据。7 种内置实现覆盖 JSON / 二进制 / 压缩三种取舍方向。

## 结构设计

1. 困惑开场：Java 对象怎么变成 Redis 能存的数据
2. Codec 接口：getMapValueDecoder / getValueEncoder（或等价方法）
3. JsonJacksonCodec（默认）：JSON 可读但体积大
4. Kryo5Codec / FSTCodec：高性能二进制
5. SnappyCodecV2 / LZ4CodecV2：压缩
6. 注册方式：全局 vs 单结构
7. 失败路径
8. 收网与下篇桥接 R-5 RMap

## 必须回填的源码锚点

- `client/codec/Codec.java` 接口（Decoder/Encoder）
- `codec/JsonJacksonCodec.java` 236 行（默认 JSON）
- `codec/Kryo5Codec.java` 246 行（二进制）

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
ENDOFFILE