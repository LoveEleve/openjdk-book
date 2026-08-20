# JDK 11 内置类加载器：三层边界与模块/类路径双轨

> 本文基于 JDK 11 `java.base` 的 `ClassLoaders`、`BuiltinClassLoader`、`BootLoader` 和 `ClassLoader` 实现。Boot / Platform / App 的初始化、模块优先路径和 `BootLoader` 都是 JDK 11 当前实现事实；JDK 8 的 Bootstrap / Ext / App 只作为历史对照。模块图和启动镜像的更深层实现不在本文展开。本文讨论的是 JDK 11 内建加载器的 Java 层分工，不把这里的三层关系、模块优先路径和 Boot 侧 Java 视图外推成所有 JVM 或所有类加载体系都必须遵守的统一规范。
> **前置依赖**：[双亲委派与类加载流程](01-delegation-model.md)
> **后续**：[资源查找与 SPI](03-resource-spi.md)

## JDK 9+ 改掉的不是“三层”，而是中间层的权力边界

很多人回答 JDK 9+ 类加载器变化时，会把 JDK 8 的三件套背出来：Bootstrap、Ext、App。然后再说“Ext 改名成 Platform”。这句话看似对，实际上漏掉了最重要的变化。

JDK 8 的 ExtClassLoader 代表一种很宽松的扩展方式：把 jar 放进约定的 `ext` 目录，就可能进入一条全局可见的加载路径。它方便，但也让“谁能把代码塞进 JDK 的扩展世界”变得模糊。

模块化之后，JDK 不再希望用一个可随意投放 jar 的目录表达平台边界。于是 JDK 11 仍然保留三层加载关系，却把中间层收紧成了受控的平台模块：

```text
JDK 8：Bootstrap → ExtClassLoader → AppClassLoader
JDK 11：Boot       → PlatformClassLoader → AppClassLoader
```

注意，这不是简单换名字：

- **Boot** 仍然代表最核心的 VM 侧加载边界。
- **Platform** 不再是“某个目录里随便放扩展 jar”，而是平台模块的受控加载层。
- **App** 继续是应用侧入口，但它在 JDK 11 里不只处理 classpath，还要处理应用模块。

这篇要解开的核心问题是：**JDK 11 如何在三层委派关系不变的情况下，把模块世界和传统 classpath 世界同时装进去？**

## 一、系统类加载器为什么是 App，而不是最顶层

### 先排除一个常见的名字误导

“系统类加载器”听起来像是整个 JVM 最核心的那个加载器。于是很多人会顺手把它等同于 Bootstrap，或者认为 `ClassLoader.getSystemClassLoader()` 应该返回最顶层。

事实相反：系统类加载器是应用程序默认使用的入口。它要负责找到应用的主类、classpath 上的业务类，并参与应用模块加载，所以它天然位于委派链的下方。

JDK 11 的初始化代码先创建 Boot，再创建 Platform，最后创建 App：

```java
// ClassLoaders.java:53-78
private static final BootClassLoader BOOT_LOADER;
private static final PlatformClassLoader PLATFORM_LOADER;
private static final AppClassLoader APP_LOADER;

static {
    String append = VM.getSavedProperty("jdk.boot.class.path.append");
    BOOT_LOADER =
        new BootClassLoader((append != null && !append.isEmpty())
            ? new URLClassPath(append, true)
            : null);
    PLATFORM_LOADER = new PlatformClassLoader(BOOT_LOADER);

    String cp = System.getProperty("java.class.path");
    if (cp == null || cp.isEmpty()) {
        String initialModuleName = System.getProperty("jdk.module.main");
        cp = (initialModuleName == null) ? "" : null;
    }
    URLClassPath ucp = new URLClassPath(cp, false);
    APP_LOADER = new AppClassLoader(PLATFORM_LOADER, ucp);
}
```

父子关系从这段构造顺序已经能看出来：

```text
AppClassLoader
   parent → PlatformClassLoader
                 parent → BootClassLoader / VM 边界
```

`getSystemClassLoader()` 的语义也是“返回默认应用入口”，不是“返回整个加载器树的根”：

```java
// ClassLoader.java:1928
public static ClassLoader getSystemClassLoader() {
```

它的名字来自应用视角：当前 Java 程序默认用谁找自己的类和资源，而不是谁负责加载 `java.lang.String`。

### `java.system.class.loader` 只替换应用入口

JDK 11 还允许通过 `-Djava.system.class.loader=...` 指定一个自定义系统类加载器。这个机制更能说明系统加载器的层级：JDK 会用默认系统加载器加载指定类，再把默认系统加载器作为构造器参数传给它，让它成为新的应用侧入口。

