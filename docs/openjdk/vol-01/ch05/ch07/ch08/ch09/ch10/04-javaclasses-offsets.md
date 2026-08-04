# 硬编码偏移量 —— C++ 怎么读一个还没加载的类的字段？

> **本文定位**：`universe_init` 第 685 行 `JavaClasses::compute_hard_coded_offsets()`。正常流程是：C++ 访问 Java 字段需要 SystemDictionary 找到 InstanceKlass，再查 fields 数组拿到偏移量。但 `universe_init` 执行到这里时 SystemDictionary 还是空的——一个 Java 类都没加载。
>
> 那为什么不用等？因为有些类（`Reference`、`Integer`/`Long` 等包装类型）的字段顺序是 Java 规范保证的——不需要加载类文件也能算出偏移量。本文从 oop 内存布局开始，解释这个"编译期常量 → 运行时偏移"的转换链路，以及 JVM 怎么往 Java 对象里注入 C++ 指针（InjectedField）。
>
> **阅读提示**：本文不假设你懂 SystemDictionary 或 InstanceKlass——第 1 节会从零建立这些概念。读完本文你只需要记住：字段偏移量 = 序号 * heapOopSize + 对象头大小。InjectedField 是 JVM 在 Java 对象体内藏 C++ 指针——反射看不见、零额外开销。

---

## 1. 先建基本概念

### 1.1 oop —— Java 对象在 C++ 中的替身

JVM 是 C++ 写的。在 C++ 代码中需要表示 Java 对象。HotSpot 用一个类来描述 Java 对象头（`oops/oop.hpp:55-63`）：

```cpp
class oopDesc {
 private:
  volatile markOop  _mark;            // mark word：GC 标记、锁状态、hashCode
  union _metadata {
    Klass*      _klass;              // 非压缩：8 字节指针
    narrowKlass _compressed_klass;   // 压缩：4 字节整数
  } _metadata;
};
```

`oop` 是 `oopDesc*`——指向堆上 Java 对象头的指针。这个类的成员只有对象头——mark word（8 字节）+ klass pointer（4 或 8 字节）。对象头之后是实例字段——不属于 `oopDesc`，但物理上紧挨着。

**对象头大小**：`instanceOopDesc::base_offset_in_bytes()` 返回跳过对象头后的偏移量：
- 32 位 JVM：mark(4) + klass(4) = 8
- 64 位 + compressed class pointers（默认）：mark(8) + klass(4) = 12
- 64 位非压缩：mark(8) + klass(8) = 16

### 1.2 Klass 和 InstanceKlass —— 类的 C++ 替身

每个 Java 类在 C++ 中有对应的 `Klass` 对象（注意是 `K` 开头）。`Klass` 存类的元数据：类名、字段列表、方法表、继承关系。`InstanceKlass` 是 `Klass` 的子类——代表一个普通 Java 类。

`InstanceKlass` 的 `_fields` 数组成员记录了该类所有字段的元数据。类型是 `Array<u2>*`——一个 `uint16_t` 紧凑数组。每 6 个连续的 `u2` 槽位组成一个字段描述符（`field_slots = 6`）：

```cpp
// fieldInfo.hpp:62-70
enum FieldOffset {
  access_flags_offset    = 0,  // u2: 访问标志（public/static/etc）
  name_index_offset      = 1,  // u2: 字段名在常量池中的索引
  signature_index_offset = 2,  // u2: 类型签名在常量池中的索引
  initval_index_offset   = 3,  // u2: 初始值索引
  low_packed_offset      = 4,  // u2: 偏移量低位（含 tag）
  high_packed_offset     = 5,  // u2: 偏移量高位
  field_slots            = 6
};
```

`FieldInfo` 不是一个独立分配的对象——`FieldInfo::from_field_array()` 直接把 `u2*` 强转成 `FieldInfo*`，同一块内存用不同的类型来解读。`FieldInfo` 内部 `u2 _shorts[6]`（12 字节）刚好踩在 6 个 u2 槽位上。

### 1.3 字段偏移量 —— C++ 怎么读 Java 字段

JVM 的 C++ 代码不能写 `obj->referent`——`oopDesc` 没有 `referent` 这个 C++ 成员。必须这样：

```cpp
oop* slot = obj->obj_field_addr(referent_offset);  // 从对象头偏移 offset 字节
oop referent = *slot;                               // 读这个位置存的值
```

