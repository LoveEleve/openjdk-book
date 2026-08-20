# 05. Access API：一次引用写入，为什么要经过三层协议

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论；G1 barrier 部分以 JDK 11u 的 G1 实现为边界，Access API 部分同时区分 C++ runtime path、x86 assembler、C1 和 C2。这里描述的是 HotSpot 当前实现，不是 Java 语言规范，也不是所有 GC 都必须采用的结构。
> **前置依赖**：[03 — 为什么 `InstanceKlass`、`ObjArrayKlass`、`TypeArrayKlass` 不能合并？](03-instanceklass-arrayklass.md)：对象数组元素访问已经通过 `HeapAccess<IS_ARRAY>` 进入本文；[04 — 常量池与方法](04-constantpool-method.md)：解释器和 JIT 是访问协议的消费方
> → **后续**：[06 — Symbol 与注解](06-symbol-annotations-aux.md)
> 关联域：25-gc、13-jit

## `obj.field = value` 为什么不是一条 `mov`

从 Java 代码看，下面只有一件事：

```java
obj.field = value;
```

如果 `field` 是一个普通整数，机器大致确实可以把新值写进目标地址。但如果 `field` 是对象引用，这次写入同时改变了两件事：

1. Java 对象图中的一条引用边被替换了
2. 堆中的某个位置发生了引用修改，可能影响分区回收所依赖的索引

G1 并发标记时，标记线程依据某个时间点的对象图工作。此时一个 mutator 把旧引用覆盖掉，如果旧引用没有被记录，标记线程可能再也找不到这条本该属于快照的边。

另一方面，G1 的年轻代或混合回收并不希望每次都扫描所有老区对象，去寻找指向待回收 region 的引用。写入发生在哪个堆卡上，必须被记录下来，后续的 remembered-set 维护和 card refinement 才知道该检查哪里。

于是一个引用写入至少有两种不同的记录需求：

```text
写入前：旧值是什么？       → SATB object queue
实际写入：把新值编码后存入槽位
写入后：哪个位置发生了变化？ → dirty-card queue
```

但调用方不应该在每个字段、数组元素和 `arraycopy` 位置自己写一遍这套逻辑。否则访问代码必须知道当前使用的是 G1、当前是否处于并发标记、目标是不是新对象、槽位在堆内还是 native storage，还要知道压缩 oop 和内存序如何处理。

HotSpot 的真正问题因此是：

**调用方如何只声明“我要进行一次什么样的引用访问”，而不直接绑定某个 GC 的 barrier 实现？同一个 Access API 到底哪些信息在编译期确定，哪些信息要等运行时或编译器后端才能确定？**

先把全文主线画出来：

```text
字段写入 / 对象数组元素写入
  │
  ├─ 调用方声明 DecoratorSet
  │    ├─ 位置：IN_HEAP / IN_NATIVE
  │    ├─ 形态：IS_ARRAY / IS_DEST_UNINITIALIZED
  │    ├─ 保活：AS_NO_KEEPALIVE / AS_RAW
  │    └─ 内存序：MO_*
  │
  ├─ Access API
  │    ├─ 编译期检查装饰器组合
  │    ├─ 补齐默认语义
  │    └─ 按路径分流
  │
  ├─ C++ runtime path
  │    └─ 首次调用按 BarrierSet 懒解析函数指针
  │         └─ G1 AccessBarrier
  │              ├─ pre：读取并保存旧引用
  │              ├─ raw store：写入新引用
  │              └─ post：记录目标字段所在卡
  │
  └─ C1/C2 path
       └─ 编译器后端在生成 IR/机器码时插入 barrier
```

一句话先记住：

**Access API 把“访问语义”和“GC 实现”拆成两条轴：调用方描述访问，BarrierSet 决定实现；G1 再把普通堆内引用写拆成旧值记录、裸写新值、位置记录三个动作。**

---

## 一、三个看似更简单的方案，为什么都会失败

在看装饰器位图前，先推演几个直觉方案。读者真正需要理解的不是“源码为什么有这么多模板”，而是“不这样分层会发生什么”。

