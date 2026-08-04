# 14.3 ResolvedMethodTable 初始化——经典表 + 弱引用，三表收束

> **本文定位**：`ResolvedMethodTable::create_table()` 全线——这张表为谁服务、为什么是"SymbolTable 的表结构 + StringTable 的弱引用"的组合、redefine 怎么处理，以及三张表的设计对比收束。
>
> **前置依赖**：ch12/01（Hashtable 基础、锁模型）、ch12/02（OopStorage、弱引用概念）；ch10（`method_idnum`、redefine 概念）。

---

## 0. 它是什么——Method* 与 ResolvedMethodName 的反向映射表

### 0.0 前置概念：MethodHandle 为什么需要一个"Java 身份证"

Java 代码用 `MethodHandle` 来"持有"一个方法：

```java
MethodHandles.Lookup lookup = MethodHandles.lookup();
MethodHandle mh = lookup.findVirtual(C.class, "foo", ...);
mh.invoke(obj);    // 最终调用 C.foo()
```

`MethodHandle` 本身是 Java 对象，但它最终得指向一个具体的方法——方法的信息以 `Method*` 的形式存在于 JVM 内部的 Metaspace。Java 代码**不能直接持有 C++ 指针**——所以 JVM 需要一个小对象，把它作为"方法的 Java 身份证"：

```
Java 层持有:  MethodHandle  →  ResolvedMethodName  →  JVM 内部的 Method*
               (Java 对象)     (Java 对象，JVM 注入)   (C++ Metaspace 指针)
```

这个桥接对象就是 `ResolvedMethodName`——JVM 在启动时给它注入两个字段：`vmtarget`（指向 Method*）和 `vmholder`（指向方法所属类）。Java 代码通过持有 `ResolvedMethodName` 间接"知道是哪个方法"。

RMT 的职责：同一个 Method* 会被反复解析（不同的 invokedynamic 指令、不同的 MethodHandle 创建等）——每次都新建 `ResolvedMethodName` 浪费内存。RMT 做 **Method* → ResolvedMethodName 的缓存**（键是 Method*，值是 WeakHandle 指向的 RMN oop）：第一次查表未命中就新建并插入，之后同一个 Method* 再查直接返回已有的 Java 对象。

反过来，RMN 内部存了 `vmtarget`（Method* 指针）——这是 **RMN → Method* 的方向**（Java 层通过 RMN 找到要调的方法）。RMT 提供的 Method* → RMN 缓存与 RMN 本身的 vmtarget 字段一起，形成了双向映射。

### 0.1 服务对象：ResolvedMethodName

`java.lang.invoke.ResolvedMethodName` 是一个 Java 对象，两个关键字段：

```
ResolvedMethodName（Java 对象，堆里）
+- vmtarget: 指向 Method*（方法元数据）
+- vmholder: 指向类的镜像（保持元数据存活）
```

它把"Method*"和"Java 对象"绑在一起——MethodHandle 体系（MemberName、LambdaForm）需要从 C++ 侧的 Method* 找到对应的 Java 对象，或反向查找。

> JDK 源码中 `vmtarget` 和 `vmholder` 在 `ResolvedMethodName` 类体内是**注释**状态（`//@Injected JVM_Method* vmtarget`）——这不是被移除，而是 **JVM 注入字段**：JVM 在启动时通过 `compute_offsets` 算出这两个字段的偏移，运行时用 `Unsafe` 直接把 Method* 和类的镜象写入对象。源码中没有声明，但每个 `ResolvedMethodName` 对象在堆上运行时**确实包含这两个 8 字节的槽位**。

### 0.2 为什么需要这张表

**方法解析**（所有 invoke 指令的链接解析，不只 invokedynamic）完成后，`CallInfo` 需要持有对应的 ResolvedMethodName 对象（linkResolver 的 `set_resolved_method_name`）。每次解析都新建对象会浪费——所以建表缓存：**按 Method\* 查表，命中返回已有的 ResolvedMethodName**。

入口是 `find_resolved_method`（javaClasses.cpp）：

