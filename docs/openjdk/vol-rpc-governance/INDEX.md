# RPC 与治理卷总索引（grpc-java）

> 收口时间：2026-08-20  
> 当前覆盖范围：`ch01` ~ `ch05` + xDS 客户端 / 服务端两篇  
> 当前状态：目录级三件套完整，累计 `20` 篇 article base / `60` 个文件

## 一、这份索引解决什么问题

这份索引不是简单的目录树，而是把已经完成的 grpc-java 篇章重新压成一张“阅读地图”。

它回答三个问题：

1. 这 20 篇分别在整卷里承担什么角色？
2. 如果读者不是从头到尾通读，应该按什么顺序进入？
3. 当前已经完成了哪些层，后续若继续扩展，应该往哪几个方向加篇？

## 二、当前完成总览

| 章节 | 主题 | 已完成 |
|------|------|--------|
| `ch01-grpc-runtime` | 主干运行时 | 4/4 |
| `ch02-codegen-builders` | 生成代码与装配 | 4/4 |
| `ch03-runtime-deepening` | 机制补深 | 6/6 |
| `ch04-protocol-semantics` | 协议语义 | 3/3 |
| `ch05-production-diagnostics` | 生产诊断 | 3/3 |

总计：`20` 篇，目录级三件套完整率 `100%`。

## 三、推荐阅读顺序

### 路线 A：第一次系统进入 grpc-java

按完整卷主线读：

1. `ch01-grpc-runtime/01-stub-channel-clientcall.md`
2. `ch01-grpc-runtime/02-servercall-and-streaming-model.md`
3. `ch01-grpc-runtime/03-interceptors-context-deadline.md`
4. `ch01-grpc-runtime/04-nameresolver-loadbalancer-netty-transport.md`
5. `ch02-codegen-builders/01-protoc-grpc-skeleton.md`
6. `ch02-codegen-builders/02-channel-server-builders.md`
7. `ch02-codegen-builders/03-marshaller-protoutils-message-bridge.md`
8. `ch02-codegen-builders/04-inprocess-testing-semantics.md`
9. `ch03-runtime-deepening/01-service-config-retry-hedging.md`
10. `ch03-runtime-deepening/02-callcredentials-auth-boundary.md`
11. `ch03-runtime-deepening/03-health-reflection-channelz.md`
12. `ch03-runtime-deepening/04-compression-codec-message-framing.md`
13. `ch04-protocol-semantics/01-method-type-contracts.md`
14. `ch04-protocol-semantics/02-metadata-status-trailers.md`
15. `ch04-protocol-semantics/03-cancel-halfclose-completion.md`
16. `ch05-production-diagnostics/01-deadline-cancel-retry-troubleshooting.md`
17. `ch05-production-diagnostics/02-channel-subchannel-picker-diagnosis.md`
18. `ch05-production-diagnostics/03-keepalive-flowcontrol-connection.md`
19. `ch03-runtime-deepening/05-xds-client-bootstrap-ads-routing.md`
20. `ch03-runtime-deepening/06-xds-server-listener-filterchain-tls.md`

### 路线 B：只关心线上排障

如果读者是带着事故来的，建议这样进入：

1. `ch05-production-diagnostics/01-deadline-cancel-retry-troubleshooting.md`
2. `ch05-production-diagnostics/02-channel-subchannel-picker-diagnosis.md`
3. `ch05-production-diagnostics/03-keepalive-flowcontrol-connection.md`
4. 回补：`ch04-protocol-semantics/02-metadata-status-trailers.md`
5. 回补：`ch04-protocol-semantics/03-cancel-halfclose-completion.md`
6. 回补：`ch03-runtime-deepening/01-service-config-retry-hedging.md`

### 路线 C：只关心 xDS / 基础设施进阶

1. `ch01-grpc-runtime/04-nameresolver-loadbalancer-netty-transport.md`
2. `ch03-runtime-deepening/01-service-config-retry-hedging.md`
3. `ch05-production-diagnostics/02-channel-subchannel-picker-diagnosis.md`
4. `ch03-runtime-deepening/05-xds-client-bootstrap-ads-routing.md`
5. `ch03-runtime-deepening/06-xds-server-listener-filterchain-tls.md`

## 四、章节索引

### ch01-grpc-runtime：主干运行时

