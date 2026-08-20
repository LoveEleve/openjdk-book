# 05. ClassLoader：双亲委派如何接上 VM 的解析与回收协议

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论。本文聚焦 JDK 11 的 Java `ClassLoader` / `BuiltinClassLoader` 路径，以及它们如何与 HotSpot 的 bootstrap、SystemDictionary 和 `ClassLoaderData` 协议拼接起来。
> **前置依赖**：[04 — SystemDictionary](04-system-dictionary.md)：initiating/defining loader、dictionary、placeholder 和 dependency 已经建立；[42-core-native/03 — ClassLoader + I/O + TimeZone](../42-core-native/03-class-io.md)：`defineClass` 与 `findBootstrapClass` 的 JNI/JVM 入口
> → **后续**：[06 — JPMS Modules](06-jpms-modules.md)
> 关联域：06-oops、25-gc、11-cds

## 为什么“双亲委派”不是一张简单的三层箭头图

讲 Java 类加载时，最常见的一张图是：

```text
AppClassLoader
    ↓
PlatformClassLoader
    ↓
BootstrapClassLoader
```

然后再配上一句非常顺嘴的话：

```text
先问父，再问父的父，直到 bootstrap
```

这张图的问题不是全错，而是太容易把真正重要的边界抹平：

- `parent == null` 不等于“没有父也没有委派”，而是切到 bootstrap 的 VM 路径
- JDK 11 的 builtin loader 不只是沿父链问，还要先按 package/module owner 路由
- 真正拥有类元数据生命周期的不是 Java `ClassLoader` 对象，而是 VM 侧的 `ClassLoaderData`

上一章已经把 VM 侧问题讲清了：SystemDictionary 处理的是

```text
哪个 initiating loader 请求了哪个名字
最终哪个 defining loader 交回了哪个 InstanceKlass
```

这一章要解决的是它的 Java 侧前半段：

**Java 层 `loadClass` 的双亲委派，到底如何把“向谁问”这个问题传给 VM？为什么 platform 的 `getParent()` 看起来是 null，却仍然能委派到 bootstrap？JDK 11 里 platform 又为什么可能按模块把请求交给 app loader？最后，真正负责这些 loader 名下元数据生死的，为何不是 Java `ClassLoader` 本体，而是 `ClassLoaderData`？**

先把三层拼图画出来：

```text
Java call: loader.loadClass(name)
  │
  ├─ Java delegation
  │    ├─ getClassLoadingLock(name)
  │    ├─ findLoadedClass(name)
  │    ├─ parent.loadClass(...) or findBootstrapClassOrNull(name)
  │    ├─ findClass(name)
  │    └─ resolveClass(c)
  │
  ├─ Builtin routing
  │    ├─ package/module owner lookup
  │    ├─ internal parent
  │    └─ own class path
  │
  ├─ VM bridge
  │    └─ findBootstrapClassOrNull -> native -> JVM_FindClassFromBootLoader
  │         -> SystemDictionary::resolve_or_null
  │
  └─ VM ownership
       ├─ SystemDictionary 决定 lookup / define / publish
       └─ ClassLoaderData 决定 dictionary、_klasses、metaspace 与 unloading lifecycle
```

一句话先记住：

**双亲委派真正拆开的是“谁先尝试寻找类”和“谁最终定义类”；而真正拥有这些类元数据生死的，不是 Java `ClassLoader` 对象，而是每个 linking domain 对应的 `ClassLoaderData`。**

---

## 一、三个看似更简单的方案，为什么都不成立

### 1.1 把类加载画成三级单线搜索图

如果只从老式 Java 书本印象出发，很容易写成：

```text
app 没找到 → 问 platform
platform 没找到 → 问 bootstrap
bootstrap 没找到 → 抛异常
```

这个模型最大的问题是：它把 JDK 9+ 模块化后引入的 package/module owner routing 完全吞掉了。

`BuiltinClassLoader` 自己就承认，它和 regular delegation model 不同。它会先看类名属于哪个 package，再看这个 package 是哪个 builtin loader 名下的模块。也就是说，请求不一定沿固定父链往上递归，先可能横向切到别的 builtin loader。

如果继续画单线图，你就解释不了：

