# 01. 对象头 — 一个 word,五种身份

> **前置依赖**:[05-cpu-primitives/01 — 原子与内存序](openjdk/vol-02/05-cpu-primitives/01-atomic-and-memory-order.md):CAS 是对象头状态流转的核心原语;上篇 [04-logging/02](openjdk/vol-02/04-logging/02-output-and-configuration.md) 里 GC 日志报的对象变化,观察的正是本篇的对象头
> → **后续**:[02 — Klass 层次](02-klass-hierarchy.md)
> 关联域: 18-safepoint(GC 与对象头)、19-sync(锁: 对象头状态机)、25-gc(forwarding 指针)

## new Object() 的 16 个字节

Java 里一个空的 `new Object()` 占多少内存?在 64 位 JVM 的默认配置(压缩指针由 ergo 打开)下: **16 字节**。其中 12 字节是对象头——第一个 word(8 字节)是 mark word,第二个 word 在压缩模式下只算 4 字节,指向类元数据 Klass——剩下 4 字节是对齐填充,对象没有字段,数据区为零。这篇拆这个 12 字节的头: 一个 word 怎么装下身份哈希、分代年龄、三种锁状态和 GC 转发指针,以及第二个 word 的类指针怎么压成 4 字节。

## 1. oopDesc: 对象的 C++ 骨架

所有 Java 对象的起始结构是 `oopDesc`(oop.hpp:55-63,逐字):

```cpp
// oop.hpp:55-63(逐字)
class oopDesc {
  friend class VMStructs;
  friend class JVMCIVMStructs;
 private:
  volatile markOop _mark;
  union _metadata {
    Klass*      _klass;
    narrowKlass _compressed_klass;
  } _metadata;
```

对象头两个字段: 8 字节 mark word + 类指针。压缩模式下类指针只占 4 字节(union 的高 4 字节与对象对齐填充重合,不额外占空间),所以头部的有效布局是 **12 字节**;对象按 8 字节对齐,`new Object()` 没有字段,数据区为零,12B 头补到 16B——整体就是 16 字节。

- [C++: `oop` 和 `markOop` 都不是类,是指针 typedef(oopsHierarchy.hpp:37-47): `typedef class oopDesc* oop;`、`typedef class markOopDesc* markOop;`——JVM 里"对象"就是 `oopDesc*`,`markOop` 就是 `markOopDesc*`,零包装开销。注意 `markOopDesc` 本身是类,只是通常以指针形态出现]
- [C++: `volatile markOop _mark`——mark word 会被其他线程(偏向锁撤销、GC 写 forwarding、同步器 CAS)并发改写,volatile 保证读取不被编译器缓存/重排]
- [C++: `union _metadata`——同一块 8 字节内存,开压缩类指针时按 4 字节 `narrowKlass` 读,不开时按 8 字节 `Klass*` 读;`oopDesc::klass()`(oop.inline.hpp:90-94)按 `UseCompressedClassPointers` 选成员,访问时再解码]

## 2. 一个 word,五种身份

### 2.1 位布局: 64 位全景

mark word 的位分配写死在注释里(markOop.hpp:44-54,逐字):

```cpp
// markOop.hpp:44-54(注释逐字)
//  64 bits:
//  --------
//  unused:25 hash:31 -->| unused:1   age:4    biased_lock:1 lock:2 (normal object)
//  JavaThread*:54 epoch:2 unused:1   age:4    biased_lock:1 lock:2 (biased object)
//  PromotedObject*:61 --------------------->| promo_bits:3 ----->| (CMS promoted object)
//  size:64 ----------------------------------------------------->| (CMS free block)
```

普通对象: 高 25 位未用 + **31 位 identity hash** + 1 位未用 + **4 位分代年龄** + 1 位偏向标记 + **2 位锁状态**。注意 64 位下 hash 是 31 位(32 位平台才是 25 位,见 :37-39);31 位能放约 21 亿个不同值,配合"0 表示未计算"足够日常使用。

