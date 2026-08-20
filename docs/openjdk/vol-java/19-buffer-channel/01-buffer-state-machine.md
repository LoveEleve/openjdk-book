# 01. Buffer 抽象与状态机 — mark/position/limit/capacity 与翻转

> 本文基于 JDK 11 `Buffer` 与各类 Buffer 共用状态机抽象。本文聚焦 `mark/position/limit/capacity`、`flip/clear/rewind/mark/reset`、`remaining/hasRemaining`，以及 `isDirect` 背后的堆内/堆外边界；ByteBuffer 家族与视图生成留到下一篇。本文讨论的是 JDK 11 `java.nio` Buffer 状态机，不把这里的游标规则、direct 语义和 shadow buffer 路径外推成所有缓冲抽象都必须遵守的统一规范。
> **前置依赖**：[03-object-system/01 — 对象生命周期](../03-object-system/01-object-contract-references.md)(对象内存布局与数组存储)、[18-serialization/01 — 序列化协议](../18-serialization/01-protocol-flow.md)(流式读写与状态推进的对照)
> **后续**：[19-buffer-channel/02 — ByteBuffer 家族与生成体系](02-bytebuffer-family.md)

## 为什么看起来只是一个数组,却要靠四个游标字段才能安全读写

很多人第一次学 `ByteBuffer` 时,都会把注意力放在 API 名字上: `flip()`、`clear()`、`rewind()`、`mark()`、`reset()`——看起来像一堆记忆题。可如果只背方法效果,很快就会在最基本的读写切换上出错: 明明刚把数据 put 进去,为什么 get 读不到?为什么 clear 之后旧数据看起来还在?为什么 rewind 和 flip 明明都把 position 设回 0,语义却完全不同?

真正的问题不在数组本身,而在于 **Buffer 从来不是“一个带方法的 byte[]”**,而是一套围绕 `mark/position/limit/capacity` 运行的状态机。底层数据通常不动,真正变化的是“下一次从哪读/写”“当前边界在哪”“还有多少可读/可写”。也正因为如此,Buffer 的核心不是存储,而是状态推进。

这篇就沿着这条主线来讲: 为什么四个字段本身就是全部抽象核心,为什么 `flip/clear/rewind` 都只是 O(1) 的状态切换,以及为什么同样的状态机在堆内和堆外两种存储位置上,又会导出两条完全不同的 I/O 成本路径。

## 1. "Buffer 的四个状态是什么？" — 字段与语义

### 1.1 四个游标字段

`Buffer`(`Buffer.java`)是抽象基类,核心只有四个 int 字段(`Buffer.java:198-201`):

```java
// Buffer.java:198-201(截取核心,逐字)
    private int mark = -1;
    private int position = 0;
    private int limit;
    private int capacity;
```

- **`capacity`**:固定容量——创建后不变
- **`limit`**:**可读写边界**——写模式下"最多能写到这里",读模式下"数据读到这里的下一个"
- **`position`**:当前读写位置——下一个要读/写的下标
- **`mark`**:书签——`reset()` 时回到这里;`-1` 表示未设置

### 1.2 不变量:0 ≤ mark ≤ position ≤ limit ≤ capacity

四个字段不是随便改的,构造时校验(`Buffer.java:218-232`):

```java
// Buffer.java:217-232(截取核心,逐字)
    Buffer(int mark, int pos, int lim, int cap) {       // package-private
        if (cap < 0)
            throw createCapacityException(cap);
        this.capacity = cap;
        limit(lim);
        position(pos);
        if (mark >= 0) {
            if (mark > pos)
                throw new IllegalArgumentException("mark > position: ("
                                                   + mark + " > " + pos + ")");
            this.mark = mark;
        }
    }
```

校验顺序: `capacity >= 0` → `limit(lim)` setter 校验(`limit <= capacity`)→ `position(pos)` setter 校验(`0 <= position <= limit`)→ `mark <= position`。四条约束拼起来就是 `0 <= mark <= position <= limit <= capacity`。

