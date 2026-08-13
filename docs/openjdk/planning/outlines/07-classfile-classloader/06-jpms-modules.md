# 06. Modules (JPMS) — Java 9 的模块化革命

> 🟡 Working | 15 KP 中的 1 个核心机制
> 读者处境: Java 8 以前——`public class` 对所有人可见。Java 9+——除非 `exports`——不可见。这是怎么实现的？
>
> ⚠️ 写作期修正(2026-08-12, vol-02/07-classfile-classloader/06 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准;本文 ~140 行):
> - **"moduleEntry.hpp:40-100" 行号漂移**: ModuleEntry 类在 :63,字段 :66-77(_module OopHandle/_pd/_loader_data/**_reads** GrowableArray/_version/_location/_can_read_all_unnamed/_has_default_read_edges/_must_walk_reads/_is_open/_is_patched)
> - **"ModuleEntry._exports: Array<PackageEntry*>" 编造**: ModuleEntry **无 _exports 字段**——导出信息在包级: PackageEntry._export_flags+_qualified_exports(packageEntry.hpp:99-107);状态查询 is_exported/is_qual_exported/has_qual_exports_list/is_exported_allUnnamed/is_unqual_exported(:134-160)
> - **"ModuleEntry._uses: Array<Klass*>" 编造**: jdk11u 无 _uses 字段(服务使用在 Java 层 ServiceLoader,hotspot 不存)
> - **"PackageEntry::is_exported_to(ModuleEntry* m)" 不存在**: 实际检查在 **Java 层**(Reflection.verifyModuleAccess,Reflection.java:203-212 → memberModule.isExported(pkg, currentModule) :212,Module.java:453);hotspot 只存数据
> - **"--add-exports → ModuleEntry::set_has_default_read_edges()→add to _reads" 错(张冠李戴)**: 真实链路=ModuleBootstrap.java:646-730(处理 :652)→Modules.addExportsToAllUnnamed(:724)→JVM_AddModuleExportsToAllUnnamed(jvm.cpp:1024-1026)→Modules::add_module_exports_to_all_unnamed→**PackageEntry::set_is_exported_allUnnamed**(packageEntry.cpp:111-123,置 PKG_EXP_ALLUNNAMED);set_has_default_read_edges 属于 **JVMTI 类重定义**场景(can_read 里的 default read edge,moduleEntry.cpp:130-136)
> - **can_read(moduleEntry.cpp:116-140)**: 无名模块读所有/所有模块读 java.base(:121-125 注释 "Unnamed modules read everyone and all modules read java.base")/JVMTI 默认读边(:130-136)/_reads 列表
> - **ModuleEntryTable : Hashtable<Symbol*, mtModule>**(moduleEntry.hpp:208)+ 静态 _javabase_module(:216,javabase_moduleEntry() :255)——模块表按名注册,java.base 特例
> - **set_exported(packageEntry.cpp:91-110)**: 已 unqual 不可转 qual(:95-96 注释 "Illegal to convert");m==NULL→未限定导出/否则 add_qexport;purge_qualified_exports 防"导出变回未导出"(:128-131 注释)
> - **字节码级模块访问检查(大纲未提)**: 链接解析时 linkResolver.cpp:310-325(IllegalAccessError+verify_class_access_msg 模块消息);加载侧模块可见性检查在 load_instance_class(07-04)
> - 悬念指向 07-javaclasses-core-mirrors.md(标题 "07. javaClasses — String/Class/Thread 的 JVM 内建镜像")✓;实证: materials/commands/07-classfile-modules.txt(java.lang exported to unnamed: true/sun.misc: false/不加 --add-exports 反射 Unsafe 抛 IllegalAccessException "module java.base does not export jdk.internal.misc to unnamed module"/加后 addressSize()=8)

### 1. ModuleEntry + PackageEntry

场景: `module java.base { exports java.lang; }`——module-info.class→ModuleEntry 对象→模块图。非导出包的 `public class`——外部模块无法访问。

**ModuleEntry**(替代原 "moduleEntry.hpp:40-100";ModuleEntry : HashtableEntry<Symbol*>,:63):
- 字段: _module(Java Module 弱句柄)/_reads(GrowableArray<ModuleEntry*>)/_is_open/_can_read_all_unnamed/_has_default_read_edges/_is_patched;无 _exports/_uses
- ModuleEntryTable : Hashtable<Symbol*>(:208)+_javabase_module(:216);can_read(moduleEntry.cpp:116-140: 无名读所有/java.base 必读/默认读边/reads 列表)
- [C++: 模块表是全局注册;java.base 是所有检查的特例]

**PackageEntry 导出控制**(替代原 "packageEntry.hpp + modules.cpp:250-450"):
- PackageEntry : HashtableEntry<Symbol*>(:97): _module/_export_flags/_qualified_exports(:99-107)
- 状态: is_exported(:134,开模块||旗帜||名单)/is_qual_exported/is_unqual_exported/is_exported_allUnnamed(:141-160);has_qual_exports_list 名单清空仍算导出(防非法回退)
- 写: set_exported(packageEntry.cpp:91-110,unqual 不可转 qual)/set_is_exported_allUnnamed(:111-123)
- --add-exports 链路: ModuleBootstrap.java:646-730→Modules.addExportsToAllUnnamed(:724)→JVM_AddModuleExportsToAllUnnamed(jvm.cpp:1024-1026)→set_is_exported_allUnnamed
- [C++: 检查在 Java 层(Reflection.verifyModuleAccess,Reflection.java:203-212→Module.isExported,Module.java:453);字节码级在 linkResolver.cpp:310-325]

### 2. Modules 与 ClassLoader

**ModuleLayer + ClassLoader**:
- 一个 ClassLoader 可加载多个模块,一个模块绑定一个定义加载器(ModuleEntry._loader_data)
- 加载侧模块可见性检查(07-04 load_instance_class);访问侧 linkResolver.cpp:310-325(IllegalAccessError+模块消息)
- 实证: 07-classfile-modules.txt(IllegalAccessException "module java.base does not export jdk.internal.misc to unnamed module" ↔ --add-exports 后成功)

---

### 核心悬念

**"`public class`——Java 9 以后不一定对外部可见。ModuleEntry + PackageEntry 在 ClassLoader 之上加了一层模块访问控制。"** — C++ 存数据(模块表/档案/包旗帜),Java 做判断。而 ModuleEntry 的 `_module` 弱句柄指向 java.lang.Module 对象——这个"Java 对象在 JVM 内部的表示"就是镜像机制。下一篇: javaClasses——核心类镜像。

> → [07-javaclasses-core-mirrors.md](07-javaclasses-core-mirrors.md)
