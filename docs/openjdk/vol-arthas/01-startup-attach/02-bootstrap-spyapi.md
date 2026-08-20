# 02. Arthas 进了 JVM，为什么既不和业务依赖打架，又能让所有增强代码找到同一个入口？——AgentBootstrap、ArthasClassloader 与 SpyAPI 注入

> 基于 `arthas` 当前源码实现讨论；本文聚焦外部 attach 进入目标 JVM 之后的内部落地链，不把 Spring Boot starter、自 attach、bind/tunnel/销毁链混成本篇主线。
> **前置依赖**：[01 —— 服务不能重启时，Arthas 到底是怎么挂进去的？](../01-startup-attach/01-install-attach.md)：知道 `as.sh` 通过 Attach API 把 `arthas-agent.jar` 动态装进目标 JVM，但还不知道进门之后它如何住下来。
> → **后续**：[04 —— Arthas 明明已经进 JVM 了，为什么你还可能连不上？](../01-startup-attach/04-bind-destroy.md)：bind() 怎样开门迎客，destroy() 怎样撤得干净。
> 关联域：36-attach、47-instrumentation、07-classloader。
> 本篇所有行号均已回对 Arthas 源码与既有锚点，不靠猜。

## 先看真正的冲突：Arthas 已经进 JVM 了，但它不能既污染业务依赖，又要求所有增强代码都认识它

场景：你刚敲完 `./as.sh <pid>`，上一章的问题已经解决——Arthas 确实借 Attach API 进到了目标 JVM 里。现在真正棘手的，不再是“怎么进门”，而是“**进门之后怎么住下来**”。

这个问题表面上像是在问“JVM 里多了哪些类”，实际上背后是一个更硬的冲突：

- Arthas 后面要增强业务方法，增强后的代码还要在运行时调用观测入口；
- 但 Arthas 又不能把自己的整套依赖直接混进应用类路径，否则很容易和业务应用自己的依赖版本打架；
- 更麻烦的是，被增强的业务类并不都由同一个 ClassLoader 加载。Spring Boot、Tomcat、OSGi、自定义 child-first loader，都会把“增强后的代码到底能不能找到 Arthas 的类”这件事变成一个类加载可见性问题。

所以本篇真正要回答的不是：

> attach 成功后，JVM 里新增了哪三层结构？

而是：

> **Arthas 怎么做到既不把自己整个混进业务世界，又能让所有增强代码不管由谁加载，都稳定找到同一个观测入口？**

先把全篇总图立住：

```text
外部 JVM 通过 loadAgent(...) 投递 arthas-agent.jar
  → 目标 JVM 内的 AgentBootstrap 接住这次注入
    → 创建 ArthasClassloader 隔离 arthas-core.jar
      → 反射进入 ArthasBootstrap 单例
        → 在隔离空间里完成 Arthas 系统装配
          → 仅把一个极薄的 SpyAPI 提升到 Bootstrap 搜索路径
            → 所有增强后的业务代码都调用这个全局门面
```

这张图里最重要的一刀是：

```text
核心逻辑隔离在 ArthasClassloader
只有 SpyAPI 这个极薄入口需要全局可见
```

后面所有细节，都围绕这条边界展开。

---

## 一、先排除一个最直觉、也最容易出事故的方案：把 Arthas 整个混进应用类路径

### 1.1 为什么很多人会自然想到这个方案

上一章已经知道，外部 JVM 最终执行的是：

```text
VirtualMachine.attach(pid)
  → loadAgent(arthas-agent.jar, ...)
```

于是一个很自然的直觉就是：既然 `arthas-agent.jar` 已经进了目标 JVM，为什么不让它直接把整个 Arthas 系统跑起来？

把这个想法翻成更具体的工程方案，大概会变成：

```text
agentmain()
  → 直接加载 arthas-core
    → 直接把 Arthas 的所有类和依赖混进当前应用类路径
      → 所有增强后的业务代码直接调用这些类
```