偏向对象: 高 54 位是 `JavaThread*`(持有偏向的线程)+ 2 位 epoch(批量撤销的世代)+ 4 位年龄 + 偏向位 + 锁位——**同一份内存,连 age 都保留**,GC 不用为偏向对象特判年龄。

### 2.2 判断依据: 低 3 位

五种状态靠哪几个位区分?枚举(markOop.hpp:150-155,逐字):

```cpp
// markOop.hpp:150-155(逐字)
  enum { locked_value             = 0,
         unlocked_value           = 1,
         monitor_value            = 2,
         marked_value             = 3,
         biased_lock_pattern      = 5
  };
```

低 **2 位**是锁状态,第 **3 位**是偏向位。组合起来:

| 低 3 位 | 状态 | word 的其余部分 |
|--------|------|----------------|
| `000`(lock=00) | 轻量锁 | 指向**栈上** BasicLock 的指针(原 mark word 被备份到栈帧) |
| `001`(lock=01,偏向位 0) | 无锁 | 31 位 hash + 4 位年龄 |
| `010`(lock=10) | 重量锁 | 指向 ObjectMonitor 的指针 |
| `011`(lock=11) | GC 标记/转发 | forwarding 地址(markSweep 标记、GC 搬移后指新位置) |
| `101`(lock=01,偏向位 1) | 偏向锁 | 54 位 `JavaThread*` + 2 位 epoch + 4 位年龄 |

- [x86: 为什么状态位放在最低位?对象按 8 字节对齐(`ObjectAlignmentInBytes = 8`,globals.hpp:245),所有对象地址低 3 位恒为 0——这 3 个"免费的位"天然适合做 tag。判状态就是掩掉低 2 位(或低 3 位)再比较——一两条指令]

### 2.3 无锁态: identity hash 与分代年龄

`System.identityHashCode()` 返回的值存在 mark word 的 31 位里,而且是**惰性生成**: 第一次调用才计算并安装(synchronizer.cpp:754-760,截取核心,逐字):

```cpp
// synchronizer.cpp:754-760(截取核心,逐字)
    hash = get_next_hash(Self, obj);  // allocate a new hash code
    temp = mark->copy_set_hash(hash); // merge the hash code into header
    // use (machine word version) atomic operation to install the hash
    test = obj->cas_set_mark(temp, mark);
    if (test == mark) {
      return hash;
    }
```

`get_next_hash`(synchronizer.cpp:669-703)按 `hashCode` flag 选算法——默认值 5(globals.hpp:875,experimental flag)走 Marsaglia xor-shift(线程私有状态,每线程独立序列);选项 0 是 Park-Miller 全局随机数。生成后 `value &= hash_mask` 截断到 31 位,为 0 就改成 0xBAD 占位(synchronizer.cpp:700-702),保证"0 = 未计算"语义成立。**CAS 失败就膨胀成重量锁**: 注释写明 "we must inflate the header into heavy weight monitor"(synchronizer.cpp:760-762)——mark word 被别的线程动过时,hash 改存进 ObjectMonitor 的 header,之后从 monitor 里读(:764-770),而不是简单重试。

- [C++: 为什么 hash 不直接用对象地址?GC 搬对象,地址会变——hash 必须跟随对象一生不变,只能存进对象自己的头。这也是 `System.identityHashCode` 和 `Object.hashCode()`(可被覆写)的根本区别: 后者是普通方法,前者是 mark word 里的固化值]

分代年龄: `age()` 4 位(0-15,markOop.hpp:328),每次 minor GC 幸存一次 `incr_age()` 加一(:333),到 `MaxTenuringThreshold`(默认 15,gc_globals.hpp:699)就晋升老年代。

### 2.4 偏向锁态: 低 3 位 101

对象"单线程反复加锁"的场景太常见,偏向锁让**第一次加锁的线程**把 word 改成 `线程指针 + 年龄 + 101`,之后这个线程再加锁解锁只做一次位测试,零原子操作。判断函数 `has_bias_pattern()`(markOop.hpp:173-175):

```cpp
// markOop.hpp:173-175(逐字)
  bool has_bias_pattern() const {
    return (mask_bits(value(), biased_lock_mask_in_place) == biased_lock_pattern);
  }
```

