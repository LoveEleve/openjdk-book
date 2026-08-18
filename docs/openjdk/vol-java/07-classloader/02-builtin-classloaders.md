# 02. JDK11 内建加载器体系 — Boot/Platform/App 三层、模块化双路径

> **前置依赖**: [07-classloader/01 — 双亲委派模型](01-delegation-model.md)(loadClass 三步骤与委派链)
> → **后续**:[07-classloader/03 — 资源查找与 SPI](03-resource-spi.md)
> 关联: 内部卷 06-jpms-modules(模块图与解析)

## 三层"父母"是谁

面试"JDK9+ 类加载器有什么变化"——大多数人还停留在 JDK8 的 Bootstrap/Ext/App 三件套。JDK11 里 `sun.misc.Launcher` 已经消失,替代者是 `jdk.internal.loader` 的 **BootClassLoader / PlatformClassLoader / AppClassLoader**。三层职责怎么划分?模块化之后加载路径变成什么样?

这篇把内建加载器体系讲清楚: ClassLoaders 的三个内部类、BuiltinClassLoader 的模块+classpath 双路径、三层职责边界、以及"Bootstrap 是 null"的语义。

## 1. "JDK11 的类加载器三层是谁" — ClassLoaders 内部类

### 1.1 三个内部类

JDK11 的内建加载器定义在 `jdk/internal/loader/ClassLoaders.java`,是三个**静态内部类**,全部继承 `BuiltinClassLoader`:

```java
// ClassLoaders.java:111 + 126 + 151(截取核心,逐字)
private static class BootClassLoader extends BuiltinClassLoader { ... }

private static class PlatformClassLoader extends BuiltinClassLoader { ... }

private static class AppClassLoader extends BuiltinClassLoader { ... }
```

- **BootClassLoader**(@111):启动加载器的 Java 侧视图——`super(null, null, bcp)` 父为 null(委派链顶端);`loadClassOrNull` 委托 `JLA.findBootstrapClassOrNull`(VM 查询)
- **PlatformClassLoader**(@126):平台加载器
- **AppClassLoader**(@151):应用加载器——`ClassLoader.getSystemClassLoader()`(`ClassLoader.java:1928`)返回的就是它

### 1.2 历史对照:Extension 的退场

| | JDK8 | JDK11 |
|---|---|---|
| 顶层 | Bootstrap(原生) | BootClassLoader(Java 侧视图) |
| 中层 | **ExtClassLoader**(ext 目录) | **PlatformClassLoader**(平台模块) |
| 底层 | Launcher.AppClassLoader | AppClassLoader |

**JDK9+ 移除了 Extension 加载器**: ext 目录机制(任意 jar 塞进 ext 就全局生效)太容易被滥用;PlatformClassLoader 职责收缩为"加载平台模块",不再有可配置的 ext 路径。classpath 逻辑全部由 AppClassLoader 承担。

关键设计(斜体):*Extension→Platform 是"重命名 + 职责收缩": 可扩展目录(危险)变成只读平台模块(受控)。面试答"JDK9 前后变化": 三层变三层(名字变了)+ 模块化加载路径——能说出"Ext 没了,Platform 顶上"就超过背结论的。*

## 2. "BuiltinClassLoader 怎么加载" — 模块路径 + 类路径双路径

### 2.1 loadClassOrNull:模块优先

`BuiltinClassLoader.loadClassOrNull`(`BuiltinClassLoader.java:590` 起)是第 1 篇 loadClass 的 JDK11 版本——多了一步模块查询:

```java
// BuiltinClassLoader.java:590-625(截取核心,逐字)
protected Class<?> loadClassOrNull(String cn, boolean resolve) {
    synchronized (getClassLoadingLock(cn)) {
        // check if already loaded
        Class<?> c = findLoadedClass(cn);

        if (c == null) {

            // find the candidate module for this class
            LoadedModule loadedModule = findLoadedModule(cn);
            if (loadedModule != null) {

                // package is in a module
                BuiltinClassLoader loader = loadedModule.loader();
                if (loader == this) {
                    if (VM.isModuleSystemInited()) {
                        c = findClassInModuleOrNull(loadedModule, cn);
                    }
                } else {
                    // delegate to the other loader
                    c = loader.loadClassOrNull(cn);
                }

            } else {

                // check parent
                if (parent != null) {
                    c = parent.loadClassOrNull(cn);
                }

                // check class path
                if (c == null && hasClassPath() && VM.isModuleSystemInited()) {
                    c = findClassOnClassPathOrNull(cn);
                }
            }
        }
        ...
```

流程:

1. **查缓存**:`findLoadedClass`(与第 1 篇相同)
2. **模块查询**:`findLoadedModule(cn)`——按类名所属包查"哪个已加载模块拥有这个包"。命中模块 → 模块归属的加载器加载(`findClassInModuleOrNull` 或委派给该加载器)——**模块侧不走传统双亲委派,走模块图解析**
3. **未命中模块 → 回退 classpath 双亲委派**:`parent.loadClassOrNull` → 自己 `findClassOnClassPathOrNull`(@621)