这个想法直观、简单，而且好像还能少掉后面那些类加载器和 Bootstrap 注入的复杂设计。

### 1.2 这个方案为什么不行

问题恰恰出在它太“省事”了。

第一，`arthas-core.jar` 不是一个只依赖 JDK 的极薄 agent。它有自己的命令系统、网络组件、日志组件和一整套 core 逻辑。如果把它直接混进应用类路径，就会马上引入依赖冲突风险：

- 业务应用已经有自己的日志库版本；
- Web 容器已经有自己的类加载规则；
- 某些框架环境本来就在做 child-first 或多层隔离。

第二，被增强的业务类不都处在同一个类加载器世界里。哪怕你在应用类路径里放进了一套 Arthas 类，也不能保证所有被增强后的代码都能从自己所在的 ClassLoader 链稳定看见它们。

第三，重复 attach 的生命周期会变得很难收拾。如果 Arthas 的大部分类都直接混进业务世界，那么 stop、reset、再次 attach 时，哪些类该复用、哪些类该清掉、哪些引用会残留，都会变成一团粘连的生命周期问题。

所以这里最需要先记住的不是哪个类先初始化，而是一个更根本的设计目标：

**Arthas 需要的不是“让所有 Arthas 代码都全局可见”，而是“把真正必须被所有人看到的那一小部分，缩到最小”。**

这就是本篇后面所有分层设计的出发点。

---

## 二、第一层：`AgentBootstrap` 为什么只做引导，而不直接变成完整 Arthas

### 2.1 谁先接住这次注入

上一章已经建立了外部控制面的链路：`as.sh:893-899` 启动独立 JVM 执行 `arthas-core.jar -pid <pid>`，随后在 Java 侧 `Arthas.java:103` 调 `VirtualMachine.attach(pid)`，在 `Arthas.java:125-126` 调 `loadAgent(arthas-agent.jar, ...)`。

但到了这一步，真正把 Arthas 接住的，已经不再是外部 JVM，而是**目标 JVM 内的 agent 入口**。第一落点就在 `agent334/AgentBootstrap.java`：

- `AgentBootstrap.agentmain()` 在 `AgentBootstrap.java:67`；
- 然后进入同步 `main()`（`AgentBootstrap.java:90`）；
- 先做幂等检查：`SpyAPI.isInited()`（`AgentBootstrap.java:91-99`）；
- 再解析 `loadAgent` 带进来的参数字符串，拆出 core jar 路径与配置串（`AgentBootstrap.java:110-119`）。

也就是说，attach 真正进入目标 JVM 之后，最先发生的不是“Arthas 服务端启动”，而是：

```text
attach 请求到达目标 JVM
  → AgentBootstrap 接住
    → 先判断是不是重复启动
    → 再把一根字符串还原成可执行上下文
```

### 2.2 为什么 `loadAgent` 的“只给一个字符串”很关键

这里有一个很容易被忽略、但实际上决定了后面整条链设计形态的约束：`loadAgent` 只给你一根字符串。

所以 Arthas 在 `Arthas.java:125-126` 里做的，不只是“调用一个 API”，而是把初始化上下文编码成：

```text
coreJar路径;配置串
```

然后 `AgentBootstrap.java:110-119` 再按分号把它切开。

这条约束解释了为什么 `AgentBootstrap` 像一个引导器，而不像真正的系统本体：**它接到的原始输入本来就是一根字符串，不是一套已经构造好的对象图。**

关键设计（斜体）：*Attach API 只负责把一根“字符串针管”送进目标 JVM；`AgentBootstrap` 的职责不是在这里长成完整 Arthas，而是先把这根针管还原成后续引导所需的最小上下文。*[模式: 极薄引导器 + 协议还原] 这样 attach 层保持极薄，复杂系统装配被推迟到更合适的隔离空间里完成。

### 2.3 为什么不能让 `AgentBootstrap` 直接承担全部 Arthas 逻辑

