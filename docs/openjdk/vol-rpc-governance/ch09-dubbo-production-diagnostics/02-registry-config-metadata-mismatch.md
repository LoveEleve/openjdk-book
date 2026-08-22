# Dubbo：Registry / Config / Metadata 失配问题分析

> 基于 Apache Dubbo 3.3.7-SNAPSHOT

## 一、困惑开场：为什么控制面已经变了，运行态却还是老样子

生产环境里最让人无从下手的一类 Dubbo 问题，不是有堆栈的失败，而是“控制面说一套，运行态表现另一套”。

你查注册中心，provider 地址已经有了；你查配置中心，规则也推成功了；你再查 metadata，revision 都更新了。按直觉看，consumer 应该已经在走新配置、新地址、新路由了。

但现实里经常不是这样：

- registry 里有地址，consumer 还是 `No provider available`  
- 新 provider 已上线，调用仍然走旧 invoker  
- config center 规则已推，timeout / route / loadbalance 还像旧配置  
- metadata 已更新，consumer 行为却还像旧发现模型  

这些问题的根源不是“Dubbo 控制面没推到”，而是：**控制面改写的是不同层次的运行态对象，而这些对象不会在同一时刻一起切换。**

## 二、前情回顾：前面三篇已经讲过控制面，这一篇只看失配

在 `RegistryProtocol / RegistryDirectory` 那篇里，我们已经看过一条单链路：registry notify 如何分成 providers / routers / configurators，最后更新 live invokers。

在 migration 那篇里，我们又看过旧的接口级路径和新的应用级发现路径如何共存，并通过 `MigrationInvoker` 切换 `currentAvailableInvoker`。

在 config center 那篇里，我们也已经知道 configurator 规则会把 URL 语义改掉，不需要地址变化。

这一篇不再重讲这三条链各自怎么工作，而是把它们重新投影到一组 runtime 对象上：`directoryUrl`、`urlInvokerMap`、`serviceUrls`、`currentAvailableInvoker`。也就是说，**这篇不是讲控制面主线，而是讲“控制面变化到底落在了哪个对象上”。**

当这三条链在真实系统里一起发生变化时，运行态对象往往不会同步更新，于是就会出现“控制面已经变了，调用却还是老样子”的失配现象。

## 三、先走三条失败的路

### 失败方案一：控制面推送成功，就等于运行态已经切换成功

这是最常见的误判。

控制面把地址、规则、metadata 推到 Dubbo，并不等于：

- `urlInvokerMap` 已经更新好了  
- `directoryUrl` 已经重算完了  
- `RouterChain` 的 cache 已经切换完了  
- `currentAvailableInvoker` 已经切到新子树了  

控制面事件到达只是开始，后面还有对象图更新、缓存刷新、切换和旧对象回收。

### 失败方案二：registry 有地址，consumer 就应该一定能调

这会把“registry URL list”误当成“当前可调用 invoker 视图”。

但在运行时，中间至少还隔着这些步骤：

- 协议兼容检查  
- `protocol.refer()` 生成 invoker  
- router 裁剪  
- forbidden / empty protection  
- consumer 本地可用性筛选  

所以 registry 有地址，不等于当前 invocation 还有可用 invoker。

### 失败方案三：metadata 更新后，运行态立刻就该像新模型

这会忽略 migration 和服务发现的异步分层。

metadata 变化先要经过：

- service-name mapping  
- instance 变化聚合  
- revision 对应 metadata 拉取  
- `serviceUrls` 重建  
- `notifyAddressChanged()` 触发 directory 更新  
- migration 比较器决定是否切到新路径

中间任何一层没跟上，都可能让你看到“metadata 已更新，但调用还像旧模型”。

## 四、最小总图：控制面改的是不同对象，不是同一个总状态

把问题压成一张对象图最清楚：

```text
registry 地址变化
  → RegistryDirectory.cachedInvokerUrls / urlInvokerMap / validInvokers

config center 规则变化
  → configurators / directoryUrl / provider URL / export URL

metadata / service discovery 变化
  → serviceNames / serviceUrls / InstanceAddressURL / serviceDiscovery invoker

migration 规则变化
  → currentStep / currentAvailableInvoker / invoker 子树选择
```

注意这里的核心不是“控制面分了四类”，而是：**每一类控制面改写的是不同 runtime 对象。**

而且这些对象既不在同一层级，也不会同步切换：`directoryUrl` 更偏 consumer 语义视图，`urlInvokerMap` 更偏 live invoker 集，`serviceUrls` 更偏 service-discovery 地址视图，`currentAvailableInvoker` 则是 migration 壳最终真正拿来调用的那棵子树。

所以排障顺序也必须跟着对象走，而不是先入为主地问“注册中心是不是坏了”。

