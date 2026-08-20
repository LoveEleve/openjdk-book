# Ch1-01 ByteBuffer 核心抽象 — 正文深审记录

## 第一轮：事实与锚点审

- 核对 `Buffer.java` 的四字段、不变量、clear/flip/rewind/mark/reset 方法。
- 核对 `X-Buffer.java.template` 的 relative/absolute get 分支。
- 核对 `Heap-X-Buffer.java.template` 的 compact 数据移动逻辑。
- 正文所有源码锚点均带文件名与行号，无裸行号。

## 第二轮：因果审

- “四字段 → 状态机”有不变量和状态迁移依据。
- “compact 保留半包”有 `[position, limit)` 数据区间依据。
- “单 position → Netty 双指针演进动机”标为演进/权衡，不写成 NIO 实现缺陷。
- 未把 Ch2 Channel、Ch3 Selector 的后文结论提前当作本篇事实。

## 第三轮：结构审

- 结构已从源码顺序改为：byte[] 困惑 → 失败方案 → 四字段 → relative/absolute → flip → compact → 复位族 → Netty 桥接。
- 失败方案至少 3 组：多对象、调用方维护边界、flip 替代 compact。
- 篇末回收开篇问题并桥接 Ch1-02/Ch1-03/Ch4。

## 第四轮：读者审

- 删除代码块后，四字段状态机、flip/compact 差异和复位族仍可复述。
- 已补充常见误解：clear 不清数据、rewind 不进入写模式、absolute 不推进 position、compact 保留未读区间。
- 文章主语以生产者/消费者/解析器/调用方为主，不以字段清单开场。

## 第五轮：边界审

- 明确 NIO Buffer 单 position 的代价，不将其与 Netty 双指针写成实现相同。
- 明确本篇不展开 heap/direct、Channel、Selector，只建立必要桥接。
- 未引入线程安全、字节序、视图共享等属于后续篇的细节。

## 第六轮：方法论审

- 篇级依赖已落盘：`01-core-abstraction.rewrite-plan.md`。
- 目标目录为 `vol-netty`，未修改 `vol-02`/`vol-java`。
- 禁用词扫描通过。
- 不以 8000 字作为硬门槛；当前篇幅已覆盖核心问题、失败方案、四字段状态机、relative/absolute、flip/compact、复位族、误解澄清和 Netty 桥接。按“深度/广度/删码后成立”标准，本轮不因字数要求扩写。
