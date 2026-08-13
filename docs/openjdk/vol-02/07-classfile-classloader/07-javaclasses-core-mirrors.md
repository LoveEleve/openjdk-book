# 07. javaClasses — 核心类的 JVM 内建镜像

> **前置依赖**:[07-classfile-classloader/01 — ClassFile 解析](openjdk/vol-02/07-classfile-classloader/01-classfile-parser.md):injected fields 在 parse_fields 里注入,这一篇讲它们被谁定义、偏移怎么算;[07-classfile-classloader/03 — Symbol/StringTable](openjdk/vol-02/07-classfile-classloader/03-symbol-string-table.md):`create_from_unicode` 构造 String 的编码,这一篇读它;[07-classfile-classloader/04 — SystemDictionary](openjdk/vol-02/07-classfile-classloader/04-system-dictionary.md):well-known 类的加载与 `String_klass()` 从哪来;[07-classfile-classloader/06 — JPMS Modules](openjdk/vol-02/07-classfile-classloader/06-jpms-modules.md):ModuleEntry 的 `_module` 弱句柄就是"镜像"的第一个例子;[06-oops/02 — Klass 层次](openjdk/vol-02/06-oops/02-klass-hierarchy.md):Klass 的 `_java_mirror` 是镜像的另一端
> → **后续**:[09-memory-core/01 — Universe + CollectedHeap](openjdk/vol-02/09-memory-core/01-universe-heap.md)(镜像对象分配在哪、堆怎么诞生)
> 关联域: 06-oops(对象模型)、07-classfile-classloader(类加载)、09-memory-core(堆与镜像分配)、16-code-cache(JIT 生成代码直接嵌偏移)

## 一个 Java 对象,两个世界的握手

`Thread.currentThread()` 返回的 `Thread` 对象,jstack 能从它打出线程名、`#1` 这种线程 ID、`daemon`、`prio=5`、`java.lang.Thread.State: RUNNABLE`——这些信息不是反射读出来的,jstack 直接**按字段偏移**从对象里取: 名字是 obj_field、线程 ID 是 long_field、状态是 int_field。String 也一样: JIT 编译 `"hello".length()` 时,不需要任何反射——方法内联后就是读 `value` 数组长度、读 `coder` 字段,偏移直接编进机器码。支撑这一切的是一个叫 `javaClasses` 的 C++ 模块——每个核心 Java 类一个 `java_lang_XXX` 镜像类。这是 07 域的收官篇,类加载链路的最后一环: 类加载完了,核心类的**实例**怎么被 JVM 高频操作。

## 1. 镜像模式: 预计算的字段偏移

### 每个核心类一个 C++ 镜像

核心 Java 类的布局信息全部收敛在 `share/classfile/javaClasses.hpp/cpp`(cpp 4586 行,本域最大文件之一)。每个类一个 `AllStatic` 的 C++ 类,名字与 Java 类一一对应——`java_lang_String` 镜像 `java.lang.String`、`java_lang_Class` 镜像 `java.lang.Class`、`java_lang_Thread` 镜像 `java.lang.Thread`(javaClasses.hpp:50-85 的 `BASIC_JAVA_CLASSES_DO` 宏列了全部 31 个镜像: PART1 的 Class/String + PART2 的 29 个)。镜像类里没有对象,只有**静态 int 偏移**和操作这些偏移的静态方法(javaClasses.hpp:93-99,截取核心,逐字):

```cpp
// javaClasses.hpp:93-99(截取核心,逐字)
class java_lang_String : AllStatic {
 private:
  static int value_offset;
  static int hash_offset;
  static int coder_offset;

  static bool initialized;
```

`value_offset`/`hash_offset`/`coder_offset` 就是 `java.lang.String` 三个字段在堆对象里的字节偏移。任何 VM 代码想读 String 的 value 数组:`obj->obj_field(value_offset)`;想判断编码:`byte_field(coder_offset)`。VM 不调 Java 层的 `String.length()`,自己直接读。

### 偏移怎么算: 启动时 find_local_field 一次

