# 01. ClassFile 解析：一段 hostile 字节流，如何变成 `InstanceKlass`

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论；本文聚焦普通 parser path，也会标出 JVMTI 改字节和 CDS shared class 的边界。这里描述的是 HotSpot 11u 的实现，不是 JVM 规范要求的唯一做法。
> **前置依赖**：[06-oops/06 — Symbol 与辅助元数据](../06-oops/06-symbol-annotations-aux.md)：`Symbol`、`FieldInfo`、`AnnotationArray` 和 `Method` 都是在本文首次被 parser 生产出来；[42-core-native/03 — ClassLoader + I/O + TimeZone](../42-core-native/03-class-io.md)：`defineClass` 把字节交给 VM 的入口
> → **后续**：[02 — Verifier + StackMapTable](02-verifier-stackmap.md)
> 关联域：06-oops、11-cds、27-jni

## 为什么 `.class` 解析不是“读文件然后 new 一个类”

表面看，`.class` 文件只是一个二进制格式：

```text
magic
version
constant_pool
access_flags
this_class / super_class
interfaces
fields
methods
attributes
```

于是很自然会产生一个想法：

```text
按顺序读这些 section
  → 一边读一边填进 InstanceKlass
  → 读完就是一个类
```

但 HotSpot 不能这样乐观。

因为 `.class` 不是一段可信的内存布局，而是一段 hostile byte stream。它可能带着很多种错误进来：

- 文件长度不足，读取 `u2` 时已经越界
- `constant_pool_count` 合法，但后续 tag 布局错乱
- 某个索引指向了错误类型的常量池槽
- 同一个方法重复出现两个 `Code` 属性
- 版本号超过当前 JVM 支持范围
- 文件尾部还有额外垃圾字节
- JVMTI `ClassFileLoadHook` 在类定义前改写了整个字节流

更关键的是，就算字节格式本身正确，解析器也还没准备好立刻生产一个完全可用的类：

- 很多常量池项只需要先登记 unresolved graph，不能一上来就全解析成直接指针
- 字段布局、vtable/itable 大小、transitive interfaces 这些派生信息，要等整份 class file 都读完后才能算
- 只要中途任何一步失败，已经分配的 `ConstantPool`、`Method`、`FieldInfo`、`AnnotationArray`、甚至部分 `InstanceKlass` 都必须安全回滚

所以本文真正要追的问题不是“class file 规范长什么样”，而是：

**HotSpot 怎样把一段不可信、可变长度、互相引用的字节流，先隔离成 parser-owned 的临时元数据图，再在确认形状成立后事务式地移交给 `InstanceKlass`？为什么它不边读边直接构造一个最终类对象？**

先把全程画出来：

```text
Class bytes
  │
  ├─ KlassFactory::create_from_stream
  │    ├─ JVMTI hook 可改字节
  │    └─ 构造 ClassFileParser
  │
  ├─ ClassFileParser constructor
  │    ├─ parse_stream()               → 按格式读取 + 局部校验 + 临时元数据
  │    └─ post_process_parsed_stream() → 解析部分依赖 + 计算派生形状
  │
  ├─ create_instance_klass()
  │    ├─ allocate_instance_klass()    → 按派生形状分配 raw klass
  │    └─ fill_instance_klass()        → 挂入 CLD、移交 metadata、补派生状态
  │         ├─ rollback armed: set_klass_to_deallocate(ik)
  │         ├─ handoff: apply_parsed_class_metadata()
  │         ├─ clear parser fields + assert NULL
  │         ├─ commit: set_klass_to_deallocate(NULL)
  │         └─ set_klass(ik)
  │
  └─ define / link later
       ├─ define_instance_class() → loaded
       └─ link_class_impl()       → verify + rewrite + method link
```

一句话先记住：

**`ClassFileParser` 不是“边读边填 `InstanceKlass`”的构造器，而是一个事务式中间层：先构造 parser-owned 元数据，再计算类的派生形状，最后统一移交所有权；失败时析构函数按“要么全给 klass、要么全回收”的规则兜底。**

---

## 一、三个看似更简单的办法，为什么会把类加载写成事故现场

### 1.1 边读字节边直接填 `InstanceKlass`

最直觉的做法就是：

```text
new InstanceKlass
  → 读到常量池就填 constants
  → 读到字段就填 fields
  → 读到方法就填 methods
  → 读到属性继续补状态
```

