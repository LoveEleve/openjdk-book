# RPC 与治理卷总索引（Dubbo）

> 收口时间：2026-08-21  
> 当前覆盖范围：`ch06` ~ `ch09` 的 Dubbo 运行时、集成层、控制面与生产诊断  
> 当前状态：目录级三件套完整，累计 `16` 篇 article base / `48` 个文件

## 一、这份索引解决什么问题

这份索引不是再抄一遍目录，而是把当前已完成的 Dubbo 篇章压成一张“阅读地图”。

它回答三个问题：

1. 现在这 16 篇分别在 Dubbo 源码书里承担什么角色？
2. 如果读者不是顺着章节线性阅读，最合理的进入顺序是什么？
3. 当前 Dubbo 这条线已经闭环到什么程度，后面如果切到下一个框架，Dubbo 有没有足够扎实的停点？

## 二、当前完成总览

| 章节 | 主题 | 已完成 |
|------|------|--------|
| `ch06-dubbo-runtime` | Dubbo 主干运行时 | 7/7 |
| `ch07-dubbo-integration` | Spring / 配置接入层 | 2/2 |
| `ch08-dubbo-control-plane` | Registry / Migration / Config Center / Metadata 控制面 | 4/4 |
| `ch09-dubbo-production-diagnostics` | 生产诊断 | 3/3 |

总计：`16` 篇，目录级三件套完整率 `100%`。

## 三、推荐阅读顺序

### 路线 A：第一次系统进入 Dubbo

按“运行时主干 → 集成桥 → 控制面 → 生产诊断”的顺序读：

1. `ch06-dubbo-runtime/01-serviceconfig-referenceconfig-export-refer.md`
2. `ch06-dubbo-runtime/02-invoker-protocol-exporter-proxy-filter.md`
3. `ch06-dubbo-runtime/03-directory-router-loadbalance-cluster.md`
4. `ch06-dubbo-runtime/04-remoting-exchange-dispatcher-network.md`
5. `ch06-dubbo-runtime/05-extensionloader-adaptive-activate-spi.md`
6. `ch06-dubbo-runtime/06-dubbo2-triple-injvm-protocol-comparison.md`
7. `ch06-dubbo-runtime/07-scope-model-application-model-lifecycle.md`
8. `ch07-dubbo-integration/01-spring-springboot-integration-bootstrap.md`
9. `ch07-dubbo-integration/02-config-merge-externalization-url-generation.md`
10. `ch08-dubbo-control-plane/01-registryprotocol-registrydirectory-address-update.md`
11. `ch08-dubbo-control-plane/02-service-discovery-migration.md`
12. `ch08-dubbo-control-plane/03-config-center-dynamic-override.md`
13. `ch08-dubbo-control-plane/04-metadata-metadata-report.md`
14. `ch09-dubbo-production-diagnostics/01-timeout-retry-cluster-troubleshooting.md`
15. `ch09-dubbo-production-diagnostics/02-registry-config-metadata-mismatch.md`
16. `ch09-dubbo-production-diagnostics/03-dispatcher-threadpool-provider-stall.md`

### 路线 B：只关心线上排障

1. `ch09-dubbo-production-diagnostics/01-timeout-retry-cluster-troubleshooting.md`
2. `ch09-dubbo-production-diagnostics/02-registry-config-metadata-mismatch.md`
3. `ch09-dubbo-production-diagnostics/03-dispatcher-threadpool-provider-stall.md`
4. 回补：`ch06-dubbo-runtime/03-directory-router-loadbalance-cluster.md`
5. 回补：`ch06-dubbo-runtime/04-remoting-exchange-dispatcher-network.md`
6. 回补：`ch08-dubbo-control-plane/01-registryprotocol-registrydirectory-address-update.md`
7. 回补：`ch08-dubbo-control-plane/02-service-discovery-migration.md`
8. 回补：`ch08-dubbo-control-plane/03-config-center-dynamic-override.md`

### 路线 C：只关心 Dubbo 架构与扩展机制

1. `ch06-dubbo-runtime/01-serviceconfig-referenceconfig-export-refer.md`
2. `ch06-dubbo-runtime/02-invoker-protocol-exporter-proxy-filter.md`
3. `ch06-dubbo-runtime/05-extensionloader-adaptive-activate-spi.md`
4. `ch06-dubbo-runtime/07-scope-model-application-model-lifecycle.md`
5. `ch06-dubbo-runtime/06-dubbo2-triple-injvm-protocol-comparison.md`
6. `ch07-dubbo-integration/01-spring-springboot-integration-bootstrap.md`
7. `ch07-dubbo-integration/02-config-merge-externalization-url-generation.md`

## 四、章节索引

### ch06-dubbo-runtime：Dubbo 主干运行时