偏移不是硬编码的——JVM 不知道也不信任 javac 编出来的布局,它启动时用 `fieldDescriptor` 在类里**按名字和签名查找**(javaClasses.cpp:121-143,截取核心,逐字):

```cpp
// javaClasses.cpp:121-144(截取核心,逐字)
static void compute_offset(int &dest_offset,
                           InstanceKlass* ik, Symbol* name_symbol, Symbol* signature_symbol,
                           bool is_static = false) {
  fieldDescriptor fd;
  if (ik == NULL) {
    ResourceMark rm;
    log_error(class)("Mismatch JDK version for field: %s type: %s", name_symbol->as_C_string(), signature_symbol->as_C_string());
    vm_exit_during_initialization("Invalid layout of well-known class");
  }

  if (!ik->find_local_field(name_symbol, signature_symbol, &fd) || fd.is_static() != is_static) {
    ResourceMark rm;
    log_error(class)("Invalid layout of %s field: %s type: %s", ik->external_name(),
                     name_symbol->as_C_string(), signature_symbol->as_C_string());
#ifndef PRODUCT
    // Prints all fields and offsets
    Log(class) lt;
    LogStream ls(lt.error());
    ik->print_on(&ls);
#endif //PRODUCT
    vm_exit_during_initialization("Invalid layout of well-known class: use -Xlog:class+load=info to see the origin of the problem class");
  }
  dest_offset = fd.offset();
}
```

字段名和签名来自 `vmSymbols` 表(String 的三个字段,javaClasses.cpp:195-198,截取核心,逐字):

```cpp
// javaClasses.cpp:195-198(截取核心,逐字)
#define STRING_FIELDS_DO(macro) \
  macro(value_offset, k, vmSymbols::value_name(), byte_array_signature, false); \
  macro(hash_offset,  k, "hash",                  int_signature,        false); \
  macro(coder_offset, k, "coder",                 byte_signature,       false)
```

然后 `compute_offsets` 把三个宏展开成三次 `compute_offset`(javaClasses.cpp:200-209): 拿 `SystemDictionary::String_klass()`(07-04 的 well-known 类缓存),逐个字段找偏移。**找不到就 `vm_exit_during_initialization`**——错误消息带着 JDK 版本不匹配的诊断提示。镜像偏移是 JVM 与 JDK 之间的契约: 布局不匹配不再是"运行时行为诡异",而是启动即失败、报错即定位。

[C++: `vmSymbols` 是预 intern 的 Symbol 表(每个 Java 类/字段名一个枚举值,07-04 讲过 well-known classes 用它做快速解析)——名字不经过字符串比较,直接按枚举取 Symbol 指针。]

### 时机: 两个阶段,一个都不能早

偏移计算分两阶段,因为镜像类之间有依赖:

- **String 和 Class 最先算**——在 `SystemDictionary::resolve_well_known_classes` 里,Object/String/Class 三个最基础类一加载完就立刻算(systemDictionary.cpp:2012-2015,截取核心,逐字):

```cpp
// systemDictionary.cpp:2012-2015(截取核心,逐字)
  // Calculate offsets for String and Class classes since they are loaded and
  // can be used after this point.
  java_lang_String::compute_offsets();
  java_lang_Class::compute_offsets();
```

String/Class 是"一切的基础"——它们是最早加载的 well-known 类(Object/String/Class 三兄弟),加载完就能用,所以立刻算: 这之后才有异常、类加载、反射等一切依赖 String 表示与 Class 镜像的操作。

- **其余 29 个镜像在 `javaClasses_init` 里算**——`JavaClasses::compute_offsets`(javaClasses.cpp:4463-4482)把 PART2 的类(System/Thread/Throwable/ClassLoader/…)全部算完,然后调 `AbstractAssembler::update_delayed_values()`。这最后一行揭示了一个时序问题: 模板解释器的机器码在 `interpreter_init`(init.cpp:117)就生成了,**早于** `javaClasses_init`(:125)算偏移——模板生成时若要用偏移,得先留占位,偏移算好后再 `update_delayed_values` 统一替换(jdk11u 的模板表代码没有实际使用这个延迟常量机制,但补丁通道保留着)。C2 则是另一条路: 编译方法时偏移早已算好,直接编进机器码——**不是每次运行时算,而是代码生成时把启动期算好的 int 直接嵌进去**。

