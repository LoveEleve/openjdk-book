# ThreadLocal 原理与内存泄漏：值不在线程栈里，它挂在线程对象身上

> 本文基于 JDK 11 `ThreadLocal`、`ThreadLocalMap` 与 `InheritableThreadLocal`。讨论范围聚焦值存储位置、`get/set/remove`、弱 key 强 value、开放寻址与清理链、继承时机与线程池失效边界。第三方透传库只作为局限说明，不展开内部实现。
> **前置依赖**：[线程的生命周期与调度原语](01-thread-lifecycle.md)、[四种引用与对象生命周期](../03-object-system/01-object-contract-references.md)
> **后续**：[未捕获异常与 ThreadLocalRandom](03-exception-random.md)

## 先看一个最常见、也最容易被误讲成“线程私有所以天然安全”的坑

很多团队都会在请求入口把用户上下文、TraceId、数据库连接或审计信息塞进 `ThreadLocal`，然后在业务深处直接取。刚开始一切看起来都很好：没有参数层层透传，也没有显式加锁，一个线程拿自己的值，互不干扰。直到某天线程池里的请求开始串号：上一个请求的用户信息出现在下一个请求里；或者内存缓慢上涨，堆里堆满了你以为“已经用完”的上下文对象。

这类问题之所以难排，不是因为 ThreadLocal 太神秘，而是因为很多人从一开始就把一句口号记错了：**“线程本地变量”不等于“值放在线程栈里，也不等于出了作用域就自然消失”。**

真正的问题应该先问清楚三件事：值到底存在哪；为什么同一个 `ThreadLocal` 可以让不同线程互不影响；以及为什么明明 key 是弱引用，线程池里 value 还是会泄漏。只要这三件事没讲透，后面关于 `remove()`、弱引用、继承传播的结论都会变成背诵。

所以这篇不从“ThreadLocal 是什么”开始，而是先把存储位置这件事钉死：**值不在 `ThreadLocal` 对象里，也不在方法局部栈里，它挂在每个 `Thread` 自己的 `ThreadLocalMap` 上。** 这个设计天然免锁，但也把值的生命周期绑到了线程生命周期上，线程池于是成了问题最容易爆炸的地方。

## 一、为什么值挂在线程对象上，而不是挂在 ThreadLocal 自己身上

### 先排除最直觉、也最错误的存储模型

很多人第一次听到 ThreadLocal，会下意识想成这样：既然它叫“线程本地变量”，那值要么存在 `ThreadLocal` 对象自己身上，要么存在某种看不见的线程栈槽位里。两种理解都不准确。

先看第一个模型为什么不成立。一个 `ThreadLocal` 实例通常是被多个线程共享引用的，例如一个静态字段、一个框架级工具变量、一个拦截器里的上下文入口。如果值真放在 `ThreadLocal` 对象自己身上，那多个线程访问的其实就是同一个位置，根本谈不上“每线程一份”。

而第二个“在线程栈里”的想法，则把 ThreadLocal 和普通局部变量混到了一起。线程栈里的局部变量是跟着方法调用帧走的，方法返回后自然消失；ThreadLocal 恰恰是为了跨方法层级、跨调用深度，让同一个线程后面仍能取回一份值。它需要的是一种**附着在线程、但独立于单个方法栈帧**的存储位置。

### JDK 11 的答案：值存在线程对象的两个 map 字段上

真正的存储入口就在 `Thread` 对象里：

```java
// Thread.java:180 / 186
ThreadLocal.ThreadLocalMap threadLocals = null;
ThreadLocal.ThreadLocalMap inheritableThreadLocals = null;
```

这两行已经把整体结构说透了。`ThreadLocal` 自己不是 value 仓库，它更像一个 key；真正的值，存在当前线程对象持有的 `threadLocals` 或 `inheritableThreadLocals` 里。

把这层关系画出来：

```text
Thread 对象
  ├── threadLocals
  │     └── ThreadLocalMap
  │            └── Entry[]
  │                 key   = ThreadLocal 对象
  │                 value = 当前线程自己的值
  └── inheritableThreadLocals
        └── 用于继承传播的另一张表
```