这个方案的问题不是“不能实现”，而是失败时很难回滚。

假设已经把类插进 `ClassLoaderData::_klasses` 链表，已经把一部分 `Method*` 挂到 `InstanceKlass`，然后在最后一个类属性上抛出 `ClassFormatError`。此时谁负责：

- 把类从 CLD 链表摘掉
- 释放已经创建的 `Method` / `ConstMethod`
- 释放常量池、字段数组和注解数组
- 处理可能已经共享出去的 transitive interface array

把这些细节全部分散到 `InstanceKlass` 的每个 setter 和 parser 的每个分支里，会迅速失控。

### 1.2 常量池一读完就全部解析成直接指针

第二个方案是“反正都要用，不如一开始全解析”。

这样会把两个本该分离的成本绑死：

```text
加载一个类
  ≠
立刻使用它的每一个 Methodref / String / MethodHandle / Dynamic constant
```

很多常量池项只需要在加载阶段确认结构和索引合法；真正解析成 `Klass*`、字符串对象或 invokedynamic 相关运行时实体，可以等到后续需要时再做。

如果一读完 CP 就把一切都解析出来：

- 类加载成本被无差别抬高
- 可能提前触发更多类加载和错误
- 只被“装载但从未真正执行”的类也要支付完整解析代价

当然，“加载期完全不解析任何依赖”也不成立。superclass 和 interfaces 就必须在构造类的时候解析，否则连类层次和布局都没法确定。正确边界不是“全部 eager”或“全部 lazy”，而是：**只在当前类构造必须用到的地方提前解析，其余保持 unresolved。**

### 1.3 字节读完后再到处散落地补派生信息

第三个方案看似更工程化：

```text
先把原始 section 读完
  → 之后再到很多地方分别计算接口、字段偏移、vtable、大量派生状态
```

这的问题在于所有权边界会被打散。

如果 `parse_stream()` 结束后，字段布局在别处算、方法排序在另一个函数里做、注解 ownership 又在第三处完成，你很难回答：

```text
在第 N 步失败时，当前哪些对象归 parser 所有？
哪些已经归 klass 所有？
哪些还没挂到任何 owner？
```

所以 HotSpot 把类构建拆成三层清晰阶段：

1. `parse_stream()`：按 class file 格式读字节并做局部校验
2. `post_process_parsed_stream()`：把读出的事实整理成“可以据此分配 klass”的派生形状
3. `fill_instance_klass()`：真正把 parser-owned 元数据移交给 `InstanceKlass`

这里先别急着抠每个函数。先记住问题被拆开的方式：

```text
字节安全     → ClassFileStream
局部结构校验 → parse_stream
派生形状计算 → post_process_parsed_stream
所有权交接   → fill_instance_klass
```

---

## 二、入口与字节安全：Parser 先把输入隔离在自己手里

### 2.1 `ClassFileLoadHook` 在 parser 构造之前就可能改掉整份字节

普通类定义从 `SystemDictionary::resolve_from_stream` 进入，再调用 `KlassFactory::create_from_stream`。真正构造 parser 之前，`KlassFactory` 会先经过 `check_class_file_load_hook`，让 JVMTI 有机会改写 class bytes。

因此 parser 看到的那份 `ClassFileStream`，不一定是最初来自 `defineClass` 的原始字节。这个边界很重要：**JVMTI 改字节不是 parser 内部的一个 case，而是 parser 的输入前置步骤。**

这也解释了为什么“hostile byte stream”不仅仅是磁盘上的 `.class` 文件，还包括 agent 改写后的版本。

### 2.2 `ClassFileStream` 是字节读取的安全膜

`ClassFileStream` 的职责不是解释 class file 语义，而是提供一个有界、带 endian 语义的 cursor。

它的三个关键点是：

1. 整个底层 buffer 的所有权不在它自己手里，`ClassFileStream` 只是视图
2. `Bytes::get_Java_u2/u4/u8` 负责 big-endian 读取
3. `guarantee_more(n)` 负责“接下来读 n 字节是否合法”

`classFileStream.hpp:88-116` 中，checked read 与 `*_fast` read 的边界很明确：

