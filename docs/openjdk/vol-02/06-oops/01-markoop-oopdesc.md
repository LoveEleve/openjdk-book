# 01. 一个 `markOop`，为什么能装下对象的五种身份？

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论
> **前置依赖**：[05-cpu-primitives/01 — 原子与内存序](../05-cpu-primitives/01-atomic-and-memory-order.md)：对象头状态切换使用 CAS；[04-logging/02 — 输出与配置](../04-logging/02-output-and-configuration.md)：GC 日志观察到的对象状态最终来自这里
> → **后续**：[02 — Klass 层次](02-klass-hierarchy.md)：对象头的第二个槽位指向的类元数据
> 关联域：18-safepoint、19-sync、25-gc

## 先别急着背对象头布局

一个空的 Java 对象看起来什么都没有：

```java
new Object()
```

但 HotSpot 不能只分配一块“没有内容的内存”。运行时至少要知道：

- 这个对象属于哪个类
- 它当前是否参与锁协议
- 它是否已经有 identity hash
- 它经历了多少次年轻代存活
- GC 搬走它之后，旧地址应该指向哪里

最朴素的做法是给每种信息各加一个字段。这样最容易理解，却会把每个 Java 对象都变胖，而且这些信息并不是同时需要的：

- 普通对象只需要无锁元数据
- 加锁时需要锁状态
- 搬移期间旧地址需要 forwarding 信息
- 对象一旦搬走，旧位置也不再需要继续保存正常对象的年龄和 hash 布局

JDK 11u 的答案是：

**对象头的第一个机器 word 不是固定字段表，而是一块由低位 tag 解释的状态槽。不同阶段，剩余位可以代表 hash、年龄、线程指针、栈锁指针、监视器指针或 GC forwarding 地址。**

第二个槽位负责类元数据：

```text
Java 对象
  ├─ markOop _mark
  │    └─ 低位 tag 决定其余位如何解释
  └─ _metadata
       ├─ Klass*
       └─ 或 narrowKlass
```

这一篇要追的不是“每个位叫什么”，而是这条状态链：

```text
普通对象
  → 惰性安装 identity hash
  → 锁竞争时保存 displaced mark 并膨胀
  → GC 搬移时把旧 mark 改成 forwarding
  → 新位置重新拥有普通对象头
```

先记住一句话：

**同一块 mark word 不能同时承担所有身份；HotSpot 用低位 tag 选择解释，并在身份冲突时把原信息搬到栈、ObjectMonitor 或新对象位置。**

---

## 一、三个直觉方案为什么都不理想

在看源码前，先试着设计一个对象头。

### 1.1 方案一：每种功能增加一个字段

可以这样设计：

```text
对象头
  ├─ klass 指针
  ├─ lock 状态
  ├─ identity hash
  ├─ age
  └─ forwarding 指针
```

它的优点是字段互不干扰，但代价也很直接：

- 每个对象都为低频功能支付空间
- 大量对象从未调用 identity hash，却仍带着 hash 字段
- 大量对象从未竞争重量锁，却仍为 monitor 信息预留位置
- 普通对象和 GC 搬移对象的布局被迫统一扩大

对象数量通常远大于真正需要这些附加状态的对象数量。把所有可能性都固定进每个对象，是空间上最昂贵的办法。

### 1.2 方案二：锁状态永远放在对象外部

也可以让对象头只放 klass，锁、hash 和 GC 信息都放到外部表：

```text
对象地址
   ↓ 查表
锁 / hash / age / forwarding
```

这会把对象头变简单，却让最常见的操作变复杂：

- 每次进入同步块都要查表
- 每次取 identity hash 都要查表
- GC 搬移时需要维护对象地址到外部记录的映射
- 表的分配、回收和并发访问都需要额外协议

HotSpot 更愿意让对象自身携带少量状态，让无锁和轻量锁路径能直接读对象头，而不是为所有对象引入一张外部索引表。

### 1.3 方案三：GC 搬走对象后只更新所有引用

如果 GC 只修改所有已知引用，不在旧地址留下 forwarding，那么 GC 扫描或并行复制过程中遇到旧地址时就没有本地答案：

