# 06. Symbol 与辅助元数据：为什么名字要全局共享，注解却只保留原始字节

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论。本文描述 HotSpot 元数据的当前实现边界，不把这些存储布局外推成所有 JVM 的必然设计。
> **前置依赖**：[03 — 为什么 `InstanceKlass`、`ObjArrayKlass`、`TypeArrayKlass` 不能合并？](03-instanceklass-arrayklass.md)：字段数组与 `FieldInfo` 是本文字段视图的基础；[04 — 常量池与方法](04-constantpool-method.md)：常量池、方法和调用解析都反复使用 Symbol；[05 — Access API 与 barrier](05-access-api-barrier.md)：元数据长期持有的 oop 引用使用不同的句柄和访问语义
> → **后续**：[07-classfile-classloader/01 — ClassFile 解析](../07-classfile-classloader/01-classfile-parser.md)
> 关联域：11-cds、48-utilities、13-jit

## 同一个名字，为什么值得全 JVM 共享

一个 class file 里有很多名字：

```text
类名：       java/lang/String
方法名：     length
字段名：     value
描述符：     ()I、[C、Ljava/lang/String;
```

这些字节串不会只出现一次。类名既会出现在 `Class` 常量条目，也会成为 `InstanceKlass` 的名称；方法查找需要方法名和签名，字段查找也需要字段名和类型描述符。大量类加载之后，`java/lang/String`、`<init>`、`([C)V` 这样的内容会被反复引用。

如果每次读到一个名字都独立分配一份内存，JVM 会得到很多内容相同、地址不同的字符串对象。比较两个名字时还要逐字节比较，释放时还要分别判断每一份副本是否仍被使用。

但注解属性看起来也是字节数据：

```java
@Entity(table = "users")
```

为什么不把注解的所有字节也拆成 token，放进同一张全局 SymbolTable？因为注解不是单一的名字 atom。它是一段带声明上下文的结构，里面可能有类型索引、元素名、数组、枚举、嵌套注解和常量值；它通常只在反射或少数 VM 语义需要时才被完整解释。

字段遍历和 compiled inline cache 又是另一种问题。它们不需要把所有可能的关系永久整理进一张巨大的全局表，而是：

- 从紧凑字段数组上创建当前调用方需要的遍历视图
- 为某个机器码调用点临时保存一对 metadata 和接收者类型

所以本篇真正要回答的是：

**HotSpot 怎样判断一段元数据应该被做成全局共享的 canonical atom，还是保留为拥有者私有的 raw payload；当基础数据已经存在时，又为什么更倾向于创建局部视图和 call-site helper，而不是再建一张万能表？**

先画出全篇的设计图：

```text
.class 中的字节串和属性
  │
  ├─ 名字、描述符、签名
  │    └─ SymbolTable
  │         └─ Symbol：不可变 canonical atom
  │              ├─ 相同内容共享
  │              ├─ refcount 管持有关系
  │              └─ GC/unloading 后清扫零引用项
  │
  ├─ 注解属性
  │    └─ AnnotationArray / ConstMethod 尾部
  │         ├─ 按声明者保存 raw bytes
  │         ├─ VM 只有限检查少数语义
  │         └─ 反射需要时复制并解析
  │
  ├─ 字段元数据
  │    └─ FieldInfo + FieldStream
  │         └─ 按调用场景建立本类、internal 或继承层次视图
  │
  └─ compiled inline cache
       └─ CompiledICHolder
            ├─ 特定 call site 的 metadata
            ├─ receiver Klass
            └─ safepoint 延迟释放
```

一句话先记住：

**名字因为高重复、可按内容比较、适合不可变共享，所以进入 SymbolTable；注解因为是声明级复杂属性，所以保留为 owner-local raw bytes；字段流和 IC holder 则只为具体使用场景建立局部解释层。**

---

## 一、三个朴素方案，为什么都不是答案

### 1.1 每次出现名字都独立分配

