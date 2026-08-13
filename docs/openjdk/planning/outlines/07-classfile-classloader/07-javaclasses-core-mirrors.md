# 07. javaClasses — String/Class/Thread 的 JVM 内建镜像

> 🟡 Working | 15 KP 中的 1 个机制
> 读者处境: `Thread.currentThread()`——返回的不是普通对象——JVM 内建 `java_lang_Thread` 类直接操作它。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/07-classfile-classloader/07 已按真实源码成文~405 行,本大纲为规划期产物,机制描述以文章为准):
> - **"javaClasses.hpp:60-500" 行号漂移**: String 类在 :93-211(String 偏移 :95-97);Class 类在 :225-343;Thread 类在 :347-444;BASIC_JAVA_CLASSES_DO 在 :50-85(共 **31 个镜像**: PART1 Class/String + PART2 29 个);CLASS_INJECTED_FIELDS 在 **:216-223**(非 1562+——1562 是 ALL_INJECTED_FIELDS 宏起点,:1562-1569)
- **"eetop 存 pthread_t (OS 级线程 ID)" 错(机制编造)**: eetop 存的是 **JavaThread\* 指针**(javaClasses.cpp:1641-1648 thread()/set_thread 用 address_field);它声明在 Thread.java:158(注释 "Fields reserved for exclusive use by the JVM"),不是注入字段;jstack 的 `#1` 是 **tid 字段**(java_lang_Thread::thread_id,javaClasses.cpp:1753-1760)不是 eetop;jstack 一行三 ID: #1=Java 层 tid 字段、tid=JavaThread 对象地址(thread.cpp:923)、nid=OS 线程 ID(pthread_t,osThread.cpp:41-42)
- **"klass 字段存 compressed Klass*→decode" 错**: 镜像的 klass 字段存**全宽 Klass\* 指针**,as_Klass(:1390-1396)用 metadata_field 一次加载(oop.hpp:163);压缩类指针作用于 Klass 之间,不作用于镜像字段
- **compute_offsets 时机(大纲未提)**: 分两阶段——String/Class 在 SystemDictionary::resolve_well_known_classes(systemDictionary.cpp:2012-2015)先算;其余 29 个在 javaClasses_init→JavaClasses::compute_offsets(javaClasses.cpp:4463-4482);interpreter_init(init.cpp:117)早于 javaClasses_init(:125),update_delayed_values(:4481)是为此保留的延迟常量补丁通道(jdk11u 模板表未实际使用)
- **注入字段机制(大纲未提,核心)**: may_be_java=false 的字段是 JVM 注入(7-01 parse_fields get_injected,classFileParser.cpp:1575-1578),带 JVM_ACC_FIELD_INTERNAL(fieldInfo.hpp:240);偏移查 _injected_fields 表(javaClasses.cpp:85-87)+InjectedField::compute_offset(:4558-4580);ALL_INJECTED_FIELDS 共 **14 个**(Class 7+ClassLoader 1+ResolvedMethodName 2+MemberName 1+CallSiteContext 1+StackFrameInfo 1+Module 1)
- **ThreadStatus 是 JVMTI 状态位组合**(javaClasses.hpp:407-434: RUNNABLE=ALIVE|RUNNABLE 等),不是简单枚举;jstack 的 Thread.State 来自 thread_status_name(:1773-1785)
- **StringDedup 用法(大纲表述模糊)**: StringDedupTable::deduplicate(stringDedupTable.cpp:345-393)——value() 取数组/is_latin1 定编码/hash 字段缓存(先查后写,javaClasses.inline.hpp:62-66,与 String.java:156 的 private int hash 共享)/set_value 替换数组(:390)
- **C2 用法(大纲表述准确但补具体)**: GraphKit::load_String_length(graphKit.cpp:3887-3893)=数组长度>>coder;value_offset_in_bytes 直接参与地址计算(:3895);Java 层 String.length() 同逻辑(String.java:658)
- **mirror 可变大小(大纲未提)**: create_mirror(javaClasses.cpp:894+)=InstanceMirrorKlass::allocate_instance(instanceMirrorKlass.cpp:48-56,静态字段住镜像里);oop_size/static_oop_field_count 注入字段自描述大小(:1279-1291,读回 :58-60);fixup_mirror_list + Universe::fixup_mirrors(systemDictionary.cpp:2023)补齐早期镜像;getClass() 链路=Object.java:72 native→jni_GetObjectClass(jni.cpp:1292-1300)→obj->klass()->java_mirror()(与 as_Klass 反方向)
- 悬念指向 09-memory-core/01-universe-heap.md(标题 "01. Universe + CollectedHeap — JVM 的"Genesis"与全局堆")✓;实证: materials/commands/42-process-reaper-thread.txt:13(jstack 一行三 ID)

