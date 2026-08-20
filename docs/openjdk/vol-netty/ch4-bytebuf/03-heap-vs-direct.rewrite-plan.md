# Ch4-03 Heap vs Direct — rewrite-plan

## 篇章定位

- 核心困惑：Allocator 已经能选择 heap/direct，但这两个 ByteBuf 到底差在哪里？为什么 Heap 更容易处理，Direct 却更适合某些 I/O 路径？
- 一句话顿悟：Heap 与 Direct 的差别不是“一个快、一个慢”，而是底层存储、Java 访问、Native I/O 互操作、扩容复制和释放责任不同；Netty 再在两者之上提供 Unsafe/VarHandle/安全回退路径。
- 篇章边界：讲 Unpooled Heap/Direct 的代表实现、Unsafe 变体、扩容/释放、跨类型拷贝；不深入 allocator 选择、Pooled Arena、派生视图、Composite 组件算法。

## 依赖

### HARD

- Ch4-01：ByteBuf 双指针、capacity/maxCapacity、deallocate/ensureAccessible。
- Ch4-02：Allocator 的意图分发、Unpooled/Pooled 策略、LeakAware 返回边界。
- Ch1-02：Java heap/direct 与 Cleaner 的基本背景。
- Ch2/Ch3：Channel/Selector 的 I/O 场景。

### SOFT

- JNI/Native I/O：正文提供“heap 可能需要中间拷贝、direct 可暴露地址”的最小解释，不展开 JNI ABI。
- Unsafe/VarHandle：正文只解释访问路径与检查边界，不展开 JVM 内部实现。

### NAV

- Ch4-04：slice/duplicate/retainedSlice 如何复用底层存储和引用计数。
- Ch4-05：Composite/多组件拷贝和 consolidate。
- Ch8：Pooled Heap/Direct 的 Arena、Chunk、Subpage、ThreadCache。

## 素材事实卡片

### 卡片 A：Heap 存储与初始化

- `UnpooledHeapByteBuf.java:38-42`：`byte[] array` 与 allocator、临时 NIO view。
- `UnpooledHeapByteBuf.java:50-61`：新数组构造后 `setIndex(0,0)`。
- `UnpooledHeapByteBuf.java:69-82`：包裹既有数组后 `setIndex(0,array.length)`，整段数组成为 readable。
- `UnpooledHeapByteBuf.java:84-90`：默认 `new byte[]`，`freeArray` NOOP。
- `UnpooledHeapByteBuf.java:113-138`：capacity 扩容/缩容分配新数组、复制、替换、释放旧数组。
- `UnpooledHeapByteBuf.java:141-163`：hasArray true、memoryAddress 不支持。
- `UnpooledHeapByteBuf.java:320-334`：安全 Heap 的 `_getByte` 走 HeapByteBufUtil。
- `UnpooledUnsafeHeapByteBuf.java:37-51`：Unsafe Heap 可用 `allocateUninitializedArray` 和 UnsafeByteBufUtil；访问前仍 checkIndex。
- `HeapByteBufUtil.java:25-33`、`:59-64`：多字节访问在 VarHandle 可用时走 VarHandle，否则显式组合字节。

### 卡片 B：Direct 存储、包装与 capacity

