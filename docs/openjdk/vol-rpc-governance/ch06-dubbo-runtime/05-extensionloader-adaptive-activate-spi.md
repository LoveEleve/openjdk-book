# Dubbo：ExtensionLoader、Adaptive 与 Activate SPI 机制

> 基于 Apache Dubbo 3.3.7-SNAPSHOT

## 一、困惑开场：Dubbo 为什么能动态拼出这么多实现

前几篇里，我们已经看到过很多实现名：`dubbo`、`tri`、`injvm`，`failover`、`random`，`execution`，还有一长串 provider/filter/listener。

问题是：这些名字从哪里来？为什么一个 `Protocol` 接口可以根据 URL 选择 Dubbo2、Triple 或 Injvm？为什么 `Filter` 不需要在代码里手动 new，却能自动出现在调用链？为什么同一个接口在不同 Module 或 Application 下，拿到的扩展实例可能还不一样？

如果你只把 Dubbo SPI 理解成“读取 `META-INF` 文件”，这些问题都解释不了。资源文件只负责告诉框架“有哪些候选实现”；真正把候选实现变成可运行对象的，是一整套扩展运行时：scope 管理、资源扫描、名称映射、实例缓存、Adaptive 路由、Activate 条件筛选、wrapper、依赖注入和生命周期。

所以本篇不做 Java SPI 教程，而是追踪一个扩展从接口声明到最终运行对象的完整形成过程。

## 二、前情回顾：前面那些协议和 Filter，都是这套机制装出来的

在前几篇里，`Protocol`、`Filter`、`Dispatcher`、`Cluster`、`LoadBalance` 都作为已经存在的扩展被使用过。

- `Protocol.export()` / `refer()` 需要根据 URL protocol 选择具体协议。
- `ProtocolFilterWrapper` 需要根据 URL 和 group 组装 Filter 链。
- `LoadBalance` 需要根据方法级配置选择 random、roundrobin 等实现。
- `Dispatcher` 需要根据 URL 中的 dispatcher 参数选择线程派发策略。

但前面关注的是这些扩展“被使用时做了什么”，没有回答它们“是怎么被找到、创建、包装和注入的”。

本篇把视角反过来：不再从某个 Protocol 或 Filter 的业务行为出发，而是从 `ExtensionLoader` 出发，解释 Dubbo 如何把一组类装配成前面那些运行链。

## 三、先走三条失败的路

### 失败方案一：Dubbo SPI 就是读取 Java SPI 文件

这只能解释“名字对应哪个类”，解释不了后面的运行行为。

Dubbo 的 Loader 不只是扫描资源文件，它还要处理：

- `@SPI` 默认名称和 scope
- 具体扩展实例缓存
- wrapper 排序与嵌套
- setter 依赖注入
- Adaptive 适配器
- Activate 条件和排序
- 生命周期初始化与销毁

所以资源文件只是输入，`ExtensionLoader` 才是运行时组装器。

### 失败方案二：`getAdaptiveExtension()` 就是默认扩展

这两个 API 的语义完全不同。

`getDefaultExtension()` 使用 `@SPI.value()` 里的固定名称，例如 `@SPI("dubbo")` 最终就是 `getExtension("dubbo")`。

`getAdaptiveExtension()` 返回的是一个适配器。它不会固定代表某个实现，而是在每次方法调用时根据 URL protocol 或参数 key 决定使用哪个实现。

所以默认扩展是“固定名称”，Adaptive 是“动态路由”。

### 失败方案三：`@Activate` 会自动加载所有标注类

`@Activate` 不是“看到注解就加载”。它只是声明“这个扩展允许被自动激活”。真正进入调用链之前，还要通过 group、URL 参数、`onClass`、order 和显式配置筛选。

同一个扩展可以在 provider 场景激活，在 consumer 场景不激活；也可以只有 URL 出现某个 key 时才激活。

## 四、最小总图：接口到最终实例的 ExtensionLoader 组装链

```text
@SPI 扩展接口
    ↓
ExtensionDirector 按 ScopeModel 找到 ExtensionLoader
    ↓
ExtensionLoader 扫描 META-INF/dubbo/internal 资源
    ↓
扩展名称 -> 实现类映射
    ↓
getExtension(name) / getDefaultExtension()
    ↓
原始实例创建与缓存
    ↓
依赖注入 / post processor
    ↓
wrapper 排序与嵌套
    ↓
Lifecycle.initialize()
    ↓
最终运行对象
```

Adaptive 和 Activate 是两条不同的旁路：

```text
getAdaptiveExtension()
    → URL key / protocol → getExtension(realName)

getActivateExtension(url, key, group)
    → group / value / onClass / order → 条件扩展列表
```