掩掉低 3 位以上,比 `5`(101)——这就是"偏向锁不是 lock 位等于 1,而是 lock=01 且偏向位=1"的源码证据。其他线程抢锁时,先撤销偏向(revoke),把 word 恢复成普通无锁态再走轻量级流程。

### 2.5 轻量锁与重量锁: 栈上备份与 ObjectMonitor

- **轻量锁**(lock=00): 加锁时把 mark word 原样备份到栈帧的 BasicLock(displaced mark word),再用 CAS 把 word 指向这个栈上位置(markOop.hpp:92 注释 "ptr points to real header on stack")。解锁 CAS 还原。为什么能这么做: 锁是"线程私有到解锁"的,栈上位置天然线程私有。
- **重量锁**(lock=10): 竞争激烈(或轻量锁失败)就膨胀,word 指向 ObjectMonitor(markOop.hpp:94 注释 "inflated lock")。注意 ObjectMonitor 分配在 **C 堆**(`omAlloc`,synchronizer.cpp:1100,全局空闲链表 gFreeList :119),不在 Java 堆——所谓"堆上重量级锁"指的是 C 堆,不是 Java 对象堆。

- [C++: monitor() 取指针用 `value() ^ monitor_value`(markOop.hpp:276-279)——xor 而不是 and-not,注释说 "to provide one extra tag-bit check": 如果低 2 位不是 10,结果就是个野指针,越早暴露越好的调试意图]

### 2.6 GC 转发态: 搬走之后留一张纸条

GC 把对象从年轻代拷到幸存区后,旧位置不能空着——所有还指向旧地址的引用要靠它找到新家。旧位置的 mark word 被覆写成 forwarding 指针: 目标地址的低 2 位 OR 上 11(marked)。

```cpp
// oop.inline.hpp:341-346(逐字)
// Used by scavengers
bool oopDesc::is_forwarded() const {
  // The extra heap check is needed since the obj might be locked, in which case the
  // mark would point to a stack location and have the sentinel bit cleared
  return mark_raw()->is_marked();
}
```

```cpp
// oop.inline.hpp:349-361(截取核心,逐字)
void oopDesc::forward_to(oop p) {
  ...
  markOop m = markOopDesc::encode_pointer_as_mark(p);
  assert(m->decode_pointer() == p, "encoding must be reversable");
  set_mark_raw(m);
}
```

`encode_pointer_as_mark(p) = markOop(p)->set_marked()`——就是"指针 | 11"(markOop.hpp:356)。读旧位置时先查 `is_forwarded()`,是就调 `forwardee()` 拿新地址——实现就是 `mark_raw()->decode_pointer()`(oop.inline.hpp:398-400),把低 2 位清掉。**关键设计 (斜体)**: *转发不需要额外字段——对象被搬走后,旧位置的头就是唯一的寻址线索;任何线程(其他 GC 线程、应用线程读引用)走到旧地址都能一步找到新地址,而"转发+年龄"不能并存——搬走的对象已经不需要年龄了,这 8 字节空间恰好腾出来。*

**关键设计 (斜体)**: *五种身份共用一个 word,靠低位位测试区分,没有标志位数组、没有对象级别字段。代价是状态切换必须原子(全部 CAS),而且身份之间互相排斥: mark 里写入 hash 后,低 3 位不再是 101——`biased_locking_enter` 的第一道位测试(掩低 3 位比 5,macroAssembler_x86.cpp:1142-1144)直接把它分流到普通锁路径,永远不会尝试安装偏向;identity hash 安装前也会先撤销已有偏向。有 hash 的对象与偏向锁从此无缘。内存省下来的每一分,都是语义耦合换的。*

## 3. 第二个 word: 压缩的类指针

### 3.1 从 8 字节到 4 字节

`_metadata` 的两种读法对应两种模式。64 位 JVM 上 `UseCompressedOops` 与 `UseCompressedClassPointers` 声明默认都是 false(globals.hpp:228,:232),但最大堆不超过 32G 减一页时由 ergo 自动打开(`set_use_compressed_oops`,arguments.cpp:1630-1644;类指针同源,:1661-1670)——所以常规配置下第二个 word 只占 4 字节,`Klass*` 被编码成"从压缩基址算起的偏移"。