最直觉的做法是：class file 解析器每读到一个 UTF-8 名字，就分配一块内存复制进去。

```text
读到 java/lang/String → new 一份
另一个类又读到它     → 再 new 一份
常量池再次引用它     → 再保存一份
```

这会造成三种浪费：

1. 内容重复，元数据空间不断膨胀
2. 名字比较只能回到长度和字节内容，无法直接利用稳定身份
3. 每份副本都有独立生命周期，类卸载时需要重复解除关系

而名字的特点恰好适合共享：它创建后不会被某个调用方改成另一个名字；只要内容相同，所有使用者需要的语义就相同。

### 1.2 所有元数据属性都进入全局 SymbolTable

第二个方案是走向另一个极端：既然 SymbolTable 能去重，就把注解、字段布局、inline cache 状态也全部做成全局 canonical 对象。

注解不适合这样处理。一个注解属性的内容不能脱离声明者理解：

```text
@Target(ElementType.FIELD)
```

它的元素值、注解类型、可见性和目标位置共同构成语义。把它拆成全局 token 会丢掉原始属性的边界；把整段注解作为全局 atom，又会把低频、结构丰富的 payload 污染到全局表中。

此外，注解的许多内容只在反射调用或特定 VM 语义中需要。类加载时为所有注解建立完整对象图，会提前解析可能根本不会被使用的注解类型和值。

### 1.3 建立覆盖所有场景的万能字段和调用表

第三个方案是给每个 `InstanceKlass` 建一张“全部字段、所有父类关系、所有反射状态、所有 compiled call site”的统一表。

它看似能让调用方查一次就拿到答案，实际会把不同生命周期的东西强行绑在一起：

- 当前类声明字段与继承字段的所有权不同
- VM 注入字段和 class file 字段的边界不同
- 反射需要的类层次遍历与 VM 内部本类字段访问不同
- compiled IC helper 会随单个机器码调用点变化，不应该成为类级永久状态

结果就是，低频场景的字段和调用状态也要让每个类支付空间和维护成本。

HotSpot 采用的是更克制的分层：

```text
稳定且高重复的基础名字 → 全局 canonical Symbol
复杂且声明相关的属性   → owner-local raw storage
具体调用方需要的关系     → 局部视图或短生命周期 helper
```

这条分层规则是本文后面四个组件的共同骨架。

---

## 二、Symbol：把重复名字压成不可变 metadata atom

### 2.1 Symbol 不是 Java String，而是元数据名字的 canonical 身份

`Symbol` 的类注释把它定义为全局 SymbolTable 中的 canonicalized string。它服务的是 HotSpot 元数据中的名字、描述符和签名，不是 Java 程序可见的 `java.lang.String` 对象。

这一区分很重要：

```text
Symbol
  → Metaspace/metadata 里的名字 atom
  → JVM 内部按内容共享
  → 不提供 Java String 的对象语义

java.lang.String
  → Java heap 对象
  → 有 Java 层方法、字段和生命周期
```

类名、方法名、字段名和签名需要的是“相同内容对应稳定共享实体”。它们不需要被建成可以被 Java 代码修改的字符对象。

### 2.2 Symbol 的物理布局：头部后面紧跟内容

`symbol.hpp:110-115` 中，Symbol 的核心字段是：

```cpp
ATOMIC_SHORT_PAIR(
  volatile short _refcount,
  unsigned short _length
);
short _identity_hash;
jbyte _body[2];
```

`_body[2]` 不应被简单称作标准 C++ flexible array member。当前实现把两个字节写在类声明里，再用 `Symbol::byte_size(int)` 在 `symbol.hpp:122-126` 中根据真实长度扩大分配：

```text
实际分配大小
  = Symbol 头部大小
  + 超过 2 字节的 body 部分
  → 按机器字对齐
```

所以 Symbol 是“一次分配得到头部和内容”的尾随布局。读取内容时，`base()` 直接指向 `_body` 起始位置，不需要再追一个字符缓冲区指针。

