# 04. 常量池与方法：字节码里的编号，如何变成一次读取就能执行的答案

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论；本文重点观察 x86 模板解释器，也用 C++ 解释器核对同一条语义路径。这里描述的是 HotSpot 11u 的实现，不是所有 JVM 都必须采用的对象布局或缓存格式。
> **前置依赖**：[03 — 为什么 `InstanceKlass`、`ObjArrayKlass`、`TypeArrayKlass` 不能合并？](03-instanceklass-arrayklass.md)：`InstanceKlass` 的 `_constants` 是本文的入口；[02 — 为什么一个 `Klass*` 就够了？](02-klass-hierarchy.md)：vtable 是虚调用解析结果的消费端
> → **后续**：[05 — Access API 与 barrier](05-access-api-barrier.md)：字段和数组元素最终如何经过统一访问通道
> 关联域：13-jit、18-safepoint

## `invokevirtual #5`，为什么第一次和第二次像两条指令

假设一个类里有这样的代码：

```java
String s = value;
int n = s.length();
```

编译后的调用指令不会把 `String.length` 的机器地址直接写进 class file。它更接近：

```text
invokevirtual #5
```

这里的 `#5` 只是当前类常量池中的一个编号。编号对应的条目里保存了类似这样的符号信息：

```text
类名：java/lang/String
方法名：length
签名：()I
```

第一次执行这条指令时，JVM 不能只做一次跳转。它至少要确认：

1. `java/lang/String` 对当前类加载器来说是哪一个类
2. 这个类及其父类、接口中是否有 `length()I`
3. 当前调用方是否有权限调用它
4. 当前接收者的真实类应当从哪个 vtable 槽位取实现
5. 解析结果是否要记录成直接调用、虚调用或接口调用

如果每次执行都重复这些动作，一个很普通的方法调用就会反复付出类解析、层次查找和访问检查的代价。

但第二次执行同一条字节码时，解释器并不想再次理解 `java/lang/String`、`length` 和 `()I`。它只想拿到一个已经整理好的答案：

```text
这是一条虚调用
接收者的 Klass 到 vtable 的第 42 项取 Method*
返回值类型是 int
参数区占多少栈槽已经知道
```

于是本文真正的问题出现了：

**第一次执行得到的复杂答案，被 HotSpot 放到了哪里？为什么一个看起来只有四个机器字的缓存条目，能够同时服务字段访问、虚调用、接口调用和 invokedynamic？**

先把整条路线画出来：

```text
字节码中的 #5
  │
  ▼
ConstantPool
  │  保存符号引用；需要时解析类名、字段名、方法名和签名
  ▼
InterpreterRuntime::resolve_from_cache
  │
  ├─ LinkResolver：查找目标、做访问检查、选择调用形态
  └─ 将结果写入 ConstantPoolCacheEntry
       _indices：常量池编号 + 已解析的字节码标记
       _f1     ：Method* 或 Klass*
       _f2     ：偏移、vtable index 或 Method*
       _flags  ：返回类型、参数大小和调用形态
  │
  ▼
下一次执行
  │
  ├─ bytecode 已匹配 → 跳过解析
  ├─ 按字节码选择 _f1 或 _f2
  └─ 按 flags 做一次必要分支，进入方法或查 vtable
```

一句话先记住：

**解析先把符号引用的痛苦一次性吃完，再把结果固化成一个按字节码解释的多义条目；后续执行不再重新理解符号，而是读取已经编码好的分派答案。**

---

## 一、三个看似更简单的办法，为什么都不够好

在看 `ConstantPoolCacheEntry` 之前，先推演几个自然得不能再自然的方案。真正的设计感，往往藏在“为什么不这样做”。

### 1.1 每次执行都重新解析

最直接的实现是：

```text
invokevirtual #5
  → 每次都从 #5 取 Methodref
  → 每次都解析类名
  → 每次都找方法
  → 每次都做访问检查
  → 每次都计算或确认分派结果
```

这个办法在语义上没有问题，却把一次性的链接工作放进了每次调用的热路径。一个循环里反复调用 `String.length()` 时，方法本身可能只有几条机器指令，前面的符号解析反而会成为主要负担。

