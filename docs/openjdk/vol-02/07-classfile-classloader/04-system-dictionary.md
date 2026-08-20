# 04. SystemDictionary：为什么同一个名字不一定是同一个类

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论。本文聚焦 HotSpot 11u 的类解析与并发协调路径，不把这里的 dictionary、placeholder 或 loader constraint 结构外推成 JVM 规范层面的唯一实现。
> **前置依赖**：[01 — ClassFile 解析](01-classfile-parser.md)：`InstanceKlass` 如何从字节流诞生；[03 — SymbolTable 与 StringTable](03-symbol-string-table.md)：名字可以唯一化成 `Symbol`，但名字唯一不等于类唯一
> → **后续**：[05 — ClassLoader](05-classloader-hierarchy.md)
> 关联域：06-oops、25-gc、11-cds

## 为什么 `java/lang/String` 只有一个 Symbol，却不一定只有一个类

上一篇已经把 `SymbolTable` 和 `StringTable` 区分清楚了：`java/lang/String` 这个名字在 HotSpot 里只需要一份 `Symbol`。

但这件事并没有回答另一个更危险的问题：

```text
同一个名字，是否就唯一确定一个类？
```

Java 的答案是否定的。两个不同的 `ClassLoader` 完全可以各自定义一份同名类：

```text
loader A: Shared.class -> Class A
loader B: Shared.class -> Class B
名字相同，但类型身份不同
```

这说明：

```text
名字唯一
  ≠
类唯一
```

JVM 在真正解析一个类引用时，首先问的也不是“这个名字在 VM 里有没有出现过”，而是：

```text
对当前这个发起加载的 loader 来说
这个名字已经有可用的类结果了吗？
```

SystemDictionary 就是回答这类问题的核心位置。但它不是一个“全局名字到类”的电话本。更准确地说，它是一组分层机制：

- 每个 `ClassLoaderData` 有自己的 dictionary，负责 loader 视角下的类映射
- PlaceholderTable 负责“这个类还在加载中”的并发协调
- LoaderConstraintTable 负责在必要时要求不同 loader 对同一个名字达成一致
- protection-domain cache 负责“当前访问者是否允许使用这个类”
- `record_dependency` 负责跨 loader 解析后额外补上的生命周期边

本文真正的问题是：

**为什么同一个 `Symbol` 名字并不天然对应唯一类？SystemDictionary 究竟用什么作为类解析请求的真正 key，又怎样同时满足两件看似矛盾的事：一方面允许不同 loader 隔离出不同同名类，另一方面又能在签名解析等场景下强制某些同名类必须一致？**

先把完整路线画出来：

```text
解析请求
  = (name, initiating loader, protection domain)
  │
  ├─ 规范化名字
  │    ├─ array desc     -> resolve_array_class_or_null
  │    ├─ L...; wrapper  -> 剥壳后 resolve_instance_class_or_null
  │    └─ plain name     -> resolve_instance_class_or_null
  │
  ├─ initiating loader 的 ClassLoaderData dictionary
  │    ├─ 查这个加载域里已知的类结果
  │    └─ protection domain 决定是否可直接复用
  │
  ├─ PlaceholderTable
  │    ├─ LOAD_SUPER
  │    ├─ LOAD_INSTANCE
  │    └─ DEFINE_CLASS
  │
  ├─ 实际加载结果
  │    └─ defining loader 可能与 initiating loader 不同
  │
  ├─ consistency / access / lifetime
  │    ├─ check_constraints
  │    ├─ update_dictionary
  │    ├─ validate_protection_domain
  │    └─ record_dependency
  │
  └─ 返回当前 loader 视角下可用的 Klass
```

一句话先记住：

**SystemDictionary 管的不是“全局名字唯一”，而是“在某个 initiating loader 的解析域里，这个名字现在指向哪个类结果”；而 placeholder、constraint、protection domain 和 dependency 则分别负责加载中状态、跨 loader 一致性、访问授权和生命周期。**

---

## 一、三个看似更简单的方案，为什么都会失败

### 1.1 全局 `name -> Klass` 映射

最直接的设计当然是：

```text
java/lang/String -> Klass*
com/foo/Shared   -> Klass*
```

但一旦这么做，不同加载器定义同名类的能力就彻底消失了。JVM 将再也无法表达：

