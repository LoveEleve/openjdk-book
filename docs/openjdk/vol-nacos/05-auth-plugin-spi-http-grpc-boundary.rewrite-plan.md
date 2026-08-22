# Nacos：auth / plugin SPI / HTTP-gRPC boundary — rewrite plan

## 篇章定位

- 写作卷：`vol-nacos`
- 章节：`ch02-remote-cluster-auth`
- 篇：`05 Nacos：auth / plugin SPI / HTTP-gRPC boundary`
- 对应主题：`N-05 auth / plugin`
- 文章类型：横切安全与扩展边界篇
- 正文状态：未开始
- 分析对象：`Nacos 3.0.3`

## 文章定位

- 核心困惑：Nacos 的 auth 很容易被写成一团：有人会说“auth 都在 `auth` 模块里”，有人会说“其实就是 `core` 里几个 filter”，还有人会把 default auth plugin 当成 core 自带实现。真实源码并不是单层结构，而是至少有四层：`core`/`console` 的拦截入口、`auth` 的协议适配层、`plugin/auth` 的 SPI 契约层、`plugin-default-impl` 的默认实现层。问题不是“有没有 auth”，而是：**请求是在哪一层被拦住、在哪一层被解析、在哪一层被交给插件、又在哪一层选出具体 auth engine。**
- 一句话顿悟：Nacos 3.0.3 的 auth 不是单一模块，而是**`core` / `console` 负责拦截，`auth` 负责把 HTTP/gRPC 请求规范化成 `IdentityContext + Resource + Permission`，`plugin/auth` 提供 SPI 契约，`plugin-default-impl` 提供 `nacos` / `ldap` 等默认实现和 Spring wiring。**
- 文章边界：本篇重点讲 auth 在架构上的分层、HTTP 与 remote/gRPC 的进入路径、`@Secured` / 资源解析 / 身份解析 / authority 校验、SPI 与默认插件如何接线；不深讲用户/角色/权限表结构、JWT/LDAP 细节、console 业务管理流程。

## 前置依赖

### HARD

- `02-shared-kernel-core-sys-startup-cluster-remote-auth.md`
- `03-remote-grpc-request-handler-connection-auth.md`

### SOFT

- 对 servlet filter 和 request filter 有直觉会有帮助，但不是前提。

### NAV

- 后续可接：security deep-dive、console 管理面、naming/config 的领域级权限语义。

## 一句话困惑

Nacos 的 auth 到底属于 `core`、`auth` 还是 plugin？HTTP 和 gRPC 又分别在哪一层被真正鉴权？

## 一句话顿悟

`core` / `console` 决定“在哪拦”，`auth` 决定“怎么把请求解释成可鉴权对象”，`plugin/auth` 决定“插件必须接受什么输入并返回什么结果”，`plugin-default-impl` 决定“默认到底跑哪套 auth engine”。

## 读者理解路径

1. 先否定“auth 都在 `auth` 模块里”的直觉。
2. 建立四层模型：intercept -> adapt -> SPI -> default impl。
3. 先走一条 HTTP 请求鉴权链。
4. 再走一条 remote/gRPC 请求鉴权链。
5. 解释 `IdentityContext + Resource + Permission` 这套统一鉴权输入模型。
6. 解释 plugin SPI 与 default plugin 的接线方式。
7. 收束到：auth 是 shared kernel 与 plugin ecosystem 的交界层，不是某个业务模块的私有逻辑。

## 失败方案推演

### 失败方案一：auth 全都在 `auth` 模块里

- `auth` 模块主要做协议适配与解析。
- 真正的拦截入口在 `core` 和 `console`。
- 真正的默认实现则在 `plugin-default-impl`。
- 所以 auth 是多层协作，不是单模块封装。

### 失败方案二：remote/gRPC auth 只是把 servlet filter 换个协议继续用

- HTTP 走 servlet filter 链。
- remote/gRPC 走 `RequestHandler` filter 链里的 `RemoteRequestAuthFilter`。
- 两者协议不同、入口不同，但都会收束到统一 plugin auth 模型。

### 失败方案三：默认 auth 是 hardcode 在 core 里的

- core 只负责拦截与转发。
- 默认 `nacos` / `ldap` auth engine 来自 `plugin-default-impl`，通过 SPI + Spring auto-config 接入。
- 所以默认实现也属于插件层，不属于 core 本体。

### 失败方案四：plugin 自己直接解析 HTTP/gRPC 请求

- 请求解析发生在 `auth` 层：根据 `@Secured`、HTTP 参数/头、gRPC request 字段，把请求规范化成 `IdentityContext` 和 `Resource`。
- plugin 只消费这些规范化对象，不直接摸 servlet request 或 gRPC payload。

## 必须澄清的误解