更糟的是，解析过程并不只是字符串查表。类可能尚未加载，方法可能需要沿父类和接口层次查找，访问权限和类加载器约束也必须检查。把这些动作留在每次调用中，等于让解释器每次都扮演一遍链接器。

### 1.2 直接把解析结果改写进常量池条目

第二个办法是：

```text
Methodref
  第一次：把名字和签名替换成 Method*
  以后：直接从常量池拿 Method*
```

这又遇到两个问题。

第一，常量池条目既要表达 class file 的原始符号，也要承载运行时状态。解析失败时，JVM 还要区分“尚未解析”“解析成了类”“解析失败并保存了错误”。如果把这些状态全部塞进同一个条目，tag 和内容的语义会变得非常拥挤。

第二，同一个字段引用可能被 `getfield` 和 `putfield` 两种字节码使用；同一个方法引用也可能被不同调用形式消费。class file 中的符号条目描述的是“引用了谁”，而解释器需要的是“这次字节码应该怎样访问它”。这两种信息不在同一层。

因此 HotSpot 保留常量池作为符号引用仓库，再单独建立一个运行时缓存，把“怎么访问”编码进去。

### 1.3 每种字节码都设计一套独立缓存

第三个办法是为每一类字节码准备不同结构：

```text
FieldCache
VirtualCallCache
InterfaceCallCache
InvokeDynamicCache
```

它当然可以工作，但会把解释器的入口变复杂：解释器先要判断当前条目属于哪种缓存，再进入不同读取路径；同一个常量池引用如果被不同字节码使用，还可能需要多份重复缓存。

HotSpot 选择了更紧凑的办法：让一个固定大小的条目保存不同语义，字节码本身负责告诉解释器该读哪个槽位，`_flags` 负责告诉它槽位里的数值应该怎样解释。

这里先别急着抠位图，主线只需要记住两个动作：

```text
ConstantPool       → 负责把符号说清楚
ConstantPoolCache  → 负责把执行方式预先编码好
```

接下来分别看这两座仓库的分工。

---

## 二、ConstantPool：符号引用为什么不能直接当指针

### 2.1 class file 里保存的是可移植的名字，不是本进程地址

class file 必须能够在不同进程、不同类加载器和不同机器上使用。一个类的地址在生成 class file 时根本还不存在，更不能把某次运行中的 `Klass*` 或 `Method*` 写进文件。

因此 class file 里的方法引用更像一张待兑现的支票：

```text
Methodref
  ├─ class_index       → 一个 Class 条目
  └─ name_and_type     → 方法名 + 描述符
```

它描述目标，但不承诺当前进程中的具体地址。

`ConstantPool` 继承自 `Metadata`，不是 Java 堆对象。`constantPool.hpp:98-130` 中可以看到，它至少持有：

- `_tags`：每个常量池槽位的类型标签
- `_cache`：对应的运行时解析缓存
- `_pool_holder`：拥有这座常量池的 `InstanceKlass`
- `_resolved_klasses`：已经解析出的 `Klass*` 侧数组
- `_length`：常量池长度

其中 `_tags` 很重要。常量池槽位不是一组同构的 C++ 对象，解释器必须先知道某个槽位是 `Class`、`Methodref`、`Utf8` 还是 `InvokeDynamic`，才能决定如何解释槽位里的数据。

### 2.2 类解析先走已经解析的侧数组

读者可能会猜：既然常量池条目里保存了类名，那么 `klass_at()` 每次都要按名字查类。

实际情况先检查缓存。`ConstantPool::klass_at_impl` 在 `constantPool.cpp:447-517` 中先从 `klass_slot_at(which)` 取出名字索引和已解析类索引，然后读取 `_resolved_klasses`：

```cpp
int resolved_klass_index = klass_slot_at(which).resolved_klass_index();
Klass* klass = this_cp->resolved_klasses()->at(resolved_klass_index);
if (klass != NULL) {
  return klass;
}
```

这段快路径回答了第一个问题：**类解析结果并不需要每次回到符号名字。只要侧数组已经有 `Klass*`，调用就可以直接返回。**

