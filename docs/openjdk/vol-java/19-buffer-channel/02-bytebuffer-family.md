# 02. ByteBuffer 家族与生成体系 — 模板、wrap、视图、字节序

> **前置依赖**: [19-buffer-channel/01 — Buffer 抽象与状态机](01-buffer-state-machine.md)(四状态字段与翻转)
> → **后续**:[19-buffer-channel/03 — FileChannel 与 mmap 零拷贝](03-filechannel-mmap.md)
> 关联: 域 32 Unsafe(堆外内存);域 08 集合(subList 视图同思想)

## 七个近亲,一份源码

`ByteBuffer`、`CharBuffer`、`ShortBuffer`、`IntBuffer`、`LongBuffer`、`FloatBuffer`、`DoubleBuffer`——七种基本类型的 Buffer,方法几乎一模一样,区别只有元素类型。JDK 怎么组织这七份近同的代码?答案: 源码里根本找不到七份实现——它们从**一个模板文件**生成。这一篇拆三件事: 模板生成体系、wrap 的零拷贝包装、视图与字节序。

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

## 核心悬念

Buffer 家族讲完——但**通道**呢?`FileChannel` 怎么把文件映射进内存?`map()` 的 mmap 是什么?`transferTo` 的零拷贝怎么做到"三次拷贝变一次"?`MappedByteBuffer` 的 load/force 干什么?——下一篇: FileChannel 与 mmap 零拷贝。

> → [19-buffer-channel/03 — FileChannel 与 mmap 零拷贝](03-filechannel-mmap.md)