**关键设计 (斜体)**: *镜像模式的本质是"**启动时算一次,之后零反射**": 布局查找(find_local_field + 签名匹配)只发生在启动早期,运行期访问全是 `obj_field(offset)` 一次内存读。代价是 JVM 与 JDK 的类布局强耦合——所以失败模式设计成"启动即死",而不是运行时慢慢错。*

## 2. String: 三个偏移撑起压缩编码

### value/coder/hash: 一个对象三块信息

String 的堆布局: `value`(**永远是 byte[]**——Java 9 压缩字符串的存储端;Latin-1 每字符 1 字节,UTF-16 每字符 2 字节即数组长度翻倍,07-01 的解析与 07-03 的创建)、`coder`(1 字节编码标志)、`hash`(缓存的 hashCode)。编码标志两个值(javaClasses.hpp:107-111): `CODER_LATIN1 = 0`、`CODER_UTF16 = 1`——这就是 CompactStrings 的核心: 存 1 字节还是 2 字节,由 coder 决定。`is_latin1` 就是一次 `byte_field(coder_offset)` 比较(javaClasses.inline.hpp:67-73,截取核心,逐字):

```cpp
// javaClasses.inline.hpp:67-73(截取核心,逐字)
bool java_lang_String::is_latin1(oop java_string) {
  assert(initialized && (coder_offset > 0), "Must be initialized");
  assert(is_instance(java_string), "must be java_string");
  jbyte coder = java_string->byte_field(coder_offset);
  assert(CompactStrings || coder == CODER_UTF16, "Must be UTF16 without CompactStrings");
  return coder == CODER_LATIN1;
}
```

`length` 也靠它: 先读 `value` 数组长度,再按 coder 决定要不要除 2(javaClasses.inline.hpp:74-87)——UTF-16 时数组长度是字符数的两倍(`arr_length >>= 1`)。

### JIT 眼里没有 String.length(): 一次移位

C2 的字符串优化路径(拼接、长度计算)不调 `String.length()`——graphKit.cpp:3887-3893 的 `load_String_length` 直接按镜像偏移读:

```cpp
// graphKit.cpp:3887-3893(截取核心,逐字)
Node* GraphKit::load_String_length(Node* ctrl, Node* str) {
  Node* len = load_array_length(load_String_value(ctrl, str));
  Node* coder = load_String_coder(ctrl, str);
  // Divide length by 2 if coder is UTF16
  return _gvn.transform(new RShiftINode(len, coder));
}
```

`load_String_value` 里,`java_lang_String::value_offset_in_bytes()` 直接作为偏移参与地址计算(:3895)——机器码层面就是带立即数偏移的访存(`mov rax, [rdx + offset]`)。`value` 数组长度读出来,右移 coder 位: Latin-1 移 0 位原样返回,UTF-16 移 1 位正好除 2。有意思的是 Java 层的 `String.length()` 也是同一套逻辑(String.java:658 `value.length >> coder()`)——**一次移位替代了整个 Java 方法调用**,这正是 §1 镜像模式给 JIT 的礼物。

### 字符串去重: 全程只用镜像访问器

G1 的字符串去重(StringDeduplication)在 GC 并发阶段扫描 String,用镜像访问器拿 value 数组、算 hash、替换数组——一个 Java 方法都不调(stringDedupTable.cpp:345-393,截取核心,逐字):

