# 03. 资源加载与打破委派 — URLClassPath、SPI、线程上下文加载器

> **前置依赖**: [07-classloader/01 — 双亲委派模型](01-delegation-model.md)(loadClass 三步骤)、[07-classloader/02 — 内置加载器](02-builtin-classloaders.md)(三层职责)
> → **后续**:域 08 集合框架(08-collections 系列,下一篇)
> 关联: 域 36 JDBC(SPI 机制的落地场景)

## 委派方向反了怎么办

"双亲委派的破坏"是类加载的面试深水区。问题的起点很朴素: `java.sql.DriverManager`(平台模块,Platform 加载器加载)要实例化 MySQL 驱动(应用 classpath,App 加载器)——**委派方向反了**: 父加载器加载的代码,够不到子加载器里的实现类。解法是线程上下文加载器(TCCL)——让"高层代码"用"低层加载器"去找类。

这篇讲四件事: 资源加载的双亲委派、URLClassPath 的 jar 搜索、SPI 与 TCCL 的方向反转、以及自定义加载器与类隔离。

## 1. "getResource 也委派" — 资源加载的双亲委派

### 1.1 与类加载同构

`ClassLoader.getResource`(`ClassLoader.java:1397-1407`):

```java
// ClassLoader.java:1397-1407(截取核心,逐字)
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

与 loadClass 完全同构: **先问父(parent 为 null 时问 BootLoader),父没有才 `findResource`(自己的搜索路径)**。

### 1.2 getResources:全量收集

`getResources`(`ClassLoader.java:1463-1478`)不同——返回**委派链上所有命中**:

```java
// ClassLoader.java:1463-1478(截取核心,逐字)
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

父的命中 + 自己的命中用 `CompoundEnumeration` 合并——**SPI 扫描(META-INF/services)用的就是它**: 多个 jar 里同名资源全部收集。

### 1.3 覆写点

`findResource`(`ClassLoader.java:1562`)/`findResources`(`ClassLoader.java:1598`)是子类覆写点——和 findClass 的定位一样。

关键设计(斜体):*资源委派与类委派同构——但资源没有"类唯一性"问题,所以 getResources 是"全部收集"而非"第一个"(`CompoundEnumeration` 合并)。面试区分: getResource(第一个)、getResourceAsStream(流)、getResources(全量)——SPI 扫描场景必须用 getResources。*

## 2. "URLClassPath 怎么搜 jar" — JarLoader 与 FileLoader

### 2.1 有序搜索

`URLClassPath.findResource`(`URLClassPath.java:291-300`):

```java
// URLClassPath.java:291-300(截取核心,逐字)
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

**按 classpath 顺序逐个 Loader 找,第一个命中即返回**——`ClassLoader.getSystemResource("log4j.properties")`(`ClassLoader.java:1670-1672`)最终走到这里。

### 2.2 两种 Loader

`URLClassPath` 内部两种 Loader:

- **JarLoader**(`URLClassPath.java:702`):jar 文件——**缓存打开的 JarFile 句柄**(避免每次重新打开),支持 jar 索引加速
- **FileLoader**(`URLClassPath.java:1205`):目录——直接文件系统查找

### 2.3 顺序即裁决

classpath 顺序 = 依赖版本裁决: 两个 jar 都有同一个类/资源,**先出现在 classpath 的被找到**——"jar 包冲突(NoSuchMethodError)"的根源就是"classpath 顺序 + 双亲委派"共同决定了加载到哪个版本。

关键设计(斜体):*URLClassPath 是"有序搜索": 顺序 = classpath 顺序;JarLoader 缓存 JarFile 句柄避免反复打开。面试"jar 冲突怎么排查": 先看 classpath 顺序(谁先谁赢),再看委派链(同层才比顺序)。*

跨层标注: [内部卷: 41-zip-jimage(底层 zip/jimage 读取)]

## 3. "双亲委派为什么被破坏" — SPI 与线程上下文加载器

### 3.1 问题:委派方向够不到 SPI 实现

`DriverManager` 在 java.sql 模块(Platform 加载器);MySQL 驱动在应用 classpath(App 加载器)。纯双亲委派下,DriverManager 只能向上委派(Platform → Boot)——**永远够不到 App 里的实现类**。这就是"接口在父链顶端、实现类在子链底端"的 SPI 困境。

### 3.2 解法:线程上下文加载器

`Thread` 有一个特殊字段(`Thread.java:167`):

```java
// Thread.java:167
private ClassLoader contextClassLoader;
```

- `getContextClassLoader`(`Thread.java:1482`)/`setContextClassLoader`(`Thread.java:1515`)
- 新线程**默认继承父线程的 contextClassLoader**(`Thread.java:436-438`)
- main 线程的 contextClassLoader 是**应用加载器**(启动时设置)

TCCL 的意义: **打破委派方向**——高层代码(DriverManager)需要加载实现类时,不沿自己的委派链向上,而是**向"下"借用当前线程的类加载器**:

```
DriverManager(Platform 加载) 需要加载 MySQL 驱动(App 加载)
   └── 不用自己的委派链(向上,够不到)
   └── 用 Thread.currentThread().getContextClassLoader()(App 加载器,向"下"够到)
