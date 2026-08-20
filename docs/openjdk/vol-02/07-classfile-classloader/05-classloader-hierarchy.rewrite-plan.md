# 07-classfile-classloader/05-classloader-hierarchy 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 Java 层的双亲委派如何与上一章 VM 内部的 initiating/defining loader 协议拼接起来，并说明 CLD 如何承载加载域的元数据生命周期

## 1. 选题判断

现稿已经覆盖了三层加载器、`loadClass` 五步和 `ClassLoaderData` 回收，但仍像三块并列事实卡片，容易让人得到“三级线性查找链”的过度简化印象。

真正的读者困惑是：

**Java 层 `loadClass` 的双亲委派，到底如何与上一章 SystemDictionary 的 initiating/defining loader 协议对接？为什么 `parent == null` 不等于“没有父”，而是“委托到 bootstrap 的 VM 边界”？JDK 11 里 bootstrap、platform、app 三者又为什么不是一条简单的单向查找链？最后，谁来真正拥有这些 loader 关联的元数据——Java `ClassLoader` 本身，还是 VM 侧的 `ClassLoaderData`？**

## 2. 一句话顿悟

**双亲委派真正拆开的是“谁先尝试寻找类”与“谁最终定义类”。Java `ClassLoader.loadClass` 先查 initiating loader 已知结果，再委派给 parent；当 `parent == null` 时桥接到 VM bootstrap loader。JDK 11 的 builtin loader 还在父链之上叠加了模块归属路由，因此 platform 可以按模块把请求交给 app。VM 侧真正拥有类元数据生命周期的不是 Java `ClassLoader` 对象，而是每个 linking domain 对应的 `ClassLoaderData`。**

## 3. 总图

