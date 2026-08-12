# 01. markOop — 一个 64-bit word, 五种身份

> 🔴 Deep | 15 KP 中的 2 个核心机制
> 读者处境: `new Object()` — 第一件创建的事不是构造函数，是往对象头写 mark word。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/06-oops/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **五种状态位布局全错(最严重)**: lock 是**低 2 位**,biased 是**第 3 位**。真实编码(markOop.hpp:150-155): locked=0(轻量,指向栈上 BasicLock)/unlocked=1(无锁)/monitor=2(重量,ObjectMonitor)/marked=3(GC 标记/转发)/**biased_lock_pattern=5(低 3 位 101)**。大纲"0 unlocked/1 biased/2-3 lightweight/4-5 inflated/6-7 GC"全部编造
> - **64 位 hash 是 31 位不是 25 位**(markOop.hpp:46: `unused:25 hash:31`);25 位是 32 位平台布局(:37-39)
> - **is_forwarded 不在 markOop.inline.hpp:35**: is_forwarded 在 oop.inline.hpp:341-346(= mark_raw()->is_marked());markOop.inline.hpp:34-48 是 must_be_preserved_with_bias;has_bias_pattern 在 markOop.hpp:173-175(不在 inline)
> - **行号漂移**: 状态枚举 :150-155(非 :50);value() :107(非 :80);oopDesc 结构 oop.hpp:55-63(非 :50-150);is_oop 在 oop.cpp:121-137(非 :40-80),且实现是"heap 范围 + mark 非空"两查,**无 KlassID/Metaspace 检查(编造)**
> - **markOop 是 typedef markOopDesc*(oopsHierarchy.hpp:43),markOopDesc 才是类**——"markOop 不是 class 是 typedef"表述颠倒
> - **ObjectMonitor 在 C 堆**(omAlloc,synchronizer.cpp:1100,gFreeList :119),不在 Java 堆
> - **Marsaglia xor-shift 默认说法需补充**: hashCode flag 默认 5(globals.hpp:875,experimental)走 xor-shift;选项 0 才是 Park-Miller(os::random)
> - **压缩三档**(universe.cpp:779-791): 堆顶≤4G → shift=0/base=0;4G<堆顶≤32G → shift=3/base=0;**>32G 才 base=堆起点**;OopEncodingHeapMax=32G 值在 arguments.cpp:1609(globalDefinitions.hpp:520 只是 extern)
> - **压缩开关是 ergo 打开**: UseCompressedOops/UseCompressedClassPointers 声明默认 false(globals.hpp:228/:232),堆≤32G 时 ergo 置 true(arguments.cpp:1640-1644/:1661-1670)
> - **hash 与偏向互斥**: mark 有 hash 后与类偏向原型不匹配,biased_lock_enter CAS 永不成功;identity hash 安装前先 revoke(FastHashCode,synchronizer.cpp:715-721)
> - MaxTenuringThreshold=15 ✓(gc_globals.hpp:699);age 4 位 ✓;volatile _mark ✓;identity hash 惰性+CAS ✓(synchronizer.cpp:754-760)

### 1. markOop — 5-in-1 压缩编码

场景: `new Object()` 创建了——在堆上分配了 16B (12B header + 4B padding)。第一 word (8B) 是 mark word。第二 word (4B compressed) 是 Klass 指针。这就是 Java 对象的物理表示——"万物皆对象"的底层真相。

**markOop 的五种状态** (`markOop.hpp:50-120` + `markOop.inline.hpp`):
- 同一 64-bit word——根据低 3 位的 lock 状态——解释为五种完全不同的结构:
  - 0 (unlocked): hash(25) + age(4) + biasedLock(1) + lock(2) = 32 bit (低 32 位)
  - 1 (biased): thread(54) + epoch(2) + age(4) + biased(1) + lock(2) — 偏向锁持有者线程 ID + GC epoch
  - 2-3 (lightweight): displaced mark word ptr(62) + lock(2) — 指向**栈上**备份的原始 mark word
  - 4-5 (inflated): ObjectMonitor ptr(62) + lock(2) — 指向**堆上**重量级锁对象
  - 6-7 (GC): forwarding ptr(62) + lock(2) — GC 拷贝对象后，旧位置**只留** forwarding 地址
- 源码链: `markOop.hpp:50` tag 枚举 → `markOop.hpp:80` value() 返回原始 64-bit → `markOop.inline.hpp:35` is_forwarded() 检查 GC 状态 → `markOop.inline.hpp:45` has_bias_pattern() 检查偏向锁
- [C++: markOop 是 `uintptr_t` 的强类型包装——不是 class，是 typedef——零额外内存。`inline` 函数 `is_forwarded()`、`has_bias_pattern()` 在调用处内联——1-2 条 x86 指令——无函数调用开销]
- [x86: 为什么用低 3 位做 tag？— 8 字节对齐——所有对象地址低 3 位永远是 000——可以用作 tag 位。解引用时 AND mask 清除低 3 位——恢复真实指针。类似 Linux 内核的 page 指针的 `PAGE_MASK` 技巧——利用对齐位存额外信息]
- [C++: `volatile markOop _mark`——为什么 volatile？——mark word 可能被 GC 线程并发修改 (forwarding ptr)。编译器不能 reorder mark word 读取——必须每次从内存读——不能用缓存在寄存器中的旧值]

**hash 与 age** (`markOop.hpp:60-75`):
- hash: 25-bit identity hash——`System.identityHashCode()` 返回——对象第一次被调用时计算
- [C++: identity hash 算法——不一定是对象地址 (GC 会移动对象)。JVM 默认用 Marsaglia XOR-Shift——存在 mark word 的高 25 位。lazy 计算: 第一次调 `hashCode()` → `if hash==0 → generate_hash() → CAS store to _mark`]
- [x86: identity hash——25-bit = 3,350 万个唯一值。hash 碰撞概率 ~1/33 million。如果碰撞——用 `0` (未计算)——不存——每次重新生成 (不同 seed)。GC age: 4-bit = 0-15——survivor 区每轮 GC age++——达到 MaxTenuringThreshold (默认 15)→晋升到 Old Gen]

**GC forwarding ptr** (`markOop.inline.hpp:50-65`):
- GC 移动对象: 新位置存完整对象→旧位置 mark word 被**覆写**为 forwarding pointer→所有引用旧对象的人通过 forwarded() 找到新位置
- [C++: `oopDesc::forwardee()`——检查 mark word→如果 is_forwarded()→取 forwarding address→返回新 oop。`oopDesc::forward_to(oop)`——CAS 把 mark word 设为 forwarding——CAS 失败说明其他线程已设置——用它的结果]

### 2. oopDesc — Java 对象的 C++ 物理表示

**oopDesc 结构** (`oop.hpp:50-150`):
- `volatile markOop _mark;` — 第一 word: mark word
- `union _metadata { Klass* _klass; narrowKlass _compressed_klass; }` — 第二 word: Klass 指针
- [C++: union——为什么用 union？— compressed oop 模式: 第二 word 解释为 32-bit narrow Klass index (4B)。非 compressed: 解释为 64-bit Klass* (8B)。union 让两种模式共享同一内存——根据 UseCompressedClassPointers 在访问时选择 active member]
- [C++: `oopDesc*` 是 oop 类型——所有 Java 对象的 C++ 起始地址。`oop->klass()` = `(UseCompressedClassPointers) ? decode_klass(_metadata._compressed_klass) : _metadata._klass`——返回 Klass*——从对象到类的逆向指针]

**sizeof(oopDesc)** = 12B (8B mark + 4B compressed klass) — padding 到 16B (8B 对齐)。**代码实测**: `System.out.println(org.openjdk.jol.info.ClassLayout.parseInstance(new Object()).toPrintable())` → `OFFSET  SIZE   TYPE DESCRIPTION / 0 4 (object header) / 4 4 (object header) / 8 4 (object header) / 12 4 (loss due to alignment)`

**is_oop 验证** (`oop.cpp:40-80`):
- `oopDesc::is_oop()`: Klass* 不是 nullptr——Klass 有有效的 KlassID——Klass* 在 Metaspace 范围内
- [C++: is_oop 是 DEBUG only——生产环境不调用。`#ifdef ASSERT` 包裹——只在 fastdebug/slowdebug build 使用。release build 完全编译掉——零运行时开销]

**compressed oop** (`compressedOops.inline.hpp`):
- `encode_heap_oop(oop)`: `(narrowOop)((uintptr_t)oop - heap_base) >> LogMinObjAlignmentInBytes` (移 3 位)
- `decode_heap_oop(narrowOop)`: `(oop)(((uintptr_t)narrowOop << LogMinObjAlignmentInBytes) + heap_base)`
- [x86: encode = shrq 3, decode = shlq 3 + addq heap_base——两条指令。heap_base ≠ 0 时 (heap >4GB) 加 1 cycle。LogMinObjAlignmentInBytes = 3 (8B 对齐)——低 3 位 = 000——32-bit narrow oop 可表示 2^32 * 8B = 32GB heap]

---

### 核心悬念

**"同一个 64-bit——有时是 hash+age，有时是线程 ID，有时是 GC forwarding 地址——低 3 位 tag 是唯一的判断依据。"** — markOop 的五种状态都复用同一 word。GC forwarding ptr 是 GC 搬对象后留下的——旧位置只剩 forwarding 地址——所有引用通过它找到新位置。oopDesc 的 union 让压缩和非压缩模式共享同一内存——物理对象最小化到 12B。下一篇: 类是什么——Klass 层次。

> → [02-klass-hierarchy.md](02-klass-hierarchy.md)
