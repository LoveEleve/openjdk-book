# 06. JPMS Modules — Java 9 的模块化革命

> **前置依赖**:[07-classfile-classloader/05 — ClassLoader](openjdk/vol-02/07-classfile-classloader/05-classloader-hierarchy.md):`java.sql.Driver` 由 Platform 加载的"凭什么"在这里回答;[07-classfile-classloader/01 — ClassFile 解析](openjdk/vol-02/07-classfile-classloader/01-classfile-parser.md):module-info.class 的 ACC_MODULE 与模块属性
> → **后续**:[07 — javaClasses](07-javaclasses-core-mirrors.md)(核心类镜像)
> 关联域: 06-oops(对象模型)、07-classfile-classloader(类加载)、30-jvm-entry(启动时模块系统初始化)

## public 不再是"对所有人可见"

Java 8 及以前,`public class` 意味着任何人都能 new、能反射。Java 9 的模块系统给可见性加了第二道闸门: 类还得在**导出到你的模块**的包里。这一篇拆模块的存储与检查: 模块表与模块条目、包的导出控制(旗帜与名单)、以及 `--add-exports` 这条"走后门"的完整链路。

## 1. 模块表: 谁在图上

### ModuleEntryTable: 一张模块表,一个 java.base 特例

模块按加载器注册: 每个 `ClassLoaderData` 持有一张 `ModuleEntryTable : Hashtable<Symbol*, mtModule>`(classLoaderData.hpp:252,注释 "The modules defined by the class loader";moduleEntry.hpp:208)——key 是模块名。每个表有一个**静态的 java.base 条目**(`_javabase_module`,moduleEntry.hpp:216),在启动早期就预置好(moduleEntry.hpp:198-206 注释: 模块系统初始化前加载的类,它们的 PackageEntry 要能指向 java.base)——模块系统的心脏,很多检查以它为特例(见 §3 的 can_read)。

### ModuleEntry: 模块的"档案"

每个模块一个 `ModuleEntry : HashtableEntry<Symbol*, mtModule>`(moduleEntry.hpp:63)。流传说法里的 "_exports 字段"并不存在——**导出信息不在这里**,它属于包(§2)。档案的字段是(moduleEntry.hpp:65-77,截取核心,逐字):

```cpp
// moduleEntry.hpp:65-77(截取核心,逐字)
  OopHandle _module;                   // java.lang.Module
  OopHandle _pd;                       // java.security.ProtectionDomain, cached
                                       // for shared classes from this module
  ClassLoaderData* _loader_data;
  GrowableArray<ModuleEntry*>* _reads; // list of modules that are readable by this module
  Symbol* _version;                    // module version number
  Symbol* _location;                   // module location
  bool _can_read_all_unnamed;
  bool _has_default_read_edges;        // JVMTI redefine/retransform support
  bool _must_walk_reads;               // walk module's reads list at GC safepoints to purge out dead modules
  bool _is_open;                       // whether the packages in the module are all unqualifiedly exported
  bool _is_patched;                    // whether the module is patched via --patch-module
```

- **`_module`**: Java 层 `java.lang.Module` 对象的弱句柄——hotspot 的 ModuleEntry 与 Java 的 Module 是一体两面(07 篇的镜像机制会再见到这种模式);
- **`_reads`**: 可读模块列表;`_is_open`: open 模块的所有包无条件导出;`_can_read_all_unnamed`/`_has_default_read_edges`: 两个特例开关(无名模块与 JVMTI 重定义);
- **没有 `_exports`、没有 `_uses`**: 服务使用(ServiceLoader)不在这里存;导出在包级。

**关键设计 (斜体)**: *"模块导出"的信息粒度是包,不是模块——`exports com.foo.api` 是包级声明,一个模块里可以同时有导出的公开 API 包和不导出的内部包。所以档案拆成两层: 模块记"读谁",包记"被谁读"。*

## 2. 导出控制: 旗帜与名单

### PackageEntry: 每个包两个"旗帜"加一张名单

`PackageEntry : HashtableEntry<Symbol*, mtModule>`(packageEntry.hpp:97)知道三件事: 属于哪个模块(`_module`)、导出方式(`_export_flags`)、限定导给谁(`_qualified_exports` 列表)。导出状态查询(packageEntry.hpp:134-160,截取核心,逐字):

```cpp
// packageEntry.hpp:134-160(截取核心,逐字)
  bool is_exported() const { // qualifiedly or unqualifiedly exported
    assert_locked_or_safepoint(Module_lock);
    return module()->is_open() ||
            ((_export_flags & PKG_EXP_UNQUALIFIED_OR_ALL_UNAMED) != 0) ||
            has_qual_exports_list();
  }
  // Returns true if the package has any explicit qualified exports or is exported to all unnamed
  bool is_qual_exported() const {
    assert_locked_or_safepoint(Module_lock);
    return (has_qual_exports_list() || is_exported_allUnnamed());
  }
  // Returns true if there are any explicit qualified exports.  Note that even
  // if the _qualified_exports list is now empty (because the modules that were
  // on the list got gc-ed and deleted from the list) this method may still
  // return true.
  bool has_qual_exports_list() const {
    assert_locked_or_safepoint(Module_lock);
    return (!is_unqual_exported() && _qualified_exports != NULL);
  }
```