### 1.1 每个写入点自己判断当前 GC

最直接的办法是把 G1 逻辑写进每个写引用的地方：

```text
obj.field = value
  → if 当前是 G1 并发标记，记录旧值
  → 写引用
  → if 目标卡需要记账，标脏
```

这会让对象数组、字段访问、反射写入、JNI/native storage 和解释器模板各自拥有一份 GC 判断。换成 Parallel、CMS 或其他 collector 时，不是替换一个 barrier backend，而是全工程搜索所有引用写入点。

更麻烦的是，写入点还必须知道一堆不是每次都相同的事实：

- 目标是不是新分配、尚未有有效旧值的对象
- 目标地址是在 Java heap 还是 native storage
- 这是单槽写入还是数组批量复制
- 这个访问是否允许 keepalive
- 当前引用是否已经被证明为非空
- 当前写入要求什么内存序

如果所有调用点都自行判断，访问协议和 GC 实现就粘在了一起。

### 1.2 所有引用写入都固定执行完整 pre + store + post

第二个办法更统一：不管什么访问，统统执行：

```text
读旧值 → 入 SATB 队列 → 写新值 → 标脏卡
```

这又会错过大量语义边界：

- native 槽没有 Java heap card，不应该执行 heap card post-barrier
- 新对象的旧字段内容没有需要保留的应用引用
- `AS_NO_KEEPALIVE` 明确要求观察时不把对象留在 SATB 语义里
- `arraycopy` 可以用范围 barrier，没必要对每个元素重新走完整调用
- `AS_RAW` 的调用方明确要求绕过 GC access barrier
- SATB 未激活时，pre-barrier 的队列操作没有实际收益

“所有写入都两道 barrier”看起来安全，实际既浪费成本，也无法表达不同访问的真实语义。

### 1.3 每次访问都动态枚举所有装饰器和 GC 类型

第三个方案是把一切判断推迟到运行时：

```text
每次访问开始
  → 判断 heap/native
  → 判断 array/raw/weak/keepalive
  → 判断内存序
  → 判断当前 GC
  → 再决定走哪个 barrier
```

这会把本来在调用点就已经知道的信息，重新变成热路径分支。字段访问和数组元素访问每秒可能发生数十亿次，不能每次都从“这是什么访问”开始做解释。

HotSpot 的解法是把两条变化轴拆开：

```text
调用方声明的访问语义 → DecoratorSet，尽量在编译期固化
当前 VM 的 GC 实现   → BarrierSet，在 runtime 或 compiler backend 选择
```

这就是 Access API 的存在理由。它不是为了把 `load` 和 `store` 包装成更长的函数名，而是为了让“访问者的责任”和“收集器的责任”分离。

这里先记住结论：

```text
DecoratorSet 解决“这次访问是什么”
BarrierSet    解决“当前 GC 怎么处理它”
```

---

## 二、DecoratorSet：调用方先声明这次访问是什么

### 2.1 装饰器不是运行时对象，而是编译期位集

`accessDecorators.hpp:39-44` 把 `DecoratorSet` 定义成 `uint64_t` 位集，并用 `HasDecorator` 做编译期判断：

```cpp
typedef uint64_t DecoratorSet;

template <DecoratorSet decorators, DecoratorSet decorator>
struct HasDecorator : public IntegralConstant<bool,
                                             (decorators & decorator) != 0> {};
```

于是调用可以写成：

```cpp
HeapAccess<IS_ARRAY>::oop_store_at(base, offset, value);
```

`IS_ARRAY` 不是传给函数的一个运行时枚举，而是模板参数的一部分。编译器在实例化代码时就知道这次访问属于数组。

### 2.2 装饰器描述的是不同维度，不是一串互相独立的开关

`accessDecorators.hpp:70-194` 把装饰器分成若干组。常见维度包括：