- `get_u2()` / `get_u4()` 在 `_need_verify` 下会先 `guarantee_more`
- `get_u2_fast()` / `get_u4_fast()` 不做边界检查，只做读取和 cursor 前进

所以 HotSpot 的解析节奏通常是：

```text
先 guarantee_more(这节至少还剩多少字节)
  → 然后大量使用 *_fast 读取
```

这样做的好处不是“完全不检查边界”，而是把边界检查从每个原子读取提到当前 section 的入口，减少重复开销。

### 2.3 `at_eos()` 是最后一道“没有垃圾尾巴”检查

很多人只记得 `CAFEBABE` 和版本号检查，却忽略了 `parse_stream()` 最后还要求：

```cpp
guarantee_property(stream->at_eos(),
                   "Extra bytes at the end of class file %s",
                   CHECK);
```

这意味着 class file 不是“前面能读通就行”。只要尾部还有多余字节，HotSpot 也会把它视为格式错误。

这里先收一个结论：Parser 的第一层任务不是“理解类”，而是先保证自己能安全、完整、不越界地走完整段字节流。

---

## 三、`parse_stream()`：按格式解码，但只做局部承诺

### 3.1 constructor 里只做两件事：解析与后处理

`ClassFileParser` 的构造函数末尾只有两步：

```cpp
parse_stream(stream, CHECK);
post_process_parsed_stream(stream, _cp, CHECK);
```

也就是说，parser 构造本身不会直接 `new InstanceKlass`。它先把 class file 读成 parser-owned state，再做派生整理。

### 3.2 `parse_stream()` 的顺序贴着 class file 格式走

`parse_stream()` 从 `guarantee_more(8)` 开始，随后读取：

```text
magic
minor/major version
constant_pool_count + constant_pool
access_flags
this_class / super_class
interfaces
fields
methods
class attributes
at_eos
```

这一步最容易被误读成“源码顺序就是理解顺序”。实际更准确的说法是：`parse_stream()` 负责把字节按规范节奏拆出来，并为每节建立最低限度的局部正确性承诺。

例如 magic 与版本：

- magic 必须等于 `JAVA_CLASSFILE_MAGIC`
- 版本必须通过 `verify_class_version`
- preview、过新 major、过旧版本都会在这里拒绝

这一节不回答“这个类最终是否能 link 成功”，只回答“它在文件头层面像不像一个当前 JVM 理解得了的 class file”。

### 3.3 parser 在这一阶段构造的是临时元数据，不是 live class graph

`classFileParser.hpp:92-110` 里那组字段很关键：

```text
_cp
_fields
_methods
_inner_classes
_nest_members
_local_interfaces
_transitive_interfaces
_combined_annotations
_klass_to_deallocate
```

它们表明 parser 在 parse 阶段持有一批元数据对象，但这些对象此时还属于 parser，自身还不属于某个正式 `InstanceKlass`。

因此 `parse_stream()` 更像在构造一个“候选类描述图”：

- 常量池已物化为 `ConstantPool`
- 字段表已物化为 `Array<u2>` / `FieldInfo`
- 方法数组已物化为 `Method*`
- 注解数组已准备好原始 payload

但最终 owner 还没确定，失败时 parser 依然能统一销毁这批对象。

### 3.4 这一步做的是局部结构合法性，不是完整链接

最容易混淆的地方在这里：`parse_stream()` 中已经会检查很多东西，所以读者容易以为“这一步已经把类完整解决了”。

实际上它主要验证的是：

- section 边界是否足够
- 索引是否落在范围内
- tag 与被引用目标类型是否匹配
- 修饰符组合是否非法
- 某些属性是否重复或长度错误

它不等于把整个类变成 fully linked 的运行时实体。这个差异在常量池、superclass/interfaces 和 verifier 边界上都很重要，下面逐节展开。

---

## 四、常量池：先登记 unresolved graph，不急着把世界都解析出来

### 4.1 tag loop 的目标是把字节槽位解释成 HotSpot 的 CP 形状

`parse_constant_pool_entries()` 是一个从 1 开始的 tag switch。槽 0 保留不用，`Long` 和 `Double` 按 JVMS 双槽规则多占一格。

其中最有代表性的几类是：

```text
Class / Fieldref / Methodref / InterfaceMethodref
String / NameAndType
Integer / Float / Long / Double
Utf8
MethodHandle / MethodType / InvokeDynamic / Dynamic
```

