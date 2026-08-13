# 02. 一个 Java Monitor 在 C++ 里怎么表示？— ObjectMonitor 结构

> ⚠️ 写作期修正(2026-08-13, vol-02/19-sync/02 已按真实源码成文~110 行,本大纲为规划期产物,机制描述以文章为准):
> - **行号核对(大纲 143-155/86-121/155-170 基本对)**: 字段= _header :143/_object :144/DEFINE_PAD :148/_owner :152/_previous_owner_tid :153/_recursions :154/_EntryList :155/_cxq :159/_succ :160/_Responsible :161/_Spinner :163/_count :166(注释 :168 "approximately |_WaitSet| + |_EntryList|")/_WaitSet :170/_WaitSetLock :173;offset 0 约束注释 :76-81(不能继承/虚函数,markOop.hpp 不 include ObjectMonitor.hpp);Futures notes 伪共享 :112-122(_recursions/_EntryList/_cxq/_succ 放另一 cache line 免疫 _owner 的 CAS 失效);_recursions 建议 int :124-128
> - **OM_OFFSET_NO_MONITOR_VALUE_TAG(f)**(objectMonitor.hpp:232-233)=偏移减去 monitor_value(2),注释 :221 "ObjectMonitor references can be ORed with markOopDesc::monitor_value"
> - **ObjectWaiter**(:42-50): TStates=TS_UNDEF/TS_READY/TS_RUN/TS_WAIT/TS_ENTER/TS_CXQ(:44)+_next/_prev/_thread/_notifier_tid/_event
> - 三队列分工(cxq 新到达 LIFO/EntryList 排队/exit 转移/WaitSet wait 者);悬念指向 03-enter-exit-wait.md(标题 "03. enter/exit/wait——多线程怎么抢锁、怎么睡、怎么醒")✓

> 🔴 Deep | 4 KP 中的锁内部结构
> 读者处境: `synchronized(obj)` 锁升级为重量锁后——obj 的 mark word 里不再存 hash/age/biased thread，而是存一个指针指向 ObjectMonitor。这个 ObjectMonitor 里有几条队列，一个 spin counter。

### 1. "我在对象头的第一字节" — _header at offset 0

场景: ObjectMonitor 必须能替代 markOop——mark word 的前 8 字节必须和 ObjectMonitor::_header 在同一个位置。

**_header offset=0 约束** (`objectMonitor.hpp:74-81`):
```
ObjectMonitor:
  _header     (offset 0) → displaced markOop(含 hash+age+lock bits)
  _object     → 回指 Java 对象的 oop
  [padding]   → cache line 隔离 _header 和 _owner 防伪共享
  _owner      → 拥有者线程(BasicLock或 Thread*)
  _recursions → 重入次数(0=非重入, N=第N+1次进入)
```
- 源码: `objectMonitor.hpp:143-155` 字段定义
- 关键设计: _header 必须在 offset 0——markOop.hpp 不能 include ObjectMonitor.hpp，否则循环依赖。markOop 的 lock bits=11 时剩余 62 bit 存的就是 ObjectMonitor*(减去 tag)。解引用时减掉 tag→取 _header→读 hash/age
- [C++: `OM_OFFSET_NO_MONITOR_VALUE_TAG(f)` 宏——从 ObjectMonitor 偏移中减去 tag value(2)——因为 `monitor_value=2` 是 OR 在 ObjectMonitor* 上的。不做这个减法→得到错误的地址→错误字段]

**字段布局与伪共享** (`objectMonitor.hpp:86-121`):
```
[_header] [lightly used fields] [padding → cache line] [_owner] [EntryList/cxq/succ/_Responsible/_Spinner]
```
- 关键设计: _header 和 _owner 被 padding 隔开——因为 (1) monitorenter 执行 cmpxchg 到 _owner → 核 #0 的 cache line 被排他标志→其他核读这行要等。(2) monitorexit 需要读 _EntryList/_cxq 决定唤醒谁——如果它们在 _owner 同行→exit 的读等待 enter 的写→慢。分离后 exit 不需要等 enter
- [x86: cache line = 64 bytes。_header(8)+_object(8)+padding(0)=16→padding 填到 64 bytes→_owner 在第二行。DEFINE_PAD_MINUS_SIZE(0, DEFAULT_CACHE_LINE_SIZE, ...)=计算 remaining space to fill]

### 2. "三条队列，三个用途" — cxq + EntryList + WaitSet

场景: 三个线程同时抢同一把锁——一个在运行(sys)，两个在等。ObjectMonitor 用三条队列组织它们。

**三队列分离** (`objectMonitor.hpp:155-170`):
```
_cxq:       LIFO 队列——最近到达的竞争者(先 push 到头部)
_EntryList: 等待获取锁的候选人(cxq→EntryList 转移在 exit 时做)
_WaitSet:   调了 wait() 的线程(wait→notify→move to EntryList)
```
- 源码: `objectMonitor.hpp:155-170` _EntryList(线126), _cxq(159), _WaitSet(170)
- 关键设计: 为什么不是一条队列？(1) cxq 处理新到达者的快速入队——push 到头部用的是 CAS swap(单条原子指令)不遍历。EntryList 在 exit 时被完整取出——cxq 的全部内容瞬间转移。(2) WaitSet 隔离 wait/notify——被 notify 的线程不能直接进 cxq(不公平)而是要经过 EntryList 排队

**cxq 入队 — CAS push-to-front**:
```
enter() 竞争失败:
  1. wrap thread in ObjectWaiter node
  2. ObjectWaiter._next = _cxq       // 新节点 → 当前 cxq 头部
  3. cmpxchg(&_cxq, old, waiter)    // 原子 CAS——新 waiter 成为头部
  4. 如果 CAS 失败→回到步骤2
```
- [x86: cxq push 用 `cmpxchg` 而非锁——是 lock-free LIFO stack。在竞争高时 CAS 可能重试 2-3 次才成功——每次约 20-50 cycles。这是 "乐观并发"——相信多数情况下只有 1 个线程同时 push]

### 3. "你怎么知道锁没人在用了？" — _recursions 与 deflate

场景: 锁升级为重量锁后不再需要了——怎么回收 ObjectMonitor？_count 字段追踪活跃使用者数。

**_recursions — 重入** (`objectMonitor.hpp:154`):
```
_recursions = 0: 锁被首次获取(非重入)
_recursions = N: 同一个线程第N+1次进入
```
- 关键设计: 重入不获取锁——检查 _owner==self→++_recursions→continue。退出时 --_recursions→如果0→释放。这是 int 不是 CAS——只有 owner 修改它

**_count — 防 deflate 引用计数** (`objectMonitor.hpp:166-168`):
```
_count ≈ |WaitSet| + |EntryList|
```
- deflate_idle_monitors: GC safepoint 时遍历所有 ObjectMonitor→_count=0(无等待者)→可回收
- 回收: 把 ObjectMonitor 放回 per-thread free list (omFreeList)→下次 inflate 复用

---

### 核心悬念

**"ObjectMonitor 用 _header 存 displaced markOop(offset 0)，用三条队列分离新到达者(cxq)、等待者(EntryList)、wait 者(WaitSet)。_recursions 让重入免锁。"** — 但多线程怎么抢锁？下一篇: enter/exit 协议。

> → [03-enter-exit-wait.md](03-enter-exit-wait.md)
