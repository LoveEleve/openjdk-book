# Dubbo：RegistryProtocol、RegistryDirectory 与地址更新主线

> 基于 Apache Dubbo 3.3.7-SNAPSHOT

## 一、困惑开场：注册中心推了一条消息，consumer 到底变了什么

前面已经讲过 Dubbo consumer 的流量主线：`Directory` 提供候选 invoker，`Router` 裁剪集合，`LoadBalance` 选一个，`Cluster` 决定失败后怎么办。

但这条链里有一个关键问题还没彻底打穿：Directory 里的 provider 到底从哪里来？

线上经常会出现这样的场景：

- 注册中心显示 provider 已经上线，但 consumer 还打不到它。
- 注册中心推送了新的 provider 地址，后续请求逐渐切过去，但旧连接没有立刻消失。
- 注册中心推了空地址，调用有时直接 forbidden，有时却继续使用旧 provider。
- 路由规则变了，但 provider 地址没有变化，consumer 的选择结果却变了。

如果把 registry 理解成“推一份最新地址列表”，这些现象都解释不了。Dubbo 的 registry 控制面实际上同时处理 providers、routers、configurators 三类信息，并把它们分阶段翻译成 live invokers、router cache 和可用性状态。

## 二、前情回顾：上一篇讲“选谁”，这一篇讲“候选集怎么变”

在前一篇 consumer 流量篇里，我们已经知道 `Directory -> RouterChain -> LoadBalance -> ClusterInvoker` 是一次调用的运行链。

但那里默认 Directory 已经有了一份可用 invoker 视图，也就是说上一篇关注的是：**当前这一批候选里，最后到底选谁。**

这一篇回到它的上游，关注的是另一个问题：**这批候选自己是怎么变的。** 谁在更新它？更新时为什么不能直接替换一个列表？旧 invoker 怎么复用和销毁？

所以本文只解决一个问题：**注册中心和配置变化，如何安全地流入 consumer 的 live runtime。**

## 三、先走三条失败的路

### 失败方案一：registry 推送就是直接替换 consumer 地址列表

这会忽略 registry notify 中至少三类数据：

- provider URLs
- router URLs
- configurator URLs

provider 决定“有哪些调用目标”，router 决定“哪些目标可以参与这次调用”，configurator 决定“目标和调用参数如何被覆盖”。它们不可能用同一条替换逻辑处理。

### 失败方案二：RegistryProtocol 就是 registry 客户端

Registry 客户端负责和具体注册中心交互，但 `RegistryProtocol` 还要负责把 registry 接进 RPC refer 主线：创建 Directory、绑定 Protocol、构建 RouterChain、订阅 registry、最后 `cluster.join(directory, true)`。

所以它不是单纯的连接适配器，而是控制面进入 consumer runtime 的协调入口。

### 失败方案三：地址更新时直接替换 invoker map 就够了

如果直接把旧 map 换成新 map，会产生两个风险：

- router cache 可能还对应旧 invokers
- 正在进行的调用可能观察到半更新状态

因此 Dubbo 会先转换/复用 invoker，先刷新 router chain，再切换 Directory 的 invoker 引用，最后销毁不再使用的旧 invokers。

## 四、最小总图：控制面更新如何变成 live runtime

```text
RegistryProtocol.refer()
    ↓
DynamicDirectory / RegistryDirectory
    ↓ registry.subscribe()
Registry notify()
    ├─ configurators
    ├─ routers
    └─ providers
          ↓
refreshOverrideAndInvoker()
    ↓
refreshInvoker()
    ├─ forbid / EMPTY_PROTOCOL
    ├─ empty protection
    ├─ URL 去重与 cache reuse
    ├─ protocol.refer() -> new Invoker
    └─ destroy unused Invoker
          ↓
refreshRouter()
    ↓
RouterChain.setInvokers()
    ├─ backup chain
    ├─ main chain refresh
    ├─ switch directory reference
    └─ backup chain refresh
```

这不是一次简单赋值，而是一套分阶段的控制面更新事务：先分桶，再转换，再切换，再回收。后面依次拆开。

## 五、RegistryProtocol：控制面进入 consumer 的协调入口

### 5.1 refer 阶段先创建 Directory

`RegistryProtocol.refer()` 取得 registry 和 refer 参数，随后进入 `doRefer()`。真正的 Directory 组装发生在 `doCreateInvoker()`。

`RegistryProtocol.java:557` — `refer()`
`RegistryProtocol.java:578` — `doRefer()`
`RegistryProtocol.java:647` — `doCreateInvoker()`

`doCreateInvoker()` 做几件事：

- 给 Directory 设置 Registry
- 给 Directory 设置 Protocol
- 构建 RouterChain
- 向 Registry 注册 consumer URL
- 订阅 provider/router/configurator 类别
- 通过 `cluster.join(directory, true)` 生成最终聚合 invoker

