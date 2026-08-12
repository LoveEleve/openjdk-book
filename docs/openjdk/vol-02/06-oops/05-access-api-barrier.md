# 05. Access API — 每次引用读写,GC 都在旁听

> **前置依赖**:[03 — InstanceKlass 与数组](03-instanceklass-arrayklass.md):`obj_at/obj_at_put` 走的 HeapAccess 就是本篇的入口;[04 — 常量池与解析](04-constantpool-method.md):解释器与 JIT 是 barrier 的消费方
> → **后续**:[06 — Symbol 与注解](06-symbol-annotations-aux.md)
> 关联域: 25-gc(G1 SATB/card table)、13-jit(barrier 代码生成)

## obj.field = value 不是一条 mov

`this.region = anotherRegion` 在 Java 层是一行赋值,在 JVM 里是一条**被 GC barrier 包围**的写——G1 下,写引用前要把旧值记录进 SATB 队列(并发标记的快照),写完后要把对象所在卡标记为 dirty(remembered set 的粒度)。这套插入对调用方完全透明: 解释器模板与 C++ 运行时走 Access API,JIT 通过各自的 barrier 代码生成器(C1/C2 的 BarrierSetAssembler),同一套语义,barrier 由模板在编译期组合、由运行时按当前 GC 选择。这篇拆这条看不见的通道: 装饰器怎么组合、G1 的两道 barrier 各管什么、以及元数据持有的引用(OopHandle/WeakHandle)怎么安全地被 GC 管理。

## 1. Access 模板: 装饰器与 barrier 的组合

所有受保护的引用访问都从一个模板出发(access.hpp:94-95,截取核心,逐字):

```cpp
// access.hpp:94-95(截取核心,逐字)
template <DecoratorSet decorators = INTERNAL_EMPTY>
class Access: public AllStatic {
```

调用形如 `Access<IN_HEAP | MO_UNORDERED>::load(addr)`、`Access<IS_ARRAY>::oop_store_at(...)`——装饰器集合是模板参数,在**编译期**组合。装饰器有分组(accessDecorators.hpp:37 起,uint64_t 位集):

- **内存序**: `MO_UNORDERED`(默认,等价 JMM plain)、`MO_RELAXED`(opaque)、`MO_ACQUIRE`、`MO_RELEASE`、`MO_SEQ_CST`(volatile)——定义在 :129-137,与 C++11 原子语义一一对应;
- **位置**: `IN_HEAP`(:182,堆内)/ `IN_NATIVE`(:183,堆外但指向堆内);
- **语义开关**: `AS_RAW`(:155,裸访问不插 barrier,VM 内部用)、`IS_ARRAY`(:191,数组特例)、`IS_NOT_NULL`(:193,允许更快的压缩 oop 路径)。

- [C++: 装饰器是 uint64_t 位集(accessDecorators.hpp:37),模板用 `HasDecorator<decorators, X>::value` 在编译期判断(accessDecorators.hpp:44-45)——哪个分支被编译、哪些 barrier 被内联,写代码时就定死了]

**从模板到具体 GC**: 调用展开到 `AccessInternal::AccessFunction`(accessBackend.hpp:60-71 的 BarrierType 枚举按操作分类: STORE/LOAD/ATOMIC_CMPXCHG/ARRAYCOPY……),最终落到 `BarrierSet::AccessBarrier<decorators, BarrierSetT>`(barrierSet.hpp:167)——GC 子类通过特化自己的 AccessBarrier 覆盖默认行为。注意这里的"选型"是**运行时解析**的: `resolve_barrier()`(access.inline.hpp:269-270)在第一次访问时按当前 BarrierSet 取函数指针——注释原文 "Its accessors will then be automatically resolved at runtime"(barrierSet.hpp:162-165)。

**关键设计 (斜体)**: *装饰器在编译期组合、barrier 在运行时选择——写访问代码的人不需要知道当前是什么 GC,GC 换实现也不用改访问代码。两条轴正交: 调用方声明"我要什么语义",GC 决定"怎么实现语义"。JIT 编译时 barrier 已经确定,C2 直接内联生成带 barrier 的机器码,热路径上零函数调用。*

## 2. G1 的两道 barrier: SATB 与卡表

### 2.1 Pre-barrier: 写前记录旧值

G1 的并发标记需要"快照"语义: 标记开始那一刻,活对象集合就被钉住了——之后被修改的引用旧值必须记录,否则标记会漏对象。这就是写前的 **SATB**(Snapshot-At-The-Beginning,开始时刻快照)barrier(g1BarrierSet.inline.hpp:36-46,截取核心,逐字):

```cpp
// g1BarrierSet.inline.hpp:36-46(截取核心,逐字)
inline void G1BarrierSet::write_ref_field_pre(T* field) {
  if (HasDecorator<decorators, IS_DEST_UNINITIALIZED>::value ||
      HasDecorator<decorators, AS_NO_KEEPALIVE>::value) {
    return;
  }

  T heap_oop = RawAccess<MO_VOLATILE>::oop_load(field);
  if (!CompressedOops::is_null(heap_oop)) {
    enqueue(CompressedOops::decode_not_null(heap_oop));
  }
}
```

