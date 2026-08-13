# 02. 一个 Java Monitor 在 C++ 里怎么表示?— ObjectMonitor 结构

> **前置依赖**:[19-sync/01 — synchronized 三步曲](openjdk/vol-02/19-sync/01-lock-hierarchy.md):锁膨胀的终点在这里展开;[06-oops/01 — 对象头](openjdk/vol-02/06-oops/01-markoop-oopdesc.md):markOop 的 monitor_value=2 是 ObjectMonitor 指针的 tag;[17-threads/01 — Thread 层次体系](openjdk/vol-02/17-threads/01-thread-hierarchy.md):omFreeList/omInUseList 每线程缓存
> → **后续**:[19-sync/03 — enter/exit/wait](03-enter-exit-wait.md)(多线程怎么抢锁、怎么睡、怎么醒)
> 关联域: 06-oops(对象头)、19-sync(锁)、17-threads(线程)、01-os(原子与 cache line)

## 锁膨胀之后,对象头里存的是什么

`synchronized` 的锁升级到重量级后,对象头不再存 hash/age/偏向线程——它存一个**指向 ObjectMonitor 的指针**(monitor_value=2 做 tag,06-01 讲过)。这个 ObjectMonitor 内部是什么?这一篇拆它的"结构": 为什么 _header 必须住在 offset 0、字段怎么排布避免伪共享、三条队列(cxq/EntryList/WaitSet)各管什么、以及 _recursions 与 _count 两个计数器。

## 1. 布局: _header 必须住在 offset 0

### 一个不能继承、不能有虚函数的类

ObjectMonitor 的头文件注释把约束写得明明白白(objectMonitor.hpp:76-81,截取核心,逐字):

```cpp
// objectMonitor.hpp:76-81(截取核心,逐字)
// - The _header field must be at offset 0 because the displaced header
//   from markOop is stored there. We do not want markOop.hpp to include
//   ObjectMonitor.hpp to avoid exposing ObjectMonitor everywhere. This
//   means that ObjectMonitor cannot inherit from any other class nor can
//   it use any virtual member functions. This restriction is critical to
//   the proper functioning of the VM.
```

- **`_header` 必须在 offset 0**(:76): markOop 的 lock bits=11 时,剩余位存的是 **指向 ObjectMonitor 的指针**(带 tag 2)。GC/锁代码拿到这个指针后要"把它当 markOop 读 hash/age"——而 displaced markOop 就存在 `_header` 里。如果 _header 不在 offset 0,从 markOop 视角读到的就不是它;
- **不能继承、不能有虚函数**(:79-80): 一有虚函数表,对象布局就带 vptr,_header 就不在 offset 0 了——所以整个类全是无虚函数的字段。

### 字段清单与 tag 减法

字段布局(objectMonitor.hpp:143-173,截取核心,逐字):

```cpp
// objectMonitor.hpp:143-173(截取核心,逐字)
  volatile markOop   _header;       // displaced object header word - mark
  void*     volatile _object;       // backward object pointer - strong root
  ...
  DEFINE_PAD_MINUS_SIZE(0, DEFAULT_CACHE_LINE_SIZE,
  ...
  void *  volatile _owner;          // pointer to owning thread OR BasicLock
  volatile jlong _previous_owner_tid;  // thread id of the previous owner of the monitor
  volatile intptr_t  _recursions;   // recursion count, 0 for first entry
  ObjectWaiter * volatile _EntryList; // Threads blocked on entry or reentry.
  ...
  ObjectWaiter * volatile _cxq;     // LL of recently-arrived threads blocked on entry.
  Thread * volatile _succ;          // Heir presumptive thread - used for futile wakeup throttling
  Thread * volatile _Responsible;
  ...
  volatile int _Spinner;            // for exit->spinner handoff optimization
  ...
  volatile jint  _count;            // reference count to prevent reclamation/deflation
  ...
  ObjectWaiter * volatile _WaitSet; // LL of threads wait()ing on the monitor
  volatile int _WaitSetLock;        // protects Wait Queue - simple spinlock
```

- `_header`(:143): 被膨胀时从对象头换下来的 displaced markOop(hash/age 都在这);
- `_object`(:144): 回指 Java 对象的 oop;
- `_owner`(:152): 拥有者——`BasicLock*` 或 `Thread*`;
- `_previous_owner_tid`(:153)/`_recursions`(:154)/`_EntryList`(:155)/`_cxq`(:159)/`_succ`(:160)/`_Responsible`(:161)/`_Spinner`(:163)/`_count`(:166)/`_WaitSet`(:170)/`_WaitSetLock`(:173)。

