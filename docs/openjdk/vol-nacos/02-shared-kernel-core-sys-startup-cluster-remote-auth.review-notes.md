# Nacos：shared kernel——core / sys / startup / cluster / remote / auth — review notes

## 深度 review 结论

本轮按"事实 → 因果 → 结构 → 删码 → 边界"重审后，**当前正文无必须修改的事实性错误**，主线成立，可以收口。

之后已追加一轮深修：把 `ProtocolManager`、`RequestHandlerRegistry`、`RemoteRequestAuthFilter` 的更细 `file:line` 锚点补回正文，用来把“shared wiring 怎么给 AP/CP 注入成员”“request handler registry 到底注册了什么”“remote auth 到底先验什么再验什么”这三条共享内核因果链压得更实。

## 第一轮：事实审

### 已复核的关键结论

1. `bootstrap` 会先拉起 core/basic context，再进入 web/console/optional context，这说明 shared kernel 先于业务上下文启动，证据：`bootstrap/NacosBootstrap.java:74`、`:83`、`:93`、`:99`、`:106`、`:113`。
2. `core` 通过 `spring.factories` 注册 `ApplicationListener` 与 `SpringApplicationRunListener`，说明 Nacos 在 Spring Boot 生命周期外又叠了一层自己的启动编排，证据：`core/resources/META-INF/spring.factories:2`、`:5`。
3. `NacosStartUp` 定义了 phase SPI，`NacosStartUpManager` 负责加载、注册、选择与失败时逆序处理，证据：`core/listener/startup/NacosStartUp.java:28`、`core/listener/startup/NacosStartUpManager.java:43`、`:60`、`:74`、`:85`。
4. `StartingApplicationListener` 把 Spring lifecycle 映射到 `currentStartUp` 上，证据：`core/listener/StartingApplicationListener.java:40`、`:45`、`:58`、`:64`、`:71`。
5. `NacosCoreStartUp` 负责环境注入、配置加载、watcher 注册、system property 初始化、storage mode 日志与失败清理，证据：`core/listener/startup/NacosCoreStartUp.java:84`、`:101`、`:106`、`:118`、`:158`、`:167`、`:175`。
6. `sys` 更偏 support floor：`EnvUtil`、`NacosTypeExcludeFilter`、文件监听等基础设施落在这里，证据：`sys/env/EnvUtil.java:127`、`:266`、`:276`、`sys/filter/NacosTypeExcludeFilter.java:37`。
7. `core` 持有 cluster kernel：`ServerMemberManager`、`LookupFactory`，证据：`core/cluster/ServerMemberManager.java:91`、`:156`、`core/cluster/lookup/LookupFactory.java:64`、`:126`。
8. `core` 持有 consistency wiring：`ProtocolManager`、`ConsistencyConfiguration`，证据：`core/distributed/ProtocolManager.java:46`、`:129`、`:164`、`core/distributed/ConsistencyConfiguration.java:38`；正文现在还补了 `:131`、`:133`、`:134`、`:141`、`:143`、`:144`、`:149`、`:157`、`:173`、`:174`、`:176`、`:177` 来压实 AP/CP 成员注入与 memberChange 分流机制。
9. `core` 持有 shared remote substrate：`BaseRpcServer`、`BaseGrpcServer`、`RequestHandlerRegistry`、`ConnectionManager`，证据：`core/remote/BaseRpcServer.java:43`、`core/remote/grpc/BaseGrpcServer.java:91`、`core/remote/RequestHandlerRegistry.java:75`、`core/remote/ConnectionManager.java:102`；正文现在还补了 `RequestHandlerRegistry.java:77`、`:78`、`:79`、`:95`、`:96`、`:97`、`:99`、`:105`、`:109`、`:110`、`:113`、`:120` 来压实 handler、TPS 控制点、invoke source 和请求类型映射的注册路径。
10. `core` 持有 shared auth cut-in point：`AuthConfig`、`AuthFilter`、`RemoteRequestAuthFilter`，证据：`core/auth/AuthConfig.java:35`、`core/auth/AuthFilter.java:27`、`core/auth/RemoteRequestAuthFilter.java:67`；正文现在还补了 `:72`、`:73`、`:74`、`:76`、`:80`、`:86`、`:87`、`:92`、`:100`、`:101`、`:102`、`:103`、`:104`、`:112`、`:113`、`:114`，把 remote auth 的 secured 元数据读取、identity short-circuit、资源解析、身份校验、authority 校验链压得更细。
11. naming 与 config 的 standalone app 都直接扫描 `core`，说明它们站在 shared kernel 上，证据：`naming/NamingApp.java:29`、`config/server/Config.java:29`。
12. naming/config 的 package filter 分别由 `NamingEnabledFilter` 与 `ConfigEnabledFilter` 控制，并通过 `NacosTypeExcludeFilter` 接入整体扫描边界，证据：`naming/config/NamingEnabledFilter.java:41`、`config/filter/ConfigEnabledFilter.java:41`、`sys/filter/NacosTypeExcludeFilter.java:43`。

### 测试与辅助证据复核

