# Nacos：auth / plugin SPI / HTTP-gRPC boundary

> 基于 Nacos 3.0.3

## 一、困惑开场：为什么 Nacos 的 auth 最容易被写成一团

Nacos 的 auth 是一个特别容易被写乱的主题。

因为只要沿着源码多走几步，你就会同时看到这些东西：

- `core/auth`
- `auth`
- `plugin/auth`
- `plugin-default-impl/nacos-default-auth-plugin`
- `console/filter`
- `RemoteRequestAuthFilter`
- `HttpProtocolAuthService`
- `GrpcProtocolAuthService`

于是最自然的几种误解就会一起冒出来：

- auth 都在 `auth` 模块里
- 其实也没什么，就是 `core` 里几个 filter
- 默认实现应该是 hardcode 在 core 里
- plugin 既然叫 plugin，那它是不是直接自己去解析 HTTP/gRPC 请求

这些直觉之所以危险，是因为它们每条都只抓住了其中一层，却把整个 auth architecture 压扁了。

真正的问题不是“有没有 auth 模块”，而是：**请求是在哪一层被拦住、在哪一层被解析、在哪一层被交给插件、又在哪一层选出具体 auth engine。**

先把结论放前面：Nacos 3.0.3 的 auth 不是单一模块，而是**`core` / `console` 负责拦截，`auth` 负责把 HTTP/gRPC 请求规范化成 `IdentityContext + Resource + Permission`，`plugin/auth` 提供 SPI 契约，`plugin-default-impl` 提供 `nacos` / `ldap` 等默认实现和 Spring wiring。**

## 二、先走四条失败的路

### 失败方案一：auth 全都在 `auth` 模块里

这条误解最常见，因为 `auth` 这个模块名太有迷惑性。

但真正看职责，它并不持有完整 auth 系统。它更像**协议适配层**：

- 解析 `@Secured`
- 根据 HTTP 或 gRPC 的输入提取 identity/resource
- 决定把这些规范化对象交给哪个 plugin 去验证

真正的拦截入口在：

- `core` 的 servlet filters
- `core` 的 `RemoteRequestAuthFilter`
- `console` 的 console 过滤链

真正的默认 engine 则在：

- `plugin-default-impl/nacos-default-auth-plugin`

所以 auth 不是单模块，而是多层协作。

### 失败方案二：remote/gRPC auth 只是把 servlet filter 换个协议继续用

HTTP 与 remote/gRPC 最终都会进同一套 auth 模型，但入口并不相同。

- HTTP 走 servlet filter 链  
  `core/auth/AbstractWebAuthFilter.java:50`
- remote/gRPC 走 `RequestHandler` filter 链里的 `RemoteRequestAuthFilter`  
  `core/auth/RemoteRequestAuthFilter.java:51`  
  `core/remote/RequestHandler.java:46`

所以 remote auth 不是“把 servlet filter 复用一下”，而是另一条 shared remote filter path。

### 失败方案三：默认 auth 是 hardcode 在 core 里的

这条误解也很自然，因为最终拦截逻辑看起来都发生在 `core`。

但 `core` 的作用是：

- 决定在哪拦
- 决定什么时候放行或继续校验
- 决定如何把请求喂给 auth service

它不持有默认 engine 本体。

真正的默认实现来自 `plugin-default-impl`，并且是通过 SPI + Spring auto-config 接进来的。  
`plugin-default-impl/.../META-INF/services/...AuthPluginService:17`  
`plugin-default-impl/.../AutoConfiguration.imports:17`

所以 default auth 也是 plugin 层的事情，不是 core 硬编码。

### 失败方案四：plugin 自己直接解析 HTTP/gRPC 请求

如果只从“插件负责鉴权”这个角度想，很容易误会 plugin 直接拿 servlet request 或 gRPC request 进去解析。

但实际解析层在 `auth`：

- `HttpProtocolAuthService` 负责 HTTP 侧解析  
  `auth/HttpProtocolAuthService.java:42`
- `GrpcProtocolAuthService` 负责 remote/gRPC 侧解析  
  `auth/GrpcProtocolAuthService.java:43`