## 五、`@SPI` 与 `ExtensionDirector`：扩展契约和作用域

### 5.1 扩展接口必须声明 `@SPI`

`ExtensionDirector.getExtensionLoader(type)` 会先检查三件事：类型非空、类型必须是接口、接口必须带 `@SPI`。

`ExtensionDirector.java:67` — SPI/interface 校验

`@SPI` 本身提供两个关键元数据：

- `value()`：默认扩展名称
- `scope()`：扩展属于 framework、application、module 等哪个作用域

`SPI.java:56` — default name / scope

例如：

- `Protocol` 默认是 `dubbo`，Framework scope。
- `ProxyFactory` 默认是 `javassist`。
- `Cluster` 默认是 `failover`。
- `Dispatcher` 默认是 `all`。
- `Filter` 没有固定默认实现，通常通过 Activate 或显式配置进入。

### 5.2 为什么需要 `ExtensionDirector`

如果所有扩展都放在一个全局静态 map 中，多个 Application、Module 之间就无法隔离扩展实例和模型。

`ExtensionDirector` 管理的是一组 `ExtensionLoader`，并维护 parent/child scope 关系。查找时大致经过：

1. 当前 Director 本地缓存
2. 当前 scope 是否允许本地创建
3. 向 parent Director 查找
4. 必要时创建本地 Loader

`ExtensionDirector.java:80` — parent/local Director 查找

因此 Dubbo 的扩展实例不是简单的全局单例，而是和 ScopeModel 绑定的运行时对象。

## 六、`ExtensionLoader`：资源文件如何变成名称映射和实例缓存

### 6.1 资源扫描是延迟发生的

Loader 不会在框架启动时把所有扩展一次性实例化。第一次需要扩展类时，`getExtensionClasses()` 才触发 `loadExtensionClasses()`。

`ExtensionLoader.java:955` — lazy load extension classes
`ExtensionLoader.java:987` — LoadingStrategy 资源扫描

资源目录通常包含：

```text
META-INF/dubbo/internal/org.apache.dubbo.rpc.Protocol
```

其中的内容类似：

```text
tri=org.apache.dubbo.rpc.protocol.tri.TripleProtocol
injvm=org.apache.dubbo.rpc.protocol.injvm.InjvmProtocol
```

Loader 解析这些行，建立“扩展名称 → 实现类”的映射。

`ExtensionLoader.java:1045` — resource parsing

### 6.2 名称不是实现类的简单名称

扩展名称由资源文件显式指定最可靠。如果资源没有显式名称，Loader 还会尝试从 `@Extension` 或类名推导。

`ExtensionLoader.java:1139` — 支持 `name=class` 与旧式配置
`ExtensionLoader.java:1420` — 从类推导扩展名

所以扩展名称是运行时协议的一部分：

```text
URL protocol=tri
    → 扩展名称 tri
    → TripleProtocol
```

### 6.3 多级缓存不是重复设计

Loader 内部同时缓存：

- 实现类 → 原始实例
- 扩展名称 → 实现类
- 扩展名称 → 最终包装实例
- Adaptive class / Adaptive instance
- wrapper classes
- Activate 信息

`ExtensionLoader.java:117` — 核心缓存字段

这几类缓存服务于不同阶段：类缓存解决扫描，名称缓存解决查找，实例缓存解决复用，wrapper 后的最终实例则代表真正交给业务运行的对象。

## 七、固定扩展与 Adaptive 扩展

### 7.1 `getExtension(name)`：固定选择

调用：

```java
loader.getExtension("tri")
loader.getExtension("random")
loader.getExtension("failover")
```

Loader 会：

1. 按名称找到实现类
2. 创建或取得原始实例
3. 执行后处理器
4. 注入依赖
5. 应用 wrapper
6. 调用生命周期初始化
7. 缓存最终实例

`ExtensionLoader.java:549` — getExtension
`ExtensionLoader.java:772` — 实例创建
`ExtensionLoader.java:788` — wrapper/injection/lifecycle 组装

### 7.2 `getDefaultExtension()`：固定名称的快捷入口

`@SPI("dubbo")` 不等于接口直接持有 `DubboProtocol` 实例，它只是提供默认名称。`getDefaultExtension()` 最终还是调用：

```java
getExtension(cachedDefaultName)
```

`ExtensionLoader.java:595` — getDefaultExtension
`ExtensionLoader.java:1026` — 缓存默认扩展名

所以默认扩展的真实关系是：

```text
@SPI("dubbo")
    → default name = dubbo
    → getExtension("dubbo")
    → final wrapped instance
```

### 7.3 `getAdaptiveExtension()`：动态选择代理

Adaptive 扩展不是某个固定策略，而是一个实现了扩展接口的适配器。调用它的方法时，它会：

