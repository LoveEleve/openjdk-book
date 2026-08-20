# Ch4-02 ByteBufAllocator 分配器体系 — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| `buffer()` 不承诺 heap/direct | `ByteBufAllocator.java:25-43` | ✅ |
| `ioBuffer()` 只是 preferably direct | `ByteBufAllocator.java:45-58` | ✅ |
| heap/direct/composite 明确入口 | `ByteBufAllocator.java:60-122` | ✅ |
| direct pooling 与容量算法接口 | `ByteBufAllocator.java:124-133` | ✅ |
| 默认值与 4 MiB threshold | `AbstractByteBufAllocator.java:31-34` | ✅ |
| 公共分发、zero/zero、校验 | `AbstractByteBufAllocator.java:85-169` | ✅ |
| 模板抽象方法 | `AbstractByteBufAllocator.java:216-224` | ✅ |
| directByDefault 条件 | `AbstractByteBufAllocator.java:64-82` | ✅ |
| ioBuffer 的 direct/heap 条件 | `AbstractByteBufAllocator.java:109-131` | ✅ |
| composite 分发 | `AbstractByteBufAllocator.java:171-205` | ✅ |
| 小于 threshold 的 2 次幂策略 | `AbstractByteBufAllocator.java:256-258` | ✅ |
| 等于 threshold 的特殊分支 | `AbstractByteBufAllocator.java:239-243` | ✅ |
| 大于 threshold 的步进与 maxCapacity 截断 | `AbstractByteBufAllocator.java:245-253` | ✅ |
| Unpooled 不池化与具体实现分发 | `UnpooledByteBufAllocator.java:25-32`、`:81-115` | ✅ |
| Pooled 默认 page/maxOrder/chunk 配置 | `PooledByteBufAllocator.java:38-57`、`:68-126` | ✅ |
| LeakAware 普通/Composite 包装 | `AbstractByteBufAllocator.java:36-62` | ✅ |
| Unpooled direct 的 disableLeakDetector | `UnpooledByteBufAllocator.java:89-98` | ✅ |

### 深审发现

1. **中风险：大于 4 MiB 的算法描述不够精确。** 初稿写成“对齐后再增加一个步长”但未明确整数倍需求也会额外增长。已补充“对齐基线 + 可能增加一步”的行为及示例边界。
2. **低风险：direct pooling 的解释容易被读成通用释放保证。** 已限定为当前 `ioBuffer()` 实现的策略条件，不外推到所有 allocator/平台。

## 第二轮：因果审

- 业务直接 new 具体 ByteBuf -> 实现耦合 -> SPI 按意图申请：✅
- SPI 入口 -> Abstract allocator 默认值/校验/分发 -> 子类 newHeap/newDirect：✅
- I/O 意图 -> direct 释放能力或 direct pooling 条件 -> direct/heap 降级：✅
- writable 不足 -> calculateNewCapacity -> 小/等/大于 4 MiB 三路增长 -> maxCapacity 封顶：✅
- 频繁底层分配 -> Unpooled/Pooled 策略差异 -> 调用接口不变：✅
- 引用计数可能泄漏 -> allocator 返回边界接 LeakAware -> 诊断不替代 release：✅

事实与设计推断已区分，未发现高风险因果跳跃。

## 第三轮：结构审

正文按“调用意图 → 公共模板 → ioBuffer 条件 → 扩容算法 → Unpooled/Pooled → LeakAware → 总图”组织，没有按源码文件顺序罗列。✅

失败方案覆盖直接 new、永远 direct、所有扩容翻倍、业务手动包装、硬绑定 4 MiB 等。✅

## 第四轮：读者审

删掉代码块后仍能复述：Allocator 隔离创建策略，`buffer/ioBuffer/heap/direct` 表达不同意图，抽象类收公共流程，容量算法按阈值切换，具体 allocator 和 LeakAware 在返回边界落地。✅

主要路标清晰：SPI 解耦、模板分发、扩容算法停顿回收、策略对照、诊断边界、收网总图。✅

## 第五轮：边界审

- 4 MiB、256、Integer.MAX_VALUE、默认组件数均标明为当前实现默认值。✅
- `buffer()` 和 `ioBuffer()` 未写成类型承诺。✅
- `directByDefault` 与 `ioBuffer` 条件分开。✅
- 4 MiB threshold 与默认 Pooled chunk 的数值关系已限定为默认配置下的呼应。✅
- Unpooled/Pooled 未提前展开 Arena/Chunk/Subpage/ThreadCache。✅
- LeakAware 只讲返回边界，不冒充自动修复 ownership。✅

## 第六轮：依赖审

- Ch4-01 已完成并提供 capacity/maxCapacity/ensureWritable 前置。✅
- Ch1-02、Ch2、Ch3 已完成，分别支撑 Heap/Direct 与 I/O 场景。✅
- Ch4-03 Heap/Direct、Ch4-04 views、Ch4-05 Composite、Ch5 EventLoop、Ch8 pooling 只作导航。✅
- 未把 `io.netty.allocator.type` 三模式当作本篇未经展开的硬前提。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 435。
- 去码后字符数：约 10,200。
- 去码去空白后字符数：约 9,200。
- 符合重大机制篇篇幅要求。✅

## 结论

六轮 review 完成，深审发现 2 项表述边界并已修正。Ch4-02 可进入后续深度 review 或继续 Ch4-03。