```
find_resolved_method(method):
  (1) ResolvedMethodTable::find_method(method)   → 命中？返回
  (2) 未命中 → 创建 ResolvedMethodName 对象（存 vmtarget/vmholder）
           → add_method 插入表
```

### 0.3 与两张表的定位差异

```
                 键                       值                    回收方式
SymbolTable      字符串内容（UTF8）    → Symbol*（C 堆/Arena）    引用计数
StringTable      字符串内容（jchar）   → interned String oop     弱引用
ResolvedMethodTable Method*（C++ 指针） → ResolvedMethodName oop  弱引用
```

三张表的条目**都会死**，区别在死亡机制：SymbolTable 靠显式引用计数（引用方递减、GC unlink 删归零的），后两者靠隐式弱引用（GC 自动检测）。结构上 RMT 最接近 SymbolTable（经典 Hashtable），但引用模型学 StringTable（弱引用）——**"经典表结构 + 弱引用"的组合**。

---

## 1. create_table() 做了什么

```cpp
static void create_table() {
  _the_table = new ResolvedMethodTable();
}
```

### 1.1 new ResolvedMethodTable()——1007 个桶

```cpp
ResolvedMethodTable()
  : Hashtable<ClassLoaderWeakHandle, mtClass>(_table_size, sizeof(ResolvedMethodEntry)) { }
```

`_table_size = 1007`——硬编码的枚举常量。注意：**1007 不是质数**（19 × 53），不像 SymbolTable 刻意选质数。为什么？这张表的条目规模天然小（只有 invokedynamic 解析过的方法才进表），桶数不需要精心设计——1007 是个够用的历史值。

> 时序：RMT 的 `create_table()` 在 `universe_init` 第 747 行调用——在 `SystemDictionary::initialize_oop_storage()`（第 692 行）之后，`vm_weak_oop_storage`（ch08/02 讲过的 OopStorage 实例）已经建好。RMT 的条目存弱引用时是从这个已建好的池子里**租槽位**。

`Hashtable<ClassLoaderWeakHandle, mtClass>`——与 SymbolTable 同一个 `BasicHashtable` 家族：桶数组 + 链表 + entry 块分配，全部复用 14.1 讲过的机制。

**数据存在哪？四层结构**——以表里已有一条缓存的条目为例（方法 m 的 Method* = 0x5000，分配到的 OopStorage 槽位在 0xA000）：

```
桶数组（1007 个 HashtableBucket，每个只装一个指针）
+- 桶 5: _entry ------------+
                            ↓
                   +--------------------------+   +--------------------------+
                   | ResolvedMethodEntry #1    |   | ResolvedMethodEntry #2    |
                   | _hash = 0x1234            |   | _hash = 0x5678            |
                   | _next --------------------+--→| _next ----------→ NULL    |
                   | _literal:                 |   | _literal:                 |
                   |   ClassLdrWeakHandle      |   |   ClassLdrWeakHandle      |
                   |   (_obj = 槽位0xA000)     |   |   (_obj = 槽位0xB000)     |
                   +--------------------------+   +--------------------------+
                         | _obj
                         ↓
             vm OopStorage 槽位 0xA000: [oop → ResolvedMethodName]
                         ↓
             Java 堆: ResolvedMethodName 对象（vmtarget=0x5000, vmholder=...）
```

| 层次 | 结构 | 存什么 |
|------|------|--------|
| 桶 | `HashtableBucket` | `_entry` 指针（链表头），不存数据 |
| 条目 | `ResolvedMethodEntry` | `_hash` + `_next` + `_literal`（ClassLoaderWeakHandle） |
| 弱引用 | `ClassLoaderWeakHandle` | `_obj` = OopStorage 槽位地址（存在 `SystemDictionary::vm_weak_oop_storage()` 里，不同于 StringTable 的 `_weak_handles`） |
| 数据本体 | `ResolvedMethodName` Java 对象 | 堆上，含 `vmtarget`（→Method*）和 `vmholder`（→类镜像） |

