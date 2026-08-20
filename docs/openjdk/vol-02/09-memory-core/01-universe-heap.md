# 01. Universe 与 CollectedHeap：JVM 为什么要先造地基，后造世界

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论。本文聚焦 JVM 启动早期的 `Universe` / `CollectedHeap` / `MemAllocator` 协议，说明“堆、类宇宙、镜像和第一批对象”是如何被分阶段点亮的。
> **前置依赖**：[07-classfile-classloader/07 — javaClasses](../07-classfile-classloader/07-javaclasses-core-mirrors.md)：basic type mirrors、fixup mirror list 和 String/Class offset contract 的时序在这里闭合；[07-classfile-classloader/04 — SystemDictionary](../07-classfile-classloader/04-system-dictionary.md)：well-known classes 在 `genesis` 中落地；[06-oops/02 — Klass 层次](../06-oops/02-klass-hierarchy.md) 与 [06-oops/03 — InstanceKlass / ArrayKlass](../06-oops/03-instanceklass-arrayklass.md)：primitive array klass 与 mirror 家族的前置概念
> → **后续**：[02 — VirtualSpace](02-virtualspace.md)
> 关联域：06-oops、07-classfile-classloader、25-gc、10-metaspace、16-code-cache

## 第一个 Java 对象出生前，JVM 靠什么活着

从 Java 代码看，一切对象都像是从 `new` 开始的：

```java
new Object()
```

可 JVM 自己在真正执行第一条 Java 方法前，就已经需要很多“像对象一样”的东西：

- GC 堆本身
- primitive array klass
- `Object` / `String` / `Class` 这些 well-known 类
- primitive mirrors，比如 `int.class`
- 若干 canonical metadata arrays
- 预分配的 OutOfMemoryError

于是问题就变得反直觉了：

```text
在还没有完整 Java 世界时
JVM 靠什么把第一批类和对象生出来？
```

如果回答只是“`Universe::genesis()` 会创建它们”，还不够，因为：

- 先得有 heap substrate，否则对象无处可放
- 还得先有一小截类宇宙，否则连镜像和数组 klass 都没法组织
- 更麻烦的是，有些 canonical thing 根本不是 Java heap 对象，而是 metaspace metadata arrays
- 有些对象，比如 empty `Class[]` 和 OOME 预分配，又明显出现在更晚的 post-init 阶段

所以本文真正的问题是：

**JVM 在启动时为什么要把“选 GC、造堆、引导类宇宙、修镜像、预分配异常对象、建立正常对象分配协议”拆成多段？`Universe` 到底为什么不像一个“全局变量袋子”，而更像一个把这几段顺序串起来的引导台？**

先把全篇主线画出来：

```text
init_globals()
  │
  ├─ universe_init()
  │    ├─ GCConfig 已选定 collector
  │    ├─ Universe::create_heap()      -> 只构造 CollectedHeap C++ 对象
  │    ├─ CollectedHeap::initialize()  -> reserve/aux mappings/barriers
  │    ├─ metaspace / CLD / SymbolTable / StringTable
  │    └─ heap substrate ready
  │
  ├─ interpreter_init / stubs / ...
  │
  ├─ universe2_init()
  │    └─ Universe::genesis()
  │         ├─ _bootstrapping = true
  │         ├─ primitive TypeArrayKlass objects
  │         ├─ canonical metadata arrays
  │         ├─ vmSymbols + SystemDictionary::initialize()
  │         ├─ String/Class offsets, primitive mirrors, mirror fixups
  │         ├─ Object[] klass, sentinel strings
  │         └─ minimal class universe ready
  │
  ├─ javaClasses_init()
  │
  └─ universe_post_init()
       ├─ fully_initialized = true
       ├─ vtable/itable post bootstrap repair
       ├─ canonical empty Class[]
       ├─ preallocated OOME pool
       └─ known methods / late canonical objects
```

一句话先记住：

**`Universe` 不是“存全局单例的袋子”，而是 JVM 启动里的引导台：先把堆和基础设施立起来，再造最小类宇宙，再补镜像和 canonical objects，最后才把普通对象分配协议交给 `CollectedHeap` 与 `MemAllocator` 的日常路径。**

---

## 一、三个看似更简单的方案，为什么都不够

### 1.1 一次性同时创建堆、类、镜像和对象

最直觉的启动方案就是：

