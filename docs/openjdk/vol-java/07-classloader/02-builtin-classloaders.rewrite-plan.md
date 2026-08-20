# 07-classloader/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.base` 的 `ClassLoaders`、`BuiltinClassLoader`、`BootLoader` 与 `ClassLoader.getSystemClassLoader`；模块图分派只讲 Java 层可见事实，不展开 `ModuleLoaderMap` 生成细节。
> 目标：把“JDK 11 内建加载器三层”改写成一篇围绕“JDK 9+ 为什么要把旧 Extension 世界收紧成 Boot/Platform/App 三层，并在模块路径与类路径之间维持双轨加载”的机制文章。

## 1. 读者困惑

- JDK 11 里到底还有没有以前说的 Bootstrap / Ext / App 三件套？
- `ClassLoader.getSystemClassLoader()` 返回的到底是谁，为什么它不等于引导加载器？
- 为什么 `String.class.getClassLoader()` 是 `null`，但 JDK 又有个 `BootClassLoader` 内部类？
- 模块化之后，类到底先走模块路径还是类路径？双亲委派还算不算主线？
- 生产排查 `ClassNotFoundException` 时，为什么“类属于哪层加载器”比“先加依赖”更重要？

## 2. 一句话顿悟

**JDK 11 没有废掉三层加载器，而是把旧的 Bootstrap/Ext/App 重构成 Boot/Platform/App：Boot 仍代表最核心的 VM 侧加载边界，Platform 接管受控的平台模块，App 则同时承担应用模块与类路径类的主要入口。模块化之后真正变化的不是“还有没有双亲委派”，而是内建加载器先做模块归属判断，再在类路径侧继续走委派。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `ClassLoaders` 三个内部类、`BuiltinClassLoader.loadClassOrNull` 的模块/类路径双路径、`getSystemClassLoader`、`BootLoader` 的 Java 侧入口、`String.class.getClassLoader()==null` 的解释。
- 关键证据齐全：`ClassLoaders.java:53-78/89-104/111-119/126-160`、`BuiltinClassLoader.java:576-630/648-655/678-699`、`BootLoader.java:56-65`、`ClassLoader.java:1873-1928`。
- 已有面向排障的“类所属层 + 该层路径”框架，方向是对的。

### 必须重写

- 旧稿一上来就列三层内部类，读者还没真正感受到“JDK 9+ 究竟改掉了什么问题”。需要先把 Extension 时代的模糊边界与模块时代的受控边界对照出来。
- “模块优先 / 类路径回退”目前写成执行序列，但还没真正解释为什么 JDK 11 必须维持双轨：既不能强迫所有应用立刻模块化，也不能继续把平台类都混在类路径世界里。
- `BootClassLoader` 与 `BootLoader` 的关系容易让读者混淆：一个是 `ClassLoaders` 内部类，一个是提供受限 Java 侧入口的辅助类，必须更明确区分。
- “String 的 classLoader 为 null” 现在解释还偏答案式，需要和“Boot 仍然是 VM 边界，不在 Java 层完全建模”连起来讲成机制。
- 排障方法论要落到更具体的失败方案：比如误把 `java.sql.DriverManager` 当 Boot 层、误把模块路径问题当类路径缺依赖。

## 4. 理解路径

### 第一节：JDK 9+ 改掉的不是三层，而是中间层的权力边界

用读者熟悉的旧世界开场：JDK 8 时代说 Bootstrap / Ext / App，很多人会把 Ext 理解成“往 ext 目录里扔个 jar 就全局生效”。引出问题：这种全局可扩展目录为什么危险？模块化以后为什么要收紧？

先画对照：

```text
JDK 8: Bootstrap → Ext → App
JDK 11: Boot → Platform → App
```

重点不是名字，而是职责变化：Ext 的“任意扩展目录”被收缩成 Platform 的“受控平台模块”。

### 第二节：系统类加载器为什么是 App，而不是最顶层

先打掉误解：很多人把“系统类加载器”误当成“最核心加载器”。

证据：
- `ClassLoader.java:1928`：`getSystemClassLoader()` 入口
- `ClassLoader.java:1873-1899`：`java.system.class.loader` 与 classpath / module path 说明
- `ClassLoaders.java:72-78/103-104/151-160`：AppClassLoader 初始化与返回

要讲清：`getSystemClassLoader()` 返回的是应用侧默认入口，也就是 AppClassLoader；它有 parent（Platform），因此天然不是最顶层。`-Djava.system.class.loader` 只是替换这个应用入口，不会替换 Boot 边界。

### 第三节：Boot / Platform / App 到底是谁，各自加载什么

从 `ClassLoaders` 静态初始化切入：Boot、Platform、App 三者如何被构造、parent 如何串起来。

证据：
- `ClassLoaders.java:53-78`
- `ClassLoaders.java:111-119/126-160`

主线：
- BootClassLoader：Java 侧的引导加载器视图，parent 为 null，实际类查询回到 `JLA.findBootstrapClassOrNull`
- PlatformClassLoader：受控的平台模块层，parent = Boot
- AppClassLoader：应用默认入口，parent = Platform，同时持有 `URLClassPath`

失败方案：
1. 以为 JDK 11 没有 Boot，因为 `String.class.getClassLoader()` 返回 null。
2. 以为 Platform 只是 Ext 换了个名字，没有边界变化。
3. 以为所有 `jdk.*` 模块都属于 Platform。

### 第四节：模块化之后为什么变成“先判模块，再回退类路径”

这是全文顿悟点。不要直接贴流程，而先推演两个失败方案：
- 如果还像旧时代那样只靠类路径委派，模块边界和包归属就失去意义。
- 如果强制所有加载都只走模块图，历史 classpath 应用又无法运行。

