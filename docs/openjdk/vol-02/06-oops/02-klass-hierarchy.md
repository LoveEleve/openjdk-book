# 02. Klass — 对象到类的桥

> **前置依赖**:[01 — 对象头](01-markoop-oopdesc.md):对象头的第二个 word 指向的就是本篇的 Klass
> → **后续**:[03 — InstanceKlass 与数组](03-instanceklass-arrayklass.md)
> 关联域: 23-stub(vtableStubs)、15-c2(虚方法解析)、17-threads(初始化线程协作)

## obj.getClass() 的两步

`String s = ...; s.getClass()` 不查表、不遍历——`s` 的 oop 第二 word 直接指向一个 `Klass*`,再从 Klass 找到 `java.lang.Class` 镜像对象。整条路就是两次解引用。上一篇讲了对象头的 mark word 和第二 word(压缩类指针);这篇走完第二 word 的旅程: Klass 是什么、它的 C++ 家族有哪些成员、虚方法和接口方法怎么通过它分发、普通类的元数据装在哪。

## 1. Klass: 类元数据的基座

`Klass` 继承自 `Metadata`(metadata.hpp:33,而 Metadata 继承 MetaspaceObj)——**Klass 对象本身不在 Java 堆里,在 Metaspace**。它承载一个 Java 类型的所有元数据: 类名、父类、接口、方法表、字段表、常量池指针、镜像对象指针。

从 oop 到类名只需两步: `obj->klass()`(解引用第二 word)再 `klass->external_name()`(klass.cpp:621)——instance 类返回形如 "java/lang/String" 的符号名,匿名类附加地址后缀。`instanceof`/强制转换用的快速子类型检查、GC 遍历对象用的布局信息,也全在 Klass 上。

## 2. 七个具体子类,不是"二十种"

网上讲 HotSpot 对象模型常写"约 20 种 Klass 子类"——jdk11u 里数一数,Klass 子类只有七个(ArrayKlass 是抽象类):

```
Metadata (MetaspaceObj)
 └─ Klass
     ├─ InstanceKlass             普通类/接口
     │   ├─ InstanceMirrorKlass   java.lang.Class 对象(镜像)
     │   ├─ InstanceRefKlass      软/弱/虚引用对象
     │   └─ InstanceClassLoaderKlass  ClassLoader 对象
     └─ ArrayKlass(抽象)
         ├─ ObjArrayKlass         对象数组 String[]/Object[]
         └─ TypeArrayKlass        基本类型数组 int[]/byte[]
```

一个 Java 类对应一个 Klass 实例(接口也是 InstanceKlass);每种**特殊行为**配一个子类——引用对象的 GC 特殊处理、镜像对象的静态字段存储,都是"换子类就换行为"。

类型判断靠一个字段: `_layout_helper`(klass.hpp:115,注释在 :89-114)——instance 类是**正数**(对象大小,低 1 位标记"不能走快速分配路径"),数组是**负数**(四个字节打包: 数组 tag/头部大小/元素类型/元素大小对数),其余是 0。`is_instance_klass()`(klass.hpp:589-591)就是一次比较(klass.hpp:372):

```cpp
// klass.hpp:370-376(截取核心,逐字)
  static bool layout_helper_is_instance(jint lh) {
    return (jint)lh > (jint)_lh_neutral_value;
  }
  static bool layout_helper_is_array(jint lh) {
    return (jint)lh < (jint)_lh_neutral_value;
  }
```

- [C++: 类型判断用手写位测试而不是 `dynamic_cast`——JVM 编译时用 `-fno-rtti -fno-exceptions` 关掉 RTTI(flags-cflags.m4:529),省掉 type_info 和虚表开销;Klass 的"是什么类型"答案编码在 layout helper 里,一次比较同时得到"类型+布局"两个信息]
- [C++: 还有一个独立机制 `KlassID` 枚举(klass.hpp:41-47): InstanceKlass=0、InstanceRef=1、InstanceMirror=2、InstanceClassLoader=3、TypeArray=4、ObjArray=5——它的注释写明用途是 "devirtualized oop closure dispatching"(klass.hpp:117): GC 遍历 oop 的闭包按 ID 分发,避免一串虚函数调用]

## 3. 关键字段: 名字、父类、镜像

Klass 的常用字段(klass.hpp:128-166):