```text
启动时统一 new 出 heap
同时加载 Object/String/Class
同时把所有 mirrors 和 canonical objects 都造好
```

这个方案的问题是依赖环根本拆不开。

比如：

- `java.lang.Class` mirror 本身需要 `Class_klass` 可用
- 但很多更早创建的 klass 又需要先把 mirror 延迟登记起来
- primitive array klass 的部分初始化依赖 `Object` vtable 尺寸
- `Object[]` klass 又依赖 `Object_klass()` 已存在

如果想“一步到位”，最后往往会变成到处判断“这个东西此刻是不是还没完全初始化好”。HotSpot 选择的是把引导顺序显式分段，让每一段只依赖前一段已经保证可用的最小骨架。

### 1.2 `create_heap()` 一步完成所有堆初始化

另一个常见误解是把：

```cpp
Universe::create_heap()
```

理解成“这里就把 Java heap reserve/commit 完了”。实际上它只是：

```text
根据已选 GCArguments
构造具体 CollectedHeap C++ 对象
```

真正的虚拟地址 reserve、辅助映射、barrier set 初始化、初始扩容，都在：

```cpp
_collectedHeap->initialize()
```

这个分层非常重要，因为它把：

- **选哪个 GC / 构造哪个 heap object**
- **这个 heap object 如何初始化地址空间和内部结构**

拆成了两步。

### 1.3 把所有预分配对象都混叫成“genesis 第一批对象”

现稿里最容易写混的是：

- metaspace canonical arrays
- primitive mirrors
- `"null"` / `"-2147483648"`
- empty `Class[]`
- preallocated OOME pool
- `non_oop_word` sentinel

它们都和“启动早期特殊对象”有关，但并不都在同一时刻、同一种存储区域、用同一种目的被创建。

如果一股脑都叫“genesis 第一批对象”，会模糊三个关键区别：

```text
metaspace metadata arrays
heap-side canonical Java objects
error/sentinel objects for failure or compiled metadata paths
```

这三层必须拆开讲。

---

## 二、`init_globals`：为什么 Universe 夹在解释器、stubs 和 javaClasses 之间

`init_globals()` 的顺序在 `init.cpp:101-127`。最关键的中段是：

```cpp
jint status = universe_init();
...
gc_barrier_stubs_init();
interpreter_init();
...
SharedRuntime::generate_stubs();
universe2_init();
javaClasses_init();
referenceProcessor_init();
```

这条顺序很值得慢慢看。

### 2.1 `universe_init()` 先于解释器和 `javaClasses_init`

这意味着：

- heap substrate、metaspace、symbol/string tables 等必须先就绪
- 解释器与 runtime stubs 的生成建立在已经存在的基础设施之上
- 但真正的类宇宙（`genesis`）和 bulk `javaClasses` offset contract 还没完成

也就是说，JVM 不是“先把所有 Java 世界都准备好，再生成解释器”。它把解释器和 runtime stubs 插在 heap substrate 与 class universe 之间。

### 2.2 `universe2_init()` 和 `javaClasses_init()` 又是两步

`universe2_init()` 调的是 `Universe::genesis()`。而 `javaClasses_init()` 则是更晚的 offset 计算与检查步骤。

这个顺序说明：

```text
先点亮最小类宇宙
  → 再完成更全面的 Java offset/access contract
```

这也解释了为什么 `String`/`Class` 的 offset 会先算，PART2 再 bulk compute。

### 2.3 `Universe` 真正承担的是分阶段引导，而不是简单持有指针

光看 `_collectedHeap`、`_the_empty_int_array`、`_the_null_string` 这些静态字段，Universe 很容易被误看成“全局仓库”。

但从 `init_globals` 的插入位置能看出来，它更重要的角色是：**确保每个子系统只在自己的依赖地基已经到位后再往前走。**

这一点后面会越来越明显。

---

## 三、`universe_init()`：先把能承载世界的地基搭出来

### 3.1 `universe_init` 做的是 substrate，不是完整 Java 世界

`Universe::universe_init()` 在 `universe.cpp:675-750` 中做的事很杂，但可以被压成一个清晰的主题：**先准备堆与元数据基础设施。**

它会：

- 检查对象/heap word 对齐与基本假设
- `compute_hard_coded_offsets()`
- 初始化 metaspace 相关状态
- 调 `initialize_heap()`
- 准备 null CLD
- 建 `LatestMethodCache`
- 创建 `SymbolTable` / `StringTable`
- 初始化 resolved-method table