```text
旧地址：这块对象去哪了？
```

GC 需要另建一张 forwarding table，或者保证任何线程都不会再次看到旧地址。这两种办法都增加了全局协调成本。

在旧对象位置留下一个带 tag 的新地址更直接：

```text
旧对象头 = forwarding 地址 + marked tag
```

任何拿到旧地址的 GC 线程都可以先检查 mark，再解码新地址。

### 1.4 真正的设计约束

三个失败方案把约束暴露出来了：

1. 常态对象不能为所有低频状态预留完整字段
2. 最常见的锁和 hash 操作要能直接触碰对象头
3. GC 搬移期间旧地址必须自带找到新地址的线索
4. 状态切换需要能被多个线程用原子操作协调

因此，HotSpot 选择的是：

```text
固定大小的 word
  + 低位 tag
  + 不同状态使用不同位布局
  + 必要时把原 header 搬到外部位置
```

接下来先确认这个 word 在 C++ 对象骨架里的位置。

---

## 二、`oopDesc`：对象头其实只有两个入口槽位

### 2.1 `oop` 不是包装对象，而是指针

HotSpot 里 `oop` 的含义不是一个包住 Java 对象的 C++ 智能对象，而是一个指针类型。`oopsHierarchy.hpp:37-47` 把它定义为：

```cpp
typedef class oopDesc* oop;
typedef class markOopDesc* markOop;
```

所以：

```text
oop       = 指向 Java 对象起始地址的指针
oopDesc   = 对象起始布局的 C++ 视图
markOop   = 指向 mark word 的指针类型
markOopDesc = 对 mark word 位布局提供访问方法的 C++ 类型
```

`markOopDesc` 虽然放在 oop 继承体系里，但源码明确说明它“不是一个真正的 oop，只是一个 word”。不能把它理解成 Java 堆里额外分配的对象。

### 2.2 `oopDesc` 的两个字段

`oop.hpp:55-63` 给出对象起始结构：

```cpp
class oopDesc {
 private:
  volatile markOop _mark;
  union _metadata {
    Klass*      _klass;
    narrowKlass _compressed_klass;
  } _metadata;
};
```

从对象内存布局看，前两个区域是：

```text
对象起始地址
  +0  mark word
  +8  Klass*，或压缩后的 narrowKlass 区域
  +?  Java 实例字段 / 数组长度与元素
```

这里的 `_mark` 使用 `volatile markOop`，但不能把 `volatile` 误解成完整的并发协议。真正的状态交换还通过 `cas_set_mark` / `cas_set_mark_raw` 等原子访问完成，定义在 `oop.inline.hpp:45-79`。

`volatile` 让普通读写不会被编译器当成普通非易变内存处理；CAS 则负责“只有当对象头仍然是我观察到的旧值时，才安装新值”的竞争判断。

对象初始化时，`init_mark()` 并不是无条件把 header 设成同一个固定常量；它调用的是 `markOopDesc::prototype_for_object(this)`。也就是说，初始 mark 来自该对象所属 `Klass` 的 prototype header：在不启用偏向锁的路径上，它通常是普通 `prototype()`；在启用偏向锁的 JDK 11u 配置里，类的 prototype header 也可能一开始就是 biasable 原型。这一点决定了“对象创建后的第一份 mark”本身就带着类级别的锁策略边界。

### 2.3 压缩类指针为什么会让布局变得反直觉

`_metadata` 是一个 union：

```text
不开压缩类指针：Klass*         → 机器指针宽度
开启压缩类指针：narrowKlass     → 32 位编码
```

这不是说 C++ union 同时占两个字段，而是同一片区域有两种解释。

在开启压缩类指针的常见 64 位配置下，同一个 C++ union 槽仍然是一个 8 字节槽，但其中只有前 4 字节存放 `narrowKlass`；剩余位置可以作为 klass gap 或后续布局的一部分：

```text
C++ 结构视图：
  mark word       8 字节
  metadata union  8 字节

逻辑实例布局（压缩 Klass + 压缩 oop）：
  mark word       8 字节
  narrowKlass     4 字节
  klass gap       4 字节区域
  实例字段从     12 字节偏移开始
```