这个设计恰好解决了前面的共享难题：同一个 `ThreadLocal` 对象可以同时被很多线程拿来当 key，但每个线程只会去自己的 `ThreadLocalMap` 里查这把 key 对应的值。于是 key 可以共享，value 天然按线程隔离，不需要全局锁，也不需要 `ConcurrentHashMap<Thread, Object>` 这种显式外置结构。

### `get` / `set` 证明了查找入口一定是“先找线程，再找 map”

JDK 11 的 `ThreadLocal.get()` 入口在 `ThreadLocal.java:161`：

```java
// ThreadLocal.java:161
public T get() {
```

它的第一步不是去看 `this` 这个 `ThreadLocal` 自己有没有存值，而是先拿到 `Thread.currentThread()`，再通过线程去拿 map，然后在 map 里用当前 `ThreadLocal` 作为 key 查值。`setInitialValue()` 在 `ThreadLocal.java:194`，`set()` 在 `ThreadLocal.java:218`，第一次没有 map 时最终都会落到 `createMap()`（`ThreadLocal.java:264`）去把第一份 value 挂到当前线程对象上。

所以 ThreadLocal 的真正模型应该这样记：**ThreadLocal 是每个线程私有 map 的索引键，而不是值本体。** 这句话一旦记住，后面为什么免锁、为什么泄漏、为什么继承传播只在构造时生效，就都能顺下来了。

## 二、ThreadLocalMap 为什么不用普通 HashMap：因为它是一张每线程私有的小型开放寻址表

### 先看它面对的访问模式和普通全局 map 有什么不同

既然值已经决定挂在线程对象上，下一步就会自然冒出一个问题：那为什么不直接在线程里放一个普通 `HashMap<ThreadLocal<?>, Object>`？

答案在于访问模式。ThreadLocalMap 不是一个通用全局哈希表，而是一张**每个线程自己独占的小表**。它的特点通常是：

- 键的数量相对有限
- 查找几乎总是“拿当前这个 ThreadLocal 去查自己的值”
- 没有多线程同时竞争同一张表
- 删除和清理会跟 key 的回收状态缠在一起

这种模式下，JDK 11 没有复用通用 `HashMap`，而是自己做了一张开放寻址数组表。入口类在 `ThreadLocal.java:319`：

```java
// ThreadLocal.java:319
static class ThreadLocalMap {
```

关键字段包括：

- `INITIAL_CAPACITY = 16`（`ThreadLocal.java:342`）
- `Entry[] table`（`ThreadLocal.java:348`）

也就是说，它天然是一张小起步、数组化、开放寻址的线程私有表，而不是链表桶结构那一套通用散列表实现。

### `0x61c88647` 为什么会出现在这里

每个 `ThreadLocal` 实例创建时都会拿到一个专属哈希码：

- `threadLocalHashCode`（`ThreadLocal.java:87`）
- `HASH_INCREMENT = 0x61c88647`（`ThreadLocal.java:101`）

这个常量不是魔法噱头，而是在为“开放寻址 + 2 的幂数组”这种结构服务。连续创建的 ThreadLocal 如果直接用简单自增哈希，很容易在小表上形成糟糕聚集；用这个黄金分割相关步长递增后，连续 key 在 2 的幂数组上会分散得更均匀，更适合线性探测。

这里不用把数学细节讲成考试题，真正该记住的是：**ThreadLocalMap 不是偷懒复用 HashMap，它从哈希步长到存储结构都在针对“每线程一张小数组表”做定制。**

### 开放寻址为什么和后面的清理链绑在一起

开放寻址有一个特别重要的后果：槽位不是独立桶链，探测链上的一个脏槽如果直接清空，后面一些本来靠线性探测才放到当前位置的元素，可能就再也找不到了。所以你后面会看到很多清理逻辑都不只是“把 key 为 null 的 Entry 删掉”，而是还要顺带 rehash 后续探测链。

这也是为什么 ThreadLocalMap 的清理逻辑看起来比普通弱引用容器更绕：它不仅在管 GC 之后的脏槽，还在管开放寻址表的探测路径完整性。