| 文件 | 角色定位 | 读者收获 |
|------|----------|----------|
| `01-serviceconfig-referenceconfig-export-refer.md` | export / refer 入口篇 | 建立 provider `ref -> Invoker -> Exporter` 与 consumer `URL -> Invoker -> Proxy` 两条主线 |
| `02-invoker-protocol-exporter-proxy-filter.md` | 窄腰篇 | 理解 `Invoker` 为什么是 Dubbo 的真正窄腰 |
| `03-directory-router-loadbalance-cluster.md` | consumer 流量主线 | 理解 provider 集合如何被裁剪、选择、重试和放大 |
| `04-remoting-exchange-dispatcher-network.md` | 网络主线 | 理解 `Invocation -> Request -> Exchange -> Channel -> Codec -> Network` |
| `05-extensionloader-adaptive-activate-spi.md` | 扩展运行时 | 理解 Dubbo 如何动态装配 Protocol、Filter、Dispatcher、Cluster |
| `06-dubbo2-triple-injvm-protocol-comparison.md` | 协议对照 | 看懂 Dubbo2 / Triple / Injvm 如何共享窄腰又在 wire path 上分叉 |
| `07-scope-model-application-model-lifecycle.md` | 运行时骨架收束篇 | 理解 model tree / deployer 如何把前面所有主线重新收束 |

### ch07-dubbo-integration：Dubbo 集成层

| 文件 | 角色定位 | 读者收获 |
|------|----------|----------|
| `01-spring-springboot-integration-bootstrap.md` | Spring / Boot 接入桥 | 理解 `@DubboService` / `@DubboReference` 如何接回 Dubbo runtime |
| `02-config-merge-externalization-url-generation.md` | 配置语义篇 | 理解来源层 / refresh 层 / URL 层三段式配置处理 |

### ch08-dubbo-control-plane：Dubbo 控制面

| 文件 | 角色定位 | 读者收获 |
|------|----------|----------|
| `01-registryprotocol-registrydirectory-address-update.md` | 地址更新主线 | 理解 registry notify 如何变成 live invokers |
| `02-service-discovery-migration.md` | 双发现模型切换篇 | 理解 interface-level 与 application-level discovery 如何共存和迁移 |
| `03-config-center-dynamic-override.md` | 动态治理篇 | 理解地址不变时，为什么行为仍会变化 |
| `04-metadata-metadata-report.md` | 元数据基础设施篇 | 理解 `MetadataInfo` / `MetadataReport` / `MetadataService` 如何支撑 discovery 与治理 |

### ch09-dubbo-production-diagnostics：Dubbo 生产诊断

| 文件 | 角色定位 | 读者收获 |
|------|----------|----------|
| `01-timeout-retry-cluster-troubleshooting.md` | 调用失败判因篇 | 把 timeout / retry / cluster failure 压成三层判因模型 |
| `02-registry-config-metadata-mismatch.md` | 控制面失配篇 | 学会从 `directoryUrl` / `urlInvokerMap` / `serviceUrls` / `currentAvailableInvoker` 这些对象层排障 |
| `03-dispatcher-threadpool-provider-stall.md` | provider 执行面篇 | 理解 provider 为什么会“活着但越来越像死了” |

## 五、当前 Dubbo 这条线已经闭环到什么程度

### 已经形成的闭环

1. **运行时主干闭环**
   - export / refer
   - Invoker 窄腰
   - consumer 流量选择
   - remoting / exchange / dispatcher
   - 协议对照
   - model / lifecycle 总骨架

2. **集成层闭环**
   - Spring / Spring Boot 接入桥
   - 配置合并、外部化与 URL 生成

3. **控制面闭环**
   - registry 地址更新
   - service discovery / migration
   - config center / dynamic override
   - metadata / metadata report

4. **生产诊断闭环**
   - timeout / retry / cluster
   - registry / config / metadata 失配
   - dispatcher / threadpool / provider 假死

### 当前最稳的结论

到这里，Dubbo 已经不再只是“主干运行时卷”，而是形成了：

- 主干运行时层
- 集成层
- 控制面层
- 生产诊断层

四组能力的完整第一轮闭环。

## 六、当前还偏薄的方向

按目录观察和主题覆盖，Dubbo 这条线还偏薄的方向主要是：

1. **QoS / metrics / tracing / observability**
   - 还没有单独形成一组篇章
2. **Dubbo metadata 深挖**
   - 当前有 metadata 基础设施篇，但还没有 metadata 生产诊断或 metadata publish 深挖篇
3. **控制面与执行面的总失配大图**
   - 现在已经有多篇局部诊断文，但还没有一篇总的“事故地图”收束篇

## 七、后续可扩展方向

如果继续扩 Dubbo，建议优先级如下：

1. **Dubbo observability / QoS / metrics / tracing**
   - 作为生态与运维层补篇
2. **metadata 深挖或 metadata 失效诊断篇**
   - 作为控制面与治理支撑层补篇
3. **Dubbo 控制面 / 执行面失配总排障篇**
   - 把 `registry / migration / config / metadata / dispatcher / provider stall` 收成一张事故地图

## 八、现在适不适合切下一个框架

适合。

因为 Dubbo 现在已经具备：

- baseline 运行时主线
- Spring/Boot 接入桥
- 控制面主线
- 生产诊断主线

这意味着它已经不是“只讲了主干”，而是形成了完整的第一轮闭环。继续扩写会进入更边缘或更生态化的方向，收益开始下降。

如果现在切到下一个框架，是一个合理的停点。