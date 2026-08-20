# 资源查找与 SPI：双亲委派为什么需要一条反向通道

> 本文基于 JDK 11 `java.base` 的 `ClassLoader`、`URLClassPath`、`Thread` 和 `ServiceLoader` 契约。资源委派、classpath 有序搜索、JarLoader 与线程上下文类加载器以 JDK 11 当前实现为准；SPI 的模块路径规则只作边界说明，不展开 `module-info` 全部语法。本文讨论的是 JDK 11 Java 层资源查找与 SPI 反向通道，不把这里的 classpath 搜索顺序、TCCL 借用方式和热部署命名空间切换外推成所有类加载框架都必须遵守的统一规范。
> **前置依赖**：[双亲委派与类加载流程](01-delegation-model.md)、[JDK 11 内置类加载器](02-builtin-classloaders.md)
> **后续**：域 08 集合框架

## 双亲委派走不通时，问题不一定在类加载器

先看一个生产中很常见的场景：应用同时引入两个插件 jar，它们都提供了同名的 `META-INF/services/...` 文件。框架如果只读到第一个文件，可能只发现一个实现；如果把两个文件都读出来，再按 SPI 规则逐个加载，结果又完全不同。

再看 JDBC：`DriverManager` / `ServiceLoader` 这类接口和框架代码位于平台层，MySQL 驱动实现却在应用 classpath。按照上一章的双亲委派，平台层只能问自己的 parent，怎么会自然“向下”看到 App 层的实现？

这两个问题其实是一条链：

```text
资源查找：我要一个结果，还是所有结果？
SPI 加载：接口在父层，实现在哪个加载器的路径里？
```

如果只背“先父后己”，就会在 SPI 场景里卡住。因为这里需要的不是让父加载器永远向下委派，而是让高层代码**借用当前线程所处的应用类路径视角**。

整篇文章围绕四个角色展开：

```text
ClassLoader 资源 API
   → parent / 当前 loader 的资源搜索
URLClassPath
   → 按 classpath 顺序搜索目录和 jar
ServiceLoader / DriverManager
   → 需要发现服务描述和实现类
Thread.contextClassLoader
   → 把当前线程的低层类路径视角借给高层代码
```

## 一、`getResource` 和 `getResources`：一个找第一个，一个收集全部

### 先推演错误的统一方案

如果把资源当成类来理解，最容易得到一个判断：既然类加载只需要找到一个 `Class`，资源也应该找到第一个就结束；`getResources` 无非是 `getResource` 多返回几个结果。

但 SPI 和配置聚合马上会打破这个判断。类定义通常要求同一个命名空间里只有一个结果，资源却可能合法地分布在多个 jar 中：多个 `META-INF/services/...` 文件都应该被发现，多个配置片段也可能需要合并。

所以 JDK 的两个 API 不是“返回类型不同”，而是表达两种不同的搜索意图：

```text
getResource(name)
   → 委派链查找
   → 第一个命中就返回

getResources(name)
   → 委派链查找
   → 父和当前 loader 的命中全部枚举
```

### `getResource` 与类加载同构

JDK 11 的 `ClassLoader.getResource` 先问父，再查自己：

```java
// ClassLoader.java:1397-1407
public URL getResource(String name) {
    Objects.requireNonNull(name);
    URL url;
    if (parent != null) {
        url = parent.getResource(name);
    } else {
        url = BootLoader.findResource(name);
    }
    if (url == null) {
        url = findResource(name);
    }
    return url;
}
```

这条路径与上一章 `loadClass` 的骨架相似：

```text
当前 loader.getResource(name)
   → parent.getResource(name)
      → parent 的 parent ...
   → 父链都没有
   → 当前 loader.findResource(name)
```

失败方案是把资源查找当成完全脱离委派的“当前目录搜索”。这样同一个资源名在父层和子层同时存在时，结果就会依赖调用点，而不是依赖加载器层级规则。

### `getResources` 为什么必须合并父与自己

全量枚举的实现则不同：它把父层枚举和当前 loader 的枚举放进 `CompoundEnumeration`，而不是只保留第一个：

```java
// ClassLoader.java:1463-1478
public Enumeration<URL> getResources(String name) throws IOException {
    Objects.requireNonNull(name);
    @SuppressWarnings("unchecked")
    Enumeration<URL>[] tmp = (Enumeration<URL>[]) new Enumeration<?>[2];
    if (parent != null) {
        tmp[0] = parent.getResources(name);
    } else {
        tmp[0] = BootLoader.findResources(name);
    }
    tmp[1] = findResources(name);

    return new CompoundEnumeration<>(tmp);
}
```