setter 也是同样的约束(`Buffer.java:291-299`):

```java
// Buffer.java:291-299(截取核心,逐字)
    public Buffer position(int newPosition) {
        if (newPosition > limit | newPosition < 0)
            throw createPositionException(newPosition);
        if (mark > newPosition) mark = -1;
        position = newPosition;
        return this;
    }
```

注意一个细节: **position 向后移会清掉 mark**(`mark > newPosition` 时 `mark = -1`)——书签指的位置已经"读过去了",没有保留意义。

关键设计(斜体):*Buffer 是"读写游标 + 边界"的状态机——position 是"我读到/写到哪了",limit 是"边界在哪",所有操作都是**改状态不改底层数据**。对比裸数组: 数组只有下标,游标和边界都要你自己管;Buffer 把"我该从哪读、读到哪为止"封装成了状态。面试画"四状态坐标图"(数轴 + 四个标记)是区分度——能画出 mark/position/limit/capacity 在写模式和读模式下的位置,这道题就过了。*

## 2. "flip/clear/rewind 区别？" — 三个翻转操作

### 2.1 flip:写→读(设置"已写边界")

`flip()`(`Buffer.java:449-454`):

```java
// Buffer.java:449-454(截取核心,逐字)
    public Buffer flip() {
        limit = position;
        position = 0;
        mark = -1;
        return this;
    }
```

写模式下: 写入了 N 个数据,`position` 停在 N。flip 做三件事: **`limit = position`**(把"已写边界"设为 N)、**`position = 0`**(回到起点)、**mark 清除**。之后读循环 `while (buffer.hasRemaining()) buffer.get()` 只会读到刚写入的 N 个数据——**limit 记录了"真实数据长度"**。

### 2.2 clear:读→写(重置全容量)

`clear()`(`Buffer.java:421-426`):

```java
// Buffer.java:421-426(截取核心,逐字)
    public Buffer clear() {
        position = 0;
        limit = capacity;
        mark = -1;
        return this;
    }
```

`position = 0`、`limit = capacity`、mark 清除——**完全重置游标,但不清数据**(Javadoc 明说 "does not actually erase the data",`Buffer.java:415-417`)。名字叫 clear 是因为"反正马上要覆盖了"。

### 2.3 rewind:重读(回到已写起点)

`rewind()`(`Buffer.java:471-475`):

```java
// Buffer.java:471-475(截取核心,逐字)
    public Buffer rewind() {
        position = 0;
        mark = -1;
        return this;
    }
```

**只动 position 和 mark,limit 不变**——数据还在,从头再读一遍。典型用法: 把同一段数据写给两个通道(写完 `rewind()` 再写第二个)。

### 2.4 mark/reset:书签

`mark()`(`Buffer.java:380-383`)把当前位置存进 mark;`reset()`(`Buffer.java:396-402`)把 position 拉回 mark(未设置抛 `InvalidMarkException`)。

三个操作对比:

| 操作 | position | limit | mark | 用途 |
|------|:--:|:--:|:--:|------|
| `flip()` | =0 | **=position** | -1 | 写→读(设置已写边界) |
| `clear()` | =0 | =capacity | -1 | 读→写(重置全容量) |
| `rewind()` | =0 | 不变 | -1 | 重读(回到已写起点) |

关键设计(斜体):*三个操作的本质: flip 设置"已写边界"、clear 恢复"全容量"、rewind 回到"已写起点"——都是 O(1) 的字段赋值,不动数据。面试手写读写循环 `while (buffer.hasRemaining()) buffer.get();` 是基本功;再问"flip 和 clear 什么时候用": 写→读 flip;读→写 clear;重读 rewind——三句口诀。*

## 3. "remaining/hasRemaining" — 剩余语义

### 3.1 两个查询

`remaining()`(`Buffer.java:483-486`)与 `hasRemaining()`(`Buffer.java:495-497`):