- `UnpooledDirectByteBuf.java:39-47`：ByteBuffer/cleanable/capacity/doNotFree 字段。
- `UnpooledDirectByteBuf.java:55-71`：新 direct 分配路径。
- `UnpooledDirectByteBuf.java:78-104`：包装外部 direct ByteBuffer，默认不负责释放并按 remaining 初始化 writerIndex。
- `UnpooledDirectByteBuf.java:124-153`：allocateDirect、替换 ByteBuffer、tryFree 与 doNotFree。
- `UnpooledDirectByteBuf.java:178-203`：扩容/缩容分配新 direct buffer，调整 position/limit 后 `put` 复制，替换并清理旧资源。
- `UnpooledDirectByteBuf.java:257-266`：基础 byte 访问走 ByteBuffer absolute get。
- `UnpooledDirectByteBuf.java:323-341`、`:357-369`：VarHandle 可用时多字节访问加速，否则 ByteBuffer get + swap。
- `UnpooledDirectByteBuf.java:449-480`、`:527-549`：写入路径对应 VarHandle/ByteBuffer put。
- `UnpooledUnsafeDirectByteBuf.java:32-36`、`:94-104`：memoryAddress 缓存与更新。
- `UnpooledUnsafeDirectByteBuf.java:117-140`、`:167-207`：安全 checkIndex 后 Unsafe 地址访问；多字节也有 VarHandle 条件路径。
- `UnpooledUnsafeNoCleanerDirectByteBuf.java:23-54`：no-cleaner 变体可重分配 direct 资源，不走普通 freeDirect。

### 卡片 C：释放责任

- `UnpooledHeapByteBuf.java:548-551`：释放时 freeArray 后替换为空数组；freeArray 默认 NOOP。
- `UnpooledDirectByteBuf.java:781-797`：释放 cleanable 或 freeDirect，受 doNotFree/cleanable 影响。
- `PooledByteBuf.java:174-185`：池化资源归还 arena 并 recycle；本篇仅作边界对照。
- `UnpooledUnsafeDirectByteBuf.java:58-68`：外部 ByteBuffer 包装默认 doFree=false，源码解释 Java 9 Unsafe.invokeCleaner 对 duplicate/slice 的限制。

### 卡片 D：跨类型拷贝

- `UnpooledHeapByteBuf.java:167-175`：目标有 memoryAddress + Unsafe → copyMemory；目标有 array → 数组路径；否则 dst.setBytes 回退。
- `UnpooledHeapByteBuf.java:180-183`：Heap 到 byte[] 使用 System.arraycopy。
- `UnpooledDirectByteBuf.java:373-391`：目标有 array、AbstractByteBuf 的 NIO buffer、多个 NIO buffers、最终 setBytes 的分发。
- `UnsafeByteBufUtil.java:513-577`：Unsafe Direct 目标/源在有 address 或 array 时 copyMemory，否则回退到 ByteBuf API。
- 不把所有路径都总结成“必然零拷贝”；`copyMemory` 本身仍然是数据复制，只是避免中间对象/通用逐字节路径。

## 理解路径

1. **从 I/O 现场切入**：同一份数据在 Java 业务处理和 native Socket I/O 之间往返，存储位置会影响互操作路径。
2. **先讲 Heap**：byte[]、初始化索引、array 能力、扩容复制、GC/无显式释放；建立容易理解的基线。
3. **再讲 Direct**：ByteBuffer + native address + doNotFree；说明它为何适合特定 I/O 交接，但分配和释放责任更复杂。
4. **处理“Direct 访问一定更快”的误解**：普通 Direct 实现仍走 ByteBuffer absolute get/put，多字节操作在 VarHandle 可用时才走另一条路径。
5. **引出 Unsafe 变体**：Unsafe Heap/Direct 用不同方式访问数据，前置 checkIndex/ensureAccessible 不能被绕过；不把性能数字写死。
6. **讲扩容与生命周期**：Heap 分配新数组 + arraycopy；Direct 分配新 direct buffer + position/limit + put；包装外部 Direct 时不拥有释放权。
7. **讲跨类型拷贝**：根据 array/address/抽象能力多路分发，区分“直接内存复制”与“零拷贝视图”。
8. **收网**：Heap/Direct 是资源与路径选择，不是统一快慢排名；视图篇承接共享存储与生命周期。

## 失败方案推演

