# Dubbo：ScopeModel、ApplicationModel 与生命周期主线

> 基于 Apache Dubbo 3.3.7-SNAPSHOT

## 一、困惑开场：为什么 Dubbo 3.x 要多出这么多 Model

如果你第一次读 Dubbo 3.x 源码，很容易被一组名字绊住：`FrameworkModel`、`ApplicationModel`、`ModuleModel`、`ScopeModel`。直觉上它们很像“又多了一层抽象”，好像只是为了把代码分层写得更整齐。

但如果真只是这样，那前面几篇里出现的很多关键点就解释不通：

- 为什么 `ExtensionLoader` 不再是一个简单的 JVM 全局 SPI 缓存，而要挂在 `ExtensionDirector` 上？
- 为什么 `ServiceConfig.export()` 和 `ReferenceConfig.get()` 开头都要先触碰 `getScopeModel().getDeployer()`？
- 为什么 Spring 集成最终不是直接调 export/refer，而是去触发 `moduleModel.getDeployer().prepare()/start()`？

这些现象说明，Dubbo 3.x 的 model 层不是“类分层美化”，而是 runtime 的拥有权结构。它定义了：

- 谁拥有 SPI loader
- 谁拥有 config manager
- 谁拥有 service repository
- 谁来驱动 export/refer
- 谁在销毁时先走，谁后走

所以这篇文章要回答的，不是“类之间的继承关系”，而是：**为什么 Dubbo 3.x 必须用 model 树和 deployer 状态机把前面那些分散主线重新收束。**

## 二、前情回顾：前面几篇都在运行，但总时钟还没讲出来

在 export/refer 那篇里，我们已经看过 `ServiceConfig` 和 `ReferenceConfig` 如何把配置态推进到运行态。

在 SPI 那篇里，我们也看过 `ExtensionDirector` 和 `ExtensionLoader` 如何把扩展组装起来。

在 Spring 接入篇里，又看到 `@DubboService`、`@DubboReference` 最终落到 `moduleModel.getDeployer().prepare()/start()`。

这些篇章都已经在“用” model/lifecycle 体系，但还没有把它本身当作主角讲透。换句话说，前面我们已经看到了很多指针都指向同一个地方：`ScopeModel`、`ApplicationModel`、`ModuleModel` 和 deployer。

这里要先把定位钉死：**这篇不是再新增一条主线，而是把前面那些已经存在的主线，重新收回到同一个拥有权结构和启动时钟里。** 现在该回过头来，把这个“总时钟”本身建立起来。

## 三、先走三条失败的路

### 失败方案一：Model 只是为了分层命名，和运行时语义无关

如果 model 只是命名分层，那没必要把 `ExtensionDirector`、`ScopeBeanFactory`、destroy listeners、service repository、config manager、deployer 全都挂到它上面。

Dubbo 3.x 恰恰是反过来的：这些 model 的存在，是为了定义 **runtime ownership**。谁拥有扩展实例，谁拥有配置，谁有资格启动服务，谁有资格销毁上下文，都通过 model 树决定。

所以它不是“包一层好看”的对象，而是运行时边界。

### 失败方案二：Dubbo 3.x 只是把旧的全局单例拆成了更多对象，语义没变

如果语义没变，那 multi-application、多 module、scoped SPI、模块级 deployer 这些东西都没有必要存在。

`ApplicationModel` 的类注释已经把问题说得很清楚：旧时代很多能力（例如 `ExtensionLoader`、`DubboBootstrap` 等）都偏单例或进程级，如果要在一个进程里安全承载多套 Dubbo runtime，就必须重建作用域和生命周期。

所以 3.x 不是“对象更多了”，而是“所有权和边界被重做了”。

### 失败方案三：Spring 生命周期就是 Dubbo 生命周期

Spring 只是把对象接进来，并在恰当时机触发 prepare/start。真正 export/refer 的总时钟仍然是 deployer 状态机。

如果把 Spring 生命周期当成 Dubbo 生命周期，就会误以为 `ContextRefreshedEvent` 一发生，所有服务和引用都已经自然 ready；但实际上那只是 Dubbo deployer 被推进到某个阶段的时刻，后面还有 module state、completion、service register 等自己的过程。

## 四、最小总图：Model 树与 Deployer 状态机