`referent_offset` 就是这个字段的**字节偏移量**——refernt 字段相对于对象头的字节偏移。

正常的获取方式是：通过 `SystemDictionary` 找到 `Reference` 的 `InstanceKlass`，然后查 `_fields` 数组定位 `referent` 字段并返回 `fd.offset()`。

### 1.4 SystemDictionary —— 类名到 Klass 的映射

`SystemDictionary` 是一张全局哈希表——从类名（如 `"java/lang/ref/Reference"`）映射到对应的 `InstanceKlass`。这是 C++ 找到 Java 类元数据的唯一入口：

```
C++ 访问 Java 字段的完整路径:
  SystemDictionary::find("java/lang/ref/Reference")
  → InstanceKlass*
  → _fields 数组
  → 查 referent 字段的 FieldInfo
  → FieldInfo::offset()
  → obj->obj_field_addr(offset)
```

**关键事实**：`universe_init` 执行到第 685 行时，这条路径是断的。SystemDictionary 还没有初始化——没有任何 Java 类被加载。`SystemDictionary::find("Reference")` 返回 NULL。

### 1.5 为什么拿 Reference 举例子

`java.lang.ref.Reference` 是 SoftReference、WeakReference、PhantomReference、FinalReference 的父类。GC 处理引用队列时需要直接读写它的四个字段——`referent`（引用的对象）、`discovered`（GC 发现的下一引用）、`queue`（引用队列）、`next`（链表下一节点）——这几个字段在 GC 的引用处理阶段被频繁访问。

但 GC 发生时 SystemDictionary 可能还没加载 `Reference` 类。不能走"SystemDictionary→InstanceKlass→fields 查偏移量"的标准路径。只能硬编码——因为 `Reference` 的字段顺序是 Java 规范保证的，编译期就能算出偏移量。

这个模式在多个 Java 类上重复——`Integer.value`、`Long.value`、`Class.klass` 等。本文以 `Reference.referent` 为主线，讲清楚硬编码偏移量的机制后，其他类的原理完全一样。

---

## 2. 为什么不等 SystemDictionary 就绪？

### 2.1 因为现在能算——零代价

`compute_hard_coded_offsets` 覆盖两组类：

- `java.lang.ref.Reference` —— 它的 4 个字段把位置写死
- `java_lang_boxing_object` —— 8 种 Java 包装类型（Integer/Long/Short/Byte/Boolean/Character/Float/Double）共用的一套偏移量

HotSpot 的 C++ 代码中，每个 Java 类有一个对应的命名空间存字段偏移量——`java_lang_String::hash_offset`、`java_lang_Thread::eetop_offset` 等。但 Integer/Long/Short/... 这 8 个包装类型的字段布局完全一样（第一个字段都是 `value`，Long/Double 多一个 `long_value`），没必要写 8 套重复代码。HotSpot 把这 8 种合并为一个 C++ 入口叫 `java_lang_boxing_object`（不是 `java.lang.Object`）。

这两组类有一个共同特点：**它们的字段顺序由 Java 规范保证，不会随 JDK 版本或 JVM 实现而变。**

`Reference` 的四个字段 `referent`、`queue`、`next`、`discovered` 永远是声明的第 0、1、2、3 个字段。包装类（`Integer`、`Long` 等）的 `value` 永远是第 0 个字段。

因为顺序固定，偏移量可以用纯数学公式算出：

```
字节偏移 = 字段序号 * heapOopSize + 对象头大小
```

这个公式的输入全是编译期常量或启动时已知的值——不需要 `InstanceKlass`、不需要 `_fields` 数组、不需要 SystemDictionary。现在算和以后算结果一样——既然现在就能算，就在现在算，后面的代码随手用，不用管 SystemDictionary 状态。

### 2.2 和运行时偏移量的分工

其他核心类（`String`、`Class`、`Thread` 等 30+ 个）不满足这个特点——它们的字段不是第 0/1/2 个（可能排在继承字段之后），或者字段顺序没有规范保证。这些类的偏移量走另一条路径——`compute_offsets()`——在 SystemDictionary 初始化之后用 `InstanceKlass` 的字段表查：

```cpp
void JavaClasses::compute_offsets() {
  if (UseSharedSpaces) return;   // CDS 归档了偏移量——不需要重算
  BASIC_JAVA_CLASSES_DO_PART2(DO_COMPUTE_OFFSETS);  // 遍历 30+ 核心类
}
```

两条路径的分工：