```

### 3.3 经典场景

- **JDBC**:`DriverManager` 用 TCCL 加载 `META-INF/services/java.sql.Driver` 里的实现类(域 36 展开)
- **ServiceLoader**:`ServiceLoader.load(service)`(`ServiceLoader.java:1690`)默认用 TCCL——`META-INF/services` 扫描的核心
- JNDI/JAXP 同理

关键设计(斜体):*"破坏"的本质: 接口在父链顶端(核心库)、实现类在子链底端(应用)——SPI 用 contextClassLoader 从"当前线程的类路径视角"加载实现。面试讲清楚"谁在何时用谁的加载器"就是满分: 高层代码、需要低层加载器时、用 TCCL。生产坑: 线程池任务里改了 TCCL 没恢复 → 后续任务加载错类——用完必须还原。*

## 4. "自定义加载器与隔离" — 热部署思路

### 4.1 三种玩法

| 做法 | 效果 | 场景 |
|------|------|------|
| 覆写 findClass | 字节来源自定义(网络/数据库/解密) | 加密类加载器 |
| 新加载器实例 | 新命名空间: 同名新旧类共存 | 热部署 |
| 覆写 loadClass | 完全接管委派(不先问父) | OSGi/Tomcat 类隔离 |

### 4.2 热部署原理

**新 ClassLoader 实例 + 重新 defineClass** = 新命名空间: 旧对象仍引用旧类(旧加载器的类),新请求加载新类(新加载器)——"切换加载器"就是热部署的本质。

**注意内存泄漏**: 加载器被持有(比如静态引用),它加载的类无法卸载——与域 11 ThreadLocal 泄漏同类问题。

### 4.3 类沙箱

类加载器是"类沙箱",隔离程度取决于委派策略: 全委派(安全/共享)→ 全自取(隔离/重复)。框架选型: **依赖共享用委派,应用隔离用接管**。

关键设计(斜体):*面试"热部署原理"答"新 ClassLoader 实例 + 重新 defineClass"是入门;补上"加载器被持有会导致类无法卸载(元空间泄漏)"才完整——这和第 2 篇的三层体系、域 11 的 ThreadLocal 泄漏是同一条"生命周期管理"线。*

## 核心悬念

类加载完毕——类对象、成员、注解、反射全部就绪。接下来是"装什么": **集合框架**。ArrayList 怎么扩容?HashMap 的哈希为什么这么设计?二叉树退化成链表怎么办?Set/Map 全家怎么选型?——下一站: 域 08 集合框架。

> → 下一篇: 域 08 集合框架(08-collections 系列)| 关联: 域 36 JDBC(SPI 落地)、域 25 Agent(加载器与 Instrumentation)
