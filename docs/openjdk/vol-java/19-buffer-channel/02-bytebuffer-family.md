# 02. ByteBuffer 家族与生成体系 — 模板、wrap、视图、字节序

> 本文基于 JDK 11 `ByteBuffer` 及其生成出来的 Heap/Direct/AsXBuffer 视图类。本文聚焦模板生成体系、`allocate/allocateDirect/wrap`、字节序、视图（slice/duplicate/asXBuffer）与共享底层语义；FileChannel 与 mmap 放到下一篇。本文讨论的是 JDK 11 `java.nio` Buffer 家族生成与视图体系，不把这里的模板工程、共享底层语义和字节序视角外推成所有缓冲抽象都必须遵守的统一规范。
> **前置依赖**：[19-buffer-channel/01 — Buffer 抽象与状态机](01-buffer-state-machine.md)(四状态字段与翻转)
> **后续**：[19-buffer-channel/03 — FileChannel 与 mmap 零拷贝](03-filechannel-mmap.md)

## 为什么看起来像七套几乎一样的类,却还能共享同一套底层逻辑

`ByteBuffer`、`CharBuffer`、`ShortBuffer`、`IntBuffer`、`LongBuffer`、`FloatBuffer`、`DoubleBuffer`——第一次看到这七个近亲时,很多人都会自然追问: 它们的方法几乎一模一样,区别看起来只在元素类型,那 JDK 难道真的手写维护了七份几乎重复的实现?如果答案只是“模板生成”,那还只解释了工程手法,没有解释后面更关键的问题: `wrap` 为什么不复制? `slice`/`duplicate` 为什么明明是新对象却共享数据? `order(ByteOrder)` 改的到底是字节,还是解释方式?

真正值得抓住的不是类名有多少,而是 **ByteBuffer 家族一直在坚持同一个原则: 尽量共享底层存储,只改变观察和访问这段存储的方式**。模板生成解决的是“逻辑近同代码怎么统一维护”;视图、字节序和 direct/heap 则是在回答“同一块底层内存怎样被不同 API 视角重新解释”。

所以这一篇的主线不是把类谱系再背一遍,而是围绕三件事展开: 为什么七种 Buffer 能从一套模板长出来,为什么 wrap/slice/duplicate/asXBuffer 都更像视图而不是复制,以及为什么同样的状态机落在堆内与堆外后,会导出两条不同的 I/O 成本路径。

## 1. "七种 Buffer 从哪来？" — 模板生成体系

### 1.1 一份模板,七份产出

打开 `java/nio` 目录,找不到 `ByteBuffer.java` 的实现——只有模板文件:

```
X-Buffer.java.template            // 抽象基类模板($type$ 占位)
Heap-X-Buffer.java.template       // 堆内实现模板
Direct-X-Buffer.java.template     // 堆外实现模板
ByteBufferAs-X-Buffer.java.template  // 视图实现模板
```

模板里用 `$type$`/`$Type$` 做类型占位(`X-Buffer.java.template:271` 的存储字段):

```java
// X-Buffer.java.template:271(截取核心,逐字)
    final $type$[] hb;                  // Non-null only for heap buffers
```

构建期 GensrcBuffer(`make/gensrc/GensrcBuffer.gmk` 的 `SetupGenBuffer` 宏,`:182`)把模板展开成七个类: `$type$` 分别代入 byte/char/short/int/long/float/double,视图类再叠加 `BO:=B/L`(大小端)、`RW:=R`(只读)变体(`:350-354` 的 ByteBufferAsCharBufferB 等调用)。**这是 JDK 对付"七份近同代码"的工程手法**——一份模板、一处维护,避免手写七份复制。所以面试问"ByteBuffer 的源码在哪": 在模板里,构建期生成。

### 1.2 类层次:抽象 + 两实现

生成后的层次是:

```
Buffer(抽象基类,域 19 第 1 篇)
  └── ByteBuffer(抽象)
        ├── HeapByteBuffer        ← Heap-X-Buffer.java.template 生成
        └── DirectByteBuffer      ← Direct-X-Buffer.java.template 生成
```