长度保存在 unsigned short 中，当前实现的最大 Symbol 长度是 `2^16 - 1` 字节，定义在 `symbol.hpp:117`。这里的“UTF8 character”应理解为 HotSpot Symbol 使用的 classfile 字节表示长度，不要把它泛化成用户感知的 Unicode 字符数。

### 2.3 不可变内容为什么适合共享

Symbol 构造完成后，调用方没有修改 body 的正常接口。所有持有者看到的都是同一份内容：

```text
同内容 → 同 Symbol 地址
```

这带来两个收益：

- 内容比较可以先比较长度和字节，命中后还可以复用同一个元数据实体
- 常量池、Klass、Method 和字段元数据可以共享同一名字对象，而不必各存一份 body

这里不要把“地址相同”误写成 Java 层的业务身份。它只是 HotSpot 内部 canonical metadata 身份，服务于 VM 的查找、比较和生命周期管理。

### 2.4 `_identity_hash` 不是简单的内容 hash

`Symbol::identity_hash()` 在 `symbol.hpp:151-155` 中混合了：

- Symbol 地址的一部分
- `_length`
- `_body[0]` 和 `_body[1]`
- 保存的短 hash 部分

因此它不是一个“只由完整字符串内容决定”的普通 hash。SymbolTable 的查找仍会用长度、hash 和字节内容确认命中；identity hash 不能被解释成“相同内容必然得到同一个纯内容 hash 算法结果”。

### 2.5 refcount：共享不等于永远不回收

可回收 Symbol 使用 `_refcount` 记录持有关系。`symbol.cpp:277-289` 的增加和减少使用原子操作：

```cpp
void Symbol::increment_refcount() {
  if (_refcount >= 0) {
    Atomic::inc(&_refcount);
  }
}

void Symbol::decrement_refcount() {
  if (_refcount >= 0) {
    Atomic::add(short(-1), &_refcount);
  }
}
```

`_refcount == -1` 是 `PERM_REFCOUNT`，表示永久 Symbol。CDS 共享或 arena 中的永久 Symbol 不按普通可回收 Symbol 的 refcount 路径处理。

这形成了两个边界：

```text
普通 Symbol
  → refcount 可增减
  → 归零后等待 GC/unloading 清扫

永久/共享 Symbol
  → PERM_REFCOUNT
  → 不走普通零引用删除
```

refcount 归零不是立即 `delete`。它只是说明当前没有记录中的持有者，真正的表摘除和释放要等后面的 GC cleanup 阶段。

### 2.6 `as_C_string()` 只是加终止符的字节视图

`Symbol::as_C_string()` 在 `symbol.cpp:112-118` 中把 Symbol body 复制到资源区或调用方提供的 buffer，并补一个 `\0`。

它不负责把 Symbol 重新解释成 Java 字符串，也不应被描述成完整的 Unicode 转码器。Symbol 的原始字节和 modified UTF-8 约束由 class file 与 HotSpot 的 UTF-8 工具共同决定；如果需要真正解码成 Unicode，走的是 `as_unicode()` 等路径。

---

## 三、SymbolTable：一次 intern 如何兼顾共享、并发和延迟清扫

### 3.1 先查共享数据，再决定是否创建

`SymbolTable` 继承 `RehashableHashtable<Symbol*, mtSymbol>`，但 lookup 并不是简单的“每次都拿一把全局锁”。`symbolTable.cpp:319-336` 的流程是：

```text
检查长度并计算 hash
  → 先做动态表/共享表查找
  → 命中：返回已有 Symbol
  → 未命中：获取 SymbolTable_lock
  → 锁内再次检查
  → 仍未命中才创建并插入
```

动态表命中时，`symbolTable.cpp:208-217` 会按 hash、长度和字节内容比较，并增加命中 Symbol 的 refcount。

