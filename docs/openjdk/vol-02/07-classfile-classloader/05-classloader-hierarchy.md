# 05. ClassLoader — 双亲委派与三层加载

> **前置依赖**:[07-classfile-classloader/04 — SystemDictionary](openjdk/vol-02/07-classfile-classloader/04-system-dictionary.md):用户加载器在 Java 层 loadClass 的钩子已经埋好;[42-core-native/03 — ClassLoader + I/O + TimeZone](openjdk/vol-02/42-core-native/03-class-io.md):findBootstrapClass 的 native 链
> → **后续**:[06 — JPMS Modules](06-jpms-modules.md)
> 关联域: 06-oops(ClassLoaderData)、25-gc(CLD 回收)、11-cds

## 谁负责找类: 三层加载器

07-04 的结尾留了个钩子: 用户加载器解析类时,hotspot 调的是 **Java 层的 `ClassLoader.loadClass`**——"找类"的规矩全在 Java 代码里。这套规矩的核心是三张牌: **Bootstrap、Platform、App** 三层加载器,与贯穿其中的**双亲委派**。这一篇拆三层加载的构成、loadClass 的五步、以及承载加载结果的 ClassLoaderData 怎么生怎么死。

## 1. 三层: Bootstrap 不是"一个加载器"

### 层次结构: 两个 BuiltinClassLoader + 一个"不是"

[实证] 直接打印了这棵树(materials/commands/07-classfile-loader-hierarchy.txt):

```
app      = jdk.internal.loader.ClassLoaders$AppClassLoader@5cb0d902
platform = jdk.internal.loader.ClassLoaders$PlatformClassLoader@198a8075
app.parent      = jdk.internal.loader.ClassLoaders$PlatformClassLoader@198a8075
platform.parent = null
String.class.loader       = null        ← bootstrap 加载,getClassLoader() 返回 null
LoaderDemo.class.loader   = ...AppClassLoader
java.sql.Driver.class.loader = ...PlatformClassLoader
```

- **App 与 Platform 都是 `BuiltinClassLoader` 的子类**(jdk/internal/loader/ClassLoaders.java: PlatformClassLoader :126、AppClassLoader :151),由 `ClassLoaders` 类在启动早期创建(platformClassLoader :96/appClassLoader :103);App 的 parent 是 Platform;
- **Bootstrap 不是 ClassLoader 实例**: 它没有 Java 对象,`getClassLoader()` 对 bootstrap 加载的类返回 null。它的"类"是 C++ 侧的 `ClassLoader`(share/classfile/classLoader.cpp)与 Java 侧的 `BootLoader`(jdk/internal/loader/BootLoader.java,只管资源和模块);
- 加载范围: Platform 管 JDK 模块类(`java.sql.Driver` 在实证里由它加载),App 管 classpath。

### bootstrap 的实际加载: C++ 侧 ClassLoader::load_class

Bootstrap 没有 Java 方法可调——hotspot 直接干活: `ClassLoader::load_class`(classLoader.cpp:1406 起)。07-04 已经见过它的一半(模块可见性检查);后半是真正的文件来源查找: `--patch-module` 条目 → jimage 模块镜像(41 域的 jimage!)→ `-Xbootclasspath/a` 追加路径与 classpath entries。而 **CDS 共享类**(`load_shared_class`)在这之前就拦了一道——它在 `SystemDictionary::load_instance_class` 里先查(07-04 的 :1472),归档里有的类根本不进 `ClassLoader::load_class`。注意 JDK 11 里已经没有 rt.jar——JDK 8 时代的 `loadZipJar` 与 "Bootstrap 扫描 rt.jar" 的说法都随模块化消失了,只剩 `-Xbootclasspath/a` 的追加语义(classLoader.cpp:957)。

**关键设计 (斜体)**: *"三层"里只有两层是对象,Bootstrap 是"不是加载器的加载器"——它没有 parent(实证里 platform.parent=null 正是"parent 是 bootstrap 时表现为 null"的约定,BuiltinClassLoader.java:157-158),也走不了 Java 的 loadClass。委托链到它就到头,接下来的活交给 C++。*

## 2. 双亲委派: loadClass 的五步

### 核心: 先问父,再问自己

双亲委派的全部逻辑在 `ClassLoader.loadClass(String, boolean)`(ClassLoader.java:571-607,截取核心,逐字):

```cpp
// ClassLoader.java:573-597(截取核心,逐字)
        synchronized (getClassLoadingLock(name)) {
            // First, check if the class has already been loaded
            Class<?> c = findLoadedClass(name);
            if (c == null) {
                long t0 = System.nanoTime();
                try {
                    if (parent != null) {
                        c = parent.loadClass(name, false);
                    } else {
                        c = findBootstrapClassOrNull(name);
                    }
                } catch (ClassNotFoundException e) {
                    // ClassNotFoundException thrown if class not found
                    // from the non-null parent class loader
                }

                if (c == null) {
                    // If still not found, then invoke findClass in order
                    // to find the class.
                    long t1 = System.nanoTime();
                    c = findClass(name);
```