`Utf8` 的路径最值得留意，因为它不是简单“把字节抄进 CP 槽”。parser 会先验证 UTF-8 合法性，然后通过 `SymbolTable::lookup_only` 查现有 Symbol，miss 时批量累积，最后用 `new_symbols` 批量 intern。

也就是说，**字符串去重从 class file 解析阶段就开始了**。这直接把上一域 SymbolTable 的设计拉到了本域入口处。

### 4.2 `Module` / `Package` 不是完全绕开 switch

这里要专门收紧一个常见说法。

很多讲解会说 `Module` / `Package` 常量“不走这段 CP switch”。更准确的事实是：在 JDK 11u 的 `parse_constant_pool_entries()` 中，它们会进入 switch，但被作为 bad constant 19/20 记录；之后再结合 `ACC_MODULE`、module-info 相关语义走后续错误/合法路径。

也就是说，正确边界是：

```text
它们没有被当成普通类引用那样进入后续常规 class 解析语义
但并非完全绕过 constant-pool entry 解析循环
```

这类细节之所以重要，是因为它提醒我们：parser 不是只按 JVM 规范目录抄 case，而是在“能先归类的地方先归类，再把最终语义判断留给后续阶段”。

### 4.3 第一遍校验：把 CP 从“原始条目”改写成“运行时未解析条目”

`parse_constant_pool()` 不是第二次完整解析常量池，而是做第一遍交叉引用检查和运行时形状归一化。

这里会发生两件关键事：

1. 检查引用型条目的目标索引和目标 tag 是否合法
2. 把部分 class file 形态改写成 HotSpot 的 unresolved runtime 形态

典型例子：

```text
ClassIndex  → unresolved klass slot
StringIndex → unresolved string slot
```

这一步非常关键，因为它把“class file 的二级索引关系”变成了“HotSpot 运行时将来可继续解析的占位形式”。

### 4.4 加载期不等于运行期全部解析

这里必须收紧一句容易写过头的话：不能简单说“加载期只登记、不解析任何东西”。

更准确的是：

- **大量常量池符号引用** 在加载期只做结构校验并登记为 unresolved
- 但 **superclass 和 interfaces** 属于构造当前类所必须的依赖，会在加载/后处理期间就解析

对照运行时路径看更清楚：`ConstantPool::klass_at_impl`、`string_at_impl`、`resolve_constant_at_impl` 仍然承担按需解析工作。也就是说，加载阶段并没有把每个 `Methodref`、每个 `String`、每个 `Dynamic` 都变成最终直接引用。

这条分界是全文主线之一：**parser 只提前做“当前类出生必须依赖”的那部分解析，其余引用继续留到后面的链接或执行路径。**

---

## 五、字段、方法、属性：Parser 先收集原材料，再准备最终形状

### 5.1 `FieldInfo` 是固定六槽，不是七槽大礼包

字段解析最容易被讲错的点，是把 generic signature 当成 `FieldInfo` 每字段固定内联的一部分。

`fieldInfo.hpp:45-69` 明确 `FieldInfo` 的固定结构是六个 `u2` 槽：

```text
access_flags
name_index
signature_index
initval_index
low_offset
high_offset
```

parser 这边为了处理泛型签名，会在临时字段数组上预留额外空间，把 generic signature index 作为尾部辅助槽位整理进去。但 permanent `_fields` 中每个固定字段单元仍然是 6 个 `u2`。不能把最终格式写成“每字段固定 7 槽”。

### 5.2 字段解析的真正目标是为 `layout_fields()` 准备输入

`parse_fields()` 不只是把每个字段的四元组读出来，它还会根据签名把字段归入分配桶，记录 `FieldAllocationType`。这一步为后面的字段布局服务，而不是当前立刻决定最终 offset。

所以字段解析更准确的理解是：

```text
class file field declaration
  → 固定 FieldInfo 记录
  → allocation type / annotation / generic-signature 等辅助信息
  → 交给 layout_fields() 决定最终布局
```

这解释了为什么 parser 阶段不能直接把 final offset 填死到 live klass 里——因为类的完整派生形状还没算完。

### 5.3 injected fields 说明 parser 的输入不止 class file 本身

`parse_fields()` 还会处理 injected fields。也就是说，最终字段集合不完全等于 class file 明面上写出来的字段集合，JVM 自身还能为某些核心类补充内部字段。