CDS 共享 Symbol 走独立的 shared compact hashtable。`lookup_shared` 在 `symbolTable.cpp:229-256` 中参与查找；动态表和共享表的先后顺序由 `_lookup_shared_first` 这个启发式开关调整。它影响性能，不影响“相同内容必须得到正确 Symbol”的语义。

### 3.2 为什么 miss 后仍要在锁内重新查

两个线程可能同时经历：

```text
线程 A：动态查找 miss
线程 B：动态查找 miss
线程 A：准备创建 Symbol
线程 B：也准备创建 Symbol
```

如果锁内不重新查，两个线程可能为同一字节串各自创建一份动态 Symbol，canonical 约束就破坏了。

因此 `basic_add` 在 `symbolTable.cpp:500-514` 中获得锁后会再次检查 bucket。已经被另一个线程插入时，后到线程直接返回已有项；只有确认仍不存在时才分配新的 Hashtable entry 和 Symbol。

这是一种典型的“快读 + 锁内 duplicate recheck”结构：

```text
无锁查找负责常见命中
锁内复查负责 canonical 正确性
```

### 3.3 refcount 的使用者边界

SymbolTable 的 lookup 接口有一个重要的所有权约定：返回 Symbol 时，调用方将获得一个持有关系。临时持有通常通过 `TempNewSymbol` 表达，它在构造/复制时调整 refcount，在析构时释放临时持有。

因此 refcount 不是 SymbolTable 内部“对象数量”的简单统计，而是跨常量池、Klass、解析器和临时句柄的共享所有权账本。

类卸载或常量池释放时，拥有者会减少对 Symbol 的引用。只有所有持有者都释放，Symbol 才会进入零引用状态。

### 3.4 unlink 和 rehash 是两件完全不同的事

这是 SymbolTable 最容易混淆的一对动作。

`unlink` 在 `symbolTable.cpp:124-158` 中处理的是生命周期：

```text
遍历动态表
  → refcount == 0
  → 从 bucket 摘除
  → 删除 Symbol 和 entry
```

它发生在 GC/unloading 相关的清扫阶段。共享 Symbol 不按这条普通动态项路径删除。

`rehash` 在 `symbolTable.cpp:182-203` 中处理的是表结构：当 bucket 分布过于不均衡时，重新计算或重建表结构，减少恶劣冲突带来的查找成本。它不会因为 refcount 为零而删除 Symbol，也不是一次“死符号回收”。

```text
unlink → 回收没人持有的内容
rehash  → 修复 bucket 分布
```

把这两个动作都叫“SymbolTable 清理”会让读者错过生命周期和数据结构维护之间的区别。

### 3.5 名字字节与 modified UTF-8 的边界

HotSpot Symbol 保存的是 class file/VM 使用的名字字节。`SymbolTable::lookup_unicode` 会把 Unicode 输入转换为 HotSpot 使用的 UTF-8 形式；HotSpot 的 UTF-8 工具对 U+0000 使用 modified UTF-8 的编码方式。

因此本文只需要保留三条事实：

- Symbol 比较和长度主要按保存的字节进行
- `as_C_string()` 主要是复制原始字节并补终止符
- 这套字节不是“任意标准 UTF-8 字符串对象”的完整替代品

这样既能解释 Symbol 为什么适合做 metadata atom，也不会把文本编码专题带进对象模型篇。

---

## 四、Annotations：复杂属性为什么保留为 owner-local raw bytes

### 4.1 注解不是全局名字 atom

`annotations.hpp:38` 直接把 `AnnotationArray` 定义为：

```cpp
typedef Array<u1> AnnotationArray;
```

这已经说明了存储策略：HotSpot 先保存一段字节数组，而不是把注解构造成一组全局共享的 Java annotation 对象。

`Annotations` 结构在 `annotations.hpp:40-68` 中保存类和字段相关的几类数据：

```text
_class_annotations
_fields_annotations
_class_type_annotations
_fields_type_annotations
```

方法侧则不同。方法声明、参数、类型和 default annotation 的数组指针位于每个 `ConstMethod` 的可选尾部，`constMethod.hpp:187-190,436-460` 提供了对应 flags 和 accessor。