1. `core/listener/StandaloneProfileApplicationListenerTest.java:41` — 启动 listener 相关行为。
2. `sys/filter/NacosTypeExcludeFilterTest.java:39` — type exclude/filter 行为。
3. `core/cluster/ServerMemberManagerTest.java:62` — cluster substrate。
4. `core/distributed/raft/JRaftProtocolTest.java:47` — consistency substrate。
5. `core/CoreUtApplication.java:22` — core-only test app 入口。

## 第二轮：因果审

- 如果不先从启动链入手，读者就无法理解为什么 `core` 会先于业务上下文被拉起：当前正文已从 `bootstrap` 多上下文装配切入，成立。✅
- 如果不把 `spring.factories -> run listener -> application listener -> startup phase` 这条链拉直，shared kernel 会被误写成若干静态工具集合：当前正文已拉直，成立。✅
- 如果不把 `sys` 和 `core` 做层级切分，后续 cluster/remote/auth 就会继续被写成“公共工具类”：当前正文已切开，成立。✅
- 如果不说明 naming/config 直接扫描 `core`，shared kernel 会显得像理论推断而不是源码现实：当前正文已用入口类压实，成立。✅
- 如果不明确边界，shared kernel 篇会侵占 remote/cluster/auth/consistency 后续篇章：当前正文已单列边界，成立。✅

## 第三轮：结构审

### 结构是否跑偏

没有跑偏。正文推进顺序是：

1. 先抓“为什么 `core` 不是杂物间”  
2. 再用四个失败方案打掉最常见错误模型  
3. 再建立 `sys -> core -> naming/config` 总图  
4. 再从启动链进入 shared kernel 的 phase runtime  
5. 再切出 `sys` 的 support floor 与 `core` 的五根支柱  
6. 最后再解释 naming/config 站在 kernel 上，并明确与后续篇章的边界  

这保证了正文没有退化成包名罗列，也没有退化成 remote/cluster/auth 的抢跑篇。✅

### 失败方案是否有效

有效，而且命中了这一篇最需要先打掉的四种错觉：
- `core` 是杂物间  
- `sys` 和 `core` 差不多  
- naming/config 是两个独立服务器只共享 util  
- Nacos 启动就是普通 Spring Boot  

这四条分别对应模块边界、层级边界、业务与内核边界、启动机制边界。✅

## 第四轮：删码测试

删除所有代码块后，正文仍然能复述：

- `sys` 是 support floor，`core` 是 shared server kernel  
- startup 编排不是普通 Spring Boot，而是多层桥接后的 phase 系统  
- shared kernel 的五根支柱是 startup、cluster、consistency wiring、shared RPC、shared auth  
- naming/config 显式站在 `core` 上，而不是只共享少量 util  
- remote/cluster/auth/consistency 的细节被刻意 defer 到后续篇章  

删码后主线不塌，说明代码块不是叙事骨架。✅

## 第五轮：边界审

### 本篇边界控制

当前正文边界控制是对的：
- 没深挖 gRPC 帧、双向流、协商器等 remote 细节  
- 没深挖 member lookup、address server、server-to-server RPC 细节  
- 没深挖 auth plugin 与资源权限模型  
- 没深挖 AP/CP 语义和 jraft/distro 算法  
- 重点压在 `core` / `sys` / startup / cluster / remote / auth 的 shared substrate 边界上  

### 与后续篇章的边界

- 第 03 篇可自然接 remote / gRPC 深拆。✅
- cluster 篇可接 member lookup / cluster RPC / reporting。✅
- auth 篇可接 plugin / resource / permission model。✅
- consistency 篇可接 AP/CP 语义与 jraft/distro。✅
- 本篇自身位置：`vol-nacos` 的 shared kernel 立柱篇。✅

## 第六轮：风险点

### 已确认不是问题的点

1. 正文没有把 `core` 写成 leftovers bucket。  
2. 正文没有把 `sys` 和 `core` 写成同一层。  
3. 正文没有把 naming/config 写成“共享少量 util 的独立服务器”。  
4. 正文没有把 Nacos 启动写成普通 Spring Boot lifecycle。  
5. 正文没有在 shared kernel 篇里过度展开后续 remote/cluster/auth/consistency 细节。  

### 当前仍存在的轻微风险

1. 正文已经补齐关键上游锚点，但如果后续做整卷统一抛光，仍可继续把 `BaseRpcServer`、`BaseGrpcServer`、`StartingApplicationListener` 的局部路径压得更细。  
2. 这个问题不影响主线正确性，属于进一步精修项。  

## 机械检查

- 禁用表达已复扫；当前命中为 0。✅
- 正文行数：509。✅
- 代码块未承担主叙事骨架。✅
- 主要结论均已落到 file:line。✅
- 正文已经达到 shared kernel 篇所需的长文规模。✅

## 结论

本轮深度 review 后，正文可以认为已经完成收口：

- 事实层面成立  
- 因果链成立  
- 结构推进成立  
- 删码后主线成立  
- 与后续篇章边界清晰  

如果后续要再提升一档，优先项不是改结构，而是补更细的 `ProtocolManager` / `RequestHandlerRegistry` / `RemoteRequestAuthFilter` 锚点。当前版本不改也可以过关。 