- `_name`: `Symbol*`——类名,instance 类是 "java/lang/String",数组是 "[I"、"[Ljava/lang/String;";
- `_super` / `_subklass` / `_next_sibling`: 运行时类层次链表——子类挂在父类的 `_subklass`,`next_sibling` 串兄弟;
- `_primary_supers[8]` / `_secondary_supers` / `_secondary_super_cache` + `_super_check_offset`: 快速子类型检查的数据(klass.hpp:120-126)。`instanceof` 先查 primary 表(直接祖先,最多 8 个),miss 再查 secondary 缓存——常见情况一到两次比较就出结果;
- `_java_mirror`: `OopHandle`,指向 `java.lang.Class` 实例——`getClass()` 的最后一步;
- `_prototype_header`: 类级 mark word 原型(含偏向锁 pattern)——上一篇说过,对象初始化时 mark 从它复制(oop.inline.hpp:82-84 `init_mark`)。

**关键设计 (斜体)**: *一个 Java 类型在 JVM 里就一份 Klass,所有实例共享;对象头里只放一个(压缩的)指针。类级信息(方法表、字段表)不随实例复制,实例只付 4~8 字节的指针成本——"万类"的元数据总量被压在 Metaspace 里一份。*

## 4. vtable: 虚方法表,内嵌在 Klass 里

### 4.1 表在哪: Klass 头部之后

子类的方法表不是独立的堆对象,是 **Klass 对象自身内存的延伸**:

```cpp
// klass.cpp:781-783(逐字)
ByteSize Klass::vtable_start_offset() {
  return in_ByteSize(InstanceKlass::header_size() * wordSize);
}
```

vtable 从 InstanceKlass 固定头部之后开始,一个 entry 一个 word(方法指针)。取第 i 个虚方法 = `[klass + vtable_start + i*8]`——一次内存读。

### 4.2 表怎么建: 父类长度打底,逐方法归位

vtable 构建分三步(klassVtable.cpp):

- `compute_vtable_size_and_num_mirandas`(:56-120): 长度从父类继承(`super->vtable_length()`,:68),逐个方法问 `needs_new_vtable_entry`(:85,需要新 entry 就加一),最后补 miranda 方法(接口抽象方法落入实现类的 vtable,`get_mirandas` 调用在 :93-94);
- `initialize_from_super`(:138-155): **先把父表整体复制到子表**(`superVtable.copy_vtable_to(table())`,:151)——子表是父表的物理副本;
- `initialize_vtable`(:167 起): 遍历本类方法,`update_inherited_vtable`(:368)决定归位方式——**override 父类方法的,在复制来的槽位上覆写为子类方法(不新增槽)**;父类没有的,追加到末尾。注释原文 "if override, replace in copy of super vtable, otherwise append to end"(:205-206)。private/static/`<init>` 不进 vtable(:397-400);final 方法**从不新增 entry**——它要么静态解析,要么覆写被 override 的父类槽位(:402-406)。数组类不引入新槽位(:203-204)。

**关键设计 (斜体)**: *先复制再覆写,比"每个槽位逐个从父表找"更简单——子表建好后就是一份完整自洽的表,方法地址全部就位;override 只需覆盖对应槽位,继承的方法天然就是父表里那些地址,不需要再查父表。*

### 4.3 invokevirtual: 三条指令

解释器执行 `invokevirtual` 的真实路径(templateTable_x86.cpp:3699 `invokevirtual_helper`): 检查常量池缓存——final 方法直接取 `Method*`(无查找);否则加载 receiver 的 Klass,再按 vtable index 取方法:

```cpp
// macroAssembler_x86.cpp:4640-4652(截取核心,逐字)
void MacroAssembler::lookup_virtual_method(Register recv_klass,
                                           RegisterOrConstant vtable_index,
                                           Register method_result) {
  const int base = in_bytes(Klass::vtable_start_offset());
  assert(vtableEntry::size() * wordSize == wordSize, "else adjust the scaling in the code below");
  Address vtable_entry_addr(recv_klass,
                            vtable_index, Address::times_ptr,
                            base + vtableEntry::method_offset_in_bytes());
  movptr(method_result, vtable_entry_addr);
}
```

加上前面的 `load_klass`(读第二 word,压缩模式要解码)和最后的 `jump_from_interpreted`,一次虚调用是: 解引用 oop 取 Klass → 按 index 取方法 → 跳转。**没有链式查找**——index 在链接时(常量池缓存解析)固定。

- [C++: 前提是 vtable entry 每项正好一个 word(`assert(vtableEntry::size() * wordSize == wordSize)`),所以 index 直接乘 8 做寻址]
- [x86: C2 编译代码的虚调用走 vtableStub(每个调用点一个专用小 stub),寻址逻辑与这里相同]

## 5. itable: 接口方法表,多一道扫描

### 5.1 为什么接口方法没有固定 index

虚方法表按"类继承"编号,index 在链接时确定。接口不同: 一个类实现多个接口,每个接口一套方法——**给每个接口方法排固定 vtable index 会撑爆表**,所以接口方法另起 itable: 一个 offset 表(接口 → 方法区偏移)+ 每个接口的方法 entry 块(klassVtable.hpp:236-253):

