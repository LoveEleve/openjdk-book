# JMM：volatile 和 final 到底保证了什么，锁又做了什么

> 基于 JDK 11 `java.util.concurrent` 包文档（`package-info.java:227-275` 的 Memory Consistency Properties 章节）与 JLS 第 17 章。本文讨论的是 happens-before 关系、`volatile` 的可见性语义、`final` 的初始化发布语义，以及 synchronized 锁与 happens-before 的关系。这些规则的核心是 JLS 17.4 定义的，JDK 11 在并发包文档里做了官方重申；`volatile` 具体在字节码/硬件层面的实现不是本文主题。
> **前置依赖**：[值传递、装箱拆箱与对象身份](03-value-passing-boxing.md)
> → **后续**：按扩展计划进入线程同步专题

## 先看两个最容易被口头背对、却被追问就露馅的"并发题"

第一句话是"`volatile` 保证可见性"。背这句话的人很多，但被问到"它保证的是什么可见性？是谁对谁可见？单纯写 volatile 能解决计数问题吗"，就容易卡住。第二句话是"`final` 字段构造完就安全"。这句话的问题在于：**final 的"安全"只在构造器正确完成后才成立**，如果把未完成构造的对象发布出去，final 也救不了你。

这两个问题共同指向一个更底层的概念——happens-before。JDK 11 在 `java.util.concurrent` 的包文档里专门用了一节 "Memory Consistency Properties" 来重申这个模型（`package-info.java:227` 起）。它说的其实只有一句话：**一个线程的写操作，要对另一个线程的读操作可见，必须存在一个 happens-before 链；孤立地说"volatile 保证可见性"或"final 安全发布"，都丢掉了这个链条最重要的前置条件。**

这里至少有三个失败方案。

第一种失败方案，是把"可见性"理解成一个开关：好像写了 volatile，读线程就一定"随时"能看到最新值。实际 volatile 的承诺是"写 happens-before 后续读"——它是在两个动作之间建立顺序关系，不是在全局做广播。

第二种失败方案，是把"final 安全发布"说得太满。final 确实限制了字段必须在构造完成前被赋值，且"构造完成后"的可见性有 JMM 保证；但如果你把 this 暴露出去、让别的线程在构造进行中就拿到对象，final 的保证就失效了。

第三种失败方案，是把锁当成"只是互斥"。同步块确实互斥，但它同时还建立 monitor 的 unlock/relock happens-before——这正是"释放锁之前写的都让拿到锁之后读得到"的机制来源。只把锁当互斥用，会漏掉它一半的语义。

所以这三个失败方案指向同一个顿悟：**并发正确性的地基不是"关键字"，而是 happens-before 链。volatile、synchronized、final、Thread.start/join 都只是制造这条链的手段；链条存在，可见性才有意义，不然再多的关键字也拼不出一条可见的路径。**

## 一、happens-before 到底是什么：一张顺序关系的网，不是广播

### JMM 的核心是一种"前置关系"

JMM（Java Memory Model）的核心不是"所有线程都看到同一份内存"，而是一组 happens-before 规则。JDK 11 并发包文档原话是：一个线程对共享变量的写，只有在"写 happens-before 读"的情况下，才保证对另一个线程的读可见（`package-info.java:232-235`）。

它不是一个全局广播系统。它是一次次"动作之间的先后承诺"：

- 程序顺序：线程内，前面的动作 happens-before 后面的动作
- monitor 规则：同一把锁，unlock happens-before 后续 lock
- volatile 规则：对同一字段的写 happens-before 后续读
- Thread.start/join：start happens-before 新线程里任何动作；新线程所有动作 happens-before join 返回

### 为什么"链条"比"开关"更准确

假设线程 A 先写普通字段 y，再写 volatile 字段 x；线程 B 先读 x，再读 y。此时：

- A 写 y happens-before A 写 x（线程 A 的程序顺序）
- A 写 x happens-before B 读 x（volatile 规则）
- B 读 x happens-before B 读 y（线程 B 的程序顺序）
- 传递性把这些串成一条完整链条：A 写 y happens-before B 读 y

所以在这种情况下，尽管 y 不是 volatile，B 也能看到 A 写入的 y——因为它被 volatile x 这一跳"包含"进了传递链。真正的风险是另一种：B 不读 x、直接读 y，中间没有任何 happens-before 环节，此时 y 的可见性没有保证。

这就是为什么"volatile 保证可见性"这句话总是不完整：它保证的是"使用 volatile 建立的那一跳"的可见性，而其它字段要跟着可见，必须借助整条 happens-before 链的传递性。JDK 文档明确写了"happens-before 关系具有传递性"（`package-info.java:246-248`），链上的每一跳都是相对严格的条件。

到这里，happens-before 这张网已经立住了。接下来三节分别看 volatile、final、synchronized 各自在这张网里的位置。

## 二、volatile：它保证什么、不保证什么

### volatile 保证：写 happens-before 后读

JDK 11 文档说得很直白：对 volatile 字段的一次写，happens-before 对同一字段的每一次后续读（`package-info.java:251-253`）。并且 volatile 的读写"在内存一致性效果上接近进入/退出监视器，但不涉及互斥锁"。

也就是说，volatile 给了你"后续读到的是这个写之后的状态"这种保证，但：