```cpp
// stringDedupTable.cpp:345-393(截取核心,逐字)
void StringDedupTable::deduplicate(oop java_string, StringDedupStat* stat) {
  assert(java_lang_String::is_instance(java_string), "Must be a string");
  NoSafepointVerifier nsv;

  stat->inc_inspected();

  typeArrayOop value = java_lang_String::value(java_string);
  if (value == NULL) {
    // String has no value
    stat->inc_skipped();
    return;
  }

  bool latin1 = java_lang_String::is_latin1(java_string);
  unsigned int hash = 0;

  if (use_java_hash()) {
    // Get hash code from cache
    hash = java_lang_String::hash(java_string);
  }

  if (hash == 0) {
    // Compute hash
    hash = hash_code(value, latin1);
    stat->inc_hashed();

    if (use_java_hash() && hash != 0) {
      // Store hash code in cache
      java_lang_String::set_hash(java_string, hash);
    }
  }

  typeArrayOop existing_value = lookup_or_add(value, latin1, hash);
  if (existing_value == value) {
    // Same value, already known
    stat->inc_known();
    return;
  }

  // Get size of value array
  uintx size_in_bytes = value->size() * HeapWordSize;
  stat->inc_new(size_in_bytes);

  if (existing_value != NULL) {
    // Existing value found, deduplicate string
    java_lang_String::set_value(java_string, existing_value);
    stat->deduped(value, size_in_bytes);
  }
}
```

细节都在镜像访问器上: `value()`(javaClasses.inline.hpp:52-56)读数组、`is_latin1()` 定编码、`hash()` 用**缓存的 hash 字段**(:62-66——`private int hash` 本是 Java 层 `String.hashCode()` 的缓存(String.java:156),VM 去重时先查缓存、算完写回,一个字段两个世界共用)、找到相同数组后 `set_value()` 把原数组替换掉(去重数组本身,多个 String 共享同一个 value 数组)。

[C++: `lookup_or_add` 把 value 数组本身(而非 String)作为去重 key——两个内容相同的 "hello" 的 value 数组内容相同,hash 相同,后到的被替换成先到的数组。]

**关键设计 (斜体)**: *String 是 JVM 里被读写频率最高的对象,所以它的镜像访问器全部 inline、偏移启动时算好、编码判断一次 byte 读——从解释器到 GC 到 JIT,所有路径走同一套访问器。存储端(Latin-1 压成 1 字节)与读取端(一个 coder 位)是同一枚硬币的两面: 07-03 讲创建时怎么选编码,这一篇讲读取时怎么知道编码。*

## 3. Thread: eetop 存的是 JavaThread*,不是 OS 线程 ID

### 11 个偏移里,最特别的一个叫 eetop

`java_lang_Thread` 的镜像有 11 个偏移(javaClasses.cpp:1614-1626,截取核心,逐字):

```cpp
// javaClasses.cpp:1614-1626(截取核心,逐字)
#define THREAD_FIELDS_DO(macro) \
  macro(_name_offset,          k, vmSymbols::name_name(), string_signature, false); \
  macro(_group_offset,         k, vmSymbols::group_name(), threadgroup_signature, false); \
  macro(_contextClassLoader_offset, k, vmSymbols::contextClassLoader_name(), classloader_signature, false); \
  macro(_inheritedAccessControlContext_offset, k, vmSymbols::inheritedAccessControlContext_name(), accesscontrolcontext_signature, false); \
  macro(_priority_offset,      k, vmSymbols::priority_name(), int_signature, false); \
  macro(_daemon_offset,        k, vmSymbols::daemon_name(), bool_signature, false); \
  macro(_eetop_offset,         k, "eetop", long_signature, false); \
  macro(_stillborn_offset,     k, "stillborn", bool_signature, false); \
  macro(_stackSize_offset,     k, "stackSize", long_signature, false); \
  macro(_tid_offset,           k, "tid", long_signature, false); \
  macro(_thread_status_offset, k, "threadStatus", int_signature, false); \
  macro(_park_blocker_offset,  k, "parkBlocker", object_signature, false)
```

注意 javaClasses.hpp:349-350 的注释: Thread 的布局在 JDK 1.2 和 1.3 之间改过,所以镜像**必须**运行时计算偏移而不能硬编码。其中 `eetop` 声明在 Java 源码里但只给 JVM 用(Thread.java:158,上方注释 "Fields reserved for exclusive use by the JVM")——它存的不是流传说法里的"pthread_t(OS 线程 ID)",而是 **JavaThread\* 指针**(javaClasses.cpp:1641-1648,截取核心,逐字):

