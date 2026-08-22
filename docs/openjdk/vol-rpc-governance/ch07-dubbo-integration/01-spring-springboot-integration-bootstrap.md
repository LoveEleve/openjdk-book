# Dubbo：Spring / Spring Boot 接入桥

> 基于 Apache Dubbo 3.3.7-SNAPSHOT

## 一、困惑开场：为什么“用了注解”并没有绕过 Dubbo 主线

第一次用 Dubbo 的开发者，通常接触到的是两类注解：

- provider 侧的 `@DubboService`
- consumer 侧的 `@DubboReference`

表面上看，事情似乎很简单：标个注解，Spring 一启动，服务就自动暴露了；字段一注入，远程代理也自动可用了。

但如果真的是这样，前面那几篇关于 `ServiceConfig`、`ReferenceConfig`、`Invoker`、`Protocol`、`Cluster`、`Remoting` 的文章几乎都不需要存在。事实并不是这样。

Spring 和 Spring Boot 在 Dubbo 里真正做的，不是“代替主线”，而是“接上主线”。它们负责把注解、BeanDefinition、外部化配置和容器生命周期翻译成 Dubbo 认识的运行时对象，再让 `ServiceConfig` / `ReferenceConfig` / deployer 去走真正的 export/refer 主线。

所以这篇文章要回答的不是“注解怎么写”，而是：**Spring 这一层到底把什么翻译成了什么。**

## 二、前情回顾：前面讲的是运行时主线，这一篇讲它怎么接到 Spring 容器里

在第一篇里，我们已经知道 provider/export 和 consumer/refer 的入口实际上是 `ServiceConfig` 与 `ReferenceConfig`。第二篇到第六篇又把 `Invoker` 窄腰、Directory/Cluster、Remoting、SPI、具体协议分叉这些运行时主线一层层拆开了。

这里要先把顺序钉死：**先有 Dubbo runtime 主线，后有 Spring/Boot 把这些主线对象翻译进容器。** Spring 不是 Dubbo 的前提层，而是接入层。

但普通用户不是先手写 `ServiceConfig.export()`，也不是手动 new `ReferenceConfig` 再 `get()`。更多时候，他们是：

- 在 Spring 里加一个 `@EnableDubbo`
- 写一个 `@DubboService`
- 注入一个 `@DubboReference`
- 再在 Spring Boot 里配一些 `dubbo.*` 属性

所以这篇文章不再讨论运行时内部如何执行，而是回答另一个问题：**这些 Spring 层的入口，最终是怎么回接到我们前面已经建立的 Dubbo runtime 主线上的。**

## 三、先走三条失败的路

### 失败方案一：`@DubboService` 直接调用了 `ServiceConfig.export()`

这是最容易形成的直觉：既然 `@DubboService` 的效果是“服务被导出”，那它大概会在注解处理阶段直接触发 `export()`。

但如果真这么做，Spring 注解扫描时就会提前进入运行时导出阶段，BeanFactory 尚未完整，配置来源还没全部合并，deployer 生命周期也还没接上。

Dubbo 的实际做法完全不同：先把注解翻译成一个 `ServiceBean` BeanDefinition；`ServiceBean` 本身是 `ServiceConfig` 的 Spring 包装；然后再等 Spring 容器和 deployer 生命周期合适的时候，统一让这些 `ServiceBean` 进入真正的 export 主线。

所以 `@DubboService` 不是“直接导出”，而是“注册了一个等待导出的 Dubbo 运行时入口对象”。

### 失败方案二：`@DubboReference` 注入字段时，就已经连上了远端

很多人看到字段里已经有对象了，就自然认为“远端引用已经完成了”。

但 Spring 注入进来的通常不是一个已经把 registry、directory、cluster、transport 全链路跑完的最终远程调用结果，而是 `ReferenceBean` 产出的 lazy proxy。它可以在合适时机预热，也可以在首次真正调用时再兜底初始化。

所以“字段里已经有 proxy”不等于“远端一定已经完全准备好”。

### 失败方案三：Spring Boot 重写了一套 Dubbo 接入逻辑

Spring Boot 的自动配置很显眼，所以很多人会误以为 Boot 模块自己实现了一套 Dubbo 接入主线。

实际并不是。Boot 更多做的是：

- 自动启用 `@EnableDubboConfig`
- 绑定 `dubbo.*` 配置属性
- 根据是否配置扫描包决定是否注册 `ServiceAnnotationPostProcessor`

真正把注解翻成 `ServiceBean` / `ReferenceBean`、真正把这些对象纳入 deployer 生命周期的，还是 `dubbo-config-spring` 里的那批 processor、listener 和 initializer。

所以 Boot 是入口外壳，不是第二套 Dubbo runtime。

## 四、最小总图：Spring 注解 / 配置怎样接到 Dubbo runtime