这里的“12 字节”是实例字段起始偏移的布局事实，不是说 `sizeof(oopDesc)` 或 `oopDesc::header_size()` 在 C++ 视图中自动变成了 12 字节。`instanceOop.hpp:33-45` 的 `base_offset_in_bytes()` 会根据压缩类指针和压缩普通对象指针的组合选择字段起始偏移；数组还要额外考虑 length 字段，`arrayOop.hpp:49-83` 专门处理数组头。

对象分配最终还要按对象对齐规则向上取整。因此在这些前提下，空 `Object` 的字段起始位置可以是 12 字节，但整个对象通常向上对齐为 16 字节。这不是脱离配置的 Java 语言常数。

### 2.4 路标：到这里真正确定了什么

先别急着进入位表。到这里主线只有三件事：

1. `oop` 是指向对象起始地址的指针
2. 对象头入口是 `_mark` 与 `_metadata`
3. `_mark` 的解释会变，`_metadata` 负责找到 Klass

下一节解决最关键的问题：HotSpot 怎么用几个最低位告诉自己“此刻应该按哪种方式解释 `_mark`”？

---

## 三、低位 tag：一个 word 的五种主要解释

### 3.1 为什么最低位可以拿来做状态标记

Java 对象地址和栈指针在当前实现中满足对齐要求，低位有些值不会用于真实地址。`markOop.hpp:98` 还明确依赖栈/线程指针的低两位被清零。

这给了 HotSpot 一个空间技巧：

```text
真实指针：低位天然为 0
状态 tag ：拿这些低位表示“这是什么指针/数据”
```

在 JDK 11u 的 64 位实现中，低两位是 lock bits，紧邻其后的 1 位是 biased lock bit。`markOop.hpp:111-160` 定义了这些位数和模式：

```text
lock bits = 2
biased bit = 1
```

几个关键模式是：

| 低 3 位 | 主要解释 | 其余内容 |
| --- | --- | --- |
| `001` | neutral / 普通无锁 | hash、age 等正常 header 信息 |
| `101` | biased | JavaThread*、epoch、age |
| `000` | 栈锁 | BasicLock 指针，原 mark 在栈上 |
| `010` | monitor | ObjectMonitor 指针 |
| `011` | marked / forwarding | GC 标记或转发地址 |

源码中的状态常量位于 `markOop.hpp:150-155`。这里的“低 3 位”是帮助理解的概括；具体判断函数会分别使用 lock mask 和 biased lock mask。

### 3.2 “无锁”不是 lock bits 等于 1

`unlocked_value` 是 `01`，但偏向模式是 `101`。因此：

```text
普通无锁：低三位 001
偏向状态：低三位 101
```

`has_bias_pattern()` 在 `markOop.hpp:173-175` 中比较的是包含偏向位的低三位模式，而不是只看两个 lock bits。

这一区分很重要：

- 普通无锁状态可以保存 hash
- 偏向状态把高位的一部分解释为线程指针
- 有了 identity hash 后，header 不能再被简单当作可偏向的原型

### 3.3 还有一个不能放进“五种身份表”的临时状态：0

对象头在锁膨胀过程中可能短暂为 0。`markOop.hpp:217-227` 将其定义为 `INFLATING()` / `BUSY`：

```text
0 = 某个线程正在把原状态转换成重量级 monitor
```

它不是一个稳定的对象身份，也不是“无锁”。读对象头的代码必须知道这个临时状态，否则可能把膨胀中的 word 当成正常 unlocked 或指针使用。

### 3.4 GC 的 `011` 不是对象永久进入“标记态”

`marked_value = 3` 说明低两位为 `11` 时可以表示 GC 相关编码，但具体含义取决于调用协议：

- mark-sweep 可能使用它表达 marked
- scavenger 使用它编码 forwarding pointer
- 只有在对应 GC 阶段，读取方才按这种协议解码

因此不要把 `011` 写成普通 Java 对象会永久保持的第五种运行时状态。更准确的说法是：

> 同一 tag 为 GC 协议提供了另一种临时解释。