```cpp
// javaClasses.cpp:1641-1648(截取核心,逐字)
JavaThread* java_lang_Thread::thread(oop java_thread) {
  return (JavaThread*)java_thread->address_field(_eetop_offset);
}


void java_lang_Thread::set_thread(oop java_thread, JavaThread* thread) {
  java_thread->address_field_put(_eetop_offset, (address)thread);
}
```

`eetop` 的名字没有官方解释,内容却是清楚的: Java Thread 对象 ↔ 原生线程的双向指针——每个 `JavaThread` 有 `threadObj()`(Java 对象),每个 Java Thread 对象有 eetop(C++ 线程)。两个世界通过这一对指针握手,类似 07-06 的 ModuleEntry._module。

### 绑定时机: 构造器调用之前

初始线程的绑定在 `create_initial_thread`(thread.cpp:1088-1102,截取核心,逐字):

```cpp
// thread.cpp:1088-1102(截取核心,逐字)
// Creates the initial Thread
static oop create_initial_thread(Handle thread_group, JavaThread* thread,
                                 TRAPS) {
  InstanceKlass* ik = SystemDictionary::Thread_klass();
  assert(ik->is_initialized(), "must be");
  instanceHandle thread_oop = ik->allocate_instance_handle(CHECK_NULL);

  // Cannot use JavaCalls::construct_new_instance because the java.lang.Thread
  // constructor calls Thread.current(), which must be set here for the
  // initial thread.
  java_lang_Thread::set_thread(thread_oop(), thread);
  java_lang_Thread::set_priority(thread_oop(), NormPriority);
  thread->set_threadObj(thread_oop());

  Handle string = java_lang_String::create_from_str("main", CHECK_NULL);
```

注释点破因果: **Java 的 Thread 构造器内部调 `Thread.current()`**(Thread.java:258 的 native 方法 → `JVM_CurrentThread`,jvm.cpp:3139-3144,直接返回 `thread->threadObj()`),所以必须先绑定 eetop 再执行 Java 构造器——否则 `current()` 拿不到自己。名字 "main" 也是这里用 `java_lang_String::create_from_str`(javaClasses.cpp:298)造的——String 镜像的创建路径(07-03)在启动时首次亮相。

线程退出时反向操作(thread.cpp:1885-1890): `set_thread_status(TERMINATED)` 写状态,`set_thread(threadObj(), NULL)` 清 eetop——清空后 `is_alive` 判定立刻变 false,join() 得以完成。

### jstack 的每一列: 全是从镜像访问器读的

`Thread.isAlive()`(Java,Thread.java:1051 native)的链路全程是镜像访问器: JNI 表里的 `isAlive`(Thread.c:46)→ `JVM_IsThreadAlive`(jvm.cpp:2987-2992)→ `java_lang_Thread::is_alive`(javaClasses.cpp:1687-1690)——**没有 Java 调用**,直接判 eetop 是否非空:

```cpp
// javaClasses.cpp:1687-1690(截取核心,逐字)
bool java_lang_Thread::is_alive(oop java_thread) {
  JavaThread* thr = java_lang_Thread::thread(java_thread);
  return (thr != NULL);
}
```

javaClasses.hpp:386-387 的注释说得很直白: "Alive (NOTE: this is not really a field, but provides the correct definition without doing a Java call)"。jstack 的线程信息也全部来自镜像访问器——`JavaThread::print_on`(thread.cpp:3011-3026,截取核心,逐字):

```cpp
// thread.cpp:3011-3026(截取核心,逐字)
void JavaThread::print_on(outputStream *st, bool print_extended_info) const {
  st->print_raw("\"");
  st->print_raw(get_thread_name());
  st->print_raw("\" ");
  oop thread_oop = threadObj();
  if (thread_oop != NULL) {
    st->print("#" INT64_FORMAT " ", (int64_t)java_lang_Thread::thread_id(thread_oop));
    if (java_lang_Thread::is_daemon(thread_oop))  st->print("daemon ");
    st->print("prio=%d ", java_lang_Thread::priority(thread_oop));
  }
  Thread::print_on(st, print_extended_info);
  // print guess for valid stack memory region (assume 4K pages); helps lock debugging
  st->print_cr("[" INTPTR_FORMAT "]", (intptr_t)last_Java_sp() & ~right_n_bits(12));
  if (thread_oop != NULL) {
    st->print_cr("   java.lang.Thread.State: %s", java_lang_Thread::thread_status_name(thread_oop));
  }
```