```text
位置
  IN_HEAP / IN_NATIVE

内存序
  MO_UNORDERED / MO_RELAXED / MO_ACQUIRE / MO_RELEASE / MO_SEQ_CST

访问强度
  AS_RAW / AS_NO_KEEPALIVE / AS_NORMAL

引用强度
  ON_STRONG_OOP_REF / ON_WEAK_OOP_REF / ON_PHANTOM_OOP_REF

对象形态
  IS_ARRAY / IS_DEST_UNINITIALIZED / IS_NOT_NULL
```

这些位不能随意混搭。例如 `IN_HEAP` 和 `IN_NATIVE` 不是“两个优化开关同时打开”，而是同一位置维度的互斥选择；`AS_RAW` 也不能和要求正常 barrier 处理的语义混成一句。

`Access<decorators>::verify_decorators` 在 `access.hpp:343-374` 中通过 `STATIC_ASSERT` 检查装饰器组合。它验证的是“这组位对当前操作是否合法”，不是运行时证明地址真的在堆内、值真的非空。

### 2.3 `IN_HEAP`、`IN_NATIVE`：同样是 oop，位置不同，barrier 不同

`IN_HEAP` 表示目标地址位于 Java heap。这样的写入可能需要 card-table post-barrier；对象引用的压缩、解压也按 heap oop 规则处理。

`IN_NATIVE` 表示目标地址在堆外，但槽位里保存一个指向 Java heap 的 oop。典型场景包括 VM 元数据持有的引用槽。

两者的差别不是“地址在不在一个 malloc 块里”这么简单，而是 GC 需要的记录不同：

```text
堆内槽位 → 可能有目标卡，需要 heap mod/ref 记账
native 槽位 → 没有 Java heap card，但仍可能需要引用保活/更新语义
```

因此 `NativeAccess` 和 `HeapAccess` 是不同的入口包装，而不是同一个 `Access` 传一个 bool。

### 2.4 `AS_RAW`、`AS_NO_KEEPALIVE` 和 `IS_NOT_NULL` 都不能望文生义

`AS_RAW` 明确表示绕过 GC access barrier，但不等于“把 C++ 指针随便解引用”。它仍然要遵守适用的内存序、原子性和压缩 oop 编解码规则。`RawAccess` 在 `access.hpp:279-282` 中只是为访问加上 `AS_RAW` 装饰。

`AS_NO_KEEPALIVE` 的含义是这次访问不应因为观察或写入而产生 keepalive 行为。它不等于所有 barrier 都消失；位置、引用强度和当前 GC 仍然可能决定其他处理。

`IS_NOT_NULL` 更像调用方给出的前提：调用方承诺相关 oop 非空，Access API 才可以选择更快的 `decode_not_null` 或 `encode_not_null`。它不是 Access API 自己做的一次 null 检查。

### 2.5 `IS_DEST_UNINITIALIZED` 为什么能跳过写前记录

一个新分配对象的字段在 Java 语义上还没有一个需要保留的旧应用引用。数组复制到一个刚建立的目标区域时，也可能知道目标内容尚未初始化。

这类事实由 `IS_DEST_UNINITIALIZED` 表达。G1 pre-barrier 看到这个装饰器时直接返回，因为它不需要把“覆盖前的旧值”加入 SATB 快照。

注意这里的主语是“调用方声明目标未初始化”，不是 G1 通过地址自动猜出“这是新对象”。如果 C1/C2 通过逃逸分析证明了初始化事实，那是编译器额外做出的证明，不应和 DecoratorSet 的契约混在一起。

### 2.6 默认装饰器由模板补齐

调用方不必每次把所有维度全部写出来。`DecoratorFixup` 在 `accessDecorators.hpp:218-252` 中为缺省维度补上默认值，例如：

```text
没有引用强度 → 默认强引用
没有内存序   → 默认普通 unordered
没有 barrier strength → 默认 normal
```

所以“装饰器是编译期”的准确说法是：模板参数及其合法性是编译期信息，默认值和部分内部装饰由模板展开补齐；当前 GC 和压缩 oop 模式仍属于另一条运行时维度。

---

## 三、Access API 的分流：同一套词汇，实际走三条路

### 3.1 公共入口只描述访问，不实现某个 GC

`access.hpp:279-297` 给出三个最重要的包装：

