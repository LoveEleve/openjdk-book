# 07-classloader/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.base` 的 `ClassLoader` Java 层实现；`systemDictionary`、类唯一性和加载器命名空间作为 HotSpot / JVM 事实引用，不展开 VM 内部全部细节。
> 目标：把“双亲委派”从口号改写成一篇围绕“为什么类加载既要防重复、防核心类被污染，又要保留自定义隔离能力”的机制文章，核心是 `loadClass` 骨架、`findClass/defineClass` 契约、类加载锁与‘加载’/‘初始化’分离。

## 1. 读者困惑

- 为什么 `ClassLoader.loadClass("java.lang.String")` 不能让我自己随便加载一个同名类？
- `loadClass`、`findClass`、`defineClass` 为什么要分成三层，为什么自定义加载器通常只覆写 `findClass`？
- 多线程同时加载同一个类时，JDK 怎么防止重复定义？
- 为什么两个加载器可以加载同名类，而同一个加载器却不能重复定义它？
- 为什么 `loadClass` 之后静态块不一定执行，而 `Class.forName` 却会？

## 2. 一句话顿悟

**双亲委派不是为了“有父子关系”而存在，而是为了先确认同名类是否已经被更高层命名空间定义、避免核心类被应用侧伪造；而 `findClass/defineClass` 的分工、类加载锁和命名空间二元组，又让 JDK 在保证一致性的同时保留了自定义加载器和类隔离的空间。**

## 3. 旧稿优点与问题

### 保留

- 已经覆盖 `loadClass` 三步骤、`findClass` 与 `defineClass` 分工、`getClassLoadingLock`、`registerAsParallelCapable`、`resolveClass` 与初始化分离。
- 关键证据齐全：`ClassLoader.java:571/574/576/581/594/603/669/723/806/1022/1114/1222/1283/1623`。
- 已和域 04 的 `Class.forName` 语义衔接，说明 `loadClass` 与初始化分离。

### 必须重写

- 旧稿从源码三步平铺开始，读者还没真正感受到“双亲委派到底在保护什么”。需要先用“自己写一个假的 String”或“热部署同名类冲突”这类事故建立问题。
- “类一致性”目前讲得偏结论化，需要更具体地推演：如果不先问父加载器，会发生什么；如果同一加载器允许重复定义，会发生什么。
- `findClass` / `defineClass` 的模板方法关系还不够有设计感，要把“提供字节”和“让 VM 定义类”彻底分开讲。
- 并发加载那节信息密但缺少角色图，容易让读者只记住 `synchronized`，却没建立“Java 层锁只是优化，VM 层命名空间才是最终裁决”的层次。
- “resolve != initialize” 需要回扣域 04 的 JDBC 注册事故，让主线形成收网，而不是单独的术语讲解。

## 4. 理解路径

### 第一节：如果谁都能自己加载 `java.lang.String`，类型系统会发生什么

用两个场景开场：
1. 应用自定义类加载器如果先自己找字节，理论上可以提供一个同名 `java.lang.String`。
2. 热部署系统想同时保留同名旧版本和新版本类。

把这两个看似矛盾的需求并列：一边要求“核心类不能被伪造”，一边要求“同名类在不同隔离域里又必须可以共存”。

先给总图：

```text
loadClass(name)
   → 先看本加载器有没有
   → 再问父加载器是否已经定义
   → 最后才轮到自己提供字节
```

失败方案：直接自己找字节、永远不委派父类。要先把“为什么不能更简单”建立起来。

### 第二节：`loadClass` 的三步不是流程模板，而是安全与一致性的折中

从 `loadClass(String, boolean)` 出发，但先讲动机：
- 先查本加载器缓存，是为了避免重复定义。
- 先问父加载器，是为了让更高层命名空间优先决定同名类归属。
- 最后 `findClass`，才给自定义加载器保留扩展空间。

证据：
- `ClassLoader.java:571-603`
- `ClassLoader.java:1260` 的 `findBootstrapClassOrNull` 只作边界点到

失败方案：
1. 以为双亲委派只是“代码风格约定”。
2. 以为 parent 为 null 时就等于“没有更高层了”，忽略它代表引导加载器边界。
3. 以为 public `loadClass(name)` 与 `Class.forName(name)` 只是不同入口，忽略初始化时机。

### 第三节：为什么自定义加载器通常只覆写 `findClass`

从最容易犯的错入手：自定义加载器如果直接覆写 `loadClass`，表面上更自由，实际上也最容易绕过委派骨架。

证据：
- `ClassLoader.java:723-727`：默认 `findClass` 抛 `ClassNotFoundException`
- `ClassLoader.java:806/1022/1114/1122`：`defineClass` Java 骨架与 native 入口

主线要收成：
- `findClass` 负责“我能否提供字节”。
- `defineClass` 负责“把这些字节交给 VM 定义成类”，Java 层不再自己决定类是否有效。
- `loadClass` 则是固定骨架：缓存 → 委派 → 自己找。

把模板方法模式讲成真正设计，而不是 API 记忆题。

### 第四节：类加载锁为什么不是唯一性本身，只是防抖层

先用并发场景引入：两个线程同时 `loadClass("com.foo.Bar")`，JDK 为什么不会在同一加载器里定义两次？