先把整篇文章的最小总图压出来：

```text
FrameworkModel
    └─ ApplicationModel
         ├─ internal ModuleModel
         └─ public ModuleModel(s)

每个 ScopeModel 都有：
  - ExtensionDirector
  - ScopeBeanFactory
  - destroy listeners

ApplicationModel 还拥有：
  - Environment
  - ConfigManager
  - ServiceRepository
  - ApplicationDeployer

ModuleModel 还拥有：
  - ModuleConfigManager
  - ModuleServiceRepository
  - ModuleDeployer

启动时间线：
DubboBootstrap.start()
    ↓
ApplicationDeployer.start()
    ↓
ModuleDeployer.startSync()
    ↓
exportServices()
    ↓
referServices()
    ↓
registerServices()
    ↓
completion
```

这里最重要的一句要先钉死：**model 解决的是“谁拥有运行时状态”，deployer 解决的是“这些状态什么时候开始工作”。**

这也是全篇最重要的路标：看到 `FrameworkModel / ApplicationModel / ModuleModel` 时，先问 ownership；看到 `prepare / start / completion / stop` 时，先问 timing。两者相关，但不是同一个抽象层。

## 五、`ScopeModel`：Dubbo 3.x 的最小作用域骨架

### 5.1 `ScopeModel` 不是业务模型，而是运行时容器

`ScopeModel` 是三层 model 的共同父类。它不是拿来表达业务语义的，而是拿来承载一组 scoped 运行时基础设施：

- `ExtensionDirector`
- `ScopeBeanFactory`
- classloader 集合
- destroy listeners
- attributes

`ScopeModel.java:42` — ScopeModel 定位
`ScopeModel.java:100` — 初始化 `ExtensionDirector` / `ScopeBeanFactory`

所以 `ScopeModel` 更像“一个带作用域的运行时小容器”，而不是一个普通 POJO。

### 5.2 每个 scope 都有自己的 SPI 和 bean 世界

`ScopeModel.initialize()` 会创建一个新的 `ExtensionDirector`，其 parent 指向父 scope 的 director。这意味着：

- framework scope 拥有自己的扩展世界
- application scope 继承 framework scope，但可以有自己的扩展实例
- module scope 再继承 application scope

这就是 scoped SPI 的根。

为什么一定要这么做，而不是继续沿用“全局 SPI + 命名隔离”？因为后者只能解决“名字别撞车”，解决不了“实例归属谁、销毁时谁先谁后、不同 application/module 下是否应该共享同一个扩展对象”这些真正的 runtime 问题。Dubbo 3.x 要的是拥有权隔离，而不是字符串级别的命名规避。

`ScopeModel.java:102` — `new ExtensionDirector(parent.getExtensionDirector(), scope)`

### 5.3 destroy 也是 scoped 的

`ScopeModel.destroy()` 的流程不是“清空几个字段”，而是统一执行：

1. `onDestroy()`
2. 移除 classloader
3. `beanFactory.destroy()`
4. `extensionDirector.destroy()`

`ScopeModel.java:117` — destroy 主流程

所以每个 scope 自己就带着完整的资源回收边界。

## 六、Framework / Application / Module：谁拥有什么

### 6.1 `FrameworkModel`：最上层 runtime 根

`FrameworkModel` 的类注释明确写着：它可以被多个 application 共享。它不是“当前应用”，而是“整个 Dubbo runtime 树的根”。

`FrameworkModel.java:40` — 可承载多个 application

它还会在构造时创建一个 internal application model。

`FrameworkModel.java:101` — internal application model

从设计上看，FrameworkModel 解决的是：哪些资源必须跨 application 共享，哪些应该下沉到 application/module。

### 6.2 `ApplicationModel`：应用级拥有权

`ApplicationModel` 挂在 `FrameworkModel` 下面，负责应用级资源：

- `Environment`
- `ConfigManager`
- `ServiceRepository`
- `ApplicationDeployer`
- modules 集合

`ApplicationModel.java:53` — application-level fields
`ApplicationModel.java:111` — internal module

这里还保留了一个 internal module，用来在正式 public modules 还没 fully active 之前承载一些内部服务和准备动作。

### 6.3 `ModuleModel`：服务分组和 export/refer 的直接边界