### 1. javaClasses 模式 — 预计算的 field offset

场景: `String s = "hello"; int len = s.length();`——JIT 想直接读 `value` 字段——但需要知道 value 在 heap 对象的哪个 offset。不能每次调 FieldInfo——太慢。

**javaClasses 解决**: `java_lang_String::value_offset()`——初始时一次性计算→存为 `static int`→JIT inline 为常数——`mov rbx, [rax + value_offset]`——零反射开销。

**核心类镜像** (`javaClasses.hpp:93-444` 三大类 + `javaClasses.cpp` 4586行):
- `java_lang_String`(:93-211): `value_offset` (byte[])/`coder_offset` (LATIN1=0 or UTF16=1)/`hash_offset` (cached hash code);compute_offsets :200-209;访问器在 javaClasses.inline.hpp(value :52-56/is_latin1 :67-73/length :74-87 UTF16 >>1)
- `java_lang_Class`(:225-343): `klass_offset`——镜像→JVM Klass* 的反向指针;CLASS_INJECTED_FIELDS :216-223(klass/array_klass/oop_size/static_oop_field_count/protection_domain/signers/source_file)
- `java_lang_Thread`(:347-444): `eetop_offset`——**JavaThread\* 指针**(Java 对象↔C++ 线程双向指针)/`tid_offset`——线程 ID/`threadStatus_offset`——JVMTI 状态位
- [C++: javaClasses 是 JVM 内部 class——每个核心 Java 类有对应的 `java_lang_XXX` 名字空间。偏移在 `java_lang_XXX::compute_offsets()` 中一次性计算——`InstanceKlass::cast(SystemDictionary::String_klass())->find_field(...)->access_flags().offset()`→static int。JIT 用这些 int 作为 immediate operand——零 indirection;找不到字段→vm_exit_during_initialization(javaClasses.cpp:131-143)]

**String 压缩 (Java 9+)** (`javaClasses.cpp:200-500`):
- coder: byte=0 (LATIN1, 1B/char) or byte=1 (UTF16, 2B/char)——按内容选
- `java_lang_String::value(obj)` = `obj->obj_field(value_offset)`→return `typeArrayOop` (byte[] if LATIN1, char[] if UTF16)
- [C++: String 去重——G1 `StringDeduplication`——用 `java_lang_String::value()` 取 char 数组→hash→如果已有相同→用已有 array 替代——节省堆内存]

### 2. Thread + Class 的特殊处理

**java_lang_Thread**: `eetop` = **JavaThread\* 指针**(不是 OS 线程 ID!)——`java_lang_Thread::thread()`→`obj->address_field(eetop_offset)`——is_alive 直接判 eetop 非空(:1687-1690);jstack 的 `#1` 线程 ID 来自 `thread_id()`→`tid` 字段(:1753-1760)

**java_lang_Class**: `klass` 注入字段存 **全宽 Klass\* 指针**→`java_lang_Class::as_Klass(obj)`→`metadata_field(_klass_offset)`(:1390-1396)——`obj.getClass()` 的内部实现;反向=Klass._java_mirror(klass.hpp:139)

---

### 核心悬念

**"`Thread.currentThread()`——eetop 字段存的是 JavaThread\* 指针;jstack 的一行三 ID(#1=tid 字段/tid=JavaThread 地址/nid=pthread_t)。"** — javaClasses 让 JIT 直接访问核心 Java 类的内部——避免了反射和 JNI 开销。String 的压缩编码 (LATIN1/UTF16) 让 ASCII String 内存减半。域 7 完成——Group 3 结束。下一篇: 09-memory-core——镜像对象分配在哪、堆怎么诞生(Universe::genesis)。

> → domain 9: [Universe + CollectedHeap — 镜像对象分配在哪、堆怎么诞生](09-memory-core/01-universe-heap.md)