这个差异正是 SPI 能发现多个实现描述的基础：服务配置文件可以同时存在于父层路径和应用 classpath，调用方需要的是“所有候选”，而不是“最先遇到的一个”。

因此，资源 API 的第一个设计结论是：**类查找通常关心唯一结果，资源枚举可能关心完整集合；不能用 `getResource` 代替 SPI 的 `getResources`。**

## 二、URLClassPath：classpath 顺序就是搜索裁决顺序

### 先看一个 jar 冲突事故

假设两个 jar 都包含：

```text
log4j.properties
com/example/Codec.class
```

应用启动时到底读哪个配置、加载哪个类？如果认为“JVM 会聪明地比较版本，自动选择正确的那个”，排查就会走偏。对于传统 classpath 搜索，顺序本身就是重要输入：谁在前面，谁先获得命中机会。

### URLClassPath 按 URL 顺序逐个 Loader 搜索

JDK 11 的 `URLClassPath.findResource` 直接遍历内部 Loader 列表，遇到第一个非空结果就返回：

```java
// URLClassPath.java:291-300
public URL findResource(String name, boolean check) {
    Loader loader;
    for (int i = 0; (loader = getLoader(i)) != null; i++) {
        URL url = loader.findResource(name, check);
        if (url != null) {
            return url;
        }
    }
    return null;
}
```

`getResource` 使用同样的有序逻辑，只是返回内部 `Resource` 对象：

```java
// URLClassPath.java:310-323
public Resource getResource(String name, boolean check) {
    Loader loader;
    for (int i = 0; (loader = getLoader(i)) != null; i++) {
        Resource res = loader.getResource(name, check);
        if (res != null) {
            return res;
        }
    }
    return null;
}
```

因此，classpath 冲突的第一条排查规则很朴素：**先确认搜索顺序，再确认加载器委派链。** `NoSuchMethodError`、读到旧配置、SPI 只发现一个实现，很多时候都可以追溯到“先命中的版本不是你以为的版本”。

### JarLoader 和 FileLoader 只是不同的路径载体

URLClassPath 不把所有 URL 当成同一种东西。目录由文件系统 Loader 处理，jar 则由 JarLoader 处理；文章主线只需抓住 jar 侧两个实现事实：JarFile 会被缓存复用，JarIndex 可以提前提供 jar 之间的索引关系。

```java
// URLClassPath.java:702-743
static class JarLoader extends Loader {
    private JarFile jar;
    private final URL csu;
    private JarIndex index;
    private URLStreamHandler handler;
    private final HashMap<String, Loader> lmap;
    private final AccessControlContext acc;
    private boolean closed = false;
    private static final JavaUtilZipFileAccess zipAccess =
            SharedSecrets.getJavaUtilZipFileAccess();

    JarLoader(URL url, URLStreamHandler jarHandler,
              HashMap<String, Loader> loaderMap,
              AccessControlContext acc)
        throws IOException
    {
        super(new URL("jar", "", -1, url + "!/", jarHandler));
        csu = url;
        handler = jarHandler;
        lmap = loaderMap;
        this.acc = acc;

        ensureOpen();
    }

    @Override
    public void close () throws IOException {
        if (!closed) {
            closed = true;
            ensureOpen();
            jar.close();
        }
    }

    JarFile getJarFile () {
        return jar;
    }
```

打开 jar 时，JDK 11 会保存 JarFile，并尝试读取 JarIndex：

```java
// URLClassPath.java:750-763
private void ensureOpen() throws IOException {
    if (jar == null) {
        jar = getJarFile(csu);
        index = JarIndex.getJarIndex(jar);
        if (index != null) {
            String[] jarfiles = index.getJarFiles();
```

这部分的性能意义很具体：反复查资源时，不必每次重新打开同一个 jar；存在索引时，也能减少无目标的 jar Loader 创建和搜索。它不会改变“先后顺序决定第一个命中”的大原则，只是在这条有序路径上减少重复工作。

**路标：到这里先把局部实现放下。资源查找的主线只发生了两件事：`getResource` 选择第一个结果，`getResources` 收集全部结果；在 classpath 内部，URL 又按声明顺序逐个搜索。下一节进入真正的矛盾：接口在父层，实现却在子层。**

## 三、SPI：为什么父层接口沿 parent 链永远够不到子层实现

### 先把角色摆在正确的位置

以 JDBC 为例，服务接口和发现框架可能位于 `java.sql` 平台模块，而 MySQL 驱动实现位于应用 classpath。抽象成加载器关系就是：

```text
平台层代码：知道服务接口是什么
        │
        └── parent 链只能向上：Platform → Boot

应用层实现：位于 App classpath
        │
        └── 不在平台加载器的 parent 链上
```

