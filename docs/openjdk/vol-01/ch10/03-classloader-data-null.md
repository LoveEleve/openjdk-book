# ClassLoaderData + ClassLoaderDataGraph + init_null_class_loader_data()

> 本文定位：`universe_init` 在堆和 Metaspace 就绪后、加载第一个 Java 类之前，调用 `ClassLoaderData::init_null_class_loader_data()` 为 bootstrap class loader 创建 CLD。本文从设计动机开始，按图层拆解 CLD 的结构、CLDG 全局链表、Klass 双向绑定、null CLD 的特殊性、构造函数细节，以及为什么这个调用必须在 universe_init 中发生。

## 需要的前置知识

| 知识项 | 说明 |
|--------|------|
| C++ 基础 | 构造函数初始化列表、虚函数、new/delete |
| OOP/Klass 模型 | ch06 的 oop 与 Klass 二分、Handle 包装 |
| Metaspace | 类元数据的 native memory 分配器。每个 CLD 有一个独立的 ClassLoaderMetaspace 实例——通过内部 BlockFreelist 管理已分/已释放的内存块。详细结构在后续 Metaspace 章节展开，本文只关注 CLD 如何使用它 |
| CAS | Compare-And-Swap 原子操作——本文会在首次出现时解释 |

---

## Layer 1: 设计动机——为什么需要 ClassLoaderData？

### 没有 CLD 之前：PermGen 时代的困境

（本节为设计动机分析——ClassLoaderData 源码注释中不包含此历史背景，是为了理解"为什么存在 CLD"而补充的上下文。）

在 Java 7 及之前的 PermGen 时代，所有类的元数据堆在一个共享的永久代中。每次加载一个类，它的 Klass、常量池、方法字节码都分配在这个共享空间里。当某个 class loader 被 GC 回收时，它加载的所有类的元数据仍然占据 PermGen 空间——这些元数据无法立即释放。

释放条件苛刻：必须等到下一次 Full GC，而且只有 CMS 收集器才可能在 Full GC 时回收 PermGen 中的类。Parallel 和 Serial 收集器根本不回收永久代。

核心矛盾：多个 class loader 共用一块元数据空间，但每个 loader 的生命周期是独立的。一个 loader 死了，它的元数据不能单独释放——因为和活着的 loader 的元数据缠在一起。

### Metaspace 时代：按 class loader 分配

Java 8 用 Metaspace 替换了 PermGen。Metaspace 的核心能力是按 class loader 独立分配：

- 每个 class loader 有自己的 `ClassLoaderMetaspace` 分配器
- 类加载时，Klass、常量池、方法元数据都从对应 loader 的 Metaspace 中分配
- class loader 被 GC 回收后，整个 Metaspace 一次性归还给操作系统

这样解决了 PermGen 的问题——但引入了一个新问题：JVM 需要一个 C++ 数据结构来管理 "每个 class loader 的元数据集合"。这个数据结构就是 ClassLoaderData（CLD）。

### CLD 扮演的角色

一个 Java ClassLoader 对象 = 一个 CLD。CLD 是 JVM 内部为每个 class loader 创建的元数据管家：

```
Java 层:     bootstrap loader  |  platform loader  |  app loader
               (C++实现)         |  (Java对象)       |  (Java对象)
                    |                    |                   |
VM 层:       null CLD          |  platform CLD     |  app CLD
```

CLD 管理四项核心数据：

| 数据 | 字段 | 用途 |
|------|------|------|
| 类链表 | `_klasses` | 这个 loader 加载的所有 Klass 的链表 |
| 类字典 | `_dictionary` | 类名到 Klass 的哈希表——加载时查重 |
| Metaspace | `_metaspace` | 这个 loader 独占的元数据分配器。每个 CLD 持有一个 ClassLoaderMetaspace 实例——类加载时 InstanceKlass、常量池等元数据从这里分配 native memory。卸载时整个 Metaspace 一次性归还 |
| 模块/包 | `_packages` / `_modules` / `_unnamed_module` | JPMS 模块系统信息 |

下表对比两种方案的核心差异：

| | PermGen（JDK 7 及之前） | Metaspace + CLD（JDK 8+） |
|---|---|---|
| 元数据空间 | 所有 loader 共享 | 每个 loader 独立 |
| class loader 死后 | 元数据占着不放 | 整个 Metaspace 释放 |
| 释放时机 | 下一次 Full GC（CMS 才有） | GC 发现 loader 死后立即标记 |
| 空间上限 | -XX:MaxPermSize | -XX:MaxMetaspaceSize |
| 实现 | 堆内 | 堆外（native memory） |

