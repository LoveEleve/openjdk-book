# 02. Klass 层次 — oop 找到自己是什么类的唯一路径

> 🔴 Deep | 15 KP 中的 2 个核心机制
> 读者处境: `obj.getClass()` — 它怎么返回 `java.lang.Class`？不是查表——是跟着 oop→Klass* 指针走。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/06-oops/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **KlassLayoutHelper 不存在**(jdk11u): 是 `_layout_helper` 字段(klass.hpp:115,注释 :89-114)——instance 类=正数(对象大小,低 1 位=不能走快速分配),数组=负数(四字节: tag/hsz/ebt/log2(esz)),其余=0;**类型判断方向反了**: `is_instance_klass` = layout_helper_is_instance = `lh > 0`(klass.hpp:372,不是 < 0)
> - **KlassID 枚举在 :41-47 不是 :65,顺序错**: InstanceKlass=0、InstanceRef=1、InstanceMirror=2、InstanceClassLoader=3、TypeArray=4、ObjArray=5(大纲"Mirror=1/Ref=2"错);用途=devirtualized oop closure dispatching(klass.hpp:117)
> - **"~20 种 Klass 子类"错**: jdk11u 只有 7 个子类(ArrayKlass 抽象): InstanceKlass/Mirror/Ref/ClassLoader + ArrayKlass→ObjArray/TypeArray
> - **invokevirtual 汇编序列编造**: 真实=load_klass(解码压缩)+ lookup_virtual_method 一条 movptr(macroAssembler_x86.cpp:4640-4652);vtable 内嵌在 Klass 里(vtable_start_offset = InstanceKlass::header_size()*wordSize,klass.cpp:781-783);解释器路径 templateTable_x86.cpp:3699
> - **vtable 构建行号漂移**: compute_vtable_size_and_num_mirandas :56-120(get_mirandas :93-94);initialize_vtable :167;update_inherited_vtable :368(private/static/<init> 不占 :397-400;final 不新增 entry :402-406)
> - **itable**: klassItable(klassVtable.hpp:233+);itableOffsetEntry{Klass* _interface; int _offset}(:236-242,无注释!);initialize_itable :1093-1130(接口先分 index,调用 :1097;终止符 :1125-1127,注释 :1106);invokeinterface :3791(Object 方法 forced-virtual 特判 + private vfinal 特判 + subtype check + lookup_interface_method)
> - **parse_fields 不在 instanceKlass.cpp**: 在 classFileParser.cpp:1541(ClassFileParser 的职责)
> - **_init_state 是 6 态不是 5 态**(instanceKlass.hpp:131-138): 多 initialization_error;初始化同步=init_lock + is_reentrant_initialization(_init_thread==self)+ waitUninterruptibly(instanceKlass.cpp:905-955)
> - **external_name 在 klass.cpp:621**(非 :40-80);InstanceMirrorKlass 静态字段偏移=Class_klass()->size_helper()<<LogHeapWordSize(instanceMirrorKlass.hpp:76-83)✓
> - -fno-rtti 确认: make/autoconf/flags-cflags.m4:529(TOOLCHAIN_CFLAGS_JVM)

### 1. Klass — 所有 Java 类的 C++ 模板

场景: `String s = "hello"; s.getClass();` — JVM 怎么知道 s 是 String？— `s->klass()->external_name()` → "java/lang/String"。从 oop 到 Klass 到类名——只有两次 deref。

**Klass 结构** (`klass.hpp:120-400`):
- `KlassLayoutHelper`: super class check——子类 Klass 的第一部分是父类 Klass 字段——C++ 用**单继承模拟**多级类
- [C++: HotSpot 内部 ~20 种 Klass 子类——不是 1:1 Java class 映射。每种 Java 类型 (普通类/接口/数组/基本类型) 对应不同 Klass 子类。`obj->klass()` 返回具体子类指针——存储时是基类 Klass*——但运行时实际是子类 instanceKlass*——C++ 虚函数 dispatch 区分]
- [C++: `Klass::is_instance_klass()`——用 `KlassID` 枚举比较——不是 `dynamic_cast`——`dynamic_cast` 需要 RTTI (type_info)——JVM 编译时 `-fno-rtti` 禁用 RTTI——节省二进制大小 + 虚表开销]
- `_layout_helper`: 对象布局描述——普通对象 = instance size/field count——数组 = 元素类型和大小——GC 遍历时用
- `_super_check_offset`: super class 快速检查——不是遍历继承链——是 offset 跳转——子类 Offset=父类 Klass* 在子类 Klass 内部的偏移