## 五、registry 有地址，但 consumer 还是调不通

### 5.1 provider URL list 先不等于 invoker map

`RegistryDirectory.notify()` 拿到 provider URLs 后，真正变成 live invokers 之前，还要经过 `refreshOverrideAndInvoker()` 和 `refreshInvoker()`。

这里最需要钉住的一句排障提醒是：**registry 里看到的是输入，不是结果。** registry 给你的只是 provider URL 列表；真正决定“当前这次调用还能不能打出去”的，是后面生成出来的 `urlInvokerMap`、`validInvokers` 和 routed invokers。

`RegistryDirectory.java:200` — notify
`RegistryDirectory.java:257` — refreshOverrideAndInvoker
`RegistryDirectory.java:337` — newUrlInvokerMap 构造

所以最先要问的不是“registry 里有没有地址”，而是“`urlInvokerMap` 有没有真的建起来”。

### 5.2 协议不匹配时，有地址也会被丢掉

provider URL 进入 `toInvokers()` 后，会先经过协议兼容检查。协议不匹配、实现未安装等情况，都会让这个 URL 直接被跳过。

`RegistryDirectory.java:560` — 协议兼容检查

这解释了一个高频现场：registry 明明有 provider，但 consumer 因协议条件不匹配，最终一个 invoker 也没生成。

### 5.3 `protocol.refer()` 失败，地址也落不成 invoker

即使协议兼容，如果 `protocol.refer()` 自己抛异常，URL 同样不会变成 live invoker。

`RegistryDirectory.java:476` — `protocol.refer()` 失败路径

因此“有地址但调不通”，完全可能发生在地址到 invoker 的转换阶段。

### 5.4 router 裁空和 forbidden 是两种不同问题

- `NO_INVOKER_AVAILABLE_AFTER_FILTER` 常常是 route 之后空了。  
- `FORBIDDEN_EXCEPTION` 常常是 Directory 被明确 forbid 了。  

`DynamicDirectory.java:197` — `FORBIDDEN_EXCEPTION`

所以“没 provider”不能只看异常 message，要先分清：是候选集被裁空，还是目录直接禁止访问。

## 六、config center 已推，但行为还是旧的

### 6.1 listener 没挂上，规则根本进不来

consumer 侧只有在配置监听启用时，才会挂上 `ConsumerConfigurationListener` 和 `ReferenceConfigurationListener`。

如果没启用这条监听链，config center 的动态规则虽然存在，但当前目录根本不会收到它。

### 6.2 规则进来了，但解析/匹配可能失败

`AbstractConfiguratorListener.process(...)` 收到 rule 文本后，还要经过 `parseConfigurators()` 和匹配条件判断。只要解析失败、条件不匹配，运行态就不会变。

`AbstractConfiguratorListener.java:85` — process config changed
`AbstractConfiguratorListener.java:104` — parse rules

所以“规则已推但行为没变”首先要问：规则有没有真的变成生效的 `Configurator`。

### 6.3 `directoryUrl` 变了，不等于 invoker 也变了

consumer 侧 configurator 变化会先重算 `directoryUrl`，然后再进入 `refreshInvoker()`。

`RegistryDirectory.java:652` — overrideWithConfigurator
`RegistryDirectory.java:257` — refreshOverrideAndInvoker

但如果这次 override 只改了部分语义，而 provider URL 最终没有形成新的 key，旧 invoker 可能继续复用。也就是说：**directoryUrl 已变，不代表 invoker map 已重建。**

换成人话说：规则已经进入治理平面，不等于这次请求看到的 invoker 视图已经刷新完成。前者说明“解释规则变了”，后者才说明“真正拿来调用的对象变了”。

### 6.4 provider 侧可能触发 re-export

provider 侧更进一步。如果 configurator 改写后的 export URL 真的变了，就会触发 `reExport(...)`。

`RegistryProtocol.java:895` — provider-side override
`RegistryProtocol.java:900` — reExport

所以行为变化不一定全发生在 consumer，provider 自己也可能因为动态覆盖而重新暴露一次服务。

## 七、metadata 已更新，但服务发现仍像旧模型

### 7.1 mapping 没补齐，实例订阅根本没开始

在应用级服务发现里，`ServiceDiscoveryRegistry` 先要从接口拿到 app names。若这一步为空，就不会继续 `subscribeURLs()`。

`ServiceDiscoveryRegistry.java:199` — subscribe path
`ServiceDiscoveryRegistry.java:234` — no mapping，停止向下订阅

所以 metadata / mapping 没闭环时，consumer 仍然会像旧模型一样工作。

### 7.2 revision 变了，不等于 metadata 已可用

`ServiceInstancesChangedListener` 收到实例变化后，会按 revision 聚合，再尝试获取 metadata。如果 metadata 还没拉到或为空，这次更新会被挂起重试。