```text
Java call: loader.loadClass(name)
  │
  ├─ ClassLoader.loadClass (default algorithm)
  │    ├─ synchronized(getClassLoadingLock(name))
  │    ├─ findLoadedClass(name)   // initiating-loader view
  │    ├─ parent.loadClass(...) or findBootstrapClassOrNull
  │    ├─ findClass(name)
  │    └─ resolveClass(c)
  │
  ├─ BuiltinClassLoader override
  │    ├─ module/package owner routing
  │    ├─ internal parent chain
  │    └─ own class path
  │
  ├─ bootstrap bridge
  │    └─ Java findBootstrapClassOrNull -> native -> JVM_FindClassFromBootLoader
  │         -> SystemDictionary::resolve_or_null
  │
  └─ VM ownership
       ├─ SystemDictionary decides lookup/definition/publication
       └─ ClassLoaderData owns dictionary, class list, metaspace, handles, unloading lifecycle
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——为什么“双亲委派”不是一张简单的三层箭头图

目标约 1000 字。

- 从三个常见误解开场：
  1. app → platform → bootstrap 的单线搜索图
  2. `platform.getParent()==null` 就代表它没有父
  3. 一个链路上同名类永远只有一个定义
- 回收上一章：SystemDictionary 区分 initiating loader 和 defining loader
- 提出本文问题：Java 层委派到底怎样决定“向谁问”，VM 层又怎样决定“谁真正定义”

### 第二节：三个朴素方案为什么不成立

目标约 1800 字。

至少推演：

1. `loadClass` 只做“先问父再问自己”的单线链图 → 无法解释模块路由和 bootstrap 桥接
2. `parent == null` 等于没有父也没有委派 → 无法解释 `findBootstrapClassOrNull`
3. Java `ClassLoader` 自己直接拥有全部元数据生命周期 → 无法解释 CLD、anonymous class 和 GC unloading

引出：Java 层负责委派协议，VM 层负责解析/定义/生命周期，两者通过 native bridge 和 CLD 拼接。

### 第三节：默认 `ClassLoader.loadClass`——双亲委派真正做了哪五步

目标约 1800 字。

- `getClassLoadingLock(name)` 的同步边界
- `findLoadedClass(name)` 的 initiating-loader 语义，不是“只查自己定义的类”
- parent 非 null 时 `parent.loadClass`，parent 为 null 时 `findBootstrapClassOrNull`
- 只有父链失败才 `findClass`
- 最后 `resolveClass`
- `preDefineClass` 的安全边界：`java.*` 禁止、PD、signer 检查

### 第四节：builtin loaders——为什么 JDK 11 的“父链”上面还叠了一层模块路由

目标约 2200 字（核心拆解层）。

- `ClassLoaders` 如何创建 `BootClassLoader` / `PlatformClassLoader` / `AppClassLoader`
- `BuiltinClassLoader.loadClassOrNull` 的真实顺序：
  - 已加载检查
  - package/module owner routing
  - internal parent
  - own class path
- platform loader 在升级模块场景下可路由到 app loader
- 这说明 JDK 11 的类查找不是单纯的“父优先单链”
- 说明“builtin loader 的 parent”与 Java API `getParent()` 观察到的 parent 不是同一个字段语义

### 第五节：bootstrap——为什么“它不是一个普通 `ClassLoader` 对象”要说两遍

目标约 1900 字。

- VM bootstrap loader：Java API 中通常以 null 表示
- `BootClassLoader` 是 Java-side bridge/facade，而非 VM 里真正的 bootstrap loader 本体
- `BootLoader` 是静态 facade，不是 `ClassLoader`
- `findBootstrapClassOrNull` → native `findBootstrapClass` → `JVM_FindClassFromBootLoader` → `SystemDictionary::resolve_or_null`
- bootstrap 搜索顺序：module visibility check -> CDS -> `ClassLoader::load_class`
- `ClassLoader::load_class` 的 normal mode 与 append-only mode：patch-module、runtime image、boot append
- 纠正 “rt.jar” 与 “bootstrap 搜普通 classpath” 的旧叙事

### 第六节：defining loader 与 initiating loader——双亲委派和上一章为什么能拼起来

目标约 1800 字（核心拆解层）。

- `findLoadedClass` 的 initiating-loader 语义
- parent 委派成功时，请求者 loader 成为 initiating loader，真正定义者可能是 parent 或 bootstrap
- `SystemDictionary` 在 defining loader != initiating loader 时执行 constraints / dependency / update_dictionary
- “一条委派链上通常共享同一个定义”与“不同 defining loader 仍可定义同名类”的边界
- 不能写成“整条链永远只有一个 definition”；必须限定为委派成功时多个 loader 共享同一结果

### 第七节：ClassLoaderData——为什么真正拥有元数据生死的是 CLD 而不是 Java loader

目标约 2200 字（核心拆解层）。

- CLD 不是 Java `ClassLoader`，而是 VM-side linking domain
- loader 对象隐藏字段指向 CLD；bootstrap 也有 singleton CLD
- CLD 拥有/跟踪：dictionary、_klasses、metaspace、handles、packages/modules、deallocate_list
- `add_class` 路径把 `InstanceKlass` 挂到 CLD `_klasses`
- SystemDictionary 索引类；CLD 持有元数据集合和生命周期
- anonymous class 拥有独立 CLD，不进入普通 dictionary

### 第八节：CLD 卸载——类卸载为什么是一批 metadata 一起死

目标约 1700 字。

- `ClassLoaderDataGraph::do_unloading`：活 CLD 清 deallocate list，死 CLD `unload()` 并移到 unloading list
- `purge()` 统一销毁 dead CLD
- `is_alive() = keep_alive() || _holder.peek() != NULL`
- `_holder` 决定普通 loader CLD 生死
- `keep_alive` 的精确边界：匿名类和 bootstrap/null CLD，不是通用“把 loader 保活”的机制
- live CLD 的 `free_deallocate_list` 与 dead CLD 的 `unload_deallocate_list` 区别

### 第九节：误解澄清与收网

目标约 1100 字。

至少回答：

1. 双亲委派是否就是 app→platform→bootstrap 的单线搜索图
2. `parent == null` 是否等于没有父也没有委派
3. `BootClassLoader` 是否就是 VM bootstrap loader 本体
4. platform loader 是否真的“没有父”
5. `findLoadedClass` 是否只查自己定义的类
6. 委派链上是否永远只有一个定义
7. CLD 是否就是 Java ClassLoader 自身
8. `keep_alive` 是否是通用 loader 保活机制

## 5. 失败方案必须写进正文

1. 把类加载画成简单三级直线搜索图
2. 把 `parent == null` 解释成“不再委派”
3. 把 Java `ClassLoader` 当作元数据生命周期 owner

## 6. 证据清单

- `ClassLoader.java:530-545,571-606`：默认 `loadClass` 算法
- `ClassLoader.java:649-679`：`getClassLoadingLock`
- `ClassLoader.java:886-915`：`preDefineClass`
- `ClassLoader.java:1270-1289`：`findLoadedClass` 的 initiating-loader 语义
- `ClassLoader.java:1256-1267`：`findBootstrapClassOrNull`
- `ClassLoaders.java:52-79,107-120,126-178`：Boot/Platform/App 创建与 BootClassLoader bridge
- `BuiltinClassLoader.java:82-92,156-165,590-631`：模块路由、parent 处理、loadClassOrNull
- `BootLoader.java:51-57,112-117`：BootLoader 只是 facade
- `ClassLoader.c:214-248`：`findBootstrapClass` JNI bridge
- `jvm.cpp:762-785`：`JVM_FindClassFromBootLoader`
- `systemDictionary.cpp:1403-1476`：bootstrap visibility/CDS/load_instance_class
- `classLoader.cpp:817-868,914-947,1405-1487`：runtime image / patch-module / boot append 搜索顺序
- `systemDictionary.cpp:821-845`：initiating vs defining loader bookkeeping
- `dictionary.hpp:123-141`：initiating loader + PD cache 语义
- `classLoaderData.cpp:25-47`：CLD 定义与 bootstrap/null 说明
- `classLoaderData.hpp:221-255`：CLD 拥有的关键字段
- `classLoaderData.cpp:159-180,460-473`：CLD 构造与 `add_class`
- `classLoaderData.inline.hpp:34-38,58-67`：loader -> CLD 关系
- `systemDictionary.cpp:1825-1849`：do_unloading 委派 CLDG
- `classLoaderData.cpp:1371-1472`：CLDG unloading/purge
- `classLoaderData.cpp:597-630,724-782,881-943`：`unload`、析构、两种 deallocate list 处理
- `classLoaderData.cpp:144-153,287-303,695-701`：`keep_alive` / `is_alive` 边界
- `systemDictionary.cpp:963-1003,1825-1827`：anonymous class 独立 CLD / 不入普通 dictionary

## 7. 必须明确的边界

- 基于 OpenJDK 11u / HotSpot / Linux / x86_64
- “三层加载”只是一种职责概括，不是完整搜索算法
- `BootClassLoader` / `BootLoader` / VM bootstrap loader 三者必须分开
- `findLoadedClass` 的 initiating-loader 语义不能简化成“自己定义的类缓存”
- builtin loader 的模块路由是 JDK 9+ 之后叠加在父链上的额外维度
- 委派成功时多个 initiating loader 共享同一结果；不同 defining loader 仍可定义同名类
- CLD 是 VM-side linking domain / metadata owner，不是 Java loader 对象本身
- `keep_alive` 是匿名类与 bootstrap/null CLD 的特殊生存机制，不是通用 loader pin 机制

## 8. 完成后 review

- 删除代码后能否复述“Java delegation -> bootstrap bridge -> SystemDictionary initiating/defining loader -> CLD ownership/unloading”
- 是否纠正了三层线性图、parent=null、BootClassLoader 本体化、findLoadedClass 只查定义者缓存等误解
- 是否把 Java 层委派协议与上一章 VM 侧解析协议真正拼接起来
- 是否把 CLD 的 ownership/unloading 讲成独立于 Java loader 对象的 VM 生命周期层
- 是否完成删码测试、禁用词、file:line、链接和版本边界检查