### 3.2 编码与解码

```cpp
// compressedOops.inline.hpp:46-53(截取核心,逐字)
  inline oop decode_not_null(narrowOop v) {
    assert(!is_null(v), "narrow oop value can never be zero");
    address base = Universe::narrow_oop_base();
    int    shift = Universe::narrow_oop_shift();
    oop result = (oop)(void*)((uintptr_t)base + ((uintptr_t)v << shift));
```

解码 = `base + (v << shift)`;编码 = `(v - base) >> shift`(compressedOops.inline.hpp:59-71)。`shift` 和 `base` 是运行时按堆大小算的(universe.cpp:779-791):

- 堆顶 ≤ 4G(`UnscaledOopHeapMax`): shift=0、base=0——32 位偏移就是地址本身;
- 4G < 堆顶 ≤ 32G: shift=3、base=0——偏移左移 3 位;
- 堆顶 > 32G: shift=3、base=堆起点——**唯一的 base≠0 情形**,解码多一次加 base。

`shift` 来自 `LogMinObjAlignmentInBytes = exact_log2(ObjectAlignmentInBytes)`(arguments.cpp:1605),默认 8 字节对齐所以是 3;上限 `OopEncodingHeapMax = 4G << 3 = 32G`(定义在 globalDefinitions.hpp:520,值在 arguments.cpp:1609 算出)——32 位偏移左移 3 位可寻址 32G 空间,堆超过 32G 就不能压缩 oop 了。

- [x86: 打开压缩后,每个引用字段从 8 字节变 4 字节,引用密集的 64 位对象堆占用明显下降;读写多一到两条移位/加法指令——`decode_heap_oop` 的完整序列在 macroAssembler_x86.cpp:5543-5626。用几条算术指令换堆空间,GC 压力与缓存行占用都因此下降]

**关键设计 (斜体)**: *压缩的本质是"对齐位免费"的逆向运用: 对象 8 字节对齐,真实地址低 3 位恒 0,所以右移 3 位存储不丢信息——32 位存储 35 位寻址空间。与 mark word 用低 3 位做 tag 相反,一个是把低位信息挖出来用,一个是把低位冗余压掉省内存,同一件事的两面。*

## 4. is_oop: 对象身份的运行时验证

DEBUG 构建里处处验证"这确实是个 oop"(oop.cpp:121-137,截取核心,逐字):

```cpp
// oop.cpp:121-137(截取核心,逐字)
bool oopDesc::is_oop(oop obj, bool ignore_mark_word) {
  if (!Universe::heap()->is_oop(obj)) {
    return false;
  }

  // Header verification: the mark is typically non-NULL. If we're
  // at a safepoint, it must not be null.
  ...
  if (obj->mark_raw() != NULL) {
    return true;
  }
  return !SafepointSynchronize::is_at_safepoint();
}
```

两道检查: ① 地址在堆的已分配区域里(`Universe::heap()->is_oop`);② mark word 非空——mark 为空时,只有在 safepoint 外才可能是合法的(另一线程正在膨胀锁,mark 短暂为 0)。函数定义处的注释写明 "used only for asserts and guarantees"——**生产构建完全编译掉**,零运行时开销。

- [C++: 网上资料常写"is_oop 检查 Klass 指针是否在 Metaspace"——jdk11u 的实现没有这步;校验逻辑就这两条,且只在 ASSERT 构建生效]

## 核心悬念

对象头到此成形: 12 字节——mark word 用低 3 位区分无锁/偏向/轻量/重量/GC 五种身份,31 位 hash 惰性生成、CAS 安装,GC 搬移靠"指针|11"留纸条;第二个 word 在压缩模式下用"对齐位右移"把类指针压进 4 字节。但第二个 word 指向的 Klass 还是黑盒——对象怎么找到自己的类、虚方法怎么分发、类元数据本身长什么样,下一篇: Klass 层次。

> → [02-klass-hierarchy.md](02-klass-hierarchy.md)