到这里，状态机的钥匙已经出现：**低位 tag 决定其余位是数据、栈地址、monitor 地址还是 GC 地址。**下面开始看普通态里的数据为什么够用。

---

## 四、普通态：identity hash 和年龄如何共享剩余位

### 4.1 普通 header 的位预算

`markOop.hpp:111-144` 给出了位数：

```text
age       = 4 bits
lock      = 2 bits
biased    = 1 bit
hash      = 64 位平台最多取 31 bits
```

64 位普通对象可以理解为：

```text
高位                       低位
[ unused | identity hash | unused/cms | age | bias | lock ]
```

`hash()` 从 `hash_shift` 开始读取，`age()` 从 `age_shift` 读取；`no_hash = 0` 表示还没有安装 identity hash。年龄最大值由 4 位决定，`incr_age()` 到最大值后不再继续溢出，定义在 `markOop.hpp:324-343`。

### 4.2 identity hash 为什么是惰性的

不是每个对象都会调用 `System.identityHashCode()`。如果对象一创建就计算 hash：

- 每次分配都多一次计算
- 每个对象都要立刻占用 header 的 hash 位
- 大多数从未使用 hash 的对象白付成本

HotSpot 选择第一次需要时再生成。`synchronizer.cpp:749-759` 的普通 header 路径是：

```cpp
markOop mark = ReadStableMark(obj);
if (mark->is_neutral()) {
  hash = mark->hash();
  if (hash) return hash;
  hash = get_next_hash(Self, obj);
  temp = mark->copy_set_hash(hash);
  test = obj->cas_set_mark(temp, mark);
  if (test == mark) return hash;
}
```

这个流程里有三个角色：

```text
当前线程：生成候选 hash
对象头：提供旧 mark 和安装位置
其他线程：可能同时修改 mark
```

CAS 成功说明对象头仍然是自己读取的旧值；CAS 失败说明不能覆盖别人刚刚安装的状态。

### 4.3 为什么 CAS 失败不能简单循环重试

直觉方案是：

```text
CAS 失败
  → 重新读取 mark
  → 再试一次
```

但对象头可能已经进入锁协议，或者轻量锁的 displaced mark 已经被放到栈上。JDK 11u 的 hash 路径选择在竞争场景下膨胀成重量级 monitor：

```text
普通 header CAS 失败
  → inflate ObjectMonitor
  → 从 monitor 保存的 header 中读取/安装 hash
```

`synchronizer.cpp:761-792` 明确表达了这个边界。尤其当轻量锁的 displaced header 位于栈上时，源码说明它不能被修改，因为其他线程可能异步读取这个栈槽；要稳定保存 hash，只能进一步膨胀到 monitor。

所以 identity hash 并不是“总在 mark word 里”。

它有两种主要落点：

```text
普通 neutral header  → mark word 的 hash 位
重量级 monitor       → monitor 保存的 header
```

这正是“状态槽不够时搬信息”的第一次具体体现。

### 4.4 分代年龄为什么也留在 header

年轻代 GC 需要知道对象经历了多少次存活。`age` 使用 4 位，每次幸存复制时可以通过 `incr_age()` 增加。

偏向状态也保留 age bits。`markOop.hpp:76-85` 特别解释过：如果偏向对象没有年龄信息，GC 只能给它一个任意年龄，可能导致对象迟迟不晋升、复制成本增加。

因此偏向锁并不是简单地把普通 header 的 age 位全部拿走，而是通过对齐后的线程指针、epoch 和位布局继续保存年龄。

这体现了一个重要取舍：

```text
偏向锁想借用高位保存线程身份
GC 又不能失去年龄
→ 通过更严格的 JavaThread* 对齐腾出可解释的位
```

到这里，普通态的主线可以收回：hash 是按需写入的，age 是 GC 持续更新的，二者都依赖 neutral/biased 这两种布局。下一节看对象真正加锁后，mark word 如何让出位置。

---

## 五、锁竞争：原 mark 放哪儿，取决于锁的形态

### 5.1 偏向锁：把“反复是同一个线程”编码进 header

如果一个对象长期只被一个线程进入同步块，反复执行完整的 CAS 竞争并不划算。