这里要强调：很多“Java 世界必需的对象”其实在这一步还没出现。它建立的是承载这些对象的 substrate。

### 3.2 GC 的选择在 `Universe::create_heap()` 之前已经决定了

`Universe::create_heap()` 只是：

```cpp
return GCConfig::arguments()->create_heap();
```

而 `GCConfig::arguments()` 在更早的参数/ergonomics 初始化中就已经选好了一个 `GCArguments`。是否 `UseG1GC`、`UseSerialGC`、以及 server-class 机器上的默认选择，都在 `GCConfig::select_gc()` 那一层决定。

所以叙事上应该是：

```text
先由 arguments / GCConfig 决定 collector family
再由 Universe 按这个选择去构造具体 heap object
```

不要写成 “Universe 选择了 GC”。

### 3.3 `create_heap()` 只构造 C++ heap object，虚拟内存工作在 `initialize()`

这是本篇必须反复强调的一条边界。

以 G1 为例：

- `G1Arguments::create_heap()` 最终只是 `create_heap_with_policy<G1CollectedHeap, G1CollectorPolicy>()`
- 这个 helper 先 new policy，再 `new G1CollectedHeap(policy)`

而真正的 reserve / barrier set / region mapping / bitmap / card table 建立，在 `G1CollectedHeap::initialize()` 中才发生。`initialize()` 甚至把 “Reserve the maximum.” 直接写进了注释里。

因此应该把“堆诞生”拆成两步叙述：

```text
1. 选定 collector 后构造 heap C++ 对象
2. 调 virtual initialize() 真正建立 heap address space 与内部结构
```

### 3.4 `initialize_heap()` 的后半段还决定压缩 oop 和 TLAB 支持

`Universe::initialize_heap()` 在 heap `initialize()` 成功之后，还会：

- 根据 heap 边界计算 compressed oop base/shift
- 设置最大 TLAB 大小并启用 TLAB 初始化

所以 `initialize_heap()` 不是一个“简单转发到 collector initialize”的小 wrapper。它是 JVM 级 heap substrate 与 collector-specific 初始化的连接点。

到这里先收一个结论：**`universe_init()` 的产物不是“第一批类对象”，而是“足以承载后续类宇宙和对象出生的地基”。**

---

## 四、`Universe::genesis()`：为什么 primitive array klass 要先于 Object 镜像

### 4.1 `_bootstrapping` 不是装饰标志，而是允许“半成品世界”存在的许可证

`Universe::genesis()` 一开始就通过 `FlagSetting fs(_bootstrapping, true);` 把 `_bootstrapping` 打开。

这不是无关紧要的全局状态。它允许很多对象和 klass 暂时处于“还没补完关系”的中间态，例如：

- array klass 暂时不挂完整 superclass
- vtable 只拿到 base size，还没完整初始化
- 部分 mirror 先挂 fixup list，稍后补齐

也就是说，`_bootstrapping` 本质上是：

```text
允许 Universe 在最小可用前提下逐层点亮世界
```

### 4.2 第一批 freshly created klass 之一，是 primitive `TypeArrayKlass`

`genesis()` 最早的实质动作之一，是 `compute_base_vtable_size()` 之后创建 8 个 primitive `TypeArrayKlass`：

- boolean
- char
- float
- double
- byte
- short
- int
- long

这一步很反直觉，因为大家直觉上会以为 `Object` 或 `String` 更早。

真正原因在注释里已经给出：没有 base vtable size，就无法创建 array klass。也就是说，primitive array klass 之所以先出场，不是因为数组比 Object 更“根”，而是因为引导逻辑自己需要这类元数据骨架。

这里要把表述收紧：**它们是最早的一批 freshly created klass 之一，尤其在 non-CDS 路径里非常靠前；但不应把它绝对化成“所有环境下的第一个 klass”。**

### 4.3 canonical metadata arrays 紧跟其后，但它们不是 Java heap 数组

`genesis()` 紧接着创建：

- `_the_array_interfaces_array`
- `_the_empty_int_array`
- `_the_empty_short_array`
- `_the_empty_method_array`
- `_the_empty_klass_array`

这些全部来自 `MetadataFactory::new_array<T>`，本质是 metaspace 中的 `Array<T>*`，不是堆里的 Java 数组对象。

