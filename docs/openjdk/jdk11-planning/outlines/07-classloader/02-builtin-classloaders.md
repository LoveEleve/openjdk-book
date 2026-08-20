# 02. JDK11 内建加载器体系 — Boot/Platform/App 三层、模块化双路径

> 🔴 Deep | 域 07 类加载器第 2 篇 | Layer 2
> 读者处境: 面试"JDK9+ 类加载器有什么变化"——新增 PlatformClassLoader、模块化影响;生产 ClassNotFoundException 排查要知道类从哪层加载。

### 1. "JDK11 的类加载器三层是谁？" — ClassLoaders 内部类

场景: `ClassLoader.getSystemClassLoader()` 返回什么?三层加载器怎么初始化的?

- `jdk/internal/loader/ClassLoaders.java` — 三个内部类(BootClassLoader 111/PlatformClassLoader 126/AppClassLoader 151),全部 extends BuiltinClassLoader
- `ClassLoader.java:1928` `getSystemClassLoader()` → 返回 `ClassLoaders.AppClassLoader`(经 VM 初始化传递)
- 历史对照: JDK8 是 Bootstrap(原生)/ExtClassLoader/sun.misc.Launcher.AppClassLoader——**JDK9+ 移除了 Extension 加载器**,新增 PlatformClassLoader
- 关键设计 (斜体): *Extension→Platform 的重命名与职责收缩: Extension 加载 ext 目录(易被滥用),Platform 加载平台模块;JDK11 的 classpath 逻辑全部由 AppClassLoader(BuiltinClassLoader)承担*
- 面试: "JDK9 前后类加载器变化"——三层变三层(名字变了)+ 模块化加载路径

### 2. "BuiltinClassLoader 怎么加载？" — 模块路径 + 类路径双路径

场景: `Class.forName("java.util.List")` 与 `Class.forName("com.app.Main")` 走的路一样吗?

- `BuiltinClassLoader.java:590` `loadClassOrNull`: ① 模块查询(已定义模块的类→直接返回,`602` 附近)② `parent.loadClassOrNull`(615,委派)③ `findClassOnClassPathOrNull`(621,自己的 classpath)
- `defineClass`(`BuiltinClassLoader.java:680`)— 模块中类走 defineClass(带模块上下文)
- BootClassLoader 的模块: java.base 等启动模块(从 jimage 读取)
- 关键设计 (斜体): *模块化加载 = 先查"类属于哪个模块"再加载——模块比 classpath 更结构化(包归属固定);但非模块化 classpath 类仍按双亲委派;JDK11 是"模块与 classpath 共存"的过渡态*
- 面试: "模块化后还需要双亲委派吗?"——类路径侧依然需要;模块侧按模块图解析
- [内部卷: 06-jpms-modules(模块图与解析);C++: java_lang_ClassLoader 的 JVM 侧结构]

### 3. "三层各自加载什么？" — 职责边界

场景: 生产 ClassNotFoundException 排查——先判断类应该在哪层

- BootClassLoader(启动): `java.base` 等 JDK 模块——java.* 全在这(被委派保护,不可覆盖)
- PlatformClassLoader(平台): java.sql/java.xml/java.management 等平台模块、jdk.* 模块、`--limit-modules`
- AppClassLoader(应用): classpath(-cp/-jar)、模块路径的应用模块;`getSystemClassLoader` 指向它
- 委派链: App → Platform → Boot(null parent)
- 关键设计 (斜体): *委派方向决定了"同包类归属": 应用代码里写 java.util.Xxx 一定被 Boot 抢先——自定义类试图冒充 java.* 无效(域 01 曾讲的安全隔离);排查 ClassNotFound: 类所属层 + 该层加载路径(-cp 内容)*
- 生产: `-Djava.system.class.loader=com.Xxx` 可替换系统加载器(框架 Tomcat 类隔离常用)
- [内部卷: 06-jpms-modules(平台模块划分)]

### 4. "Bootstrap 加载器是 null" — 启动加载器语义

场景: `String.class.getClassLoader()` 为什么返回 null?

- 启动加载器由 **VM 实现**(非 Java 类),Java 侧用 `BootLoader`(`jdk/internal/loader/BootLoader.java:56`)提供查询入口(jimage 路径等)
- `ClassLoader.getParent()` 返回 null = "我是委派链顶端"(启动加载器之上无父)
- 关键设计 (斜体): *null 的双重含义: "没有父"与"由 VM 直接加载"——面试"为什么 String 的 classLoader 是 null"的标准答案: Bootstrap 是 VM 内建,不在 Java 层建模*
- 面试: "哪些类由 Bootstrap 加载?"——java.base 模块类(启动前已预加载/按需)
- [内部卷: 07-classfile-classloader(启动类加载流程 jimage)]

---

### 核心悬念

类找到了,但**资源怎么找**?`getResource` 走的也是双亲委派——但 SPI 场景(JDBC/ServiceLoader)委派方向反了: 由 Bootstrap 加载的接口要用 App 加载的实现类,谁去加载?——线程上下文加载器与 URLClassPath 的 JarLoader 是怎么搜 jar 的?

> → [03-resource-spi.md](03-resource-spi.md)