只有侧数组为空时，HotSpot 才会根据常量池中的名字调用 `SystemDictionary::resolve_or_fail`，使用当前常量池持有者的类加载器和保护域寻找类。找到之后还要经过 `verify_constant_pool_resolve`，检查当前代码是否有权使用这个类。

如果解析失败，失败本身也不是简单丢掉。`constantPool.cpp:783-818` 的 `save_and_throw_exception` 会把链接错误记录下来，并尝试把 tag 改成错误状态。这样后续再触发同一解析时，JVM 可以重新抛出保存的链接错误，而不是把完整失败流程无休止地重跑。

### 2.3 发布顺序保证其他线程看到完整结果

类解析成功后，源码不是随便写两个字段就结束。`constantPool.cpp:510-515` 的顺序是：

```cpp
OrderAccess::release_store(adr, k);
release_tag_at_put(which, JVM_CONSTANT_Class);
```

先发布 `_resolved_klasses` 中的 `Klass*`，再把 tag 变成已经解析的 `Class`。这个顺序表达了一个并发约束：

```text
其他线程看到“已解析”标记时
必须已经能读到完整的 Klass*
```

如果顺序反过来，读线程可能先看到 tag 已经变成 `Class`，却还读到空的 `_resolved_klasses` 槽位。

所以常量池这一层完成的是：

```text
符号名字 → 已加载并通过访问检查的 Klass*
```

但它还没有回答“`invokevirtual` 应该走哪个 vtable 槽位”。那是调用形态的答案，落在另一张表里。

---

## 三、ConstantPoolCache：一个四字条目怎样同时表达四种调用

### 3.1 条目不是哈希表，而是按编号索引的定长数组

`ConstantPoolCache` 的名字很容易让人联想到哈希缓存。这里要澄清：它不是按名字做哈希查找的 map，而是与常量池引用建立编号映射的定长条目数组。

解释器已经从字节码中拿到了常量池编号，接下来只需要根据这个编号找到对应条目。条目本身由四个 volatile 字段组成，`cpCache.hpp:139-142` 定义为：

```cpp
volatile intx       _indices;
Metadata* volatile  _f1;
volatile intx       _f2;
volatile intx       _flags;
```

`cpCache.hpp:46-55` 直接给出了这四个字段的设计图：

```text
_indices   [ b2 | b1 |  index  ]
_f1        [  entry specific  ]
_f2        [  entry specific  ]
_flags     [ type and options ]
```

这里的“entry specific”不是随意的多用途变量，而是一个非常严格的协议：**解析阶段决定每个字段的语义，执行阶段只按当前字节码读取。**

### 3.2 `_indices` 不只是编号，还藏着两个“已解析标记”

`_indices` 的低 16 位保存原始常量池索引；高 16 位分成 `bytecode_1` 和 `bytecode_2` 两个字节。`cpCache.hpp:198-206` 定义了低位索引和两个字节码的位移。

为什么需要两个字节码槽？因为同一个缓存条目可以服务一组相关字节码：

- `getfield` 和 `putfield` 共享字段解析结果
- `getstatic` 和 `putstatic` 共享字段解析结果
- `invokevirtual` 主要使用 bytecode 2
- `invokespecial`、`invokestatic`、`invokeinterface` 等使用 bytecode 1

`bytecode_number()` 在 `cpCache.hpp:312-327` 中把当前字节码映射到槽位。解释器执行时不需要猜条目属于什么类型，只要查看当前字节码对应的那个字节是否已经匹配。

模板解释器的 `resolve_cache_and_index` 位于 `templateTable_x86.cpp:2721-2749`，核心判断就是：

```text
读出当前条目的 bytecode_N
  │
  ├─ 等于当前 opcode → 已解析，进入快路径
  └─ 不等于当前 opcode → 调用 resolve_from_cache
```

这比单独维护一个 `resolved` 布尔字段更紧凑，因为同一个字节已经同时承担了“哪个字节码使用这个结果”和“该字节码是否已解析”两层信息。

### 3.3 为什么 bytecode 要最后写入

解析线程会先填写 `_f1`、`_f2` 和 `_flags`，然后才调用 `set_bytecode_1` 或 `set_bytecode_2`。`cpCache.cpp:92-110` 使用 `OrderAccess::release_store` 写入 `_indices`：