```cpp
template <DecoratorSet decorators = INTERNAL_EMPTY>
class RawAccess : public Access<AS_RAW | decorators> {};

template <DecoratorSet decorators = INTERNAL_EMPTY>
class HeapAccess : public Access<IN_HEAP | decorators> {};

template <DecoratorSet decorators = INTERNAL_EMPTY>
class NativeAccess : public Access<IN_NATIVE | decorators> {};
```

调用 `HeapAccess<>::oop_store_at` 后，`Access` 会验证 heap oop 装饰器，把值标成 oop，交给 `AccessInternal`。公共层不直接写 G1 的 SATB 队列，也不直接知道 card table 的地址计算。

这条边界很重要：

```text
Access API 说：这里有一次带某种语义的访问
BarrierSet 说：当前收集器怎样实现这种访问
```

### 3.2 C++ runtime path：第一次调用才解析具体 barrier

在 C++ runtime path 中，普通访问可能进入 `RuntimeDispatch`。`access.inline.hpp:283-361` 展示了它的懒解析模式：函数指针初始指向 `load_init` 或 `store_init`，第一次调用时才解析当前 barrier，并把函数指针替换成解析后的目标。

解析过程在 `access.inline.hpp:209-271`：

```text
如果需要压缩 oop
  → 加入内部压缩 oop装饰
根据 BarrierSet::kind()
  → 选择 G1 等具体 BarrierSet 的 AccessBarrier
返回具体函数指针
```

这不是“整个 VM 第一次随便访问一个引用时做一次全局初始化”。不同的操作、值类型和 DecoratorSet 组合，可能对应不同的 `RuntimeDispatch` 实例。准确说法是：

**某个具体 runtime-dispatch 实例第一次被调用时，懒解析并缓存它对应的 barrier 函数。**

解析完成后，C++ path 仍可能保留一次间接函数指针调用。它的收益是把 GC 选择分支从每次访问移到解析阶段，不代表每个 runtime access 都自动变成零开销直接调用。

### 3.3 x86 解释器 assembler path 不是同一个 resolver

x86 模板解释器和 VM assembler 访问字段时，常走 `MacroAssembler::access_load_at` / `access_store_at`。`macroAssembler_x86.cpp:5466-5487` 中，它通过全局 `BarrierSet` 找到 `BarrierSetAssembler`，再根据装饰器选择 base implementation 或 collector-specific assembler implementation。

这个路径会生成实际机器码或调用慢路径，并不是 C++ `RuntimeDispatch::_load_func` 那套每个模板实例懒解析函数指针。

### 3.4 C1/C2：相同语义，不同消费方式

C1 使用 `BarrierSetC1`，C2 使用 `BarrierSetC2`。它们在编译期间接收 DecoratorSet 和访问地址信息，把访问转换成 LIR 或 C2 IR，再由 collector-specific backend 插入 barrier。C1 的 raw/normal 分流在 `c1_LIRGenerator.cpp:1625-1634`，C2 的对应分流在 `graphKit.cpp:1612-1628`。

```text
C1：LIRAccess → BarrierSetC1 → LIR / slow path
C2：C2Access  → BarrierSetC2 → IR / macro barrier / slow path
```

因此不能把“Access API 解析到 G1 AccessBarrier”写成所有执行路径的统一过程：

- C++ runtime path：运行时懒解析函数指针
- x86 assembler：通过 `BarrierSetAssembler` 生成机器码或调用路径
- C1/C2：编译期通过各自后端生成代码

JIT 代码通常不会在每个已编译字段访问中调用 C++ Access API resolver，但这也不等于绝对没有函数调用；barrier 的慢路径、队列溢出和运行时检查仍可能形成 stub 或 runtime call。

到这里先记住：

```text
装饰器统一的是描述语言
不是所有执行路径都共享同一段实现代码
```

---

## 四、G1 一次堆内引用写入的真实顺序

现在把问题缩小到 JDK 11u 的 G1 堆内 oop store。`ModRefBarrierSet::AccessBarrier::oop_store_in_heap` 在 `modRefBarrierSet.inline.hpp:57-65` 给出了最重要的顺序：