### 设计结论

CLD 的本质是"元数据的组管理"——把属于同一个 class loader 的所有元数据组织成一个独立单元。这个单元的分配、遍历、释放都以 CLD 为粒度进行。没有 CLD 之前，这些元数据是分散的；有了 CLD 之后，JVM 可以一次性对一个 class loader 的整套元数据做操作。

---

## Layer 2: ClassLoaderDataGraph——全局 CLD 链表

### 没有 CLDG 之前的问题

CLD 管理单个 class loader 的元数据，但 GC 需要找到 **所有** class loader 加载的 **所有** 类。如果没有一个全局入口，GC 遍历所有 Klass 时会退化成"先找到所有 CLD"——但没有地方维护 CLD 的集合。

### _head 单链表

`ClassLoaderDataGraph`（CLDG）解决这个问题。它是一个 `AllStatic` 工具类，不走虚拟函数、不实例化，核心状态只有一个静态指针：

```cpp
// classLoaderDataGraph.hpp
class ClassLoaderDataGraph : public AllStatic {
  static ClassLoaderData* _head;
```

代码量如图——就一个静态成员。`_head` 始终指向链表的第一个 CLD。每个 CLD 通过自己的 `_next` 字段连接到下一个：

```
_head --> null CLD --> platform CLD --> app CLD --> ... --> NULL
```

### CAS 插入：两阶段操作

`add_to_graph`（`classLoaderData.cpp:1050-1090`）分两段：非匿名 CLD 先持锁查重，然后所有 CLD 都用 CAS 插入链表。

**第一阶段——非匿名 CLD 的持锁查重。** 同一个 class loader 不能创建两个 CLD。先拿 `ClassLoaderDataGraph_lock` 检查是否已经存在：

```cpp
if (!is_anonymous) {
    MutexLocker ml(ClassLoaderDataGraph_lock);
    cld = java_lang_ClassLoader::loader_data_raw(loader());  // 查重
    if (cld != NULL) return cld;                              // 已有？直接返回
    cld = new ClassLoaderData(loader, is_anonymous);          // 没有？新建
    java_lang_ClassLoader::release_set_loader_data(loader(), cld); // 绑定到 ClassLoader 对象
} else {
    cld = new ClassLoaderData(loader, is_anonymous);          // 匿名类不走锁
}
```

匿名类 CLD 不需要锁——lambda 的 CLD 是瞬态的，不存在"同一个 lambda 被创建两次"的并发场景。

**第二阶段——CAS 插入链表头。** 无论是否匿名，都需要原子地把新 CLD 挂在 `_head` 上。这段不需要锁——用 CAS 循环即可：

```cpp
ClassLoaderData** list_head = &_head;
ClassLoaderData* next = _head;

do {
    cld->set_next(next);                                      // 新节点 → 当前头
    ClassLoaderData* exchanged = Atomic::cmpxchg(cld, list_head, next);
    if (exchanged == next) return cld;                        // CAS 成功
    next = exchanged;                                         // 被抢，重试
} while (true);
```

`NoSafepointVerifier` 确保 CAS 插入和 CLD 挂到链表之间不发生 GC——因为 `_handles` 里的 oop 需要被 GC root 扫描。
```

`exchanged == next` 表示插入成功。不相等则把 `next` 更新为当前链表头，循环重试——这称为 CAS 循环（spin loop）。

### 为什么用 CAS 不用 Mutex

两个原因：

1. 创建 class loader 本身就持有着锁。`add_to_graph` 的调用者中，非匿名 CLD 的创建路径已经持有 `ClassLoaderDataGraph_lock`：

```cpp
  if (!is_anonymous) {
    MutexLocker ml(ClassLoaderDataGraph_lock);
    // ...
  }