```cpp
OrderAccess::release_store(&_indices,
                           _indices | ((u_char)code << bytecode_1_shift));
```

源码在 `cpCache.cpp:122-126` 明确说明了原因：字节码标记必须在其他字段之后发布，避免其他处理器看到一个非零 bytecode，却看到空的 `_f1` 或未完成的 `_f2`。

因此读线程的顺序是：

```text
acquire-load _indices
  → 确认 bytecode 已匹配
  → 再读取 _f1 / _f2 / _flags
```

这不是单纯的内存排布，而是一个发布协议。bytecode 槽相当于“这份解析结果现在可以被别人消费”的门闩。

### 3.4 `_flags` 的一位，先把字段和方法分开

`_flags` 的第 26 位是 `is_field_entry`，定义在 `cpCache.hpp:176-196`。它把条目先分成两种大类：

```text
is_field_entry = 1
  → _f1 / _f2 按字段协议解释

is_field_entry = 0
  → _f1 / _f2 按方法协议解释
```

字段条目通常保存：

```text
_f1     → 字段持有者的 Klass*
_f2     → 字段偏移
_flags  → 字段类型、final、volatile、FieldInfo index
```

静态字段还要从持有者 Klass 找到 Java mirror，解释器模板在 `templateTable_x86.cpp:2752-2779` 的 `load_field_cp_cache_entry` 中完成这个转换。

方法条目则根据调用字节码改变 `_f1` 和 `_f2` 的意义。这里先看四种主要形态。

### 3.5 非虚直接调用：`_f1` 直接保存 `Method*`

`invokestatic` 和很多 `invokespecial` 调用在解析时已经确定了目标，不需要根据接收者的 vtable 再选一次实现。

这类条目把目标 `Method*` 放在 `_f1`。模板解释器看到 `invokespecial` 或 `invokestatic` 使用 bytecode 1，于是从 `_f1` 读取目标方法，直接进入它的解释器入口。

这里的关键不是 `_f1` “恰好可以放一个指针”，而是调用形态已经在解析阶段确定：

```text
解析阶段确认：这是直接调用
执行阶段约定：bytecode_1 对应 _f1
```

### 3.6 普通虚调用：`_f2` 保存 vtable index

`invokevirtual` 的目标不能只由常量池里的声明方法决定。声明类型可能是父类，真实接收者却是子类；最终要以接收者的实际 `Klass*` 为准，从对应 vtable 槽位取实现。

解析阶段已经能算出这个方法在 vtable 中的索引。于是缓存条目不必保存每个接收者的最终 `Method*`，只需保存：

```text
_f2 = vtable index
```

模板解释器的 `invokevirtual_helper` 在 `templateTable_x86.cpp:3699-3743` 中先取接收者的 Klass，再执行 `lookup_virtual_method`。因此第二次执行仍然保留多态性，但不再重新做方法名和签名查找。

### 3.7 final 虚调用：同一个 `_f2` 改存 `Method*`

如果解析结果确认目标是 final 或其他不可被覆盖的静态绑定方法，就没必要每次再取接收者 Klass 查 vtable。

HotSpot 仍然复用 `_f2`，但这次存进去的是 `Method*`。`is_vfinal` 位在 `cpCache.hpp:188` 定义，模板解释器在 `templateTable_x86.cpp:3710-3724` 用一位测试区分两种含义：

```text
is_vfinal = 1
  → _f2 是 Method*
  → 直接跳转

is_vfinal = 0
  → _f2 是 vtable index
  → 用接收者 Klass 查 vtable
```

这就是 `_f2` 多义设计的边界：它不是运行时随便猜类型，而是由解析阶段写入 `is_vfinal`，执行阶段按这一个位解释。

### 3.8 接口调用：`_f1` 和 `_f2` 共同保存接口查找所需信息

`invokeinterface` 需要两类信息：

```text
_f1 → 被引用的接口 Klass*
_f2 → 接口中声明的方法 Method*
```

真正的实现还要结合接收者 Klass 的 itable。模板解释器在 `templateTable_x86.cpp:3791-3937` 中先处理 forced virtual 和 private interface 等特殊情况，再走接口表查找。