1. `auth` 不是独立的一整套系统，而是 auth architecture 中的协议适配层。
2. `core`/`console` 决定拦截入口，但不持有具体 auth engine。
3. `plugin/auth` 提供的是契约，不是默认实现。
4. `plugin-default-impl` 才是默认 `nacos` / `ldap` 实现与其 Spring wiring 所在地。
5. HTTP 与 remote/gRPC 的入口不同，但最终都会被规范化成同一套 `IdentityContext + Resource + Permission` 模型。

## 文章结构与字数预算

1. 困惑开场：为什么 Nacos auth 容易被写成一团（800-1000 字）
2. 四层总图：intercept -> adapt -> SPI -> impl（1000-1400 字）
3. HTTP 请求鉴权链（1600-2200 字）
4. remote/gRPC 请求鉴权链（1600-2200 字）
5. 统一鉴权输入模型：`@Secured` / `IdentityContext` / `Resource` / `Permission`（1600-2200 字）
6. plugin SPI 与默认 auth plugin 的接线（1600-2200 字）
7. 与后续业务篇/安全篇边界（800-1200 字）
8. 收网总结（600-800 字）

目标叙述性正文：`10000-13000` 字；代码块不计入目标。

## 证据清单

- `plugin/auth/.../AuthPluginService.java:34` — auth SPI contract
- `plugin/auth/.../AuthPluginManager.java:35` — plugin manager
- `plugin/auth/.../Resource.java:31` — normalized resource
- `plugin/auth/.../Permission.java:29` — permission = resource + action
- `auth/AbstractProtocolAuthService.java:47` — protocol adapter base
- `auth/HttpProtocolAuthService.java:42` — HTTP adapter
- `auth/GrpcProtocolAuthService.java:43` — gRPC adapter
- `auth/annotation/Secured.java:37` — per-endpoint policy metadata
- `core/auth/AuthConfig.java:35` — web auth filters registration
- `core/auth/AbstractWebAuthFilter.java:71` — controller method resolve and HTTP auth flow
- `core/auth/AuthFilter.java:51` — non-admin API auth
- `core/auth/AuthAdminFilter.java:45` — admin API auth
- `core/auth/RemoteRequestAuthFilter.java:72` — remote auth path
- `console/filter/NacosConsoleAuthFilter.java:31` — console filter
- `console/config/ConsoleWebConfig.java:84` — console auth web config
- `plugin-default-impl/.../NacosAuthPluginService.java:47` — built-in nacos auth impl
- `plugin-default-impl/.../LdapAuthPluginService.java:28` — built-in ldap auth impl
- `plugin-default-impl/.../META-INF/services/...AuthPluginService:17` — SPI registration
- `plugin-default-impl/.../AutoConfiguration.imports:17` — default plugin Spring wiring
- `core/auth/NacosServerAuthConfig.java:151` — auth system type selection

## 测试与辅助证据

- `core/auth/AuthFilterTest.java:94`
- `core/auth/RemoteRequestAuthFilterTest.java:100`
- `auth/HttpProtocolAuthServiceTest.java:75`
- `auth/GrpcProtocolAuthServiceTest.java:83`
- `auth/parser/http/NamingHttpResourceParserTest.java:43`
- `auth/parser/http/ConfigHttpResourceParserTest.java:42`
- `auth/parser/grpc/NamingGrpcResourceParserTest.java:34`
- `plugin/auth/.../AuthPluginManagerTest.java:59`
- `test/core-test/.../ConfigAuthCoreITCase.java:85`
- `test/core-test/.../NamingAuthCoreITCase.java:68`

## 版本边界

- 当前分析对象固定为 `Nacos 3.0.3`。
- 不深讲 JWT、token 缓存、LDAP bind 细节。
- 不深讲默认 auth plugin 的持久化表结构与 CRUD 控制器。
- 不深讲 console 管理面业务流程。

## 与后续篇章的边界

### 本篇要讲清

- auth 的四层架构。
- HTTP 与 remote/gRPC 两条鉴权进入链。
- `IdentityContext + Resource + Permission` 的统一模型。
- SPI 与默认实现如何接线。

### 本篇不深讲

- 用户/角色/权限表设计
- token/JWT/LDAP 实现细节
- naming/config/console 的领域级权限语义细节

## 写作后检查

- [ ] 开篇先抓“auth 到底分几层”，而不是直接列类名。
- [ ] 至少展开 4 个失败方案，且包含“auth 全都在 `auth` 模块里”“默认 auth hardcode 在 core 里”。
- [ ] 明确给出四层总图：intercept -> adapt -> SPI -> impl。
- [ ] 清楚拆开 HTTP 与 remote/gRPC 两条请求鉴权链。
- [ ] 每个关键结论落到 file:line。
- [ ] 删除代码块后，读者仍能复述各层职责与 plugin 接线方式。
- [ ] 通过一次性深审收口。