`RegistryProtocol.java:649` — 设置 registry/protocol
`RegistryProtocol.java:662` — consumer register
`RegistryProtocol.java:666` — buildRouterChain
`RegistryProtocol.java:667` — subscribe
`RegistryProtocol.java:669` — cluster join

这一步把 registry 从“外部系统”接进了 consumer 的实际调用主线。

### 5.2 RegistryProtocol 不拥有 live provider 列表

它负责接线，但不负责长期保存每次 provider 变化后的 invoker 集合。那是 Directory 的职责。

这层分工很重要：

- RegistryProtocol 负责“把 Registry 和 Directory 接起来”。
- RegistryDirectory 负责“在 notify 到达后更新 live invokers”。
- ClusterInvoker 负责“调用时如何使用这份动态视图”。

## 六、RegistryDirectory.notify：三类控制面信息分流

### 6.1 notify 先按 category 分桶

`RegistryDirectory.notify(List<URL>)` 不会直接遍历所有 URL 就更新 provider。它先过滤非法/不兼容数据，再按 category 分成 configurators、routers、providers。

之所以必须先分桶，而不能把三类 URL 混在一起统一处理，是因为它们改写的是三个不同层面：configurator 改的是“参数语义”，router 改的是“候选裁剪规则”，provider 才改的是“目标集合本身”。如果把三者混成一个列表做统一更新，最终你根本无法回答“这次行为变化，到底是地址变了、路由变了，还是覆盖参数变了”。

`RegistryDirectory.java:200` — notify 入口
`RegistryDirectory.java:206` — category 分组

这一步把三种控制面数据分开：

- **configurator**：覆盖 consumer/provider 的配置语义
- **router**：改变候选集合的裁剪规则
- **provider**：改变可调用目标本身

### 6.2 configurator 和 router 先各自更新

configurator URLs 会先转换成覆盖规则，router URLs 会转换成 Router 并加入 RouterChain。

`RegistryDirectory.java:217` — configurator 处理
`RegistryDirectory.java:219` — router 处理

这意味着一次 registry notify 里，即使 provider 地址没变，consumer 的最终选择结果也可能变化，因为 router 或 configurator 已经变了。

### 6.3 providers 进入 refresh

provider URLs 会经过 `AddressListener` 扩展处理，然后进入 `refreshOverrideAndInvoker(providerURLs)`。

`RegistryDirectory.java:224` — provider URLs
`RegistryDirectory.java:227` — AddressListener
`RegistryDirectory.java:257` — refreshOverrideAndInvoker

## 七、refreshInvoker：地址如何变成 live invokers

### 7.1 EMPTY_PROTOCOL：明确禁止访问

如果收到一个 `EMPTY_PROTOCOL` URL，Directory 会把它解释为 forbid：

- 设置 `forbidden=true`
- 刷新为空的 router/invoker 视图
- 销毁所有已有 invokers

`RegistryDirectory.java:275` — refreshInvoker
`RegistryDirectory.java:280` — EMPTY_PROTOCOL / forbid

这和普通“暂时没有地址”不是同一个语义。它更像控制面明确告诉 consumer：当前服务禁止访问。

### 7.2 空地址保护：为什么不一定立刻清空

如果 provider URL 列表为空，但没有 `EMPTY_PROTOCOL`，Dubbo 会检查是否有旧的 cached invoker URLs。

如果有，可能触发 empty protection，保留旧地址，避免注册中心短暂抖动导致 consumer 瞬间把全部调用目标清空。

这不是“逻辑上更优雅”的小技巧，而是一个很明确的生产保护：registry 短时抖动、瞬间空推送、watch 抖动都不该立刻把 consumer 打成全量不可用。对排障来说，这意味着“收到空地址”与“当前真的没有 provider 可用”不是同一个结论。

`RegistryDirectory.java:288` — forbidden=false
`RegistryDirectory.java:293` — empty-protection

因此“registry 推了空列表”在线上不一定马上等于“调用立即 forbidden”。要看它是明确的 EMPTY_PROTOCOL，还是普通空地址事件。

### 7.3 URL 去重与旧 invoker 复用

非空 provider 列表会先去重，再基于旧的 `urlInvokerMap` 构造新 map。

`RegistryDirectory.java:315` — URL 去重
`RegistryDirectory.java:337` — old map -> toInvokers

旧 URL 能复用旧 Invoker，就不需要每次 notify 都重新建立连接；只有新 URL 或参数变化的 URL 才需要重新 `protocol.refer()`。

### 7.4 地址变成 Invoker

`toInvokers()` 把 provider URL 转成真正可调用的 protocol invoker。这个过程最终会重新进入 `Protocol.refer(serviceType, url)`。

`RegistryDirectory.java:452` — toInvokers

因此 registry notify 的 provider 地址不是最终调用对象，而是再次经过 Dubbo Protocol/Invoker 主线的输入。

