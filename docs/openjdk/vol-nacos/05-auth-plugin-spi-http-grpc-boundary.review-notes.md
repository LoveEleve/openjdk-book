# Nacos：auth / plugin SPI / HTTP-gRPC boundary — review notes

## 深度 review 结论

本轮按"事实 → 因果 → 结构 → 删码 → 边界"重审后，**当前正文无必须修改的事实性错误**，主线成立，可以收口。

之后已追加一轮深修：把 `AbstractWebAuthFilter`、`RemoteRequestAuthFilter`、`AbstractProtocolAuthService` 的更细 `file:line` 锚点补回正文，用来把“HTTP 侧到底在哪些节点短路/放行”“remote 侧怎样先验 server identity 再验 authority”“协议适配层怎样把插件选择真正落到 `enableAuth/validateIdentity/validateAuthority` 上”这三条因果链压得更实。

## 第一轮：事实审

### 已复核的关键结论

1. `plugin/auth` 提供的是 auth SPI 契约层，包括 `AuthPluginService`、`AuthPluginManager`、`IdentityContext`、`Resource`、`Permission` 等抽象，不是默认实现层，证据：`plugin/auth/.../AuthPluginService.java:34`、`plugin/auth/.../AuthPluginManager.java:35`、`plugin/auth/.../Resource.java:31`、`plugin/auth/.../Permission.java:29`。
2. `auth` 模块承担的是协议适配层职责：`AbstractProtocolAuthService`、`HttpProtocolAuthService`、`GrpcProtocolAuthService` 负责把 HTTP/gRPC 请求解析成统一鉴权输入，证据：`auth/AbstractProtocolAuthService.java:47`、`auth/HttpProtocolAuthService.java:42`、`auth/GrpcProtocolAuthService.java:43`。
3. `core` 持有 HTTP 侧 shared auth 入口：`AuthConfig` 注册 `AuthFilter` / `AuthAdminFilter`，`AbstractWebAuthFilter` 负责基于 `ControllerMethodsCache` 找到 controller method 并读取 `@Secured`，证据：`core/auth/AuthConfig.java:35`、`core/code/ControllerMethodsCache.java:70`、`core/auth/AbstractWebAuthFilter.java:71`；正文现在还补了 `:72`、`:76`、`:82`、`:83`、`:90`、`:91`、`:93`、`:95`、`:101`、`:105`、`:106`、`:107`、`:108`、`:111`、`:115`、`:120`、`:123`、`:124`，把 method 缺失/未加注解短路、server identity 短路、identity-only API 分支、authority 校验顺序压得更细。
4. `core` 也持有 remote/gRPC 侧 shared auth 入口：`RemoteRequestAuthFilter` 是 `RequestHandler` filter 链的一部分，而不是 servlet filter 复用，证据：`core/auth/RemoteRequestAuthFilter.java:51`、`core/remote/RequestHandler.java:46`；正文现在还补了 `RemoteRequestAuthFilter.java:72`、`:73`、`:74`、`:76`、`:80`、`:86`、`:87`、`:88`、`:92`、`:100`、`:101`、`:102`、`:103`、`:104`、`:105`、`:106`、`:108`、`:112`、`:113`，把 inner API 短路、server identity、`X-Real-IP` 注入、identity/authority 校验链压得更细。
5. `console` 不是另一套 auth 世界，而是复用同一类 web auth filter 基础能力与 console auth config，证据：`console/filter/NacosConsoleAuthFilter.java:31`、`console/config/ConsoleWebConfig.java:84`、`console/config/NacosConsoleAuthConfig.java:31`。
6. `@Secured` 定义 action、resource override、signType、custom parser、tags、apiType，是端点级 policy declaration，不是实现，证据：`auth/annotation/Secured.java:37`。
7. 资源解析优先级是：显式 `secured.resource()` > built-in parser by `signType` > custom `parser()` fallback，证据：`auth/HttpProtocolAuthService.java:63`、`auth/GrpcProtocolAuthService.java:63`、`auth/AbstractProtocolAuthService.java:125`、`:140`。
8. HTTP naming/config 资源解析与 gRPC naming/config 资源解析使用不同协议适配器，但都会归一到 `Resource`，证据：`auth/parser/http/NamingHttpResourceParser.java:48`、`auth/parser/http/ConfigHttpResourceParser.java:36`、`auth/parser/grpc/NamingGrpcResourceParser.java:34`、`auth/parser/grpc/ConfigGrpcResourceParser.java:35`。
9. `IdentityContext` 与 `Permission(resource + action)` 是 plugin 最终消费的统一输入模型，证据：`plugin/auth/.../IdentityContext.java:27`、`plugin/auth/.../Permission.java:29`。
10. 默认 auth engine 并不 hardcode 在 core 中，而是在 `plugin-default-impl/nacos-default-auth-plugin` 中提供 `nacos` / `ldap` 两套内建实现，证据：`plugin-default-impl/.../NacosAuthPluginService.java:47`、`plugin-default-impl/.../LdapAuthPluginService.java:28`。
11. 默认 auth plugin 通过 SPI 文件和 `AutoConfiguration.imports` 接入，而不是 core 手工 new，证据：`plugin-default-impl/.../META-INF/services/...AuthPluginService:17`、`plugin-default-impl/.../AutoConfiguration.imports:17`。
12. 具体 auth engine 的选择由 `AuthPluginManager` + `nacos.core.auth.system.type` 完成，证据：`plugin/auth/.../AuthPluginManager.java:50`、`core/auth/NacosServerAuthConfig.java:151`；正文现在还补了 `auth/AbstractProtocolAuthService.java:64`、`:65`、`:68`、`:76`、`:77`、`:80`、`:86`、`:87`、`:90`，把插件选择如何真正落到 `enableAuth / validateIdentity / validateAuthority` 上压得更细。