`ByteBuffer` 本身是抽象类(模板的 `X-Buffer.java.template` 基类部分),`allocate` 返回 `HeapByteBuffer`、`allocateDirect` 返回 `DirectByteBuffer`——具体类型对调用方透明。

关键设计(斜体):*"模板生成"是 JDK 对付"七份近同类"的工程手法——一份模板多份产出,避免手写七份复制代码;类型占位符($type$)把"元素类型不同、逻辑相同"的部分参数化。面试"为什么源码找不到 ByteBuffer 的实现": 模板生成,构建期 GensrcBuffer 展开。*

## 2. "wrap 与创建" — 数组包装

### 2.1 wrap:包装现有数组,零拷贝

`wrap(byte[], offset, length)`(`X-Buffer.java.template:389`)把已有数组包成 Buffer:

```java
// X-Buffer.java.template:389-398(截取核心,逐字)
    public static $Type$Buffer wrap($type$[] array,
                                    int offset, int length)
    {
        try {
            return new Heap$Type$Buffer(array, offset, length);
        } catch (IllegalArgumentException x) {
            throw new IndexOutOfBoundsException();
        }
    }
```

直接 `new HeapByteBuffer(array, offset, length)`——**不复制数组,共享底层存储**(模板 Javadoc 原话 "modifications to the buffer will cause the array to be modified and vice versa",`:403-404`)。容量 = array.length,limit = length,position = 0——**offset 不是 limit 的偏移,是子数组的起点**(wrap 的典型用途: 数组的一段当 Buffer 用)。内部实现: offset 存进 `HeapByteBuffer.offset` 字段(`Heap-X-Buffer.java.template:55`),所有下标访问经 `ix(i)` 换算(`Heap-X-Buffer.java.template:154` 的 `return i + offset;`)。

### 2.2 共享语义:改 Buffer = 改数组

因为共享,wrap 出来的 Buffer 的任何修改**直接影响原数组**——与 `Arrays.copyOf`(域 08,复制)完全相反。生产典型用法: 协议解析把接收的 byte[] 直接 wrap 成 ByteBuffer,免一次拷贝:

```java
// 用法示意(API 形式,非源码片段)
byte[] data = receive();                  // 网络收到的原始字节
ByteBuffer buf = ByteBuffer.wrap(data);   // 零拷贝包装
buf.order(ByteOrder.BIG_ENDIAN);
int magic = buf.getInt();                 // 直接读原数组
```

安全注意: 包装后原数组仍可被其他代码直接改——Buffer 不是防御边界,是同一内存的另一个名字。

关键设计(斜体):*wrap 是"零拷贝视图"——数组与 Buffer 互操作不复制,共享底层数组。面试"wrap 会复制吗": 不会,new HeapByteBuffer 直接包数组;再问"wrap 的坑": 共享意味着双方修改互相可见,协议解析时数组被其他线程改动就是脏数据。*

## 3. "视图与字节序" — asXBuffer/order

### 3.1 字节序:默认大端,可切换

字节序字段是**两个 boolean**(`X-Buffer.java.template:1636-1638`):

```java
// X-Buffer.java.template:1636-1638(截取核心,逐字)
    boolean bigEndian                                   // package-private
    boolean nativeByteOrder                             // package-private
```

查询与设置(`X-Buffer.java.template:1651` 的 `order()` 与 `:1665` 的 `order(ByteOrder)`):

```java
// X-Buffer.java.template:1651-1653 + 1665-1670(截取核心,逐字)
    public final ByteOrder order() {
        return bigEndian ? ByteOrder.BIG_ENDIAN : ByteOrder.LITTLE_ENDIAN;
    }
...
    public final $Type$Buffer order(ByteOrder bo) {
        bigEndian = (bo == ByteOrder.BIG_ENDIAN);
        nativeByteOrder =
            (bigEndian == (ByteOrder.nativeOrder() == ByteOrder.BIG_ENDIAN));
        return this;
    }
```

