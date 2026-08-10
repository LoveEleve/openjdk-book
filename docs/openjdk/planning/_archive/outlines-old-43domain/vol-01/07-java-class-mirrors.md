# Java Class Mirrors — 文章大纲

> vol-01 · 域 07 · 🟡 B | 拓扑排序 #7
> 依赖：OOPs（对象模型）+ OS（内存分配）

## 叙事计划

**开篇场景**：JVM 源码里经常看到 `java_lang_String::value(obj)` —— 用 C++ 代码读一个 Java String 的字符数组。但 `value` 是 Java 的 `private final byte[]`，C++ 怎么绕过访问控制直接读？答案是 JVM 在初始化时算好了每个字段的偏移量，存成常量——之后所有 C++ 代码通过"基地址 + 偏移量"直接读写 Java 对象的字段。

**第一层：模式——每个 Java 类型一个 C++ 静态助手类**

`javaClasses.hpp`（4586 行 `.cpp`）为每个核心 Java 类型定义了一个 `AllStatic` 类：`java_lang_String`（`:93`）、`java_lang_Class`（`:225`）、`java_lang_Thread`、`java_lang_System`、`java_lang_reflect_Method` 等。每个类有 `compute_offsets()` 在 JVM 启动时计算字段偏移量，之后通过 `field_offset()` + `obj->obj_field_put()` 或 `obj->int_field_put()` 直接读写。

**第二层：java_lang_Class——Klass 和 Java Class 对象的双向桥**

`java_lang_Class::create_mirror()`（`javaClasses.hpp:264`）在类加载完成时调用——为 `Klass` 创建对应的 `java.lang.Class` 对象。这个 mirror 对象存储在 Klass 的 `_java_mirror` 字段中。反向：`java_lang_Class::as_Klass(mirror_oop)` 从 Java 的 `Object.getClass()` 返回值直接拿到 Klass 指针——不需要查表或散列。

**第三层：java_lang_String——C++ 如何创建和操作 Java String**

`java_lang_String::create_oop_from_str()`（`:120`）从 C 字符串创建 Java String 对象——在 GC 堆上分配 char 数组（或 byte 数组，JDK9+ compact strings），设置 `value` 字段和 `coder` 字段。`value(oop str)` 直接读 `value` 字段拿到 `typeArrayOop`——比 JNI `GetStringUTFChars` 快得多，因为不需要拷贝。

**第四层：反射链——Method/Field/Constructor 的 C++ 表示**

`java_lang_reflect_Method` 持有 `Method*` 指针的包装对象。`java_lang_reflect_Field` 持有字段索引和声明的 Klass。`Constructor` 就是 Method 的特例。反射 API 最终都通过 C++ 直接操作 oop 和 Klass 实现——`Field.set(obj, value)` 在 C++ 层就是 `obj->obj_field_put(field_offset, value)`。

**设计权衡**

一、偏移量计算 vs 硬编码。每次 JVM 启动时 `compute_offsets()` 动态计算——兼容不同 JDK 版本下字段排列变化。代价是启动时多一次字段遍历。

二、直接内存访问 vs JNI 封装。JNI 的 `GetStringUTFChars` 需要分配临时 buffer 并拷贝。`java_lang_String::value()` 直接读 GC 堆上的原始数组——零拷贝，但在 safepoint 外操作有 GC 并发风险。

## 核心悬念

**C++ 代码怎么直接读写 Java 对象的 `private` 字段？JVM 里那些 `java_lang_String::value(obj)` 调用是怎么绕过所有 Java 访问控制的？**

**→ 下一域**：C++ 能直接操作 Java 对象了，但 native 代码通过 JNI 拿到的又是什么？`env->FindClass()` 返回的不是 Klass 指针——是 JNI 句柄。为什么多一层句柄包装？JNI 层篇见。

## 预估

1 篇，4 层递进，预估 1500-2000 行。