因此不能说“所有注解都挂在 InstanceKlass 上”：

```text
类/字段注解     → InstanceKlass 关联的 Annotations
方法/参数注解   → 对应 Method 的 ConstMethod
```

### 4.2 parser 为什么只有限检查

类文件解析阶段需要知道某些注解是否影响 VM 行为，例如 `@Contended` 之类的 VM-significant 注解。`classFileParser.cpp:1212-1266` 的注释和逻辑表明，parser 会筛选这些对 VM 有意义的内容。

但它没有必要在每个类加载时把所有注解类型、元素值和嵌套结构都解析成最终 Java 对象。大部分注解 payload 只需要被安全地保存，等反射或其他消费者真正请求时再解释。

类型注解还有更明确的边界：`classFileParser.cpp:2769` 和 `3611` 的注释指出，某些 type annotation 属性没有必要由 VM 在加载时完整解析。

所以“注解只在反射时解释”太绝对；更准确的是：

```text
VM 加载时：有限检查 VM-significant declaration annotations
常规完整语义：由 Java reflection/type-annotation 路径按需解析
```

### 4.3 raw bytes 如何从 class file 进入元数据

parser 会把 class file 中的 annotation attribute 内容组装成 `AnnotationArray`。`classFileParser.cpp:3788-3796` 展示了分配和复制过程：

```text
计算 visible/invisible payload 大小
  → MetadataFactory::new_array<u1>
  → 复制原始 annotation bytes
  → 挂到 Annotations 或 ConstMethod
```

这不是“保存一个指向 class file 输入缓冲区的悬空指针”，而是把需要的字节复制到拥有者管理的 metaspace 元数据中。

visible 和 invisible 的保存还受 preservation policy 影响，不能简单写成“运行时不可见注解一律丢弃”。在需要保留的配置下，parser 会把它们拼接进保存的 raw array。

### 4.4 为什么不在加载时建立对象图

如果类加载阶段就把所有注解解析成 Java annotation proxy、数组和嵌套值，会有几个代价：

- 需要提前解析注解类型和元素类型
- 为可能永远不会调用的反射数据分配 Java heap 对象
- 元数据加载与 Java reflection 语义强绑定
- 注解属性的原始布局不再容易保留

raw byte storage 的交换是：

```text
类加载时少做解析、少建对象
真正反射时再复制/解析、支付使用成本
```

`Annotations::make_java_array` 在 `annotations.cpp:64-72` 中把 metaspace 的数组复制成 Java `byte[]`，随后 Java 层的 `AnnotationParser`、`TypeAnnotationParser` 等组件继续完成语义解析。

因此 raw bytes 不是“没处理”，而是把处理时机推迟到确实需要语义的边界。

### 4.5 注解存储的代价与收益

这种设计也不是免费：

- raw bytes 会随类元数据保留
- 反射时需要把 bytes 再复制到 Java heap
- 真正解析会产生额外的 Java 对象和类型检查

但它换来了三个收益：

1. 元数据格式紧凑，未使用的注解不需要提前展开
2. 同一份 raw payload 可以服务不同反射消费者
3. 类加载器和注解解析生命周期被拆开，VM 不必在加载阶段启动完整反射语义

这就是它与 SymbolTable 的分界：Symbol 通过全局去重换长期共享；AnnotationArray 通过 owner-local raw storage 换结构完整和延迟解析。

---

## 五、FieldStream：紧凑字段数组之上的局部解释视图

### 5.1 `_fields` 不是继承字段总表

上一篇已经说明，`InstanceKlass` 保存的是本类声明字段的紧凑数组。每个普通字段由六个 `u2` 槽位构成，`FieldInfo` 只是对这段数组的轻量解释视窗。

```text
InstanceKlass::_fields
  ├─ access_flags
  ├─ name_index
  ├─ signature_index
  ├─ initval_index
  ├─ low_offset
  └─ high_offset
```