两个关键点:

- **初始恒为 BIG_ENDIAN**(模板 Javadoc `:141-142`: "The initial order of a byte buffer is always BIG_ENDIAN")——**Java 默认大端 = 网络字节序**,报文解析开箱即用
- `nativeByteOrder` 是**性能标志**: 字节序与硬件一致时,多字节读写走快路径(无需反转);不一致才逐字节组装

### 3.2 视图:同一内存的多类型解释

`asIntBuffer()`(`Heap-X-Buffer.java.template:429`)把 ByteBuffer 的字节"重新解释"为 int 序列:

```java
// Heap-X-Buffer.java.template:429-445(截取核心,逐字)
    public IntBuffer asIntBuffer() {
        int pos = position();
        int size = (limit() - pos) >> 2;
        long addr = address + pos;
        return (bigEndian
                ? (IntBuffer)(new ByteBufferAsIntBuffer$RW$B(this,
                                                             -1,
                                                             0,
                                                             size,
                                                             size,
                                                             addr))
                : (IntBuffer)(new ByteBufferAsIntBuffer$RW$L(this,
                                                             -1,
                                                             0,
                                                             size,
                                                             size,
                                                             addr)));
```

**`(limit() - pos) >> 2`**: 剩余字节数 ÷ 4 = 能解释成几个 int。视图类 `ByteBufferAsIntBufferB/L` 由 `ByteBufferAs-X-Buffer.java.template` 生成(B=大端、L=小端),内部持有 `final ByteBuffer bb`(`ByteBufferAs-X-Buffer.java.template:39`)——**读写都委托给底层 ByteBuffer**,自己只管类型解释。

网络协议的例子: 报文头部固定大端——`getInt()` 直接按大端读 4 字节;本地文件常小端——先 `order(ByteOrder.LITTLE_ENDIAN)` 再读。

关键设计(斜体):*视图 = "同一块内存的多类型解释"——asIntBuffer 不复制、不转换,只是把字节流当 int 序列读;字节序决定多字节怎么组装。面试"网络字节序": Java 默认大端即网络序,报文解析零配置;本地文件小端需 order 切换;能说出 nativeByteOrder 是"快路径标志"就是源码级。*

## 4. "slice/duplicate" — 子视图

### 4.1 slice:从 position 到 limit 的切片

`slice()`(抽象声明在 `X-Buffer.java.template:553`,实现因类型而异)返回**从当前 position 到 limit 的新视图**——共享底层,独立游标。视图模板的实现(`ByteBufferAs-X-Buffer.java.template:79-86`):

```java
// ByteBufferAs-X-Buffer.java.template:79-86(截取核心,逐字)
    public $Type$Buffer slice() {
        int pos = this.position();
        int lim = this.limit();
        int rem = (pos <= lim ? lim - pos : 0);
        long addr = byteOffset(pos);
        return new ByteBufferAs$Type$Buffer$RW$$BO$(bb, -1, 0, rem, rem, addr);
    }
```

`addr = byteOffset(pos)`——**新视图的地址从当前 position 偏移开始**,容量 = 剩余量。

### 4.2 duplicate:整个缓冲区的副本

`duplicate()`(抽象在 `X-Buffer.java.template:576`)返回**共享同一底层、但游标独立的副本**——位置/限制/标记全都复制当前值,但数据是同一份(`ByteBufferAs-X-Buffer.java.template:87-94`)。

两者对比:

| | slice() | duplicate() |
|--|--------|------------|
| 覆盖范围 | position..limit | 整个缓冲区 |
| 新 position | 0 | 当前 position |
| 新 limit | 剩余量 | 当前 limit |
| 共享数据 | 是 | 是 |
| 独立游标 | 是 | 是 |

### 4.3 视图家族:全部共享底层