```text
Spring annotations / Boot config
    ↓
@EnableDubbo / @DubboService / @DubboReference / dubbo.*
    ↓
DubboComponentScanRegistrar / DubboSpringInitializer
    ↓
ServiceAnnotationPostProcessor
ReferenceAnnotationBeanPostProcessor
DubboConfigApplicationListener
DubboDeployApplicationListener
    ↓
ServiceBean / ReferenceBean
ReferenceBeanManager / ConfigManager
    ↓
moduleModel.getDeployer().prepare() / start()
    ↓
ServiceConfig.export() / ReferenceConfig.get()
    ↓
Dubbo runtime spine
```

这张图里最重要的不是类名，而是边界：

- Spring 负责扫描、翻译、注册 BeanDefinition 和接生命周期。
- Dubbo runtime 负责真正的 export/refer。
- 中间的桥梁对象是 `ServiceBean`、`ReferenceBean`、`ReferenceBeanManager` 和 deployer。

这里再加一句路标：**Spring 这一层不会改写 Dubbo runtime 主线，它只负责把 Spring 世界里的 bean、annotation、配置和值对象翻译成 Dubbo runtime 认识的入口对象。** 后面看到 `ServiceBean`、`ReferenceBean`、listener 和 deployer 时，都要带着这个边界去读。

## 五、`@EnableDubbo` 和 `DubboSpringInitializer`：桥从哪里开始

### 5.1 `@EnableDubbo` 不是魔法开关，而是 Import 入口

`@EnableDubbo` 本质上是一个组合注解。它通过 `@EnableDubboConfig` 和 `@DubboComponentScan` 把 Dubbo Spring 基础设施接进容器。

`EnableDubbo.java:44` — `@EnableDubbo`
`DubboComponentScan.java:42` — component scan 入口

也就是说，`@EnableDubbo` 自己不 export、也不 refer。它只是打开扫描和配置注册入口。

### 5.2 `DubboComponentScanRegistrar` 和 `DubboSpringInitializer`

`DubboComponentScanRegistrar` 是更真实的入口。它在 registrar 阶段先初始化 Dubbo Spring 基础设施，再注册 `ServiceAnnotationPostProcessor`。

`DubboComponentScanRegistrar.java:62` — registrar 初始化

`DubboSpringInitializer.initialize(...)` 则把当前 Spring 容器与 Dubbo 的 `ApplicationModel` / `ModuleModel` 绑定起来，并注册一批基础设施 Bean。

`DubboSpringInitializer.java:51` — initializer 入口
`DubboBeanUtils.java:67` — common beans 注册

这里第一次出现了全篇最重要的桥接动作：**Spring 容器不再只是一个 BeanFactory，它开始携带 Dubbo 的 ScopeModel / ModuleModel 上下文。**

## 六、`@DubboService`：注解怎样变成 `ServiceBean`

### 6.1 扫描与候选识别

`ServiceAnnotationPostProcessor` 会扫描类级和方法级的 `@DubboService`。

`ServiceAnnotationPostProcessor.java:169` — 扫描入口
`ServiceAnnotationPostProcessor.java:205` — 候选类处理

这一步仍然停留在 Spring BeanDefinition 世界，还没有真正进入 Dubbo export 主线。

### 6.2 注解属性翻译成 `ServiceBean` 定义

扫描到 `@DubboService` 后，processor 会生成 `ServiceBean` 的 BeanDefinition：

- 普通注解属性通过 `AnnotationPropertyValuesAdapter` 写入  
- `ref` 指向原始 Spring 服务 Bean  
- `interface` / `interfaceName` 被明确填入  
- `parameters`、`methods`、`providerIds`、`registryIds`、`protocolIds` 等做专门处理  

`ServiceAnnotationPostProcessor.java:359` — serviceBeanName 构造
`ServiceAnnotationPostProcessor.java:453` — `ServiceBean` BeanDefinition 构造
`ServiceAnnotationPostProcessor.java:483` — ref / interface 注入

### 6.3 `ServiceBean` 不是“另一个配置类”

`ServiceBean` 直接 `extends ServiceConfig<T>`。也就是说，Spring 层不是发明了一套独立的 provider 模型，而是给 `ServiceConfig` 包了一层容器集成壳。

`ServiceBean.java:42` — `ServiceBean extends ServiceConfig`

它在 `afterPropertiesSet()` 里做的事情也不是 export，而是把自己注册到 `ConfigManager`，再把 deployer 标成 pending。

`ServiceBean.java:111` — `afterPropertiesSet()` 注册 ConfigManager

为什么不能在扫描阶段直接 export？因为那时：

- Spring 容器里的其他基础设施 Bean 可能还没稳定  
- 外部化配置和属性合并还没完全落下  
- deployer 的 prepare/start 时序还没接上  
- provider/consumer 可能还要统一纳入同一个模块生命周期