这里的 `_f2` 不是普通虚调用的 vtable index，而是接口方法指针；接口方法自身携带 itable index，运行时据此找到接收者的实际实现。

到这里，主线其实只发生了三件事：

1. 常量池保存“引用了谁”的符号
2. cpCache 保存“这条字节码应该怎么调用”的答案
3. `_f1`、`_f2` 的语义由 bytecode 槽和 flags 在解析阶段共同固化

---

## 四、第一次执行：解析线程如何把符号变成缓存条目

前面描述了条目长什么样，现在沿着一次真实的 `invokevirtual #5` 把第一次执行走完。

### 4.1 解释器先判断“这条引用是否已经兑现”

x86 模板解释器进入 `invokevirtual` 后，调用 `prepare_invoke`。其中 `load_invoke_cp_cache_entry` 位于 `templateTable_x86.cpp:2781-2817`，最终由 `resolve_cache_and_index` 检查当前 bytecode 槽。

如果 bytecode 槽还不是 `_invokevirtual`，模板解释器调用 `InterpreterRuntime::resolve_from_cache`。这个统一入口在 `interpreterRuntime.cpp:977-1000` 按 opcode 分流：字段访问走 `resolve_get_put`，普通调用走 `resolve_invoke`，`invokehandle` 和 `invokedynamic` 走各自特殊路径。

因此“第一次执行”并不是一个隐含的初始化动作，而是发生在真实字节码路径上的一次慢调用：

```text
模板解释器
  → 发现 bytecode 槽未匹配
  → 进入 VM runtime
  → 解析并写缓存
  → 返回原字节码路径
```

### 4.2 `LinkResolver` 先解决声明，再决定运行时调用形态

普通方法调用进入 `InterpreterRuntime::resolve_invoke`，源码范围是 `interpreterRuntime.cpp:833-928`。

它先从当前栈帧取出常量池索引和接收者，然后调用 `LinkResolver::resolve_invoke`。`linkResolver.cpp:1611-1622` 按字节码分到 `resolve_invokestatic`、`resolve_invokespecial`、`resolve_invokevirtual` 或 `resolve_invokeinterface`。

以普通类方法为例，`resolve_method` 位于 `linkResolver.cpp:723-793`，它完成的不是一步查表，而是一组有顺序的动作：

1. 根据常量池引用得到声明类、方法名和签名
2. 在当前类和父类层次中查找方法
3. 必要时继续查接口默认方法和多态签名方法
4. 找不到时抛出 `NoSuchMethodError`
5. 检查访问权限
6. 检查类加载器约束

真正的层次查找在 `lookup_method_in_klasses`，位置是 `linkResolver.cpp:333-384`。解析到这里得到的是“声明方法”，还不是所有接收者都相同的最终实现。

### 4.3 虚调用还要把声明方法变成 vtable 答案

`runtime_resolve_virtual_method` 位于 `linkResolver.cpp:1344-1409`。它面对一个关键分叉：

```text
声明方法能否被接收者的子类覆盖？
```

如果可以，就取得 vtable index；运行时用接收者 Klass 的同一个 index 找实际实现。如果方法已经静态绑定，就把它标记成 direct call，并让 `_f2` 保存 `Method*`。

`CallInfo` 把这个结果带回 `InterpreterRuntime::resolve_invoke`。后者根据 `call_kind()` 调用：

```text
直接调用 → set_direct_call
vtable 调用 → set_vtable_call
itable 调用 → set_itable_call
```

这些分流位于 `interpreterRuntime.cpp:906-927`。

### 4.4 写入顺序把“解析答案”变成“可消费答案”

以普通虚调用为例，`set_vtable_call` 最终进入 `cpCache.cpp:167-309` 的 `set_direct_or_vtable_call`：

```text
_f2     ← vtable index
_flags  ← 返回类型、参数大小、调用形态
_indices 的 bytecode_2 ← invokevirtual
```

前两个动作先发生，bytecode 标记最后发生。于是其他线程只要看到 `bytecode_2 == invokevirtual`，就可以相信 `_f2` 和 `_flags` 已经准备好。

