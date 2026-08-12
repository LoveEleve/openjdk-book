# 04. 常量池与解析 — 字节码里的编号怎么变成直接指针

> **前置依赖**:[03 — InstanceKlass 与数组](03-instanceklass-arrayklass.md):InstanceKlass 的 `_constants` 指向本篇的 ConstantPool;[02 — Klass](02-klass-hierarchy.md):vtable 是解析结果的落点
> → **后续**:[05 — Access API](05-access-api-barrier.md)
> 关联域: 13-jit(C2 消费 cpCache 与 MethodData)、18-safepoint(解析与 deopt)

## invokevirtual #5: 一次编号,两种命运

`String s = ...; s.length()` 编译成字节码 `invokevirtual #5`——`#5` 是常量池下标,指向一个"符号引用": 类 `java/lang/String`、方法名 `length`、签名 `()I`。**第一次**执行到这条字节码,必须把符号引用解析成真实的方法入口(可能触发类加载);**之后**每次执行,只想付出"读缓存拿 vtable index、再查一次表"的代价。这篇拆开这条链: 符号引用仓库 ConstantPool、直接引用缓存 ConstantPoolCache、方法字节码的宿主 Method,以及 JIT 的两件工具(计数器与画像)。

## 1. ConstantPool: 符号引用仓库

每个 InstanceKlass 都有一份常量池(constantPool.hpp:98-107,截取核心,逐字):

```cpp
// constantPool.hpp:98-107(截取核心,逐字)
class ConstantPool : public Metadata {
  friend class VMStructs;
  ...
  Array<u1>*           _tags;        // the tag array describing the constant pool's contents
  ConstantPoolCache*   _cache;       // the cache holding interpreter runtime information
```

- [C++: ConstantPool 继承 **Metadata** 不是 oopDesc——它和 Klass 一样住在 Metaspace,不是 Java 对象;`_tags` 与条目数据并列存储,每个条目先看 tag 再按类型解释(Utf8/Integer/String/Class/Methodref/NameAndType……),`tag_at(which)` 是访问入口]

条目分两类:
- **直接量**: Utf8(字符串)、Integer/Float/Long/Double(常量值);
- **符号引用**: Class、Fieldref、Methodref、InterfaceMethodref、NameAndType、String(指向 Utf8 条目的下标)、MethodHandle/MethodType/InvokeDynamic——它们不直接存值,存**指向其他条目的下标**。比如 Methodref 条目 = class_index + name_and_type_index,解析时先按 class_index 找到类,再按 name_and_type 找方法。

拿类条目做例子——"取第 which 个类"不是 O(1) 数组读:

```cpp
// constantPool.hpp:380-383(截取核心,逐字)
  Klass* klass_at(int which, TRAPS) {
    constantPoolHandle h_this(THREAD, this);
    return klass_at_impl(h_this, which, true, THREAD);
  }
```

`klass_at_impl` 会检查条目是否已解析: 未解析就查 `SystemDictionary` 按名字找类(找不到则触发类加载),解析成功后把 `Klass*` 写回条目,此后才是 O(1)。**符号引用与直接引用共用一个条目空间**,靠 tag/状态区分。

**关键设计 (斜体)**: *为什么字节码不直接写死方法地址?因为类文件是"二进制可移植"的——字节码只引用常量池编号,类依赖(名字、签名)全部延迟到运行期解析: 字节码因此不绑定具体实现、类可以按需加载,解析失败的代价被推迟到真正执行的那一行。*

## 2. ConstantPoolCache: 解析结果的落点

直接引用不写在条目本体里,而是存在配套的 **ConstantPoolCache**(`_cache`,constantPool.hpp:107)——每个条目对应一个 `ConstantPoolCacheEntry`。条目的布局注释(cpCache.hpp:50-54,逐字):

```cpp
// cpCache.hpp:50-54(注释逐字)
// _f1        [  entry specific   ]  metadata ptr (method or klass)
// _f2        [  entry specific   ]  vtable or res_ref index, or vfinal method ptr
// _flags     [tos|0|F=1|0|0|0|f|v|0 |0000|field_index] (for field entries)
```

三个字段,按字节码类型**复用同一份内存**:

- **字段访问**(getstatic/putfield): `_f1` = 字段持有者(`java.lang.Class` 引用)、`_f2` = 字段偏移、`_flags` = 字段类型信息(cpCache.hpp:98-101);
- **虚调用**(invokevirtual): `_f2` = vtable index(或 final 方法的 Method*,`is_vfinal` 位标记);非虚调用 `_f1` = Method*(cpCache.hpp:107-116);
- **invokedynamic/invokehandle**: `_f1` = 管理实际调用的 adapter 方法;**appendix 参数(CallSite/MethodType)存在 ConstantPool 的 resolved_references 数组里**(cpCache.hpp:108-113 注释)。

- [C++: 和 mark word 同一招——8 字节按上下文多义解释。省内存是表象,真正的收益是**解释器/JIT 不用在调用点判断条目类型**: 解析时把该字段的语义固化好,执行时按 bytecode 固定读 _f1/_f2]

**首次调用的完整链路**: 解释器执行 `invokevirtual` → 查 cpCache 条目未解析 → `linkResolver` 解析(类加载/链接/验证)→ 结果写进条目(_f1/_f2/_flags,标记已解析)→ 继续执行。此后每次执行只读 `_f2` 再走 vtable 查表(02 篇的 lookup_virtual_method)。

**关键设计 (斜体)**: *解析只发生一次,结果固化在缓存里——代价(类加载+链接)摊销到整个类生命周期;缓存与常量池分离,还让解析失败可以被就地记录——indy 条目有专门的 `indy_resolution_failed` 位(cpCache.hpp:189,:366),不必每次调用都重试。*