- `"main"`: 线程名(String 对象,`get_thread_name`);
- `#1`: **`thread_id`(javaClasses.cpp:1753-1760)读的是 `tid` 字段**(JDK 5 起引入),不是 eetop——流传的"jstack 的 tid 来自 eetop"是把镜像的"能读"与"读哪个字段"混淆了;
- `daemon`/`prio=5`: `is_daemon`(:1693-1695)、`priority`(:1661-1663);
- `java.lang.Thread.State: RUNNABLE`: `thread_status_name`(:1773-1785)把 `threadStatus` 字段的数值翻译成名字。

jstack 行尾还有两列 ID(Thread::print_on,thread.cpp:900-926): `tid=0x...` 是 **JavaThread 对象地址**(`p2i(this)`,:923),`nid=0x...` 才是 OS 线程 ID(`OSThread::print_on`,osThread.cpp:41-42,`thread_id()` 即 pthread_t)。[实证] 里 `"main" #1 prio=5 ... tid=0x00007f9d88025a50 nid=0x1165a3`(materials/commands/42-process-reaper-thread.txt:13)——**一行三个 ID,三种身份**: `#1` 是 Java 层 `tid` 字段、`tid` 是 C++ JavaThread 地址、`nid` 才是 OS 层的 pthread_t。这也再次坐实: eetop 与线程 ID 没有任何关系,它只是对象与 JavaThread 之间的指针。

`threadStatus` 的值是 JVMTI 状态位组合(javaClasses.hpp:407-434 的 `ThreadStatus` 枚举): RUNNABLE = `JVMTI_THREAD_STATE_ALIVE | JVMTI_THREAD_STATE_RUNNABLE`,SLEEPING = ALIVE|WAITING|WAITING_WITH_TIMEOUT|SLEEPING,BLOCKED_ON_MONITOR_ENTER 只有 ALIVE|BLOCKED_ON_MONITOR_ENTER……Java 层 `Thread.getState()` 返回的 `Thread.State` 枚举就是在 Java 侧再翻译一层这些位。VM 写这个字段的时机在状态转换处(如退出时写 TERMINATED,:1887)。

**关键设计 (斜体)**: *Thread 镜像的教训是"命名别猜"——`eetop` 听着像 OS 层的东西,实际存的是 JavaThread\*;jstack 的 `#tid` 又是另一个字段。镜像字段的语义以 C++ 访问器为准,不看名字。而 `is_alive` 这种"不是字段的字段"证明了镜像模式的另一个用途: 把跨世界的判断(isAlive 需要访问 JavaThread 状态)压缩成一次指针判空。*

## 4. Class: 注入的字段与双向镜像

### CLASS_INJECTED_FIELDS: Java 层不存在的 7 个字段

`java.lang.Class` 是镜像模式的极端案例: 它有一批**Java 层根本不存在的字段**——`klass`、`array_klass`、`oop_size`、`static_oop_field_count`、`protection_domain`、`signers`、`source_file`(javaClasses.hpp:216-223,截取核心,逐字):

```cpp
// javaClasses.hpp:216-223(截取核心,逐字)
#define CLASS_INJECTED_FIELDS(macro)                                       \
  macro(java_lang_Class, klass,                  intptr_signature,  false) \
  macro(java_lang_Class, array_klass,            intptr_signature,  false) \
  macro(java_lang_Class, oop_size,               int_signature,     false) \
  macro(java_lang_Class, static_oop_field_count, int_signature,     false) \
  macro(java_lang_Class, protection_domain,      object_signature,  false) \
  macro(java_lang_Class, signers,                object_signature,  false) \
  macro(java_lang_Class, source_file,            object_signature,  false) \
```

