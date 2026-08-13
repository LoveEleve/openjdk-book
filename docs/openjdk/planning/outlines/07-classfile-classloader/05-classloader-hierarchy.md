# 05. ClassLoader — 双亲委派与三层加载

> 🟡 Working | 15 KP 中的 2 个机制
> 读者处境: `Class.forName("com.example.Foo")`——JVM 怎么知道去哪找 Foo.class？委托链。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/07-classfile-classloader/05 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准;本文 ~150 行):
> - **"三层 ClassLoader 层次(classLoader.cpp:100-500)" 错**: 三层在 **Java 层**(jdk/internal/loader/ClassLoaders.java: PlatformClassLoader :126/AppClassLoader :151,都是 BuiltinClassLoader 子类;platformClassLoader() :96/appClassLoader() :103);**bootstrap 不是 ClassLoader 实例**(getClassLoader()==null,实证 platform.parent==null 即"父是 bootstrap"约定,BuiltinClassLoader.java:157-158);C++ 侧 ClassLoader::load_class(classLoader.cpp:1406)是 bootstrap 的实现
> - **"load_class: 1) find_loaded_class→2) parent->load_class→3) find_class" 错(JDK 8 的 C++ 流程)**: 双亲委派在 **Java 层 ClassLoader.loadClass**(ClassLoader.java:571-607): getClassLoadingLock 同步→findLoadedClass→parent.loadClass 或 findBootstrapClassOrNull→findClass→resolve;BuiltinClassLoader.loadClassOrNull(:590-634)是模块化变体(模块优先→parent→classpath)
> - **"load_classfile()/loadZipJar() 不存在"**(JDK 8 名字): **JDK 11 无 rt.jar**(模块化),只剩 -Xbootclasspath/a 追加(classLoader.cpp:957);ClassLoader::load_class 顺序=patch-module→jimage(41 域)→bootclasspath/a+classpath;**CDS load_shared_class 在 SystemDictionary::load_instance_class(:1472)先拦**(07-04 已见)
> - **"ClassLoaders::platformClassLoader()" C++ 名错**: ClassLoaders 是 Java 类;hotspot 用 SystemDictionary::is_platform_class_loader(systemDictionary.hpp:662)
> - **"_keep_alive: JNI reference to Java ClassLoader" 错**: _keep_alive **专属于匿名类**(classLoaderData.cpp:285-300 注释: 匿名类解析期间/模块修复列表期间保持存活;inc/dec_keep_alive 只对 is_anonymous() 生效 :295/:302);普通加载器靠 Java 层强引用
> - **CLD 真实生命周期**(大纲简化): _klasses 链表(add_class,06-03/07-01 讲过);ClassLoaderDataGraph::do_unloading(classLoaderData.cpp:1373): is_alive(:696)→free_deallocate_list+purge_previous_versions/死→**unload()**+链表移除(:1394-1412)
> - **安全模型**: preDefineClass(ClassLoader.java:891-899): 类名以 java. 开头且加载器**非 Platform**→SecurityException "Prohibited package name"(注释: MemberName.checkForTypeAlias 依赖 java.* 不可伪造)——防护权在 Platform 不在 bootstrap
> - findBootstrapClassOrNull(ClassLoader.java:1260-1267)→native findBootstrapClass(:1266)→Java_java_lang_ClassLoader_findBootstrapClass(ClassLoader.c:217-248)→JVM_FindClassFromBootLoader(42-03 链)
> - 悬念指向 06-jpms-modules.md ✓;实证: materials/commands/07-classfile-loader-hierarchy.txt(app=AppClassLoader/platform=PlatformClassLoader/app.parent=platform/platform.parent=null/String.loader=null/java.sql.Driver=Platform/custom.loadClass(String)==String.class true)

### 1. 双亲委派 — Bootstrap → Platform → App

场景: App ClassLoader 收到加载 `java.lang.String` 的请求——自己加载？不——`parent.loadClass(name)`→Platform→再向上→Bootstrap——Bootstrap 在 modules 中找到 String→返回之前加载的 Klass*。

**三层 ClassLoader 层次**(替代原 "classLoader.cpp:100-500"):
- Java 层: ClassLoaders.java(PlatformClassLoader :126/AppClassLoader :151,都继承 BuiltinClassLoader;platformClassLoader :96/appClassLoader :103);bootstrap 不是对象(getClassLoader()==null)
- C++ 侧: ClassLoader::load_class(classLoader.cpp:1406)=bootstrap 实现(patch-module→jimage→bootclasspath/a+classpath;无 rt.jar/loadZipJar);CDS 在 SystemDictionary::load_instance_class(:1472)先拦
- 实证: 07-classfile-loader-hierarchy.txt(app.parent=platform/platform.parent=null/String=null loader)

**双亲委派实现**(替代原 "classLoader.cpp:100-200"):
- ClassLoader.loadClass(ClassLoader.java:571-607): 锁(getClassLoadingLock)→findLoadedClass→parent.loadClass/findBootstrapClassOrNull→findClass→resolve
- BuiltinClassLoader.loadClassOrNull(:590-634): 模块优先→parent→classpath(JDK 9+ 变体)
- 安全: preDefineClass(ClassLoader.java:891-899)禁非 Platform 定义 java.*;委托链保证核心类不可替换
- [C++: findBootstrapClassOrNull(ClassLoader.java:1260-1267)→native→Java_java_lang_ClassLoader_findBootstrapClass(ClassLoader.c:217-248)→JVM_FindClassFromBootLoader]

### 2. ClassLoaderData — 元数据生命周期

**CLD GC**(替代原 "classLoaderData.cpp:100-300"):
- _klasses 链表(add_class 挂链,06-03/07-01 讲过);per-loader 仓库(Klass/Method/Metaspace)
- do_unloading(classLoaderData.cpp:1373): is_alive(:696)→free_deallocate_list/死→unload()+链表移除(:1394-1412)
- _keep_alive(classLoaderData.cpp:149,:285-300)=**匿名类专用**(inc/dec 只对 is_anonymous);普通加载器靠 Java 层强引用
- [C++: 字典管"名字到类",CLD 管"类到内存"——一荣俱荣的批量卸载]

---

### 核心悬念

**"为什么 `Class.forName("java.lang.String")` 不会从 App loader 加载？"** — 双亲委派——先问父 loader。Bootstrap 已加载 String→返回已有 Klass*。这是 Java 安全模型的基石——核心类不可替换。而 `java.sql.Driver` 由 Platform 加载的"凭什么"答案是模块: 模块规定了哪个加载器能看见哪个包。下一篇: Modules——Java 9 在 ClassLoader 之上加了模块访问控制。

> → [06-jpms-modules.md](06-jpms-modules.md)
