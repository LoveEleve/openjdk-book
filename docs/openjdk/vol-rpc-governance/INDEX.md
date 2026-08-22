# RPC 与治理卷总索引

> 收口时间：2026-08-22  
> 当前覆盖范围：grpc-java、Dubbo、OpenFeign core、Spring Cloud OpenFeign  
> 当前状态：累计 `46` 篇 article base / `138` 个三件套文件，其中 grpc-java `20` 篇、Dubbo `16` 篇、OpenFeign `10` 篇

## 一、这份索引解决什么问题

这份索引不是简单的目录树，而是把当前已经完成的 RPC/治理篇章重新压成一张阅读地图。

它回答四个问题：

1. 这一卷现在到底覆盖了哪几条技术主线？
2. 如果读者不是顺序通读，应该按什么路线进入？
3. OpenFeign core 和 Spring Cloud OpenFeign 的边界，到底收在了哪里？
4. 当前已经形成了哪些闭环，后续最自然该往哪一层继续扩展？

## 二、当前完成总览

| 大章 | 主题 | 已完成 |
|------|------|--------|
| `ch01` ~ `ch05` | grpc-java | 20/20 |
| `ch06` ~ `ch09` | Dubbo | 16/16 |
| `ch10` | OpenFeign core | 3/3 |
| `ch11` | Spring Cloud OpenFeign | 7/7 |

总计：`46` 篇 article base，`138` 个三件套文件，目录级三件套完整率 `100%`。

## 三、推荐阅读顺序

### 路线 A：第一次系统进入这一卷

建议按"core runtime → 框架集成 → 治理能力 → 生产问题"的顺序进入：

1. `ch01-grpc-runtime/01-stub-channel-clientcall.md`
2. `ch01-grpc-runtime/04-nameresolver-loadbalancer-netty-transport.md`
3. `ch06-dubbo-runtime/01-invoker-chain-proxy-dispatch.md`
4. `ch08-dubbo-control-plane/01-registryprotocol-registrydirectory-address-update.md`
5. `ch10-openfeign-core/01-runtime-spine-builder-proxy-http.md`
6. `ch10-openfeign-core/03-client-codec-retry-error-capability.md`
7. `ch11-springcloud-openfeign/01-enablefeignclients-registrar-factorybean.md`
8. `ch11-springcloud-openfeign/03-loadbalancer-feign-client.md`
9. `ch11-springcloud-openfeign/04-circuitbreaker-fallback.md`
10. `ch11-springcloud-openfeign/06-timeout-options-retry-redirect.md`

这条路线的目标不是一次读完全部 46 篇，而是先建立这卷最稳定的四根主梁：

- grpc-java 的 transport / call 主干
- Dubbo 的 invocation / registry 主干
- OpenFeign core 的 builder / proxy / client 主干
- Spring Cloud OpenFeign 的 registrar / child context /治理桥主干

### 路线 B：只关心 OpenFeign 系列

如果读者这次主要是为了 Feign 体系，建议按完整链路读：

1. `ch10-openfeign-core/01-runtime-spine-builder-proxy-http.md`
2. `ch10-openfeign-core/02-contract-methodmetadata-requesttemplate.md`
3. `ch10-openfeign-core/03-client-codec-retry-error-capability.md`
4. `ch11-springcloud-openfeign/01-enablefeignclients-registrar-factorybean.md`
5. `ch11-springcloud-openfeign/02-springmvccontract-configuration-properties.md`
6. `ch11-springcloud-openfeign/03-loadbalancer-feign-client.md`
7. `ch11-springcloud-openfeign/04-circuitbreaker-fallback.md`
8. `ch11-springcloud-openfeign/05-micrometer-observation-capability.md`
9. `ch11-springcloud-openfeign/06-timeout-options-retry-redirect.md`
10. `ch11-springcloud-openfeign/07-codec-errordecoder-capability-boundary.md`

这是当前最完整的一条 Feign 源码分析链：

- 先理解 Feign 自己怎么造 client
- 再理解 Spring 怎么把它装进框架
- 再理解 LoadBalancer / CircuitBreaker / Micrometer / Options / Codec 边界如何依次挂上去

### 路线 C：只关心线上治理与排障

如果读者是带着事故或治理问题来的，建议这样进入：

1. `ch05-production-diagnostics/01-deadline-cancel-retry-troubleshooting.md`
2. `ch05-production-diagnostics/02-channel-subchannel-picker-diagnosis.md`
3. `ch09-dubbo-production-diagnostics/01-timeout-retry-cluster-fault-flow.md`
4. `ch09-dubbo-production-diagnostics/02-threadpool-serialization-dispatch-diagnosis.md`
5. `ch11-springcloud-openfeign/03-loadbalancer-feign-client.md`
6. `ch11-springcloud-openfeign/04-circuitbreaker-fallback.md`
7. `ch11-springcloud-openfeign/06-timeout-options-retry-redirect.md`

这条路线优先回答：

- 请求为什么没发出去
- 为什么打错实例
- 为什么 retry/fallback 和直觉不一样
- timeout / serialization / thread model 问题分别卡在哪一层

## 四、章节索引

### grpc-java：`ch01` ~ `ch05`

- 章节索引：`INDEX.md:1`
- 当前状态：`20` 篇 article base / `60` 个文件
- 角色定位：这一卷的第一条 runtime spine，从 call、transport、protocol semantics 一直到生产诊断和 xDS。
- 入口建议：
  1. `ch01-grpc-runtime/01-stub-channel-clientcall.md`
  2. `ch01-grpc-runtime/04-nameresolver-loadbalancer-netty-transport.md`
  3. `ch03-runtime-deepening/01-service-config-retry-hedging.md`
  4. `ch05-production-diagnostics/01-deadline-cancel-retry-troubleshooting.md`