它改变的是 App 这一层的实现，不是把 Boot 或 Platform 也替换掉：

```text
VM / Boot
   → Platform
      → 默认 App 或用户指定的 system class loader
```

因此，生产排查里看到 `getSystemClassLoader()` 不是内建 `AppClassLoader`，不代表整棵树都被替换了；通常只是应用入口被定制。

## 二、Boot、Platform、App 三层各自是什么

### `ClassLoaders` 里真的有三个 Java 侧对象

JDK 11 的三层内建加载器定义在 `jdk.internal.loader.ClassLoaders` 中：

```java
// ClassLoaders.java:111-160
private static class BootClassLoader extends BuiltinClassLoader {
    BootClassLoader(URLClassPath bcp) {
        super(null, null, bcp);
    }
}

private static class PlatformClassLoader extends BuiltinClassLoader {
    PlatformClassLoader(BootClassLoader parent) {
        super("platform", parent, null);
    }
}

private static class AppClassLoader extends BuiltinClassLoader {
    final URLClassPath ucp;

    AppClassLoader(PlatformClassLoader parent, URLClassPath ucp) {
        super("app", parent, ucp);
        this.ucp = ucp;
    }
}
```

这段源码最值得注意的不是三个类名，而是它们的构造参数：

- Boot 的 parent 是 `null`，因为它已经站在 Java 层父链的顶端。
- Platform 的 parent 是 Boot。
- App 的 parent 是 Platform，而且 App 拿到了 `URLClassPath`。

所以 JDK 11 里常说的委派链可以画成：

```text
AppClassLoader → PlatformClassLoader → BootClassLoader / VM
```

### Boot：Java 侧的视图，不等于普通应用可操作的加载器

BootClassLoader 虽然在 `ClassLoaders.java` 里有一个 Java 类，但它的加载动作直接回到 JVM 提供的 bootstrap 查询：

```java
// ClassLoaders.java:111-119
private static class BootClassLoader extends BuiltinClassLoader {
    BootClassLoader(URLClassPath bcp) {
        super(null, null, bcp);
    }

    @Override
    protected Class<?> loadClassOrNull(String cn) {
        return JLA.findBootstrapClassOrNull(this, cn);
    }
}
```

这说明它更像 Java 层的适配视图，而不是一个由普通 Java 代码独立控制的类加载器。核心类的真正加载边界仍然在 VM 和启动模块环境里。

### Platform：平台模块的受控中间层

PlatformClassLoader 的父类是 Boot，但它没有 App 那样的普通 classpath。它的职责是承接被定义为平台范围的模块，让平台 API 不必全部挤进 Boot，也不必落到应用类路径。

这正是它和 JDK 8 ExtClassLoader 的关键差别：Platform 不是“用户往目录里放扩展 jar 的入口”，而是模块系统划出的受控边界。

### App：应用模块与 classpath 的共同入口

AppClassLoader 携带 `URLClassPath`，因此传统 `-cp`、`-jar` 应用仍然通过它寻找类和资源；同时，JDK 11 的应用模块也由应用侧加载器参与承载。

这就解释了一个容易被历史知识带偏的判断：**AppClassLoader 不等于“只负责 classpath 的旧 AppClassLoader”，它是 JDK 11 应用侧的综合入口。**

## 三、模块化之后为什么变成“先判模块，再回退类路径”

### 两个极端方案都不能接受

如果 JDK 11 继续只用旧式 classpath 委派，那么模块最重要的能力——包归属、模块边界和模块路径——就会被重新压扁成一堆 jar 搜索。

但如果 JDK 11 彻底禁止 classpath，只允许所有类都来自模块路径，既有海量 Java 应用也无法运行。JDK 11 的现实任务不是选择其中一个，而是让两套世界并行存在。

因此 `BuiltinClassLoader` 的主线不是简单复制上一章的 `parent → findClass`，而是多了一个优先判断：**这个类名所属的包，是否已经归属于某个模块？**

### `BuiltinClassLoader.loadClassOrNull` 的双轨流程

JDK 11 的实现可以压缩成下面这段证据：

```java
// BuiltinClassLoader.java:590-630
protected Class<?> loadClassOrNull(String cn, boolean resolve) {
    synchronized (getClassLoadingLock(cn)) {
        Class<?> c = findLoadedClass(cn);

        if (c == null) {
            LoadedModule loadedModule = findLoadedModule(cn);
            if (loadedModule != null) {
                BuiltinClassLoader loader = loadedModule.loader();
                if (loader == this) {
                    if (VM.isModuleSystemInited()) {
                        c = findClassInModuleOrNull(loadedModule, cn);
                    }
                } else {
                    c = loader.loadClassOrNull(cn);
                }
            } else {
                if (parent != null) {
                    c = parent.loadClassOrNull(cn);
                }
                if (c == null && hasClassPath() && VM.isModuleSystemInited()) {
                    c = findClassOnClassPathOrNull(cn);
                }
            }
        }

        if (resolve && c != null)
            resolveClass(c);

        return c;
    }
}
```