这再次提醒我们：parser 的职责不是“忠实抄录 class file”，而是把 class file 与 HotSpot 自身运行时需求合成为最终类元数据输入。

### 5.4 `Method` 与 `ConstMethod` 不是一次连续分配

方法解析也常被讲成“一次分配 Method + 字节码 + 子表”。11u 里更准确的事实是：

- parser 先收集 `Code`、异常表、LVT、StackMapTable、注解等信息
- 然后 `Method::allocate(...)` 先分配 variable-sized `ConstMethod`
- 再分配一个单独的 `Method`，让它指向 `ConstMethod`

连续的是 `ConstMethod` 内部的 code bytes 和 inline tables，不是 `Method` 与 `ConstMethod` 作为一个整体物理连续。

### 5.5 Code 字节不是把 class file buffer 当长期 owner

`parse_method()` 读 `Code` 属性时，先在 `ClassFileStream` 中记录 `code_start = current()`，随后跳过对应字节。真正长期保存字节码时，调用的是 `m->set_code((u1*)code_start)`；`ConstMethod::set_code` 会把字节复制进自己的 inline storage。

所以 parser 没有把 class file 输入缓冲区直接挂成 `Method` 的长期 owner。它先借用这段视图，等 `ConstMethod` 分配完成再拷进去。

### 5.6 StackMapTable 这里保留的是 raw bytes，不是完整语义

`parse_stackmap_table()` 在 parser 阶段主要做的是保留原始字节数据，供 verifier 稍后使用。它不是在这里完整解释 stack map frame 语义。

这正好为下一篇 verifier 铺路：当前 parser 的职责是把验证所需的材料安全留好，不是把所有验证逻辑提前跑完。

### 5.7 类级属性：有些要部分解码，有些主要是原样保存

类级属性阶段既有要立刻转成运行时结构的，比如 `BootstrapMethods` 写进 `cp->operands()`，也有像 NestHost/NestMembers 这种要受版本门槛约束并保存起来供后续消费的。

注解属性也类似：parser 只有限处理少数 VM-significant 信息，更多时候把 raw payload 组装进 `AnnotationArray` 等 metaspace 对象，留给后续反射语义。

到这里先收一个局部结论：字段、方法、类属性在 parser 阶段的共同点不是“全部立即变成最终可执行状态”，而是**都先被转换成适合 HotSpot 进一步处理的原材料。**

---

## 六、`post_process_parsed_stream()`：为什么读完字节还不能立刻造类

### 6.1 superclass 检查故意推迟到格式校验之后

`post_process_parsed_stream()` 开头有一条很说明问题的注释：

```cpp
// We check super class after class file is parsed and format is checked
```

也就是说，superclass 的解析和语义检查故意延后到 class file 基本格式已经跑通之后。这样做能把“这份字节流像不像一个 class file”和“这个类层次在当前 VM 中是否成立”分开。

这里才会调用 `SystemDictionary::resolve_super_or_fail` 去解析 superclass。解析成功后还要继续检查：

- super 不能是 interface
- super 不能是 final

这再次说明加载期并非“绝不解析依赖”，而是把必须用于构造当前类形状的那部分解析推到合适阶段。

### 6.2 transitive interfaces、vtable、itable 和字段布局都在这里定形

在 `post_process_parsed_stream()` 中，parser 计算：

```text
_transitive_interfaces
_method_ordering
_vtable_size / _num_miranda_methods
_itable_size
_field_info + layout_fields result
_rt (reference type)
```

这些东西共同回答一个问题：

```text
如果现在开始分配 InstanceKlass，究竟要多大？
内部哪些区要预留多少空间？
字段 offset、itable/vtable 规模和引用类形态是什么？
```

也就是说，`post_process_parsed_stream()` 不是附带小修小补，而是让 parser-owned 原材料变成一份“可以据此精确分配 klass”的派生形状说明书。

### 6.3 为什么必须先有派生形状，再分配 klass

如果先随便 `new InstanceKlass`，再慢慢计算：

- 需要多大的 vtable / itable
- 需要多少 oop map block
- 字段 instance size / static size / nonstatic size
- 是普通实例类还是引用类变种

那么 klass 的内存大小、子类类型乃至部分内部区布局都还不确定。