它们把请求整理成统一的：

- `IdentityContext`
- `Resource`
- `Permission`

然后 plugin 才消费这些对象。

所以 plugin 看到的是“规范化后的鉴权输入”，不是原始协议对象。

## 三、四层总图：intercept -> adapt -> SPI -> impl

先把整篇最关键的总图压出来：

```text
HTTP / remote request
    ↓
intercept layer
    - core servlet filters
    - core remote request filter
    - console filter
    ↓
adapt layer
    - HttpProtocolAuthService
    - GrpcProtocolAuthService
    ↓
SPI contract layer
    - AuthPluginService
    - IdentityContext / Resource / Permission
    ↓
default impl layer
    - nacos auth plugin
    - ldap auth plugin
```

这张图里最重要的不是“模块多”，而是先把层级钉住：

- **intercept** 决定“在哪拦”
- **adapt** 决定“怎么把协议请求翻译成可鉴权对象”
- **SPI** 决定“插件必须消费什么抽象”
- **impl** 决定“默认到底跑哪套 engine”

只要把这四层切开，Nacos auth 的主线就不会再乱。

## 四、HTTP 请求鉴权链：先在 web 入口拦住，再规范化成 auth 输入

### 4.1 filter 注册发生在 controller 之前

HTTP auth 并不是在 controller 里“手动校验”。`AuthConfig` 会直接注册：

- `AuthFilter`
- `AuthAdminFilter`

并且范围是 `/*`。  
`core/auth/AuthConfig.java:35`

这一步意味着：HTTP 请求在进入业务 controller 之前，就已经进入 shared auth gate。

### 4.2 `ControllerMethodsCache` 决定这是不是一个受保护操作

`AbstractWebAuthFilter` 不会瞎猜这个 URL 该怎么鉴权，它会先通过 `ControllerMethodsCache` 找到目标 controller method，再看这个方法上有没有 `@Secured`。  
`core/code/ControllerMethodsCache.java:70`  
`core/auth/AbstractWebAuthFilter.java:71`

如果：

- 找不到 method
- 或 method 没有 `@Secured`

那么 auth 直接放行。  
`core/auth/AbstractWebAuthFilter.java:72`  
`core/auth/AbstractWebAuthFilter.java:76`

这说明 Nacos 的 auth 不是“所有请求统一强拦”，而是由 `@Secured` 驱动的按端点策略。

### 4.3 HTTP filter 里的真正顺序

当 method 带 `@Secured` 时，`AbstractWebAuthFilter` 的顺序可以压成几步：

1. 先读出 `@Secured`，再判断这个 filter 是否真的匹配这类 API  
   `core/auth/AbstractWebAuthFilter.java:82`  
   `core/auth/AbstractWebAuthFilter.java:83`
2. 先看 server identity 相关逻辑  
   `core/auth/AbstractWebAuthFilter.java:90`
3. 如果 server identity 已匹配，直接放行；如果失败，直接 403 结束  
   `core/auth/AbstractWebAuthFilter.java:91`  
   `core/auth/AbstractWebAuthFilter.java:93`  
   `core/auth/AbstractWebAuthFilter.java:95`  
   `core/auth/AbstractWebAuthFilter.java:96`
4. 再判断这个 secured 操作是否真的开启 auth  
   `core/auth/AbstractWebAuthFilter.java:101`
5. 然后解析 `Resource` 和 `IdentityContext`  
   `core/auth/AbstractWebAuthFilter.java:105`  
   `core/auth/AbstractWebAuthFilter.java:106`  
   `core/auth/AbstractWebAuthFilter.java:107`
6. 把鉴权结果写进 `RequestContext`，先做 identity 校验  
   `core/auth/AbstractWebAuthFilter.java:108`  
   `core/auth/AbstractWebAuthFilter.java:109`  
   `core/auth/AbstractWebAuthFilter.java:111`  
   `core/auth/AbstractWebAuthFilter.java:112`
7. 如果这是 identity-only API，则直接跳过 authority 校验  
   `core/auth/AbstractWebAuthFilter.java:115`  
   `core/auth/AbstractWebAuthFilter.java:120`