- 所有 ByteBuf 都用 Heap：Java 业务方便，但特定 native I/O 路径可能需要额外中间拷贝。
- 所有 ByteBuf 都用 Direct：分配、释放、调试和小对象管理成本上升；Direct 并非所有访问路径自动更快。
- 直接暴露 Unsafe 地址，不做 checkIndex/ensureAccessible：错误索引和已释放访问可能绕过正常异常边界。
- 包装外部 direct ByteBuffer 后仍然释放底层内存：可能释放不属于当前 ByteBuf 的资源，或触发 Java 9+ duplicate/slice 清理限制。
- 跨 buffer 拷贝统一逐字节：正确但浪费可利用的 array/address/NIO 批量路径。

## 文章结构与预算

1. 存储位置为什么会影响 ByteBuf 行为（1000-1300 字）
2. Heap：数组基线与 GC 责任（1900-2300 字）
3. Direct：ByteBuffer、地址与释放边界（2200-2700 字）
4. 普通访问与 Unsafe/VarHandle 变体（1800-2300 字）
5. 扩容和生命周期对照（1300-1700 字）
6. Heap/Direct 跨类型拷贝路径（1500-1900 字）
7. 误解澄清与视图篇桥接（1000-1300 字）

目标：删掉代码后的叙述性正文 9000-10500 字。

## 证据清单

- `UnpooledHeapByteBuf.java:38-90`
- `UnpooledHeapByteBuf.java:113-175`
- `UnpooledHeapByteBuf.java:320-334`
- `UnpooledHeapByteBuf.java:548-551`
- `UnpooledUnsafeHeapByteBuf.java:37-51`
- `HeapByteBufUtil.java:25-33`
- `HeapByteBufUtil.java:59-64`
- `UnpooledDirectByteBuf.java:39-47`
- `UnpooledDirectByteBuf.java:55-104`
- `UnpooledDirectByteBuf.java:124-153`
- `UnpooledDirectByteBuf.java:178-203`
- `UnpooledDirectByteBuf.java:257-266`
- `UnpooledDirectByteBuf.java:323-341`
- `UnpooledDirectByteBuf.java:781-797`
- `UnpooledUnsafeDirectByteBuf.java:32-36`
- `UnpooledUnsafeDirectByteBuf.java:58-68`
- `UnpooledUnsafeDirectByteBuf.java:94-140`
- `UnpooledUnsafeNoCleanerDirectByteBuf.java:23-54`
- `UnsafeByteBufUtil.java:513-577`
- `PooledByteBuf.java:174-185`

## 边界清单

- 基于当前 Netty 源码；Unpooled 类的字段/实现细节不外推到所有 Pooled、平台 native transport 或旧版本。
- “Direct 适合 I/O”是路径和平台相关的工程判断，不是所有场景的性能保证。
- Heap 到 Direct 的 `copyMemory` 仍然复制数据；真正的零拷贝视图是另一类机制，留 Ch4-04。
- Unsafe 变体依赖前置边界检查；不能用 `_getByte` 内部是否检查来推断公开 API 没有检查。
- `doNotFree` 表示当前 ByteBuf 不拥有外部 direct buffer 的释放责任，不表示外部内存永远不会释放。
- VarHandle/Unsafe 分支受运行环境能力开关影响，不把某条路径写成所有机器必走。
- 不给出未经 benchmark 支撑的“快多少倍/多少 ns”数字。

## 深审预警

- [ ] 不把 Heap 默认最优、Direct 永远零拷贝或 Unsafe 永远更快写成绝对结论。
- [ ] 明确 Direct 普通实现仍使用 ByteBuffer get/put，VarHandle 只在条件满足时参与多字节访问。
- [ ] 明确 `copyMemory` 是复制，不是共享视图。
- [ ] 明确扩容必须重新分配并复制，Direct 还要处理旧资源清理。
- [ ] `doNotFree` 与 Java 9 duplicate/slice 限制需要有源码证据。
- [ ] 访问边界检查与 Unsafe 底层访问分层说明。
- [ ] 删码后仍能复述 Heap/Direct 选择与跨类型拷贝主线。