宏参数最后一个 `false` 是 `may_be_java`——表示这些字段**不是** Java 源文件里的字段,是 JVM 在解析 `java.lang.Class` 时**注入**的(07-01 的 `parse_fields` 调 `JavaClasses::get_injected`,classFileParser.cpp:1563-1566,注入后它们和其他字段一样参与布局——所以 Java 层的 `Class` 对象比 `java.lang.Class` 的 Java 源码里看到的字段多)。整个注入字段家族在 `ALL_INJECTED_FIELDS`(javaClasses.hpp:1562-1569): Class 7 个 + ClassLoader 1 个 + ResolvedMethodName 2 个 + MemberName/CallSiteContext/StackFrameInfo/Module 各 1 个,共 14 个。

注入字段的偏移不走 `find_local_field`(那查不到)而是查 `_injected_fields` 表(javaClasses.cpp:85-87),真正的查找在 `InjectedField::compute_offset`(javaClasses.cpp:4558-4568,截取核心,逐字):

```cpp
// javaClasses.cpp:4558-4568(截取核心,逐字)
int InjectedField::compute_offset() {
  InstanceKlass* ik = InstanceKlass::cast(klass());
  for (AllFieldStream fs(ik); !fs.done(); fs.next()) {
    if (!may_be_java && !fs.access_flags().is_internal()) {
      // Only look at injected fields
      continue;
    }
    if (fs.name() == name() && fs.signature() == signature()) {
      return fs.offset();
    }
  }
```

`may_be_java=false` 时要求字段带 `JVM_ACC_FIELD_INTERNAL` 标志(fieldInfo.hpp:240)——注入字段用这个标志标记,Java 反射 API 看不到它,GC 扫描、布局计算却照常处理。所以镜像类分两种字段来源: 普通字段(Java 源码里就有)走 `find_local_field`,注入字段走 `AllFieldStream`——最后都变成同一套静态偏移,`compute_offsets` 里两部分都算(javaClasses.cpp:1545-1561): CLASS_FIELDS_DO(classRedefinedCount/classLoader/componentType/module/name,5 个 Java 字段,:1538-1544)+ CLASS_INJECTED_FIELDS(7 个注入)。注意 :1555-1558 的一个巧妙设计: `_init_lock_offset`(类初始化锁)与 `_component_mirror_offset`(数组的镜像)共用同一个偏移——普通类镜像用 init_lock,数组类镜像用 component_mirror,一个 C union。

### 双向镜像: klass 字段 ↔ Klass._java_mirror

镜像关系是双向的:

- **Klass → 镜像**: `Klass::_java_mirror`(klass.hpp:139,`OopHandle`),06-02 讲过——`getClass()` 的"最后一步";
- **镜像 → Klass**: `java_lang_Class::as_Klass`(javaClasses.cpp:1390-1396,截取核心,逐字):

```cpp
// javaClasses.cpp:1390-1396(截取核心,逐字)
Klass* java_lang_Class::as_Klass(oop java_class) {
  //%note memory_2
  assert(java_lang_Class::is_instance(java_class), "must be a Class object");
  Klass* k = ((Klass*)java_class->metadata_field(_klass_offset));
  assert(k == NULL || k->is_klass(), "type check");
  return k;
}
```

`klass` 注入字段存的是 **Klass\* 指针本身**(`metadata_field` 直接读指针宽度)——不是流传说法里的"压缩 Klass* 再 decode"。压缩类指针(UseCompressedClassPointers)是另一套机制(对象头与 Metaspace 里类型指针的窄化),不作用于镜像字段——`metadata_field` 走 HeapAccess 一次加载即可(oop.hpp:163)。

`getClass()` 的完整链路正好把两个方向串起来(Object.java:72 的 native 声明 → JNI 的 `GetObjectClass`,jni.cpp:1292-1300): `obj->klass()` 拿 Klass,再 `k->java_mirror()` 拿镜像——两个方向,四个访问器,一次 Java 方法调用都没有。

### mirror 是"可变大小对象": 静态字段就藏在 Class 对象后面

`java.lang.Class` 对象的特别之处: **静态字段住在镜像里**(06-02 的 InstanceMirrorKlass)。所以镜像大小是动态的——创建时按目标类的静态字段数计算(javaClasses.cpp:894-914,截取核心,逐字):