8. 否则再做 authority 校验  
   `core/auth/AbstractWebAuthFilter.java:123`  
   `core/auth/AbstractWebAuthFilter.java:124`

这说明 HTTP auth 不是“只验一个 token”，而是明确拆成：

- 请求是否需要 auth
- 请求属于哪个资源
- 请求方是谁
- 请求方是否有权限对这个资源做这个动作

### 4.4 `AuthFilter` 与 `AuthAdminFilter` 的分工

- `AuthAdminFilter` 只处理 `ApiType.ADMIN_API` 这类端点  
  `core/auth/AuthAdminFilter.java:45`
- `AuthFilter` 则处理非 admin 的普通 API  
  `core/auth/AuthFilter.java:51`

这进一步说明同一个 web auth gate 内部还按 API 类型做了职责拆分。

## 五、remote/gRPC 请求鉴权链：不是 servlet filter，而是 `RequestHandler` filter

### 5.1 先把入口层级切开

remote/gRPC auth 最容易被误写成“HTTP filter 的协议变体”，但真正入口层级已经变了。

所有 remote 请求在进入业务 `handle(...)` 前，都会先走 `RequestHandler.handleRequest(...)`。  
`core/remote/RequestHandler.java:46`

而 `RemoteRequestAuthFilter` 就是这条 filter 链中的一环。  
`core/auth/RemoteRequestAuthFilter.java:51`

这说明 remote auth 是 shared remote substrate 的一部分，而不是 servlet 体系的延伸。

### 5.2 `RemoteRequestAuthFilter` 的顺序

它的顺序大致是：

1. 先反射拿到 handler 的 `handle(Request, RequestMeta)` 方法  
   `core/auth/RemoteRequestAuthFilter.java:72`
2. 读取 `@Secured` 元数据  
   `core/auth/RemoteRequestAuthFilter.java:73`  
   `core/auth/RemoteRequestAuthFilter.java:74`
3. 对 inner API 和 auth 开关做短路判断  
   `core/auth/RemoteRequestAuthFilter.java:76`  
   `core/auth/RemoteRequestAuthFilter.java:80`
4. 先做 server identity 检查；如果失败直接返回错误响应，如果已匹配则直接放行  
   `core/auth/RemoteRequestAuthFilter.java:86`  
   `core/auth/RemoteRequestAuthFilter.java:87`  
   `core/auth/RemoteRequestAuthFilter.java:88`  
   `core/auth/RemoteRequestAuthFilter.java:92`
5. 如果仍需鉴权，则补 `X-Real-IP`，解析资源和身份，再做 identity 校验  
   `core/auth/RemoteRequestAuthFilter.java:100`  
   `core/auth/RemoteRequestAuthFilter.java:101`  
   `core/auth/RemoteRequestAuthFilter.java:102`  
   `core/auth/RemoteRequestAuthFilter.java:103`  
   `core/auth/RemoteRequestAuthFilter.java:104`
6. 把鉴权结果写进 `RequestContext`，再做 authority 校验  
   `core/auth/RemoteRequestAuthFilter.java:105`  
   `core/auth/RemoteRequestAuthFilter.java:106`  
   `core/auth/RemoteRequestAuthFilter.java:108`  
   `core/auth/RemoteRequestAuthFilter.java:112`  
   `core/auth/RemoteRequestAuthFilter.java:113`

所以 remote/gRPC auth 的真正形态是：**shared request filter + shared protocol adapter + plugin 校验**。

### 5.3 inner API 是一个重要分叉

`GrpcProtocolAuthService.checkServerIdentity(...)` 并不是对所有 remote request 都无差别执行同一种策略，它尤其对 `ApiType.INNER_API` 有专门判断。  
`auth/GrpcProtocolAuthService.java:82`

这说明 Nacos 在 remote auth 里明确区分了：

- 内部节点间调用
- 普通客户端调用

这也是为什么 cluster lane、SDK lane、source 限制和 auth 会互相咬合。

## 六、统一鉴权输入模型：`@Secured` / `IdentityContext` / `Resource` / `Permission`

### 6.1 `@Secured` 是策略声明，不是实现