`ModuleModel` 挂在 `ApplicationModel` 下，拥有：

- `ModuleConfigManager`
- `ModuleServiceRepository`
- `ModuleDeployer`

`ModuleModel.java:40` — module-level fields

前面写过的 `ServiceConfig` / `ReferenceConfig`，最终更直接挂靠的就是 module scope，而不是 framework root。

## 七、Deployer：谁来驱动 prepare / start / completion

### 7.1 deployer 不是临时 helper，而是 model 初始化时挂进去的

`ConfigScopeModelInitializer` 会在 model 初始化时，把 `DefaultApplicationDeployer` 挂到 application，把 `DefaultModuleDeployer` 挂到 module。

`ConfigScopeModelInitializer.java:39` — 给 app/module 挂 deployer

所以 deployer 不是某个启动时临时 new 出来的 helper，而是 model 树自带的运行时角色。

### 7.2 `DefaultApplicationDeployer`：应用级总协调者

`DefaultApplicationDeployer.initialize()` 负责的不是某一个 service 的导出，而是整个应用级准备工作：

- 注册 shutdown hook
- 启动 config center
- 加载 application configs
- 初始化 module deployers
- 初始化 metrics
- 启动 metadata center

`DefaultApplicationDeployer.java:209` — initialize

`start()` 之后，它会推进 modules 的启动，先准备 internal module，再启动 public modules。

`DefaultApplicationDeployer.java:676` — start
`DefaultApplicationDeployer.java:764` — startModules

### 7.3 `DefaultModuleDeployer`：真正推动 export/refer 的总时钟

module 级 deployer 的主流程最值得记：

```text
startSync()
  -> initialize()
  -> exportServices()
  -> prepareInternalModule()
  -> referServices()
  -> registerServices()
  -> completion
```

`DefaultModuleDeployer.java:162` — startSync
`DefaultModuleDeployer.java:176` — exportServices
`DefaultModuleDeployer.java:186` — referServices
`DefaultModuleDeployer.java:189` — completion 前后语义

这条时间线把前面我们拆开的多条主线重新收了回来：

- export/refer 不再是“谁想调就调”的分散动作  
- 它们被纳入 module 启动状态机  
- completion 还比 started 多一步“后续动作都做完了”  

### 7.4 `STARTED` 与 `COMPLETION` 不是重复状态

这是一个非常容易看轻的细节。

`DeployState` 明确定义了：`PENDING`、`STARTING`、`STARTED`、`COMPLETION`、`STOPPING`、`STOPPED`、`FAILED`。

`DeployState.java:22` — 状态枚举
`AbstractDeployer.java:35` — 状态机基础实现

`STARTED` 表示已经启动到可运行阶段，但 `COMPLETION` 表示后续的 export/refer/register/check 等动作也都走完了。对生产排障来说，二者不是同义词。

这条区别在线上特别有用：你可能看到服务已经开始对外响应，或某些引用已经可用，于是以为“系统都 ready 了”；但如果还没到 `COMPLETION`，后面的注册、引用检查、模块级收尾动作可能还没结束。也就是说，`STARTED` 更像“能跑了”，`COMPLETION` 才更接近“这一轮启动后处理也收完了”。

## 八、前面几篇内容怎么回到这条骨架上

### 8.1 export/refer 主线回到 `ModuleDeployer`

`ServiceConfig.export()` 和 `ReferenceConfig.get()` 在 3.x 里都会先触碰 `getScopeModel().getDeployer()`，必要时触发 `prepare()` 或 `start()`。

`ServiceConfig.java:324` — `ServiceConfig` 进入 deployer lifecycle
`ReferenceConfig.java:228` — `ReferenceConfig` 进入 deployer lifecycle

这说明 export/refer 不再是裸 API，而是被 model/deployer 主线兜住了。

### 8.2 SPI 主线回到 `ScopeModel`

上一篇里我们已经知道 `ExtensionDirector`/`ExtensionLoader` 是 Dubbo 扩展运行时的核心。现在再看，会发现它们不是全局单例，而是每个 `ScopeModel` 自己拥有一套 loader 树。

`ExtensionDirector.java:27` — scoped extension loader manager
`ExtensionDirector.java:67` — scope-based loader resolution