| | 硬编码 (`compute_hard_coded_offsets`) | 运行时 (`compute_offsets`) |
|---|--------------------------------------|----------------------------|
| 依赖 | 无——纯编译期常量 | SystemDictionary 已加载类 |
| 条件 | 字段顺序固定（第 0/1/2... 个） | 无限制——可以查名字 |
| 时机 | universe_init 第 685 行 | universe2_init 之后 |
| 覆盖 | Reference + Boxing 共 6 个偏移 | String/Class/Thread 等 30+ 类 |

---

## 3. 硬编码偏移量 —— 从序号到字节

### 3.1 从字段序号开始

```cpp
// javaClasses.hpp —— 编译期枚举
java_lang_ref_Reference::hc_referent_offset   = 0;  // referent 是第 0 个字段
java_lang_ref_Reference::hc_queue_offset      = 1;  // queue    是第 1 个字段
java_lang_ref_Reference::hc_next_offset       = 2;  // next     是第 2 个字段
java_lang_ref_Reference::hc_discovered_offset = 3;  // discovered 是第 3 个字段
```

`hc_` = hard-coded。这些不是字节偏移——是字段序号。

### 3.2 member_offset —— 两层转换

```cpp
static int member_offset(int hardcoded_offset) {
  return (hardcoded_offset * heapOopSize) + instanceOopDesc::base_offset_in_bytes();
}
```

第一层——`* heapOopSize`：跳过前面 N 个字段。这个乘数能工作不是因为所有字段等宽，而是因为这里涉及的字段碰巧都是 `oop` 类型。Reference 的 4 个字段（referent/queue/next/discovered）全部是 `oop`——`heapOopSize` 本来就是 oop 槽位的字节宽度（压缩模式 4，非压缩 8），所以 `N * heapOopSize` 刚好跳过 N 个 oop 引用。`Integer.value` 是 `int`（4 字节），在 compressed 模式下 `heapOopSize=4` 也对得上——但 `Long.value` 是 `long`（8 字节），`4` 不够，所以 `long_value_offset` 额外做了 `align_up`（见 3.4 节）。

第二层——`+ base_offset_in_bytes()`：跳过对象头。

具体例子——64 位 + compressed oops（默认配置）：

```
referent_offset = member_offset(0)
                = 0 * 4 + 12
                = 12
```

GC 或任何需要读 referent 的代码直接用这个偏移量：

```cpp
oop referent = oop_desc->obj_field(referent_offset);  // *(oop*)((char*)obj + 12)
```

不需要 InstanceKlass，不需要 fields 数组，不需要名字查找。只需要一个整数。

### 3.3 三种模式的完整对比

| JVM 模式 | heapOopSize | base_offset | referent_offset | queue_offset |
|----------|-------------|-------------|-----------------|--------------|
| 32 位 | 4 | 8 | 8 | 12 |
| 64 位 + compressed（默认） | 4 | 12 | 12 | 16 |
| 64 位非压缩 | 8 | 16 | 16 | 24 |

同一个 `hc_referent_offset = 0`，在三种模式下算出三个不同的字节值——但 `member_offset` 的公式是通用的。

### 3.4 compute_hard_coded_offsets —— 6 个偏移量

```cpp
void JavaClasses::compute_hard_coded_offsets() {
  java_lang_boxing_object::value_offset      = member_offset(hc_value_offset);
  java_lang_boxing_object::long_value_offset = align_up(
    member_offset(hc_value_offset), BytesPerLong);

  java_lang_ref_Reference::referent_offset    = member_offset(hc_referent_offset);
  java_lang_ref_Reference::queue_offset       = member_offset(hc_queue_offset);
  java_lang_ref_Reference::next_offset        = member_offset(hc_next_offset);
  java_lang_ref_Reference::discovered_offset  = member_offset(hc_discovered_offset);
}
```

`long_value_offset` 用 `align_up(x, 8)` 向上取整到 8 字节边界。`Long` 和 `Double` 的 `value` 是 8 字节 long——64 位 compressed oops 模式下，`value_offset = 0*4+12 = 12`，12 不是 8 的倍数 → `long_value_offset = align_up(12, 8) = 16`。不 align_up，CPU 在非对齐地址读 8 字节会慢 2-3 倍。

---

## 4. InjectedField —— 用一个额外的指针连接 Class oop 和 InstanceKlass

### 4.1 类加载时有两个东西

JVM 加载 `java.lang.String` 时会创建两个独立的对象：