```

但匿名 CLD 不持任何锁——它可以在任何线程创建（lambda/trampoline）。一旦匿名 CLD 的构造函数执行完，`NoSafepointVerifier` 要求不能 GC，必须立即插入链表。此时再申请锁会破坏无 safepoint 的约定。CAS 是唯一选择。

2. 即使没有匿名 CLD 的场景，CAS 也比锁轻量。链表插入只涉及一个指针的修改，CAS 的一两条 CPU 指令就能完成，不需要进入内核态。

### do_unloading：GC 时的链表遍历

GC 通过 `do_unloading` 判断每个 CLD 是否存活。遍历从 `_head` 开始，对每个节点检查 `is_alive()`：

```cpp
  ClassLoaderData* data = _head;
  while (data != NULL) {
    if (data->is_alive()) {
```

存活节点不做任何操作——prev 指针前移，继续下一个：

```cpp
      prev = data;
      data = data->next();
      continue;
    }
```

死亡 CLD 执行析构前的准备（`unload`），然后从主链表摘除：

```cpp
    ClassLoaderData* dead = data;
    dead->unload();
    data = data->next();
```

摘除通过修改前驱的 `_next` 指针完成：

```cpp
    if (prev != NULL) {
      prev->set_next(data);
    } else {
      _head = data;
    }
```

摘除后，死亡 CLD 不是立即释放——而是挂入 `_unloading` 临时链表：

```cpp
    dead->set_next(_unloading);
    _unloading = dead;
  }
```

这个两阶段设计（先标记后释放）是 GC 协作的关键：`do_unloading` 在 GC safepoint 中从主链表移除死 CLD，但释放操作推迟到 `purge`——确保在 `do_unloading` 遍历链表的同时，其他线程不会访问到正在释放的 CLD。

核心逻辑：遍历 `_head` 链表，对每个 CLD 调用 `is_alive()`。存活的保留下一个，死亡的执行两步操作——从主链表摘除（`prev->set_next(data)`），然后挂入 `_unloading` 待删除链表（`dead->set_next(_unloading)`）。

`is_alive()` 的判断标准：如果 `_keep_alive` 为 true（null CLD 和匿名 CLD），永远返回 true。否则检查 Java ClassLoader 对象是否还活着——如果 class loader 被 GC 回收了，CLD 就死了。

### purge：最终释放

```cpp
  ClassLoaderData* next = _unloading;
  while (next != NULL) {
    ClassLoaderData* purge_me = next;
    next = purge_me->next();
```

`purge` 在 safepoint 中调用，遍历 `_unloading` 链表：

```cpp
    delete purge_me;
  }
```

每个 CLD 的析构会释放 `_dictionary`、`_metaspace`、`_packages` 等所有附属结构。所有元数据一次性归还。

---

## Layer 3: CLD 和 Klass 的双向绑定

### 没有双向绑定之前的问题

CLD 持有 `_klasses` 链表——可以顺藤摸瓜找到这个 loader 加载的所有类。这是正向引用。

反向问题：GC 标记阶段找到某个 Klass——它已经是一个 GC root（比如 `java.lang.String.class` 一直被引用）。GC 顺着这个 Klass 需要找到它所属的 ClassLoader，因为 ClassLoader 对象本身也是 Java 对象——如果 ClassLoader 被 GC 回收了，它加载的所有类的 CLD 应该被标记为 unloading。但从 Klass 本身无法 O(1) 知道"我属于哪个 CLD"——只能遍历 CLDG 全局链表逐个 CLD 查它下面的 Klass 链表，O(n)。

`Klass::_class_loader_data` 字段解决这个问题——每个 Klass 直接指向自己的 CLD。O(1) 反向查询。

### Klass 的两根指针

每个 Klass 对象内部有两根与 CLD 相关的指针：

```cpp
// klass.hpp
ClassLoaderData* _class_loader_data;  // 反指所属的 CLD
Klass*           _next_link;          // 同 CLD 内下一个 Klass
```

`_class_loader_data` 是 Klass 到 CLD 的反向指针。从任何 Klass 出发，`class_loader_data()` 返回它被哪个 CLD 管理，时间复杂度 O(1)。

`_next_link` 把同一个 CLD 内的所有 Klass 串成链表。加载新类时，它的 Klass 被插入到 CLD 的 `_klasses` 链表头部——新类排在前面，先加载的类排在后面。

### GC 怎么遍历这个双向结构

GC 遍历路径是两层结构：

- 外层循 CLDG._head 链表，访问每个 CLD
- 内层循 CLD._klasses，串在同 CLD 下的所有 Klass

```
CLDG._head --> null CLD --> platform CLD --> NULL
                  |               |
          Object,String,...    app classes