`@Secured` 很重要，但它本身不是鉴权实现，而是每个端点的 policy declaration。

它至少定义：

- `action`
- `resource` override
- `signType`
- `parser`
- `tags`
- `apiType`

`auth/annotation/Secured.java:37`

也就是说，端点首先声明“我是个什么资源、要执行什么动作、按什么方式解析”，后面的 adapter 和 plugin 才知道怎么工作。

### 6.2 `Resource` 是规范化后的受保护对象

`Resource` 最终会被整理成：

- `namespaceId`
- `group`
- `name`
- `type`
- `properties`

`plugin/auth/.../Resource.java:31`

built-in parser 还会把 `action` 和 tags 等信息装进 `properties`。  
`auth/parser/AbstractResourceParser.java:34`

所以 `Resource` 不是原始 HTTP 参数或 gRPC 字段，而是“被规范化之后的安全对象”。

### 6.3 HTTP 与 gRPC 的 resource 解析入口不同

HTTP 侧：

- naming 解析器会从请求参数里提 namespace/group/service  
  `auth/parser/http/NamingHttpResourceParser.java:48`  
  `auth/parser/http/NamingHttpResourceParser.java:58`
- config 解析器会从 `namespaceId` / `tenant`、`groupName` / `group`、`dataId` 等字段里拼资源  
  `auth/parser/http/ConfigHttpResourceParser.java:36`  
  `auth/parser/http/ConfigHttpResourceParser.java:53`  
  `auth/parser/http/ConfigHttpResourceParser.java:62`

gRPC 侧：

- naming/config parser 则从 request object 字段或必要的反射路径里提资源  
  `auth/parser/grpc/NamingGrpcResourceParser.java:34`  
  `auth/parser/grpc/ConfigGrpcResourceParser.java:35`

所以“资源是谁”这件事是按协议适配层分别解析，然后统一落到同一个 `Resource` 抽象上。

### 6.4 `IdentityContext` 和 `Permission`

`IdentityContext` 是插件最终看到的身份上下文对象。  
`plugin/auth/.../IdentityContext.java:27`

而 `Permission` 本质上就是：

- `Resource`
- `action`

`plugin/auth/.../Permission.java:29`

这一步很关键，因为它把 auth plugin 看到的输入压成了稳定结构：

- 你是谁（identity）
- 你要操作什么（resource）
- 你想做什么（permission/action）

## 七、plugin SPI 与默认 auth plugin：契约和实现必须切开

### 7.1 `plugin/auth` 负责的是契约

`plugin/auth` 并不提供默认 engine。它主要提供的是：

- `AuthPluginService`  
  `plugin/auth/.../AuthPluginService.java:34`
- `AuthPluginManager`  
  `plugin/auth/.../AuthPluginManager.java:35`
- `IdentityContext`
- `Resource`
- `Permission`

所以它回答的是：**插件应该长什么样，应该吃什么输入、吐什么结果。**

### 7.2 `AuthPluginManager` 怎么选插件

`AuthPluginManager` 会通过 `NacosServiceLoader` 装所有 `AuthPluginService` 实现，然后按 `getAuthServiceName()` 建索引。  
`plugin/auth/.../AuthPluginManager.java:50`

而 `AbstractProtocolAuthService` 真正消费这个选择结果的方式也很直接：

- `enableAuth(...)` 先按 `nacos.core.auth.system.type` 找当前插件，再调用插件的 `enableAuth`  
  `auth/AbstractProtocolAuthService.java:64`  
  `auth/AbstractProtocolAuthService.java:65`  
  `auth/AbstractProtocolAuthService.java:68`
- `validateIdentity(...)` 也是先找当前插件，再把规范化后的 `IdentityContext + Resource` 喂进去  
  `auth/AbstractProtocolAuthService.java:76`  
  `auth/AbstractProtocolAuthService.java:77`  
  `auth/AbstractProtocolAuthService.java:80`
- `validateAuthority(...)` 则把 `IdentityContext + Permission` 交给插件  
  `auth/AbstractProtocolAuthService.java:86`  
  `auth/AbstractProtocolAuthService.java:87`  
  `auth/AbstractProtocolAuthService.java:90`