它们的作用是：

```text
为 class metadata、方法表、接口表、解析器等路径提供 canonical empty metadata containers
```

这就是为什么不能把它们写成“`new int[0]` 的全局缓存”。它们属于完全不同的层次。

### 4.4 `vmSymbols` 与 `SystemDictionary::initialize()` 在这里把最小类宇宙点亮

`genesis()` 先初始化 `vmSymbols`，然后调用 `SystemDictionary::initialize()`。这一步不是“顺手加载几个类”，而是把 minimal class universe 从纯 metadata 骨架推进到真正的 well-known classes：

- `Object`
- `String`
- `Class`
- 之后还有 `Reference`、boxes、method-handle 相关等

也正是在这个过程中，上一域的 String/Class offset contract 与 mirror fixup 开始闭合。

### 4.5 `"null"`、`"-2147483648"`、`Object[]` 都属于后续 canonical objects，但含义不同

`genesis()` 中还会 intern：

- `"null"`
- `"-2147483648"`

以及稍后取得 `Object[]` klass 并挂进 sibling list。

这些对象和前面的 primitive array klass、metaspace empty arrays 不应该混成一类：

- primitive array klass：类元数据骨架
- empty metadata arrays：metaspace canonical arrays
- `"null"` 等：heap-side canonical String 对象
- `Object[]` klass：在最小 class universe 成形后补上的普通对象数组 klass

这就是为什么“genesis 创造了第一批对象”必须具体分层讲，不能一句话打包。

---

## 五、well-known classes、primitive mirrors 与 mirror fixup：类宇宙是怎样被点亮的

### 5.1 `SystemDictionary::initialize()` 不是 class loading 附属动作，而是 genesis 的中枢

`SystemDictionary::initialize()` 先建字典表和一些基础对象，然后调用 `resolve_well_known_classes()`。

在这一步，`Object`、`String`、`Class` 会被最先落地。紧接着 `resolve_well_known_classes()` 就立即计算：

```cpp
java_lang_String::compute_offsets();
java_lang_Class::compute_offsets();
```

这说明它们不是“后面方便的时候再算”。相反，String/Class 的 offset contract 是后面 basic type mirrors 和 mirror fixup 的前提。

### 5.2 primitive mirrors 不是 parser 造的类，而是用 C++ 造的 `Class` 对象

`Universe::initialize_basic_type_mirrors()` 会创建 9 个 primitive mirror：

- `int.class`
- `float.class`
- `double.class`
- `byte.class`
- `boolean.class`
- `char.class`
- `long.class`
- `short.class`
- `void.class`

这些并不是通过解析某个 `java/lang/Int.class` 文件得到的，而是通过 `java_lang_Class::create_basic_type_mirror` 直接创建 mirror 对象，并记录在 `Universe::_mirrors` 中。

所以 primitive mirrors 是 JVM 引导世界里的“手工打造镜像”，不是一般 class loading 的产物。

### 5.3 fixup list 解释了为什么 `Class` 必须先可用，才能给老 klass 补镜像

在 `java.lang.Class` 自己还不可用时，一些 klass 已经存在了，但它们的 Java mirror 还不能分配。这些 klass 会被先推入 `_fixup_mirror_list`。

等 `String`/`Class` offset contract 先建立、primitive mirrors 先建好之后，`Universe::fixup_mirrors()` 再把这批“出生得太早的 klass”统一补镜像。

这说明 mirror 世界并不是和 klass 世界同时出现，而是：

```text
先有一部分 klass
再有 `java.lang.Class` 自己
再统一把早产 klass 的 mirror 补起来
```

### 5.4 `javaClasses_init()` 不是“第一次创建 mirrors”，而是完成更大范围的 offset contract

前文已经说过，`javaClasses_init()` 只做 PART2 的 bulk offset 计算与检查。真正的 String/Class offsets，以及 primitive mirrors 和 fixup mirror list 的核心闭合，已经在 `resolve_well_known_classes()` 里开始发生了。

所以 `javaClasses_init()` 的准确定位是：**在 minimal class universe 已点亮之后，补完更广泛的 well-known Java class offset contract。**

---

## 六、canonical metadata arrays、empty `Class[]`、OOME 池与 `non_oop_word`：为什么“预分配对象”不能混成一类

### 6.1 metaspace canonical arrays 不是 Java heap 数组