### 7.5 更新、路由、回收不是一个动作

新 invokers 形成后，Dubbo 会：

1. 先刷新 router cache
2. 再切换 Directory 当前 invoker 引用
3. 更新 URL -> Invoker map
4. 销毁不再使用的旧 invokers

`RegistryDirectory.java:363` — refreshRouter + setInvokers
`RegistryDirectory.java:371` — destroyUnusedInvokers

这正是控制面更新不能写成“替换数组”的原因。

## 八、RouterChain：为什么要 main/backup 双链切换

### 8.1 更新时先切到 backup

`RouterChain.setInvokers()` 开始时，会先把 `currentChain` 切到 backup，阻止新的请求继续进入正在刷新的 main chain。

`RouterChain.java:128` — setInvokers
`RouterChain.java:134` — 切到 backup

### 8.2 刷新 main chain 后再切 Directory

接下来，它锁住 main chain，刷新它看到的 invokers 和 router/state-router cache。

`RouterChain.java:145` — 刷新 mainChain

只有 main chain 准备好之后，才执行 `switchAction.run()`，把 Directory 的 invoker 引用切到新集合。

`RouterChain.java:170` — switchAction

### 8.3 最后刷新 backup chain

Directory 引用切换完成后，RouterChain 再切回 main chain，并刷新 backup chain，使双链最终保持一致。

`RouterChain.java:179` — 切回 main chain
`RouterChain.java:198` — 刷新 backup chain

所以 main/backup 双链不是为了“多一份缓存更快”，而是为了在 live 地址和路由 cache 更新时避免撕裂状态。

## 九、provider live-set 的第二个来源：consumer 本地可用性

registry 是上游来源，但不是 live-set 的唯一来源。

当 `AbstractClusterInvoker.select()` 发现某个 invoker 不可用时，会调用 `directory.addInvalidateInvoker(invoker)`：

`AbstractClusterInvoker.java:203` — 不可用 invoker 进入 invalidate
`AbstractDirectory.java:320` — 移出 valid、加入 reconnect list

后台 connectivity check 会重新探测这些 invoker，恢复成功后再加入 valid 集合。

`AbstractDirectory.java:384` — 恢复 valid invoker

这说明 consumer 的最终可调用集合是：

```text
registry 推送
  + configurator/router 变化
  + consumer 本地可用性探测
  → 当前 Directory live invokers
```

## 十、误解澄清

### 误解一：registry 推送就是替换 provider 地址列表

不是。notify 至少分成 providers、routers、configurators 三类，每类都会以不同方式影响 consumer。

### 误解二：EMPTY_PROTOCOL 和普通空地址是同一个意思

不是。EMPTY_PROTOCOL 表示明确 forbid，普通空列表可能触发 empty protection，暂时保留旧缓存。

### 误解三：Directory 更新就是直接替换 invoker map

不是。Dubbo 还要去重、复用/新建 invoker、刷新 router cache、切换 Directory 引用、销毁旧 invoker。

### 误解四：RouterChain 双链只是缓存优化

不是。main/backup 双链是为了避免 invoker 集合和 router cache 在热更新时出现不一致。

### 误解五：provider 还在 registry 里，就一定会被当前调用选中

也不是。consumer 本地 `isAvailable()`、路由裁剪和 invalidate/reconnect 都可能让它暂时离开 valid invokers。

### 误解六：registry 已经推了新 provider，当前请求就应该立刻切过去

不一定。控制面推送成功，只说明新的 provider 已经进入本轮更新事务；它还要经过 invoker 复用/新建、router cache 刷新、Directory 引用切换、旧 invoker 回收这些阶段。也就是说，“新 provider 已推送”不等于“当前这一瞬间已经没有请求会走旧 invoker”。

## 十一、收网总结：控制面更新不是换列表，而是一次运行时切换

回到开头的问题：注册中心推了一条消息，consumer 到底变了什么？

真正发生的不是一个数组被替换，而是一条控制面到数据面的更新链：

- RegistryProtocol 把 Registry 接到 Directory。
- RegistryDirectory 把 notify 分成 providers、routers、configurators。
- provider URLs 被转换为可复用或新建的 Invoker。
- RouterChain 先刷新 cache，再安全切换 Directory 的 invoker 视图。
- 旧 invoker 在确认不再使用后销毁。

**三句话总结：**

1. registry 是控制面数据源，Directory 才是 consumer 的 live invoker 视图。
2. 地址更新必须同时处理 provider、router、configurator，并通过 RouterChain 双链切换避免撕裂。
3. 线上看到“地址已更新但行为没变”“空地址却还能调用”“provider 仍注册但没被选中”，都要沿 notify → refresh → router → valid invoker 这条链逐层排查。

**下篇预告：** 下一篇可进入 Dubbo Service Discovery / Migration，继续看传统 registry view 如何迁移到应用级服务发现模型。