后面再根据 `nacos.core.auth.system.type` 选具体插件。  
`core/auth/NacosServerAuthConfig.java:151`

这就说明：auth engine 的选择是配置驱动 + SPI 驱动，不是 core 里 if/else 硬编码。

### 7.3 `plugin-default-impl` 才是默认实现层

默认的 auth engine 在 `plugin-default-impl/nacos-default-auth-plugin` 里。

至少有两套内建实现：

- `nacos`
- `ldap`

`plugin-default-impl/.../NacosAuthPluginService.java:47`  
`plugin-default-impl/.../LdapAuthPluginService.java:28`

并且 SPI 文件里会把它们显式暴露出来。  
`plugin-default-impl/.../META-INF/services/...AuthPluginService:17`

这一步非常关键，因为它直接打掉了“默认 auth hardcode 在 core 里”的错觉。

### 7.4 Spring wiring 也在默认实现层

默认插件并不是只给一个 Java SPI 类就完了，它还要把自己依赖的：

- persistence
- services
- security
- web controllers
- LDAP config

都通过 Boot auto-config imports 拉进来。  
`plugin-default-impl/.../AutoConfiguration.imports:17`

也就是说：默认 auth plugin 不是一个单类，而是一整套自带 Spring wiring 的实现包。

## 八、和前两篇以及后续篇章的边界

### 8.1 相对第 02 篇 shared kernel

第 02 篇回答的是：`core` 是 shared kernel。

这一篇则进一步把其中一根共享支柱切开：**auth 作为 shared gate，是怎样通过 core/console 的入口、auth 模块的适配、plugin SPI 的契约、default impl 的实现协作起来的。**

### 8.2 相对第 03 篇 remote substrate

第 03 篇已经把 remote 请求链拉直了。

这一篇不再重讲 transport，而只抓 remote 路径里 auth 插入的位置：

`RequestHandler -> RequestFilters -> RemoteRequestAuthFilter -> handler`

### 8.3 本篇不抢后续安全细节

这篇到这里就够了，再往下走就会开始侵占后续安全 deep-dive：

- 用户/角色/权限表结构
- token / JWT / 缓存
- LDAP bind
- admin 初始化
- console 里的账号管理流程

这些都应该留到后面更细的 security / console 文章里。

## 九、误解澄清

### 误解一：auth 全都在 `auth` 模块里

不是。`auth` 主要负责协议适配，拦截入口在 `core`/`console`，默认实现层在 `plugin-default-impl`。

### 误解二：remote/gRPC auth 就是 servlet filter 换个协议

不是。remote/gRPC auth 走的是 `RequestHandler` filter 链。

### 误解三：默认 auth 是 hardcode 在 core 里的

不是。默认 `nacos` / `ldap` 实现在 plugin-default-impl 里，通过 SPI + Spring wiring 接进来。

### 误解四：plugin 自己直接解析 HTTP/gRPC 请求

不是。请求解析先由 `auth` 协议适配层完成，再把规范化对象交给 plugin。

### 误解五：HTTP 与 remote/gRPC 是两套完全不同的 auth 世界

不是。入口不同，但最终都会收束到 `IdentityContext + Resource + Permission` 这一统一模型。

## 十、收网总结：Nacos 的 auth 不是单模块，而是四层协作架构

回到开头的问题：Nacos 的 auth 到底属于哪一层？

答案不是“在某个模块里”，而是：

- `core` / `console` 负责拦截入口
- `auth` 负责协议适配与规范化
- `plugin/auth` 负责定义契约
- `plugin-default-impl` 负责默认实现与 Spring wiring

把整篇压成三句话：

1. Nacos auth 的关键不是某个模块名，而是四层分工：intercept -> adapt -> SPI -> impl。  
2. HTTP 和 remote/gRPC 入口不同，但最终都会被规范化成 `IdentityContext + Resource + Permission` 再交给 plugin。  
3. 默认 `nacos` / `ldap` auth engine 不在 core 里 hardcode，而是在 `plugin-default-impl` 里通过 SPI 与 auto-config 接入。  