前面说过，`_the_empty_int_array`、`_the_empty_method_array` 等是 `MetadataFactory::new_array` 造出来的 metaspace `Array<T>*`。

它们服务的是：

- parser / metadata 路径
- 空方法表、空接口表、空 nest/member 元数据
- 某些字段/方法的 canonical empty metadata container

因此不能写成“JVM 预分配了所有零长度数组”。普通 Java `new int[0]` 仍然会走正常分配路径。

### 6.2 heap-side canonical `Class[]` 是另一回事，而且更晚创建

真正的 heap-side canonical empty `Class[]` 是：

```cpp
Universe::_the_empty_class_klass_array
```

它不是在 `genesis()` 里创建，而是在 `universe_post_init()` 才通过 `oopFactory::new_objArray(SystemDictionary::Class_klass(), 0, ...)` 创建。

它只服务部分内部常见路径，例如“没有 checked exceptions 时返回 canonical empty `Class[]`”。它也不是“所有 zero-length `Class[]` 请求”的统一对象。

所以要把这两层严格分开：

```text
metaspace empty arrays
  !=
heap-side canonical empty Class[]
```

### 6.3 OOME 预分配也分成两池，不是一个简单 singleton

`universe_post_init()` 里会预分配：

- 6 个 no-backtrace 默认 OOME
- 一组带预分配 backtrace 的 OOME 池（数量由 `PreallocatedOutOfMemoryErrorCount` 决定）

`gen_out_of_memory_error()` 会优先尝试从 backtrace-capable 池中取对象；池子耗尽后再退回对应的默认 no-backtrace OOME。

所以“JVM 预分配一个 OutOfMemoryError 对象”这类说法太粗。真实设计是：**稳定 defaults + 可消耗的 backtrace pool** 两层。

### 6.4 `non_oop_word` 根本不是空数组或空对象

`Universe::non_oop_word()` 是另一个完全不同的 bootstrap/sentinel 角色。它的要求是：这个 word 模样必须不像任何真实 oop。

它最典型的用法在 compiled IC / relocation metadata 里充当“伪空值”，而不是在堆或 metaspace 中充当某种空对象。

所以这类 sentinel 不能与：

- empty arrays
- OOME 池
- `"null"` 字符串
- primitive mirrors

混叫成“预分配对象”。它们服务的语义完全不同。

---

## 七、`CollectedHeap` 与 `MemAllocator`：普通对象分配真正在哪发生

### 7.1 `CollectedHeap` 暴露的是四类接口，不是“一个 allocate”

`CollectedHeap` 最核心的抽象接口包括：

- `allocate_new_tlab`
- `mem_allocate`
- `collect`
- `object_iterate`

这已经说明 JVM 把：

- 给线程新建 TLAB
- 给单个对象分配 raw memory
- 触发 GC
- 遍历堆对象

视为 collector-independent contract 的不同侧面。

### 7.2 `oopFactory` 不是对象真正的分配器

`oopFactory` 更像便利入口：它会根据 array/object 类型找到对应 `Klass`，再委派给 `Klass`/heap 分配逻辑。

真正负责：

- 走 TLAB 还是堆外共享空间
- 是否触发 collector 的 `mem_allocate`
- 对象 header 如何初始化
- mark 和 klass 以什么顺序发布

的是 `MemAllocator` 及其下游 collector heap。

所以要明确纠偏：**`oopFactory` 不是普通对象分配的底层实现，它只是上层 convenience layer。**

### 7.3 TLAB miss 不一定会 refill 一个新 TLAB

这是对象分配路径里最容易写歪的一点。

`MemAllocator::allocate_inside_tlab_slow()` 会先检查：

```cpp
if (tlab.free() > tlab.refill_waste_limit()) {
    tlab.record_slow_allocation(_word_size);
    return NULL;
}
```

也就是说，如果当前 TLAB 剩余空间太多，直接废弃它去换新 TLAB 太浪费，allocator 会保留当前 TLAB，并让调用路径退回 outside-TLAB 分配，而不是强行 refill。

因此 TLAB miss 的真实分支是：

```text
TLAB fast path miss
  → 若剩余空间还值得保留：outside-TLAB
  → 否则申请新 TLAB，再在新 TLAB 中分配
```

### 7.4 对象发布顺序是 mark 先、klass 后

