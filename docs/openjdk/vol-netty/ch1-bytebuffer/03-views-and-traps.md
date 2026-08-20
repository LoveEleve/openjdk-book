# ByteBuffer 的视图与陷阱：共享数据，独立状态

> 本文基于 JDK 11 NIO `ByteBuffer`。前置：Ch1-01 的四字段状态机、Ch1-02 的 Heap/Direct 分配路径。本文讲视图、字节序和比较语义，不展开 Channel 和 Netty ByteBuf 的具体实现。

## 一段数据，为什么要切成几个 Buffer

一条网络消息可能同时包含多个逻辑区域：前几个字节是长度，中间是请求 ID，后面是业务 payload。调用方希望把这些区域交给不同处理器，却不想为每个区域复制一份字节。

最直接的方案是复制：每个处理器拿一份独立数组，边界清楚，互不影响。但复制会增加内存和 CPU 成本，多个视图之间还要考虑谁是最新数据。

NIO 提供了另一种选择：**复制状态，不复制底层数据**。

```text
原始 Buffer ──共享底层存储──┬── slice 视图
                           ├── duplicate 视图
                           └── read-only 视图

每个视图独立维护：position / limit / mark
所有视图共同引用：底层 byte[] 或 native memory
```

这条设计的收益是零额外数据复制，代价是所有权、生命周期和游标状态都变得更复杂。

## 一、slice：从当前位置切出一段新视图

`slice()` 适合表达“从当前可读区间开始，切出一个相对独立的窗口”。它创建一个新的 Buffer 状态，但底层仍引用原来的存储。

对于 HeapBuffer，可以把它理解成：

```text
原数组:       [ ... ][从 position 开始的区域................]
原 Buffer:                   position ... limit
slice:                       offset=原 position, position=0
```

slice 视图的初始状态通常是：

- 新 position = 0
- 新 limit = 原 Buffer 的 remaining
- 新 capacity = 原 Buffer 的 remaining
- 新 offset = 原 Buffer 的 position 对应的底层偏移

所以原 Buffer 的 position 是 88 时，`slice.get(0)` 实际读取的是原存储中从 88 开始的位置。两个对象的游标独立移动，但写入同一底层存储的结果对彼此可见。

这解决了“切分而不复制”的问题，却带来一个生命周期事实：只要 slice 仍然持有底层存储引用，原来那个 Buffer 对象即使不可达，底层数据也不会因为原对象消失就马上消失。视图延长了数据的有效生命周期。

## 二、duplicate：复制状态，不限制范围

`duplicate()` 与 slice 的共同点是共享底层存储，区别是它复制的是原 Buffer 的完整视图状态：

- position 复制当前 position
- limit 复制当前 limit
- mark 复制当前 mark
- capacity 与原 Buffer 对应
- 底层 offset 保持同一存储关系

```text
原 Buffer:       position=p, limit=l, mark=m
                    │ duplicate()
                    ▼
duplicate Buffer: position=p, limit=l, mark=m
                  但之后两个 position 可独立移动
```

duplicate 适合两个处理器从同一段完整可见范围出发、各自维护读取进度。它不是 copy：一个视图写入底层字节，另一个视图读取时仍然会看到修改。

slice 和 duplicate 的区别可以压缩成一句话：

```text
slice     = 从当前位置开始建立一个新的相对窗口
duplicate = 保留当前完整视图边界，复制一份独立游标状态
```

## 三、asReadOnlyBuffer：共享数据，但切断写入口

只读视图解决的是另一个问题：多个组件可以共享一份数据，但其中某个组件不应该拥有修改权限。

`asReadOnlyBuffer()` 返回一个 read-only Buffer 视图。它仍然引用同一底层数据，读操作与普通视图一样；但所有写操作会抛出 `ReadOnlyBufferException`。

这不是复制一份“只读数组”，而是把写权限限制放在视图 API 上：

```text
同一底层数据
   ├── 可写视图：可以 put
   └── 只读视图：读得到，put 被拒绝
```

因此只读视图并不提供并发安全。它只保证通过这个视图暴露的写接口被禁止；如果另一个可写视图同时修改底层存储，只读视图看到的数据仍可能变化。

这正是共享存储设计的边界：权限隔离和线程同步是两件事。Heap/Direct view 的构造与只读分支分别位于 `Heap-X-Buffer.java.template:104-145`、`Heap-X-Buffer.java.template:130-160` 和 `X-Buffer.java.template:601-630`。

## 四、hasArray/array：为什么测试通过，生产却崩

许多旧代码习惯把 Buffer 转成 `byte[]` 批量处理：

```java
byte[] bytes = buffer.array();
```

但 Buffer 的静态类型是 `ByteBuffer`，并不能保证它一定有可暴露的 Java 数组。HeapBuffer 通常有数组，DirectBuffer 没有；只读视图也可能禁止暴露可写数组。

正确的防守顺序是先问能力：

```java
if (buffer.hasArray()) {
    byte[] array = buffer.array();
    // 还要结合 arrayOffset / position / limit 计算有效范围
} else {
    // 使用 Buffer API，或走专门的 direct 访问路径
}
```