## 三、为什么 key 用弱引用，value 却还是会泄漏

### 先看最容易被误答成“弱引用就没事了”的地方

ThreadLocal 面试最常见的一种半对半错答案是：“Entry 的 key 是弱引用，所以线程池里要小心泄漏。” 这句话只对了一半。对的部分是：Entry 的 key 确实是弱引用；错的部分是：很多人以为既然 key 弱了，value 也就会跟着自动安全。

源码里 `Entry` 定义在 `ThreadLocal.java:329-333`：

```java
// ThreadLocal.java:329-333
static class Entry extends WeakReference<ThreadLocal<?>> {
    Object value;
```

这四行已经把泄漏故事讲完了：**key 是弱引用，value 是普通强引用。** 只要 Entry 这个壳还挂在活着线程的 `ThreadLocalMap` 里，value 就还活着。

### 为什么不用强 key：那样会更糟

先推演一下“看起来更简单”的失败方案：如果 Entry 对 key 也用强引用，会发生什么？结果是 ThreadLocal 对象本身也会被这张线程私有 map 长期抓住。外部代码哪怕早就把静态字段、实例字段清空了，只要线程没结束，这个 key 仍然不会被回收。

这会让问题更糟：不仅 value 活着，连本该消失的 ThreadLocal 对象自己也活着。JDK 选择弱 key，至少允许“外部已经不用这把 key 了”这件事被 GC 识别出来。

所以弱引用不是为了让 value 自动安全，而是为了避免 key 自身也永久滞留在线程 map 里。它是在修复“强 key 更糟”的失败方案，而不是直接消灭泄漏。

### 真正泄漏的为什么是 value 和长寿命线程上的脏槽

当外部对某个 `ThreadLocal` 不再保留强引用时，GC 可以把 key 回收掉。此时 Entry 槽位就变成了“key 已空、value 仍在”的脏槽。如果线程很快结束，整个 `threadLocals` 会跟着线程一起清掉，问题通常来不及表现出来。

但只要线程还活着，这个脏槽和里面的 value 就不会凭空消失。因为：

- 线程对象还活着
- 线程对象还持有 `ThreadLocalMap`
- map 里的 Entry 槽位还活着
- value 仍被 Entry 强引用着

所以更准确的结论应该是：**ThreadLocal 泄漏的不是 key，key 恰恰可能已经被弱引用回收；真正滞留的是 value 和仍挂在线程 map 里的残留 Entry 槽位。**

这一层一定要讲透，因为后面为什么线程池最容易出事、为什么 `remove()` 是根治手段，都建立在这个事实之上。

## 四、JDK 会清理脏槽，但那只是被动补救，不是你可以依赖的后台保洁

### 先看清理为什么不能指望 GC 一步完成

很多人以为“既然 key 被 GC 回收了，那 JDK 应该自然就会把 value 也清掉”。问题在于，GC 只负责发现弱 key 已失效，它不会替你重排开放寻址数组，也不会替仍在运行的线程随时扫描自己的 `ThreadLocalMap`。

于是 JDK 11 只能把清理嵌进后续的 map 操作里，让 get/set/rehash 在经过脏槽附近时顺手打扫。这一套逻辑主要包括：

- `expungeStaleEntry`（`ThreadLocal.java:460` / 定义在 `609`）
- `replaceStaleEntry`（`ThreadLocal.java:540`）
- `cleanSomeSlots`（`ThreadLocal.java:669`）
- `rehash`（`ThreadLocal.java:690`）
- `resize`（`ThreadLocal.java:701`）

### 为什么清理会顺带 rehash 探测链

前面已经说过，开放寻址表和普通桶链不同。一个脏槽如果直接删掉，后面靠探测放进来的元素可能断链。因此 `expungeStaleEntry` 做的不只是把 value 清空，还会把后续探测链里受影响的元素重新安置，保证按 key 还能继续找到它们。

`replaceStaleEntry` 则处理另一种常见情况：set 过程中探测到一个已经脏掉的槽位，此时与其让新值继续往后探测，不如就地接管这个位置，再顺手把附近该清的链清理掉。`cleanSomeSlots` 进一步做启发式局部扫描，试图把清理成本控制在可接受范围，而不是每次都全表大扫除。

