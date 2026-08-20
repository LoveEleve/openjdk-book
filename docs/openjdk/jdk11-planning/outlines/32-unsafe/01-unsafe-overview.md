# 01. Unsafe 全景与能力边界 — 双入口、安全校验、API 地图

> 🔴 Deep | 域 32 Unsafe 与本地内存第 1 篇 | Layer 2
> 读者处境: 面试"为什么叫 Unsafe/怎么拿到它/它能干什么"——从入口校验到四大能力域,一次看全。

### 1. "为什么 new 不了 Unsafe？" — 双入口与校验

场景: `new Unsafe()` 会怎样?`Unsafe.getUnsafe()` 为什么在普通代码里抛异常?

- `jdk.unsupported` 的 `sun/misc/Unsafe.java:64` — `private static final Unsafe theUnsafe = new Unsafe()` — **私有构造 + 单例**
- `getUnsafe()`(`sun/misc/Unsafe.java:96-101`): `VM.isSystemDomainLoader(caller.getClassLoader())` 检查——**非引导类加载器直接抛 SecurityException("Unsafe")**
- 绕过方式(面试点): 反射读 theUnsafe 字段(setAccessible,域 04)——框架(Netty)就这么拿
- 关键设计 (斜体): *"不安全"= 可以: 绕过类型系统写内存、绕过构造器建对象、手动管理内存——所以 JDK 只让可信(引导)代码拿;但反射可破(设计是"威慑"非"墙")*
- 双入口: 公开版 `sun.misc.Unsafe`(jdk.unsupported,兼容/委托)vs 内部版 `jdk.internal.misc.Unsafe`(java.base,核心实现)——JDK 内部全用后者
- 模块状态: **jdk.unsupported 显式 `exports sun.misc` + `opens sun.misc`**(jdk.unsupported module-info.java:28/31)——可直接 import,真正的防线只有 getUnsafe 的类加载器检查

### 2. "Unsafe 的四大能力域" — API 地图

场景: 面试"Unsafe 能干什么"——分类回答(不能只背方法名)

- **对象字段访问**: `objectFieldOffset(Field)`(`jdk/internal/misc/Unsafe.java:948`)+ `getInt/putInt/getObject/putObject`(152/175/182/195)— 绕过可见性按偏移直读
- **堆外内存**: `allocateMemory`(607)/`freeMemory`(899)/`setMemory`(717)/`copyMemory`(779)/`pageSize`(1173)
- **原子操作**: `compareAndSetInt`(1361)/`compareAndExchangeInt`(1366)/`getAndAddInt`(2334)+ Acquire/Release 变体
- **线程控制**: `park(boolean, long)`(2294)/`unpark(Object)`(2280)
- 其他: `allocateInstance`(1231,绕过构造器)
- 关键设计 (斜体): *四大域分别回答四个问题: 怎么读任意字段/怎么用堆外内存/怎么原子更新/怎么阻塞线程——**并发框架(AQS/原子类/CHM)几乎全靠 Unsafe 的 CAS+park+字段访问**;面试答全四类=完整*
- [C++: 内部卷 05-cpu-primitives(CAS/内存屏障的硬件原语);域 12/13 全部基于本域]

### 3. "为什么叫 Unsafe？" — 危险语义

场景: 面试"Unsafe 的危险操作举例"——每个能力对应的风险

- 内存: 忘 freeMemory = **堆外内存泄漏**(GC 管不到);错误地址 = JVM 崩溃(segfault,无 Java 异常)
- 字段: 破坏不变量(写 final/绕过验证)
- CAS: 失败即返回,调用方必须循环(语义错误 = 数据竞态)
- 关键设计 (斜体): *Unsafe 违反的 Java 安全三原则: 类型安全/内存安全/线程安全——"只要出错就是进程级";生产原则: 除非必要(高性能框架),否则用标准库;JDK 自己用它但**不暴露给应用***
- 面试: "Unsafe 和反射谁快"——Unsafe 按偏移直读(无检查),反射有检查链(域 04)——但 JDK9+ 对非导出包都受限

### 4. "谁在用 Unsafe？" — 框架生态

场景: 生产代码间接使用 Unsafe 的地方

- Netty: DirectByteBuffer/堆外池(Cleaner 回收链路)
- ConcurrentHashMap/AQS/原子类: CAS + volatile 读写
- 序列化框架: 绕过构造器(allocateInstance)创建对象
- JDK 自身: Unsafe 改名史(compareAndSwapInt → compareAndSetInt,JDK9+)——**API 在变,语义不变**
- 关键设计 (斜体): *理解 Unsafe = 理解"Java 的底层边界": 它之上是 CAS→AQS→锁/并发集合的整个大厦;面试问"ConcurrentHashMap 怎么保证并发"的底层答案在这里*
- [关联: 域 10 并发集合/域 12 锁/域 13 原子类]

---

### 核心悬念

Unsafe 能申请"不受 GC 管理的内存"——**堆外内存**。`DirectByteBuffer` 怎么分配?`Cleaner` 怎么回收?为什么 Netty 偏爱它?堆外 OOM 怎么排查?——下一篇: 堆外内存与 DirectBuffer。

> → [02-offheap-directbuffer.md](02-offheap-directbuffer.md)