最直觉的失败方案就是：

> 既然 `AgentBootstrap` 已经在目标 JVM 里了，干脆就在这里把 Arthas 全部逻辑跑完。

这会立刻带来两个问题：

- `AgentBootstrap` 必须直接依赖更多 core 类和第三方依赖，污染注入面；
- 目标 JVM 公共空间里会常驻更多 Arthas 类，重复 attach 和 stop 后的生命周期边界更难收紧。

所以更合理的分工是：

- `AgentBootstrap` 只接住 attach、做幂等、还原协议、搭桥；
- 真正的 Arthas 系统逻辑放到后面受隔离的空间去装配。

换句话说，`AgentBootstrap` 的价值不是“这里已经有一个小型 Arthas 了”，而是“它足够薄，所以能安全地先落进目标 JVM，再把复杂部分领进来”。

---

## 三、第二层：为什么必须有 `ArthasClassloader`

### 3.1 这不是“多套一层”而已，而是在隔离冲突

一旦承认 `AgentBootstrap` 不该直接承担完整 Arthas，下一步自然会问：那完整逻辑放哪？

Arthas 的回答是：**先创建一个隔离出来的 `ArthasClassloader`，只让它负责加载 `arthas-core.jar` 及其依赖。**

对应代码就在 `AgentBootstrap.java:83-88`：

```java
new ArthasClassloader(new URL[]{arthasCoreJarFile.toURI().toURL()})
```

全局引用保存在 `AgentBootstrap.java:61`，而 stop 后还能通过 `resetArthasClassLoader()`（`AgentBootstrap.java:74-76`）把这个引用清空，允许后续再次 attach。

这套设计的真正含义不是“写法比较优雅”，而是：

```text
arthas-agent 负责进门
arthas-core 负责住下来
两者之间要有一道类加载隔离带
```

### 3.2 为什么 parent 不是应用类加载器

真正的类加载策略写在 `agent/ArthasClassloader.java:11-30`：

- 它继承 `URLClassLoader`；
- parent 不是应用类加载器，而是 `System ClassLoader` 的 parent；
- `java.*` / `sun.*` 继续走父加载器；
- 其余类优先 `findClass()` 自己加载，找不到再回退父加载器。

也就是说，它不是一个粗暴的“全部 child-first”加载器，而是一种带边界意识的混合策略：

```text
系统类        → parent-first
Arthas 自身依赖 → 尽量 child-first 隔离解决
业务应用类      → 默认不接管
```

这条策略背后的目标非常明确：**Arthas 不是想去统治应用的类世界，而是想先把自己关在一个笼子里活下来。**

关键设计（斜体）：*`ArthasClassloader` 不是为了抢加载权，而是为了给 Arthas 自己划出一个与业务依赖隔离的生存舱。*[模式: 隔离类加载器] 它先解决“我怎么不和别人打架”，然后才谈“我怎么给别人做增强”。

### 3.3 如果没有这层隔离，会出什么错

把上一节的失败方案再具体化，就是：

- 日志、网络、命令系统等依赖可能和业务应用已有版本冲突；
- 重复 attach 时，旧类引用、旧 ClassLoader、旧静态单例会更难清理；
- 业务应用自己的类加载边界会被 Arthas 代码更大面积侵入。

所以 `ArthasClassloader` 在这里不是“可有可无的工程整理”，而是后续 `SpyAPI` 设计能成立的前提：**只有先把大部分 Arthas 逻辑关进隔离空间，才有意义去讨论“到底哪些东西必须被抬成全局可见”。**

---

## 四、第三层：`ArthasBootstrap` 为什么要“构造即装配”

### 4.1 进入隔离空间后，真正的系统装配才开始

有了 `ArthasClassloader`，`AgentBootstrap` 的下一步就不是继续自己写业务逻辑，而是反射进入 core 里的真正单例：`com.taobao.arthas.core.server.ArthasBootstrap`。

