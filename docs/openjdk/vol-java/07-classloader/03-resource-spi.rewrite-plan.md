# 07-classloader/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ClassLoader` 资源 API、`URLClassPath`、`Thread` 上下文类加载器与 `ServiceLoader` 使用契约；JDBC 只作为 SPI 场景，不展开 `DriverManager` 内部实现。
> 目标：把“资源加载与打破委派”改写成一篇围绕“父层接口为什么够不到子层实现，资源枚举与 TCCL 如何补上这条反向通道”的机制文章，并收束到热部署和类隔离。

## 1. 读者困惑

- `getResource` 和 `loadClass` 是不是同一套委派？
- 为什么 `getResource` 只返回一个，而 `getResources` 要把多个 jar 的结果全部收集？
- classpath 顺序为什么会决定配置文件和依赖版本冲突？
- `DriverManager` 在平台层，MySQL 驱动在应用层，父加载器为什么能找到接口却找不到实现？
- 线程上下文类加载器为什么能“向下”加载，线程池里污染它又为什么危险？
- 热部署为什么必须换一个新的 ClassLoader 实例？

## 2. 一句话顿悟

**资源有“第一个命中”和“全部枚举”两种需求，SPI 又让父层接口必须看到子层实现；因此 JDK 先让资源查找复用委派骨架，再用 `getResources` 收集多份描述，最后通过线程上下文类加载器把当前线程的应用类路径视角借给高层代码。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `getResource`/`getResources`、URLClassPath 有序搜索、JarLoader/FileLoader、TCCL、SPI 和热部署。
- 已明确 JDBC 场景的方向冲突，以及线程池 TCCL 未恢复的生产风险。
- `URLClassPath` 的 JarFile 缓存与 JarIndex 事实已有源码支撑。

### 必须重写

- 当前开头直接讲 JDBC 方向冲突，资源 API 的“单个命中 vs 全量收集”动机没有先建立。
- `getResources` 与 SPI 的关系需要更具体：不是“资源也委派”这么简单，而是 SPI 描述文件必须跨多个 jar 合并。
- URLClassPath 目前偏 Loader 清单，应围绕“classpath 顺序就是裁决顺序”的事故写，避免把 JarLoader 细节写成目录说明。
- TCCL 需要把“谁调用、借谁的 loader、为什么不能沿 parent 向上”讲成时序；当前结论对，但角色关系略跳步。
- 热部署段需要明确“新加载器 = 新命名空间”，并把卸载条件和 TCCL/静态引用持有风险说清边界。

## 4. 理解路径

### 第一节：资源查找为什么有两个 API

用两个 jar 都包含 `META-INF/services/...` 或同名配置文件的场景开场。读者先面对选择：只想拿一个最先命中的资源，还是必须看到全部实现声明？

先画：

```text
getResource(name)  → 委派链搜索 → 第一个命中
getResources(name) → 委派链搜索 → 父与自己全部合并
```

失败方案：用 `getResource` 做 SPI 扫描，导致只拿到一个 jar 的实现。

### 第二节：资源委派与类委派同构，但资源没有类唯一性

证据：
- `ClassLoader.java:1397-1407`：`getResource` 先父后己
- `ClassLoader.java:1463-1478`：`getResources` 收集父和自身枚举

主线：
- 类加载需要“唯一 Class”，所以第一个命中就可以结束。
- 资源可能有多个合法来源，所以 `getResources` 必须合并。
- `findResource/findResources` 是资源侧扩展点。

### 第三节：URLClassPath 为什么按顺序裁决

先用 jar 冲突事故：两个 jar 都有 `log4j.properties` 或同名类，classpath 先后决定加载哪一个。

证据：
- `URLClassPath.java:291-300`：逐个 Loader，第一个命中返回
- `URLClassPath.java:310-323`：资源查找同样按顺序
- `URLClassPath.java:702-743`：JarLoader 与 JarFile
- `URLClassPath.java:750-763`：JarFile 打开与 JarIndex
- `URLClassPath.java:1205`：FileLoader 目录路径（写作时对照实际行）

主线不是讲所有 jar 索引字段，而是：classpath 是有序搜索路径，先命中就是裁决；JarLoader 缓存打开的 JarFile，JarIndex 可减少搜索。

### 第四节：SPI 为什么让双亲委派方向不够用

用 `java.sql.DriverManager` 与 MySQL 驱动场景：接口/框架在平台层，实现类在 App classpath。平台层沿 parent 向上找只能到 Boot，不可能自然向下进入 App。

失败方案：让父层代码沿自己的 parent 链找子层实现，逻辑上永远到不了。

### 第五节：TCCL 如何提供反向通道

证据：
- `Thread.java:166-167`：`contextClassLoader`
- `Thread.java:1482` / `1515`：get/set（写作时核实）
- `ServiceLoader.load` 默认使用 TCCL 的源码/Javadoc（写作时对照实际行）