- **`is_exported`**: 开模块 || 未限定/对全部无名模块导出 || 有限定名单——三个条件任一;
- **`has_qual_exports_list` 的注释很有味道**: 即使名单里的模块都被 GC 清了、列表空了,也算"曾经导出过"——防止包从"导出"非法变回"未导出"(包的导出状态只能单向加强);
- 写操作是 `set_exported`(packageEntry.cpp:91-110): 已未限定导出的包**不允许**再转限定导出(注释 "Illegal to convert"),`m==NULL` 表示未限定导出,否则把模块加进限定名单。

### --add-exports: 一条走后门的路

JDK 内部包(sun.misc 等)默认不导出,最常用的合法访问途径是 `--add-exports`(另有 `--add-opens` 打开深层反射、`--patch-module` 给模块打补丁)。全链路: **Java 层解析**(ModuleBootstrap.java:646-730 处理 `--add-exports`/`--add-opens`,调用 `Modules.addExportsToAllUnnamed` :724)→ **JNI**(`JVM_AddModuleExportsToAllUnnamed`,jvm.cpp:1024-1026)→ **Modules::add_module_exports_to_all_unnamed** → `PackageEntry::set_is_exported_allUnnamed`(packageEntry.cpp:111-123,把 `_export_flags` 置为 `PKG_EXP_ALLUNNAMED`)。注意流传的"`--add-exports` 会设置 `set_has_default_read_edges`"是张冠李戴——那个开关属于 **JVMTI 类重定义**场景(can_read 里的 default read edge,moduleEntry.cpp:130-136),与导出无关。

[实证] 的两行输出把导出的"有无"与错误消息都钉死了(materials/commands/07-classfile-modules.txt):

```
=== without ===
Unsafe call failed: IllegalAccessException: class ModDemo3 cannot access class
jdk.internal.misc.Unsafe (in module java.base) because module java.base does not
export jdk.internal.misc to unnamed module @3ed71992
=== with --add-exports ===
Unsafe.addressSize() = 8 (without add-exports)
```

同一个反射调用,`--add-exports java.base/jdk.internal.misc=ALL-UNNAMED` 前后,从 `IllegalAccessException`(错误消息逐字写明 "module java.base does not export jdk.internal.misc to unnamed module")变成正常返回——而查询侧也能直接看到导出状态(`java.lang exported to unnamed: true`、`sun.misc exported to unnamed: false`)。

**关键设计 (斜体)**: *导出是"旗帜+名单"两态: 未限定导出(旗帜)对所有模块生效;限定导出(名单)只对点名模块生效;开模块(module-info 里 open)直接让所有包变未限定。状态只能单向变强(不能收回),这是模块系统"兼容性优先、安全逐步收紧"的体现。*

## 3. 可读性与访问检查: 数据在 C++,判断在 Java

### can_read: 两条特例在前

模块可读性检查的 C++ 侧是 `ModuleEntry::can_read`(moduleEntry.cpp:116-140,截取核心,逐字):

```cpp
// moduleEntry.cpp:116-127(截取核心,逐字)
bool ModuleEntry::can_read(ModuleEntry* m) const {
  assert(m != NULL, "No module to lookup in this module's reads list");

  // Unnamed modules read everyone and all modules
  // read java.base.  If either of these conditions
  // hold, readability has been established.
  if (!this->is_named() ||
      (m == ModuleEntryTable::javabase_moduleEntry())) {
    return true;
  }

  MutexLocker m1(Module_lock);
```

- **无名模块读所有**(classpath 上的代码可以读一切);
- **所有模块读 java.base**(模块系统的公理——java.base 是唯一"被所有人依赖"的模块);
- 之后才查 `_reads` 列表,以及 JVMTI 重定义的默认读边(:130-136)。

### 真正的检查在 Java 层

hotspot 的 ModuleEntry/PackageEntry 是**存储**,判断动作在 Java 层: 反射访问走 `Reflection.verifyModuleAccess`(jdk/internal/reflect/Reflection.java:203-212)→ `memberModule.isExported(pkg, currentModule)`(:212,Module.java:453)——[实证] 里那条 IllegalAccessException 就是这里抛的。字节码层面的跨模块访问则在链接解析时检查(`linkResolver.cpp:310-325`: 类访问检查抛 `IllegalAccessError`,错误消息带模块信息 `verify_class_access_msg`);加载侧另有一道模块可见性检查(07-04 的 `load_instance_class`: 包属于哪个模块、模块是否定义给当前加载器)。

**关键设计 (斜体)**: *模块系统的分工很清晰: **C++ 存数据**(模块表/模块档案/包旗帜),**Java 做判断**(反射检查、加载时的模块可见性)。这也是为什么模块信息要同时在两个世界存在——ModuleEntry 与 java.lang.Module 对象互为镜像(moduleEntry.hpp:67 的 `_module` 弱句柄)。*

## 核心悬念

模块的三件事到齐: 模块表与档案(_reads/_is_open,没有 _exports——导出在包级)、PackageEntry 的旗帜与名单(单向加强的导出状态)、can_read 的特例与 Java 层的检查。但你大概注意到了那个反复出现的词: **镜像**——hotspot 的 ModuleEntry 握着 java.lang.Module 的弱句柄,而 java.lang.Module 对象本身、String 对象、Class 对象……这些"Java 层对象"在 JVM 内部是怎么表示的?下一篇: javaClasses——核心类镜像。

> → [07 — javaClasses](07-javaclasses-core-mirrors.md)