`fieldInfo.hpp:45-69` 和 `instanceKlass.hpp:290-303` 给出这段布局边界。

`FieldStreamBase(InstanceKlass* klass)` 在 `fieldStreams.hpp:102-109` 中把 `_limit` 设置为 `klass->java_fields_count()`。它遍历的是当前类声明的 Java 字段，不会自动沿 superclass 链把父类字段拼进来。

如果需要按继承关系找字段，调用方必须显式沿父类或接口查找。`InstanceKlass::find_field` 的层次查找路径就是独立的逻辑。

### 5.2 generic signature 为什么放在字段数组尾部

泛型签名不是每个字段六元组中的第七个固定槽位。字段数组末尾有额外的 generic signature 索引区域，`FieldStreamBase` 通过 `init_generic_signature_start_slot()` 计算它的位置。

因此遍历器需要同时维护：

```text
当前逻辑字段 index
当前 generic signature 辅助槽位
```

`next()` 遇到泛型签名时会跳过额外槽位，而不会把它误当成一个普通字段。这个结构再次体现了 HotSpot 的偏好：高频固定字段保持紧凑，低频可选信息放到尾部辅助区域。

### 5.3 三种本地字段流表达三种边界

`fieldStreams.hpp:188-247` 中的几个 stream 名字相似，但边界不同：

```text
JavaFieldStream
  → 当前 InstanceKlass 的普通 Java 字段
  → 不含 JVM internal fields
  → static/non-static 由调用方检查

InternalFieldStream
  → 当前 InstanceKlass 的 JVM 注入字段

AllFieldStream
  → 当前 InstanceKlass 的 Java + internal 字段
  → 只在少数解析、dump 等场景使用
```

尤其要修正一个常见误解：`JavaFieldStream` 不是“只遍历实例字段”。它遍历普通 Java 字段，字段是否 static 由 `AccessFlags` 表达，调用方需要自己判断。

### 5.4 另一个同名 FieldStream 才负责反射层次

`reflectionUtils.hpp:112-135` 还有一个面向反射的 `FieldStream`。它会沿当前类、父类和接口层次构造反射所需的字段视图，和 `oops/fieldStreams.hpp` 中的 `FieldStreamBase` 不是同一个类型。

这两个类型同时存在，恰好说明“字段集合”不是一个天然唯一的概念：

```text
VM 本地字段访问 → 本类紧凑字段数组
反射字段枚举     → 类层次视图
```

如果强行把继承字段复制进每个 `InstanceKlass::_fields`，本类字段、父类字段和接口字段的所有权就会纠缠，类卸载和布局更新也要承担重复数据。

---

## 六、CompiledICHolder：compiled call site 为什么需要一个短生命周期 helper

### 6.1 它不是 cpCache，也不是一张全局表

解释器的 cpCache 保存常量池解析结果，服务字节码路径；compiled inline cache 则是已经生成的机器码调用点的局部状态。二者都可能引用 `Method*` 和 `Klass*`，但层次完全不同。

`CompiledICHolder` 继承 `CHeapObj<mtCompiler>`，`compiledICHolder.hpp:33-44` 明确它是 C heap 上的 helper object。它不是 Java heap 对象，也不是 `ConstantPoolCacheEntry` 的替代品。

核心字段在 `compiledICHolder.hpp:47-55`：

```cpp
Metadata* _holder_metadata;
Klass*    _holder_klass;
CompiledICHolder* _next;
bool _is_metadata_method;
```

这个对象只在一个特定 compiled call site 需要携带一对运行时信息时出现。

### 6.2 第一种形态：`Method* + receiver Klass*`

当调用点不能直接跳到编译后的目标，而需要经过 interpreted fallback 或 transition stub 时，holder 保存：

```text
_holder_metadata → Method*
_holder_klass    → receiver Klass*
```

`compiledIC.cpp:477-516` 的 `compute_monomorphic_entry` 会在这种场景下创建 `CompiledICHolder(method(), receiver_klass)`。