如果让平台层代码只调用自己的 `loadClass`，它会沿着父方向找；而父层永远不是子层，结果自然找不到 App 里的驱动类。

这不是双亲委派“写错了”，而是双亲委派本来就在解决另一个问题：让更高层命名空间优先决定类归属。SPI 的需求却是：**高层定义接口，低层提供实现。**

### 失败方案：让父加载器沿自己的链向下找

如果平台层的 `DriverManager` 直接尝试：

```text
Platform.loadClass("com.mysql.Driver")
   → Boot.loadClass("com.mysql.Driver")
   → 仍然没有
```

它没有一条默认路径能跳到 App。把 `loadClass` 的 parent 链倒过来，反而会破坏上一章讲的核心类一致性和命名空间边界。

因此，SPI 不应该修改整个 JVM 的 parent 关系，而应该提供一个**局部的、由当前执行上下文决定的加载视角**。

## 四、线程上下文类加载器：让高层代码借用低层视角

### TCCL 不是新加载器，而是线程上的一个入口变量

JDK 11 的 `Thread` 为每个线程保存一个 context class loader：

```java
// Thread.java:166-167
/* The context ClassLoader for this thread */
private ClassLoader contextClassLoader;
```

它不是把 Platform 的 parent 改成 App，也不是把两个类加载器合成一个；它只是在线程对象上保存一个“当前任务希望用哪个加载器视角找类”的引用。

TCCL 的角色关系是：

```text
平台层 ServiceLoader / DriverManager
   → 读取当前线程 contextClassLoader
   → 以 App 或插件 loader 的路径查找服务描述
   → 再由对应 loader 加载实现类
```

这就是所谓“打破双亲委派”的准确含义：不是破坏 JVM 的类唯一性，也不是让父加载器永久向下委派，而是高层代码在一个明确的调用上下文里，借用低层加载器完成发现。

### ServiceLoader 的使用语义正是这个方向

`ServiceLoader` 的典型用法是：

```java
// 用法示意(API 形式,非源码片段)
ServiceLoader<CodecFactory> loader = ServiceLoader.load(CodecFactory.class);
for (CodecFactory factory : loader) {
    Encoder encoder = factory.getEncoder("PNG");
}
```

调用方只声明服务接口，不需要写死实现类在哪个 jar。实现方可以放在应用 classpath，也可以放在模块路径；服务发现负责找到描述和实现，调用方只消费接口。

抽象时序如下：

```text
ServiceLoader.load(Service.class)
   → 以当前线程 TCCL 作为查找视角
   → 扫描多个 META-INF/services/Service 文件
   → 逐个读取实现类名
   → 用对应视角加载实现类
   → 实例化 provider
```

因此 TCCL 的价值不是“让所有类都能互相访问”，而是把**谁拥有实现类路径**这个问题从父层框架代码中抽出来，交给当前线程上下文决定。

### 线程池里污染 TCCL 为什么危险

TCCL 的另一个性质是它附着在线程上，而线程池线程会被多个任务复用。如果任务 A 临时把 TCCL 改成插件加载器，任务结束后忘记恢复，那么任务 B 即使属于另一个应用，也可能沿用 A 的类路径视角。

```text
任务 A：TCCL = PluginLoader
   → 任务结束，忘记恢复
任务 B：复用同一线程
   → ServiceLoader 仍从 PluginLoader 找实现
   → 可能加载错 provider，或出现类型不兼容
```

所以生产代码如果必须临时切换 TCCL，应当保存旧值，并用 `try/finally` 恢复。TCCL 是上下文状态，不是可以随意留在共享线程上的全局配置。

## 五、热部署：换的不是 class 文件，而是整个命名空间

### 为什么不能直接覆盖旧类

假设新版本的 `com.example.Plugin` 已经编译出来。最直接的热部署想法是：把旧 jar 替换掉，然后让原来的 ClassLoader 再加载一次同名类。

这条路不成立，因为：

- 同一个加载器和同一个类名不能随意重新定义成另一个 `Class`。
- 已经创建的对象仍然持有旧版本 `Class`。
- 静态字段、Method、缓存和线程可能继续引用旧类。

### 新 ClassLoader 实例就是新命名空间

热部署的核心动作不是覆盖字节，而是创建新的加载器实例，让新版本进入新的命名空间：

```text
旧 ClassLoader
   └── com.example.Plugin → 旧 Class → 旧对象

新 ClassLoader
   └── com.example.Plugin → 新 Class → 新对象
```

