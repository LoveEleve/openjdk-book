# Object 的方法契约与对象生命周期 — 从集合 key 到引用处理

> 基于 JDK 11 `java.base` 的 `Object`、`Reference`、`Cleaner` 实现；对象头与 GC reachability 的底层细节属于 HotSpot 当前实现，不等于 Java API 规范的全部内容。
> **前置依赖**: [02-number-math/01 — 包装类与 equals](../02-number-math/01-wrapper-cache-boxing.md)(对象身份/值比较)、[01-string/02 — String 的 hash 契约](../01-string/02-equals-hashcode-compare.md)(不可变 key)
> → **后续**: [System 与 Runtime 门面](02-system-runtime.md)

## 先看一个会“消失”的 HashSet 元素

```text
对象放入 HashSet
   → 按 hashCode 找桶
   → 再用 equals 确认
   → 对象参与 hash 的字段被修改
   → 再查/再删时走了另一条路径
```

对象还在，集合却可能找不到它。这个事故说明：`equals` 与 `hashCode` 不是两个独立的面试方法，而是集合正确性的共同前提。

Object、finalize、Reference 看起来属于不同主题，其实都在回答同一个边界问题：**对象的身份、值、资源和死亡通知，谁负责保证？**

## 一、Object 契约：身份与值必须先分清

### 1. equals/hashCode 不是随便覆写

Object 的默认 `equals` 是引用比较；子类如果定义值相等，就必须同时保证：

- equals 相等的对象必须拥有相同 hashCode
- 参与比较的状态在对象作为集合 key 期间保持稳定
- equals 满足自反、对称、传递等契约

否则 HashMap/HashSet 在“放入”和“查找”之间会使用不一致的定位条件。

这也是为什么不可变值对象天然适合做 key：值不会在放入集合后悄悄变化。

### 2. Object 的六类能力

不要先把 Object 方法当成一张背诵表。先按“Java 能否独立完成”分类：

- `getClass()`(`Object.java:72`)——需要读取对象运行时类型信息，native
- `hashCode()`(`:109`)——默认身份哈希由运行时提供，native
- `equals(Object)`(`:157`)——默认可以用 Java 的引用比较表达
- `clone()`(`:222`)——需要运行时执行浅拷贝，native
- `toString()`(`:245`)——Java 层拼接类型名与哈希表示
- `finalize()`(`:557-558`)——历史生命周期钩子，JDK 11 仍存在且 `@Deprecated(since="9")`

native 并不自动等于“更安全”或“更快”；它表示该能力需要进入运行时对象、线程或内存边界，Java 方法本身无法完整表达。

关键设计(斜体):*Object 的方法分工反映了两层边界：equals/toString 可以由 Java 代码表达并允许子类覆写,getClass/hashCode/clone 则需要运行时协助。面试"为什么 Object 有 native 方法": 先说清它们依赖 JVM 内部状态。*

## 二、clone 与 hash：看似简单，契约才是难点

### 1. clone 不是深复制保证

Object 的 `clone()` 是 native 浅拷贝入口。它复制对象字段的当前值，但不会自动递归复制字段引用指向的对象；数组有相应的运行时复制路径。

如果对象没有实现 `Cloneable`，调用 clone 会失败。实现接口也不等于得到业务上正确的深拷贝，只是满足了运行时允许复制的门槛。

### 2. hashCode 不是地址承诺

默认 hashCode 的目标是让对象在生命周期内稳定地参与哈希结构，不等于把内存地址暴露给 Java。GC 可能移动对象，因此业务代码不能把 hashCode 当作地址、持久 ID 或唯一标识。

失败方案：

- 只重写 equals，不重写 hashCode
- 把可变字段参与 hash 后再修改对象
- 把 hashCode 当唯一 ID

这些方案的问题不是“API 用得不优雅”，而是直接破坏集合的定位前提。

## 三、finalize：对象死了，资源却未必立刻释放

### 1. Finalizer 的根本问题

用 `finalize()` 清理文件、Socket 或 native 内存，直觉上像是“对象回收前最后补一刀”，但它有四个结构性问题：

1. 执行时机由 GC 与 Finalizer 线程共同决定，不可预测。
2. 对象进入待处理队列后，资源释放还要等待线程消费。
3. finalize 抛出的异常不能作为可靠业务错误通道。
4. 对象可能在 finalize 中重新建立可达性，形成复活。

所以 finalize 的问题不是“某个实现写得慢”，而是它把确定性的资源生命周期交给了不确定的 GC 调度。

### 2. Cleaner 解决什么，不解决什么

`Cleaner`(`jdk.internal.ref.Cleaner.java:59`)用虚引用跟踪对象死亡，并在引用处理线程中执行清理动作：

- `Cleaner.create(Object, Runnable)`(`:130`)登记 referent 与清理任务
- 对象不可达后，引用处理机制最终触发清理动作
- `clean()`(`:139`)允许显式执行一次清理

Cleaner 解决了“不要依赖 finalize 复活对象”的问题，但不提供确定的即时释放保证。文件/Socket 等资源仍应优先使用 try-with-resources；Cleaner 更适合作为兜底机制。

关键设计(斜体):*finalize 是不确定的生命周期钩子,Cleaner 是引用处理驱动的兜底桥接,显式 close 才是资源管理的主路径。不要把 Cleaner 当成同步析构函数。*

## 四、四种引用：对象死亡如何通知 Java

### 1. 引用对象本身也有状态

`Reference` 持有几个关键字段：

- `referent`(`Reference.java:151`)——被引用对象，GC 特殊处理
- `queue`(`:161`)——可选 ReferenceQueue
- `next`(`:171`)——引用处理链路
- `ReferenceHandler`(`:190`)——守护线程，处理待处理引用

状态可以文字化为：

```text
active
  → GC 判断弱化引用对象不再满足存活条件
pending
  → ReferenceHandler 处理并决定是否入队/触发清理
inactive
  → 引用处理完成，referent 不再作为业务可达对象
```

### 2. 强、软、弱、虚不是四种缓存 API

- **强引用**：正常可达性，仍然是对象存活的直接依据
- **软引用**：内存压力下可被回收，适合可丢弃的内存敏感缓存，但不应当当作精确缓存容量控制器
- **弱引用**：GC 判断对象只剩弱关联时即可清理，常用于不阻止对象回收的关联结构
- **虚引用**：`get()` 不用于取回对象，只用于死亡通知与清理协作

失败方案：用 WeakReference 当强缓存、用 PhantomReference.get 读取业务对象、用 ReferenceQueue 代替真正资源所有权管理。

关键设计(斜体):*四种引用的差别是“对象存活强度 + 死亡通知时机”。Java 层负责引用对象、队列与回调,GC/运行时负责可达性判断;两边不能混成一个 API 行为。*

## 收网：对象、资源、引用三条边界

- **对象值边界**：equals/hashCode 稳定，值对象适合做集合 key
- **资源生命周期边界**：try-with-resources/显式 close 是主路径，Cleaner 只是兜底
- **引用可达性边界**：soft/weak/phantom 影响对象存活与通知，不等于业务所有权

这三条边界连接起来，才能解释为什么 Object 的方法、finalize 的废弃和 Reference 的状态机都会出现在同一套 JDK 设计里：它们共同规定了对象从“可识别、可共享”到“不可达、可清理”的全过程。