- **InstanceKlass**(C++ 对象，在 Metaspace): String 的方法表、字段表、常量池——Java 不可见
- **java.lang.Class oop**(Java 对象，在堆上): `String.class` 就是它——你在 Java 里拿到的那个

调用 `String.class.getDeclaredMethods()` 时，JVM 必须从 Class oop 定位到 InstanceKlass 才能读到方法表。

### 4.2 对象头里的 _klass 不够

对象头 `oopDesc::_metadata._klass` 存的是"这个 oop 自己的类型"。`String.class` 的类型是 `java.lang.Class`，所以它的 `_klass` 指向 `InstanceKlass(java.lang.Class)`。

我们需要的是 `InstanceKlass(java.lang.String)`——String 这个类的元数据。对象头只能存一个指针，存了"自己是什么类型"就存不了"代表哪个类"。

### 4.3 解决方案：注入一个指针

在 `java.lang.Class` 的对象体内多放一个 `intptr_t`——用这个位置存 `InstanceKlass*`。

`intptr_t` 而不是 `oop` 的原因：`InstanceKlass*` 在 Metaspace（不在 Java 堆），GC 不应该扫描它。如果写 `oop`，GC 把它当 Java 引用处理——发现地址不在堆范围——类型混乱。

### 4.4 不止一个——Class 对象需要存更多东西

除了 `InstanceKlass*`，`java.lang.Class` 对象里还注入了：

- `array_klass`：对应数组类型（`String[]` 的 `ArrayKlass`）
- `init_lock`：类初始化锁（多线程加载同一个类时需要）
- `oop_size`：这个类的实例占几个 word
- `protection_domain`、`signers`：安全相关
- `source_file`：调试用——源文件名

这些字段的共同点：都是 JVM 内部需要的数据，但 Java 反射不需要看到（你不能 `Field.getDeclaredFields()` 拿到 `klass` 指针）。所以 JVM 标记为 `JVM_ACC_FIELD_INTERNAL`——`Field.getDeclaredFields()` 遍历时跳过它们。

---

## 5. 运行时验证：check_offsets

`#ifndef PRODUCT` 模式下，SystemDictionary 初始化后跑一次验证——用 InstanceKlass 的字段表算偏移量和硬编码值比对：

```cpp
void java_lang_ref_Reference::check_offsets() {
  InstanceKlass* k = SystemDictionary::Reference_klass();
  check_offset(referent_offset,   k, "referent",   "Ljava/lang/Object;");
  check_offset(queue_offset,      k, "queue",      "Ljava/lang/ref/ReferenceQueue;");
  check_offset(next_offset,       k, "next",       "Ljava/lang/ref/Reference;");
  check_offset(discovered_offset, k, "discovered", "Ljava/lang/ref/Reference;");
}
```

如果 JDK 版本升级、Reference 加了新字段、字段顺序变了——这个 assert 会炸，提醒你 `hc_referent_offset = 0` 不再正确。

---

## 6. 概念链

```
C++ 访问 Java 字段需要偏移量
  → 正常获取: SystemDictionary → InstanceKlass → fields 数组 → offset
  → 但 universe_init:685 时 SystemDictionary 是空的
  → Reference/Boxing 的字段顺序固定 → 编译期枚举 hc_referent_offset = 0
  → member_offset(enum) = 序号 * heapOopSize + 对象头大小 = 字节偏移
  → 现在就能算——零代价，后面任何代码都能用，不管 SystemDictionary 状态
  → 其他类没有固定顺序 → 必须等 SystemDictionary → compute_offsets
  → InjectedField: Klass* 不是 Java 字段 → JVM 注入 intptr_t → 反射看不见
```

---

## 7. 总结

| 概念 | 一句话 |
|------|--------|
| oop | `oopDesc*` —— Java 对象在 C++ 中的替身类 |
| Klass | Java 类的 C++ 元数据——存字段表、方法表 |
| SystemDictionary | 全局哈希表——类名到 InstanceKlass。universe_init:685 时为空 |
| 字段偏移量 | 字段在对象体内相对于对象头的字节偏移 |
| hc_ 前缀 | hard-coded——字段序号（0,1,2,3），不是字节偏移 |
| member_offset | 序号 * heapOopSize + base_offset_in_bytes = 字节偏移 |
| InjectedField | JVM 注入 Java 对象体内的额外字段——反射看不见、GC 不追踪 |