两个 `com.example.Plugin` 的二进制名字可以一样，但因为加载器不同，它们是两个不同的类。新请求切换到新加载器，旧请求仍然可以在旧对象上完成收尾。

这解释了为什么“重新 `defineClass`”本身还不等于热部署完成：真正的切换还需要让业务入口、线程上下文、缓存和对象引用转向新 loader。

### 旧加载器为什么可能一直不能回收

类卸载不是调用 `close()` 就完成，也不是局部变量消失就完成。只要旧加载器仍被静态字段、线程、TCCL、缓存、监听器或业务对象引用，旧 loader 以及它加载的类就可能继续可达，相关类元数据也不能回收。

因此热部署的另一半是生命周期管理：

```text
切换到新 loader
   → 停止旧任务
   → 清理旧线程与 TCCL
   → 清理静态引用和缓存
   → 让旧 loader 不再可达
   → 等待 JVM / GC 条件满足后回收
```

这比“新建一个 ClassLoader”多了一整套清理责任，也是很多插件系统最终出现类加载器泄漏的原因。

## 六、五个最容易混掉的边界：getResource 不是 getResources 的单个版，classpath 顺序不是细节，TCCL 不是新加载器，SPI 不是破坏双亲委派，热部署也不是覆盖旧类

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，`getResource` 不是 `getResources` 的单个返回值版那么简单。它们从一开始就在表达两种不同意图：一个要第一个命中，一个要把父层和当前 loader 的所有候选都收全。SPI 场景里把这两者混用，结果往往会直接漏实现。

第二，classpath 搜索顺序也不是实现细节。谁在前面、谁先命中，本身就是资源和类冲突时的裁决规则。只要还在传统 classpath 世界里，这个顺序就不是可忽略的小事，而是排障入口。

第三，线程上下文类加载器也不是另造了一棵新的类加载器树。它只是线程上的一个查找视角引用：高层代码临时借用低层 loader 去发现实现，但类最终仍然属于各自原来的加载器命名空间。

第四，SPI 更不是在破坏双亲委派。它只是承认了一个特殊方向冲突：父层定义接口、子层提供实现，于是高层框架必须借当前线程的应用视角去查找服务。被借走的是查找入口，不是 JVM 的类唯一性规则。

第五，热部署也不是把旧类文件覆盖一下就完。真正切换的是命名空间：新加载器实例承载新版本类，旧加载器连同旧类什么时候能卸载，还要看线程、静态字段、缓存和上下文加载器是否把它继续引用住。

把这五条边界记稳，资源查找与 SPI 这一篇就不会重新塌回“几个 API 区别”和“TCCL 是个技巧”的表面印象。它真正想讲的是：类世界向上委派时，资源和服务发现为什么必须补一条受控的反向查找通道。

## 收网：资源、SPI、TCCL 和热部署其实是一条线

现在重新看开头的两个问题。

为什么 `getResource` 和 `getResources` 不一样？因为资源可能只需要第一个命中，也可能必须收集多个 jar 的声明；它们分别对应单值查询和全量枚举。

为什么 SPI 会让双亲委派看起来“方向反了”？因为接口和实现天然可能处于不同加载层。解决方式不是重写整个 parent 链，而是让高层代码借用当前线程 TCCL，从低层应用或插件的路径发现实现。

为什么热部署必须换 ClassLoader？因为换的是命名空间，不是同一个加载器里的同名字节；旧 loader 还被引用时，旧版本就还活着。

把整条机制压成一张图：

```text
资源查询
   ├── getResource：委派搜索，第一个命中
   └── getResources：委派搜索，全部合并
          ↓
URLClassPath：按 classpath 顺序查目录 / jar
          ↓
SPI：多个 META-INF/services 描述
          ↓
高层接口代码借用 Thread.contextClassLoader
          ↓
加载 App / 插件实现
          ↓
热部署用新 ClassLoader 创建新命名空间
```

实际使用时记住四条规则：

1. **单个资源用 `getResource`，SPI 扫描用 `getResources`**，不要把第一个命中误当成全部实现。
2. **classpath 顺序就是冲突裁决顺序**，排查 jar 冲突先看搜索顺序和委派链。
3. **TCCL 是查找视角，不是全局委派改写**；在线程池里临时设置后必须恢复。
4. **热部署换的是 ClassLoader 命名空间**；切换入口之后，还必须清理旧 loader 的引用，才能谈类卸载。

到这里，类从哪里来、资源怎么找、SPI 如何发现实现、热部署如何隔离，已经形成一条完整的类加载实践链。下一篇进入域 08 集合框架：当类和实现都准备好之后，数据又该装进怎样的容器？

> → 下一篇：域 08 集合框架