偏向锁的想法是：

```text
第一次成功获取
  → header 记录 JavaThread*、epoch、age 和偏向 tag

同一线程再次进入
  → 检查 header 是否仍偏向自己
  → 不必重复执行完整原子竞争
```

`markOop.hpp:313-319` 展示了偏向 header 的编码要求：线程指针必须按更严格的边界对齐，空出的位用于 epoch、age 和偏向模式。

其他线程尝试获取时，偏向可能被撤销。撤销后的 header 重新进入普通锁协议，而不是让偏向状态和栈锁状态同时存在。

### 5.2 栈锁：header 只留下 BasicLock 指针

轻量级锁的关键不是把完整锁信息塞进 header，而是把原 mark 复制到当前线程栈上的 `BasicLock`：

```text
加锁前
  对象 mark → [普通 header：hash + age + unlocked]

加锁后
  BasicLock.displaced_mark → [普通 header 的副本]
  对象 mark                → [BasicLock* | 00]
```

`markOop.hpp:263-293` 的访问器说明了这种布局：

- `00` 表示 locked
- 其余高位指向栈上的 displaced mark
- 解锁时可以用 CAS 把原 header 恢复回来

为什么可以把状态放栈上？因为轻量锁的正常生命周期与持锁线程绑定，栈槽天然接近线程私有的临时存储。

但这也带来一个限制：**栈上的 displaced mark 不能随意修改。**前面 hash 安装已经遇到过这个问题：如果对象已经轻量加锁，hash 需要稳定写入，就不能只修改栈槽后期待其他线程都看见，于是要升级到 monitor。

### 5.3 重量锁：header 指向 ObjectMonitor

竞争加剧、需要等待/通知，或者其他路径要求稳定保存 header 时，对象会膨胀：

```text
对象 mark → [ObjectMonitor* | 10]
ObjectMonitor
  ├─ owner / entry / waiters 等同步状态
  └─ header：被保存的原 mark
```

`markOop.hpp:273-279` 通过 `monitor()` 从 tagged pointer 得到 `ObjectMonitor*`。这里的 monitor 对象由同步器管理，分配在 C/C++ 堆，而不是 Java 对象堆。

“重量级锁在堆上”如果不说明是哪种堆，很容易误导：

- Java 对象仍然在 Java heap
- `ObjectMonitor` 是 HotSpot 的 native 运行时对象
- mark word 只是指向它的带 tag 指针

### 5.4 膨胀中的 0：为什么要有 BUSY 哨兵

两个线程可能同时判断对象需要膨胀。如果一个线程正在：

- 分配或取得 ObjectMonitor
- 复制原 header
- 把对象 mark 改成 monitor 指针

另一个线程不能在中间插入新的 mark。

因此膨胀过程会使用 0 作为短暂的 `INFLATING` 标记。其他读取路径看到 0 时要等待或避开，而不能把它当作普通 unlocked。

这是状态机中最容易漏掉的一格：

```text
稳定状态之间切换
  → 需要一个临时 BUSY 状态
```

如果没有它，多个线程可能同时覆盖仍在复制中的原 header，导致锁和 hash 状态丢失。

### 5.5 路标：锁协议与 header 复用的真正关系

到这里不要只记“轻量锁指针在栈上、重量锁指针在 monitor”。更重要的是：

```text
普通态：mark word 自己保存元数据
栈锁态：mark word 指向 displaced mark
monitor 态：mark word 指向保存 header 的 native 对象
```

锁越复杂，越需要把原 header 搬到更稳定的外部位置。对象头仍然只有一个 word，但它不再独自保存所有信息。

---

## 六、GC 转发：旧地址的 mark 变成“新家地址”

### 6.1 搬移对象后，旧地址为什么不能只是废弃

复制式 GC 会把对象从旧区域搬到新区域：

```text
旧对象地址 A  ──复制──>  新对象地址 B
```

在所有引用都完成修正之前，GC 线程可能仍然拿着 A。此时 A 必须能回答：

```text
我已经不是对象正文了，新的对象在哪里？
```

