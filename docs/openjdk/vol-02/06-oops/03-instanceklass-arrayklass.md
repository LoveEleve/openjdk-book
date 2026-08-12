# 03. InstanceKlass 与数组 — 元数据仓库与 GC 的两副面孔

> **前置依赖**:[01 — 对象头](01-markoop-oopdesc.md):对象头 union 的"多余"4 字节在这里派上用场;[02 — Klass](02-klass-hierarchy.md):InstanceKlass/ArrayKlass 家族挂在 Klass 层次树上
> → **后续**:[04 — 常量池与解析](04-constantpool-method.md)
> 关联域: 25-gc(数组遍历/引用处理)、09-memory-core(数组分配)

## 从类的仓库到数组的两副面孔

`new int[10]` 和 `new String[10]` 在 Java 层面都是"数组",JVM 内部却是**两种不同的 Klass**——`int[]` 是 TypeArrayKlass,`String[]` 是 ObjArrayKlass。差别不在语法,在元素: `int` 是裸值,GC 看一眼就可以走;`String` 是引用,GC 必须逐个检查、逐个搬移。这篇先把 02 篇留下的 InstanceKlass 仓库补齐(字段表、方法表、引用对象的特殊 Klass),再拆开数组的两半: 头部怎么省出一个长度字段、维度链怎么串起来、以及 GC 为什么对两种数组态度完全不同。

## 1. 头部: 长度字段塞进"多余"的 4 字节

上一篇(01)说过: 压缩模式下对象头的类指针只用 4 字节,union 的高 4 字节对普通对象是纯填充。**数组把这个"浪费"利用了**——`_length` 根本不是一个 C++ 字段,它被塞进那个 4 字节里:

```cpp
// arrayOop.hpp:73-79(注释+函数,逐字)
  // The _length field is not declared in C++.  It is allocated after the
  // declared nonstatic fields in arrayOopDesc if not compressed, otherwise
  // it occupies the second half of the _klass field in oopDesc.
  static int length_offset_in_bytes() {
    return UseCompressedClassPointers ? klass_gap_offset_in_bytes() :
                               sizeof(arrayOopDesc);
  }
```

- 压缩模式(`UseCompressedClassPointers`): length 在 offset 12——就是 union 的高 4 字节,和压缩类指针合用一个 word;
- 非压缩模式: length 排在 `sizeof(arrayOopDesc)`(16 字节)之后。

读长度就是一次带偏移的整型读(arrayOop.hpp:108-110,逐字):

```cpp
// arrayOop.hpp:108-110(逐字)
  int length() const {
    return *(int*)(((intptr_t)this) + length_offset_in_bytes());
  }
```

所以压缩模式下数组头是 **16 字节**: mark(8)+ 压缩类指针(4)+ length(4)。`arraylength` 字节码的实现也印证——null 检查后直接读这个偏移(templateTable_x86.cpp:4164-4168,逐字):

```cpp
// templateTable_x86.cpp:4164-4168(逐字)
void TemplateTable::arraylength() {
  transition(atos, itos);
  __ null_check(rax, arrayOopDesc::length_offset_in_bytes());
  __ movl(rax, Address(rax, arrayOopDesc::length_offset_in_bytes()));
}
```

**关键设计 (斜体)**: *普通对象把 union 高 4 字节当填充,数组把它当长度字段——同一个 word,两种用途,谁也不多占。代价是 length 的偏移依赖压缩开关,所有读长度的代码都得走 `length_offset_in_bytes()` 而不是写死;换来的是每个数组对象省 4 字节。*

- [C++: header 大小是算出来的: `header_size_in_bytes()` 把 length 偏移 + 4 对齐到堆粒度(arrayOop.hpp:53-63);`long[]`/`double[]` 的 header 还要再对齐到 8 字节,保证元素天然 8 对齐(`header_size` 按元素类型决定,:122-127;`element_type_should_be_aligned` 在 :68-70)]

## 2. 数组的 Klass: 一张维度链

### 2.1 三个字段串起所有维度

数组 Klass 的家族关系不是树,是**维度链**(arrayKlass.hpp:41-43,逐字):

```cpp
// arrayKlass.hpp:41-43(逐字)
  int      _dimension;         // This is n'th-dimensional array.
  Klass* volatile _higher_dimension;  // Refers the (n+1)'th-dimensional array (if present).
  Klass* volatile _lower_dimension;   // Refers the (n-1)'th-dimensional array (if present).
```