### Dubbo：`ch06` ~ `ch09`

- 章节索引：`DUBBO-INDEX.md:1`
- 当前状态：`16` 篇 article base / `48` 个文件
- 角色定位：这一卷的第二条 runtime + control plane spine，从 Invoker 链、Directory/Cluster、注册中心、配置中心到生产故障。
- 入口建议：
  1. `ch06-dubbo-runtime/01-invoker-chain-proxy-dispatch.md`
  2. `ch06-dubbo-runtime/04-directory-router-cluster-loadbalance.md`
  3. `ch08-dubbo-control-plane/01-registryprotocol-registrydirectory-address-update.md`
  4. `ch09-dubbo-production-diagnostics/01-timeout-retry-cluster-fault-flow.md`

### OpenFeign core：`ch10`

- 当前状态：`3` 篇 article base / `9` 个文件
- 角色定位：Feign 自身 runtime spine，回答 builder、proxy、method metadata、request template、client、codec、retry、error、capability 各自在哪一层。
- 主线文件：
  1. `ch10-openfeign-core/01-runtime-spine-builder-proxy-http.md`
  2. `ch10-openfeign-core/02-contract-methodmetadata-requesttemplate.md`
  3. `ch10-openfeign-core/03-client-codec-retry-error-capability.md`
- 最稳结论：OpenFeign core 负责定义并执行 Feign 自己的 runtime spine，Spring 集成之前，builder / proxy / client / codec / retry / error / capability 这些 SPI 已经完整存在。

### Spring Cloud OpenFeign：`ch11`

- 章节索引：`ch11-springcloud-openfeign/INDEX.md:1`
- 当前状态：`7` 篇 article base / `21` 个文件
- 角色定位：Spring 对 Feign 的 integration spine，回答 registrar、child context、contract、LoadBalancer、CircuitBreaker、Micrometer、Options、codec 边界如何挂到 Feign core 上。
- 推荐入口：
  1. `ch11-springcloud-openfeign/01-enablefeignclients-registrar-factorybean.md`
  2. `ch11-springcloud-openfeign/03-loadbalancer-feign-client.md`
  3. `ch11-springcloud-openfeign/04-circuitbreaker-fallback.md`
  4. `ch11-springcloud-openfeign/07-codec-errordecoder-capability-boundary.md`
- 最稳结论：Spring Cloud OpenFeign 的核心职责，不是重写 Feign runtime，而是用 registrar、child context、配置模型和少量基础设施桥，把 OpenFeign core 的 SPI 组装成一套 Spring 应用可用的 client 运行时。

## 五、当前已经闭环的能力带

### 1. grpc-java runtime 闭环

- 客户端调用主线
- 服务端调用主线
- interceptor / context / deadline
- resolver / load balancer / transport
- protocol semantics
- xDS 与生产诊断

### 2. Dubbo runtime + control plane 闭环

- proxy / invoker / filter / exporter
- directory / router / cluster / loadbalance
- registry / config center / metadata
- Spring / Spring Boot 集成
- timeout / retry / serialization / 线程模型排障

### 3. Feign integration 闭环

- OpenFeign core runtime spine
- Spring Cloud registrar / child context spine
- LoadBalancer bridge
- CircuitBreaker / fallback bridge
- Micrometer / capability bridge
- timeout / options / retry bridge
- codec / error decoder / capability boundary

## 六、这一卷当前最稳的结论

到这里，这一卷已经形成了三条可并行阅读的源码主线：

1. **grpc-java 主线**：偏 transport / protocol / production
2. **Dubbo 主线**：偏 invocation / registry / control plane / production
3. **Feign 主线**：偏 declarative client runtime / Spring integration /治理桥接

如果把它们再压一层，可以得到一个更稳定的卷级结论：

**这一卷当前不再只是单框架源码分析，而是已经形成了“core runtime → framework integration → governance bridge → production diagnostics”四层闭环，并且这四层在 grpc-java、Dubbo、Feign 三条技术线上都能互相对照。**

## 七、OpenFeign core 与 Spring Cloud OpenFeign 的边界

这是本轮补索引后最值得明确写进卷级导航的一点。

- OpenFeign core 回答：Feign 自己的 builder、proxy、client、contract、codec、retry、error、capability 是怎么工作的。
- Spring Cloud OpenFeign 回答：Spring 怎么把这些 core SPI 组装成框架内可注入、可配置、可观测、可治理的 client。

也就是说：

- `ch10` 偏 runtime spine
- `ch11` 偏 integration spine

这两个大章连起来，才组成当前这一卷完整的 Feign 部分。

## 八、后续最自然的扩展方向

如果继续扩展，这一卷最自然的方向有三条：

1. **Feign / Spring Cloud 下层基础设施继续下钻**  
   比如 `Spring Cloud LoadBalancer`、`CircuitBreaker` 下层库，或者更细的 Observability bridge。
2. **治理外围栈继续扩展**  
   比如 `Nacos`、`Sentinel`、`Cloud Gateway`。
3. **卷级辅助文档继续补强**  
   比如术语表、事故排障索引、跨框架对照地图。

## 九、当前状态结论

- 当前目录级三件套完整率：`100%`
- 当前已完成 article base：`46`
- 当前总文件数（三件套）：`138`
- 当前卷级已形成 grpc-java、Dubbo、Feign 三条稳定主线
- 当前最自然的下一步：
  1. 修正 `DUBBO-INDEX.md:1` 的统计数字并补卷级互链
  2. 决定继续下钻 Spring Cloud 治理下层库，还是转入 `Nacos` / `Sentinel` / `Gateway`