1. 从 URL 或参数对象中取得 URL
2. 按 `@Adaptive` key 查扩展名称
3. 调 `getExtension(realName)`
4. 转发调用

`ExtensionLoader.java:720` — getAdaptiveExtension
`ExtensionLoader.java:1449` — 手写/生成 Adaptive class

## 八、Adaptive：URL 如何决定具体实现

### 8.1 `@Adaptive` key 的优先级

```java
@Adaptive({"key1", "key2"})
```

生成的适配器会先查 `key1`，再查 `key2`，都没有时才使用 `@SPI` 默认名；没有默认名就抛错。

`Adaptive.java:37` — Adaptive 定义
`AdaptiveClassCodeGenerator.java:242` — Adaptive method generation

### 8.2 没写 key 时，用接口名推导

如果只写 `@Adaptive`，Generator 会把接口名转换成点分隔的小写 key。例如 `SimpleExt` 会被推导成 `simple.ext`。

`AdaptiveClassCodeGenerator.java:361` — interface name → key

### 8.3 `protocol` 是特殊 key

`Protocol` 的 Adaptive 方法通常根据 URL protocol 选择实现：

```text
url.protocol=dubbo → DubboProtocol
url.protocol=tri   → TripleProtocol
url.protocol=injvm → InjvmProtocol
```

这不是普通 URL parameter，而是直接读取 `url.getProtocol()`。

`AdaptiveClassCodeGenerator.java:271` — protocol 特殊处理
`Protocol.java:81` — Adaptive export
`Protocol.java:99` — Adaptive refer

### 8.4 参数对象也可以提供 URL

Adaptive 方法的参数不一定直接就是 URL。如果参数对象有 `getUrl()`，生成器会调用它取得 URL。

`AdaptiveClassCodeGenerator.java:381` — 参数 getter URL

所以 Adaptive 能适配的不只是：

```java
method(URL url)
```

也可以是：

```java
method(Holder holder)
```

只要 holder 能提供 URL。

## 九、Activate：条件扩展如何组装成 Filter 链

### 9.1 `@Activate` 只是允许自动激活

`@Activate` 可以声明：

- `group()`：provider/consumer 等调用场景
- `value()`：URL 参数 key
- `order()`：排序优先级
- `before()` / `after()`：相对顺序
- `onClass()`：类路径条件

`Activate.java:45` — Activate 定义

类上存在 `@Activate`，不表示它一定进入当前调用链。

### 9.2 `getActivateExtension()` 的筛选过程

调用通常类似：

```java
loader.getActivateExtension(url, key, group)
```

Loader 会：

1. 读取 URL 中的显式扩展名
2. 找出带 `@Activate` 的候选
3. 匹配 group
4. 匹配 URL value
5. 检查 onClass
6. 按 order 排序
7. 合并 default 和显式扩展配置

`ExtensionLoader.java:329` — getActivateExtension
`ExtensionLoader.java:364` — group 条件
`ExtensionLoader.java:471` — URL value 条件
`ActivateComparator.java:52` — 排序

### 9.3 `onClass` 是类路径筛选

`onClass` 检查发生在资源加载/扩展类筛选阶段。指定的依赖类不存在时，该扩展不会进入可激活候选，而不是先创建实例再失败。

`ExtensionLoader.java:1279` — onClass 检查

### 9.4 `default` 和删除语法

URL 显式扩展名支持：

```text
reference.filter=log,metrics
```

也支持：

```text
default
-default
-name
```

`default` 不是实际扩展名，而是自动激活扩展列表的插入位置。

`ExtensionLoader.java:406` — 显式扩展与 default 处理

### 9.5 Filter 链为什么要反向包装

`DefaultFilterChainBuilder` 先得到逻辑顺序的 Filter 列表，再从尾到头包装 invoker：

```java
for (int i = filters.size() - 1; i >= 0; i--) {
    last = new CopyOfFilterChainNode<>(originalInvoker, last, filter);
}
```

`DefaultFilterChainBuilder.java:68` — 反向构造 filter chain

这样最终调用顺序才是：

```text
Filter1 → Filter2 → Invoker
```

## 十、Wrapper、注入与生命周期：最终对象是怎样被组装出来的

### 10.1 Wrapper 的识别

Loader 会检查扩展类是否存在单参数构造器：

```java
public WrapperType(ExtensionType extension)
```

`ExtensionLoader.java:1393` — wrapper 构造器识别

`ProtocolFilterWrapper(Protocol protocol)` 和 `ProtocolListenerWrapper(Protocol protocol)` 都属于这种 wrapper。

### 10.2 Wrapper 应用顺序