这里还有一个容易漏掉的边界：即使 `hasArray()` 返回 true，`array()` 返回的也是整个底层数组，不等于当前 Buffer 的有效区间。调用方还要考虑：

- `arrayOffset()`
- 当前 position
- 当前 limit
- slice 是否改变了视图起点

因此 `array()` 暴露的是存储能力，不是“当前可读数据的精确切片”。

这也是为什么同一段代码用 `allocate()` 测试通过，换成 `allocateDirect()` 后可能在生产环境失败：分配入口的返回类型相同，但底层能力不同。

## 五、equals/compareTo：比较的不是整个 Buffer

`ByteBuffer.equals()` 的语义是比较两个 Buffer 当前 remaining 区间里的字节，而不是比较全部 capacity、全部 limit 或底层数组。

假设：

```text
buffer1: position=0, limit=50
buffer2: position=10, limit=60
```

只要两者 remaining 都是 50，并且各自 `[position, limit)` 区间的字节完全相同，equals 就可能返回 true，即使它们的 position、limit、capacity 和底层起点完全不同。

`compareTo()` 也在 remaining 区间内做字典序比较：先比较对应字节，前缀相同时，remaining 更短的一方更小。

这套语义和上一篇的状态机是一致的：Buffer 当前“可消费的内容”就是 remaining，而不是它曾经写过的全部内容。

但它会制造一个常见陷阱：同一底层数据在 flip 前后，position/limit 发生变化，remaining 区间也随之变化；读取过一部分之后再比较，比较对象已经不是原来的全部有效数据。

如果业务要比较全部存储内容，不能直接依赖 equals；应该明确比较哪个区间，或先复制/重置到确定状态。

## 六、order：多字节解释规则也属于视图状态

一个字节序列本身没有“整数值”，只有在解释规则确定后才有值。`ByteBuffer` 的 byte order 影响 `getInt/getLong/getDouble` 和对应 put 操作：

```text
01 02 03 04

BIG_ENDIAN    -> 0x01020304
LITTLE_ENDIAN -> 0x04030201
```

`order(ByteOrder)` 改变的是后续多字节操作的解释规则，不会把底层已有字节重新排列。写入和读取必须使用一致的 order，否则读出来的数值会改变。

这同样是共享视图的风险：如果一个处理器改变了 Buffer 的 order，后续共用这个 Buffer 的处理器就会受到影响。数据没有变化，解释状态变了，结果仍然会变。

更稳妥的做法是：

- 在 Buffer 所有权交接处明确 order
- 不让多个不相关处理器隐式共享可变 order 状态
- 需要不同解释规则时，使用独立视图或明确设置后再读取

Netty ByteBuf 后续提供了 `getIntLE` 等显式字节序方法，把一部分解释选择从对象可变状态移动到方法名上；这是 API 设计上的另一种权衡，后文只做对照。

## 七、bulk get/put：批量不等于 absolute

`get(byte[], offset, length)` 和 `put(byte[], offset, length)` 是批量相对操作：先整体检查边界，再批量读写，同时推进 Buffer 的 position。

它们与循环调用单字节 get/put 的语义相同，但把边界检查和复制路径集中到一次调用中。HeapBuffer 之间的 put 还可以使用数组批量复制路径，避免逐字节处理。

这里不能把 bulk API 误认为 absolute API：

```text
bulk get/put + offset 参数
    = 底层数组的源/目标偏移
    ≠ Buffer position 不变化
```

如果调用方需要“从固定位置读一段但不改变 position”，应该使用绝对访问或 duplicate 视图，而不是把 bulk API 的 offset 当成 Buffer 状态偏移。

## 八、mark/reset：只有一层临时快照

`mark()` 保存当前 position，`reset()` 恢复到 mark。它适合“读一小段再决定是否回退”，但不提供多层嵌套事务：同一个 Buffer 只有一个 mark。

```text
position=10
  -> mark()       mark=10
  -> getInt()     position=14
  -> reset()      position=10
```

如果在 position=14 时再次 mark，旧 mark 会被覆盖。调用方不能把 mark/reset 当成任意深度的 undo 栈。

这和 slice/duplicate 的关系也值得注意：每个视图都有自己的 mark/position/limit 状态，但它们共享底层数据。因此可以拥有独立的回退位置，却不能获得独立的数据副本。

## 收网：共享存储把性能问题变成所有权问题

现在回看开篇困惑：为什么一个“看起来独立”的 Buffer 修改后会影响另一个？因为视图复制的是状态，不是存储。

- slice 创建相对窗口
- duplicate 复制完整游标状态
- read-only view 切断写入口，但不提供并发同步
- hasArray/array 暴露的是存储能力，不保证有效区间
- equals/compareTo 比较 remaining，不比较全部容量
- order 改变多字节解释规则，不重排已有字节
- bulk get/put 是推进 position 的批量相对操作
- mark/reset 只有一层状态快照

NIO 的这些设计为零拷贝和低分配提供了基础，但也把所有权、游标、字节序和线程安全责任交给调用方。下一章进入 Channel：Buffer 里有了数据，谁来把它送到网络，partial read/write 又如何让这套状态机继续运转？更后面的 Netty ByteBuf，则会重新处理这里暴露出的双指针、视图生命周期和引用释放问题。