与 01 的 SymbolTable 对照：唯一的差异在第三列的 `_literal`——从 `Symbol*`（强指针）换成了 `ClassLoaderWeakHandle`（弱引用句柄）。其余桶结构、链表、entry 块分配完全复用 01 已讲过的机制。

### 1.2 ResolvedMethodEntry 结构

条目继承自 `HashtableEntry<ClassLoaderWeakHandle, mtClass>`，三个字段：

```cpp
// 继承来的字段（01 §1.1 已讲过）
_hash    // hash 值（Method* 的四分量 hash）
_next    // 同桶下一个条目
_literal // ClassLoaderWeakHandle = WeakHandle<vm_class_loader_data>
```

其中 `hash` 存的是 `compute_hash` 得出的四分量 composite hash（§2.1），`next` 串桶内链表，`literal` 是弱引用句柄

与 SymbolTable 的 `HashtableEntry<Symbol*, mtSymbol>` 唯一区别：**literal 从强指针换成了弱引用**。

---

## 2. 查找与插入

### 2.1 哈希：loader + 类名 + 方法名 + 签名

```cpp
compute_hash(Method* method):
  hash = loader_data->identity_hash()           ← 类加载器
  hash = hash*31 ^ klass_name->identity_hash()  ← 类名
  hash = hash*31 ^ name->identity_hash()        ← 方法名
  hash = hash*31 ^ signature->identity_hash()   ← 签名
```

四个分量缺一不可——**不同类加载器加载的同名类的方法必须分开**（这是它与 SymbolTable 按纯字符串哈希的关键差异）。

### 2.2 查找：无锁遍历

```
lookup(Method* method):
  hash → bucket(hash % 1007) → 链表遍历
    每个条目: object_no_keepalive() → vmtarget == method ? 命中 : 继续
```

`object_no_keepalive` 的名字说明一切：**只偷看、不保活**——如果条目已被 GC 回收（NULL），跳过。读路径无锁，和 SymbolTable 一致。

### 2.3 插入：持锁 + redefine 处理 + 再查

```
add_method(method, rmethod_name):
  拿 ResolvedMethodTable_lock
  (1) redefine 检查: method->is_old()？
      是 → 用 method_with_idnum 换新方法（呼应 ch10）
          换不到（被删除）→ 用 Unsafe.throwNoSuchMethodError 顶替
  (2) basic_add:
      再查一次（等锁期间别人可能已插入）→ 命中？返回已有的
      未命中 → ClassLoaderWeakHandle::create → 挂桶链表头
```

两处呼应前文：
- **redefine 检查用 `method_with_idnum`**——正是 ch10 讲的机制：idnum 不变，取到最新版本
- **锁内再查一次**——SymbolTable 同款乐观模式

### 2.4 锁模型小结

```
读（find_method/lookup）:  无锁
写（add_method）:          ResolvedMethodTable_lock  + 锁内再查
```

与 SymbolTable 完全同构，不再展开。

---

## 3. 弱引用的语义

### 3.1 ClassLoaderWeakHandle——弱引用的 peek 模式

`ClassLoaderWeakHandle = WeakHandle<vm_class_loader_data>`——名字里的 ClassLoader 指的是**条目关联类加载器数据**（ResolvedMethodName 的 vmholder 来自方法所属类），tag 决定它存哪个存储。

存储细节：它不在 StringTable 那个 OopStorage 里，而是 `SystemDictionary::vm_weak_oop_storage()`——另一个专用 OopStorage。访问模式是 `AS_NO_KEEPALIVE`：查找时先用 `peek()` 偷看（不保活），发现目标匹配后才调 `resolve()` 正式保活——这避免了弱引用条目在查表过程中被意外复活。

语义效果：ResolvedMethodName oop 没人引用时被 GC 回收，回收后条目里的 WeakHandle 变 NULL——GC 的 unlink（§3.3）扫描时删除该条目。

### 3.2 redefine 处理（呼应 ch10）

redefine 替换方法后，表中的条目还指向旧方法。两个时机处理：

```
add_method 时（新插入）:  发现旧方法 → 立即换新（get_new_method / NSME）
GC safepoint 时（adjust_method_entries）:
  遍历全表 → 条目里的 vmtarget 是旧方法？
    是 → 换新方法 / 已删除 → 换 NSME 方法
```