`int[]` 的 Klass 指向 `int[][]` 的 Klass(higher),后者指向 `int[][][]`…… `int[][]` 再指回 `int[]`(lower)。基本类型数组的**最低维**是全局单例: `Universe::intArrayKlassObj()`(universe.hpp:276),启动时由 `TypeArrayKlass::create_klass` 逐个创建(universe.cpp:334-337)。`int[]` 的 Klass 全 JVM 只有一份,所有 `int[]` 实例共享。

高维数组 Klass 在需要时**沿链原子创建**: `array_klass_impl`(objArrayKlass.cpp:331-370)先 acquire 无锁读 higher_dimension,空则拿 `MultiArray_lock` 锁再查一遍,仍空才创建并 `release_set_higher_dimension` 挂链(注释 "Ensure atomic creation of higher dimensions",:345)——`int[][][]` 的 Klass 建立时,`int[][]` 和 `int[]` 的链早已就位(或当场补齐)。

- [C++: 数组类型是 Object、Cloneable、Serializable 的子类型——数组 Klass 的 secondary 接口表直接指向全局共享的 `the_array_interfaces_array()`(arrayKlass.cpp:122),`int[] instanceof Serializable` 的快速子类型检查在这里命中]

### 2.2 数组 Klass 也是完整 Klass

数组 Klass 创建时走 `complete_create_array_klass`(arrayKlass.cpp:102-112): 初始化父类链、初始化 vtable(数组不引入新方法,02 篇说过 vtable 长度 = 父类)、再创建自己的 `java.lang.Class` 镜像。所以 `int[].class` 是合法的——数组也有 mirror。

## 3. InstanceKlass 的仓库: 字段表与方法表

02 篇介绍了 InstanceKlass 的指针字段;这里看它装的两张核心表。

### 3.1 字段表: 每个字段 12 字节

`_fields` 不是结构体数组,是 `Array<u2>`——每 6 个 u2 描述一个字段(FieldInfo,fieldInfo.hpp:38-90):

- 槽 0-3: access_flags、name_index、signature_index、initval_index(后三个是常量池下标);
- 槽 4-5: 打包的偏移与类型——低 2 位是 tag: `01` 纯字段偏移、`10` 带类型的字段、`11` 带类型和争用组(fieldInfo.hpp:55-62)。

- [C++: 为什么用平铺的 u2 数组而不是 struct?ClassFile 的字段表就是这种紧凑布局,内存连续、按序遍历方便;FieldInfo 只是这个数组的"视窗",提供各槽位的访问器]

### 3.2 方法表: 声明顺序即数组顺序

`_methods` 是 `Array<Method*>`,按 class 文件顺序排列——`<init>`/`<clinit>` 也在其中(它们不进 vtable,02 篇说过)。每个 Method 对象装着字节码、异常表、行号表与调用计数;vtable index 在类链接时写进 Method(02 篇的归位)。方法与常量池的关系,下一篇(04)展开。

## 4. InstanceRefKlass: 引用对象的特殊 Klass

`SoftReference`/`WeakReference`/`PhantomReference` 的实例是普通对象,但它们的 Klass 是 InstanceRefKlass——因为 **referent 字段必须由 GC 特殊处理**: 对象是否还"活着"取决于 referent 指向谁,以及它该不该进 ReferenceQueue。`update_nonstatic_oop_maps`(instanceRefKlass.cpp:31-70)把 referent 和 discovered 从普通 oop-map 里剔掉(注释 "They are treated specially by the garbage collector",:33-35)——普通字段遍历时不再碰它们,发现/入队逻辑由 GC 按引用语义单独驱动。细节在 25-gc 域。

**关键设计 (斜体)**: *引用类必须独占一个 Klass 子类,因为"普通对象遍历"的规则对它们失效——referent 不是普通引用,它决定引用队列的入队;把特殊语义放进 Klass 类型里,GC 按类型分发,不用给每个引用对象打标记。*

## 5. ObjArrayKlass: 元素是引用,GC 逐个过问

对象数组的 Klass 多一个字段: `_element_klass`(objArrayKlass.hpp:44)——元素类型。布局是 `[16B 头][元素 × n]`,压缩模式下每个元素 4 字节(narrowOop)。

读写元素不是裸指针运算,而是走 Access API(objArrayOop.inline.hpp:47-57,截取核心,逐字):