```java
// Buffer.java:483-497(截取核心,逐字)
    public final int remaining() {
        int rem = limit - position;
        return rem > 0 ? rem : 0;
    }

    /**
     * Tells whether there are any elements between the current position and
     * the limit.
     *
     * @return  {@code true} if, and only if, there is at least one element
     *          remaining in this buffer
     */
    public final boolean hasRemaining() {
        return position < limit;
    }
```

- **`remaining() = limit - position`**(负数时返回 0)
- **`hasRemaining() = position < limit`**

### 3.2 标准读循环

```java
// 用法示意(API 形式,非源码片段)
while (buffer.hasRemaining()) {
    byte b = buffer.get();
    // ...
}
```

生产上的标准模式——**协议帧解析**: 读完 header(长度字段)后 `flip()` 一次,然后用 remaining 知道 body 还有多少,循环读:

```java
// 用法示意(API 形式,非源码片段)
frame.flip();                       // 写→读
while (frame.hasRemaining()) {      // 按 limit-position 边界读
    // 读 body
}
frame.clear();                      // 读完→写,复用缓冲区
```

关键设计(斜体):*"剩余 = 边界 - 游标"是状态机的核心查询——它的准确性依赖 flip: 写模式下 limit=capacity,remaining 算的是"还能写多少";flip 后 limit=已写长度,remaining 才算准"还有多少数据可读"。面试"为什么 flip 后才知道读多少": 因为 position 记录了实际写入数,flip 把它变成 limit,读方不需要提前知道数据长度。*

## 4. "堆内 vs 堆外" — isDirect 语义

### 4.1 isDirect:抽象判定

`Buffer.java:580`:

```java
// Buffer.java:580(截取核心,逐字)
    public abstract boolean isDirect();
```

所有 Buffer 子类回答一个问题: **我的存储是堆内数组还是堆外原生内存?** 两个实现:

### 4.2 堆内(Heap-X-Buffer):byte[] 包装

堆内 Buffer 的存储是**普通数组**——模板(`Heap-X-Buffer.java.template`)里:

- 存储字段 `final $type$[] hb`(`X-Buffer.java.template:271` 声明,注释 "Non-null only for heap buffers")——普通 Java 数组,GC 管理
- `offset`(`Heap-X-Buffer.java.template:55`)——子缓冲区(slice/duplicate)相对数组起点的偏移
- `address` 指向数组基址(`Heap-X-Buffer.java.template:66` 的 `ARRAY_BASE_OFFSET`)——这是给 JNI 用的
- `isDirect` 返回 false(`Heap-X-Buffer.java.template`)

**堆内缓冲的 IO 问题**: GC 会移动对象(压缩/复制),数组地址不稳定——系统调用(read/write)需要**稳定地址**。所以堆内缓冲做 IO 时,IOUtil 会**临时分配一个堆外 shadow 缓冲,把数据拷过去再调用系统调用**(`IOUtil.java:158-171` 的 "allocate shadow buffer to ensure I/O is done with direct buffer")——这就是"堆内缓冲 IO 慢一步"的根源: 每次 IO 多一次堆内→堆外的拷贝。

### 4.3 堆外(Direct-X-Buffer):原生内存

堆外 Buffer 直接持有一段**不受 GC 管理的原生内存**(`Direct-X-Buffer.java.template`):

- 分配: `UNSAFE.allocateMemory`(域 32 的机制),地址存 `address` 字段
- 清理: `Cleaner`(`Direct-X-Buffer.java.template:96` 的 `private final Cleaner cleaner`)——对象被 GC 回收时,cleaner 回调 `Deallocator.run` 的 `UNSAFE.freeMemory`(`:85-90`)释放内存
- `isDirect` 返回 true

**为什么 Direct 快**: 系统调用直接读写这段稳定地址的内存,**免中间拷贝**;堆内缓冲做 IO 时要先拷进堆外/固定位置。但堆外内存不受 GC 管理,申请了忘释放就是泄漏(域 32 会单独讲 Cleaner 机制)。