这保证了缓存里的 Method* 永远是当前版本——正是 ch10 讲的"idnum 不变、方法指针自动跟随"思想在另一处的应用。

### 3.3 GC 清理：unlink

```
GC 后期，unlink():
  遍历 1007 个桶
    每个条目: object_no_keepalive() == NULL（已被回收）？
      是 → WeakHandle.release()（清槽位）→ 从链表摘除 → 释放 entry
```

和 StringTable 的清理思路一致，但简单得多——没有并发表、没有懒删除，就是经典的逐桶扫描删除（因为它不是热路径，不需要无锁设计）。

---

## 4. 三表对比

### 4.1 对照表

| 维度 | SymbolTable | StringTable | ResolvedMethodTable |
|------|------------|-------------|-------------------|
| 表结构 | 经典链表哈希 | 并发无锁哈希 | 经典链表哈希 |
| 容量 | 20011（质数） | 2^16 = 65536（2 的幂） | 1007（硬编码，非质数） |
| 寻址 | hash % 20011 | hash & mask | hash % 1007 |
| 存储值 | Symbol*（强） | oop 弱引用 | oop 弱引用 |
| 存储位置 | C 堆 / Arena | OopStorage（专用） | OopStorage（vm 弱引用） |
| 锁 | 乐观（无锁读 + 锁内再查） | 无锁读 + 插入 CAS + resize 锁（扩容/批量删除共用） | 乐观（同 SymbolTable） |
| 哈希分量 | 纯字符串 | 字符串内容 | loader + 类名 + 方法名 + 签名 |
| GC 清理 | unlink（引用计数归零删） | ParState 并行 + BulkDeleteTask | unlink（逐桶扫 NULL） |
| 服务对象 | 常量池符号 | String.intern() | 方法解析（CallInfo 的 ResolvedMethodName） |

### 4.2 三种设计的差异由来

三张表不是"演进"，而是**按各自的访问模式选型**：

```
访问频率（决定锁模型）:
  SymbolTable     中频（类加载）     → 乐观锁够用
  StringTable     高频（每次 intern） → 彻底无锁
  ResolvedMethodTable 中低频（方法解析，结果有缓存）→ 经典锁就够

条目生命周期（决定引用模型）:
  SymbolTable     引用计数管理（显式递减，归零回收）→ 计数
  StringTable     弱引用（GC 隐式检测，无引用即回收）→ 弱引用
  ResolvedMethodTable 弱引用（同 StringTable）        → 弱引用
```

**锁模型由访问频率决定，引用模型由生命周期决定**——这就是三张表看似相似（都是哈希表）却走了三条技术路线的根本原因。

### 4.3 容量选择的逻辑

```
SymbolTable    20011 质数    → 取模均匀，防聚集（条目多，值得精调）
StringTable    2^16 2 的幂   → 掩码寻址（无锁表的硬件要求）
RMT            1007 硬编码   → 规模天然小，够用即可（不值得精调）
```

---

## 5. 小结

```
ResolvedMethodTable 初始化全景:
  create_table()
    +- new ResolvedMethodTable()
         +- 1007 桶经典哈希（Hashtable 家族，同 SymbolTable）
         +- ClassLoaderWeakHandle 弱引用（phantom 级，vm OopStorage）

核心机制:
  查找  : 无锁遍历 + vmtarget 比对
  插入  : 持锁 + redefine 检查（method_with_idnum）+ 锁内再查
  回收  : GC unlink 扫 NULL 条目 → release + 摘除

三表对比一句话:
  锁模型由访问频率决定（中频乐观锁 / 高频无锁 / 中低频经典锁），
  引用模型由生命周期管理方式决定（引用计数 / 弱引用）——同为哈希表，
  却因服务对象不同走上三条技术路线。
```

三张 Table 的初始化到此讲完——它们是 `universe_init` 第(10)⑪步的全部内容，也是 JVM 启动主线上"数据结构就绪"的最后一环。