- 为什么 platform loader 会在升级模块场景下把请求交给 app loader
- 为什么模块所属 loader 和 `getParent()` 暴露出来的 parent 链不是一回事

### 1.2 把 `parent == null` 理解成“不再委派”

默认 `ClassLoader.loadClass` 恰恰把 parent 为 null 当作另一种委派：

```java
if (parent != null) {
    c = parent.loadClass(name, false);
} else {
    c = findBootstrapClassOrNull(name);
}
```

这里的 `null` 不是“没有父也没有下一跳”，而是：

```text
Java `ClassLoader` 对象链到头
  → 切到 bootstrap 的 VM 路径
```

如果把 `platform.getParent() == null` 讲成“它没有父，因此不会继续委派”，就会把 bootstrap 这整条 native / SystemDictionary 链抹掉。

### 1.3 把 Java `ClassLoader` 当成元数据生命周期 owner

第三个常见误区是：某个 Java loader 加载了类，所以它自己理应就是这些类元数据的 owner。

HotSpot 的真实组织是：Java `ClassLoader` 只是 API 和委派协议的宿主；真正代表 loader linking domain 和元数据集合的，是 VM 侧的 `ClassLoaderData`。后者拥有：

- dictionary
- `_klasses`
- metaspace
- `_handles`
- package/module 表
- deallocate / unloading 流程

这就是为什么：

- bootstrap 虽然在 Java API 里常以 null 表示，仍然有 singleton CLD
- anonymous class 可以在同一个 Java loader 下拥有独立 CLD
- GC 卸载流程是按 CLD graph 扫，而不是按 Java loader 对象逐个析构

因此本文必须把三个层次分开：

```text
Java ClassLoader  → 委派与对外 API
SystemDictionary  → 名字到类结果的 VM 解析协议
ClassLoaderData   → linking domain 与元数据生命周期 owner
```

---

## 二、默认 `ClassLoader.loadClass`：双亲委派真正做了哪五步

### 2.1 第零步其实是加锁：`getClassLoadingLock(name)`

`ClassLoader.loadClass(String, boolean)` 在 `ClassLoader.java:571-606` 中一上来就：

```java
synchronized (getClassLoadingLock(name)) {
    ...
}
```

这说明类加载算法并不是一组“纯逻辑步骤”，而是天然带着并发边界。

`getClassLoadingLock` 在 `ClassLoader.java:669-679` 中的语义是：

- 非 parallel-capable loader：返回 `this`
- parallel-capable loader：按类名从 `parallelLockMap` 中取或建一个专门锁对象

所以双亲委派算法从一开始就分成两种协调方式：

```text
普通 loader     → 锁住整个 loader 对象
parallel capable→ 锁住“当前类名”的细粒度锁
```

这和上一章 VM 侧对 parallel-capable loader 不再额外拿传统 loader object lock 的逻辑是正好拼上的。

### 2.2 第一步：`findLoadedClass` 查的是 initiating-loader 视图

默认算法第一步：

```java
Class<?> c = findLoadedClass(name);
```

这句话最容易被误讲成“查这个 loader 自己 define 过的类缓存”。源码语义更精确：`findLoadedClass` 查的是**当前 loader 已被 VM 记录为 initiating loader 的类结果**。

这意味着：

```text
不一定是当前 loader 自己定义的类
也可能是它先前通过父委派成功拿到过的类
```

这一点非常重要，因为它正是 Java 层和上一章 SystemDictionary 设计的第一个接口：当前 loader 的 dictionary 记录的是 initiating view，而不是“我亲手定义的全部类”。

### 2.3 第二步：先问 parent；parent 为 null 时切 bootstrap

默认分叉是：

- `parent != null` → `parent.loadClass(name, false)`
- `parent == null` → `findBootstrapClassOrNull(name)`

这个设计恰好说明了两件事：

1. Java 层并没有把 bootstrap 当成一个普通 `ClassLoader` 对象挂在父链上
2. `null parent` 是一个桥接语义，不是“链路终止”

所以“父链到底”在源码中的真正含义是：

```text
从 Java ClassLoader 对象图切到 VM bootstrap 查找图
```

### 2.4 第三步：只有父链/boot 都失败，当前 loader 才自己找

