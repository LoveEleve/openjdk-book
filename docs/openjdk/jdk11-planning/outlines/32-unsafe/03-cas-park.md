# 03. CAS 原语与线程控制 — compareAndSet、getAndAdd、park/unpark

> 🔴 Deep | 域 32 Unsafe 与本地内存第 3 篇 | Layer 2
> 读者处境: 面试"CAS 是什么/ABA 问题/和锁比怎样"——从 Unsafe 的 native 声明到 getAndAddInt 循环,再到 park/unpark 的阻塞原语。

### 1. "compareAndSetInt 是什么？" — 原子比较交换

场景: `compareAndSetInt(obj, offset, expected, x)` 一次调用保证什么?

- `jdk/internal/misc/Unsafe.java:1361` — `public final native boolean compareAndSetInt(...)` — **native 原子指令**(x86: LOCK CMPXCHG)
- 语义: 当前值 == expected 才写 x(返回 true),否则不改(返回 false)
- JDK9+ 命名变化: 内部版 compareAndSetInt/compareAndExchangeInt(+Acquire/Release 变体);公开版保留老名 compareAndSwapInt
- 关键设计 (斜体): *CAS 是"乐观并发"的基石——不阻塞、不等待,失败返回让调用方重试;"读-比较-写"三步由硬件保证原子(缓存一致性协议,域 13 展开)*
- [C++: 内部卷 05-cpu-primitives(原子指令与内存屏障);x86: LOCK CMPXCHG 指令]
- 面试: "CAS vs synchronized"——CAS 无锁(无阻塞/无上下文切换),但高竞争下自旋浪费 CPU——"争用少用 CAS,争用多用锁(偏向/轻量,内部卷 19)"

### 2. "getAndAddInt 怎么实现？" — CAS 循环

场景: 原子 i++ 的 Unsafe 实现——没有 fetch-add 指令怎么保证?

- `jdk/internal/misc/Unsafe.java:2334` `getAndAddInt`:
  ```java
  do {
      v = getIntVolatile(o, offset);              // 读当前值
  } while (!weakCompareAndSetInt(o, offset, v, v + delta));  // CAS 更新,失败重试
  ```
- **循环重试**: 并发失败(值已被改)→ 重读重试,直到成功——"乐观锁"的标准形态
- `weakCompareAndSetInt` vs `compareAndSetInt`: weak 可假失败(无 happens-before 保证)——**允许弱化语义换取性能**,循环内用 weak 合法
- 关键设计 (斜体): *CAS 循环是"无锁算法"的模板——域 13 的 AtomicInteger.getAndIncrement/域 10 的 CHM 计数都是同一模式;面试手写 CAS 循环是基本功*
- [关联: 域 13 原子类(getAndAddInt 的封装);内部卷 05-cpu(内存序语义)]

### 3. "ABA 问题" — CAS 的经典陷阱

场景: 面试"CAS 有什么问题"——ABA 怎么发生/怎么解

- ABA: 值 A→B→A,期间其他线程改过,CAS 误判"没变过"
- 经典场景: 链表/栈操作(无锁栈 pop 的 A-B-A 导致内存重用错误)
- 解决: 版本号(`AtomicStampedReference`/`AtomicMarkableReference`,域 13)/状态位
- 关键设计 (斜体): *ABA 的本质: CAS 只验证"值相等",不验证"没被修改过";生产上纯计数器无碍,指针结构必须版本化;面试"怎么解决 ABA"——AtomicStampedReference*
- 面试: "ABA 在什么场景是问题?"——引用类型/链表结构;基本类型计数不关心

### 4. "park/unpark — 线程的阻塞原语" — AQS 的地基

场景: `LockSupport.park()` 阻塞线程——Unsafe 做了什么?

- `jdk/internal/misc/Unsafe.java:2294` — `public native void park(boolean isAbsolute, long time)` — 阻塞当前线程(可带超时/绝对时间)
- `Unsafe.java:2280` — `public native void unpark(Object thread)` — 唤醒指定线程(带"许可"语义: unpark 先于 park 也生效)
- 与 wait/notify 对比: park 不要求持有锁(与监视器无关)、可精确到线程、许可可提前发放
- 关键设计 (斜体): *park/unpark 是"信号量许可"模型(一次许可)——AQS(域 12)用它在锁等待队列上阻塞/唤醒;面试"LockSupport 与 wait 区别"——不需要锁、定向唤醒、许可语义*
- 生产: 线程池的 worker 阻塞、阻塞队列的空闲等待都用它(域 14 展开)
- [关联: 域 12 AQS/LockSupport;内部卷 17-threads(线程状态切换)]

---

### 核心悬念

Unsafe 收官——CAS 与 park 之上,**并发工具的整个大厦**: 域 13 的原子类怎么封装 CAS?域 12 的 AQS 怎么用 CAS+park 实现锁?域 10 的 ConcurrentHashMap 怎么用 CAS 保证并发?——下一站按写作顺序进入 Layer 3: 域 09 Map 与哈希。

> → 下一篇: 域 09 Map 与哈希(09-map 系列) | 域 13 原子类 / 域 12 锁与同步器