```text
loader A 的 Shared
loader B 的 Shared
```

这直接破坏 Java 类型隔离的根基。

### 1.2 每个 loader 只记自己定义的类

另一个直觉是缩小范围：每个 loader 只维护自己定义过的类。

这也不够，因为 Java 层的类加载并不总是“请求者自己定义，自己使用”。委派模型下，A loader 发起请求，最后很可能是 parent loader 真正定义类；非双亲委派场景中，某个 initiating loader 也可能拿到别的 defining loader 定义的 `InstanceKlass`。

如果 dictionary 只记录“自己定义的类”，那 initiating loader 后续再次解析同一名字时，就找不到自己已经被允许复用的类结果。

所以 dictionary 的视角必须是：

```text
当前 loader 发起过并可使用的类结果
不只是它自己亲手定义的类
```

### 1.3 把“加载中”和“已经定义好”混在同一张表

第三个直觉是：既然最终都会变成 `name -> Klass`，那“加载中”也就先在这张表里占个位吧。

这会把两个语义完全不同的状态揉在一起：

- “这个类已经定义完成，可以返回给调用方”
- “这个类正在被某个线程加载/定义，别人先别动”

一旦混在一起，你很难处理：

- superclass circularity
- bootstrap loader 上的等待与唤醒
- parallel-capable loader 的并行 `LOAD_INSTANCE`
- final define token 的唯一拥有者

所以 HotSpot 明确拆分：

```text
Dictionary        → 已定义、可返回的类视图
PlaceholderTable  → 正在加载/定义中的动作状态
```

这就是本文的总骨架。

---

## 二、名字规范化：SystemDictionary 先把“你要找什么类”说清楚

### 2.1 `resolve_or_null` 先区分三种名字

`resolve_or_null` 在 `systemDictionary.cpp:244-256` 中先做名字分派：

```cpp
if (FieldType::is_array(class_name)) {
  return resolve_array_class_or_null(...);
} else if (FieldType::is_obj(class_name)) {
  TempNewSymbol name = SymbolTable::new_symbol(
      class_name->as_C_string() + 1,
      class_name->utf8_length() - 2,
      CHECK_NULL);
  return resolve_instance_class_or_null(name, ...);
} else {
  return resolve_instance_class_or_null(class_name, ...);
}
```

也就是说，SystemDictionary 入口并不把所有“类名字符串”一视同仁。它先区分：

```text
数组描述符      [Ljava/lang/String;
对象包装名      Ljava/lang/String;
普通内部名      java/lang/String
```

`L...;` 包装名会被剥壳，最终按普通内部名解析。数组描述符则走单独的数组解析路径。

### 2.2 内部名与外部二进制名也不是一回事

SystemDictionary 内部讨论的是：

```text
java/lang/String
```

但真正调用 Java 层 `ClassLoader.loadClass` 时，会先转成：

```text
java.lang.String
```

这个转换发生在 `load_instance_class` 调 Java loader 之前。等 Java 层返回类对象后，VM 还会校验返回类的内部名是否和请求一致。

所以“同名解析请求”里的“名字”，必须理解成：**规范化后的内部类名**，而不是调用方随手传进来的任意字符串壳子。

### 2.3 protection domain 不是 class identity 的第三个坐标

解析入口还带着 `protection_domain`。这很容易让人误写成：

```text
类身份 = (loader, name, protection domain)
```

这在 HotSpot 11u 中不对。

更准确的关系是：

```text
initiating loader + name
  → 决定当前解析域里在找哪一类结果

protection domain
  → 决定当前请求者是否被允许使用已找到的类
  → 并作为访问授权缓存维度挂在 dictionary entry 上
```

也就是说，PD 会影响“这次 lookup 能否直接返回已有类”，但不会让同一 loader/name 产生第二个不同 `InstanceKlass`。

---

## 三、Dictionary：为什么每个 `ClassLoaderData` 都要有自己的类视图

### 3.1 `Dictionary` 真实存的不是“名字字符串”，而是 `InstanceKlass*`

`Dictionary` 在 `dictionary.hpp:42-50` 里是 `Hashtable<InstanceKlass*, mtClass>`，还有一个 `_loader_data` backpointer。

这意味着：

- value 是 `InstanceKlass*`
- entry 的主 literal 不是 `Symbol*`
- 整张表属于某个 `ClassLoaderData`