```cpp
// objArrayOop.inline.hpp:47-57(截取核心,逐字)
inline oop objArrayOopDesc::obj_at(int index) const {
  assert(is_within_bounds(index), "index %d out of bounds %d", index, length());
  ptrdiff_t offset = UseCompressedOops ? obj_at_offset<narrowOop>(index) : obj_at_offset<oop>(index);
  return HeapAccess<IS_ARRAY>::oop_load_at(as_oop(), offset);
}

inline void objArrayOopDesc::obj_at_put(int index, oop value) {
  assert(is_within_bounds(index), "index %d out of bounds %d", index, length());
  ptrdiff_t offset = UseCompressedOops ? obj_at_offset<narrowOop>(index) : obj_at_offset<oop>(index);
  HeapAccess<IS_ARRAY>::oop_store_at(as_oop(), offset, value);
}
```

**`obj_at_put` 写引用会经过 GC barrier**——这是关键: 数组里的引用和其他字段引用一样,写之前要通知 GC(比如 G1 记录跨 region 引用)。`obj_at` 读引用同理,`HeapAccess` 层把 barrier 插入,调用方不感知。

GC 遍历对象数组时,每个元素都必须过一遍闭包(objArrayKlass.inline.hpp:39-46,逐字):

```cpp
// objArrayKlass.inline.hpp:38-46(逐字)
template <typename T, class OopClosureType>
void ObjArrayKlass::oop_oop_iterate_elements(objArrayOop a, OopClosureType* closure) {
  T* p         = (T*)a->base_raw();
  T* const end = p + a->length();

  for (;p < end; p++) {
    Devirtualizer::do_oop(closure, p);
  }
}
```

从首元素到末元素,逐个交给闭包——标记、搬移、更新指针,全部发生在这里。

## 6. TypeArrayKlass: 元素是裸值,GC 直接路过

基本类型数组的遍历实现是**空函数**(typeArrayKlass.inline.hpp:36-40,逐字):

```cpp
// typeArrayKlass.inline.hpp:36-40(逐字)
inline void TypeArrayKlass::oop_oop_iterate_impl(oop obj, OopIterateClosure* closure) {
  assert(obj->is_typeArray(),"must be a type array");
  // Performance tweak: We skip processing the klass pointer since all
  // TypeArrayKlasses are guaranteed processed via the null class loader.
}
```

注释和头文件都点明了原因(typeArrayKlass.hpp:89-90): "Since there are no oops in TypeArrayKlasses, these functions only return the size of the object"——**基本类型数组里不可能有引用**,GC 的遍历闭包直接空转,元素区一个引用都不需要处理。这是"元素是引用还是裸值"在 GC 路径上的直接分岔。

读写则是对应类型的裸访问: `byte_at` 读 1 字节(typeArrayOop.inline.hpp:92)、`int_at` 读 4 字节(:125)、`long_at` 读 8 字节(:158)——底层 `HeapAccess<IS_ARRAY>::load_at`(以 int_at 为例,typeArrayOop.inline.hpp:125-129),无引用所以无 oop barrier。元素偏移按类型定: `element_offset = base_offset_in_bytes + sizeof(T) * index`(typeArrayOop.hpp:65-69)。

**关键设计 (斜体)**: *同一个"数组"概念,GC 的成本差了一个量级——对象数组 O(n) 逐个处理元素,基本类型数组 O(1) 只看头。把"不可能含引用"编码进 Klass 类型里,GC 遍历时一次类型判断就免掉整个数组的扫描;Java 层无感知,性能差全在布局与遍历的纪律里。*

## 7. 边界检查: 每个访问都在栅栏内

数组访问(aaload/iaload/astore/istore)与 `arraylength` 不同,都要先做**边界检查**——index 在 [0, length) 内才放行,越界抛 `ArrayIndexOutOfBoundsException`。解释器模板里 `index_check` 与访问同处(templateTable_x86.cpp:769 起);JIT 编译后边界检查仍在,但 C2 的 Range Check Elimination 会在能证明 index 必然在界内时消除检查,循环里不变的检查被提升到循环外只做一次。这条"永远存在"的栅栏,是数组与普通字段访问最根本的行为差异。

## 核心悬念

数组的两副面孔到此分明: 长度字段塞进 union 的"多余"4 字节、维度链沿 higher_dimension 原子延伸、对象数组逐元素过 GC、基本类型数组的遍历是空函数——加上 InstanceKlass 的字段表(每字段 12 字节)与方法表、引用对象的特殊 Klass,对象模型的两大支柱(类与数组)都过了一遍。但数组访问的字节码里藏着下一个问题——`new String[10]` 编译后字节码是 `anewarray #5`,这个 `#5` 是**常量池符号引用**,运行时怎么变成真实的 ObjArrayKlass?下一篇: 常量池与解析——字节码里的编号怎么变成直接指针。

> → [04-constantpool-method.md](04-constantpool-method.md)
