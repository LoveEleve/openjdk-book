# ClassFile / ClassLoader — Pass 0+1 探索笔记

> vol-04 · 域 22 · 🔴 A | 2026-08-07

## Pass 0: 设计上下文

**关键 git 提交**：
- `1d78ce4d8a` JDK-8221351: shared class 加载 class_file_load_hook 崩溃——CDS 和 JVMTI 交互边界
- `86cf496d4b` JDK-8222446: SystemDictionary 修改计数器和 TypeFunc 不一致——并发加载 + 去优化的 race
- `a17c306f81` JDK-8218851: 自定义 classloader 压力测试崩溃——并发 defineClass 的竞态
- `25a2ccaf7f` JDK-8203382: `initialize_wk_klass` 重命名为 `resolve_wk_klass`——well-known class 加载命名
- `332a672e9c` JDK-8210094: 改进 classloader 类加载——bootstrap 的初始化顺序

**演进趋势**：并发 class loading 是 bug 高发区（多线程同时请求同一个类时的 placeholder/defineClass 竞态）。模块系统（JDK9 JEP 261）是最大的架构变更——引入了 per-module classloader 权限隔离。

## Pass 1: 结构扫描

### 核心文件
```
classfile/
  classFileParser.cpp (6463行)        — .class 二进制解析
  systemDictionary.cpp (3058行)       — 全局类注册表
  verifier.cpp (2913行)               — 字节码验证
  classLoader.cpp (1805行)            — classpath + 双亲委派
  classLoaderData.cpp                 — per-classloader 元数据
  moduleEntry.cpp                     — JDK9 模块条目
  javaClasses.cpp (4586行)            — Java 类型 C++ 表示 [Java Class Mirrors 域]
  classFileStream.cpp                 — class 文件流读取
  dictionary.cpp                      — Dictionary 哈希表实现
```

### 依赖/消费者图
```
JNI (jni.cpp)                     CDS (metaspaceShared.cpp)
    │                                  │
    ▼                                  ▼
SystemDictionary::resolve_or_null() ←──┘
    │
    ├── 命中 → 返回 Klass
    └── 未命中 → load_instance_class()
                    │
                    ▼
                ClassLoader::load_class()
                    │
                    ▼
                ClassFileParser::parseClassFile()
                    │
                    ▼
                InstanceKlass (存入 SystemDictionary)
                    │
                    ▼
                链接: verify → prepare → resolve (linkResolver)
                    │
                    ▼
                初始化: <clinit> 执行
```

### 基本元素分解

1. **ClassFileParser**：`parseClassFile()` 逐步解析 class 文件二进制格式——magic `0xCAFEBABE`→version→constant_pool→access_flags→this_class→super_class→interfaces→fields→methods→attributes。`create_instance_klass()` 用解析结果构造 `InstanceKlass`。

2. **SystemDictionary**：全局类注册表。`_dictionary`（哈希表：类名→Klass）+ `_placeholders`（并发保护：线程 A 在加载时线程 B 等待）。`resolve_or_null()` 是入口——JNI / Reflection / 字节码解析全部通过它查类。

3. **ClassLoader**：`load_class()` 实现双亲委派——bootstrap→platform→application。`ClassPathEntry` 链管理 classpath。JDK11 模块系统引入 `_module_first_entry`——模块路径优先传统 classpath。

4. **Dictionary**：`Dictionary` 是 `SystemDictionary` 内部使用的哈希表——`resize()` / `rehash()` 处理冲突。`verify_lookup_length()` 确保查找性能不退化。

5. **Verifier**：`Verifier::verify_class()` 走 StackMapTable 验证。JDK7 后 verifier 从"推演操作数栈类型"变为"检查预计算 StackMap 帧是否匹配"——更快但 class 文件更大。

6. **ClassLoaderData**：per-classloader 元数据——追踪该 classloader 加载的所有 Klass、管理 Metaspace 分配。类卸载时通过 CLD 找到所有关联 Klass 批量回收。

7. **ModuleEntry**：JDK9 模块系统的核心——`ModuleEntryTable` 管理所有模块，`reads` 边表示模块依赖。`SystemDictionary` 解析类时检查当前模块是否 `requires` 目标模块。

### 标记问题（≥5）

1. **_placeholders 怎么防止重复加载？** 线程 A 在加载 `java.lang.String` 时线程 B 也来请求——B 在 placeholder 上 `wait()`，A 加载完后 `notify_all()`。这个过程怎么处理加载失败——one失败≠所有waiting线程失败？

2. **双亲委派在 JDK11 模块系统下怎么工作？** 以前 `loadClass()` 先问 parent——JDK9 后 `findModule()` 先于 parent delegation。`java.sql` 模块的类怎么通过 `requires java.logging` 找到 logging 模块中的类？

3. **并行 class loading 的锁粒度是什么？** `ClassLoaderData` 有自己的锁？`SystemDictionary` 有全局锁？不同 classloader 能否并行加载不同的类？同一个 classloader 能否并行加载不同类？

4. **StackMapTable 验证怎么和 non-StackMapTable 验证共存？** class 文件版本 <50 没有 StackMapTable——verifier 需要回退到推演模式。JDK11 是否还支持没有 StackMapTable 的 class 文件？

5. **`defineClass` 和 CDS 的交互？** CDS 归档中有预解析的 `InstanceKlass`——加载时跳过 ClassFileParser，直接从归档 mmap。但如果 class 文件版本变了（patch 更新），怎么退回到正常解析路径？

6. **classLoader 卸载怎么触发类卸载？** ClassLoader 对象不可达→CLD 标记为 dead→MetaspaceGC 触发→遍历 CLD 关联的所有 Klass→check `!is_alive(clazz)`→卸载所有方法/常量池/itable。这个过程在哪个 safepoint 中执行？

7. **well-known class 预加载机制？** `SystemDictionary::initialize_wk_klasses()` 在 JVM 启动时预加载 `java.lang.Object/String/Class/Thread` 等核心类——这些类的加载顺序有严格要求吗（Object 必须在所有类之前）？