桥接代码在 `AgentBootstrap.java:176-191`：

- `agentLoader.loadClass("com.taobao.arthas.core.server.ArthasBootstrap")`
- 反射拿 `getInstance(Instrumentation.class, String.class)`
- `invoke(...)`
- 再用 `isBind()` 校验服务端是否真的起来

这说明 `AgentBootstrap` 到这里的职责已经完成：

1. 接住 attach；
2. 创建隔离类加载器；
3. 把 `Instrumentation` 和配置参数交给真正的 Arthas 系统。

### 4.2 为什么必须是单例，而且不能留下半初始化状态

`ArthasBootstrap` 的入口在 `ArthasBootstrap.java:897-923`：

- 字符串版本入口先把配置还原成 `Map`；
- 最终走 `synchronized static getInstance(Instrumentation, Map)`；
- 背后有静态 `volatile` 单例字段；
- 如果重复 attach，直接返回已有实例；
- 如果初始化失败，不缓存半成品。

这套设计解决的是同一个 JVM 里最危险的生命周期问题：**不能寄生出两套 Arthas。**

如果允许多套并存，后面马上会撞上：

- 多套命令系统和服务端争端口；
- 多套 Transformer 争增强链；
- 多套 Spy 引用争全局入口；
- stop 时根本搞不清应该撤哪一套。

所以单例在这里不是“习惯性写法”，而是寄生系统必须自我收束的边界。

### 4.3 为什么说它是“构造即装配”，不是“空壳 + 懒初始化”

`ArthasBootstrap` 构造器主链在 `ArthasBootstrap.java:149-196`。现稿里曾经把 8 个步骤平铺出来，但对本篇主线真正重要的不是记住每一个 init 名称，而是看清它的装配语义：

- 成功，就得到一套完整的 Arthas；
- 失败，就不能留下半初始化状态；
- `initSpy()` 必须足够靠前，因为后面的增强、命令执行和服务编排都可能间接依赖 Spy 全局入口。

关键设计（斜体）：*`ArthasBootstrap` 不是一个“先占坑、以后慢慢补齐”的单例，而是一个必须在构造阶段就把寄生系统装配到可工作状态的单例。*[模式: 单例 + 模板式装配] 成功就完整可用，失败就让后续回滚链有明确边界。

这节先别急着逐项追 bind/tunnel/destroy。那些属于下一篇。这里主线只需要记住：**隔离空间已经有了，完整 Arthas 系统也已经在这里装起来了；但它仍然没有解决“所有增强代码为什么都能找到同一个入口”这个最难的问题。**

---

## 五、第四层：为什么真正必须全局可见的只有 `SpyAPI`

### 5.1 这才是本篇真正的主冲突

到这里为止，前面几层都还在解决“Arthas 自己怎么活”：

- `AgentBootstrap` 够薄，先安全进门；
- `ArthasClassloader` 把 core 与业务依赖隔开；
- `ArthasBootstrap` 在隔离空间里装配出完整系统。

但真正决定后面 `watch`、`trace`、`tt` 能不能成立的，是另一个问题：

> 被增强后的业务代码并不和 Arthas 处在同一个 ClassLoader 里，那它凭什么还能调用同一个观测入口？

增强后的业务代码里会直接出现类似调用：

```java
java.arthas.SpyAPI.atEnter(...)
```

这里一旦想错，整个 Arthas 增强链都会塌。因为业务类可能来自：

- Spring Boot 的应用类加载器；
- Tomcat WebAppClassLoader；
- OSGi；
- 自定义 child-first loader；
- 各种互相隔离的运行时插件体系。

它们彼此并不共享 `ArthasClassloader`。如果 Arthas 没有一个所有人都能看到的共同入口，那么增强后的代码就会在运行时找不到它依赖的静态方法。

### 5.2 为什么不是把整个 Arthas 都抬到全局

一个最直觉的补法是：

> 既然增强后的业务代码要能找到 Arthas，那干脆把整个 Arthas 都抬成全局可见。