只有 `parent.loadClass` 或 `findBootstrapClassOrNull` 都没有返回类，默认实现才会调用：

```java
c = findClass(name);
```

而默认 `findClass` 是一个抛 `ClassNotFoundException` 的占位实现，期望由子类覆盖。

这意味着默认双亲委派协议明确表达了“定义者候选”的优先级：

```text
先复用已有 initiating 结果
再复用 parent / bootstrap 的定义
最后当前 loader 才有机会自己成为 defining loader
```

### 2.5 第四步：`resolveClass` 在类找到之后

`resolve` 标志只在拿到 `Class<?>` 之后才用：

```java
if (resolve) {
    resolveClass(c);
}
```

所以 `loadClass` 的语义边界是：

```text
找到/定义 class object
  先发生
resolve / link
  后发生
```

这与 `InstanceKlass` 的 loaded / linked 分离一致，防止我们把“拿到一个 `Class` 对象”误写成“类已经完全 ready”。

### 2.6 `preDefineClass` 的安全模型不只是名字检查

当某个 loader 最终需要自己定义类时，Java define 路径会先经过 `preDefineClass`。它做的远不止类名合法性检查，还包括：

- `java.*` 包名限制
- 默认 `ProtectionDomain`
- signer / certificate 一致性

最常被引用的是 `java.*` 禁止规则。但源码条件要更精确：**platform builtin loader 不受这条 Java 层检查禁止。** 所以不要把它压缩成“所有非 bootstrap loader 都绝不允许定义 `java.*`”。

到这里先收一个结论：默认双亲委派不是一张概念箭头图，而是一段明确的 Java 协议代码，决定了请求复用、父委派、bootstrap 桥接和最终自定义的顺序。

---

## 三、builtin loaders：为什么 JDK 11 的“父链”上面还叠了一层模块路由

### 3.1 `BuiltinClassLoader` 自己就说：它 differs to the regular model

`BuiltinClassLoader.java:82-92` 的类注释几乎直接把本节标题写出来了：它使用的 delegation model differs to the regular delegation model。

根本原因是：它先把类名映射到 package，再根据 package 所属 module 的 owner loader 决定把请求发给谁。

因此 builtin loader 的“先问谁”不只是父链问题，还多了一层：

```text
这个 package 属于哪个模块
这个模块由哪个 builtin loader 管
```

### 3.2 `loadClassOrNull` 的真实顺序是“模块归属 → 内部 parent → 自己 class path”

`BuiltinClassLoader.loadClassOrNull` 在 `BuiltinClassLoader.java:590-631` 中的顺序是：

1. `findLoadedClass`
2. `findLoadedModule(cn)`
3. 若 package 落在某个已加载模块中：
   - module owner 是自己 → `findClassInModuleOrNull`
   - module owner 是别的 builtin loader → 直接委派给那个 loader
4. 否则：
   - 查内部 `parent`
   - 再查自己的 class path

这段源码直接说明：**platform loader 可能因为模块归属路由而把请求交给 app loader。**

因此，在 JDK 11 里，不能继续把“父优先”理解成唯一的上行方向。对于 builtin loader，package/module owner routing 先于普通父链。

### 3.3 对外 `getParent()` 与内部 `parent` 根本不是同一个语义字段

`BuiltinClassLoader` 构造函数在 `BuiltinClassLoader.java:156-165` 中做了一个非常重要的转换：

```java
super(name, parent == null || parent == ClassLoaders.bootLoader() ? null : parent);
this.parent = parent;
```

这意味着它同时维持两层 parent：

- 基类 `ClassLoader.parent`：供 Java API `getParent()` 暴露
- 自己的 `BuiltinClassLoader parent`：供内部路由和桥接使用

当内部 parent 是 `BootClassLoader` 时：

```text
getParent() 返回 null
但内部 parent 仍是 BootClassLoader
```

这就是为什么 `platform.getParent()` 看起来为 null，却不能得出“它没有父，也不会再委派”的结论。

---

## 四、bootstrap：为什么“它不是一个普通 `ClassLoader` 对象”要说两遍

### 4.1 VM bootstrap loader、`BootClassLoader`、`BootLoader` 是三个不同层次