把代码翻译成角色时序：

```text
BuiltinClassLoader.loadClassOrNull(cn)
   → 查本加载器缓存
   → 按包名查是否属于已加载模块
      ├── 命中模块：交给模块归属的加载器
      │              → 从模块路径定义类
      └── 未命中模块：回到传统路径
             → 先问 parent
             → 再从自己的 classpath 搜索
```

这不是“双亲委派失效”，而是它前面多了一道模块归属判断。模块路径侧先解决“这个包属于哪个模块、哪个加载器”；只有不属于已加载模块的类，才进入传统 classpath 搜索。

### 模块类和 classpath 类的定义入口也不同

模块命中后，`BuiltinClassLoader` 走带 `LoadedModule` 上下文的定义路径：

```java
// BuiltinClassLoader.java:678-684
private Class<?> findClassInModuleOrNull(LoadedModule loadedModule, String cn) {
    if (System.getSecurityManager() == null) {
        return defineClass(cn, loadedModule);
    } else {
        PrivilegedAction<Class<?>> pa = () -> defineClass(cn, loadedModule);
        return AccessController.doPrivileged(pa);
    }
}
```

没命中模块、退回 classpath 时，则按类名转换出资源路径，再从 `URLClassPath` 找 `.class`：

```java
// BuiltinClassLoader.java:688-699
private Class<?> findClassOnClassPathOrNull(String cn) {
    String path = cn.replace('.', '/').concat(".class");
    if (System.getSecurityManager() == null) {
        Resource res = ucp.getResource(path, false);
        if (res != null) {
            try {
                return defineClass(cn, res);
```

两条路径的区别可以压成一句话：

```text
模块类：先确定模块归属，再带模块上下文定义
classpath 类：按类名找资源，再按传统方式定义
```

这就是 JDK 11 的真实过渡状态：模块化不是把 classpath 一夜清空，而是在已有 classpath 之上增加了结构化的模块路径。

**路标：这里先别急着记每个内部方法名。主线只发生了两件事：先问“这个包属于哪个模块”，属于模块就走模块路径；不属于模块，才继续走父加载器和 classpath。下面把三层职责和生产排障接起来。**

## 四、三层加载器怎么分工，排障时先看哪一层

### 不要只靠包名前缀猜加载器

工程师排查 `ClassNotFoundException` 时，最容易直接做的动作是继续加 jar、改 `-cp`。但 JDK 11 的内置加载器已经不适合只靠“这个名字看起来像 `java.*` 还是 `jdk.*`”来猜归属。

更可靠的第一步是：先判断它属于哪个加载层，再检查该层的路径。

```text
Boot：启动核心模块，例如 java.base
Platform：受控的平台模块，例如 java.sql、java.xml、java.management
App：应用模块、classpath / -cp / -jar 上的业务类
```

这里要特别避开一个误解：并不是所有 `jdk.*` 模块都天然属于 Platform。JDK 11 的模块到加载器分派由构建和模块映射决定，不能只看模块名字符串下结论。生产上真正需要的是查当前运行时的模块归属，而不是凭前缀猜。

### `getSystemClassLoader` 对应的是 App 侧

AppClassLoader 的公开获取入口是 `ClassLoaders.appClassLoader()` 的内部实现，以及 `ClassLoader.getSystemClassLoader()` 的公共 API。它服务的是应用入口，所以当业务类找不到时，首先应该检查 classpath 或应用模块路径，而不是去怀疑 Boot。

JDK 11 初始化 App 时会读取 `java.class.path`：

```java
// ClassLoaders.java:67-78
String cp = System.getProperty("java.class.path");
if (cp == null || cp.isEmpty()) {
    String initialModuleName = System.getProperty("jdk.module.main");
    cp = (initialModuleName == null) ? "" : null;
}
URLClassPath ucp = new URLClassPath(cp, false);
APP_LOADER = new AppClassLoader(PLATFORM_LOADER, ucp);
```

这段实现还揭示了一个边界：空 classpath 在未命名初始模块和命名初始模块下可能有不同解释。也就是说，“我明明设置了空 `java.class.path`，为什么路径行为不一样”并不一定是命令行失效，而可能是启动形态不同。