HotSpot 的一个实现路径是把 A 的 mark word 改写成 B 的 forwarding 编码。

### 6.2 `marked` tag 与 forwarding 地址

`oop.inline.hpp:341-360` 的 `forward_to` 做三件事：

1. 检查目标地址对齐且位于 heap 保留区
2. 用 `markOopDesc::encode_pointer_as_mark(p)` 编码目标地址
3. 把编码结果写入旧对象的 mark word

编码函数在 `markOop.hpp:355-359` 附近，概念上是：

```text
forwarding mark = 对齐后的目标地址 | marked tag
```

读取旧对象时：

```text
is_forwarded()
  → 检查 mark 是否 marked

forwardee()
  → 清掉低位 tag
  → 得到目标地址
```

所以 forwarding 不需要在对象末尾增加一个字段。旧对象头已经是 GC 可以优先读取的位置。

### 6.3 并行 GC 为什么还要 CAS forwarding

多个 scavenger 线程可能同时发现同一个旧对象。`cas_forward_to` / `forward_to_atomic` 使用 CAS 让第一个成功安装 forwarding 的线程成为发布者：

```text
线程 A：CAS(A.mark, old, forwarding B)
线程 B：CAS(A.mark, old, forwarding B 或 C)
```

失败者重新读取当前 mark。如果已经是 marked，就读取已发布的 forwardee，而不是覆盖它。

这和 hash 安装的逻辑相似：

```text
先观察旧 mark
只有旧 mark 没变，才能发布新解释
```

但两者服务的时序不同：hash 是应用线程的惰性元数据安装，forwarding 是 GC 搬移协议的地址发布。

### 6.4 forwarding 与锁/年龄不是同时存在的普通组合

不能把 forwarding 当作“在普通 header 上再加一位”。一旦旧位置已经变成 forwarding：

- 读取方按 GC 协议解码目标地址
- 不再把高位解释成普通 hash 和 age
- 也不再把它当作普通锁状态使用

如果对象头当前处于锁相关状态，GC 必须遵守对应的 mark 保留和恢复协议。`is_forwarded()` 的注释还特别提醒：对象如果被锁住，mark 可能指向栈位置，因此调用方不能只靠一个脱离上下文的位判断就完成所有 GC 工作。

所以“低三位选择解释”不是让所有解释可以叠加，而是让**同一时刻的协议参与者知道当前这一个解释是什么**。

---

## 七、第二个槽位：压缩类指针怎样找到 Klass

### 7.1 类指针为什么值得压缩

每个 Java 对象都需要知道自己的类元数据。若 64 位 JVM 对每个对象都保存完整 `Klass*`，对象头中的类指针就是 8 字节。

在对象数量很多、引用密集的堆里，这个固定成本很可观。HotSpot 因此支持把类指针存成 32 位 `narrowKlass`：

```text
真实 Klass 地址
  → 减去运行时编码 base
  → 右移对齐位数
  → 存入 32 位 narrowKlass
```

`oopDesc::klass()` 在 `oop.inline.hpp:90-95` 根据 `UseCompressedClassPointers` 选择解码或直接读取。

### 7.2 编码公式不是普通整数截断

`klass.inline.hpp:46-67` 给出当前 JDK 11u 的核心公式：

```text
encode:
  pd = Klass 地址 - narrow_klass_base
  narrowKlass = pd >> narrow_klass_shift

decode:
  Klass 地址 = narrow_klass_base + (narrowKlass << narrow_klass_shift)
```

这里依赖两个事实：

1. Klass 地址满足 `KlassAlignmentInBytes` 对齐
2. 被右移的低位是对齐产生的冗余位，不需要存储

`base` 和 `shift` 是运行时编码参数，不应把某一台机器上的数值当成所有 JVM 的固定常量。

### 7.3 压缩类指针和压缩普通 oop 不是一回事

HotSpot 同时有：

```text
UseCompressedOops
  → Java 对象引用字段的 narrowOop

UseCompressedClassPointers
  → 对象头中指向 Klass 的 narrowKlass
```

二者相关，但不是同一个字段、同一套访问器或同一个语义。