也就是说，SPI 的作用域问题，在这一篇里终于有了总归宿。

### 8.3 Spring 接桥回到 deployer

Spring integration 那篇里最关键的两个 listener：

- `DubboConfigApplicationListener` 调 `moduleModel.getDeployer().prepare()`
- `DubboDeployApplicationListener` 调 `moduleModel.getDeployer().start()`

`DubboConfigApplicationListener.java:84` — Spring 触发 prepare

这说明 Spring 不是另一个 runtime，而是把容器生命周期桥接回 model/deployer 主线。

## 九、destroy 顺序与多应用隔离

### 9.1 `ApplicationModel.onDestroy()` 的顺序不是随意的

应用级销毁时，顺序大致是：

1. 从 framework 上摘掉自己
2. `deployer.preDestroy()` 先让服务下线
3. framework 尝试销毁 protocols
4. destroy public modules
5. destroy internal module
6. `deployer.postDestroy()`
7. destroy listeners / environment / config / repository
8. 必要时 destroy framework

`ApplicationModel.java:145` — onDestroy 主顺序

这不是形式主义。它保证了：

- 服务先下线  
- 再回收 module 级对象  
- 最后再考虑 framework 级共享资源  

### 9.2 `FrameworkModel.tryDestroyProtocols()` 为什么保守

Framework 级 protocol 不是想删就删。源码里明确说明，protocol 是特殊的共享资源，只有当没有 public application model 留下时，framework 才会尝试销毁它们。

`FrameworkModel.java:272` — tryDestroyProtocols 保守策略

这恰恰说明了 model 树存在的意义：共享资源和局部资源必须在销毁时有不同边界。

## 十、误解澄清

### 误解一：Model 只是命名分层

不是。它们定义的是 runtime ownership：SPI、bean、config、service repository、deployer、destroy 边界都挂在 model 上。

### 误解二：`ApplicationModel` 就是“整个 JVM 里唯一一个应用”

不是。它挂在 `FrameworkModel` 下，而 `FrameworkModel` 允许多 application 并存。

### 误解三：`ModuleModel` 就是 Maven module

不是。它是 Dubbo 的运行时服务分组作用域，和构建工具概念不是一回事。

### 误解四：Spring 生命周期就是 Dubbo 生命周期

不是。Spring 只是桥接 prepare/start 的触发时机，真正的 export/refer/complete/stop 仍由 deployer 控制。

### 误解五：`STARTED` 和 `COMPLETION` 重复

不是。`STARTED` 代表已经启动起来，`COMPLETION` 代表 export/refer 等后续动作也完成了。

### 误解六：我看到 `DubboBootstrap.start()` 了，就等于整个 runtime 已经 ready

不是。`DubboBootstrap.start()` 只是 facade 入口，真正的准备、模块启动、export/refer、register、completion 都还要继续沿着 application/module deployer 的状态机往下推进。看到 `start()` 被调用，只能说明总时钟开始走了，不能说明所有 runtime 语义都已经就绪。

## 十一、收网总结：这一篇是前面所有主线的总时钟

回到开头的问题：为什么 Dubbo 3.x 要多出这么多 Model？

因为前面几篇里看起来平行的那些主线——export/refer、SPI、Spring 接桥、config manager、service repository——需要一个统一的拥有权结构和启动时钟。不然它们就会重新退回到“JVM 全局单例 + 松散初始化 + 难以多应用隔离”的旧模式。

所以这篇真正应该记住的是：

- `ScopeModel` 提供 scoped bean / SPI / destroy 边界  
- `FrameworkModel / ApplicationModel / ModuleModel` 定义谁拥有谁  
- `DefaultApplicationDeployer / DefaultModuleDeployer` 决定什么时候开始工作  

**三句话总结：**

1. Dubbo 3.x 的 model 树不是额外抽象，而是 runtime ownership 结构。  
2. deployer 不是启动辅助类，而是 export/refer/complete/stop 的总时钟。  
3. 前面所有主线——SPI、config、Spring、export/refer——都要回到 model/deployer 才能真正收束成一个统一 runtime。  

**下篇说明：** 到这里，Dubbo baseline 主线、协议对照、集成桥和生命周期骨架已经形成第一轮闭环；继续扩展的话，可进入注册发现控制面或生产诊断层。