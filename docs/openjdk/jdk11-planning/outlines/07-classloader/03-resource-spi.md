# 03. 资源加载与打破委派 — URLClassPath、SPI、线程上下文加载器

> 🟡 Working | 域 07 类加载器第 3 篇 | Layer 2
> 读者处境: "双亲委派的破坏"是面试深水区;生产上 `Class.forName(..., 类加载器)` 传错、SPI 加载不到实现类——都源于这条资源/SPI 链路。

### 1. "getResource 也委派？" — 资源加载的双亲委派

场景: 两个 jar 里都有 META-INF/services 同名文件——谁先被读到?

- `ClassLoader.java:1397` `getResource(String)` — **先问父加载器**,父没有才自己找(与类加载同构)
- `ClassLoader.java:1463` `getResources(name)` — 返回全部分布(委派链上所有命中合并,SPI 扫描用这个)
- `findResource` — 子类覆写点
- 关键设计 (斜体): *资源委派与类委派同构——但资源没有"类唯一性"问题,所以 getResources 是"全部收集"而非"第一个";`Thread.currentThread().getContextClassLoader()`(`Thread.java:1482`)是打破方向的钥匙*
- 面试: "getResource vs getResourceAsStream vs getResources"——路径前导斜杠、当前类相对路径、全量收集

### 2. "URLClassPath 怎么搜 jar？" — JarLoader 与 FileLoader

场景: `ClassLoader.getSystemResource("log4j.properties")` — 它在哪个 jar 里被找到的?

- `jdk/internal/loader/URLClassPath.java:291` `findResource(name, check)` / `310` `getResource` — 遍历 URL 列表逐个找
- `URLClassPath.java:702` `JarLoader` — jar 文件的类路径加载器: JarFile 打开缓存、jar 索引(Index-Jar)加速、Manifest 处理
- `URLClassPath.java:1205` `FileLoader` — 目录类路径: 直接文件系统查找
- 关键设计 (斜体): *URLClassPath 是"有序搜索": 顺序 = classpath 顺序;JarLoader 缓存 JarFile 句柄避免反复打开——资源冲突时"先到先得",这就是类路径顺序决定依赖版本的机制*
- 面试: "jar 包冲突(NoSuchMethodError)"——classpath 顺序与双亲委派共同决定加载哪个类
- [C++: 内部卷 41-zip-jimage(底层 zip/jimage 读取)]

### 3. "双亲委派为什么被破坏？" — SPI 与线程上下文加载器

场景: `DriverManager`(java.base 里)要加载 MySQL 驱动(应用 classpath 里)——委派方向反了,怎么破?

- 问题: `java.sql` 模块的 DriverManager(平台模块,Platform 加载器)要加载应用 classpath 里的驱动实现类(App 加载器)——委派方向反了,**纯双亲委派够不到 SPI 实现**
- 解法: 线程上下文加载器(`Thread.java:167` contextClassLoader,`1482` get/`1515` set)— 让"高层代码"用"低层加载器"去找类(方向反转)
- 经典场景: JDBC DriverManager/ServiceLoader/`META-INF/services`(域 36 JDBC 展开)、JNDI、JAXP
- 关键设计 (斜体): *"破坏"的本质: 接口在父链顶端(核心库),实现类在子链底端(应用)——SPI 用 contextClassLoader 从"当前线程的类路径视角"加载实现;面试讲清楚"谁在何时用谁的加载器"就是满分*
- 生产: 线程池里 contextClassLoader 未恢复 → 后续任务加载错类(框架坑);Tomcat 的类隔离是更彻底的重写委派

### 4. "自定义加载器与隔离" — 热部署思路

场景: 生产热部署/插件隔离——类加载器怎么玩出花

- 覆写 findClass: 字节来源自定义(网络/数据库/解密)
- 新加载器 = 新命名空间: 同名的旧类与新类共存(旧对象仍引用旧类)——热部署"切换加载器"的原理
- 覆写 loadClass: 完全接管委派(OSGi/Tomcat 模式,打破双亲委派)——类隔离: 每个应用自己的加载器链
- 关键设计 (斜体): *类加载器是"类沙箱"——隔离程度取决于委派策略: 全委派(安全/共享)→ 全自取(隔离/重复);框架选型: 依赖共享用委派,应用隔离用接管*
- 面试: "热部署原理"——新 ClassLoader 实例 + 重新 defineClass;注意内存泄漏: 加载器被持有 → 类无法卸载(与域 11 ThreadLocal 泄漏同类问题)
- [内部卷: 07-classfile-classloader(类卸载与元空间回收,域 10-metaspace)]

---

### 核心悬念

类加载完毕——类对象、成员、注解、反射全部就绪。接下来是"装什么": **集合框架**——ArrayList 怎么扩容?HashMap 的哈希为什么这么设计?Set/Map 全家怎么选型?——下一站: 域 08 集合框架。

> → 下一篇: 域 08 集合框架(08-collections 系列) | 关联: 域 36 JDBC(SPI 落地)、域 25 Agent(加载器与 Instrumentation)