- 它不保证互斥：两个线程同时写 volatile，仍然会互相覆盖
- 它不保证原子性：`volatile int x; x++;` 不是原子的"读-改-写"
- 它不保证所有字段都在同一时刻可见：只有这条链覆盖到的字段才有保证

### volatile 解决什么、解决不了什么

volatile 适合"一个线程写、多个线程只读"的发布场景：写线程更新一个状态标志，读线程不断检查它。这种场景 volatile 够了。

它不适合"多线程并发修改同一个计数"：那需要原子操作或锁。把 volatile 当"可以无锁计数"用，会在高并发下丢更新。

## 三、final：安全发布的正确理解和它的边界

### final 的承诺：构造完成后的安全发布

final 字段的 JMM 语义是：如果构造器正确完成（没有把 this 泄漏出去），那么安全发布之后，其它线程看到这个 final 字段时，能看到它**初始化后的值**，并且能看到"构造器写 final 字段之前写的其它字段"的一部分顺序保证。这消除了"看到默认值或半初始化对象"的风险。

### 边界：构造器里把 this 暴露出去

如果构造器在字段全部赋值前，就通过把 this 传给别的线程、注册监听器、启动线程等动作把对象发布出去，那么其它线程可能在构造进行中读到这个对象。此时 final 的"安全发布"保证不适用——因为对象还没"构造完成"，就不存在"构造完成后的发布"这个前提。

这就是为什么生产规范常说"构造器里不要轻易把 this 传出去"：不是形式主义，而是它直接破坏 final 安全发布成立的前提。

## 四、synchronized：不只是互斥，它还建立 happens-before

### 锁的两半语义

很多人只看锁的互斥性：同一时刻只有一个线程能进入。JDK 文档提醒另一半：同一把锁的 unlock，happens-before 后续的每次 lock（`package-info.java:243-248`）；因为 happens-before 可传递，线程 A 解锁前写的所有东西，都对线程 B 持有同一把锁以后读得到。

这就是"把数据放进同步块、在同步块里读"背后的真正原因：不仅防同时写，还负责把 A 的写入结果"传"给 B。用一个 `volatile` 标志 + 同步块组合，往往是在利用链的传递性拼出一条可见路径。

### 为什么"加锁同步"比"volatile 硬凑"更稳

当一段共享状态的修改涉及多个字段、多个步骤时，单一 volatile 字段未必能覆盖所有字段的同步；而一把锁通过 unlock/lock 的 happens-before 链，把所有同步块内的写入一并"传"给后续持锁者。这就是为什么复杂共享状态该用锁而不是用 volatile 堆标志。

## 五个最容易混掉的边界：可见性不是广播，volatile 不保证原子，final 安全发布有前提，锁不只互斥，happens-before 是可传递的链不是单条

第一，可见性不是广播。happens-before 是"动作之间建立顺序承诺"，不是"让所有线程随时看到最新值"的全局广播。只有存在于 happens-before 链上的读写才被保证可见。

第二，volatile 不保证原子。`volatile int x; x++;` 仍是读-改-写三步，可能丢更新；volatile 只保证"写 happens-before 后续读"这一跳，不解决并发计数。

第三，final 安全发布有前提。它只对"构造器正确完成后被发布"的对象成立；构造器把 this 泄漏给别线程，安全发布保证就失效。

第四，锁不只是互斥。synchronized 同时建立同一把锁的 unlock/relock happens-before，把锁内的所有写入"传"给后续持锁者；只把锁当互斥用，会漏掉一半语义。

第五，happens-before 是可传递的链，不是单条平行规则。字段的可见性往往要通过中间的多步动作把多跳串在一起；少了其中任一环节，前面的写对后面读不一定可见。

把这五条边界记稳，JMM 就不会再被简化成"volatile=可见、final=安全、synchronized=互斥"的三句口号。它真正想讲的是：并发正确性围绕 happens-before 建立，而 volatile、final、synchronized、start/join 只是不同工具，各自贡献一段"写与读之间的顺序承诺"。

## 收网：可见性是规则的结果，不是关键字的属性

回到开头两句话，现在能看清它们为什么不完整了。

"volatile 保证可见性"——准确的说法是：volatile 在两段动作之间建立 happens-before，使"写 happens-before 读"这一跳对同字段成立；其它字段能否可见，取决于是否被包含在同一条可传递的链里。

"final 构造完就安全"——准确说法是：构造器正确完成且对象被安全发布后，final 字段的可见性有保证；把未完成构造的 this 发布出去，这两条前提都不成立。

把整篇压成一张总图：

```text
happens-before（JMM 核心）
  → 程序顺序：线程内先后动作有顺序
  → 同一 monitor：unlock happens-before 后续 lock
  → 同一 volatile 字段：写 happens-before 后续读
  → Thread.start：start happens-before 新线程内动作
  → Thread.join：线程内所有动作 happens-before join 返回
  → 传递性：多跳可串成一条链

volatile
  → 写 happens-before 后续读
  → 不保证互斥 / 不保证原子

final
  → 构造器正确完成后安全发布，字段可见
  → 构造器泄漏 this，保证失效

synchronized
  → 互斥 + unlock/lock happens-before
  → 把锁内写入"传"给后续持锁者
```

所以当你再谈并发正确性时，真正该问的不是"要不要加 volatile、要不要用 final"，而是：**这两段读写之间，有没有一条完整的 happens-before 链把它们串起来？** 链存在，可见性就有了；链断了，再多的关键字也只是在单条边上打补丁。