名字用于 hash 和匹配，但表真正承载的是“当前 loader 视角下的已定义/已知类对象”。

### 3.2 `DictionaryEntry` 里的 protection domain set 是访问缓存，不是 identity

`dictionary.hpp:117-143` 对 `DictionaryEntry` 的注释很关键。它明确说：entry 描述的是

```text
{ InstanceKlass*, protection_domain }
```

并进一步解释 `_pd_set` 存的是一组三元组缓存：

```text
(InstanceKlass C, initiating class loader ICL, Protection Domain PD)
```

注释还特意强调：`C.protection_domain()` 和这里缓存的 `PD` 不是一回事。

这说明 PD set 的职责是：

```text
某个 initiating loader + PD
是否已经被证明可以使用这个已存在的类
```

而不是：

```text
给同一个名字创建更多“按 PD 区分”的类定义
```

### 3.3 `find` 与 `find_class` 的区别，正好分离“访问授权”和“已定义类”

`resolve_instance_class_or_null` 开头第一次查表调用的是：

```cpp
dictionary->find(d_hash, name, protection_domain)
```

`Dictionary::find` 在 `dictionary.cpp:334-345` 中会先按名字找 entry，再检查 `is_valid_protection_domain`。

而后续在 `SystemDictionary_lock` 下复查和等待循环中，调用的是 `find_class`——它只按 name 找 `InstanceKlass`，不做 PD 检查。

这正说明 HotSpot 把两个问题拆开了：

```text
有没有这个类结果
当前请求能不能直接使用它
```

不要把这两步混成“查字典命中/未命中”。

### 3.4 “per-loader dictionary”最好说成 “per-ClassLoaderData 的 initiating view”

`ClassLoaderData` 头文件的注释已经说得很准确：dictionary 里保存的是

```text
The loaded InstanceKlasses, including initiated by this class loader
```

这句话非常重要。它意味着 dictionary 不是简单地“我自己定义了哪些类”，而是“在我这个 CLD 视角里，哪些类结果已经可用”。

因此本文最好避免把它写成“每个 loader 一张只存自己定义类的表”。更准确的说法是：

**每个 `ClassLoaderData` 有一张 dictionary，记录这个 initiating loader 视角下已经可返回的类结果。**

这为下一节“initiating loader 与 defining loader 可以不同”埋下了基础。

---

## 四、PlaceholderTable：为什么“加载中”必须有独立结构

### 4.1 PlaceholderEntry 不是单个状态值，而是三条动作队列加一个 define token

`placeholders.hpp:67-81` 先定义了三种 action：

```text
LOAD_INSTANCE
LOAD_SUPER
DEFINE_CLASS
```

如果只看这三个枚举名，很容易误以为 placeholder entry 就是一个“当前状态 = LOAD_INSTANCE/LOAD_SUPER/DEFINE_CLASS”的状态机。

实际完全不是。`PlaceholderEntry` 在 `placeholders.hpp:146-162` 中持有的是：

- `_superThreadQ`
- `_loadInstanceThreadQ`
- `_defineThreadQ`
- `_definer`
- `_instanceKlass`
- `_supername`
- `_loader_data`

也就是说，同一个 `(name, loader_data)` placeholder entry 可以同时表达：

```text
谁正在为这个类加载 superclass
谁正在做 LOAD_INSTANCE
谁排队等待 DEFINE_CLASS
当前 define token 归谁
成功定义出来的 InstanceKlass 是谁
```

这就是为什么不能把 placeholder 简化成“加载中状态枚举”。

### 4.2 为什么 Dictionary 和 Placeholder 可以短暂共存

现稿里最容易被写过头的一句，就是“字典里是已定义类，占位符表里是正在定义类，所以类只会出现在其中一个地方”。

源码不是这么说的。

`find_and_remove` 的注释与实现说明，placeholder 只有在所有 action queue 都为空且 `definer` 为 null 时才被完全移除。也就是说，一个类已经有了 dictionary entry，placeholder 仍可能暂时存在，用于清理剩余并发动作。

因此更精确的边界是：

```text
Dictionary      → 已定义/已可返回的类结果
PlaceholderTable→ 针对同一 (name, loader) 的 in-progress actions

二者职责不同，因此可短暂共存
```

