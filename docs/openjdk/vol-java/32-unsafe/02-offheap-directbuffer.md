# 02. 堆外内存与 DirectBuffer — 分配、回收、OOM 排查

> **前置依赖**: [32-unsafe/01 — Unsafe 全景](01-unsafe-overview.md)(堆外原语)、[17-io-streams/01 — 字节流](../17-io-streams/01-byte-streams.md)(IO 与缓冲)
> → **后续**: [03-cas-park.md](03-cas-park.md)
> 关联: [34-jmx/06 — JMX 生产实践](../34-jmx/06-production-practice.md)(BufferPoolMXBean 监控)

## DirectBuffer 的内存不在堆上

`ByteBuffer.allocateDirect(...)` 申请的不是 Java 堆数组,而是通过 Unsafe 进入的一块堆外地址空间。GC 只能感知包装对象,不能直接管理那块 native memory。

## 1. "堆外内存怎么申请?" — allocateMemory 语义

### 1.1 真实入口

`Unsafe.allocateMemory(long)`(`sun/misc/Unsafe.java:461`)是公开委托入口,最终调用内部 Unsafe 完成堆外分配。释放对应 `freeMemory(long)`(`:607`)。

### 1.2 DirectByteBuffer 构造细节

JDK 11 的 DirectByteBuffer 是**模板生成类**,源码不以普通 `.java` 文件直接出现在树中;可验证模板在 `java/nio/Direct-X-Buffer.java.template`。

其主构造流程(模板 `:112-135`)是:

1. `Bits.pageSize()`(`Bits.java:72`)取得页大小
2. `Bits.reserveMemory(size, cap)`(`Bits.java:109`)预留额度
3. `UNSAFE.allocateMemory(size)`(`template:122`)申请堆外内存
4. `UNSAFE.setMemory(base, size, (byte)0)`(`template:127`)清零
5. 按页对齐时调整 `address`(`template:128-133`)
6. `Cleaner.create(this, new Deallocator(...))`(`template:134`)注册清理器

关键设计(斜体):*堆外 = 地址可见、GC 不直接管理的 native memory。DirectBuffer 的价值在于避开堆移动并服务本地 IO,代价是生命周期必须额外桥接。*

## 2. "DirectBuffer 接口" — address 与 cleaner

### 2.1 地址暴露

`sun.nio.ch.DirectBuffer` 是 JDK 内部接口:

- `address()`(`DirectBuffer.java:33`)——暴露堆外地址
- `cleaner()`(`:37`)——暴露关联清理器

这说明 DirectBuffer 的设计目标之一就是让 JDK 内部 native/通道代码拿到**真实地址**。

### 2.2 为什么要地址

堆内 `byte[]` 会被 GC 移动,而堆外地址是稳定的,更适合和 native IO、零拷贝路径衔接。`isDirect()` 本质上就是问“底层是不是 direct buffer”。

关键设计(斜体):*DirectBuffer 的本质特征不是“更快”,而是“有稳定地址”。面试"怎么判断一个 Buffer 是堆外": `isDirect()`;JDK 内部进一步可看是否实现 DirectBuffer。*

## 3. "堆外内存怎么回收?" — Cleaner 链路

### 3.1 Cleaner 不是 GC 本身

`Cleaner`(`jdk.internal.ref.Cleaner.java:59`)是基于虚引用的清理器。`Cleaner.create(Object, Runnable)`(`:130`)把 referent 与清理动作绑定,真正执行清理的是引用处理线程。

对于 DirectByteBuffer,模板构造里注册的是 `Deallocator(base, size, cap)`(`template:134`)。对象不可达后,Cleaner 才有机会触发这段释放逻辑。

### 3.2 桥接两件事

这里桥接的是两套生命周期:

- Java 对象何时变成不可达
- 堆外内存何时调用 `freeMemory`

两者不是同一个时钟。所以“对象快没用了”不等于“堆外内存立刻释放”。

关键设计(斜体):*GC 负责发现 DirectByteBuffer 包装对象死亡,Cleaner 负责把“对象死亡”翻译成“释放 native memory”。面试"堆外内存是 GC 管的吗": 不是;GC 只间接驱动 Cleaner。*

## 4. "为什么会 OOM?" — MaxDirectMemory 与排查

### 4.1 预留额度

`Bits.reserveMemory`(`Bits.java:109`)与 `unreserveMemory`(`:203`)维护 direct memory 配额,超出预算时最终会报 `OutOfMemoryError: Direct buffer memory`。

### 4.2 常见原因

- 分配太多 direct buffer
- 包装对象仍被引用,导致 Cleaner 迟迟不触发
- Cleaner 跟不上分配速度
- 池化/复用策略不当

生产排查通常要结合 BufferPool 监控、对象引用链和 native memory 视角一起看,而不是只看 Java 堆。

关键设计(斜体):*Direct buffer OOM 不是普通堆 OOM。面试"为什么堆还够却 Direct buffer memory OOM": 因为 direct memory 配额与堆是两套账。*

## 核心悬念

Unsafe 除了内存,更关键的是**原子与阻塞原语**。CAS 怎样实现无锁更新?`park/unpark` 为什么能支撑 AQS?——下一篇: CAS 原语与线程控制。