**tag 减法**: 因为 markOop 里存的是 `ObjectMonitor* | monitor_value`(monitor_value=2),取字段偏移时要用 `OM_OFFSET_NO_MONITOR_VALUE_TAG(f)`(objectMonitor.hpp:232-233)——**偏移减去 2**,否则访问错位(注释 :221)。

### 伪共享: _owner 单独一条 cache line

`DEFINE_PAD_MINUS_SIZE`(:148)在 `_header/_object` 与 `_owner` 之间填充到 `DEFAULT_CACHE_LINE_SIZE`(64 字节)。注释解释了动机(:82-83 与 :113-121,截取核心,逐字):

```cpp
// objectMonitor.hpp:112-122(截取核心,逐字)
// Futures notes:
//   - Separating _owner from the <remaining_fields> by enough space to
//     avoid false sharing might be profitable. Given
//     http://blogs.oracle.com/dave/entry/cas_and_cache_trivia_invalidate
//     we know that the CAS in monitorenter will invalidate the line
//     underlying _owner. We want to avoid an L1 data cache miss on that
//     same line for monitorexit. Putting these <remaining_fields>:
//     _recursions, _EntryList, _cxq, and _succ, all of which may be
//     fetched in the inflated unlock path, on a different cache line
//     would make them immune to CAS-based invalidation from the _owner
//     field.
```

enter 的 CAS 会**失效 _owner 所在 cache line**(写者拿排他权);exit 要读 _EntryList/_cxq/_succ 决定唤醒谁——如果它们与 _owner 同线,exit 的读就得等 enter 的写完成。把它们隔开,exit 不受 enter 的 CAS 失效影响(注释 :113-121)。

## 2. 三条队列: cxq、EntryList、WaitSet

竞争同一个 monitor 的线程被组织在三条队列:

- **`_cxq`**(:159): **LIFO,最近到达的竞争者**——enter 失败时 CAS push-to-front,单条原子指令,不遍历;
- **`_EntryList`**(:155): 等待获取锁的**候选人**——exit 时把 cxq 整段转移过来(或唤醒其中的线程);
- **`_WaitSet`**(:170): **调了 wait() 的线程**——notify 后移回 EntryList 而不是 cxq(避免插队不公平)。

为什么不是一条队列?注释在 _count 处给了线索(:168 "count is approximately |_WaitSet| + |_EntryList|")——cxq 是"刚来的、还没排队的",EntryList 是"正式排队的",WaitSet 是"睡了等通知的"。三种生命周期不同: cxq 的入队必须极快(锁竞争的热路径)、EntryList 在 exit 时批量处理、WaitSet 与 wait/notify 配对。`ObjectWaiter` 节点自带状态机(TS_RUN/TS_WAIT 等),同一节点在队列间流转。

## 3. 两个计数器: _recursions 与 _count

- **`_recursions`**(:154): 重入计数——`_owner == self` 时不用再抢,直接 ++;_exit 时 --,归零才真正释放。注释 :124-128 还建议它用 int 而非 intptr_t(64 位下没理由占 8 字节);
- **`_count`**(:166): **引用计数,防 deflate 回收**——`≈ |_WaitSet| + |_EntryList|`(:168)。GC safepoint 的 deflate_idle_monitors 遍历所有 monitor,`_count == 0`(没人等、没人持有)才算空闲可回收;回收后 monitor 进每线程的 omFreeList(17-01 讲过),下次 inflate 直接复用。

**关键设计 (斜体)**: *ObjectMonitor 的设计围绕"锁的两条热路径"展开: enter 的 CAS 与 exit 的读——padding 让它们不互相踩 cache line;三队列让"新来者"(cxq,要快)、"排队者"(EntryList,exit 批量处理)、"等待者"(WaitSet,wait/notify)各走各的通道;两个计数器一个管重入(仅 owner 碰,无锁)、一个管生命周期(GC 判定可否回收)。*

## 核心悬念

结构到齐: _header 在 offset 0 让 markOop 视角能直接读 displaced header(不能继承/虚函数保证布局);字段排布用 padding 隔离 _owner 的 CAS 失效(_recursions/_EntryList/_cxq/_succ 在另一条 cache line);三队列分工(cxq 快入队/EntryList 排队/WaitSet 等待);_recursions 免锁重入、_count 防 deflate。但"结构"是静态的——动态的部分还没讲: enter 失败后怎么排队、exit 怎么挑唤醒对象、wait/notify 怎么在三队列间流转、自旋与 _succ 继承怎么配合?下一篇: enter/exit/wait 协议。

> → [19-sync/03 — enter/exit/wait](03-enter-exit-wait.md)