### 4.3 `LOAD_SUPER` 的真正含义不是“superclass 本体状态”

`LOAD_SUPER` 最容易被误解成“某个 superclass 正在加载”。更准确的说法是：**当前线程正在为这个 child class 做 superclass/superinterface 解析路径上的工作。**

`resolve_super_or_fail` 会为 child class 建立 `LOAD_SUPER` 记录；如果同一线程再次在同一 `(child name, loader)` 上看到自己的 `LOAD_SUPER`，说明产生了 superclass circularity。

所以 `LOAD_SUPER` 的重点不是某个父类对象本身，而是：

```text
当前线程关于这个 child class 的超类解析路径
```

### 4.4 `LOAD_INSTANCE` 与 `DEFINE_CLASS` 也不是同一步

`LOAD_INSTANCE` 表示“准备/正在执行 `load_instance_class`”。

`DEFINE_CLASS` 则是“最终定义操作的 token”。这两者分开，说明 HotSpot 不把“去用户加载器问一遍”与“真正把类定义进系统可见结构”混成同一步。

特别是 parallel-capable loader 场景下：

- 多个线程可以并行推进 `LOAD_INSTANCE`
- 但 `DEFINE_CLASS` 最终仍需要一个 owner/definer token，保证不会为同一 `(name, loader)` 产出两个不同 `InstanceKlass`

---

## 五、并发与循环加载：为什么要“查、锁、再查、占位、再查”

`resolve_instance_class_or_null` 是全文最值得按理解顺序重写的函数。它不是“先查，没有就 loadClass”。更真实的顺序是：

### 5.1 第一次查：带 protection domain 的快路径

一开始先：

```cpp
Klass* probe = dictionary->find(d_hash, name, protection_domain);
if (probe != NULL) return probe;
```

这是“带访问授权缓存”的最外层快路径。

### 5.2 决定要不要拿 loader object lock

如果 `class_loader` 不是 bootstrap 且不是 parallel-capable，则要获取 loader object lock。注释明确说，这是为了和 Java/JNI defineClass 使用的同一把 loader 对象锁对齐，避免等待者看不到成功结果而重复 define。

bootstrap loader 和 parallel-capable loader 不在这里拿这个锁。

### 5.3 锁内第二次查：只看有没有类，不看 PD

拿到 loader lock 后，在 `SystemDictionary_lock` 下用 `find_class` 再查一次，只看当前 dictionary 里是否已经存在同名类。因为此时真正关心的是“有没有类结果已经出现”，而不是“当前 PD 是否已缓存授权”。

### 5.4 处理已有 `LOAD_SUPER`

如果 placeholder entry 存在且有 `LOAD_SUPER`，就调用 `handle_parallel_super_load`。这里的逻辑不是简单等别人，而是：

- 先让当前线程也做必要的 superclass circularity 检查
- 再按 loader 类型决定是否等待
- 等待时不断复查 dictionary 和 placeholder

这一步解释了为什么 HotSpot 不可能只靠“类加载器对象锁”解决所有并发：superclass 解析路径本身就是另一条需要显式表达的 in-progress 状态。

### 5.5 处理 `LOAD_INSTANCE`：等待、循环、自身重入检测

对 bootstrap 和非 parallel-capable loader，如果已经有人在做 `LOAD_INSTANCE`：

- 若同一线程已经在 `LOAD_INSTANCE` 队列里，直接构成 circularity error
- 否则等待当前 load 完成
- 唤醒后再回头查 dictionary 和 placeholder

这一步最能说明 placeholder 的价值：没有它，你无法区分“这个类不存在”和“这个类正由别人加载中”。

### 5.6 登记 `LOAD_INSTANCE` 后还要再做一次最终复查

即便拿到了 `LOAD_INSTANCE` token，代码还会再调用一次 `find_class`。这是为了覆盖 parallel-capable loader 这类不拿 loader object lock 的路径：你终于占到了 token，但在这之前，类也可能已经由别的线程完成加载并发布到了 dictionary。

所以这条路径为什么反复“查字典”，答案不是啰嗦，而是：**每一个等待、拿锁、占位的边界都会改变并发世界的状态，必须重新观察。**

### 5.7 真正的加载与最终 PD 验证反而在后面

只有确定没人替你完成工作、并且自己已经正确登记 placeholder 后，才调用 `load_instance_class`。