```

外层循环遍历 CLDG._head 链表，内层循环遍历每个 CLD._klasses 链表。`classes_do` 实现这个过程：

```cpp
void ClassLoaderData::classes_do(KlassClosure* klass_closure) {
  for (Klass* k = OrderAccess::load_acquire(&_klasses);
       k != NULL; k = k->next_link()) {
```

`OrderAccess::load_acquire` 保证读到的 `_klasses` 是最新值——类加载可能在其他线程并发插入 Klass。`acquire` 语义确保在这个读之后的所有内存操作不会被重排到这个读之前：

```cpp
    klass_closure->do_klass(k);
  }
}
```

### oops_do：GC 标记的一环

GC 遍历 CLD 时不仅需要遍历 Klass，还需要标记 CLD 本身持有的 Java 对象引用：

```cpp
void ClassLoaderDataGraph::oops_do(OopClosure* f, bool must_claim) {
  for (ClassLoaderData* cld = _head; cld != NULL; cld = cld->next()) {
    cld->oops_do(f, must_claim);
  }
}
```

每个 CLD 的 `_handles`（`ChunkedHandleList`）中存储着指向 Java 对象的 oop。包括 `_class_loader`（指向 Java ClassLoader 对象）——GC 需要把这些引用也标记为存活，否则 class loader 对象会被误判为垃圾。

### RedefineClasses 的场景

当 JVMTI 触发热替换（RedefineClasses）时，旧版本的 Klass 仍然保留（被标记为 "previous version"），它的 `_class_loader_data` 仍然指向同一个 CLD。GC 遍历 `_klasses` 链表时可能同时碰到当前版本和旧版本的 Klass——`is_loader_alive()` 方法统一处理：

```cpp
bool is_loader_alive() const {
  return !class_loader_data()->is_unloading();
}
```

两个版本都属于同一个 loader，loader 只要活着，两个版本在 GC 标记阶段都被认为是活的。

---

## Layer 4: null CLD——bootstrap class loader 的 VM 层代表

### 没有 null CLD 设计之前的问题

普通的 CLD 有一个 Java ClassLoader 对象与之关联——通过 `_class_loader` 指向。GC 通过判断 `_class_loader` 指向的对象是否存活，来判断 CLD 是否可以被卸载。

bootstrap class loader 由 C++ 实现，不是 Java 对象。如果直接创建一个普通 CLD 给它用，`_class_loader` 字段为 NULL。但 `is_alive()` 逻辑中，NULL 的 `_class_loader` 会被解释为 "loader 已死"——GC 会立刻卸载这个 CLD，于是 bootstrap 类的元数据被释放，JVM 崩溃。

解决方案：为 bootstrap 专门设计一个 CLD 变体——null CLD。它不是简单地复用普通 CLD 的模板再置几个 NULL 字段，而是在多个维度上走独立路径。

### _class_loader 为空

`_class_loader` 字段存的是 Java 层 ClassLoader 对象的 oop 引用。null CLD 的这个字段为 NULL——bootstrap loader 是 C++ 实现的，没有堆上的 ClassLoader 实例。强调的是：**ClassLoader 对象不存在，但 CLD 本身存在**——null CLD 就是 C++ 实现的 bootstrap loader 在 VM 层的元数据管家。

构造函数中这段判断决定了 CLD 和 Java ClassLoader 对象的绑定：

```cpp
  if (!h_class_loader.is_null()) {
    _class_loader = _handles.add(h_class_loader());
    _class_loader_klass = h_class_loader->klass();
  }
```

null CLD 传入的是空句柄 `Handle()`——`is_null()` 返回 true，跳过整个 if 块。

结果：
- `_class_loader` 保持初始值（OopHandle 的默认值，resolve 时返回 NULL）
- `_class_loader_klass` 保持 NULL——没有 `java/lang/ClassLoader` 的 Klass 与之关联

`class_loader()` 内联方法返回 `_class_loader.resolve()`。对 null CLD，这个调用返回 NULL。`is_boot_class_loader_data()` 就是通过这个 NULL 返回值来判断的：

```cpp
inline bool ClassLoaderData::is_boot_class_loader_data() const {
    return class_loader() == NULL;
}
```

### _keep_alive = 1

null CLD 在初始化列表中：

```cpp
_keep_alive((is_anonymous || h_class_loader.is_null()) ? 1 : 0),
```

`h_class_loader.is_null()` 为 true，因此 `_keep_alive` 为 1。语义：bootstrap class loader 永远不会被 GC 卸载。

后果：GC 的 `do_unloading` 在遇到 null CLD 时，`is_alive()` 永远返回 true（因为 `_keep_alive` 优先于 class loader 的存活检查）。null CLD 永远不会被移入 `_unloading` 链表，永远不会被 purge 释放。

### Bootstrap unnamed module

null CLD 的 unnamed module 通过专用工厂方法创建：

```cpp
  if (h_class_loader.is_null()) {
    _unnamed_module = ModuleEntry::create_boot_unnamed_module(this);
  }