这是 JDK 11 类加载里最容易混的三个名词。

#### VM bootstrap loader

这是 HotSpot VM 内部的 bootstrap loader 语义。在 Java API 中，很多地方用 `null` 表示它。默认 `ClassLoader.loadClass` 在 `parent == null` 时桥接到的，就是这条 VM bootstrap 路径。

#### `BootClassLoader`

`ClassLoaders.java:107-120` 里已经把它说得很明白：`BootClassLoader` is not used for class loading。

它更像一个 Java-side bridge object。它的 `loadClassOrNull` 只是再次调用 `JLA.findBootstrapClassOrNull(this, cn)`，把控制权桥回 VM。

#### `BootLoader`

`BootLoader.java:51-57` 则表明它只是一个 facade / utility class，用于资源、模块、service catalog、unnamed module 等 bootstrap 相关操作；它甚至不是 `ClassLoader` 子类。

所以本节最精确的结论必须是：

```text
VM bootstrap loader
  → 真正决定 bootstrap 类查找与定义的 VM 侧实体
BootClassLoader
  → Java-side bridge object
BootLoader
  → 静态 facade/helper
```

### 4.2 `findBootstrapClassOrNull` 的桥接链路

从 Java 到 VM 的桥接链路是：

```text
ClassLoader.findBootstrapClassOrNull
  → private native findBootstrapClass
  → Java_java_lang_ClassLoader_findBootstrapClass
  → JVM_FindClassFromBootLoader
  → SystemDictionary::resolve_or_null
```

所以当文章说“委派到 bootstrap”时，实际含义是：**从 Java `ClassLoader` 世界跨过 JNI/JVM bridge，进入 HotSpot 的 bootstrap lookup / define path。**

### 4.3 JDK 11 的 bootstrap 搜索已经不是 `rt.jar`

这一点必须明确收紧。

JDK 11 的 bootstrap 路径不再是“扫描 `rt.jar`”。普通 bootstrap path 在 `SystemDictionary::load_instance_class` 和 `ClassLoader::load_class` 的组合下，大致顺序是：

```text
模块/包可见性边界检查
  → CDS shared class lookup
  → --patch-module
  → runtime image / exploded modules
  → （某些受限场景）boot append / JVMTI append
```

这里要同时纠正两个旧叙事：

1. CDS 不是“在 jimage 后再试一次”的普通目录来源，而是更早的一条替代定义来源
2. bootstrap 正常路径不会去搜普通 application classpath；普通 `-cp` 属于 app loader 的范围

### 4.4 `search_append_only` 解释了为什么有时只搜 boot append

`SystemDictionary::load_instance_class` 先按 package/module 判断这个类是否应走普通 boot module/image 路径；某些类只允许在 append-only 范围内搜索，这时才把 `search_append_only=true` 传给 `ClassLoader::load_class`。

因此“bootstrap 总是 runtime image -> boot append”也不对。更精确的说法是：**是否进入 append-only 模式，是由 SystemDictionary 的 bootstrap visibility 规则先决定的。**

---

## 五、defining loader 与 initiating loader：双亲委派和上一章为什么能拼起来

### 5.1 `findLoadedClass` 的 initiating-loader 语义是第一处接缝

前面已经说过，`findLoadedClass` 查的不是“我亲手定义过的类”，而是“VM 记录为当前 loader 已知结果的类”。

这意味着当前 loader 以前通过父委派拿到过的类：

```text
第一次：沿父链/boot 成功返回
第二次：可直接通过 findLoadedClass 命中
```

这正是上一章 SystemDictionary 中“initiating loader dictionary view”的 Java 层投影。

### 5.2 parent 委派成功时，defining loader 可能根本不是当前 loader

例如 app loader 请求某个类：

- 可能最终由 platform 定义
- 也可能最终由 bootstrap VM 路径定义

于是：

```text
当前 loader = initiating loader
真正定义类的 loader = defining loader
```

这就是上一章 `k->class_loader() != class_loader()` 分支存在的原因。Java 委派成功后，VM 看到的不是“当前 loader 找到了自己的类”，而是“当前 loader 获得了别人定义的类结果”。

