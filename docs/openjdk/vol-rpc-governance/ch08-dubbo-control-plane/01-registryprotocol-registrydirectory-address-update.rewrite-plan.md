# Dubbo：RegistryProtocol、RegistryDirectory 与地址更新主线 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch08-dubbo-control-plane`
- 篇：`01 RegistryProtocol、RegistryDirectory 与地址更新主线`
- 对应主题：`D-CTRL-1 Registry / Address Update Spine`
- 文章类型：控制面与地址更新主线篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：前面的 consumer 流量主线已经把 `Directory / Router / LoadBalance / Cluster` 讲清楚了，但读者可能仍然没完全想通：“provider 列表到底是从哪里进入 Directory 的”？注册中心任何一个地址变化，是怎样变成 consumer 侧 live invoker 变化的？为什么 registry 推送非空/空列表会带来完全不同的线上症状？
- 一句话顿悟：Registry 在 Dubbo 里不是“外部辅助组件”，而是直接插入 consumer 调用主线的控制面：`RegistryProtocol.refer()` 创建 Directory 并订阅，`RegistryDirectory.notify()` 把 providers/configurators/routers 三种推送分桶处理，`refreshInvoker()` 把 provider URL 转成 live invokers，`RouterChain.setInvokers()` 用 main/backup 双链切换避免地址与路由缓存撕裂；configurators/routers 则改变“当前这一批 invoker 怎么被覆盖和怎么被筛选”。
- 文章边界：本篇重点讲 `RegistryProtocol` -> `RegistryDirectory.notify()` -> `refreshOverrideAndInvoker()` -> `refreshInvoker()` -> `toInvokers()` -> `refreshRouter()` / `RouterChain.setInvokers()` 这条控制面到 live runtime 的更新链；不展开具体 registry 实现（ZK/Nacos 等适配器）、不展开 service-discovery migration 深度细节、不重讲 cluster/router/lb 算法。

## 前置依赖

### HARD

- `ch06-dubbo-runtime/04-directory-router-loadbalance-cluster.md`：已经知道 consumer 流量主线四层结构。
- `ch06-dubbo-runtime/02-...`：已经知道 `Invoker` / `Protocol` / `Exporter` 窄腰。

### SOFT

- 不要求先懂 ZK/Nacos 具体适配器。
- 不要求先懂 service-discovery migration 全量。

### NAV

- 后续可接：`Service Discovery / Migration 机制`
- 后续可接：`Config Center / Dynamic Override`
- 后续可接：生产诊断：registry/address 失配排障

## 一句话困惑

注册中心的地址、路由、配置覆盖变化，到底是怎么变成 consumer 侧 live invoker 列表变化的？`RegistryProtocol`、`RegistryDirectory`、`RouterChain` 各自负责哪一段？

## 一句话顿悟

控制面更新不是“换一个地址列表”这么简单，而是分桶、转换、双链切换和回收并存：`RegistryDirectory.notify()` 把 providers/routers/configurators 分开，provider URLs 再经 `refreshInvoker()` 转成 invokers，`toInvokers()` 负责复用/新建，`RouterChain.setInvokers()` 用 main/backup 双链保证地址与路由缓存的一致性，最后 `destroyUnusedInvokers()` 回收旧连接；所以“地址变化”最终体现为 directory 当前 invokers、router cache 与存活连接同时被安全切换。

## 读者理解路径

1. 先否定“registry 推送后直接替换地址数组”的直觉。
2. 建立总图：`RegistryProtocol.refer -> RegistryDirectory.subscribe -> notify -> refreshOverrideAndInvoker -> refreshInvoker -> toInvokers -> refreshRouter/setInvokers -> destroyUnusedInvokers`。
3. 解释 `RegistryProtocol` 为什么不是 registry client，而是控制面入口协调者。
4. 解释 `notify()` 如何按 category 分桶。
5. 解释 `refreshOverrideAndInvoker()` 如何先应用 configurator 覆盖，再刷新 invoker。
6. 解释 `refreshInvoker()` 的 forbid / EMPTY_PROTOCOL / empty-protection / URL 去重逻辑。
7. 解释 `toInvokers()` 如何对 URL 复用/新建 invoker。
8. 解释 `RouterChain.setInvokers()` 的 main/backup 双链切换。
9. 收束到：控制面更新是“分桶 + 转换 + 双链切换 + 回收”，不是一次性替换。

## 失败方案推演

### 失败方案一：registry 推送就是直接替换 consumer 的地址列表

- 这会漏掉 configurators/routers 两个分桶。
- 地址列表只是 providers 一类；router 和 configurator 也需要被翻译成运行时机。
- 所以推送并不是“一个列表”，而是“三类数据的组合”。

### 失败方案二：`RegistryProtocol` 就是“注册中心客户端”

- Registry 接口本身负责和真实注册中心交互，但 `RegistryProtocol` 更多是 export/refer 的协调壳。
- 它创建 Directory、订阅 registry、组装 cluster。
- 所以它不仅是客户端，而是控制面入口调度者。

### 失败方案三：地址更新时直接替换 invoker map 就够了