## 3. Method: 字节码的宿主,四个入口

方法本身是一个 Method 对象(method.hpp:70-113,截取核心,逐字):

```cpp
// method.hpp:103-113(截取核心,逐字)
  address _i2i_entry;           // All-args-on-stack calling convention
  // Entry point for calling from compiled code, to compiled code if it exists
  // or else the interpreter.
  volatile address _from_compiled_entry;        // Cache of: _code ? _code->entry_point() : _adapter->c2i_entry()
  ...
  CompiledMethod* volatile _code;                       // Points to the corresponding piece of native code
  volatile address           _from_interpreted_entry; // Cache of _code ? _adapter->i2c_entry() : _i2i_entry
```

字节码本身不在这几个字段里——它内联在 `ConstMethod` 结构之后:`code_base() = (address)(this+1)` 指向结构体紧邻的字节码(constMethod.hpp:490,注释 :40 "The actual bytecodes are inlined after the end of the ConstMethod struct")。ConstMethod 固定头里只有各区的偏移(异常表、行号表、栈图等),数据区与字节码都在对象本体末尾,一次分配,零指针。

- [C++: Method 是"只读元数据(ConstMethod)+ 可变运行时状态(入口点、编译代码、计数)"的复合: ConstMethod 不可变可共享,入口点字段全部 volatile——编译完成、deopt 都在并发下发生]

**入口点由谁设置?** 不是某个 "MethodLinker" 管理器(jdk11u 没有这个类),是 `Method::link_method`(method.cpp:1077): 从解释器取方法入口(`Interpreter::entry_for_method`,:1099),一次设好 `_i2i_entry` 和 `_from_interpreted_entry`(二者初始相同,`set_interpreter_entry`,:1102)。之后四个入口各司其职:

| 调用方 → 目标 | 入口 |
|---|---|
| 解释器 → 解释器 | `_i2i_entry` |
| 解释器 → 编译代码 | `_from_interpreted_entry`(经 i2c adapter) |
| 编译代码 → 编译代码 | `_from_compiled_entry`(编译完成后更新) |
| 编译代码 → 解释器 | c2i adapter |

**关键设计 (斜体)**: *"方法被编译"不是一个不可逆事件——`Method::set_code`(method.cpp:1195-1219)在 Patching_lock 保护下依次更新 `_code`、`_from_compiled_entry` 和 `_from_interpreted_entry`(换到 i2c 入口,注释 "Instantly compiled code can execute"),解释器下一次调用就无缝进入编译代码;deopt 时在 safepoint 换回来。方法的"解释执行/编译执行"状态通过替换入口指针切换,调用点(解释器、JIT 生成的代码)永远不用知道方法处于哪个状态。*

## 4. 计数器与画像: 何时编译、怎么编译

### 4.1 MethodCounters: 计数触发编译

调用计数不在 MethodData,在独立的 `MethodCounters`(methodCounters.hpp:51-52,逐字):

```cpp
// methodCounters.hpp:51-52(逐字)
  InvocationCounter _invocation_counter;         // Incremented before each activation of the method - used to trigger frequency-based optimizations
  InvocationCounter _backedge_counter;           // Incremented before each backedge taken - used to trigger frequencey-based optimizations
```

- 解释器每次进入方法 `_invocation_counter` 加一;循环每次回边 `_backedge_counter` 加一;
- 分层编译下 x86 的阈值: 解释器 → C1 是 **1500**(c1_globals_x86.hpp:43),C1 → C2 是 **10000**(c2_globals_x86.hpp:43);
- 回边计数触发 **OSR**(On-Stack Replacement)——在循环**执行到一半**时把栈帧换到编译代码,长循环不用等它跑完才编译。

### 4.2 MethodData: 画像供给优化

MethodData(MDO,methodData.hpp:1955 `class MethodData : public Metadata`)按字节码位置存放运行时画像: `_data` 是 `DataLayout` 数组(methodData.hpp:286),`bci_to_data(bci)`(methodData.hpp:2350)把字节码偏移映射到数据。它记录什么:

- **分支概率**: "这个 if 95% 走 true";
- **接收者类型**: "这个 invokevirtual 的 receiver 几乎总是 ArrayList"——C2 据此做内联 + CHA(类层次分析)保护,猜错了走去优化(deopt)兜底;
- 方法调用计数/参数类型等。

- [C++: MDO 与 MethodCounters 各管一摊: 计数器决定**何时**编译(触发),画像决定**怎么**编译(优化)。MDO 由 ClassLoaderData 管理(methodData.cpp:709 allocate),随类一起释放]

**关键设计 (斜体)**: *JIT 是"数据驱动"的: 不猜热点,用计数器证明热度;不做盲优化,用画像做有依据的投机——猜错有 deopt 兜底。解释器=数据采集器,编译器=消费数据的工厂,Method/MethodCounters/MethodData 就是三者之间的账本。*

## 核心悬念

从 `invokevirtual #5` 出发,这条链完整了: 符号引用在 ConstantPool、解析结果固化在 ConstantPoolCache(_f1/_f2 按字节码多义复用)、方法字节码宿住在 Method(四个入口无缝切换解释/编译)、计数与画像驱动 JIT。但解释器/JIT 读写字段与数组元素时,都经过一条看不见的通道——`HeapAccess`——GC barrier 就藏在那里: 对象引用每次被写入,GC 都在"旁听"(卡表、跨区域引用记录)。下一篇: Access API——barrier 怎么做到透明且零开销。

> → [05-access-api-barrier.md](05-access-api-barrier.md)