```cpp
// javaClasses.cpp:894-914(截取核心,逐字)
void java_lang_Class::create_mirror(Klass* k, Handle class_loader,
                                    Handle module, Handle protection_domain, TRAPS) {
  assert(k != NULL, "Use create_basic_type_mirror for primitive types");
  assert(k->java_mirror() == NULL, "should only assign mirror once");

  // Use this moment of initialization to cache modifier_flags also,
  // to support Class.getModifiers().  Instance classes recalculate
  // the cached flags after the class file is parsed, but before the
  // class is put into the system dictionary.
  int computed_modifiers = k->compute_modifier_flags(CHECK);
  k->set_modifier_flags(computed_modifiers);
  // Class_klass has to be loaded because it is used to allocate
  // the mirror.
  if (SystemDictionary::Class_klass_loaded()) {
    // Allocate mirror (java.lang.Class instance)
    oop mirror_oop = InstanceMirrorKlass::cast(SystemDictionary::Class_klass())->allocate_instance(k, CHECK);
    Handle mirror(THREAD, mirror_oop);
    Handle comp_mirror;

    // Setup indirection from mirror->klass
    java_lang_Class::set_klass(mirror(), k);
```

`instance_size`(instanceMirrorKlass.cpp:40-46)按目标类的静态字段数算镜像大小——`size_helper() + static_field_size()`;`allocate_instance`(:48-56)按这个大小分配,注释说得很清楚: "Since mirrors can be variable sized because of the static fields, store the size in the mirror itself."——**镜像把自己的大小存进注入字段 `oop_size`**,`set_oop_size`(javaClasses.cpp:1279-1281)/`set_static_oop_field_count`(:1289-1291)在创建时写入,GC 读 `InstanceMirrorKlass::oop_size`(:58-60)时再取出来。一个对象自己报告自己的大小,这是 JVM 里少数几个"自描述大小"的对象。静态字段的初始值也在这里统一写入(`initialize_static_field`,javaClasses.cpp:744-789,按字段类型写镜像偏移)。

镜像创建后还有补丁列表: `_fixup_mirror_list`——某些类加载太早(Class 还没就绪),镜像先挂在待补丁列表,`resolve_well_known_classes` 里 `Universe::fixup_mirrors`(systemDictionary.cpp:2023)统一补齐;基本类型的镜像(int.class 等)由 `create_basic_type_mirror` 特造。模块字段则由 `set_mirror_module_field` 写入——07-06 那个"ModuleEntry 握着 java.lang.Module 弱句柄"的镜像在这里完成另一头: Class 对象也握着它的 Module。

**关键设计 (斜体)**: *Class 镜像把"类"这个抽象折叠成一个普通对象: 双向指针(klass↔mirror)让两个世界互相可达,注入字段让 JVM 私有的元数据(大小、静态字段数、Klass 指针)藏在普通对象里而不污染 Java API,可变大小让静态字段白住镜像的房子。jmap -histo 里每个类的静态字段都算在 Class 对象头上——就是这套布局的外在表现。*

## 核心悬念

07 域以 javaClasses 收官: 镜像模式把核心 Java 类的实例变成"偏移已知的普通堆对象"——String 的 value/coder/hash 三个偏移撑起压缩编码与去重,C2 把 `value_offset` 直接编进机器码;Thread 的 eetop 是 JavaThread* 双向指针,is_alive/jstack 全靠镜像访问器零反射读取;Class 的 7 个注入字段与可变大小镜像把 Klass 元数据藏进普通对象。你大概注意到了本节反复出现的词——`allocate_instance`、`oop_size`、`Universe::fixup_mirrors`: 镜像的创建与修复挂在**堆**上,`Class_klass` 的实例、静态字段、空数组都分配在 Universe 管理的堆里。但堆本身是谁、在什么时候创建的?答案是启动早期的 `universe_init` 建堆、`Universe::genesis` 在堆上造第一批对象——JVM 的"宇宙大爆炸"。下一篇: Universe 与 CollectedHeap——堆怎么诞生、第一批对象是什么。

> → [09-memory-core/01 — Universe + CollectedHeap](openjdk/vol-02/09-memory-core/01-universe-heap.md)