```

不是普通的 `ModuleEntry::create_unnamed_module`，而是 `create_boot_unnamed_module`。

`_unnamed_module` 存的是 JPMS 模块元数据（`ModuleEntry`：模块名、版本、可读权限），**不存类**。类在 `_klasses` 链表里——`_unnamed_module` 只是一个分类标签，表示"从 classpath 加载的类被标记为属于 unnamed module"。每个 ClassLoader 都有一个。

bootstrap 的 unnamed module 比较特殊——正常 JDK 类都在命名模块（`java.lang.String` 在 `java.base` 模块），只有通过 `-Xbootclasspath` 打补丁进来的类才会进 bootstrap 的 unnamed module。这种操作不常见，不需要过度关注。null CLD 创建它只是因为 JPMS 要求每个 ClassLoader 都要有 unnamed module 作为兜底。

（说明：AppClassLoader 和 PlatformClassLoader 的 unnamed module 在生产中极其常用——大多数 Java 应用通过 classpath 部署，所有业务类都进各自的 unnamed module。但那是 App/Platform loader 的场景，不是 null CLD 的。）

### Dictionary 尺寸的差异

Dictionary 是类名到 `InstanceKlass` 的哈希表——**每个 CLD 持有一份独立的哈希表**。不是所有 CLD 共享一份——每个 class loader 有自己的类命名空间，两个不同的 loader 加载同名 `com.example.Foo` 返回两个不同的 Class 对象。Dictionary 就是查询"这个 loader 下有没有加载过名叫 X 的类"的依据。

`create_dictionary()` 按 CLD 类型分三个分支，选哈希表桶数：

```cpp
  if (_the_null_class_loader_data == NULL) {
    size = _boot_loader_dictionary_size;  // 1009
    resizable = true;
```

判断 `_the_null_class_loader_data == NULL` 的深意：当这个条件为 true 时，说明 `_the_null_class_loader_data` 尚未被赋值——**当前正在构造函数中创建的就是 null CLD 本身**。这时分配 1009 个桶的哈希表。bootstrap class loader 加载 500+ 个核心类，107 个桶的默认 hash 表冲突太多。1009（一个质数）能有效分散 hash 分布。

```cpp
  } else if (is_system_class_loader_data()) {
    size = _boot_loader_dictionary_size;  // 1009
  } else {
    size = _default_loader_dictionary_size;  // 107
  }