### 测试与辅助证据复核

1. `core/auth/AuthFilterTest.java:94` — HTTP auth filter 行为。
2. `core/auth/RemoteRequestAuthFilterTest.java:100` — remote auth filter 行为。
3. `auth/HttpProtocolAuthServiceTest.java:75` — HTTP protocol adapter。
4. `auth/GrpcProtocolAuthServiceTest.java:83` — gRPC protocol adapter。
5. `auth/parser/http/NamingHttpResourceParserTest.java:43`、`ConfigHttpResourceParserTest.java:42` — HTTP resource parser。
6. `auth/parser/grpc/NamingGrpcResourceParserTest.java:34`、`ConfigGrpcResourceParserTest.java:34` — gRPC resource parser。
7. `plugin/auth/.../AuthPluginManagerTest.java:59` — SPI loading。
8. `test/core-test/.../ConfigAuthCoreITCase.java:85`、`NamingAuthCoreITCase.java:68` — end-to-end permission flavor。

## 第二轮：因果审

- 如果不先切开四层模型，读者会把“拦截入口”“请求解析”“契约定义”“默认实现”混成一个 auth 模块故事：当前正文已切开，成立。✅
- 如果不分别走 HTTP 与 remote/gRPC 两条链，读者会误把 remote auth 写成 servlet filter 变体：当前正文已分开，成立。✅
- 如果不说明 `IdentityContext + Resource + Permission` 的统一模型，plugin SPI 会显得像魔法黑盒：当前正文已说明，成立。✅
- 如果不把 default plugin 的 SPI 与 auto-config 接线讲清，core hardcode 误解就会一直存在：当前正文已纠正，成立。✅
- 如果不明确哪些内容留给后续 security deep-dive，当前篇会迅速失控成实现细节大杂烩：当前正文已控制边界，成立。✅

## 第三轮：结构审

### 结构是否跑偏

没有跑偏。正文推进顺序是：

1. 先抓“为什么 Nacos 的 auth 最容易被写成一团”  
2. 再用四个失败方案打掉最常见错误模型  
3. 再建立四层总图：intercept -> adapt -> SPI -> impl  
4. 再分别走 HTTP 与 remote/gRPC 两条鉴权链  
5. 再统一到 `IdentityContext + Resource + Permission` 模型  
6. 最后再切出 SPI 与默认实现层的接线方式和后续边界  

这保证了正文没有退化成 auth 类名百科，也没有退化成某个默认实现的细节说明书。✅

### 失败方案是否有效

有效，而且正好命中了这一篇最需要先打掉的四种错觉：
- auth 全都在 `auth` 模块里  
- remote/gRPC auth 只是 servlet filter 换个协议  
- 默认 auth 是 hardcode 在 core 里的  
- plugin 自己直接解析 HTTP/gRPC 请求  

这四条分别对应模块层、入口层、实现层、协议解析层的常见错位。✅

## 第四轮：删码测试

删除所有代码块后，正文仍然能复述：

- Nacos auth 是四层架构：intercept -> adapt -> SPI -> impl  
- HTTP 与 remote/gRPC 入口不同，但最终都会被规范化成 `IdentityContext + Resource + Permission`  
- 默认 `nacos` / `ldap` auth engine 不在 core 里 hardcode，而是在 `plugin-default-impl` 里通过 SPI 与 auto-config 接入  
- plugin 看到的是规范化后的 auth 输入，而不是原始协议请求  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

### 本篇边界控制

当前正文边界控制是对的：
- 没深讲 JWT/token 缓存细节  
- 没深讲 LDAP bind 细节  
- 没深讲默认 auth plugin 的持久化表结构与 CRUD  
- 没深讲 console 业务管理流  
- 重点压在 auth architecture 分层与 plugin 接线边界上  

### 与后续篇章的边界

- 第 06 篇将进入 naming domain model，auth 只作为横切前置知识。✅
- 后续 security deep-dive 可从默认 auth plugin 持久化、token、ldap 细节继续下钻。✅
- console 相关管理流可单独在 console/operator 篇处理。✅
- 本篇自身位置：`vol-nacos` 的横切安全与插件接线篇。✅

## 第六轮：风险点

### 已确认不是问题的点

1. 正文没有把 auth 全写进 `auth` 模块。  
2. 正文没有把 remote/gRPC auth 写成 servlet filter 变体。  
3. 正文没有把默认 auth 写成 core hardcode。  
4. 正文没有把 plugin 写成直接解析协议请求的地方。  
5. 正文没有把 HTTP 与 remote/gRPC 割裂成两套完全不同的 auth 世界。  

### 当前仍存在的轻微风险

1. 正文已经补齐关键 auth 主链锚点，但如果后续做整卷统一抛光，仍可继续把 `HttpProtocolAuthService`、`GrpcProtocolAuthService`、各类 resource parser 的局部路径压得更细。  
2. 这个问题不影响主线正确性，属于进一步精修项。  

## 机械检查

- 禁用表达已复扫；当前命中为 0。✅
- 正文行数：449。✅
- 代码块未承担主叙事骨架。✅
- 主要结论均已落到 file:line。✅
- 正文已经达到 auth architecture 篇所需的长文规模。✅

## 结论

本轮深度 review 后，正文可以认为已经完成收口：

- 事实层面成立  
- 因果链成立  
- 结构推进成立  
- 删码后主线成立  
- 与后续篇章边界清晰  

如果后续要再提升一档，优先项不是改结构，而是补更细的 `AbstractWebAuthFilter` / `RemoteRequestAuthFilter` / `AbstractProtocolAuthService` 锚点。当前版本不改也可以过关。 
