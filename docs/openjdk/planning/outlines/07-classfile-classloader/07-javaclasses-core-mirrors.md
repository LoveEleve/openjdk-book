# 07. javaClasses — String/Class/Thread 的 JVM 内建镜像

> 🟡 Working | 15 KP 中的 1 个机制
> 读者处境: `Thread.currentThread()`——返回的不是普通对象——JVM 内建 `java_lang_Thread` 类直接操作它。

### 1. javaClasses 模式 — 预计算的 field offset

场景: `String s = "hello"; int len = s.length();`——JIT 想直接读 `value` 字段——但需要知道 value 在 heap 对象的哪个 offset。不能每次调 FieldInfo——太慢。

**javaClasses 解决**: `java_lang_String::value_offset()`——初始时一次性计算→存为 `static int`→JIT inline 为常数——`mov rbx, [rax + value_offset]`——零反射开销。

**核心类镜像** (`javaClasses.hpp:60-500` + `javaClasses.cpp` 4586行):
- `java_lang_String`: `value_offset` (char[]/byte[])/`coder_offset` (LATIN1=0 or UTF16=1)/`hash_offset` (cached hash code)
- `java_lang_Class`: `klass_offset`——镜像→JVM Klass* 的反向指针
- `java_lang_Thread`: `eetop_offset`——pthread_t (OS 级线程 ID)/`threadStatus_offset` (RUNNABLE/BLOCKED/...)
- [C++: javaClasses 是 JVM 内部 class——每个核心 Java 类有对应的 `java_lang_XXX` 名字空间。偏移在 `java_lang_XXX::compute_offsets()` 中一次性计算——`InstanceKlass::cast(SystemDictionary::String_klass())->find_field(...)->access_flags().offset()`→static int。JIT 用这些 int 作为 immediate operand——零 indirection]

**String 压缩 (Java 9+)** (`javaClasses.cpp:200-500`):
- coder: byte=0 (LATIN1, 1B/char) or byte=1 (UTF16, 2B/char)——按内容选
- `java_lang_String::value(obj)` = `obj->obj_field(value_offset)`→return `typeArrayOop` (byte[] if LATIN1, char[] if UTF16)
- [C++: String 去重——G1 `StringDeduplication`——用 `java_lang_String::value()` 取 char 数组→hash→如果已有相同→用已有 array 替代——节省堆内存]

### 2. Thread + Class 的特殊处理

**java_lang_Thread**: `eetop` = native thread ID (pthread_t)——`java_lang_Thread::thread_id()`→`obj->long_field(eetop_offset)`——jstack 输出线程 ID

**java_lang_Class**: `klass` 字段存了 compressed Klass*→`java_lang_Class::as_Klass(obj)`→decode→Klass*——`obj.getClass()` 的内部实现

---

### 核心悬念

**"`Thread.currentThread()`——eetop 字段存的是 Linux pthread_t。"** — javaClasses 让 JIT 直接访问核心 Java 类的内部——避免了反射和 JNI 开销。String 的压缩编码 (LATIN1/UTF16) 让 ASCII String 内存减半。域 7 完成——Group 3 结束。下一篇: Interpreter——类加载完，JVM 怎么执行字节码？

> → domain 8: [Interpreter — 解析完 .class，字节码怎么一步一步执行？](../08-interpreter/01-bytecodes-and-interpreter.md)