### 5.3 “链上通常共享一个定义”与“不同 loader 可定义同名类”都成立

这里最容易写成两种过头话：

- “整条委派链上永远只有一个定义”
- “不同 loader 随便都能定义同名类，不受影响”

更准确的真实边界是：

```text
如果委派成功
  → 多个 initiating loader 可以共享同一个 defining result

如果委派失败并由不同 defining loader 自行 defineClass
  → 同名类仍然可以并存为不同定义
```

因此双亲委派是一种“尽量先共享父定义”的策略，而不是 JVM 级别全局单定义定理。

### 5.4 Java 委派协议与上一章 VM 协议的接合点

上一章在 defining loader != initiating loader 时，HotSpot 会做：

- `check_constraints`
- `record_dependency`
- `update_dictionary`

现在把它翻回 Java 语义就很自然：

```text
当前 loader 通过 parent/bootstrap 委派得到了一个类
  → 这个类需要被登记成当前 loader 的 initiating result
  → 同时补上约束和生命周期边
```

这就是默认 `loadClass` 为什么看起来只是递归调父类，但最后却能与 SystemDictionary 那套 dictionary/constraint/dependency 协议无缝拼起来。

---

## 六、ClassLoaderData：为什么真正拥有元数据生死的是 CLD，而不是 Java loader

### 6.1 CLD 不是 Java `ClassLoader` 本体，而是 VM-side linking domain

`classLoaderData.cpp:25-47` 的注释已经把 CLD 定义得很清楚：它表示一个 loader 的 linking domain 与相关元数据集合。

Java `ClassLoader` 对象只是在隐藏字段里保存一个指向 CLD 的指针；bootstrap 即使在 Java API 里常以 null 表示，也一样拥有 singleton CLD。

所以不要写成“Java `ClassLoader` 持有 dictionary、klasses、metaspace”。更精确的对象关系是：

```text
Java ClassLoader object
  └─ hidden field -> ClassLoaderData

ClassLoaderData
  ├─ dictionary
  ├─ _klasses
  ├─ metaspace
  ├─ handles/dependencies
  └─ unloading lifecycle
```

### 6.2 CLD 具体拥有什么

`classLoaderData.hpp:221-255` 给出了最关键的字段：

- `_holder`
- `_class_loader`
- `_metaspace`
- `_klasses`
- `_dictionary`
- `_handles`
- `_packages` / `_modules` / `_unnamed_module`
- `_deallocate_list`

SystemDictionary 负责“名字如何映射到类结果”，而 CLD 负责“这批类元数据归谁所有，以及何时整体回收”。这两个层次不能再混写成一个“class loader 内部表”。

### 6.3 `add_class` 说明类真正挂到 CLD 的时机

parser 在 `fill_instance_klass` 阶段调用 `_loader_data->add_class(ik)`，随后 CLD 就把新类链进自己的 `_klasses` 列表。

这说明从 class definition 成功起，元数据所有权已经进入 CLD 领域，而不是挂在 Java loader 对象上等着某个 Java API 决定命运。

### 6.4 anonymous class 正好证明“CLD != Java loader”

anonymous class 会拥有独立 CLD，但并不作为普通类进入 SystemDictionary。其 holder 还会被切成 mirror，以便 GC 按 mirror 生命周期管理。

如果 CLD 只是 Java loader 的别名，这种“同一个 Java loader 下却出现独立 CLD”根本无从解释。

---

## 七、CLD 卸载：类卸载为什么是一批元数据一起死

### 7.1 `is_alive()` 不是“Java loader 活着吗”这么简单

`ClassLoaderData::is_alive()` 的定义非常短：

```cpp
bool alive = keep_alive() || (_holder.peek() != NULL);
```

对普通 loader 来说，主要是 `_holder` 弱引用是否还活着；但还要加上 `keep_alive()` 这条特殊边界。

### 7.2 `keep_alive` 不是通用 loader 保活机制

`_keep_alive` 在构造函数里只有两类情况初始化为 1：

- anonymous class CLD
- bootstrap/null CLD

而 `inc_keep_alive()` / `dec_keep_alive()` 的实现又只对 anonymous class 生效，源码注释明确说明它服务于匿名类解析期间和 module fixup 列表期间的存活窗口。