证据：
- `ClassLoader.java:574`：`synchronized(getClassLoadingLock(name))`
- `ClassLoader.java:669-680`：默认全局锁 vs `parallelLockMap`
- `ClassLoader.java:1623`：`registerAsParallelCapable`
- `ClassLoader.java:1283`：`findLoadedClass`

主线必须明确层次：
- Java 层锁的作用是让同一加载器对同一类名的并发加载尽量串行，避免浪费和冲突。
- 但真正的类唯一性不是这把锁给的，而是“加载器 + 类名”命名空间以及 VM 侧定义检查给的。
- 不同加载器可以加载同名类，这是隔离；同一加载器重复定义同名类会失败，这是唯一性。

### 第五节：为什么 `loadClass` 完成后静态块还不一定执行

从域 04 的 JDBC 驱动事故回扣：为什么 `Class.forName("com.mysql.jdbc.Driver")` 会注册驱动，而 `loadClass("com.mysql.jdbc.Driver")` 不会？

证据：
- `ClassLoader.java:1222-1225`：`resolveClass`
- `ClassLoader.java:526-527`：public `loadClass(name)` 默认 `resolve=false`
- 与域 04 的 `Class.forName(name, true, loader)` 形成对照（正文引用，不必再贴源码）

主线：
- `resolve` 属于链接阶段控制。
- 初始化是“主动使用”触发，不由 `loadClass` 保证。
- 这让“类对象存在”和“静态副作用发生”彻底分离。

### 第六节：收网与下一篇钩子

回到开头两种需求：
- 双亲委派和缓存防止核心类污染与重复定义。
- 加载器命名空间和 `findClass` 扩展点又保留了隔离与热部署能力。

最终收成几条规则：
1. 同一加载器下先父后己，是为了核心类一致性和已有定义优先。
2. 自定义加载器通常只覆写 `findClass`，不是因为 API 保守，而是因为骨架本该留在 `loadClass`。
3. “类唯一性 = 加载器 + 类名”决定了为什么两个加载器能各自拥有同名类。
4. `loadClass` 只保证类可被找到，初始化要看后续是否主动使用。

下一篇再进入 JDK 11 的内建三层加载器：Boot / Platform / App 到底怎么分工，为什么 `String.class.getClassLoader()` 是 null。

## 5. 失败方案清单

1. 任何加载器都先自己找字节，不做父类委派。
2. 自定义加载器直接覆写 `loadClass`，却没保留缓存和委派骨架。
3. 把 `findClass` 当成“定义类”的地方，混淆它与 `defineClass` 的职责。
4. 以为同名类在 JVM 里天然只能有一个，忽略加载器命名空间。
5. 以为 Java 层的 `synchronized` 就是类唯一性的最终保证。
6. 以为 `loadClass` 完成后静态块一定执行。
7. 以为 `resolve=true` 就等于“类已经初始化”。

## 6. 误解清单

1. 双亲委派只是父子链条，不涉及安全与一致性。
2. parent 为 null 表示“没有父类加载器”，而不是进入引导加载器边界。
3. `findClass` 与 `defineClass` 只是名字不同，功能等价。
4. 自定义加载器标准写法是覆写 `loadClass`。
5. 两个加载器加载同名类一定冲突；其实这是类隔离的基础。
6. `findLoadedClass` 命中就是全 JVM 唯一性保证；它只是本加载器已加载缓存查询。
7. `loadClass` 与 `Class.forName` 都会触发初始化；实际初始化触发条件不同。

## 7. 证据清单

- `ClassLoader.java:526-527`：public `loadClass(name)` 默认 `resolve=false`
- `ClassLoader.java:571-603`：`loadClass(String, boolean)` 主骨架
- `ClassLoader.java:669-680`：`getClassLoadingLock`
- `ClassLoader.java:723-727`：默认 `findClass`
- `ClassLoader.java:806-809`：`defineClass(byte[])` 入口
- `ClassLoader.java:1016-1022`：`defineClass1` Java → native
- `ClassLoader.java:1092-1122`：ByteBuffer 路径与 `defineClass2`
- `ClassLoader.java:1222-1225`：`resolveClass`
- `ClassLoader.java:1260`：`findBootstrapClassOrNull`
- `ClassLoader.java:1283`：`findLoadedClass`
- `ClassLoader.java:1623`：`registerAsParallelCapable`

## 8. 版本与边界

- 基于 JDK 11 `java.base`；JDK 8 的 `sun.misc.Launcher` 体系留到下一篇与内建加载器对照时再说。
- `systemDictionary`、类命名空间和“加载器 + 类名”唯一性属于 JVM/HotSpot 事实，不是 Java 源码直接展示的全部实现细节。
- 本文只讲 Java 层可见的加载、委派、定义与 resolve；验证、准备、解析的完整 JVM 细节留内部卷。
- 热部署、Tomcat、OSGi 只作为场景引用，不在本篇展开它们各自的类加载器树。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“缓存 → 委派 → 自己找 → defineClass 交给 VM → 初始化另算”的主线。
- 小标题能还原“为什么不能自己先找 → 三步骨架 → 扩展点在哪里 → 锁与唯一性 → resolve 不等于 initialize → 收网”。
- 必须把双亲委派讲成设计取舍，而不是结论记忆。
- 必须把 `findClass` / `defineClass` / `loadClass` 的分工讲清，不得混成“都是加载类”。
- 结尾必须自然引到下一篇内建三层加载器。