### 2.2 defineClass 的两条路径

`defineClass` 也有两个版本(`BuiltinClassLoader.java:729`/`779`):

- 模块中的类 → `defineClass(cn, LoadedModule)`(@729,带模块上下文)
- classpath 中的类 → `defineClass(cn, Resource)`(@779,读文件字节)

### 2.3 过渡态

JDK11 是"模块与 classpath 共存"的过渡态: **java.* 等 JDK 模块走模块图解析,第三方 classpath 仍走双亲委派**。`java.util.List` 由 BootClassLoader 的模块路径加载(jimage 镜像),`com.app.Main` 由 AppClassLoader 的 classpath 加载。

关键设计(斜体):*模块化加载 = 先查"类属于哪个模块"再加载——模块比 classpath 更结构化(包归属固定,冲突在编译/启动期就暴露);但非模块化 classpath 类仍按双亲委派。面试"模块化后还需要双亲委派吗": 类路径侧依然需要,模块侧按模块图解析——答出"双轨共存"才是 JDK11 的真相。*

跨层标注: [内部卷: 06-jpms-modules(模块图与解析);C++: java_lang_ClassLoader 的 JVM 侧结构]

## 3. "三层各自加载什么" — 职责边界

### 3.1 三层职责

模块→加载器的分派是**构建期列表制**(`jdk/internal/module/ModuleLoaderMap.mappingFunction`,`ModuleLoaderMap.java:92-114`): 模块名命中构建期生成的 BOOT_MODULES/PLATFORM_MODULES 列表分别归 Boot/Platform,**其余所有模块(含 jdk.* 和第三方)归 App**:

```
BootClassLoader(启动)     java.base 等启动模块(构建期 BOOT_MODULES 列表)——java.* 核心全在这(被委派保护,不可覆盖)
PlatformClassLoader(平台)  java.sql/java.xml/java.management 等平台模块(构建期 PLATFORM_MODULES 列表)
AppClassLoader(应用)       jdk.* 模块 + classpath(-cp/-jar) + 模块路径的应用模块;getSystemClassLoader 指向它
```

注意一个反直觉点: **jdk.\* 模块(如 jdk.management、jdk.jfr)默认由 AppClassLoader 加载**——平台列表只含 java.* 前缀的模块,不要凭名字前缀猜归属。

委派链:**App → Platform → Boot(null parent)**。

### 3.2 排查方法论

生产 `ClassNotFoundException` 排查两步: **① 判断类应该在哪层**(java.* → Boot;javax.sql/java.sql → Platform;业务包 → App)→ **② 检查该层的加载路径**(App 层的 `-cp` 内容、Boot 层的模块是否缺失)。"类所属层 + 该层路径"是标准排查框架。

**同包类归属**: 应用代码里写 `java.util.Xxx` 一定被 Boot 抢先加载——自定义类试图冒充 java.* 无效(委派方向决定了核心包不可覆盖)。`-Djava.system.class.loader=com.Xxx` 可以替换系统加载器(框架隔离常用)。

关键设计(斜体):*委派方向 = 安全边界: 越核心的包越早被高层加载,应用代码无法冒充 java.*。排查 ClassNotFound 的标准动作: 类所属层 + 该层路径,而不是盲目加依赖。*

## 4. "Bootstrap 加载器是 null" — 启动加载器语义

### 4.1 VM 实现,不在 Java 层建模

启动加载器**由 VM 实现,不是 Java 类**——所以 `String.class.getClassLoader()` 返回 null: 没有 Java 对象可以返回。Java 侧访问启动加载器功能的主要入口是 `jdk/internal/loader/BootLoader`(`BootLoader.java:56`)——提供 jimage 路径查询(`BootLoader.java:135` 的 `findResource`)等只读操作。

### 4.2 null 的双重含义

`ClassLoader.getParent()` 返回 null = "我是委派链顶端"(启动加载器之上无父)。与 `getClassLoader()` 的 null 含义一致: **"由 VM 直接加载,不在 Java 层建模"**。

面试标准答案: "为什么 String 的 classLoader 是 null"——Bootstrap 是 VM 内建,不在 Java 层建模;它加载 java.base 模块的类。

关键设计(斜体):*null 的双重含义: "没有父"与"由 VM 直接加载"——这不是 bug,是"VM 内建实体在 Java 层没有对象"的自然结果。面试答出"Bootstrap 不是 Java 类,Java 侧用 BootLoader 查询"就完整了。*

## 核心悬念

类找到了,但**资源怎么找**?`getResource` 走的也是双亲委派——但 SPI 场景(JDBC/ServiceLoader)委派方向反了: 由 Bootstrap 加载的 `java.sql.Driver` 接口,要用 App 加载器里的 MySQL 驱动实现类——**谁去加载它**?线程上下文加载器(Thread Context ClassLoader)就是为打破"委派方向死锁"而生的。下一篇: 资源查找与 SPI。

> → [07-classloader/03 — 资源查找与 SPI](03-resource-spi.md)