关键设计(斜体):*"直接缓冲区"直接持有本机地址——系统调用零拷贝的前提;堆内缓冲 IO 时必然经历"拷贝或固定"。面试"为什么 Direct 快": 少一次拷贝(堆内→堆外临时缓冲);再问"Direct 的坑": 堆外内存泄漏(Cleaner 回收时机不可控,域 32)。生产: 大 IO/网络高频用 Direct,小数据堆内足够。*

跨层标注: [内部卷: 01-os——read/write 系统调用需要稳定地址,这是"堆内缓冲 IO 慢"的根源;域 32 Unsafe——allocateMemory/freeMemory 与 Cleaner 的完整机制]

## 五、五个最容易混掉的边界：Buffer 不是数组包装，flip 不只是归零，clear 不擦数据，remaining 不脱离模式，Direct 也不是无脑更快

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，Buffer 不是“多几个便捷方法的数组”。它真正值钱的不是底层存储本身，而是那四个游标字段把“下一次从哪读/写、当前边界在哪、还有多少可操作空间”都封进了状态机里。离开这套状态去看数组内容，很多 API 就会全部失去语义。

第二，`flip()` 也不只是把 `position` 设回 0。更关键的动作是把“刚才写到了哪”改写成“现在读到哪为止”，也就是 `limit = oldPosition`。少了这一步，读方根本不知道有效数据到底只占了前多少字节。

第三，`clear()` 更不是擦除底层数据。它做的只是把写模式重新开放到全容量：`position = 0`、`limit = capacity`。旧字节往往还躺在那儿，只是状态机告诉你“这些旧内容已经不再是当前有效边界的一部分”。

第四，`remaining()` 也不能脱离当前模式去理解。写模式下，它表达的是还能写多少；flip 进入读模式后，它才表达还有多少已写数据可读。同一个公式 `limit - position`，意义会随状态切换而改变。

第五，DirectBuffer 也不是无脑更快。它真正占优的是高频 I/O 场景里少一次堆内到堆外的过渡拷贝，并给系统调用提供稳定地址；如果数据很小、生命周期很短、管理成本更敏感，堆内缓冲一样可能更合适。

把这五条边界记稳，Buffer 这一篇就不会重新塌回“flip/clear/rewind 的记忆题”这种表面印象。它真正讲的是一套读写边界状态机，以及这套状态机在堆内和堆外两种存储位置上怎样分裂出不同的 I/O 成本路径。

## 收网：Buffer 的核心不是数组，而是四个游标字段驱动的读写状态机

回到开头那个最常见的误会，现在已经能看清为什么 `ByteBuffer` 最难的从来不是底层数组，而是状态机。真正决定你接下来读到什么、还能写多少、什么时候该切换模式的，不是数组内容本身，而是 `mark/position/limit/capacity` 这四个字段怎样共同划定边界。

这也把整篇的主线压回来了：

- 四个游标字段定义当前模式和边界；
- `flip/clear/rewind/mark/reset` 都只是 O(1) 的状态切换，不负责搬动底层数据；
- `remaining/hasRemaining` 只是对当前边界的读取，因此必须放在读模式/写模式里理解；
- `isDirect` 则在同一套状态机外，再把底层存储切成堆内与堆外两条 I/O 成本路径。

把整篇压成一张总图，就是：

```text
Buffer
  → 不是数组本身
  → 是 mark/position/limit/capacity 组成的状态机

状态切换
  → flip：写边界变读边界
  → clear：恢复全容量写模式
  → rewind：回到已写起点重读

存储位置
  → heap：数组好管理，但 I/O 常多一层过渡拷贝
  → direct：地址稳定，更利于高频 I/O
```

如果说这一篇解决的是“为什么 Buffer 必须先被当成状态机来理解”，下一篇就会继续往具体家族展开：`ByteBuffer`、视图 buffer、`wrap/slice/duplicate` 和字节序，到底怎样在同一套模板和共享存储思想上长出来。