`MemAllocator::finish()` 负责最后的对象发布顺序：

- 先设置 mark word
- 再用 release 语义发布 `Klass*`

这意味着对象只有在 header/body 已足够初始化之后，才对并发 GC 和其他消费者表现为“一个可解析对象”。

因此对象分配不是“拿到一块内存再随便填”，而是带着并发可见性约束的协议。

---

## 八、Universe 仓库：为什么它像“引导台”，不只是“全局变量表”

如果只看 `universe.hpp`，很容易把 Universe 理解成一堆静态字段：

- `_collectedHeap`
- primitive array klass 指针
- primitive mirrors
- canonical arrays
- preallocated exceptions
- sentinel strings
- `non_oop_word`

但从全篇走下来，真正重要的不是它“装了什么”，而是：**它把启动依赖顺序显式收进了同一处协议。**

- `heap()` 让全 VM 拿到当前 heap 抽象
- primitive array klasses 在 bootstrapping 期先被建立成最小元数据骨架
- `SystemDictionary::initialize()` 点亮最小类宇宙
- primitive mirrors / fixup list 把 Class mirror 世界接上
- `universe_post_init()` 再补 canonical heap-side objects 与异常池

所以 Universe 更像：

```text
JVM 启动时各阶段 bootstrap state 的编排者与仓库
```

而不只是“保存几个全局单例指针的头文件”。

---

## 九、误解澄清：八个最容易写过头的判断

1. **`create_heap()` 是否就已经 reserve 了整个 Java heap？** 不是。它只构造具体 `CollectedHeap` C++ 对象；真正的地址空间与辅助结构工作在 `initialize()`。
2. **G1 是否总是默认 GC？** 不是。只有在相应 build 支持且 ergonomics 选中时，server-class 机器才优先 G1；non-server 可能走 Serial。
3. **`genesis` 是否创造了“所有第一批对象”？** 不是。它是 class universe bootstrap 的核心阶段，但许多 canonical heap-side object 和异常池在 `universe_post_init()` 才出现。
4. **primitive array klass 是否就是“绝对第一个 klass”？** 不能这么绝对。它们是最早的一批 freshly created klass 之一，尤其在 non-CDS 路径里很靠前，但不是对所有环境的唯一答案。
5. **`_the_empty_int_array` 是否意味着所有 `new int[0]` 都复用它？** 不是。它是 metaspace canonical metadata array，不是普通 Java heap `int[]` 缓存。
6. **`_the_empty_class_klass_array` 与 metaspace empty arrays 是否是一回事？** 不是。前者是更晚创建的 heap-side canonical empty `Class[]`，后者是 metaspace `Array<T>*`。
7. **`oopFactory` 是否就是对象真正的分配器？** 不是。它是 convenience layer；TLAB/collector/memory publication 由 `MemAllocator` 与 `CollectedHeap` 处理。
8. **TLAB miss 是否一定会 refill 一个新 TLAB？** 不是。剩余空间过大时会保留当前 TLAB，直接走 outside-TLAB 分配。

---

## 十、收网：Universe 的真正角色，是把世界按依赖顺序点亮

回到开头的问题：JVM 在第一个普通 Java 对象出生前，靠什么活着？

答案不是一句“genesis 会创建它们”，而是一整条分阶段引导链：

```text
universe_init
  → 先立 heap substrate 与基础元数据设施

Universe::genesis
  → 再搭最小 class universe 与 mirror bootstrap 骨架

javaClasses_init / universe_post_init
  → 最后补全 offset contract、canonical heap objects、异常池与后置修复
```

三句话收束全文：

- **`Universe` 的第一重身份不是“全局变量袋子”，而是 JVM 启动里的分阶段引导台。**
- **堆的诞生要拆成“构造 heap object”和“初始化虚拟内存与辅助结构”两步，类宇宙与第一批镜像则在其上继续分阶段点亮。**
- **metaspace canonical arrays、heap-side canonical objects、异常池和 sentinel 都属于“启动期特殊对象”，但它们的存储层、时序和用途完全不同，不能混成一句“预分配了第一批对象”。**

下一篇顺着文中被多次提到的一个词继续：reserve。虚拟地址空间为什么要先 reserve 再 commit？为什么 metaspace、code cache 和 Java heap 都离不开这个模式？答案在 `VirtualSpace`。

> → [02 — VirtualSpace](02-virtualspace.md)