这套设计说明得很清楚：**JDK 的目标不是做一个实时后台回收器，而是在你再次访问 map 时尽力把路过的脏槽补救掉。**

### 为什么 `remove()` 仍然是业务代码的责任

正因为清理是被动触发的，所以它天然有盲区：如果线程一直活着，但后续很少再经过那片探测路径，脏槽和 value 可以在 map 里挂很久。JDK 没有安排一个后台线程定时巡视每个活线程的 ThreadLocalMap。

这也是 `ThreadLocal.remove()`（`ThreadLocal.java:239`）为什么不能被当成“可有可无的好习惯”。它不是锦上添花，而是**调用方主动声明“这次线程绑定值的生命周期结束了”**。你主动 remove，就不再需要赌后续某次 get/set 会不会刚好路过并清掉这片脏槽。

这一层的收束是：弱 key 是设计，清理链是补偿，`remove()` 才是调用方真正负责任的收尾动作。

## 五、为什么线程池会把问题放大成“泄漏 + 串值”双重事故

### 普通短命线程为什么常常掩盖问题

线程结束时，JDK 会把线程对象上的两个 map 都清掉：

- `threadLocals = null`（`Thread.java:848`）
- `inheritableThreadLocals = null`（`Thread.java:849`）

这意味着对短命线程而言，哪怕你忘了 remove，问题也可能被线程生命周期掩盖：线程很快死掉，整张 map 跟着一起回收，泄漏窗口不够长，串值风险也来不及扩散。

### 线程池为什么让风险长期滞留

线程池恰好反过来：worker 线程被反复复用，线程不死，map 就不死。于是前面所有“只是暂时残留”的脏槽和 value，都可能在这个长寿命线程上长期挂着。

这会放大成两种不同事故：

- **内存泄漏**：value 占着内存不走
- **上下文串值**：后续任务在同一线程上读到上一个任务留下的旧值

而且后者经常比前者更早爆出来。因为内存泄漏需要时间慢慢积累，而串值只要下一个任务刚好复用同一线程、又恰好访问相同 ThreadLocal，就会立刻污染业务结果。

所以“线程池里一定要 remove”这条生产规范，真正的原因不是一句模糊的“怕泄漏”，而是：**长寿命复用线程会同时放大 value 残留和业务串值。**

## 六、InheritableThreadLocal 为什么在 `new Thread()` 好使，到了线程池里却经常失效

### 继承发生在线程构造时，而不是任务提交时

上一篇已经讲过，Thread 对象和真实线程的生命周期分界点在 `start()`，而线程构造阶段也会做一部分线程级初始化。`Thread` 构造器里有这样一段逻辑（`Thread.java:443-445`）：

```java
// Thread.java:443-445
if (inheritThreadLocals && parent.inheritableThreadLocals != null)
    this.inheritableThreadLocals =
        ThreadLocal.createInheritedMap(parent.inheritableThreadLocals);
```

这三行的意义非常大：`InheritableThreadLocal` 的传播不是在任务切换时发生，而是在**子线程对象构造时**，把父线程当时的 `inheritableThreadLocals` 复制一份给新线程。

复制入口是 `ThreadLocal.createInheritedMap()`（`ThreadLocal.java:275`）。而 `InheritableThreadLocal` 本身也只是对普通 ThreadLocal 做了几个关键覆写：

- 类定义在 `InheritableThreadLocal.java:53`
- `childValue()` 在 `InheritableThreadLocal.java:66`
- `getMap()` 在 `InheritableThreadLocal.java:75`
- `createMap()` 在 `InheritableThreadLocal.java:85`

也就是说，它并没有改变“值挂在线程 map 上”这条总路线，只是把 map 换成了专用的可继承版本，并允许在复制给子线程时对值做一次转换。

### 为什么它在一对一新线程场景够用，在线程池里却不重新传播

这时线程池失效的原因就一眼能看出来了。线程池 worker 线程不是每次任务都重新 `new Thread()`；它们通常早就创建好了，后续任务只是不断复用这些老线程。既然没有新的线程构造动作，自然也就没有再执行一次 `createInheritedMap()` 的时机。