```

platform class loader 和 app class loader 也是系统 loader（`is_system_class_loader_data()`），同样分配 1009 桶。其余自定义 class loader 用默认 107 桶——大部分场景不会超过几十个类。

### 存放哪些核心类

null CLD 的 `_klasses` 链表存放了 JVM 启动后加载的第一批类。这些类没有它们 JVM 无法运行：

- `java.lang.Object`——所有类的根
- `java.lang.String`——字符串字面量的 Klass
- `java.lang.Class`——反射的基础
- `java.lang.System`——标准输入输出
- `java.lang.Thread`——线程的基础
- 所有原始类型的数组 Klass（`int[]`、`byte[]` 等的 Klass）

它们的元数据分配在 null CLD 的 `_metaspace` 中，类名存入 `_dictionary`。

---

## Layer 5: 构造函数逐行拆解——null CLD 走哪条路

`classLoaderData.cpp:144-186`。构造函数的 20+ 个字段中，对 null CLD 最重要的只有 5 个决策。在讲这些决策之前，先理解构造函数的两个参数从哪里来。

### 5.1 两个参数的含义

```cpp
_the_null_class_loader_data = new ClassLoaderData(Handle(), false);
```

**`Handle()`**——`handles.hpp:74`，默认构造函数：`_handle = NULL`。`Handle()` 创建一个空句柄——指向 NULL oop。它的 `is_null()` 返回 true，`()` 运算符返回 `(oop)NULL`。整个含义是"没有对应的 Java ClassLoader 对象"。

**`false`**——`is_anonymous` 为 false。null CLD 不是匿名 CLD（lambda 那种临时壳），它是非匿名的、功能完整的 CLD——有 dictionary、有 module、有 packages。

所以这个调用的意图是：**创建一个完整的 CLD，但它不绑定任何 Java ClassLoader 对象——因为 bootstrap 是 C++ 实现的。**

### 5.2 决策一：_keep_alive = 1——永远不死

初始化列表第 149 行：

```cpp
_keep_alive((is_anonymous || h_class_loader.is_null()) ? 1 : 0),
```

`h_class_loader.is_null()` 为 true（Handle() 空句柄）→ `_keep_alive = 1`。

`is_alive()` 的实现是 `keep_alive() || (_holder.peek() != NULL)`（`classLoaderData.cpp:697`）。`keep_alive()` 检查 `_keep_alive > 0`——null CLD 返回 true，所以 `is_alive()` 永远返回 true。GC 的 `do_unloading` 在遍历 CLDG 时检查 `is_alive()`——null CLD 永远不会被卸载。

platform loader 和 app loader 的 CLD：`h_class_loader` 不是空句柄（有真正的 Java ClassLoader 对象），`_keep_alive = 0`。它们的存活完全靠 `_holder.peek() != NULL`——GC 检查 Java ClassLoader 对象是否还活着。loader 被回收→_holder 变 NULL→is_alive 返回 false→CLD 被卸载。

### 5.3 决策二：_class_loader 不绑定 Java 对象

构造函数体第 159-162 行：

```cpp
if (!h_class_loader.is_null()) {          // null CLD: 条件为 false，跳过
    _class_loader = _handles.add(h_class_loader());
    _class_loader_klass = h_class_loader->klass();
}
```

null CLD 的 `h_class_loader` 就是 5.1 节传入的 `Handle()` 空句柄——`is_null()` 返回 true → 跳过。null CLD 的 `_class_loader` 保持默认 OopHandle（内部 NULL）。

`_class_loader` 不是直接存 oop 值——它存的是一个 `oop*` 指针，指向 `_handles` 里的槽位地址。`_handles.add(h_class_loader())` 在 ChunkedHandleList 中分配一个槽位写入 oop，返回槽位地址赋给 `_class_loader`。后续 `class_loader()` 方法调用 `_class_loader.resolve()` 解引用取出真正的 ClassLoader oop。GC 遍历 `_handles.oops_do()` 时找到这个槽位并标记。

注意这里和 5.6 节的 `_holder` 是两个不同的东西。`_class_loader`（OopHandle）存在 `_handles` 的 ChunkedHandleList 里——用于 GC 标记 class loader 对象。`_holder`（WeakHandle）存在 OopStorage 里——用于 `is_alive()` 判断 class loader 是否活着。null CLD 两个都不需要——bootstrap 没有 Java ClassLoader 对象。

`_handles` 不单存 ClassLoader oop。源码注释（`classLoaderData.hpp`）说得很清楚："Handles to constant pool arrays, Modules, etc, which have the same life cycle of the corresponding ClassLoader"——常量池数组、Module 对象等都存这里，和 ClassLoader 同生命周期。ChunkedHandleList 是分块链表（每块 32 个 oop 槽），块满串新块，单线程写入（受 `metaspace_lock` 保护），GC 并发遍历 `oops_do`。

`class_loader()` 方法（`classLoaderData.inline.hpp:34`）返回 `_class_loader.resolve()`——null CLD 下返回 NULL。`print_value_on()` 打印时检查 `class_loader() != NULL`——null CLD 走 else 分支，输出 "bootstrap"。

platform loader 和 app loader 的 CLD：条件为 true，走 `_handles.add()` 把真正的 AppClassLoader/PlatformClassLoader 的 Java 对象的 oop 注册进 handle list。GC 遍历 `_handles` 时标记这个 oop——不标记的话 class loader 对象会被当成垃圾回收。

### 5.4 决策三：_unnamed_module = boot unnamed module

构造函数体第 164-181 行。`is_anonymous = false` → 进入完整路径。先创建 holder 和 packages，然后第 173 行：

```cpp
if (h_class_loader.is_null()) {
    _unnamed_module = ModuleEntry::create_boot_unnamed_module(this);
} else {
    _unnamed_module = ModuleEntry::create_unnamed_module(this);
}
```

`h_class_loader.is_null()` 为 true → 走 `create_boot_unnamed_module`。

`create_boot_unnamed_module` 传入空 Handle——bootstrap 的 `java.lang.Module` 对象还没就绪，先创建一个空壳 ModuleEntry。后续 JVM 初始化时通过 `JVM_SetBootLoaderUnnamedModule` 回填 Java 对象。

`create_unnamed_module` 从 `java_lang_ClassLoader::unnamedModule(cld->class_loader())` 取 `java.lang.Module` 对象——但 null CLD 的 `class_loader()` 返回空 oop，这条路走不通。所以必须用 boot 版本。

platform loader 和 app loader 的 CLD：`class_loader()` 返回真实的 ClassLoader 对象，调用 `create_unnamed_module`——从 Java 对象的 `unnamedModule` 字段拿到 `java.lang.Module` 实例，建立双向引用（ModuleEntry ↔ java.lang.Module）。

### 5.5 决策四：_dictionary = 1009 桶的哈希表

```cpp
_dictionary = create_dictionary();   // 在分支二末尾
```

`create_dictionary()` 做第一个判断：`_the_null_class_loader_data == NULL`。null CLD 创建时这个全局指针还没赋值 → 条件为 true → 选 1009 桶（`_boot_loader_dictionary_size`）。1009 是质数，bootstrap 加载 500+ 个核心类，比默认 107 冲突少得多。

platform loader 和 app loader 的 CLD 创建时，`_the_null_class_loader_data` 已非 NULL → 走 `is_system_class_loader_data()` 判断——同样是 1009 桶（系统 loader）。普通自定义 class loader 走 else 分支——107 桶。

### 5.6 决策五：initialize_holder 什么也不做

```cpp
void ClassLoaderData::initialize_holder(Handle loader_or_mirror) {
    if (loader_or_mirror() != NULL) {
        _holder = WeakHandle<vm_class_loader_data>::create(loader_or_mirror);
    }
}
```

传入的 `Handle()` 空句柄 → `loader_or_mirror()` 返回 `(oop)NULL` → 跳过。null CLD 的 `_holder` 保持默认 WeakHandle（内部 `_obj` 为 NULL），`is_alive()` 中的 `_holder.peek()` 返回 NULL——全靠 `_keep_alive = 1` 撑着。

### 5.8 `_deallocate_list`——卸载时释放的元数据

`classLoaderData.hpp:263`：

```cpp
GrowableArray<Metadata*>* _deallocate_list;
```

存的是等待释放的 Metadata 指针——Method、ConstantPool、InstanceKlass 等。正常加载一个类时，元数据分配了就不会再动。但类重定义（RedefineClasses）会产生旧版本的 Klass——旧版本的元数据不能立即 `delete`，因为可能还有栈上的引用在用着。它们被暂存在 `_deallocate_list` 中，等安全的时机（GC 的 safepoint）再释放。

两个释放函数：`free_deallocate_list()` 用于**这个 CLD 还活着但需要清理旧版本的场景**——逆序遍历、检查每个 Metadata 是否还在栈上，只有不在栈上的才释放。`unload_deallocate_list()` 用于**这个 CLD 本身正在被卸载**——全部释放，同时断开 Klass 和 CLD 的双向引用。两个函数都只在 safepoint 调用。

null CLD 不需要这个字段——bootstrap 类永远不会被卸载，也不会有旧版本替换。

platform loader 和 app loader 的 CLD：构造函数传入真正的 ClassLoader Handle（非空）→ `initialize_holder` 创建 WeakHandle。WeakHandle 内部从 `SystemDictionary::_vm_weak_oop_storage`（即 02 讲的 OopStorage）分配一个 `oop*` 槽位，把 ClassLoader 对象的 oop 写进去。GC 扫描 OopStorage 时检查这个槽位——class loader 被回收→槽位置 NULL→`_holder.peek()` 返回 NULL→`is_alive()` 返回 false。

### 5.7 其他字段——全是零值或默认构造

构造函数初始化列表中有 20+ 个字段。除了上面 5 个决策点，其余全部是零值或参数：`_unloading(false)`、`_claimed(0)`、`_next(NULL)`、`_name(NULL)` 等。这些对 null CLD 没有特殊含义——只是满足 CLD 框架的统一初始化要求。

`_deallocate_list` 值得一提——它是 `GrowableArray<Metadata*>` 指针。类重定义（RedefineClasses）或类卸载时，需要释放旧版本的元数据（Method、ConstantPool、InstanceKlass）。这些待释放的 Metadata 暂时挂在这个列表上，在 safepoint 中由 `free_deallocate_list()` 或 `unload_deallocate_list()` 批量处理。null CLD 下也保持 NULL——bootstrap 类不进行热替换。

---

## Layer 6: 为什么必须在 universe_init 中执行

### 调用链的依赖顺序

`universe_init` 中相关调用的顺序：

```
initialize_heap()      --> 堆就绪，可以分配 Java 对象了
meta_init()            --> Metaspace 就绪，可以分配类元数据了
init_null_class_loader_data()  --> bootstrap CLD 就绪
CDS / 第一个类加载      --> 把类放进去
```

### 依赖关系

`init_null_class_loader_data()` 的代码中，`new ClassLoaderData(Handle(), false)` 做了几件依赖上层的事情：

1. 构造函数内部 `new PackageEntryTable(...)` 分配 PackageEntryTable——需要堆内存。堆必须已经初始化。

2. 构造函数内部 `create_dictionary()` 创建 Dictionary——Dictionary 的哈希表也需要堆内存。

3. 构造函数创建的 `_metaspace_lock`（Mutex）需要 Mutex 系统就绪。Mutex 系统在 JVM 启动的更早阶段初始化。

4. CLD 的 `_metaspace` 分配器需要 Metaspace 基础设施就绪——否则后续元数据分配会失败。

### 后续依赖

反过来，后续步骤依赖 CLD 就绪：

- 第一个 Java 类 `java/lang/Object` 加载时，它的 Klass 需要存放的 CLD——null CLD
- CDS（Class Data Sharing）初始化需要遍历 CLD 链表来确定归档中哪些类属于哪个 class loader
- SystemDictionary 初始化需要把 bootstrap 类注册到正确的 CLD 的 `_dictionary` 中

时序逻辑链条：**先有容器（CLD），再往里面放东西（Klass），再通过这些东西构建 SystemDictionary**。

### 全局可访问

`init_null_class_loader_data()` 还设置了一个全局可访问的入口：

```cpp
_the_null_class_loader_data = new ClassLoaderData(Handle(), false);
ClassLoaderDataGraph::_head = _the_null_class_loader_data;
```

此后，任何代码都可以通过 `ClassLoaderData::the_null_class_loader_data()` 获取 null CLD 的指针。不需要遍历链表，不需要查表——直接比较 this 指针。这个模式在 `is_the_null_class_loader_data()` 中被验证：

```cpp
bool is_the_null_class_loader_data() const {
  return this == _the_null_class_loader_data;
}
```

单指针比较，零开销。

---

## 总结

`init_null_class_loader_data()` 做的事：

1. 用空 Handle 创建 CLD——bootstrap class loader 没有 Java 对象
2. `_keep_alive = 1`——bootstrap 类永不卸载
3. `_dictionary` 桶数 1009——bootstrap 类多，需要大的哈希表减少冲突
4. `_unnamed_module` 用 `create_boot_unnamed_module` 创建——JPMS 引导 unnamed module
5. 把 null CLD 设为 `ClassLoaderDataGraph::_head`——全局链表头
6. 保存在 `_the_null_class_loader_data` 静态指针中——全局快速判断 "是否是 null CLD"

从这一刻起，JVM 有了装类的第一个容器。`java.lang.Object` 的 Klass 挂在 `_head->_klasses` 上，元数据分配在 `_head->_metaspace` 中，类名存入 `_head->_dictionary`。

---

## 源码清单

| 文件 | 行号 | 内容 |
|------|------|------|
| `classLoaderData.hpp` | 56-68, 180+ | CLD 类定义：`_klasses`、`_dictionary`、`_metaspace`、`_keep_alive`、`_next`、`_class_loader` 等所有字段 |
| `classLoaderData.cpp` | 88-106 | `init_null_class_loader_data()`：创建 null CLD 并挂入全局链表 |
| `classLoaderData.cpp` | 144-186 | CLD 构造函数：初始化列表 + 主体分支（is_null / is_anonymous） |
| `classLoaderData.cpp` | 558-562 | `initialize_holder`：创建 WeakHandle 绑定 Java ClassLoader 对象 |
| `classLoaderData.cpp` | 656-679 | `create_dictionary()`：按 CLD 类型选尺寸（1009 / 107 / 1） |
| `classLoaderData.cpp` | 1050-1090 | `add_to_graph()`：CAS 无锁插入全局链表 |
| `classLoaderData.cpp` | 1102-1105 | `oops_do()`：遍历所有 CLD 标记 Java 对象引用 |
| `classLoaderData.cpp` | 1373-1455 | `do_unloading()`：GC 遍历链表，标记死 CLD 并摘除 |
| `classLoaderData.cpp` | 1457-1473 | `purge()`：delete CLD，释放 Metaspace |
| `klass.hpp` | 292-297 | `_next_link` / `_class_loader_data` 双向绑定指针 |
| `classLoaderData.inline.hpp` | 34-55 | `class_loader()` / `class_loader_data()` / `find_or_create()` |
| `classLoaderDataGraph.hpp` | 全文件 | `ClassLoaderDataGraph`：`_head` 全局链表头 |
