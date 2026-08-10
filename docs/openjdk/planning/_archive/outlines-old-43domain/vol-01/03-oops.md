# OOPs（对象模型）— 文章大纲

> vol-01 · 域 03 · 🔴 A | 拓扑排序 #3（叶子域）| 基于 Pass 0+1 探索笔记
> Pass 1 产出：7 基本元素 / 7 Klass 子类 / 7 标记问题

## 概念依赖

只依赖 OS 抽象层。不依赖 JVM 内部其他域。

## 叙事计划

**开篇场景**：你写 `Object obj = new Object()`，它占多少内存？不是 0——每个 Java 对象都有 12-16 字节的"对象头"，JVM 用它来识别对象类型、存 hash 值、管锁、配合 GC。OOPs（Ordinary Object Pointers）就是这套对象模型的实现。

**第一层：oopDesc——最简对象头**

`oopDesc`（`oop.hpp:54-63`）只有两个字段：`_mark`（8 字节 markOop）和 `_metadata`（4 或 8 字节 Klass 指针）。`_metadata` 是 union——64 位模式下存 `Klass*`，压缩类指针模式下存 `narrowKlass`（32 位）。

`new Object()` → HotSpot 分配 `sizeof(oopDesc) + 实例字段空间`。不含实例字段的 Object：12 字节（压缩类指针）或 16 字节。这 12/16 字节是所有 Java 对象的共同起点。

**第二层：markOop——一个字的千层饼**

`markOopDesc`（`markOop.hpp`）把 8 个字节按位打包了不同的信息。64 位模式下，正常对象：`hash(31bit) | unused(1) | age(4) | biased_lock(1) | lock(2)`。偏向锁时前 54 位换成 `JavaThread*` + `epoch(2)`——同一个字在不同锁状态下有不同的编码语义。

`lock` 字段的 2 位编码：`01` = 无锁，`01` + biased_lock = 偏向锁，`00` = 轻量锁（栈上 Lock Record），`10` = 重量锁（指向 ObjectMonitor 的指针），`11` = GC 标记（转发指针）。同一个字，不同子系统看到不同的含义——这就是为什么 mark word 必须用位打包：换成一个 sub-field 对象要多 16+ 字节。

hash 是惰性计算的——`System.identityHashCode(obj)` 第一次调时才生成（`markOop.hpp:294` 的 `copy_set_hash`），存进 mark word。一旦 hash 被计算，偏向锁就不能再获取——这两个互斥：hash 需要占用偏向锁的位域。

**第三层：Klass 层级——Java 类在 JVM 里的身份证**

`Klass`（`klass.hpp:78`，继承 `Metadata`）是 Java 类的 C++ 表示。每个 Java 类在 JVM 堆外（Metaspace）有且仅有一个 Klass 实例。

层级：
```
Klass
├── InstanceKlass (instanceKlass.hpp:114)
│   ├── InstanceMirrorKlass (java.lang.Class 对象的 Klass)
│   ├── InstanceRefKlass (Soft/Weak/PhantomReference)
│   └── InstanceClassLoaderKlass
└── ArrayKlass
    ├── ObjArrayKlass (String[]/Object[][])
    └── TypeArrayKlass (int[]/byte[]/boolean[])
```

`InstanceKlass` 是分量最重的——`_constants`（常量池）、`_methods`（方法数组）、`_fields`（字段信息）、`_annotations`、`_inner_classes`、`_itable`/`_vtable`（虚方法表）。加载一个类，就是构造一个 InstanceKlass。

**第四层：压缩 OOP——64 位地址用 32 位编码**

64 位 JVM 上，指针 8 字节——但大多数堆 ≤ 32GB 时，可以用 32 位偏移代替 64 位地址。`narrowOop`（`oop.hpp:334`）编码公式：`real_addr = narrow_oop_base + (narrow_oop << narrow_oop_shift)`（`universe.hpp:416/433`）。

`shift=3` 是因为 Java 对象 8 字节对齐——低 3 位永远是 0，可以不存。`base` 选在堆的起始地址。`narrowOop` 存的是"相对于堆起始地址的偏移 >> 3"。

类指针同理（`narrowKlass`）——但类是存在 Metaspace 而非堆中，base 和 shift 独立配置。

**第五层：Method 和 ConstMethod——方法的可变与不可变**

`Method`（`method.hpp`，3733 行）存可变信息（入口地址、编译后入口地址），`ConstMethod`（`constMethod.hpp`）存不可变信息（字节码、行号表、异常表、局部变量表）。两者分离：归档时能共享 ConstMethod（不同 JVM 实例同一个类的方法字节码一样），Method 每个实例独立（入口地址取决于具体编译结果）。

**第六层：Access API——GC 屏障的统一入口**

`Access<decorators>::load/store/compare_and_swap`（`access.hpp`）是 JVM 读写对象字段的唯一通道——不直接解引用 oop。装饰器（`IN_HEAP`/`MO_UNORDERED`/`ON_UNKNOWN_OOP_REF`）是模板参数，编译期展开为具体实现。不同的 GC 算法可以注入不同的屏障策略——写屏障、读屏障、并发标记屏障——通过装饰器的组合来切换。这层抽象使得 GC 算法和 JVM 业务代码解耦——写字段的代码不变，换 GC 策略只需换 Access API 的装饰器组合。

**设计权衡**

一、mark word 位打包 vs 多字段。打包省空间——每个对象省 8+ 字节。代价是 lock/hash/GC 共享一个字，特定组合互斥（hash 和偏向锁不能共存）。

二、压缩指针 vs 纯 64 位指针。32 位编码在 ≤32GB 堆上零开销（shift=3）。超过 32GB 自动退回 64 位。代价是地址计算多一步 `base + (narrow << shift)`。

三、Method/ConstMethod 分离 vs 单类。分离使归档时能共享字节码（跨 JVM 实例同一方法不变）。代价是多一层间接寻址（Method → ConstMethod）。

## 核心悬念

**`new Object()` 在 JVM 眼里到底是什么？12 字节的对象头里怎么同时塞进 hash、锁状态、GC 标记——还能让它们互不打架？**

**→ 下一域**：对象都有了，但创建多大的对象、堆设多大、用哪个 GC——这些不是硬编码在源码里的。你传的 `-Xmx2g` 最终生效的可能不是 2GB。解析参数、工效学自动调整、约束检查——Arguments 篇见。

## 预估

1 篇，6 层递进，预估 2500-3000 行。