- 直接替换会让正在进行的 RPC 直接看到半更新状态。
- `toInvokers()`、`refreshRouter()`、`setInvokers()`、`destroyUnusedInvokers()` 是成组出现的，不是简单赋值。
- 所以更新必须经过一致性切换。

## 必须澄清的误解

1. `RegistryDirectory` 不是“registry 客户端”，而是 consumer 侧动态 directory，registry 只是它的数据源。
2. notify 回推会同时包含 providers / routers / configurators，不能用同一个逻辑处理。
3. EMPTY_PROTOCOL / forbid 会让调用直接 forbidden，而不是“空列表继续 etc”。
4. 空地址推送不一定会立即清空，empty-protection 可能保留旧缓存。
5. `RouterChain.setInvokers()` 的 main/backup 双链不是为了性能，而是为了避免地址与路由缓存撕裂。

## 文章结构与字数预算

1. 困惑开场：地址变化怎么一路进入 consumer runtime（800-1000 字）
2. 最小总图：notify → refreshOverrideAndInvoker → refreshInvoker → toInvokers → RouterChain 双链（1000-1400 字）
3. `RegistryProtocol`：控制面入口协调者（1400-1800 字）
4. `RegistryDirectory.notify()`：按 category 分桶（1400-2000 字）
5. `refreshOverrideAndInvoker()`：configurator 覆盖与 provider refresh（1200-1600 字）
6. `refreshInvoker()`：forbid / EMPTY_PROTOCOL / empty-protection / URL 去重（1800-2400 字）
7. `toInvokers()` 与 invoker 生命周期（1400-1800 字）
8. `RouterChain.setInvokers()`：main/backup 双链切换（1400-2000 字）
9. 收网总结（600-800 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

### RegistryProtocol refer / subscriber
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:557` — refer
- `RegistryProtocol.java:578` — doRefer
- `RegistryProtocol.java:647` — doCreateInvoker
- `RegistryProtocol.java:662` — 消费者注册
- `RegistryProtocol.java:666` — buildRouterChain
- `RegistryProtocol.java:667` — subscribe
- `RegistryProtocol.java:669` — cluster.join
- `RegistryProtocol.java:687` — toSubscribeUrl 加 category 参数

### Directory notify / refresh
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryDirectory.java:200` — notify 入口
- `RegistryDirectory.java:206` — category 分组
- `RegistryDirectory.java:217` — configurators 处理
- `RegistryDirectory.java:219` — routers 处理
- `RegistryDirectory.java:224` — provider URLs
- `RegistryDirectory.java:227` — AddressListener 扩展
- `RegistryDirectory.java:257` — refreshOverrideAndInvoker
- `RegistryDirectory.java:275` — refreshInvoker
- `RegistryDirectory.java:280` — EMPTY_PROTOCOL / forbid
- `RegistryDirectory.java:288` — forbidden=false
- `RegistryDirectory.java:293` — empty-protection
- `RegistryDirectory.java:315` — URL 去重
- `RegistryDirectory.java:337` — toInvokers
- `RegistryDirectory.java:363` — refreshRouter + setInvokers
- `RegistryDirectory.java:371` — destroyUnusedInvokers

### Directory runtime behaviors
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/DynamicDirectory.java:184` — subscribe
- `DynamicDirectory.java:196` — doList：forbidden / fail-fast / route
- `DynamicDirectory.java:290` — buildRouterChain

### RouterChain double-chain
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/RouterChain.java:128` — setInvokers
- `RouterChain.java:134` — 切到 backup
- `RouterChain.java:145` — 刷新 mainChain
- `RouterChain.java:170` — switchAction 切 directory invokers
- `RouterChain.java:179` — 切回 mainChain
- `RouterChain.java:198` — 刷新 backupChain

## 测试证据清单

- `RegistryDirectoryTest` — notify / refreshInvoker / configurator / router 更新相关
- `RouterChainTest` — 双链切换
- `RegistryProtocolTest` — refer 与 invoker 组装
- `DynamicDirectoryTest` — forbidden / route / doList

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇聚焦 registry 控制面更新链，不展开 ZK/Nacos 适配器实现。
- service-discovery / migration / config center 动态覆盖只作为后续边界，不在本篇展开。

## 与其他篇的边界

### 本篇要讲清

- `RegistryProtocol.refer()` 到 `RegistryDirectory` 的接线。
- notify 分桶与 configurator/router/provider 的分流。
- `refreshInvoker()` 的 forbid / EMPTY / empty-protection / 去重。
- `toInvokers()` 的 invoker 复用/新建。
- `RouterChain.setInvokers()` 的 main/backup 双链。

### 本篇不深讲

- 具体 registry 适配器（ZK/Nacos）。
- migration / service-discovery 迁移全量。
- cluster / router / lb 算法。
- 生产排障大全。

## 写作后检查

- [ ] 开篇先抓“地址变化怎么进入 live runtime”，而不是直接讲 region。
- [ ] 至少展开 3 个失败方案，且包含“registry 推送就是替换地址列表”。
- [ ] 明确给出 notify → refresh → invoker → router 双链总图。
- [ ] 不把本文写成 RegistryProtocol/RegistryDirectory 方法清单。
- [ ] 每个阶段先讲语义再给 file:line。
- [ ] 删除代码块后，读者仍能复述控制面更新链。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。