`ServiceInstancesChangedListener.java:143` — onEvent
`ServiceInstancesChangedListener.java:185` — metadata missing / retry

所以“metadata 已更新”在控制面上可能成立，但运行态里的 `serviceUrls` 还没真正重建。

### 7.3 新路径 ready 了，也不等于当前已经走它

就算 `serviceUrls` 已经重算出来，migration 壳也未必立刻切过去。最终还要看 `currentAvailableInvoker` 当前是否已经指向 service-discovery 那一棵子树。

`MigrationInvoker.java:64` — old/new/current invoker
`MigrationInvoker.java:315` — service-discovery unavailable fallback

## 八、新 provider 已上线，为什么请求还走旧路径 / 旧 invoker

### 8.1 新 provider 到了，旧 invoker 不会瞬时消失

`RegistryDirectory.refreshInvoker()` 会先构造新的 invoker map，刷新 router，再切换，再销毁旧 invoker。这里有天然的过渡窗口。

`RegistryDirectory.java:363` — refreshRouter / setInvokers
`RegistryDirectory.java:371` — destroyUnusedInvokers

所以“新 provider 已推送”不等于“旧 invoker 立刻下线”。

### 8.2 `APPLICATION_FIRST` 本来就可能继续走旧路径

在 migration 模式下，`APPLICATION_FIRST` 并不是一句“永远优先新路径”。它会结合比较器和比例，仍然可能把部分调用送回旧路径。

`MigrationInvoker.java:285` — APPLICATION_FIRST invoke path

这意味着看到“规则已切到应用级优先，但某些请求还走旧地址”，不一定是 bug，而可能是策略本身。

### 8.3 默认实现更偏向 service-discovery，但并不等于瞬切

默认 `RegistryProtocol` 当前更偏 `ServiceDiscoveryMigrationInvoker`，这让它在实现上更偏新模型；但这并不等于每一瞬间都只剩新路径。壳里的切换、fallback 和旧子树退场仍然要走完。

`RegistryProtocol.java:601` — 默认 `ServiceDiscoveryMigrationInvoker`

## 九、误解澄清

### 误解一：控制面推送成功，就等于运行态已经切换成功

不是。控制面事件到达只是开始，后面还要经过对象图更新、缓存刷新和切换。

### 误解二：registry 有地址，就一定能调通

不是。中间还隔着协议检查、invoker 构造、router 裁剪和 forbidden/empty protection。

### 误解三：config center 改的是“配置值”，不是运行态

不是。它通过 configurator 直接改写 directoryUrl、provider URL 和 export URL 语义，最终会落到 live runtime 上。

### 误解四：metadata 变了，调用就一定立刻像新模型

不是。mapping、metadata 拉取、serviceUrls、migration 子树选择都可能滞后。

### 误解五：规则已切到新模型，当前请求就一定马上表现成新模型

也不是。`currentAvailableInvoker` 的切换、旧子树退场和比例策略都会引入延迟或共存窗口。

### 误解六：`serviceUrls` 已更新，就等于 `currentAvailableInvoker` 已经切到新路径

不等于。`serviceUrls` 只是 service-discovery 侧地址视图已经更新；真正决定“这次请求走旧路径还是新路径”的，是 migration 壳里当前生效的 `currentAvailableInvoker`。前者是新路径已经准备好了，后者才是新路径已经被真正拿来用。

## 十、收网总结：排这种问题，要先盯对象，不要先盯控制面

回到开头的问题：为什么控制面已经变了，运行态却还是老样子？

因为 Dubbo 的控制面不是改一个总状态，而是分别改写：

- `urlInvokerMap` / `validInvokers`  这一类地址视图  
- `directoryUrl` / provider URL / export URL 这一类参数语义  
- `serviceUrls` / instance metadata 这一类服务发现视图  
- `currentAvailableInvoker` 这一类迁移壳内部指向  

所以排障的正确顺序不是“控制面到底推了没有”，而是：

1. 先问：现在出问题的是哪一个运行态对象？  
2. 再问：这个对象本应由哪条控制面链更新？  
3. 最后问：这条更新链卡在了监听、解析、匹配、切换还是回收哪一步？  

**三句话总结：**

1. registry、config center、metadata、migration 改写的是不同的 runtime 对象，不是同一个总状态。  
2. “控制面已变”不等于“当前调用已体现这个变化”，中间常有缓存、fallback、双链/双树切换和延迟。  
3. Dubbo 控制面失配排障，关键不是先看哪个中心推了什么，而是先看哪个运行态对象还没跟上。  

**下篇建议：** 如果继续 Dubbo 生产诊断层，可以把 provider 侧线程池 / Dispatcher / remoting 背压与假死问题单独拉出来写。