### `String.class.getClassLoader()` 为什么是 `null`

现在看最经典的问题：

```java
// 用法示意(API 形式,非源码片段)
String.class.getClassLoader() == null;
```

这个 `null` 不是“String 没有加载器”，而是“负责它的最底层引导加载边界没有以普通 Java `ClassLoader` 对象暴露出来”。Boot 的真实工作由 VM 和启动模块环境完成，Java 侧只提供受限的辅助入口。

`BootLoader` 本身是一个 Java 类，但它的定位主要是为引导加载器定义的模块查资源和包信息：

```java
// BootLoader.java:56-65
public class BootLoader {
    private BootLoader() { }

    private static final Module UNNAMED_MODULE;

    static {
        UNNAMED_MODULE = SharedSecrets.getJavaLangAccess().defineUnnamedModule(null);
        setBootLoaderUnnamedModule0(UNNAMED_MODULE);
    }
}
```

因此要区分三个概念：

```text
BootClassLoader：ClassLoaders 内部的 Java 侧加载器视图
BootLoader：     JDK 内部使用的受限辅助入口
VM bootstrap：   真正承载核心类加载边界的底层实体
```

它们不是三个并列的“加载器实例”。`String.class.getClassLoader()` 返回 null，正是因为最后那个 VM bootstrap 边界不以普通 Java 对象形式交给应用。

## 七、五个最容易混掉的边界：系统类加载器不是最顶层，Platform 不是旧 Ext 改名，模块优先不是 classpath 消失，BootClassLoader 不等于 BootLoader，null 也不等于没有加载器

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，系统类加载器不是最顶层加载器。`getSystemClassLoader()` 站的是应用入口视角，返回的是 App 这一层，而不是引导边界本身。把“系统”误听成“最核心”，是类加载题里最常见的名字误导。

第二，PlatformClassLoader 也不是旧 ExtClassLoader 仅仅换了个名字。真正变化的是边界：Ext 时代的全局扩展目录被收紧成了受控平台模块层，不再鼓励随手往某个目录里丢 jar 就进入平台世界。

第三，模块优先更不等于 classpath 从 JDK 11 开始彻底消失。真正发生的是双轨并存：先判包是否属于已加载模块，命中就走模块路径；不命中才继续回到 parent 委派与 classpath 搜索。

第四，`BootClassLoader` 和 `BootLoader` 也不是同一个东西的两个名字。前者是 `ClassLoaders` 里用于组织三层关系的 Java 侧视图，后者则是 JDK 内部提供的受限引导加载辅助入口；真正最底层的 bootstrap 边界仍然在 VM 一侧。

第五，`String.class.getClassLoader() == null` 也不等于“这个类没有加载器”。它真正说明的是：负责它的那一层引导加载边界，没有以普通 Java `ClassLoader` 对象的形式暴露给应用代码。

把这五条边界记稳，JDK 11 内建加载器这一篇就不会重新塌回“Bootstrap/Ext/App 换了新名字”的表面印象。它真正想讲的是：JDK 9+ 保留了三层委派关系，但把中间层的权力边界和模块/classpath 的分工一起重写了。

## 收网：JDK 11 是三层关系上的双轨加载

回到开头的问题：JDK 9+ 到底改了什么？不是把三层类加载器删掉，也不是让双亲委派彻底失效，而是把中间层从 Ext 的任意扩展目录收紧成 Platform 的平台模块层，并让内置加载器同时识别模块路径和 classpath。

整条加载主线可以画成：

```text
App / Platform / Boot 三层
          │
          ▼
BuiltinClassLoader.loadClassOrNull
          │
          ├── 先查缓存
          ├── 再查类名所属模块
          │      ├── 命中：按模块归属加载
          │      └── 未命中：parent 委派 + classpath 搜索
          └── 需要时 resolve
```

实际排障时记住三条规则：

1. **先判断加载层，再检查路径**：业务类通常先看 App 的 classpath 或应用模块路径；平台 API 看 Platform；核心类看 Boot 边界。
2. **不要把 Platform 当成 Ext 的简单改名**：Ext 的任意扩展目录被收紧成受控平台模块。
3. **不要把 `null` classLoader 当成“没有加载器”**：它表示 VM 侧引导边界没有以普通 Java `ClassLoader` 对象暴露。

到这里，类“从哪里来”已经有了答案；但类之外还有另一类同样重要的东西：资源文件、`META-INF/services`、配置和 SPI 描述。下一篇继续追问：资源查找为什么也有委派，而 SPI 为什么又需要线程上下文类加载器把父层接口和子层实现接起来？

> → 下一篇：[资源查找与 SPI](03-resource-spi.md)