先画时序：

```text
平台层 DriverManager / ServiceLoader
   → 不用自己的 parent 链
   → 读取当前线程 contextClassLoader
   → 用 App 视角扫描 META-INF/services
   → 加载并实例化实现类
```

强调 TCCL 是“借用当前执行线程的类路径视角”，不是破坏 JVM 类唯一性；返回的实现类仍属于自己的加载器命名空间。

生产失败方案：在线程池任务里临时设置 TCCL 不恢复，后续任务继承错误视角，造成插件/驱动加载错类。建议用 try/finally 恢复。

### 第六节：热部署与类隔离

先回答为什么不能只替换 class 文件：已经存在的对象、Method、静态字段仍然引用旧 Class；同一个加载器也不能直接重新定义同名类。

主线：
- 新 ClassLoader 实例 = 新命名空间。
- 新 loader 加载新版本类，旧对象仍属于旧 loader 的类。
- 只要旧 loader 仍被静态字段、线程上下文类加载器、线程、缓存或对象引用持有，类和相关元数据就无法回收。

把 `findClass`、重写 `loadClass` 和新 loader 三种策略作为对照，不展开 Tomcat/OSGi 全部实现。

### 第七节：收网与域 08 钩子

回到三个问题：资源为什么有两个 API、SPI 为什么反向加载、热部署为什么换 loader。最终收成：
1. 单资源用 `getResource`，多实现描述用 `getResources`。
2. classpath 顺序是资源/类冲突裁决顺序。
3. TCCL 是高层代码借用低层类路径视角的通道。
4. 热部署换的是命名空间，不是简单覆盖字节码。

自然引到集合框架。

## 5. 失败方案清单

1. 用 `getResource` 扫描 SPI，漏掉后续 jar 的实现。
2. 以为资源查找与类加载一样只需第一个命中。
3. 以为 classpath 中同名资源/类的版本由 jar 内容自动决定。
4. 让平台层接口沿 parent 链寻找 App 层 SPI 实现。
5. 在线程池任务中设置 TCCL 后不恢复。
6. 热部署时复用原 ClassLoader，期待同名类自动更新。
7. 只删除旧 loader 变量，却忽略线程、静态字段和缓存持有它。

## 6. 误解清单

1. `getResources` 只是 `getResource` 的数组版本；它承担的是全量枚举语义。
2. `getResource` 命中顺序与 classpath 顺序无关；URLClassPath 明确按顺序查找。
3. SPI 是父加载器向下委派；真实机制通常是高层代码借 TCCL 获取低层视角。
4. TCCL 会改变类的唯一性；它只改变查找入口，不改变加载器命名空间。
5. 新 ClassLoader 只是一种缓存刷新；它创建的是新的类命名空间。
6. 旧 loader 没有业务引用就一定能卸载；线程上下文、静态引用和缓存都可能阻止回收。

## 7. 证据清单

- `ClassLoader.java:1397-1407`：`getResource`
- `ClassLoader.java:1463-1478`：`getResources`
- `Thread.java:166-167`：TCCL 字段
- `Thread.java:1482/1515`：TCCL 访问器
- `URLClassPath.java:291-300`：有序资源搜索
- `URLClassPath.java:310-323`：有序资源读取
- `URLClassPath.java:332-365`：全量资源枚举
- `URLClassPath.java:702-743`：JarLoader/JarFile
- `URLClassPath.java:750-763`：JarFile 与 JarIndex
- `URLClassPath.java:1205`：FileLoader
- `ServiceLoader.java`：默认 TCCL / provider 发现契约（写作时核实精确位置）

## 8. 版本与边界

- 基于 JDK 11；ServiceLoader 的模块路径 provider 规则与 classpath provider 规则并存，正文不展开 module-info 的完整语法。
- URLClassPath、JarLoader、JarIndex 是 JDK 11 当前实现，不是 classpath 规范要求的唯一搜索实现。
- TCCL 是线程级查找上下文，不等于修改当前线程所属类或 JVM 全局委派链。
- 热部署的类卸载还依赖旧 ClassLoader 不再可达以及 JVM/GC 条件，不能写成“换 loader 就立即卸载”。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“资源单个/全量 → classpath 有序搜索 → SPI 方向冲突 → TCCL 反向通道 → 新 loader 隔离”。
- 小标题能还原“资源为什么有两个 API → 顺序如何裁决 → 父层为什么够不到子层 → TCCL 如何补通 → 热部署为何换命名空间 → 收网”。
- 必须解释 `getResource` 与 `getResources` 的不同动机，不得只列 API 差异。
- 必须明确 TCCL 是查找视角，不是破坏类唯一性。
- 结尾自然引到域 08 集合框架。