两个指针承担不同职责：

- `Method*` 是目标元数据
- receiver `Klass*` 是这次 IC 假设的接收者类型

shared runtime 在 `sharedRuntime.cpp:1633-1659` 中可以把 holder 中的 receiver Klass 与当前接收者比较。如果类型仍然匹配，这不是一个真正的类型失配，而是调用点状态正在从解释器 fallback 转成更直接的 compiled call。

### 6.3 第二种形态：`Klass* + Klass*`

在 megamorphic compiled itable call 场景，holder 的第一个 metadata 不再解释为 Method，而是 Klass。`compiledIC.cpp:223-240` 创建的形态接近：

```text
_holder_metadata → interface/holder Klass*
_holder_klass    → referenced receiver Klass*
_is_metadata_method = false
```

`_is_metadata_method` 就是那一位语义开关：第一个 `Metadata*` 应该按 Method* 还是 Klass* 解读。

这说明 holder 不是“Method 指针盒子”。它是为不同 compiled IC 状态保存一对最小必要值的 helper。

### 6.4 为什么不把两个值直接塞进机器码或 cpCache

机器码调用点需要在 patch、miss、transition 和 unloading 之间保持一致。把所有 metadata 和 receiver 类型都直接编码进机器码，会让状态更新、类型检查和生命周期管理变得复杂。

cpCache 也不适合承担这个责任：

```text
cpCache
  → class-file 常量池编号对应的链接/解析状态
  → 解释器和字节码快路径消费

CompiledICHolder
  → 某个已编译调用点的 metadata + receiver 类型
  → transition stub / compiled IC 消费
```

让 holder 成为一个独立的 C heap 对象，机器码只通过固定的 IC 状态间接引用它，HotSpot 就能把 compiled call site 的局部状态、元数据扫描和延迟释放分开管理。

### 6.5 GC/unloading 必须访问 holder 的两个引用

holder 不在 Java heap，但它里面的 `Method*`/`Klass*` 仍然是 metadata 关系。`nmethod::metadata_do()` 在 `nmethod.cpp:1549-1562` 中处理 virtual-call relocation 时，会分别访问 holder 的 `holder_metadata()` 和 `holder_klass()`。

只访问第一个 metadata 不够，因为 receiver Klass 同样决定这份 IC 状态是否还有效，也影响类加载器存活检查。

所以 holder 的生命周期不是“C heap 自己 malloc/free 就完事”：

```text
compiled IC 引用 holder
  → nmethod metadata traversal 访问两个 metadata 指针
  → unloading 检查两个关联类的存活
```

### 6.6 为什么清除后不能立即释放

当 IC stub 被清除时，其他线程可能仍在执行 transition stub。`InlineCacheBuffer` 因此不会在清除瞬间直接 `delete` holder，而是把它放进 pending release 链。

`icBuffer.cpp:209-234` 展示了这条生命周期：

```text
IC 清除
  → holder 放入 pending list
  → 到 safepoint
  → 统一释放 pending holders
```

延迟释放不是为了缓存数据，而是为了等待机器码执行者和状态切换到安全点。这里的 helper 生命周期与 Symbol refcount 完全不同：

```text
Symbol
  → 内容共享，refcount 归零后等待 GC unlink

CompiledICHolder
  → 单个 call site 状态，IC 清除后等待 safepoint release
```

---

## 七、四种存储策略放在一起看

现在把本篇四个对象放在同一张表里，不是为了记类名，而是为了比较它们各自承担的变化轴：

```text
Symbol
  内容高度重复、按字节比较
  → 全局 canonical、不可变、refcount

AnnotationArray
  内容复杂、属于某个声明、低频解析
  → owner-local raw bytes、按需复制/解析

FieldStream
  基础字段数组已存在，调用方只需某种遍历边界
  → 局部解释视图，不复制继承字段总表

CompiledICHolder
  一个机器码 call site 临时需要 metadata pair
  → C heap helper，nmethod 追踪，safepoint 延迟释放
```