```cpp
// klassVtable.hpp:236-242(截取核心,逐字)
class itableOffsetEntry {
 private:
  Klass* _interface;
  int      _offset;
 public:
```

构建在 `klassItable::initialize_itable`(klassVtable.cpp:1093-1130): 接口先分到 itable index(`assign_itable_indices_for_interface` 调用在 :1097),然后逐接口填 offset 表与方法块,末尾留终止符(:1125-1127,注释在 :1106 "There's alway an extra itable entry so we can null-terminate it")。

### 5.2 invokeinterface: 特判之后扫描

解释器的 `invokeinterface`(templateTable_x86.cpp:3791)先处理两个特例——调的是 `Object` 的方法(比如 `list.equals(...)` 走了 invokeinterface)走虚方法路径;接口的 private 方法直接调——然后才是常规路径: 加载 receiver Klass → 子类型检查(确认实现该接口)→ `lookup_interface_method` 在 offset 表里扫到目标接口、再按接口内的方法 index 取 entry。

**关键设计 (斜体)**: *vtable 用"位置"换时间(链接期定死 index,运行时一次寻址),itable 用"扫描"换空间(接口方法不占固定槽,调用时多一趟 offset 查找)。虚调用是热路径,必须最快;接口调用要容忍一次小扫描——这是"给最频繁的调用让路"的取舍。*

## 6. InstanceKlass: 普通类的元数据仓库

普通类的 Klass 是 `InstanceKlass`(instanceKlass.hpp:154-303 的字段区):

- `_methods`: `Array<Method*>`(:277)——本类声明的所有方法(继承的方法在父类自己的表里,vtable 归位时跨父类查找);
- `_fields`: `Array<u2>`(:303)——字段描述(FIELDINFO 编码: 名字/类型/偏移),由 **ClassFileParser** 填充——`parse_fields` 在 classFileParser.cpp:1541,不在 InstanceKlass 里;
- `_constants`: `ConstantPool*`(:154)——类的符号引用仓库,链接时把符号引用解析成直接引用;
- `_init_state`(:266)+ `_init_thread`(:246): 类初始化状态机。

`_init_state` 是六态,不是五态(instanceKlass.hpp:131-138,截取核心,逐字):

```cpp
// instanceKlass.hpp:131-138(截取核心,逐字)
  enum ClassState {
    allocated,                          // allocated (but not yet linked)
    loaded,                             // loaded and inserted in class hierarchy (but not linked yet)
    linked,                             // successfully linked/verified (but not initialized yet)
    being_initialized,                  // currently running class initializer
    fully_initialized,                  // initialized (successfull final state)
    initialization_error                // error happened during initialization
  };
```

`<clinit>` 同步在 `initialize_impl`(instanceKlass.cpp:891): 持 init_lock(ObjectLocker),发现别的线程正在初始化(`is_being_initialized`)且不是自己(`is_reentrant_initialization(self)`,比较 `_init_thread`)就 `waitUninterruptibly` 等锁(:905-955)——**递归初始化**(自己初始化过程中又触发自己的类)直接放行,不递归执行 `<clinit>`。

## 7. InstanceMirrorKlass: Class 对象的 Klass

`String.class` 返回的 `java.lang.Class` 实例,它的 Klass 是 `InstanceMirrorKlass`。特殊之处: **类的静态字段存在 mirror 对象里**,不在任何实例里。mirror 对象布局 = 普通 Class 实例部分 + 静态字段区,静态字段的起始偏移是 `Class_klass()->size_helper() << LogHeapWordSize`(instanceMirrorKlass.hpp:76-83)——即"紧跟 Class 自身字段之后"。

**关键设计 (斜体)**: *静态字段只有一个副本、按类可见——放在 Class 对象末尾,`ClassName.field` 访问就变成"读 mirror 对象偏移处",JIT 还能把静态字段当成稳定的内存位置;实例字段才进实例。一类数据一个家,不多不少。*

## 核心悬念

从 oop 的第二个 word 出发,现在能看到: Klass 家族七个具体子类(布局助手一次比较定类型)、内嵌 vtable(链接期定 index,运行时一次寻址)、itable(接口方法扫描表)、InstanceKlass 的六态初始化、mirror 上的静态字段。但 InstanceKlass 的细节才刚开头——字段表怎么编码、方法表怎么组织、引用类型(InstanceRefKlass)在 GC 里怎么特殊处理、数组的 Klass 和对象数组/基本类型数组的区别——下一篇: InstanceKlass 与数组。

> → [03-instanceklass-arrayklass.md](03-instanceklass-arrayklass.md)
