# 域 07: 类加载器与链接 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "双亲委派模型(三步)/为什么安全" — 01 篇 §1(ClassLoader.java:571/574/576/581/594)
- [x] "findClass vs defineClass / 自定义加载器" — 01 篇 §2(723/806/1122)
- [x] "类加载锁 / 两个加载器加载同一个类" — 01 篇 §3(669, 命名空间)
- [x] "JDK9+ 类加载器变化(PlatformClassLoader)" — 02 篇 §1(ClassLoaders.java:111/126/151)
- [x] "为什么 String 的 classLoader 是 null" — 02 篇 §4(BootLoader.java:56)
- [x] "模块化后怎么加载(双路径)" — 02 篇 §2(BuiltinClassLoader.java:590/615/621)
- [x] "双亲委派为什么被破坏/SPI" — 03 篇 §3(Thread.java:167/1482/1515)
- [x] "热部署原理/类隔离" — 03 篇 §4

## 身份 2: 生产工程师
- [x] ClassNotFoundException 排查(类属于哪层+路径) — 02 篇 §3
- [x] jar 冲突(NoSuchMethodError/classpath 顺序) — 03 篇 §2
- [x] SPI 加载不到实现类 — 03 篇 §3
- [x] 线程池 contextClassLoader 污染 — 03 篇 §3

## 身份 3: 框架工程师
- [x] 自定义加载器(加密/热部署)— 01 篇 §2/03 篇 §4
- [x] Tomcat 类隔离/OSGi — 03 篇 §4
- [x] -Djava.system.class.loader 替换 — 02 篇 §3
- [x] ServiceLoader/SPI 机制 — 03 篇 §3

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 ClassLoader.java:243/571/574/576/581/594/669/723/806/1122/1283/1397/1463/1928, ClassLoaders.java:53/111/126/151, BuiltinClassLoader.java:576/590/602/615/621/680, BootLoader.java:56, URLClassPath.java:291/310/368/702/1205, Thread.java:167/1482/1515)/关键设计/跨层([内部卷]/[JVM Spec]/[C++])/核心悬念+OUTBOUND
- [x] 无文字描述源锚(自查 grep 通过)
- [x] 域发现 v2 已同步: sun/misc/Launcher(JDK8)→jdk/internal/loader/ClassLoaders(JDK11)

## 身份 5: 完整性缺口检查
- [x] 委派模型(01)/内建三层(02)/资源与 SPI(03)三篇覆盖域全部面试主战场
- [x] Loader/Resource/ClassLoaderValue(🟢 Surface)未单独成篇,KP 注明
- [x] 链接(verify/prepare/resolve)细节归内部卷,本域只讲 Java 层契约
- [x] 未覆盖确认: 模块化 API(java.lang.module 使用层)——面试低频,域 05 已并入反射篇提及
- [x] 二次 review 修正: DriverManager 属 java.sql 模块(Platform 加载器),非 java.base;getClassLoadingLock 细粒度锁实为 parallelLockMap putIfAbsent(669-676,registerAsParallelCapable:1623);JarLoader 确认保留 JarIndex 支持(705/762/827)+JarFile 缓存(742/808);java.system.class.loader 属性实测存在(1873/1912);JVM Spec §5.3-5.5 加载/链接/初始化章节核实
- [x] KP 修正: loadClass findClass 585→594、defineClass1→defineClass2 native(1122)、findLoadedClass0(1289)
- [ ] 待办: 02 篇 §2 的模块查询细节(findClassOnModulePath 路径)、03 篇 §2 的 JarLoader jar 索引机制写作时对照 URLClassPath 实际实现(大纲只引用类名+行号)