如果在注解扫描阶段就直接 export，Spring 生命周期和 Dubbo 生命周期就会纠缠在一起，很多后续初始化都会失序。所以 `@DubboService` 的真正语义是：**把一个 Spring Bean 翻译成一个等待被 deployer 接管的 `ServiceConfig`。**

## 七、`@DubboReference`：注解怎样变成 `ReferenceBean` 和 lazy proxy

### 7.1 `ReferenceAnnotationBeanPostProcessor` 的双职责

它既是 BeanFactory 后处理器，又是注入处理器。

- 在 BeanDefinition 阶段，它扫描并注册 `ReferenceBean` 定义。  
- 在注入阶段，它把 `ReferenceBean` 产出的对象注入字段或 setter。  

`ReferenceAnnotationBeanPostProcessor.java:76` — 双职责注释
`ReferenceAnnotationBeanPostProcessor.java:139` — post processor 位置

### 7.2 先注册 `ReferenceBean`，不是先造 `ReferenceConfig`

`prepareInjection()` 最终会调用 `registerReferenceBean(...)`。这里做的不是立即构造远程引用，而是：

1. 把注解属性统一归一化为 Dubbo reference 属性  
2. 生成 referenceKey  
3. 通过 `ReferenceBeanManager` 处理同 key 复用 / 重命名 / alias  
4. 注册一个 `ReferenceBean` 的 BeanDefinition

`ReferenceAnnotationBeanPostProcessor.java:379` — `prepareInjection()`
`ReferenceAnnotationBeanPostProcessor.java:414` — `registerReferenceBean(...)`
`ReferenceAnnotationBeanPostProcessor.java:538` — 注册 `ReferenceBean` 定义
`ReferenceBeanSupport.java:63` — 注解属性归一化
`ReferenceBeanSupport.java:124` — referenceKey 生成

### 7.3 注入到字段里的是什么

当真正往字段里塞值时，`doGetInjectedBean()` 并不是 new 一个代理，而是直接从 BeanFactory 拿 `ReferenceBean` 对应的 bean。

`ReferenceAnnotationBeanPostProcessor.java:570` — 注入时 `getBean(referenceBeanName)`

而 `ReferenceBean.getObject()` 返回的是一个 lazy proxy。

`ReferenceBean.java:201` — lazy proxy 创建

这就是为什么拿到注入对象不等于“远端已经完成了所有初始化”——因为你手里拿着的是一个延迟求值的桥接对象。

这一点对线上排障很关键：当你在 Spring 容器里能看到这个 Bean，甚至字段已经成功注入，并不意味着 registry、directory、cluster、transport 那边已经全部 ready。很多“Bean 都在，怎么第一次调用还失败/还慢/还去初始化”的问题，根源都在于这里注入的是 lazy proxy，而不是已经跑完整条 refer 链的最终事实。

## 八、`ReferenceBeanManager`：注解注入点如何收拢成少量 `ReferenceConfig`

### 8.1 `ReferenceBean` 只是 Spring 包装，不是最终引用对象

`ReferenceBean.afterPropertiesSet()` 会把自己的 interface 和 referenceProps 收回，再注册进 `ReferenceBeanManager`。这一步依然没有真正调用 `ReferenceConfig.get()`。

`ReferenceBean.java:230` — `afterPropertiesSet()`
`ReferenceBean.java:272` — 注册到 manager

### 8.2 `ReferenceBeanManager.initReferenceBean()` 才创建 `ReferenceConfig`

真正的 Dubbo runtime 对象是在 manager 里创建的：

- 根据 referenceKey 判断是否复用 `ReferenceConfig`  
- 通过 `ReferenceCreator.create(...).build()` 构建引用配置  
- 注册进 `ConfigManager`  
- 标记 deployer pending

`ReferenceBeanManager.java:166` — initReferenceBean
`ReferenceBeanManager.java:197` — 创建并注册 `ReferenceConfig`

这一步说明一个关键事实：**多个 `@DubboReference` 注入点，不一定对应多个独立的 `ReferenceConfig`。** Spring 层会先做归并与复用。

## 九、Spring 生命周期如何接回 Dubbo deployer

### 9.1 提前注册基础设施

`DubboInfraBeanRegisterPostProcessor` 会在更早的阶段主动把 `ReferenceAnnotationBeanPostProcessor` 等基础设施拉进 BeanFactory，保证它们足够早生效。

`DubboInfraBeanRegisterPostProcessor.java:55` — 提前注册 ReferenceAnnotationBeanPostProcessor

### 9.2 `DubboConfigApplicationListener`：先 prepare

在 `DubboConfigInitEvent` 时，`DubboConfigApplicationListener` 会加载配置并执行：

```text
moduleModel.getDeployer().prepare()
```