创建最终扩展时，Loader 先创建原始实例，再按 `WrapperComparator` 排序，依次包裹，并完成注入和生命周期初始化。

`ExtensionLoader.java:788` — wrapper/injection/lifecycle 组装

因此最终的 Protocol 更接近：

```text
ProtocolListenerWrapper(
    ProtocolFilterWrapper(
        ConcreteProtocol
    )
)
```

具体外层顺序仍由 wrapper order 和 Loader 排序决定。

### 10.3 依赖注入

Loader 会扫描公开的单参数 setter，把属性名转换成依赖名称，再从 `ExtensionInjector` 获取依赖实例。

`ExtensionLoader.java:856` — setter injection

基本类型会跳过，`@DisableInject` 可以禁止注入；`ScopeModelAware`、`ExtensionAccessorAware` 等特殊接口不按普通 setter 处理。

### 10.4 生命周期与后处理

扩展创建前后支持 post processor；如果实例实现 `Lifecycle`，创建完成后会调用 `initialize()`，销毁时再清理原始实例、包装实例和缓存。

`ExtensionLoader.java:829` — post processor
`ExtensionLoader.java:911` — Lifecycle initialize
`ExtensionLoader.java:249` — destroy

这说明 `getExtension(name)` 返回的不是“资源文件中写的那个 class 的裸对象”，而是经过多阶段装配后的最终运行对象。

## 十一、真实运行示例：Protocol、Dispatcher、LoadBalance

### 11.1 Protocol

```text
Protocol$Adaptive
    ↓ URL protocol
ExtensionLoader<Protocol>
    ↓
ProtocolFilterWrapper / ProtocolListenerWrapper
    ↓
DubboProtocol / TripleProtocol / InjvmProtocol
```

### 11.2 LoadBalance

```java
@SPI("random")
@Adaptive("loadbalance")
```

URL 中的：

```text
loadbalance=random
loadbalance=roundrobin
```

会让 Adaptive LoadBalance 选择不同实现。

### 11.3 Dispatcher

`Dispatcher` 通过 `dispatcher`、兼容的 `dispather`、`channel.handler` 等 key 选择线程派发策略，默认是 `all`。

`Dispatcher.java:28` — 默认值与 Adaptive key

这几个例子共同说明：前面讲过的 Protocol、Filter、LoadBalance、Dispatcher，并不是彼此硬编码，而是都依赖同一套 ExtensionLoader 运行时。

## 十二、误解澄清

### 误解一：Dubbo SPI 只是读取资源文件

不是。资源文件只是名称到实现类的输入，最终对象还要经过缓存、wrapper、注入、后处理和生命周期。

### 误解二：`getAdaptiveExtension()` 就是默认实现

不是。默认实现是固定名称，Adaptive 是调用时根据 URL 动态选择的代理。

### 误解三：`@Activate` 会无条件加载所有扩展

不是。它还受 group、URL value、onClass、order 和显式配置语法影响。

### 误解四：Wrapper 和 Filter 是同一个层级

不是。Wrapper 包装的是 Protocol 等扩展，Filter chain 包装的是 Invoker；典型关系是 `Protocol wrapper -> Filter builder -> Filter -> Invoker`。

### 误解五：扩展实例是全局单例

不一定。`ExtensionDirector` 按 ScopeModel 管理 Loader，Framework/Application/Module scope 可能拥有不同的扩展上下文和实例缓存。

## 十三、收网总结：SPI 是 Dubbo 的运行时组装器

回到开头的问题：Dubbo 为什么能动态拼出 Protocol、Filter、Dispatcher、Cluster、LoadBalance 这些实现？

因为它没有把实现直接写死在业务主线上，而是建立了一条扩展运行时：

```text
@SPI 扩展契约
    ↓
ExtensionDirector scope
    ↓
ExtensionLoader 资源扫描
    ↓
名称/默认值映射
    ↓
getExtension / Adaptive / Activate
    ↓
wrapper / injection / post processor / lifecycle
    ↓
最终运行对象
```

**三句话总结：**

1. `ExtensionLoader` 不只是加载类，而是负责把资源、名称、实例、wrapper、注入和生命周期组装成最终运行对象。
2. `getExtension(name)` 是固定选择，`getAdaptiveExtension()` 是 URL 驱动的动态选择，`getActivateExtension()` 是带条件和排序的自动组装。
3. Dubbo 前面那些 Protocol、Filter、Dispatcher、Cluster 和 LoadBalance 之所以可以插拔，根本原因是它们都被压进了同一套 SPI 运行时。

**下篇预告：** 下一篇进入 Dubbo2 / Triple / Injvm 协议对照，看看共享同一套 `Protocol`/`Invoker` 窄腰的不同协议，最终如何在 wire path 上分叉。