五步: **① `getClassLoadingLock(name)` 同步**(并行能力加载器按类名锁)→ **② `findLoadedClass`**(查已加载)→ **③ 委托父**(`parent.loadClass`,递归;parent 为 null 即父是 bootstrap 时 `findBootstrapClassOrNull`)→ **④ 父也找不到才 `findClass`**(自己找)→ ⑤ resolve。`findBootstrapClassOrNull`(ClassLoader.java:1260-1267)转 native `findBootstrapClass`(:1266)——42 域的链在这里闭合: `Java_java_lang_ClassLoader_findBootstrapClass`(ClassLoader.c:217-248)→ `JVM_FindClassFromBootLoader` → hotspot 的字典与加载器。

### 安全模型: 核心类不可替换

"先问父"不是性能取舍,是**安全边界**: 任何自定义加载器请求 `java.lang.String` 时,委托链一路到 bootstrap,返回的是 JVM 里唯一的那份 String——自定义 loader 永远没有机会用自己的字节定义它。实证里最直接的一行:

```
custom.loadClass(String) == String.class: true
```

一个 `new ClassLoader(null)` 的裸加载器,loadClass 走完链后拿到的 String 与系统类完全同一(`==` 为 true,`getClassLoader()` 为 null)。定义侧的硬防护在 `preDefineClass`(ClassLoader.java:891-899): 类名以 `java.` 开头且加载器不是 Platform loader → `SecurityException: Prohibited package name`(注释: java.lang.invoke.MemberName.checkForTypeAlias 依赖 `java.*` 不可伪造)。

**关键设计 (斜体)**: *双亲委派把"加载"拆成两个角色: **发起加载器**(initiating,决定去哪找)与**定义加载器**(defining,真正定义类)。委托链保证了"先到先得"——上层能加载的,下层永远看不到;SystemDictionary 的 per-loader 字典(07-04)配合它,同一个类在整条链上只有一个定义。*

## 3. ClassLoaderData: 元数据的出生与回收

### 出生: 每个加载器一张表

每个 ClassLoader(包括"不是对象"的 bootstrap)对应一个 `ClassLoaderData`(CLD)。07-01 的 `fill_instance_klass` 里见过它的入口(`_loader_data->add_class(ik)` 把新类挂上 `_klasses` 链表)——CLD 是"这个加载器定义的所有元数据"的仓库: Klass 链表、方法、以及它们占用的 Metaspace。加载器之间的隔离(07-04 的 per-loader Dictionary)与元数据的归属(CLD)是一体两面: **字典管"名字到类",CLD 管"类到内存"**。

### 回收: do_unloading 与 keep-alive

CLD 的生死由 GC 判定。`ClassLoaderDataGraph::do_unloading`(classLoaderData.cpp:1373 起)遍历 CLD 全局链表(截取核心,逐字):

```cpp
// classLoaderData.cpp:1394-1412(截取核心,逐字)
  data = _head;
  while (data != NULL) {
    if (data->is_alive()) {
      // clean metaspace
      if (walk_all_metadata) {
        data->classes_do(InstanceKlass::purge_previous_versions);
      }
      data->free_deallocate_list();
      prev = data;
      data = data->next();
      loaders_processed++;
      continue;
    }
    seen_dead_loader = true;
    loaders_removed++;
    ClassLoaderData* dead = data;
    dead->unload();
    data = data->next();
    // Remove from loader list.
```

- **活的 CLD**: 清理 `deallocate_list`(解析失败/冗余的中间元数据,07-01 的 `_klass_to_deallocate` 就在这里被释放),类重定义时顺带 `purge_previous_versions`;
- **死的 CLD**: `unload()` 释放所有 Klass/Method 与 Metaspace,然后从链表摘除——"类卸载"在 JVM 里的实际动作就是这个;
- **`is_alive()`**(classLoaderData.cpp:696)的判定链: Java 层类加载器对象是否还活着 + 是否有 JNI 强引用 + **`_keep_alive` 计数**——注意 `_keep_alive` 不是大纲里流传的"JNI 引用"通用机制,它**专属于匿名类**(classLoaderData.cpp:285-300,注释原文: 匿名类解析期间、出现在模块修复列表期间需要保持存活;普通加载器靠 Java 层强引用,`inc/dec_keep_alive` 只对 `is_anonymous()` 生效)。Lambda 表达式生成的类就靠这个计数撑过定义窗口。

**关键设计 (斜体)**: *CLD 把"加载器"翻译成"元数据集合": GC 判断加载器对象死活,CLD 决定整批 Klass 的去留——类卸载是"一荣俱荣、一损俱损"的批量操作。匿名类的 keep-alive 计数是这个模型里唯一的例外: 没有 Java 对象可依,就自己计数保命。*

## 核心悬念

三层加载与双亲委派到此分明: 两个 BuiltinClassLoader 加一个"不是对象"的 bootstrap,loadClass 五步"锁→查→父→自→resolve",CLD 管元数据生死。但有个细节在实证里露了半张脸: `java.sql.Driver` 由 Platform 加载——**凭什么**?它也在 classpath 上吗?不是——它在 JDK 的某个模块里,而模块规定了"哪个加载器能看见哪个包"。Java 9 在双亲委派之上又加了一层: 模块的可读性与包导出。下一篇: JPMS Modules。

> → [06 — JPMS Modules](06-jpms-modules.md)