等拿到 `InstanceKlass` 结果之后，还要：

- 在需要时做 constraint/dependency/update_dictionary
- 清掉 `LOAD_INSTANCE` placeholder 并 `notify_all`
- 最后如果 `protection_domain != NULL`，再做 `dictionary->is_valid_protection_domain` / `validate_protection_domain`

这也再次说明：**protection domain 不是前置的 class identity 组成部分，而是返回前的可用性授权边界。**

---

## 六、initiating loader 与 defining loader：为什么一个请求会得到“别人定义的类”

### 6.1 `load_instance_class` 只保证“得到一个类结果”，不保证定义者是当前 loader

对于 bootstrap loader，`load_instance_class` 可能从 shared class path、VM class loader 或 define path 得到类。

对于普通 Java loader，它最终调用的是 Java 层 `ClassLoader.loadClass`。Java 层完全可能返回一个由 parent loader 或其他 defining loader 定义好的 `Class`。

所以 `resolve_instance_class_or_null` 里会专门检查：

```cpp
k->class_loader() != class_loader()
```

这说明：

```text
当前解析请求的 initiating loader
  ≠
实际定义该 InstanceKlass 的 defining loader
```

### 6.2 这时为什么要 `check_constraints`、`record_dependency`、`update_dictionary`

一旦 defining loader 不等于 initiating loader，HotSpot 必须补三步：

1. `check_constraints`：确认这个跨 loader 返回不会违反已有 loader constraints
2. `record_dependency`：为 GC 看不到的跨 loader 关系补一条生命周期边
3. `update_dictionary`：把这个 `InstanceKlass` 登记到 initiating loader 的 dictionary 里，作为它后续同名请求的可用结果

这三步共同回答：

```text
你可以使用一个不是你自己定义的类
但这种使用必须被记账、约束并缓存到你的解析域里
```

### 6.3 这就是“同一个类可出现在多个 initiating 视图中”的真正含义

这里最容易误解成“那不就是把类复制了很多份吗”。不是。

实际情况是：

```text
同一个 InstanceKlass
  → defining loader 固定一份
  → 可被多个 initiating loader 的 dictionary 引用为已知结果
```

所以 dictionary 的语义必须说成“initiating view”，而不是“定义者私有仓库”。

---

## 七、LoaderConstraintTable 与 protection domain：一致性和访问授权不是一回事

### 7.1 `check_constraints` 先看同 loader 重定义，再看全局约束

`SystemDictionary::check_constraints` 的注释在 `systemDictionary.cpp:2085-2092` 已经把两层逻辑点破：

- `defining == true`：同 loader 下已有同名类就是 duplicate definition
- initiating loader 路径：若已存在且 `InstanceKlass` 相同，可接受

随后真正的代码分两步：

1. 查当前 initiating loader dictionary 中是否已存在同名类
2. 若没有冲突，再调用 `constraints()->check_or_update(...)`

这说明 LoaderConstraintTable 不是“先于字典存在的全局真理”，而是**在本 loader 视角不冲突之后，再去协调跨 loader 一致性**。

### 7.2 LoaderConstraintTable 不是对所有同名类做全局唯一化

这也是最容易写偏的地方。

LoaderConstraintTable 只在“相关链接关系”上建立约束。典型来源是：

- 方法签名中的类型
- 字段解析
- vtable/itable 相关链接
- 其他要求两个 loader 域对某个类型名解释一致的链接关系

也就是说，它不是“所有同名类都必须全局相同”，而是：

```text
只有当两个 loader 域通过链接语义被要求共享同一个名字解释时
才建立约束并要求结果一致
```

否则，不同 loader 完全可以各自定义同名类而互不冲突。

### 7.3 protection domain 是访问授权缓存，不是 identity 维度

前面已经从 `DictionaryEntry` 注释看到，PD set 缓存的是：

```text
这个 initiating loader + 这个 PD
是否已经被证明可以访问这个类
```

`validate_protection_domain` 失败时，失败的是当前访问请求，而不是“需要再创建另一个按 PD 区分的类定义”。

所以千万不要写成：

```text
不同 protection domain 会得到不同同名类
```

在 HotSpot 11u 的 dictionary/PD 设计里，这不是事实。

正确的分层是：

```text
隔离       → per-CLD dictionary
一致性     → LoaderConstraintTable
访问授权   → protection-domain cache + validate_protection_domain
```