机制: 读旧值 → 非空则入队。入队目标是**线程绑定的 SATB 队列**(Java 线程入自己的本地队列,非 Java 线程直接入共享队列,g1BarrierSet.cpp:62-69);本地缓冲满后整块转交队列集合,由并发标记线程消费。正常路径只是往本地缓冲里存一个指针,很快;两个装饰器(`IS_DEST_UNINITIALIZED`/`AS_NO_KEEPALIVE`)让"写向全新对象"和"不保活的偷看"跳过这一步。

### 2.2 Post-barrier: 写后标记卡

写完后,G1 要把对象所在"卡"(512 字节区域)标记为 dirty——remembered set 的索引粒度。`write_ref_field_post`(g1BarrierSet.inline.hpp:48-56,截取核心,逐字):

```cpp
// g1BarrierSet.inline.hpp:48-56(截取核心,逐字)
inline void G1BarrierSet::write_ref_field_post(T* field, oop new_val) {
  volatile jbyte* byte = _card_table->byte_for(field);
  if (*byte != G1CardTable::g1_young_card_val()) {
    // Take a slow path for cards in old
    write_ref_field_post_slow(byte);
  }
}
```

卡表本身是字节数组,卡号 = 地址右移卡大小对数(`byte_for` 的实现: `&_byte_map_base[uintptr_t(p) >> card_shift]`,cardTable.hpp:153-158)。快速路径: 取卡字节,是年轻代卡就不动(年轻代引用由 GC 另行处理),否则慢路径标 dirty。

**关键设计 (斜体)**: *pre 记"旧值"、post 记"位置",两件事缺一不可: 并发标记靠旧值防漏,增量回收(remembered set)靠位置定位脏卡。barrier 的成本是每引用写一两次内存操作,换来 GC 不用全堆扫描——这正是"引用读写有旁听"的全部意义。*

## 3. OopHandle 与 WeakHandle: 元数据里的安全引用

### 3.1 OopHandle: 一个 `oop*` 的封装

Klass 的 `_java_mirror`、各类元数据持有的对象引用,用 OopHandle 封装(oopHandle.hpp:38-55,截取核心,逐字):

```cpp
// oopHandle.hpp:38-55(截取核心,逐字)
class OopHandle {
private:
  oop* _obj;

public:
  OopHandle() : _obj(NULL) {}
  OopHandle(oop* w) : _obj(w) {}
  ...
  inline oop resolve() const;
```

它**不是**存储里的下标,就是一个 `oop*`——指向 GC 管理的内存槽(通常是 OopStorage 分配的槽)。封装的目的是"命名清晰 + 为未来读屏障留位"(头注释 :34-36)。取用 `resolve()`(oopHandle.inline.hpp:31-33,逐字):

```cpp
// oopHandle.inline.hpp:31-33(逐字)
inline oop OopHandle::resolve() const {
  return (_obj == NULL) ? (oop)NULL : NativeAccess<>::oop_load(_obj);
}
```

### 3.2 WeakHandle: 弱处理存储里的引用

WeakHandle 是存在"弱处理 OopStorage"里的引用(weakHandle.hpp:45-60): 头注释写明 "This is the vm version of jweak"——GC 按弱引用处理槽里的对象,只剩弱引用时槽被清成 NULL,持有方必须判空。按用途选存储: `get_storage()` 依类型返回对应的 OopStorage(weakHandle.cpp:35-39)。

- [C++: 强/弱不是"槽上加 tag",是**不同的 OopStorage 实例**各配一套 GC 策略——弱存储的槽在 GC 清理后置 NULL,`resolve()`/`peek()` 由调用方判空]
- [C++: 别和 `Handle`(handles.hpp:64)混淆: Handle 是栈上临时句柄,构造/析构自动管理;OopHandle/WeakHandle 是元数据里的长期引用,生命周期由拥有者控制]

**关键设计 (斜体)**: *元数据(类镜像、字符串表等)持有的引用不能散落各处让 GC 逐个找——OopStorage 把它们集中到连续的槽区,GC 一次遍历一个存储就处理完所有该类的引用,清理(弱)或更新(强)都是批量操作。引用从"散点"变成"一张表"。*

## 核心悬念

引用读写的旁听体系到齐: Access 模板编译期组合语义、运行时按 GC 选 barrier、G1 的 SATB 快照与卡表、元数据引用的 OopStorage 集中管理。但还有一个高频对象没解决——字符串。`"java/lang/String"` 这个名字在类文件、类名、字段签名里出现成千上万次,每个都存一份就是内存灾难。下一篇: Symbol 与注解——JVM 怎么让一个字符串全 JVM 只有一份。

> → [06-symbol-annotations-aux.md](06-symbol-annotations-aux.md)