所以不能把它写成“任何 CLD 都可用的保活计数”。更准确的说法是：**这是匿名类与 bootstrap/null CLD 的特殊生存机制。**

### 7.3 卸载流程是 CLDG 扫描，不是每个 Java loader 自己析构

`SystemDictionary::do_unloading` 最终调用 `ClassLoaderDataGraph::do_unloading`。后者遍历整个 CLDG：

- 活 CLD：清理 `deallocate_list` 等轻量维护
- 死 CLD：调用 `unload()`，移到 unloading list
- `purge()`：真正销毁 dead CLD，并在需要时做 metaspace purge

这说明 HotSpot 里的“类卸载”根本不是面向 Java `ClassLoader` API 的事件，而是面向 **CLD graph** 的批量元数据回收协议。

### 7.4 live CLD 与 dead CLD 的 deallocate list 处理也不同

源码里还分成：

- `free_deallocate_list`：CLD 还活着，只释放安全可回收的元数据
- `unload_deallocate_list`：CLD 正在卸载，清 C-heap side structures 并让 metaspace 整体回收

所以就连“回收 deallocate list”这件事，在活 CLD 和死 CLD 上都不是同一个动作。再次证明：真正的 owner 语义在 VM 侧，而不在 Java loader 对象本身。

---

## 八、误解澄清：八个最容易写过头的判断

1. **双亲委派是否就是 app→platform→bootstrap 的单线搜索图？** 不是。builtin loader 先做 package/module owner routing，再看 internal parent，再看自己的 class path。
2. **`parent == null` 是否等于没有父也没有委派？** 不是。默认 `loadClass` 在这里桥到 `findBootstrapClassOrNull`。
3. **`BootClassLoader` 是否就是 VM bootstrap loader 本体？** 不是。它是 Java-side bridge；真正的 bootstrap 定义路径在 VM / SystemDictionary / `ClassLoader::load_class`。
4. **platform loader 是否真的“没有父”？** 对外 `getParent()` 是 null，但内部 `BuiltinClassLoader.parent` 仍可能指向 `BootClassLoader`，作为桥接层存在。
5. **`findLoadedClass` 是否只查自己定义的类？** 不是。它按 initiating-loader 语义查当前 loader 已知的类结果。
6. **委派链上是否永远只有一个定义？** 不是。委派成功时多个 loader 共享同一结果；委派失败后，不同 defining loader 仍可定义同名类。
7. **CLD 是否就是 Java `ClassLoader` 自身？** 不是。CLD 是 VM-side linking domain / metadata owner，Java loader 只是通过隐藏字段指向它。
8. **`keep_alive` 是否是通用 loader pin 机制？** 不是。它主要服务匿名类与 bootstrap/null CLD 的特殊存活窗口。

---

## 九、收网：双亲委派决定“向谁问”，CLD 决定“谁来善后”

回到开头的问题：Java 层的双亲委派到底怎样接上 VM 内部解析协议？

答案是三层拼接：

```text
Java ClassLoader
  → 决定当前请求先问谁、何时退回自己定义

SystemDictionary
  → 把这个请求翻译成 initiating/defining loader 关系
  → 处理 lookup / define / publish / constraints / dependency

ClassLoaderData
  → 真正拥有这批类元数据的生命周期
  → 决定 dictionary、_klasses、metaspace 与 unloading 的生死
```

三句话收束全文：

- **双亲委派的本质不是“三级直线搜索”，而是“先复用当前 initiating view，再沿 parent/bootstrap 协议询问，最后才自己定义”。**
- **bootstrap 之所以难讲，是因为它同时存在 VM bootstrap loader、`BootClassLoader` bridge 和 `BootLoader` facade 三个层次。**
- **真正拥有类元数据生死的不是 Java `ClassLoader` 对象，而是 VM 侧的 `ClassLoaderData`；SystemDictionary 管名字到类结果，CLD 管类到内存和卸载。**

下一篇顺着这个边界继续：既然 builtin loader 已经把模块归属叠加到了父链之上，那么 module readability、package export 和 boot-loader package ownership 又是怎样限制“谁能看见谁”的。

> → [06 — JPMS Modules](06-jpms-modules.md)