```cpp
bs->template write_ref_field_pre<decorators>(addr);
Raw::oop_store(addr, value);
bs->template write_ref_field_post<decorators>(addr, value);
```

这三行不是模板样板，而是一次引用写入的语义骨架：

```text
1. pre：在旧值即将消失前保存它
2. raw store：真正写入新值
3. post：记录发生写入的目标位置
```

### 4.1 为什么 pre 必须在 raw store 前

SATB 需要的是覆盖前的旧引用。如果先写新值，再去读目标槽，读到的已经是新值，旧引用无法恢复。

所以 pre 不能被理解成“写入完成后给 GC 发一个通知”。它是写入动作的一部分，负责在旧引用从槽位消失前留下副本。

### 4.2 为什么 raw store 仍然是独立动作

`Raw::oop_store` 在 `accessBackend.inline.hpp:58-70` 中负责把 oop 编码成适合槽位的表示，然后执行底层存储：

```text
oop
  → compressed oop 编码（如果需要）
  → 按要求的内存序写入目标地址
```

它不应该再次执行 G1 的 pre/post，否则 barrier 层会被重复套用。`AS_RAW` 在这里的意义是：GC-specific 的记录已经由外层 AccessBarrier 安排，内层只完成实际引用存储。

### 4.3 为什么 post 记录的是 field，而不是 new value

card table 关心的是“哪一块堆地址发生了写入”。G1 的 `write_ref_field_post` 接收 `field`，通过 `_card_table->byte_for(field)` 找到目标字段所在卡。

它不需要用 `new_val` 计算卡，也不等于“new value 指向了哪个 region”。卡记录的是修改位置，后续 collector 再根据卡覆盖的对象和字段内容判断是否存在需要处理的跨 region 引用。

### 4.4 原子引用写入也必须保留顺序

普通 store 之外，ModRef barrier 还包装 atomic exchange 和 compare-exchange。

compare-exchange 的逻辑是：

```text
pre(old slot)
result = atomic_cmpxchg(new, expected)
if result == expected:
    post(field, new)
```

只有比较成功，目标槽才真的被写入新值，因此 post 只在成功时执行；pre 仍然必须在尝试覆盖旧值前完成。这个细节说明 barrier 不是“围着一条 mov 的装饰”，它必须理解底层操作的成功/失败语义。

---

## 五、SATB pre-barrier：为什么写前要保存旧引用

### 5.1 它保护的是标记开始时的对象图

G1 的 SATB 是 Snapshot-At-The-Beginning。并发标记开始时，collector 想维护一个逻辑快照：标记开始那一刻仍然存在的引用边，即使 mutator 随后修改了对象图，也不能让这些边凭空消失。

考虑：

```text
A.field = B
并发标记已经开始
mutator 执行 A.field = C
```

如果没有 pre-barrier，旧的 `B` 从 `A.field` 消失后，标记线程可能只看到 `C`，却不知道快照中还存在 `A → B`。pre-barrier 在覆盖前把 `B` 放进 SATB 队列，让并发标记稍后继续处理它。

### 5.2 G1 的具体实现先判断能不能跳过

`g1BarrierSet.inline.hpp:35-46` 的 `write_ref_field_pre` 先检查两个编译期装饰器：

```cpp
if (HasDecorator<decorators, IS_DEST_UNINITIALIZED>::value ||
    HasDecorator<decorators, AS_NO_KEEPALIVE>::value) {
  return;
}
```

前者表示目标没有需要保留的旧内容，后者表示这次访问不应产生 keepalive 行为。

若没有跳过，代码才执行：

```text
RawAccess<MO_VOLATILE>::oop_load(field)
  → 如果编码值非 null
  → 解码为 oop
  → enqueue(old oop)
```

这里的顺序和边界都重要：

- 读取的是旧值，不是新值
- null 旧值不会入队
- SATB 队列未激活时，`enqueue` 会快速返回
- Java 线程优先写入自己的本地 SATB 队列
- 非 Java 线程使用共享队列并加锁