所以 `InheritableThreadLocal` 的传播边界非常明确：**它传播的是“创建子线程那一刻”的父线程快照，而不是“每次任务提交时”的上下文。** 父线程之后再改值，子线程不会自动同步；线程池反复复用老线程，更不会替你重新继承一遍。

这也解释了为什么很多框架后来要做任务包装或上下文显式透传：不是 `InheritableThreadLocal` 写坏了，而是它天生只承诺构造期复制，不承诺线程池任务级传播。

## 五个最容易混掉的边界：ThreadLocal 不是值容器，弱引用不是自动无泄漏，remove 不是礼貌动作，继承不是实时传播，线程私有也不是线程池安全

第一，`ThreadLocal` 不是值容器。它更像线程私有 map 的 key；真正的 value 存在每个 `Thread` 自己的 `threadLocals` 或 `inheritableThreadLocals` 上，而不是存在线程栈里，也不是挂在 `ThreadLocal` 对象本身。

第二，弱引用不是自动无泄漏。弱的是 key，不是 value；只要活线程上的 `ThreadLocalMap` 里还有那个 Entry 壳，value 就仍可能被强引用着长期滞留。

第三，`remove()` 不是礼貌动作。JDK 的清理链更多是被动补救，依赖后续访问顺路打扫；真正能明确宣布“这份线程绑定值到此结束”的，是调用方主动 `remove()`。

第四，继承不是实时传播。`InheritableThreadLocal` 复制发生在线程构造期，而不是任务提交期；它传播的是“创建子线程那一刻”的父线程快照，不会在线程池复用时替你重新同步上下文。

第五，线程私有也不是线程池安全。ThreadLocal 的隔离粒度是线程，不是任务；当同一个 worker 线程反复处理多个请求时，旧 value 若未清理，就可能把内存残留和业务串值一起带进下一个任务。

把这五条边界记稳，ThreadLocal 就不会再被误解成“线程安全所以天然省心”的小工具。它真正想讲的是：线程私有存储换来了免锁访问，但值的生命周期也随线程一起变长；弱 key 只是降低 key 滞留，真正的资源收尾仍要靠业务代码在正确边界显式完成。

## 收网：ThreadLocal 真正绑定的不是“代码块”，而是“线程生命周期”

现在回到开头那个问题，就能看清 ThreadLocal 为什么既好用又危险了。它好用，是因为值不挂在共享的 `ThreadLocal` 对象上，而挂在每个 `Thread` 自己的 `ThreadLocalMap` 上，于是同一把 key 可以被很多线程共享，value 却天然按线程隔离，不需要锁。

它危险，也正是因为这份值绑定的不是方法作用域，而是线程对象本身。只要线程还活着，map 就可能还活着；只要 Entry 槽位还挂着，弱 key 回收后 value 仍可能残留。线程池把这个问题放到最大：线程不结束，脏槽不一定被动清掉，value 继续占内存，后续任务还可能读到旧上下文。

把整篇压成一张总图，就是：

```text
ThreadLocal 对象
  → 只是 key
  → 当前线程 Thread.threadLocals
  → ThreadLocalMap 开放寻址表
  → Entry(key 弱引用, value 强引用)

key 被 GC 回收
  → 槽位变脏
  → 后续 get/set 可能顺路清理
  → 但活线程上的 value 仍可能长期残留

线程池复用线程
  → map 不随任务结束而销毁
  → 泄漏 + 串值风险同时放大
  → finally 里 remove 才是主动收尾
```

如果说上一篇讲的是“Thread 对象什么时候才真正开始跑”，这一篇真正补上的就是：**线程一旦长期活着，它身上挂的本地值也会跟着长期活着。** 这就是 ThreadLocal 设计的力量，也是它最危险的边界。

下一篇继续把线程域收尾：线程里的代码抛异常时，异常为什么经常主线程看不见？`UncaughtExceptionHandler` 链怎么接住它？以及另一个同样借线程私有状态来避锁竞争的设计——`ThreadLocalRandom` 为什么比 `Math.random()` 更适合并发场景。