这四者并不是“元数据对象的四种随机写法”，而是四种不同的成本模型：

- **重复内容成本**：用 SymbolTable 去重
- **复杂属性解析成本**：保存 raw bytes，延迟解释
- **多种遍历边界成本**：保留紧凑基础数组，按需建 view
- **compiled 状态切换成本**：为具体 call site 分配 helper，并严格管理释放时机

HotSpot 没有试图用一个数据结构解决全部问题。它先问“这份信息的重复性、可变性、消费频率和所有权是什么”，再决定是共享、局部保存、动态解释还是延迟释放。

---

## 八、误解澄清：九个边界问题

1. **Symbol 是普通 Java String 吗？** 不是。Symbol 是 HotSpot metadata 中的不可变 canonical 名字 atom；Java String 是 Java heap 对象。
2. **Symbol 的 identity hash 是完整内容 hash 吗？** 不是。当前实现还混合了地址、长度、头部字节和短 hash。
3. **Symbol refcount 归零就马上删除吗？** 不是。归零后等待 GC/unloading 阶段的 `unlink`；永久/CDS Symbol 不走普通动态删除。
4. **所有注解都在类加载时完整解析吗？** 不是。VM 只有限检查少数 VM-significant 注解，常规完整解析主要留给反射和 type-annotation 消费者。
5. **所有注解都存放在 InstanceKlass 吗？** 不是。类/字段族群由 `Annotations` 关联，方法/参数/default/type annotation 主要存于对应 `ConstMethod`。
6. **JavaFieldStream 包含继承字段吗？** 不包含。它遍历当前 `InstanceKlass` 的本地字段；跨类层次反射使用另一个 `reflectionUtils.hpp` 中的 FieldStream。
7. **JavaFieldStream 只包含非 static 字段吗？** 不是。static/non-static 是字段属性，调用方自行检查。
8. **CompiledICHolder 等于 cpCache entry 吗？** 不是。cpCache 服务字节码常量池解析，CompiledICHolder 服务某个已编译调用点的局部状态。
9. **holder 从机器码移除后马上释放吗？** 不是。它进入 pending release list，到 safepoint 再释放。

---

## 九、收网：基础数据紧凑存放，派生关系按场景出现

回到开头的两个问题：为什么名字全局共享，而注解保留 raw bytes？为什么字段和 IC 不进入一张万能表？

因为它们面对的变化不同：

```text
名字
  → 内容重复且身份稳定
  → canonicalize，所有者共享

注解
  → 结构丰富且属于声明
  → owner-local 保存，使用时解析

字段遍历
  → 基础数据已紧凑存储
  → 用 FieldStream 表达具体边界

compiled IC
  → 状态属于一个机器码调用点
  → 用 CompiledICHolder 暂存最小 metadata pair
```

三个结论收束全文：

- **共享不是越多越好：只有高重复、不可变、按内容比较的名字适合全局 canonicalize。**
- **保留 raw bytes 不是偷懒：它把复杂属性的解析成本推迟到真正需要语义的消费者。**
- **局部 view 和 helper 不是重复造轮子：它们把继承边界、编译状态和释放时机留在真正拥有这些关系的场景里。**

到这里，06-oops 这一组文章的对象模型链条闭合了：对象头给出类型入口，Klass 组织类型能力，InstanceKlass 和数组类承载运行时仓库，常量池把符号解析成可执行协议，Access API 把引用访问交给 barrier，而 Symbol、注解和辅助元数据则说明这些基础材料如何被压缩、共享、延迟解析和局部组合。

下一篇进入第 3 批：这些 Symbol、字段数组、AnnotationArray 和 Method 最初如何从 `.class` 文件字节一步步构造成 `InstanceKlass`。

> → [07-classfile-classloader/01 — ClassFile 解析](../07-classfile-classloader/01-classfile-parser.md)