`DubboConfigApplicationListener.java:72` — 配置初始化与 prepare

这一步把 `ServiceBean` / `ReferenceBean` 之类桥接对象正式带入 Dubbo 模块生命周期。

### 9.3 `DubboDeployApplicationListener`：再 start

等 Spring 容器真正刷新完成，`DubboDeployApplicationListener` 才在 `ContextRefreshedEvent` 时调用：

```text
moduleModel.getDeployer().start()
```

`DubboDeployApplicationListener.java:160` — ContextRefreshedEvent 时 start

所以 export/refer 不在注解扫描时发生，也不在 BeanDefinition 注册时发生，而是在容器生命周期后段统一推进。

## 十、Spring Boot：它做了什么，没做什么

### 10.1 Boot 自动配置主要是入口外壳

`DubboAutoConfiguration` 的核心动作是：

- 打开 `@EnableDubboConfig`  
- 如果配置了扫描包，就注册 `ServiceAnnotationPostProcessor`  
- 让 `dubbo.*` 属性绑定成对应 Config Bean

`DubboAutoConfiguration.java:53` — Boot 自动配置
`DubboAutoConfiguration.java:62` — 条件注册 ServiceAnnotationPostProcessor
`spring.factories:1` — Boot 自动配置入口
`AutoConfiguration.imports:1` — 新式自动配置入口

### 10.2 Boot 没有重写主线

Boot 没有重新发明 `ServiceBean`、`ReferenceBean`、`ReferenceBeanManager`、deployer，也没有自己 export/refer。

它做的是“把 Spring Boot 世界里的属性绑定、扫描入口和生命周期外壳接到 `dubbo-config-spring` 已有那套桥接逻辑上”。

所以这篇文章最重要的边界句就是：**Boot 负责把门打开，真正过桥的还是 Spring 集成层和 Dubbo runtime 本身。**

## 十一、误解澄清

### 误解一：`@DubboService` 会直接触发 export

不是。它先变成 `ServiceBean` BeanDefinition，再注册进 `ConfigManager`，最后由 deployer 生命周期统一驱动 export。

### 误解二：`@DubboReference` 注入字段时已经连上了远端

不是。注入进来的通常是 `ReferenceBean` 产出的 lazy proxy，真正 `ReferenceConfig.get()` 可能在预热或首次调用时才完成。

### 误解三：Spring / Boot 重新实现了一套 Dubbo runtime

不是。它们只是桥接层，把注解和配置翻译成 Dubbo runtime 入口对象，并接上 deployer 生命周期。

### 误解四：`ReferenceBeanManager` 缓存的是代理对象本身

不完全对。它更核心的职责是对 `ReferenceBean` / `ReferenceConfig` 做 key 级复用和去重，而不是简单缓存业务代理。

### 误解五：有了 Boot 自动配置，就不需要理解 `ServiceConfig` / `ReferenceConfig`

也不是。Boot 只是入口外壳，真正的 export/refer 主线仍然落在 `ServiceConfig` 和 `ReferenceConfig` 上。

### 误解六：我在 Spring 容器里看到 Bean 了，就等于 Dubbo runtime 也 ready 了

不是。Spring Bean 的存在，只能说明桥接对象已经被注册/注入；它不保证 provider 已经 export 完毕，也不保证 reference 已经把 registry、directory、cluster 和 transport 整条链都准备好。特别是 `ReferenceBean` 场景，字段里拿到的常常只是 lazy proxy，不是“远端已就绪”的证明。

## 十二、收网总结：Spring 不是第二套 runtime，而是一座桥

回到开头的问题：为什么“用了注解”并没有绕过 Dubbo 主线？

因为 Spring 和 Spring Boot 做的不是 export/refer 本身，而是把注解、配置和容器生命周期翻译成 Dubbo 认识的运行时对象，再把它们接进 deployer 主线。

- `@DubboService` → `ServiceBean(ServiceConfig)`  
- `@DubboReference` → `ReferenceBean` / `ReferenceConfig` / lazy proxy  
- `DubboConfigApplicationListener` / `DubboDeployApplicationListener` → `moduleModel.getDeployer().prepare()/start()`

**三句话总结：**

1. Spring / Boot 集成的本质不是“代替 Dubbo 主线”，而是“把 Spring 世界翻译成 Dubbo runtime 入口对象”。  
2. `ServiceBean` 和 `ReferenceBean` 是两座最关键的桥，前者把 provider bean 接到 `ServiceConfig`，后者把注解引用接到 `ReferenceConfig` 和 lazy proxy。  
3. Boot 自动配置只是入口外壳，真正的桥接主战场仍然在 `dubbo-config-spring` 里。  

**下篇预告：** 下一篇可以进入 `配置合并、外部化与 URL 生成`，把 `application/module/provider/consumer/service/reference` 这些多层配置怎样压成最终 URL 再打透。