这三者必须拆开讲。

---

## 八、`record_dependency`：为什么解析完还要补一条生命周期边

### 8.1 并非所有跨 loader 关系都能靠普通 GC 可达性自动保住

当 initiating loader 使用了另一个 defining loader 返回的类时，如果这条关系不是 parent delegation 或同 loader 关系，普通 GC 引用图不一定天然能看出来“initiating loader 存活期间，这个 defining loader 还必须保留”。

因此 `record_dependency` 在 `classLoaderData.cpp:398-450` 中会：

- 跳过 permanent/builtin CLD
- 跳过 same loader / parent loader
- 对匿名类使用 mirror 依赖
- 对其他情况把 defining loader 相关对象记进 initiating loader 的 `_handles`

源码注释直接说了目的：这是“一条 GC 不一定能自己发现的依赖”，需要显式补上。

### 8.2 这不是“把 defining loader 永远钉住”

`record_dependency` 只在特定条件下加边，而且这条边的语义是：**在 initiating loader 的 CLD 还活着时，保持 defining loader 的 CLD 不被过早卸载。**

它不是：

- 对所有解析请求都强加依赖
- 永久 pin 住 defining loader
- 让两个 loader 变成互相强引用直到 VM 退出

这个边界一定要讲清，否则读者会把 dependency 理解成一个粗暴的全局 retain 机制。

---

## 九、误解澄清：八个最容易写过头的判断

1. **Symbol 唯一是否意味着类唯一？** 不是。Symbol 只保证名字字节唯一，不保证不同 loader 下类身份唯一。
2. **类身份是否由 `(loader, name, protection_domain)` 三元组决定？** 不是这么写。initiating loader + 规范化名字决定解析域；protection domain 是访问授权缓存维度，不是 class identity 主键。
3. **Dictionary 是否是“全局电话本”？** 不是。实现上是 per-`ClassLoaderData` dictionary，SystemDictionary 只是协调这些 dictionary 与全局 helper structures。
4. **不同 protection domain 是否会得到第二个同名类？** 不会。PD 控制访问授权与缓存，不创建第二份定义。
5. **Placeholder 是否只是一个“加载中状态”枚举？** 不是。它是多条 action queue、define token 和成功结果的组合结构。
6. **并行加载是否允许同一 loader 下最终产生两个不同 `InstanceKlass`？** 不允许。parallel-capable loader 允许竞争请求并行推进，但最终定义仍由 `DEFINE_CLASS` token 协调到一个结果。
7. **LoaderConstraintTable 是否为所有同名类建立全局唯一约束？** 不是。它只在相关链接关系上要求名字解释一致。
8. **`record_dependency` 是否让 defining loader 永不卸载？** 不是。它只为 GC 看不到的跨 loader 关系补上生命周期边，并有明确跳过条件。

---

## 十、收网：SystemDictionary 管的不是“名字唯一”，而是“解析域里的类结果”

回到开头的问题：为什么同一个 `java/lang/String` Symbol 不够定位一个类？

因为类解析请求真正包含的不只是名字，还包含“这个名字在谁的解析域里被发起”。SystemDictionary 先回答的是：

```text
对当前 initiating loader 来说
这个名字现在能否对应到某个可用的 InstanceKlass？
```

然后它再用额外层来补齐：

```text
PlaceholderTable      → 处理加载中状态与并发/循环加载
LoaderConstraintTable → 在必要链接关系上强制一致性
ProtectionDomain      → 决定当前访问者能否使用已有类
record_dependency     → 补上 defining loader 的生命周期边
```

三句话收束全文：

- **SystemDictionary 不是全局 name->klass 电话本，而是以 initiating loader 为中心的一组解析域与协调结构。**
- **同名类既可以在不同 loader 下隔离存在，也可以在特定链接关系下被 loader constraints 强制解释一致。**
- **名字、并发、一致性、访问授权和生命周期是五个不同问题，HotSpot 故意用 dictionary、placeholder、constraint、PD cache 和 dependency 分层解决。**

下一篇就顺着这条线回到 Java 层：双亲委派、`loadClass`、parent chain 和 parallel-capable policy，如何与这里的 VM 内部解析协议配合。

> → [05 — ClassLoader](05-classloader-hierarchy.md)