JDK 11u 的参数处理要求压缩类指针依赖压缩普通对象指针，并在合适的堆/压缩类空间条件下通过 ergonomics 打开，相关路径在 `arguments.cpp:1630-1676`。

因此开头常说的“压缩指针让空对象头变成 12 字节”，必须拆开说：

- mark word 仍是 8 字节
- Klass 槽位使用 narrowKlass 后可按 4 字节编码存储
- 具体实例字段起始偏移和对齐由 `instanceOop` 规则决定
- 数组还要额外包含 length header

### 7.4 到这里先停在对象头边界

对象头只需要知道：

```text
这块对象属于哪个 Klass
```

Klass 如何表示父类、接口、方法表和字段布局，是下一篇的主题。这里不把 `Klass` 的整套层次重新塞回对象头文章，否则会破坏当前主线。

---

## 八、`is_oop`：运行时如何做最低限度的对象验证

前面一直在讨论“拿到一个地址后，能不能把它当作 oop”。JDK 11u 的 DEBUG/ASSERT 路径提供了 `oopDesc::is_oop` 一类验证，但它不是生产构建中的完整类型检查器。

`oop.cpp` 的验证逻辑主要先确认：

- 地址是否落在 heap 的保留范围
- mark 是否满足当前断言环境下的要求

对象头为 null 时，还要结合是否处于 safepoint 等条件判断。源码注释也把这类函数定位为 asserts 和 guarantees 使用的检查。

因此不要把它描述成：

```text
is_oop 会完整验证 Klass、Metaspace、字段布局和所有锁状态
```

更准确的是：

```text
DEBUG/ASSERT 构建用它尽早发现明显的非法对象指针或异常 mark
PRODUCT 构建不会为每次普通对象访问保留同等检查成本
```

这和对象头的设计目标一致：生产路径优先使用已经建立的布局和访问协议，验证代码主要服务开发期故障定位。

---

## 九、收网：mark word 不是字段表，而是一台带 tag 的状态机

现在把全文压回最开始的问题：为什么一个 word 能表达这么多身份？

```text
对象创建
  → prototype mark：来自 `Klass` 的 prototype header
  → 可能是普通 prototype，也可能是 biasable prototype

identity hash 首次需要
  → neutral header 写入 hash
  → CAS 失败则膨胀，hash 放入 monitor 保存的 header

锁进入
  → biased：记录线程和 epoch
  → stack locked：对象头指向栈上的 displaced mark
  → inflated：对象头指向 C heap 的 ObjectMonitor
  → inflating：短暂 0/BUSY，防止并发覆盖

GC 搬移
  → 旧地址 mark 改为 forwarding 编码
  → marked tag 区分 GC 指针解释
  → 并行线程用 CAS 竞争发布 forwardee

对象类型
  → 第二个槽保存 Klass* 或 narrowKlass
  → base + shift 解码压缩类指针
```

这套设计的核心不是“低位技巧很聪明”，而是一个明确的让位协议：

- 普通态把 word 用来保存最常用的 hash 和 age
- 锁需要独占解释权时，把原 header 搬到栈或 monitor
- GC 搬移时，旧位置把 word 让给 forwarding 地址
- 每次切换都用低位 tag 和原子发布告诉其他线程“现在该按哪种协议读”

最后澄清四个最容易混淆的事实：

1. `markOop` 是对象头 word 的访问视图，不是 Java 堆里的第二个对象
2. 偏向锁不是 lock bits 单独等于某个值，而是完整的低三位 bias pattern
3. 重量锁的 `ObjectMonitor` 属于 HotSpot native 运行时内存，不是 Java 对象堆
4. `011` 的 marked/forwarding 解释属于 GC 协议，不能当成普通对象永久字段布局

所以，空对象之所以能保持小，不是因为 JVM 把信息删掉了，而是因为它把不同阶段的信息放进同一块可重解释的 word，并在状态冲突时把必要的旧信息搬到合适的位置。

下一篇沿着第二个槽继续：一个对象拿到 `Klass*` 之后，Klass 层次如何组织父类、接口、方法和布局。

> → [02-klass-hierarchy.md](02-klass-hierarchy.md)