如果两个线程同时发现未解析，`interpreterRuntime.cpp:873` 还会再次检查条目是否已经被另一个线程填好。先完成发布的一方获胜，另一方放弃覆盖。

这条链可以压缩成：

```text
符号引用
  → 类解析
  → 方法查找
  → 权限与加载器检查
  → 调用形态选择
  → 写入 _f1/_f2/_flags
  → 最后发布 bytecode
```

---

## 五、第二次执行：为什么只需要一次读和一次必要分支

### 5.1 `invokevirtual` 的快路径不再读名字

第二次进入同一条字节码时，`resolve_cache_and_index` 读到 bytecode_2 已经等于 `_invokevirtual`，直接跳过 VM 调用。

随后 `load_invoke_cp_cache_entry` 根据 `byte_no == f2_byte` 选择 `_f2`。这一步不是运行时比较条目类型，而是模板生成阶段根据当前字节码决定读取偏移：

```text
invokevirtual → 读取 _f2
invokespecial → 读取 _f1
invokestatic  → 读取 _f1
```

`invokevirtual_helper` 再测试 `is_vfinal`：

```text
_f2 + is_vfinal
  ├─ final：_f2 是 Method*，直接进入
  └─ 非 final：_f2 是 vtable index，按 receiver Klass 查表
```

因此普通虚调用的运行时成本不是“再次解析方法名”，而是：

```text
检查一个 bytecode 标记
读取 _f2
读取 receiver Klass
按 index 取 vtable 槽位
```

### 5.2 字段访问还会进一步改写字节码

字段访问的第一次快路径要从 `_flags` 的高位取 `TosState`，决定这是 byte、int、long、float、double 还是引用，然后选择对应的 load/store。

x86 模板解释器在 `templateTable_x86.cpp:2860-3006` 中先完成这个类型分派。成功执行后，它还可以把原来的 `getfield` 改写成 `_fast_igetfield`、`_fast_agetfield` 等更具体的 opcode。

改写之后，类型已经烤进字节码，后续 `fast_accessfield` 不再重复做完整类型分派，只需读取 `_f2` 作为字段偏移。

这说明缓存有两层收益：

```text
第一层：解析结果固化
  → 不再做类和方法的符号解析

第二层：字节码重写
  → 不再做字段类型的运行时分派
```

如果赶时间，这里只记住第一层；第二层是 x86 模板解释器对字段访问做的进一步优化。

### 5.3 `invokedynamic` 为什么不能套普通虚调用模型

`invokedynamic` 没有一个预先确定的接收者 Klass。它要调用 bootstrap method，根据调用点生成一个动态调用点和 adapter。

所以它的缓存条目采用另一种协议：

```text
_f1                         → adapter Method*
_f2                         → resolved_references 中的索引
resolved_references[f2+0]  → appendix
resolved_references[f2+1]  → MethodType（如果存在）
```

`cpCache.cpp:350-461` 的 `set_method_handle_common` 使用 `resolved_references` 上的锁，先写 flags、appendix 和 method type，最后用 release 语义发布 `_f1`。读线程先检查 `_f1` 是否为空，非空才消费其他字段。

如果 bootstrap method 永久失败，`save_and_throw_indy_exc` 会记录错误并设置 `indy_resolution_failed` 位。后续执行可以直接沿失败路径抛出链接错误，而不必再次调用 bootstrap method。

这类调用仍然遵循同一个总原则：

```text
第一次：完成昂贵的动态链接
之后：读取已经组织好的 adapter 和附加参数
```

只是它的“答案”不再是 vtable index。

---

## 六、Method：方法本体为什么要拆成不可变数据和可变入口

解析得到 `Method*` 之后，JVM 还要面对另一个问题：这个方法可能先由解释器执行，后来被 C1/C2 编译，再因为去优化回到解释器。

如果方法的字节码、异常表、行号表和所有可变入口都塞进一块对象里，运行时切换入口会和大量只读数据纠缠在一起。HotSpot 把它拆成 `Method` 与 `ConstMethod` 两部分。

### 6.1 `ConstMethod` 保存不会频繁变化的部分

