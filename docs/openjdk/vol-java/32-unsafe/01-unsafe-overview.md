# 01. Unsafe 全景与能力边界 — 双入口、安全校验、API 地图

> **前置依赖**: [13-atomic/01 — 原子与 CAS](../13-atomic/01-atomicinteger-cas.md)(CAS 语义)、[12-lock-sync/01 — AQS 核心](../12-lock-sync/01-aqs-core.md)(park/unpark)
> → **后续**: [02-offheap-directbuffer.md](02-offheap-directbuffer.md)
> 关联: [10-concurrent-collections/01 — ConcurrentHashMap](../10-concurrent-collections/01-chm-storage-rw.md)(底层 CAS)

## Unsafe 为什么“不安全”

`Unsafe` 不是一个“高级工具类”,而是 Java 类型系统与内存安全边界之下的一组原语。对象偏移、堆外内存、CAS、park/unpark,几乎都能在这里找到对应入口。

## 1. "为什么 new 不了 Unsafe?" — 双入口与校验

### 1.1 单例与校验

`sun.misc.Unsafe`(`Unsafe.java:56`)内部先创建单例:

- `theUnsafe`(`:64`)——`new Unsafe()`
- `theInternalUnsafe`(`:65`)——委托到 `jdk.internal.misc.Unsafe`

公开入口 `getUnsafe()`(`:96`)会检查调用者类加载器是否属于 system domain;否则直接抛 `SecurityException("Unsafe")`(`:98`)。

### 1.2 双入口

- `sun.misc.Unsafe`——兼容入口,位于 `jdk.unsupported`
- `jdk.internal.misc.Unsafe`——JDK 内部真实实现

模块层面 `jdk.unsupported` 明确 `exports sun.misc`(`module-info.java:28`)并 `opens sun.misc`(`:31`),所以能否 import 不是关键;真正的门槛在 `getUnsafe()` 的调用者校验。

关键设计(斜体):*Unsafe 的“门”不是模块导出,而是运行时 caller 校验。面试"为什么普通代码拿不到 Unsafe": 不是类找不到,而是 getUnsafe 主动拒绝非可信调用者。*

## 2. "Unsafe 的四大能力域" — API 地图

### 2.1 对象字段访问

- `putInt(Object, long, int)`(`Unsafe.java:188`)等按偏移直接读写对象字段
- 偏移通常来自 `objectFieldOffset`/`arrayBaseOffset` 这一类 API

### 2.2 堆外内存

- `allocateMemory`
- `freeMemory`
- `setMemory`
- `copyMemory`

这些能力让 Java 代码可以手动管理堆外地址空间,GC 不会替你兜底。

### 2.3 原子操作

Unsafe 提供 CAS/交换/加法原语,并发框架在它之上搭出原子类、AQS、CHM 等上层结构。

### 2.4 线程控制

`park/unpark` 提供底层阻塞/唤醒原语,锁与同步器几乎都绕不开它。

关键设计(斜体):*Unsafe 的四大域分别回答四件事: 怎么按偏移读对象、怎么管理堆外内存、怎么做原子更新、怎么阻塞线程。面试答 Unsafe,按这四类展开最完整。*

## 3. "为什么叫 Unsafe?" — 危险语义

### 3.1 三类风险

- **内存安全**: 地址错误、忘记释放堆外内存,可能直接导致进程级问题
- **类型安全**: 绕过构造器、按偏移写字段,可以破坏对象不变量
- **并发安全**: CAS 成败、内存可见性与顺序性都要调用者自己负责

### 3.2 不是普通应用默认工具

JDK 自己大量依赖 Unsafe,但这不代表业务代码应该直接依赖它。标准库之所以存在,就是为了把这些危险原语封装成更可控的抽象。

关键设计(斜体):*Unsafe 违反的是 Java 的默认安全边界: 类型安全、内存安全、线程安全。面试"为什么叫 Unsafe": 因为一旦用错,出错级别不是业务 bug,而可能是 JVM 级崩溃或隐性数据竞态。*

## 4. "谁在用 Unsafe?" — 框架生态

### 4.1 JDK 自身

- 原子类、AQS、ConcurrentHashMap 依赖 CAS 与内存访问原语
- park/unpark 是锁与同步器的底座

### 4.2 框架与生态

- 网络/缓冲框架利用堆外内存
- 序列化/对象框架可能用 `allocateInstance` 绕过构造器
- 高性能并发组件直接依赖 CAS 与字段偏移

关键设计(斜体):*理解 Unsafe,就等于理解“Java 高性能并发与内存边界”的下层接口。上层看到的是锁、队列、原子类,底层看到的常常都是 Unsafe 原语。*

## 核心悬念

Unsafe 能直接申请不受 GC 管理的内存——**堆外内存**。`DirectByteBuffer` 怎么分配?谁来回收?为什么 Netty 偏爱它?——下一篇: 堆外内存与 DirectBuffer。