因此“每次引用写都把旧对象送进全局队列”是不准确的。正常路径通常先在本地缓冲中记录，且多个条件可以让 pre 直接不产生队列记录。

### 5.3 pre-barrier 解决的是旧值丢失，不是新值定位

SATB 队列中的元素是对象引用。它回答：

```text
并发标记开始时，哪些旧对象可能因为 mutator 覆盖写入而脱离快照图？
```

它不回答“哪个堆卡被修改”。这正是后面的 card post-barrier 要解决的问题。

---

## 六、card post-barrier：为什么写后记录字段所在卡

### 6.1 card 是粗粒度位置索引

G1 card table 把堆地址映射到卡表字节。`cardTable.hpp:152-161` 的 `byte_for` 本质上按地址右移找到对应卡；`card_shift` 在 `cardTable.hpp:229-234` 中为 9，所以一张卡覆盖 `1 << 9 = 512` 字节。

card 不是某个 oop，也不是 new value 的目标地址。它只是一个粗粒度位置标签：

```text
field 地址 → field 所在的 512-byte card → card 状态
```

这使 G1 可以用少量卡表信息先筛出“可能包含相关引用的区域”，而不是为每个引用维护一份昂贵的精确反向索引。

### 6.2 快路径先过滤 young card

`g1BarrierSet.inline.hpp:48-55` 的 post-barrier 先取目标字段对应的 card：

```cpp
volatile jbyte* byte = _card_table->byte_for(field);
if (*byte != G1CardTable::g1_young_card_val()) {
  write_ref_field_post_slow(byte);
}
```

当前 card 是 G1 young card 时直接返回。对于非 young card，才进入慢路径。

这里要注意：这段通用 C++ 实现没有在参数 `new_val` 上做 null 判断，也没有在这几行里做 same-region 判断。C1/C2 生成的机器码可能根据更强的编译期事实提前过滤，但不能把编译器优化倒灌成这段 C++ 函数的字面行为。

### 6.3 慢路径如何避免重复排队

`g1BarrierSet.cpp:99-114` 的慢路径完成剩下动作：

```text
storeload
  → 再读 card 状态
  → 如果还不是 dirty，写 dirty
  → 把 card 地址放入 dirty-card queue
```

如果 card 已经是 dirty，就不重复写入和排队。Java 线程使用线程绑定的 dirty-card queue，非 Java 线程使用共享队列。

注意两个队列记录的对象完全不同：

```text
SATB queue       → 旧 oop
Dirty-card queue → card 地址
```

前者供并发标记处理可能脱离快照的对象，后者供 card refinement 和 remembered-set 相关流程处理发生写入的堆位置。把二者统称为“GC 通知队列”会丢掉最关键的设计差异。

### 6.4 这不等于 G1 永远不扫描全堆

card 和 remembered set 的价值是让很多年轻代或混合回收只需定位与 collection set 相关的旧区引用，而不是扫描所有老区对象。

它不意味着 G1 从此不做全堆工作：

- G1 并发标记仍然要维护和追踪全堆对象图
- G1 Full GC 是全堆 mark/compact 路径
- dirty card log 在 Full GC 场景下可能被放弃，因为全堆处理已经让它失去意义

所以准确表述是：**card/remembered-set 让 G1 的许多分区回收避免扫描无关的老区对象，而不是让所有 GC 阶段都免除全堆处理。**

---

## 七、数组、arraycopy、native 和弱引用为什么不能套同一条路径

到这里如果只看普通堆内字段，很容易再次得出一个过度统一的结论：“所有引用访问都执行同一套 pre/store/post”。接下来用四个边界把这个结论拆开。

### 7.1 单个对象数组元素仍然是堆内 oop store

`objArrayOop.inline.hpp:47-56` 中，`obj_at_put` 使用：

```cpp
HeapAccess<IS_ARRAY>::oop_store_at(as_oop(), offset, value);
```

它和普通字段写入共享堆内引用访问的大框架，但额外声明了 `IS_ARRAY`。这个装饰器可以让 barrier backend 知道访问发生在数组元素语义中。