所以顺序必须是：

```text
读原始 class file
  → 整理出派生形状
  → 再按这个形状分配 raw klass
```

这也是 `parse_stream()` 与 `post_process_parsed_stream()` 分开的最强理由：前者负责“事实材料”，后者负责“分配蓝图”。

---

## 七、`fill_instance_klass()`：所有权移交为什么像事务提交

### 7.1 分配 raw klass 之后，仍然处于可回滚状态

`create_instance_klass()` 先调用 `InstanceKlass::allocate_instance_klass(...)`，按前面算好的形状分配一个 raw klass。注意，这并不意味着类已经“正式出生”。

真正敏感的是 `fill_instance_klass()` 开头：

```cpp
_loader_data->add_class(ik, publicize);
set_klass_to_deallocate(ik);
```

类先被挂入 `ClassLoaderData` 的类链表，然后 parser 把 `_klass_to_deallocate` 指向它。这个动作的含义是：

```text
从现在开始
  → 如果后面任何一步抛异常
  → 这个 klass 不能假装不存在
  → 析构时必须把它送到 CLD deallocate list 做 safepoint 清理
```

这就是 rollback armed。

### 7.2 `apply_parsed_class_metadata()` 是真正的 ownership handoff

随后 `fill_instance_klass()` 调用：

```cpp
apply_parsed_class_metadata(ik, _java_fields_count, CHECK);
```

这里发生的不是“复制几份表”，而是把 parser-owned 关键元数据移交给 `InstanceKlass`：

```text
ConstantPool
fields
methods
inner_classes
nest_members
local_interfaces
combined_annotations
```

调用之后立刻跟着一串断言：

```cpp
assert(NULL == _cp, ...);
assert(NULL == _fields, ...);
assert(NULL == _methods, ...);
...
```

这些 `NULL` 断言非常重要。它们不是调试噪音，而是在源码层面证明：**从这一刻起，这批对象已经不再归 parser 所有，parser 析构函数也不应再回收它们。**

### 7.3 为什么 `_transitive_interfaces` 还要再晚一步移交

有个特别细的边界：`_transitive_interfaces` 不在 `apply_parsed_class_metadata()` 中立刻移交，而是等 `initialize_supers()` 之后再挂到 klass。

原因在源码注释里说得很清楚：它可能与 superclass 的 transitive interface array 共享。如果此时过早把 ownership 切换或失败回收，可能误删共享数组，导致后续 dereference 崩溃。

这说明 handoff 不是“所有字段同一时刻一刀切复制/置空”，而是按共享别名风险 carefully staged。

### 7.4 成功提交：清除回滚标记，再把 klass 设为 official

`fill_instance_klass()` 末尾真正的提交动作是：

```cpp
set_klass_to_deallocate(NULL);
set_klass(ik);
```

为什么顺序要这样？

因为只要 `_klass_to_deallocate` 还不为 NULL，parser 析构函数就会把它当作需要回滚的部分构造类；只有在确认所有阶段都成功之后，才能解除 rollback armed 状态。然后再把 `_klass` 设成官方结果，表示 parser 生命周期的成功产物已经固定。

这是一个非常接近事务提交的协议：

```text
allocate raw object
  → insert into CLD + arm rollback
  → move metadata, build remaining state
  → if anything fails, destructor rolls back
  → only at the very end disarm rollback and publish official klass
```

### 7.5 失败路径：不是立刻 delete，而是加入 deallocate list

parser 析构函数在 `classFileParser.cpp:6066-6069` 中，如果发现 `_klass_to_deallocate != NULL`，并不会直接销毁 klass，而是：

```cpp
_loader_data->add_to_deallocate_list(_klass_to_deallocate);
```

原因很直接：klass 已经可能在 CLD 的类链表中，必须在 safepoint 下安全地从这条链中移除，并连同 methods、constant pool、annotations 等一起做规范清理。

所以“解析失败就 delete klass”是错误的近似。更准确的说法是：**失败后 parser 负责把回滚对象交给 CLD 的 safepoint 清理协议。**

---

## 八、这还不是一个“可用”的类：define 与 link 是下一道边界

到这里，parser 已经成功把 `.class` 构造成 `InstanceKlass`。但它还不是最终意义上的“可执行类”。

### 8.1 parser 成功 ≠ define 成功