这正是必须被打掉的失败方案。因为它会立刻破坏前面好不容易建立起来的隔离边界：

- 更多 Arthas 依赖进入公共空间；
- 污染面扩大；
- 卸载和降级边界变差；
- 业务类加载世界更容易和 Arthas 世界粘连。

所以真正合理的目标不是“让所有 Arthas 都全局可见”，而是：

**只把那个绝对必要、而且必须被所有增强代码共享的入口，缩到最薄，再把它抬成全局。**

### 5.3 `appendToBootstrapClassLoaderSearch` 到底解决了什么

答案就在 `ArthasBootstrap.java:209-232` 的 `initSpy()`：

- 先尝试 `parent.loadClass("java.arthas.SpyAPI")`；如果已经能加载，说明之前注入过，直接跳过；
- 否则执行 `instrumentation.appendToBootstrapClassLoaderSearch(new JarFile(spyJarFile))`（`ArthasBootstrap.java:227`）；
- 也就是把 `arthas-spy.jar` 追加进 **Bootstrap ClassLoader 的搜索路径**。

这一步真正解决的问题不是“换个地方放 jar”，而是：

```text
增强后的业务代码可能来自任何类加载器
  → 它们最终都要沿委派链往上找类
    → 只要 SpyAPI 在 Bootstrap 搜索路径里
      → 就能成为所有人共享的共同祖先入口
```

也就是说，Arthas 不是把整个 core 世界抬到了最上面，而是只把 `spy.jar` 里的那层极薄门面抬了上去。

### 5.4 为什么 `SpyAPI` 必须是一个极薄门面

再看 `spy/src/main/java/java/arthas/SpyAPI.java:24-27`，能看到几条非常关键的信号：

- 包名故意是 `java.arthas`；
- 只有 `volatile AbstractSpy spyInstance`；
- 有 `NOPSPY` 空对象兜底；
- 有 `INITED` 标志位。

这些设计都在指向同一件事：`SpyAPI` 被做得非常薄。

它不承载复杂业务逻辑，不自己变成 Arthas 本体，而只是承担：

```text
所有增强代码共同调用的静态门面
  → 再把调用转发给隔离空间里的真实实现
```

关键设计（斜体）：*真正必须全局可见的不是整个 Arthas，而只是一个极薄、可降级、可转发的静态门面。*[模式: 薄门面 + 空对象] 这样注入面被压到最小，业务代码依赖的是一个稳定的全局入口，而不是一整套随时可能和业务依赖打架的 core 世界。

这就是本篇真正要收住的顿悟：**Arthas 解决“全局可见性”的办法，不是把自己整个变成公共基础设施，而是把公共面缩到几乎只剩一个入口。**

---

## 六、第五层：如果双亲委派被破坏，为什么还要补 `enhanceClassLoader`

这里先给一个路标：前面讲的是常规主路径。只要类加载器体系还大致遵守委派链，把 `SpyAPI` 放进 Bootstrap 搜索路径通常就够了。接下来这一节讲的是**例外分支**：如果有人连这条链都故意破坏了怎么办。

### 6.1 为什么 Bootstrap 注入还不够覆盖所有极端场景

正常推理是：

- 业务代码会向上找类；
- `SpyAPI` 已经在 Bootstrap 搜索路径；
- 所以增强后的代码总能找到它。

但 Arthas 的作者显然不敢完全赌所有运行环境都这么规矩。如果某个自定义 ClassLoader 根本不按标准双亲委派走，连 Bootstrap 都不看，那前面的常规方案就会失效。

### 6.2 `enhanceClassLoader` 解决的是哪类问题

答案在 `ArthasBootstrap.java:234-262` 的 `enhanceClassLoader()`。

它默认不开：`configure.getEnhanceLoaders() == null` 时直接 return。这一点非常重要，因为它说明这不是常规路径，而是按需启用的兜底补丁。

