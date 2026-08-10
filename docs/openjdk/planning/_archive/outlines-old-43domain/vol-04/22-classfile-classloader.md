# ClassFile / ClassLoader — 文章大纲（Pass 1 修订版）

> vol-04 · 域 22 · 🔴 A | 基于 Pass 0+1 探索笔记
> Pass 1 产出：7 基本元素 / 7 标记问题 / 跨域消费者 JNI+CDS
> 依赖：OOPs + Metaspace + GC Framework
>
> **→ 从卷 03**：对象模型、内存管理、GC 全都好了。但 Java 类怎么从 `.class` 文件变成 JVM 里的 `InstanceKlass`？ClassFile 篇。

## 概念依赖

依赖 OOPs + Metaspace + GC Framework。被 JNI 和 CDS 作为消费者调用——`jni_FindClass()` → `SystemDictionary::resolve_or_null()`，CDS 归档映射 → 跳过 `ClassFileParser`。

## 叙事计划

**开篇场景**：`new String("hello")` 怎么让 JVM 知道 `java.lang.String` 是什么？`javac` 产出的 `String.class` 是一串二进制字节——`ClassFileParser` 解析魔数 `0xCAFEBABE`、常量池、字段、方法，产出 `InstanceKlass`。`SystemDictionary` 把它注册进全局类表——下次再遇到 `String` 直接从表里取，不用重新解析。

**第一层：ClassFileParser——.class 二进制解析 pipeline**

`ClassFileParser::parseClassFile()`（JVM 最大单文件，6463 行）逐段解析 class 文件：verify `0xCAFEBABE` → `parse_constant_pool()`（UTF8/String/Class/Fieldref/Methodref/NameAndType 等 11 种常量类型）→ `parse_interfaces()` → `parse_fields()`（access_flags + name + descriptor + attributes）→ `parse_methods()`（access_flags + name + signature + Code 属性含字节码）→ `parse_class_attributes()`（BootstrapMethods/InnerClasses）。`verify_legal_class_name()` / `verify_legal_class_modifiers()` 做语法校验。最后 `create_instance_klass()` 构造 InstanceKlass。

**第二层：SystemDictionary——全局类注册表**

`SystemDictionary`（`systemDictionary.hpp:223`）用 `Dictionary`（内部哈希表：类名→Klass）做类查找。`resolve_or_null()`（`:272`）→ 查 `_dictionary` → 命中返回 / 未命中触发类加载。`_placeholders` 管并发——线程 A 在加载 `String` 时，线程 B 被 `wait()` 阻塞在同一个 placeholder 上，A 加载完后 `notify_all()`——不会重复加载。

跨域消费者：`jni_FindClass()` 调 `resolve_or_null()`、`java_lang_Class::forName0()` 走同一条路径、Reflection API 也走同一条路径。类在所有入口都是这一个注册表。

**第三层：Dictionary——哈希表内部**

`Dictionary` 是 `SystemDictionary` 内部的哈希表——支持 `resize()` / `rehash()` 维护查找性能。JDK11 的 `Dictionary` 有 `_resizable` 模式——在类加载高峰期动态扩容。`verify_lookup_length()` 监控哈希冲突——退化到 O(n) 时触发重哈希。

**第四层：ClassLoader——双亲委派 + 模块系统**

`ClassLoader::load_class()`（`classLoader.hpp:381`）→ bootstrap（C++ 内置，加载 `java.*`）→ platform（`jdk.*`）→ application（用户类路径）。`ClassPathEntry` 链管理路径条目。

JDK11 的模块系统（JEP 261）引入 `ModuleEntry`（`moduleEntry.cpp`）——`-p/--module-path` 设置的模块通过 `_module_first_entry` 先于 classpath 搜索。`ModuleEntry::can_read(ModuleEntry* m)` 检查 `requires` 边——解析 `java.sql.Driver` 时先确认当前模块 `requires java.sql`，否则抛出 `IllegalAccessError`。

**第五层：ClassLoaderData——per-classloader 的生命周期**

`ClassLoaderData`（CLD）追踪每个 classloader 加载的所有 Klass、管理 Metaspace 分配区域。类卸载时 CLD 标记为 dead → MetaspaceGC 触发 → 遍历 CLD 关联的所有 Klass → 检查 `!is_alive(clazz)` → 卸载 Method/ConstantPool/itable。CLD 有自己的锁——不同 classloader 可以并行加载类，同一 classloader 的并行加载受 CLD 保护。

**第六层：链接三段——verify → prepare → resolve**

`InstanceKlass::link_class()` 走三段 pipeline：verification（`verifier.cpp:2913`，StackMapTable 类型检查——JDK7 后从"推演操作数栈"变为"检查预计算帧"），preparation（静态字段分配默认值），resolution（符号引用→直接引用——`linkResolver` 做具体查找）。

`rewriter` 在链接阶段重写字节码——`getfield #5`（常量池索引）→ `fast_agetfield`（直接用字段偏移量）。`_init_state` 状态标记类处于哪个阶段：`allocated → loaded → linked → being_initialized → fully_initialized`。

**第七层：Well-known class 预加载**

`SystemDictionary::initialize_wk_klasses()` 在 JVM 启动早期预加载核心类——`java.lang.Object`（必须最先——所有类的父类）、`java.lang.Class`、`java.lang.String`、`java.lang.Thread`、`java.lang.reflect.*` 等。加载顺序有严格要求——`Object` 必须在任何类之前，`Class` 必须在 mirror 创建之前。

**设计权衡**

一、Placeholder vs double-lock。`_placeholders` 哈希表防重复加载——比 `volatile + synchronized` 更细粒度（不同类名走不同 placeholder），代价是额外哈希表维护。

二、StackMapTable vs 操作数栈推演。预计算表节省运行时验证时间（O(n) → O(1) 每条指令），但 class 文件变大。JDK11 仍支持老式 class 文件（版本 <50 无 StackMapTable）。

## 核心悬念

**`new String("hello")` 里面 JVM 怎么找到 `String.class`——解析魔数、注册 SystemDictionary、链接三段、初始化 <clinit>，JNI/CDS/Reflection 全部走同一个入口？**

**→ 下一域**：类加载完了，`InstanceKlass` 里存了所有方法的字节码——但 JVM 怎么执行 `a + b`？模板解释器篇见。

## 预估

强制拆 2 篇：ClassFileParser + SystemDictionary(1篇) / ClassLoader + Module + 链接(1篇)，合计 5000-6500 行。