证据：
- `BuiltinClassLoader.java:576-630`
- `BuiltinClassLoader.java:648-655`
- `BuiltinClassLoader.java:678-699`

要讲成：
1. 先按类名所属包查 `findLoadedModule(cn)`，判断它是否属于已加载模块。
2. 命中模块时，直接按模块归属找到对应加载器并在模块路径侧定义类。
3. 没命中模块时，才退回 parent 委派 + 自己的 classpath 搜索。

总图：

```text
BuiltinClassLoader.loadClassOrNull
   → 先查已加载缓存
   → 再看这个类是否属于某个已加载模块
      ├── 是：走模块侧加载
      └── 否：走 parent 委派 + classpath 搜索
```

### 第五节：为什么 `String.class.getClassLoader()` 是 null，但 Boot 又真实存在

这节专门解除一个认知冲突。

证据：
- `BootLoader.java:56-65`
- `ClassLoaders.java:111-119`

要讲清：
- Java 代码拿到 `null`，不是因为 Boot 不存在，而是因为最底层引导加载边界不以普通 Java `ClassLoader` 对象的形式暴露给用户。
- `ClassLoaders.BootClassLoader` 是 JDK 内部为模块资源查找等场景提供的 Java 侧视图；`BootLoader` 则是公开给 JDK 内部其他代码使用的受限入口。
- 所以 “Bootstrap 为 null” 与 “JDK 内部仍有 Boot 相关 Java 代码” 并不矛盾。

### 第六节：生产排障时，先判断类属于哪一层，再看哪条路径

把前面的结构收成排障方法论：
- `java.*` 或启动模块类 → Boot 边界
- 平台模块类（如 `java.sql`、`java.xml`、`java.management`）→ Platform
- 业务类、classpath 类、应用模块 → App

再补一个重要边界：JDK 11 的应用入口既承担类路径，也承担应用模块路径，所以很多 `ClassNotFoundException` 不是简单“少了 jar”，而是“你先搞错了它应该由哪一层、哪条路径加载”。

### 第七节：收网与下一篇钩子

回到开头：JDK 11 没取消三层，而是把中间层从 Ext 的模糊可扩展目录，收紧成 Platform 的受控平台模块；同时让 App 既服务 classpath，也服务应用模块。双亲委派没有消失，只是在 BuiltinClassLoader 里让位于“先判模块，再回退类路径”的双轨加载。

自然引到下一篇：类已经能找到，那资源怎么找？SPI 为什么会反过来要求父层接口去看子层实现？

## 5. 失败方案清单

1. 以为 JDK 9+ 没有三层类加载器，只剩模块系统。
2. 把系统类加载器误当成最顶层加载器。
3. 把 PlatformClassLoader 当成旧 ExtClassLoader 的纯重命名。
4. 以为模块化后所有类都只走模块路径，不再经过 classpath。
5. 以为 `String.class.getClassLoader() == null` 说明引导加载器不存在。
6. 误把平台模块类当作 Boot 层类，或误把应用模块问题当作单纯 classpath 缺依赖。
7. 以为 `java.system.class.loader` 能替换整个内建加载器树。

## 6. 误解清单

1. Boot / Platform / App 只是名字变化，没有职责变化。
2. AppClassLoader 只负责 `-cp`，不管模块路径应用。
3. PlatformClassLoader 加载所有 `jdk.*` 模块。
4. `BootLoader` 就是 `BootClassLoader`，二者完全等价。
5. 模块优先意味着双亲委派彻底失效。
6. `ClassNotFoundException` 排查只要不停加依赖，不必判断加载层级。
7. `null` classLoader 表示类没有加载器，而不是 VM 侧引导边界未对 Java 暴露对象。

## 7. 证据清单

- `ClassLoaders.java:53-78`：三层内建加载器初始化
- `ClassLoaders.java:89-104`：boot/platform/app 获取入口
- `ClassLoaders.java:111-119`：BootClassLoader
- `ClassLoaders.java:126-160`：PlatformClassLoader / AppClassLoader
- `BuiltinClassLoader.java:576-630`：`loadClassOrNull`
- `BuiltinClassLoader.java:648-655`：`findLoadedModule(cn)`
- `BuiltinClassLoader.java:678-699`：模块路径 / classpath 定义类入口
- `BootLoader.java:56-65`：BootLoader 的 Java 侧入口与 unnamed module
- `ClassLoader.java:1873-1899`：`java.system.class.loader` 与 classpath/module path 说明
- `ClassLoader.java:1928`：`getSystemClassLoader()`

## 8. 版本与边界

- 基于 JDK 11；JDK 8 的 `sun.misc.Launcher`/ExtClassLoader 只作为历史对照。
- 模块名到加载器的静态映射细节（如构建期模块列表）属于 JDK 构建事实，正文只在需要时作为边界说明，不深入生成过程。
- `BootClassLoader`、`BootLoader` 都是 JDK 内部结构或受限入口，不是普通应用直接编程模型。
- 本文重点是 Java 层可见职责边界与加载路径，不展开 URLClassPath/JarLoader 细节，那部分留到下一篇。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“Ext 被收紧为 Platform、App 是系统入口、BuiltinClassLoader 先判模块再回退类路径、Boot 边界在 Java 层返回 null”的主线。
- 小标题能还原“JDK9+ 改了什么 → 系统加载器是谁 → 三层各管什么 → 模块与类路径如何共存 → 为什么 Boot 是 null → 排障方法论 → 收网”。
- 必须把模块优先讲成‘为什么不能只靠老 classpath’，而不是流程背诵。
- 必须把 BootClassLoader / BootLoader / null 三者关系讲清，不得留下名词混淆。
- 结尾自然衔接资源查找与 SPI。 