启用之后，Arthas 会：

- 读取 `ClassLoader_Instrument.class` 模板字节码（`ArthasBootstrap.java:245-246`）；
- 配 `InstrumentConfig` 和 `SimpleClassMatcher(loaders)`（`ArthasBootstrap.java:248-249`）；
- 创建 `InstrumentTransformer`（`ArthasBootstrap.java:253`）；
- `addTransformer(..., true)`（`ArthasBootstrap.java:254`）；
- 必要时直接 `retransformClasses(ClassLoader.class)`（`ArthasBootstrap.java:258`）。

模板逻辑在 `server/instrument/ClassLoader_Instrument.java:13-23`：如果加载的类名以 `java.arthas.` 开头，就强制改用 `ClassLoader.getSystemClassLoader().getParent()` 去加载；否则回调原始 `loadClass`。

也就是说，它解决的不是常规委派链，而是：

```text
某些自定义 ClassLoader 故意不看 Bootstrap
  → 常规 SpyAPI 注入失效
    → 直接补丁它的 loadClass 逻辑
      → 遇到 java.arthas.* 时强制导向公共祖先链
```

关键设计（斜体）：*正常做法是把 `SpyAPI` 放在所有人都该能看到的地方；兜底做法则是，如果有人故意不看那个地方，就直接改它的找类路径。*[模式: 模板补丁 + 兜底重写] 所以 `enhanceClassLoader` 不是主路径，而是为了极端类加载器环境保留的一把后手。

---

## 收网：Arthas 不是把整套系统抬成全局，而是把入口缩成最小门面

现在把整条链收成一张图：

```text
1. 外部 JVM 通过 loadAgent(...) 把 arthas-agent.jar 投进目标 JVM
2. AgentBootstrap 接住 attach，请求幂等检查并还原参数协议
3. AgentBootstrap 创建 ArthasClassloader，把 arthas-core 隔离进自己的生存舱
4. 反射进入 ArthasBootstrap 单例，在隔离空间里完成系统装配
5. 只有 spy.jar 被追加进 Bootstrap 搜索路径
6. 所有增强后的业务代码都只依赖 SpyAPI 这个全局薄门面
7. 遇到破坏双亲委派的极端场景，再用 enhanceClassLoader 做兜底补丁
```

把这张图压成一句话，就是：

**Arthas 进 JVM 后不是把自己整套系统都变成公共依赖，而是把复杂逻辑关进隔离类加载器，只把 `SpyAPI` 这个最小必要入口提升成所有增强代码共享的全局门面。**

到这里为止，主线其实只发生了四件事：

- `AgentBootstrap` 足够薄，只负责接住 attach；
- `ArthasClassloader` 先解决“我自己怎么不和业务打架”；
- `ArthasBootstrap` 在隔离空间里完成完整装配；
- `SpyAPI` 被压缩成最小公共面，承担所有增强代码的共同入口。

这也解释了为什么 Arthas 后面的增强能力既能跨 ClassLoader 生效，又不必把整个 core 世界暴露给业务应用：**它不是把整个系统全局化，而是把真正必须全局化的那一层压缩到最薄。**

跨层标注：[OpenJDK 36-attach——`loadAgent` 最终如何进入目标 JVM]；[OpenJDK 47-instrumentation——`appendToBootstrapClassLoaderSearch` 与 `retransformClasses` 的 JVM 侧语义]；[ClassLoader——双亲委派、child-first 例外与 Bootstrap 搜索路径共同决定 SpyAPI 可见性]；[增强链——业务字节码并不依赖 arthas-core，而是依赖一个被提升的全局门面]

本篇解决的是“Arthas 怎么住下来，并把全局入口缩到最小”。下一篇继续进入另一条链：**住下来之后，这套寄生系统怎样真正开门营业，怎么绑定端口、生成密码、启动隧道，又怎样在 stop 时撤得干净？**

**→ 下一篇：端口、密码、隧道与销毁链。**