因此单元素对象数组写入可以复述为：

```text
数组元素语义
  → heap oop store
  → 由当前 barrier backend 决定具体 pre/store/post
```

基本类型数组不走这条 oop store 路径，因为元素不是引用；这与前篇 `TypeArrayKlass` 的成本模型相连。

### 7.2 arraycopy 不能简单展开成逐元素 store

对象数组批量复制如果真的对每个元素调用完整 `oop_store_at`，会重复计算地址、重复检查和重复触发 barrier。Access API 为 arraycopy 提供了范围语义。

`modRefBarrierSet.inline.hpp:93-108` 的典型顺序是：

```text
range pre(dst, length)
  → Raw::oop_arraycopy
  → range post(destination region)
```

范围 pre 可以一次处理目标区域的旧引用；raw arraycopy 执行实际批量复制；range post 让 GC 使目标区域对应的卡失效或重新记账。

如果目标是未初始化区域，`IS_DEST_UNINITIALIZED` 会让 range pre 跳过，因为目标没有需要保留的旧引用。这是“访问语义改变 barrier 需求”的直接例子。

### 7.3 native oop store 可能只有 pre，没有 heap card post

`g1BarrierSet.inline.hpp:97-106` 的 non-heap store 路径明确只做：

```text
SATB pre
Raw::oop_store
```

它没有 Java heap 中的目标卡，因此不能照搬 heap store 的 card post。这里说明 `IN_HEAP` 不是装饰性标签，而是决定 barrier 形态的真实位置语义。

### 7.4 OopHandle：元数据保存的是槽地址，不是直接嵌入的 oop

`OopHandle` 在 `oopHandle.hpp:38-55` 中只有一个 `oop* _obj`。它保存的是一个由 owner 管理的引用槽地址；`resolve()` 在 `oopHandle.inline.hpp:31-37` 中通过 `NativeAccess` 读取槽内当前 oop。

这与普通 `Handle` 不同：

```text
Handle
  → 线程本地 handle area
  → HandleMark 管理生命周期
  → 通常是临时 VM 句柄

OopHandle
  → 元数据持有一个长期槽地址
  → 生命周期由 owner 管理
  → 通过 NativeAccess 读取 native storage 中的 oop
```

例如 `Klass::_java_mirror` 使用强 `OopHandle`，由 `ClassLoaderData` 的强 handle 结构持有；它不是 Java heap 对象里直接嵌着一个普通 C++ oop 指针。

### 7.5 WeakHandle：槽可以被 GC 清成 NULL

`WeakHandle<T>` 使用 GC 以弱/phantom 语义处理的 OopStorage。`weakHandle.hpp:34-40` 明确要求使用者理解：GC 可以把槽内 referent 清成 null，调用方必须检查返回的 oop。

`resolve()` 和 `peek()` 的区别是 keepalive 语义：

```text
resolve()
  → 通过 ON_PHANTOM_OOP_REF 读取
  → 本次访问可以参与当前 GC cycle 的保活语义

peek()
  → 额外带 AS_NO_KEEPALIVE
  → 观察但不要求保活
```

两者都只断言“handle 有一个槽”，不保证槽内 referent 非空。不能把 `WeakHandle::resolve()` 写成“返回一个一定有效的对象”，也不能把 `OopHandle` 和 `WeakHandle` 简化成“强槽/弱槽各有一个 tag”：弱存储和生命周期由 owner、storage 类型和 GC traversal 共同决定。

### 7.6 OopStorage 不是连续数组，也不是原子批量更新器

`OopStorage` 的设计是 block 加 allocation bitmask。`oopStorage.hpp:61-66` 说明它由多个 block 组成，block 内有 oop 数组和已分配位图。

GC 遍历时，`oopStorage.inline.hpp:324-399` 通过位图找到已分配槽，再把槽地址交给 closure：

```text
强遍历：closure 可以更新槽内 oop
弱遍历：先判断存活，死对象槽清 NULL，活对象再交给 closure
```