| 文件 | 角色定位 | 读者收获 |
|------|----------|----------|
| `01-stub-channel-clientcall.md` | 客户端调用主线 | 建立 `stub -> channel -> ClientCall` 的基本心智图 |
| `02-servercall-and-streaming-model.md` | 服务端调用主线 | 建立 `transport -> ServerCall -> handler` 的基本心智图 |
| `03-interceptors-context-deadline.md` | 横切协议主线 | 理解 interceptor / Context / deadline 如何跨调用链传播 |
| `04-nameresolver-loadbalancer-netty-transport.md` | 发现、选址与 transport 桥 | 建立 resolver / LB / subchannel / transport 的桥接图 |

### ch02-codegen-builders：生成代码与装配

| 文件 | 角色定位 | 读者收获 |
|------|----------|----------|
| `01-protoc-grpc-skeleton.md` | 代码生成入口 | 从 `.proto` 到 `*Grpc` 骨架的形成过程 |
| `02-channel-server-builders.md` | builder 装配层 | 用户配置如何进入 channel / server 运行时 |
| `03-marshaller-protoutils-message-bridge.md` | 对象与消息体桥 | 理解对象如何变成 `InputStream` / 字节流 |
| `04-inprocess-testing-semantics.md` | 测试与 in-process 语义 | 理解 grpc-java 官方测试哲学 |

### ch03-runtime-deepening：机制补深

| 文件 | 角色定位 | 读者收获 |
|------|----------|----------|
| `01-service-config-retry-hedging.md` | 调用策略层 | 理解配置、限额和逻辑流状态机 |
| `02-callcredentials-auth-boundary.md` | 认证边界 | 理解为什么 `CallCredentials` 不是 metadata helper |
| `03-health-reflection-channelz.md` | 自描述诊断层 | 理解 grpc-java 如何暴露自身运行时状态 |
| `04-compression-codec-message-framing.md` | wire format 与压缩层 | 理解 5 字节帧头、压缩协商和读写路径 |
| `05-xds-client-bootstrap-ads-routing.md` | xDS 客户端主链 | 理解控制面如何改写 resolver / route / LB |
| `06-xds-server-listener-filterchain-tls.md` | xDS 服务端主链 | 理解动态 listener / filter chain / TLS / routing |

### ch04-protocol-semantics：协议语义

| 文件 | 角色定位 | 读者收获 |
|------|----------|----------|
| `01-method-type-contracts.md` | 四种调用模式契约 | 理解 1:1 / 1:N / N:1 / N:N 及 enforce 点 |
| `02-metadata-status-trailers.md` | 元数据与状态语义 | 理解 headers / trailers / Status 的三段式生命周期 |
| `03-cancel-halfclose-completion.md` | 终止边界 | 理解 cancel / deadline / completion 如何收敛到 `onClose()` |

### ch05-production-diagnostics：生产诊断

| 文件 | 角色定位 | 读者收获 |
|------|----------|----------|
| `01-deadline-cancel-retry-troubleshooting.md` | 状态码判因 | 用“来源层 → 重试层 → 收敛层”解释失败 |
| `02-channel-subchannel-picker-diagnosis.md` | 本地卡住判因 | 用四层状态 + 两层缓冲解释“没报错但发不出去” |
| `03-keepalive-flowcontrol-connection.md` | 连接问题判因 | 区分 keepalive / flow-control / lifecycle 三套并行机制 |

## 五、当前收口判断

### 已经闭环的能力带

1. **主干运行时闭环**：客户端、服务端、横切、发现/选址、transport
2. **生成与装配闭环**：codegen、builder、marshaller、testing
3. **规范层闭环**：方法契约、Metadata/Status、cancel/half-close/completion
4. **生产排障闭环**：deadline/cancel/retry、channel/subchannel/picker、keepalive/flow-control/connection
5. **xDS 双篇闭环**：客户端控制面到数据面、服务端动态接入层

### 当前最稳的结论

到这里，这一卷已经不再只是“主干源码分析”，而是形成了：

- 主干层
- 集成层
- 机制补深层
- 规范层
- 生产层
- xDS 高阶层

的完整闭环。

## 六、后续可扩展方向

如果继续扩展，优先级建议如下：

1. **xDS filters / security 专题**
   - RBAC
   - ext_authz
   - ext_proc
   - fault injection
2. **平台 / 生态变体层**
   - okhttp transport
   - cronet transport
   - servlet
   - android / binder
   - opentelemetry / gcp-observability
3. **总览型辅助文档**
   - 整卷概念地图
   - 术语表
   - 事故排障索引

## 七、当前状态结论

- 当前目录级三件套完整率：`100%`
- 当前已完成 article base：`20`
- 当前总文件数（三件套）：`60`
- 当前整卷最适合继续的方向：
  1. 先稳定收口（本索引已完成）
  2. 再决定继续补 xDS/security 还是平台/生态变体层
