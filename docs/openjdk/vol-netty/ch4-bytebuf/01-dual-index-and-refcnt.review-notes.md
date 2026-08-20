# Ch4-01 ByteBuf 双指针与引用计数 — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的 `file:line` 引用及关键语义。

| 事实 | 证据 | 结果 |
|---|---|---|
| 双指针和三区域 | `ByteBuf.java:59-74` | ✅ |
| read/write 分别推进两个索引 | `ByteBuf.java:76-104` | ✅ |
| 索引不变量 | `AbstractByteBuf.java:110-115` | ✅ |
| clear 只重置索引 | `ByteBuf.java:458-467`、`AbstractByteBuf.java:150-154` | ✅ |
| discardReadBytes 搬移和 marker 调整 | `AbstractByteBuf.java:216-233`、`:257-269` | ✅ |
| discardSomeReadBytes 的接口边界与当前阈值实现 | `ByteBuf.java:515-521`、`AbstractByteBuf.java:235-255` | ✅ |
| writable/maxWritable/maxFastWritable | `ByteBuf.java:407-430` | ✅ |
| ensureWritable 四状态 | `ByteBuf.java:537-556`、`AbstractByteBuf.java:308-335` | ✅ 已修正状态 2 语义 |
| RefCnt 后端选择和 raw value 编码 | `RefCnt.java:34-58` | ✅ |
| retain 原子更新与异常 | `RefCnt.java:254-270` | ✅ |
| release CAS 与归零判断 | `RefCnt.java:273-295` | ✅ |
| release -> deallocate 模板链 | `AbstractReferenceCountedByteBuf.java:82-101` | ✅ |
| 可达性检查与 best-effort 读取 | `AbstractByteBuf.java:1474-1482`、`AbstractReferenceCountedByteBuf.java:33-38` | ✅ |
| Heap/Direct/Pooled deallocate | `UnpooledHeapByteBuf.java:548`、`UnpooledDirectByteBuf.java:781`、`PooledByteBuf.java:174` | ✅ Direct 补充 `doNotFree` 边界 |

### 深审发现

1. **中风险：`ensureWritable` 状态 2 语义表述不准确。** 初稿写成“只表示扩容发生，是否满足请求还要另查”；接口合同明确状态 2 表示容量增加且 writable 空间已经足够。已改为“扩容后空间足够，继续写”。
2. **低风险：Direct deallocate 被写成必然释放。** 当前实现存在 `doNotFree` 分支，已补充“包装外部内存可能不负责释放”的边界。
3. **低风险：大纲原先把 CAS 细节归在 `AbstractReferenceCountedByteBuf`，已按当前源码改为 `RefCnt` 分层。**

## 第二轮：因果审

- ByteBuffer 单 position -> 多阶段处理需要 flip/compact -> 状态责任扩散 -> ByteBuf 双指针：✅
- 双指针 -> 读写独立推进，但已读空间仍占容量 -> discard/扩容取舍：✅
- writable 不足 -> maxCapacity 约束 -> ensureWritable 状态码交给上层决策：✅
- GC 不知道异步 ownership 完成时刻 -> retain/release -> 最后一次 release 才 deallocate：✅
- 引用计数更新原子化不等于内容访问线程安全：✅
- best-effort accessibility check 不等于生命周期同步：✅

未发现把设计推断冒充源码事实的高风险表述。

## 第三轮：结构审

正文按“ByteBuffer 模式冲突 -> 双指针 -> 空间回收 -> 容量边界 -> 资源寿命 -> 引用计数 -> 总图”组织，没有沿 Netty 类文件顺序展开。✅

失败方案包含单 position、clear、频繁 discard、只靠 GC、synchronized 引用计数、关闭可达性检查等，满足方法论要求。✅

## 第四轮：读者审

删掉代码块后，主线仍能复述：双指针管理数据进度，discard 管空间布局，ensureWritable 管增长边界，refCnt 管 ownership，deallocate 管多态释放。✅

主要路标均存在：双指针主线、discard 与扩容取舍、容量边界、资源寿命、总图。✅

## 第五轮：边界审

- 当前源码版本与实现边界已在开头声明。✅
- 未把 refCnt 原子更新写成 ByteBuf 全线程安全。✅
- 未把 `discardSomeReadBytes` 的当前阈值外推为接口规范。✅
- 未把 `clear()` 写成擦除内存。✅
- 已补充 Direct `doNotFree` 例外。✅
- 已说明关闭 accessibility check 只改变检查，不改变 ownership。✅

## 第六轮：依赖审

- Ch1 ByteBuffer、Ch2 Channel、Ch3 Selector 均为已完成前置。✅
- Ch4-02 allocator、Ch4-03 heap/direct、Ch4-04 views、Ch5 EventLoop 只作为导航，没有把后文结论当作本篇前提。✅
- 本篇不提前解释 Pipeline 内部实现，只把多阶段处理作为场景。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部已核对。✅
- 去掉代码块后正文仍成立。✅
- 总行数：539。
- 去码后字符数：约 12,100。
- 去码去空白后字符数：约 11,000。
- 符合重大机制篇篇幅要求。✅

## 结论

六轮 review 完成，深审发现 3 项并已修正。Ch4-01 可进入后续深度 review 或继续 Ch4-02。