它可以支持并行遍历，但不提供“所有槽位同一时刻原子更新”的魔法。移动 GC 仍然是逐槽或分块地调用 closure 更新引用。

---

## 八、成本不是一个固定数字，而是一组路径分布

现在可以回答一个实际问题：引用写入到底要付出多少 barrier 成本？不能简单回答“固定两次内存操作”。

### 8.1 可能的轻路径

一些场景会让工作很少：

- SATB 未激活，pre 的 enqueue 直接返回
- 旧值是 null，不产生 SATB 对象队列记录
- 目标是未初始化区域，跳过 pre
- 使用 `AS_NO_KEEPALIVE`，不产生对应 keepalive 行为
- post 发现目标是 young card，直接返回
- post 慢路径发现 card 已经 dirty，不重复排队
- 编译器证明写入是初始化、null 或不需要某种 barrier

### 8.2 可能的重路径

当本地队列满、线程不能使用本地队列、card 需要首次标脏或需要并发 refinement 时，会进入更重的路径：

```text
旧值读取和解码
  → SATB 缓冲写入或慢路径
  → 新值编码和存储
  → card 地址计算
  → storeload 与 dirty 检查
  → dirty card 写入和队列操作
```

具体机器指令数、是否调用 runtime stub、是否被编译器消除，都依赖平台、GC、访问类型、队列状态和编译结果。本文不把它压成一个固定 cycle 数字。

### 8.3 七个最容易错的判断

1. **Access API 是否每次访问都动态选择当前 GC？** 不是。C++ runtime path 是特定 dispatch 实例第一次调用时懒解析；C1/C2 在编译期走各自后端。
2. **C1/C2 是否调用 C++ runtime resolver？** 不是普通已编译访问路径；它们把访问降成自己的 IR、inline barrier 和可能的 slow path。
3. **`AS_RAW` 是否等于任意内存访问？** 不是。它绕过 GC access barrier，但仍受编码、原子性和内存序约束。
4. **`AS_NO_KEEPALIVE` 是否等于没有 barrier？** 不是。它改变保活语义，不能把所有位置和引用更新要求一起删掉。
5. **pre/post 是否固定各做一次内存操作？** 不是。SATB 和 card 路径都有 inactive、null、young card、dirty card、初始化和队列状态分支。
6. **card barrier 是否意味着 GC 完全不扫描堆？** 不是。它减少很多分区回收扫描无关老区对象的需要，但并发标记和 Full GC 仍有全堆工作。
7. **`OopHandle` 是否天然由 OopStorage 支撑？** 不是。强 `OopHandle` 也可能由 `ClassLoaderData` 的 chunked handle list 支撑；`WeakHandle` 才明确使用按类型选择的弱 OopStorage。

---

## 九、收网：调用方只声明语义，GC 负责兑现协议

现在把全文压回开头的 `obj.field = value`：

```text
调用方
  → 声明 heap/native、array、keepalive、内存序等 DecoratorSet

Access API
  → 编译期验证组合
  → 补齐默认装饰器
  → 将访问分流到 runtime dispatch 或 compiler backend

G1 heap oop store
  → pre：保存将被覆盖的旧 oop
  → raw store：编码并写入新 oop
  → post：记录 field 所在 card

GC
  → SATB 消费旧 oop 队列
  → card refinement / remembered-set 流程消费 dirty card
  → 移动或清理 OopStorage 中的 metadata 引用槽
```

三个结论分别对应三层设计：

- **Access API 的价值不是隐藏一次函数调用，而是建立一套描述访问语义的共同语言。**
- **G1 pre-barrier 和 post-barrier 记录的是两种不同信息：旧引用和修改位置。**
- **C++ runtime、x86 assembler、C1/C2 都消费同一套语义，但用不同后端把它落成函数、机器码或编译器 IR。**

下一篇不再继续扩大 barrier 机制，而是转向 JVM 如何管理那些反复出现的元数据名字：`java/lang/String`、字段签名和注解类型为什么不能每次都分配一份字符串。

> → [06-symbol-annotations-aux.md](06-symbol-annotations-aux.md)