`ConstMethod` 的类注释位于 `constMethod.hpp:31-87`。它保存 class file 解析后基本不再写入的内容，并且可以进入 CDS 的只读区域。

字节码紧跟在 `ConstMethod` 头部之后，`constMethod.hpp:490-496` 定义：

```cpp
address code_base() const { return (address)(this+1); }
address code_end() const  { return code_base() + code_size(); }
```

这意味着字节码不是另一个需要单独追踪的指针，而是一次分配中的内嵌数据。异常表、行号表、局部变量表、检查异常表和注解数据也按布局信息放在这块元数据中。

拆分的动机有三层：

1. 字节码和表格基本只读，适合共享
2. `Method` 的入口点会随编译和去优化改变，不适合放进只读区域
3. 大量方法可能永远不会变热，不能让可变运行时状态拖大所有只读方法对象

因此 `Method` 不是“字节码本体”，它更像是：

```text
ConstMethod  → 方法的只读说明书
Method       → 方法的运行时控制面
```

### 6.2 方法一开始只有解释器入口

`Method::link_method` 位于 `method.cpp:1075-1124`。方法所属类链接时，HotSpot 先为它设置解释器入口，然后创建调用适配器。

初始化后可以把状态画成：

```text
_i2i_entry              → 解释器入口
_from_interpreted_entry → 解释器入口
_from_compiled_entry    → c2i adapter
_code                   → NULL
```

这组入口的目的不是保存四份独立答案，而是覆盖不同调用方向：

- 解释器调用解释器
- 解释器调用已编译代码
- 已编译代码调用已编译代码
- 已编译代码调用解释器

在方法尚未编译时，编译代码的调用先通过 c2i adapter 回到解释器；解释器调用则直接进入 `_i2i_entry`。

### 6.3 编译完成时，为什么必须按这个顺序换入口

编译器完成一个 nmethod 后，`Method::set_code` 在 `method.cpp:1195-1220` 中按固定顺序写入：

```cpp
mh->_code = code;
OrderAccess::storestore();
mh->_from_compiled_entry = code->verified_entry_point();
OrderAccess::storestore();
mh->_from_interpreted_entry = mh->get_i2c_entry();
```

顺序不能调换。

解释器调用 `_from_interpreted_entry` 后，会进入 i2c adapter，再跳到 `_from_compiled_entry`。如果先把 `_from_interpreted_entry` 改成 i2c，却还没有更新 `_from_compiled_entry`，这条路径可能从 i2c 又回到旧的 c2i adapter，形成不正确的回环。

所以发布顺序是：

```text
先让 _code 指向新代码
  → 再让编译调用入口指向新代码
  → 最后让解释器调用入口切到 i2c
```

这里的 `storestore` 不是装饰。它保证前一个入口状态已经对其他线程可见，后一个入口才可以被消费。

### 6.4 去优化时为什么反向恢复，最后才清空 `_code`

`Method::clear_code` 位于 `method.cpp:961-975`。它的顺序几乎是反过来的：

```text
_from_compiled_entry    ← c2i adapter
storestore
_from_interpreted_entry ← _i2i_entry
storestore
_code                   ← NULL
```

恢复入口后才把 `_code` 清空，是为了让观察到旧 `_code` 的线程不会同时拿到一组未准备好的入口。

这说明 `_code` 更像当前编译状态的事实来源，而 `_from_compiled_entry` 和 `_from_interpreted_entry` 是为了热调用方向准备的缓存入口。方法运行时不是通过调用方反复询问“现在编译了吗”，而是通过入口指针的切换让调用方自然进入正确路径。

---

## 七、计数器和画像：JIT 什么时候介入，凭什么做投机

到这里，方法已经能在解释器和编译代码之间切换，但还有一个决策问题：什么时候值得编译？编译器又凭什么相信某个类型或分支会长期成立？

### 7.1 计数器决定什么时候值得付编译成本

`MethodCounters` 保存两个最基本的热度信号，`methodCounters.hpp:51-52` 定义为：

```cpp
InvocationCounter _invocation_counter;
InvocationCounter _backedge_counter;
```

它们分别记录方法进入次数和循环回边次数。方法进入次数说明整个方法是否变热，回边次数说明某个循环是否值得做 OSR。

