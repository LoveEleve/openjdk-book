# Ch4-03 Heap vs Direct — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| Heap 字段与两种构造状态 | `UnpooledHeapByteBuf.java:38-42`、`:50-82` | ✅ |
| Heap 新数组与 freeArray | `UnpooledHeapByteBuf.java:84-90` | ✅ |
| Heap capacity 复制/替换 | `UnpooledHeapByteBuf.java:113-138` | ✅ |
| Heap 普通访问 | `UnpooledHeapByteBuf.java:320-334` | ✅ |
| Heap array/address 能力 | `UnpooledHeapByteBuf.java:141-163` | ✅ |
| Heap 多字节 VarHandle 回退 | `HeapByteBufUtil.java:25-33`、`:59-64` | ✅ |
| Direct 字段与新建路径 | `UnpooledDirectByteBuf.java:39-71` | ✅ |
| 外部 Direct 包装与 doNotFree | `UnpooledDirectByteBuf.java:78-104` | ✅ |
| Direct 替换、tryFree 与容量 | `UnpooledDirectByteBuf.java:124-153`、`:178-203` | ✅ |
| Direct 普通 get/put 与 VarHandle 条件路径 | `UnpooledDirectByteBuf.java:257-266`、`:323-341`、`:357-369`、`:449-480`、`:527-549` | ✅ |
| Unsafe Heap 分配与访问 | `UnpooledUnsafeHeapByteBuf.java:37-51` | ✅ |
| Unsafe Direct address 缓存与边界检查 | `UnpooledUnsafeDirectByteBuf.java:32-36`、`:94-140`、`:167-207` | ✅ |
| Java 9 duplicate/slice 清理边界 | `UnpooledUnsafeDirectByteBuf.java:58-68` | ✅ |
| no-cleaner 重分配路径 | `UnpooledUnsafeNoCleanerDirectByteBuf.java:23-54` | ✅ |
| Heap/Direct/Pool 释放差异 | `UnpooledHeapByteBuf.java:548-551`、`UnpooledDirectByteBuf.java:781-797`、`PooledByteBuf.java:174-185` | ✅ |
| Heap 源跨类型拷贝分发 | `UnpooledHeapByteBuf.java:167-183` | ✅ |
| Direct 源跨类型拷贝分发 | `UnpooledDirectByteBuf.java:373-391` | ✅ |
| Unsafe Direct copyMemory 分发 | `UnsafeByteBufUtil.java:513-577` | ✅ |

未发现无效行号或引用文件错误。

## 第二轮：因果审

- I/O/Java 处理场景同时存在 -> Heap/Direct 选择影响存储与交接路径：✅
- Heap byte[] -> 数组访问与 GC 责任简单：✅
- Direct native memory -> address/NIO 交接能力增加，同时引入清理与 ownership 边界：✅
- 扩容需要新存储并复制 -> Heap arraycopy / Direct ByteBuffer put / no-cleaner reallocate：✅
- 能力检测 -> array/address/NIO 多路拷贝 -> 避免统一逐字节回退：✅
- Unsafe 访问提速 -> 公开入口先检查、底层工具假定边界已证实：✅

“Direct 适合特定 I/O 路径”被写成场景判断，没有写成无条件性能事实。✅

## 第三轮：结构审

正文按“存储选择问题 -> Heap 基线 -> Direct 复杂性 -> Unsafe/VarHandle -> 扩容释放 -> 跨类型拷贝 -> 误解澄清”展开，符合理解路径，没有按源码文件顺序堆叠。✅

四条主线（存储、访问、I/O 交接、生命周期）在开头提出，并在 Heap/Direct 对比与收网中回收。✅

## 第四轮：读者审

删掉代码块后仍能复述：Heap 是 byte[] 基线，Direct 是带清理/ownership 的 native 存储，Unsafe/VarHandle 是条件访问变体，跨类型复制先检测能力再选批量或回退路径。✅

关键误解均有单独澄清：Direct 必快、copyMemory 是零拷贝、Unsafe 没有安全边界、外部 Direct 必须由包装对象释放、no-cleaner 不用 release。✅

## 第五轮：边界审

- 未给出未经 benchmark 支撑的 ns/倍数性能数字。✅
- 明确 Direct 不是所有 Java 访问自动更快。✅
- 明确 `copyMemory` 是数据复制，不是共享视图。✅
- 明确 VarHandle/Unsafe 分支受运行环境能力影响。✅
- 明确 `doNotFree` 是 ownership 边界，不代表外部资源永不释放。✅
- 明确池化释放只做对照，不提前展开 Arena。✅
- 未把公开 API 的边界检查与底层 `_get/_set` 的假设混为一谈。✅

## 第六轮：依赖审

- Ch4-01 的索引、容量、deallocate、ensureAccessible 已完成并被正确复用。✅
- Ch4-02 的 allocator 选择和 Unpooled/Pooled 策略已完成并被正确复用。✅
- Ch4-04 视图、Ch4-05 Composite、Ch8 池化只做导航。✅
- 没有把视图引用计数或 Composite 内部行为提前写成已讲事实。✅

## 机械检查

- 禁用词：未发现。✅
- 源码行号：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 414。
- 去码后字符数：约 11,000。
- 去码去空白后字符数：约 9,950。
- 符合重大机制篇篇幅要求。✅

## 结论

Ch4-03 六轮 review 完成，无需修订。可进入 Ch4-04 视图与零拷贝。