wrap/slice/duplicate/asXBuffer 组成"视图家族"——**全部不复制数据,共享同一底层存储**,修改互相可见。这与域 08 的 `subList` 是同一思想(共享底层数组、独立视角)。生产大 Buffer 分帧解析: 每帧 `slice()` 出一个子视图处理,免拷贝;要存档再 `duplicate()` 一份独立游标的副本。

跨层标注: [域 08: 01-arraylist——subList 视图与 Buffer 视图同构(共享底层、独立游标)](../08-collections/01-arraylist.md);域 32 Unsafe——DirectBuffer 的 address 与 Cleaner 是堆外 Buffer 的地基(模板的 address 字段直连)

关键设计(斜体):*"视图"家族(wrap/slice/duplicate/asXBuffer)全部共享底层——修改互相可见、游标各自独立。面试"slice 与 duplicate 区别": 范围 vs 全量、新游标起点不同,共享语义相同;再补一句"和 ArrayList.subList 同思想(域 08)"就是跨域联想。*

## 五、四个最容易混掉的边界：模板不是运行时魔法，wrap 不是复制，字节序不是改字节，视图也不是新数组

在收网之前，先把这一篇最容易记错的四条边界压实。

第一，模板生成不是运行时黑魔法。JDK 不是在程序执行时动态拼出七种 Buffer，而是在构建期用模板展开成具体类族。运行期调用方拿到的，仍然是普通的 `ByteBuffer`、`IntBuffer`、`HeapByteBuffer`、`DirectByteBuffer` 这些真实类。

第二，`wrap()` 也不是把数组复制进一个更安全的新容器。它做的恰恰是零拷贝包装：把现有数组直接借给 `ByteBuffer` 用。于是数组改了，Buffer 看到的内容也跟着变；Buffer 写了，原数组也会被同步改掉。

第三，`order(ByteOrder)` 更不是去重排底层字节。它改变的是多字节值如何被解释和组装：同样四个字节，在大端和小端视角下读出来的 int 可能不同，但底层那四个字节本身没有被重写。

第四，`slice()`、`duplicate()`、`asIntBuffer()` 这些视图也不是“再造一份数组”。它们共享的始终是同一块底层存储，只是各自带着不同的范围、游标和解释方式。把它们误当复制体，最容易在共享修改和并发访问上踩坑。

把这四条边界记稳，ByteBuffer 家族这一篇就不会重新塌回“类很多、名字很多”的表面印象。它真正想讲的其实只有一条主线：**尽量共享底层存储，尽量把变化限制在观察视角、游标状态和字节解释方式上。**

## 收网：ByteBuffer 家族真正统一的，不是类名，而是“共享底层、改变视角”的一套生成与视图体系

回到开头那个疑问，现在已经能看清为什么 ByteBuffer 家族看起来像一堆近亲类，底层却还能保持高度统一。因为 JDK 先用模板解决了“七种原始类型实现几乎一样”的工程问题，再用 wrap、slice、duplicate、asXBuffer 和字节序，把“共享底层存储、切换观察方式”这条主线一路贯彻到底。

这也把整篇的三个重点收回来了：

- 模板生成负责把近同实现压成一套可维护源码；
- 视图家族负责在不复制数据的前提下，切出不同范围、不同游标、不同类型解释；
- heap/direct 与 byte order 则进一步决定同一套状态机落在什么存储位置、按什么字节规则被解释。

把整篇压成一张总图，就是：

```text
ByteBuffer 家族
  → 构建期模板生成七种近同类

共享底层
  → wrap：数组直接借用
  → slice/duplicate：共享存储、分离游标
  → asXBuffer：共享存储、改变元素解释

解释方式
  → order：改多字节组装规则
  → heap/direct：改 I/O 成本路径
```

如果说这一篇解决的是“为什么 Buffer 家族看起来很多，底层却还能围绕同一思想统一起来”，下一篇就会继续把这套共享存储与 direct 语义推到文件通道和 mmap 上：文件为什么能像内存一样访问，`transferTo()` 又为什么总和“零拷贝”绑在一起。