这些计数器是懒分配的。`Method::build_method_counters` 和 `init_method_counters` 在 `method.cpp:452-479` 中按需构造，并用原子方式安装；冷方法不需要一开始就为计数器支付元数据空间。

回边计数的意义尤其重要：一个方法可能只被调用一次，却在内部运行很久。此时等待整个方法返回再编译没有意义，OSR 可以在循环执行到一半时把当前栈帧切换到编译版本。

因此计数器回答的是：

```text
这个方法或这个循环，热到值得编译了吗？
```

### 7.2 MethodData 保存编译器可以消费的画像

计数只能告诉编译器“这里很热”，不能告诉它“哪条分支更常走”或“虚调用通常收到什么类型”。这类信息由 `MethodData` 保存。

`MethodData` 也是元数据对象，按字节码位置组织 `DataLayout` 数组。解释器执行过程中可以积累：

- 分支的实际走向比例
- 虚调用位置收到过的接收者类型
- 某些参数和调用行为

C2 读取这些画像后，可以进行带保护条件的内联和类层次分析。如果运行时事实违背了画像假设，去优化路径会把执行带回解释器或其他安全入口。

所以两者分工不同：

```text
MethodCounters → 什么时候编译
MethodData     → 编译时相信什么
```

这与 cpCache 的设计是同一种思路：昂贵的理解和分析发生在不频繁的路径上，热路径消费已经整理好的小型答案。

---

## 八、把整条链压回一张图

现在重新回答开头的问题：`invokevirtual #5` 为什么第一次和第二次差别这么大？

第一次执行时，JVM 要把 class file 的可移植符号兑现成当前进程里的运行时事实：

```text
#5
  → ConstantPool 找到 Methodref
  → 解析声明类
  → 查找方法名和签名
  → 做访问检查与加载器约束检查
  → 判断 direct / vtable / itable
  → 将答案写进 cpCache
```

第二次执行时，答案已经变成条目协议：

```text
bytecode_2 == invokevirtual
  → 读 _f2
  → is_vfinal ? 直接取 Method* : 当作 vtable index
  → 用 receiver Klass 取实际方法
```

字段访问、接口调用和动态调用虽然使用不同的 `_f1`、`_f2` 语义，但都遵循同一原则：

```text
符号层负责可移植
解析层负责检查和选择
缓存层负责固化执行协议
解释器负责按协议消费
```

最后澄清几个容易混淆的点：

1. `ConstantPoolCache` 不是按名字查找的普通哈希表，而是围绕常量池编号组织的运行时条目数组
2. `_f2` 不是一个没有规则的万能字段；它究竟是字段偏移、vtable index 还是 `Method*`，由当前字节码和 `_flags` 的位协议共同决定
3. `ConstantPool` 的类解析结果和 cpCache 的调用解析结果不是同一件事：前者解决“这是哪个 `Klass*`”，后者解决“这条字节码怎样访问它”
4. `Method` 入口切换不是重新创建一个方法，而是在锁和内存顺序约束下替换几个调用入口
5. `ConstMethod` 与 `Method` 分开，核心动机是不可变方法数据可以进入 CDS 只读共享，而运行时入口仍然可以变化
6. `invokedynamic` 不沿普通 invokevirtual 的 vtable 路径解析，而是生成 adapter，并把 appendix 等附加数据放进 `resolved_references`
7. x86 模板解释器的 bytecode rewriting 是额外的快路径优化，不应被当成 Java 字节码语义本身

如果只保留三句话：

- 常量池保存的是跨进程可移植的符号，不能直接保存当前 JVM 的地址
- 第一次执行把符号解析成调用协议，并按发布顺序写入 cpCache 的四字条目
- 后续执行不再重新理解名字，而是读取 `_f1`、`_f2` 和 `_flags` 中已经编码好的答案

下一篇会把这个结论往对象访问方向推进：当 `_f2` 已经给出字段偏移、数组元素已经确定为 oop 时，解释器和 JIT 如何通过 `Access API` 把读写动作交给 barrier，而不让每个调用点重复拼接 GC 逻辑。

> → [05-access-api-barrier.md](05-access-api-barrier.md)