**vtable 虚方法表** (`klassVtable.hpp:45-200` + `klassVtable.cpp:30-300`):
- `klassVtable`: 该类的**所有虚方法地址**的数组——vtable[method_index] = 方法入口地址
- 源码链: `klassVtable.cpp:40` 构造 vtable——从父类复制→override 非 final 方法→新增新方法
- [C++: vtable 复制——子类继承父类的**完整** vtable——只**替换**被 override 的方法 entry——其他保持不变。父类有 3 个虚方法→子类 vtable size=父类 size+新增方法数。`final` 方法不需要 vtable entry (静态分派)]
- [x86: invokevirtual 汇编路径——`mov rax, [obj]` (取 oop)→`mov rax, [rax+8]` (取 Klass*, offset=8=sizeof(markOop))→`mov rax, [rax+vtable_offset]` (取 vtable 指针)→`mov rax, [rax+method_index*8]` (取方法地址)→`call rax`。4 次 deref + 1 次 call——但 CPU BTB (Branch Target Buffer) 缓存此路径——延迟 ~1 cycle]

**itable 接口方法表** (`klassVtable.hpp:130-250`):
- itable: 该类的接口方法表——每个被实现的 interface 有独立 entry array
- [x86: invokeinterface——`mov rax, [obj]`→`mov rax, [rax+8]`→取 itable offset→扫描 itable 找到正确的 interface→取 itable entry→取方法地址→call。比 invokevirtual 多一步扫描——因为 interface 方法**没有固定 vtable index**——同一个类实现多个 interface——每个有独立方法表]
- [C++: `Klass::itable_method_at(klass, index)`——klass 参数用来区分**哪个**子类的 itable。同一个 interface 方法在不同子类中 index 可能不同——itable 扫描确认]

### 2. Klass 层次 — ~20 种子类

**Klass 层次** (`klass.hpp:60-100`):
- Klass (抽象基类) → InstanceKlass (普通类/Mirror/Reference/ClassLoader) + ArrayKlass (ObjArray/TypeArray)
- KlassID 枚举: `klass.hpp:65` `InstanceKlassID=0, InstanceMirrorKlassID=1, InstanceRefKlassID=2, InstanceClassLoaderKlassID=3, ObjArrayKlassID=4, TypeArrayKlassID=5, ...`
- [C++: `Klass::oop_is_instance()` → `return layout_helper() < Klass::_lh_neutral_value`——不是比较 KlassID——比较 `_layout_helper`。layout_helper 编码了对象布局+Klass类型——一次比较同时做类型判断+布局查询]

**InstanceKlass 内部** (`instanceKlass.hpp:80-350`):
- `_methods`: Method* 数组——包含从父类继承的所有方法 (non-overridden 继承，overridden 替换)
- `_fields`: FieldInfo 数组——类型/offset/名称——`instanceKlass.cpp:580` `parse_fields()` 从 ClassFileParser 填充
- `_constants`: ConstantPool*——类的符号引用存储——ClassFile 常量池→JVM ConstantPool 对象
- `_init_state`: 类初始化状态——`allocated→loaded→linked→being_initialized→fully_initialized`——JIT 只在 fully_initialized 后编译方法
- [C++: `InstanceKlass::_init_thread`——正在执行 <clinit> 的线程。如果另一个线程访问未初始化的类→检查 `_init_thread`→如果是自己→递归初始化 check→如果不是→等 `_init_thread` 完成]

**InstanceMirrorKlass** (`instanceMirrorKlass.hpp:35-80`):
- java.lang.Class 对象——`String.class` 返回的 java.lang.Class 实例——它的 C++ Klass
- [C++: 静态变量存储——`static_oop_field_count` 个 static OOP 字段——**不**在每个实例中——在 class 对象的末尾。非 static 字段属于 InstanceKlass——static 字段属于 InstanceMirrorKlass]

---

### 核心悬念

**"`obj.getClass()` 只有两步: oop→klass (1 deref)→Java mirror (1 deref)。"** — Klass 是 Java 类在 JVM 内部的 C++ 表示。vtable 决定虚方法调用——itable 决定接口方法调用。不同 Klass 子类决定不同行为——InstanceRefKlass 的 GC discover 逻辑、InstanceMirrorKlass 的 static field 存储。下一篇: 数组——int[] 和 String[] 为什么是不同的 Klass？

> → [03-instanceklass-arrayklass.md](03-instanceklass-arrayklass.md)