后续 `SystemDictionary::define_instance_class()` 才把类推进到 hierarchy/publication 边界，并把状态推进到 loaded。

所以 parser 负责的是“把字节流构造成合法的 HotSpot 类元数据对象”，不是“把这个类永久纳入系统字典并完成后续所有语义检查”。

### 8.2 define 成功 ≠ link 成功

`link_class_impl()` 才会继续做：

```text
verification
rewriter
method linking
vtable/itable initialization
```

也就是说，parser 成功以后，保留操作码、StackMapTable 语义、某些类型安全约束等问题仍然留给 verifier 和 link 阶段。

这正好解释了为什么本文只能说 parser 保留了 StackMapTable raw bytes，而不能说“类已经完全通过字节码安全验证”。

### 8.3 CDS 是另一条来源，不是 parser 自身的快路径分支

还要再收紧一个边界：CDS shared class 的恢复不是 parser 自己某个 `if (shared)` 分支里直接完成的。普通 parser path 之外，系统字典和 `KlassFactory::check_shared_class_file_load_hook()` 会决定是否直接使用共享 klass，或者因为 JVMTI 改字节而退回新 parser 路径。

所以本文讨论的是“从 bytes 造类”的慢路径；CDS 更像在运行时绕开这条慢路径，直接复用构建期已经完成过一次的结果。

---

## 九、误解澄清：八个最容易写过头的判断

1. **ClassFileParser 是否边读边直接构造完整 `InstanceKlass`？** 不是。它先构造 parser-owned 元数据，后处理派生形状，最后才统一 handoff。
2. **JVMTI 是否在 parser 内部改字节？** 不是普通路径。ClassFileLoadHook 的改写边界在 `KlassFactory`，发生在 parser 构造前。
3. **解析阶段是否把所有常量池引用都解析成直接指针？** 不是。大量 CP 项只登记 unresolved 形式；但 superclass/interfaces 等构造当前类必须依赖的部分会在加载/后处理中解析。
4. **`Module`/`Package` 是否完全绕开 CP tag switch？** 不是。它们会进入 CP entry 解析循环，但按 bad constant/后续语义边界处理，而不是走普通类引用路径。
5. **`FieldInfo` 是否固定 7 槽？** 不是。固定 per-field 结构是 6 个 `u2`；generic signature 索引属于尾部辅助槽位。
6. **`Method` 与 `ConstMethod` 是否一次连续分配？** 不是。连续的是 `ConstMethod` 内部 code + inline tables；`Method` 是分开的固定大小对象。
7. **parser 成功是否等于 class 已 verify/link？** 不是。define、verify、rewrite、method link、vtable/itable init 都在后续边界。
8. **失败后是否总是直接 delete klass？** 不是。若 klass 已挂进 CLD，parser 析构函数会把它加入 deallocate list，等 safepoint 清理。

---

## 十、收网：把 hostile byte stream 变成可交接的元数据事务

现在把全文压回最开始的问题：为什么 HotSpot 能把一段 hostile `.class` 字节流稳稳地变成 `InstanceKlass`？

因为它没有把“读取字节”“验证格式”“计算派生形状”“发布 live klass”混成一步，而是拆成了明确阶段：

```text
ClassFileStream
  → 先保证读字节安全

parse_stream()
  → 把 section 解码成 parser-owned 元数据
  → 做局部结构合法性校验

post_process_parsed_stream()
  → 解析构造当前类必须依赖的部分信息
  → 计算 vtable/itable/field layout 等派生形状

fill_instance_klass()
  → arm rollback
  → handoff metadata
  → disarm rollback
  → publish official klass
```

三句话收束全篇：

- **Parser 构造的是一份临时元数据图，不是边读边写的最终 `InstanceKlass`。**
- **加载期既不会把所有常量池都 eager 解析，也不会把当前类构造必须知道的依赖全都拖到运行时。**
- **真正把 parser-owned 数据变成 live klass 的关键，不是某个单独的读字节函数，而是 `fill_instance_klass()` 那套事务式所有权移交协议。**

下一篇顺着最后一道边界继续：为什么 parser 成功后，类还不能立刻执行？Verifier 和 StackMapTable 怎样把“格式正确的 class file”变成“类型安全、可链接的类”。

> → [02 — Verifier + StackMapTable](02-verifier-stackmap.md)
