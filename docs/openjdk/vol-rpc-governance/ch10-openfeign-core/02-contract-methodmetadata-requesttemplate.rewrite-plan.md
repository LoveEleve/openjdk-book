# OpenFeign：Contract、MethodMetadata 与 RequestTemplate — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch10-openfeign-core`
- 篇：`02 Contract、MethodMetadata 与 RequestTemplate`
- 对应主题：`F-MAIN-2 Build-time Contract and Request Blueprint`
- 文章类型：OpenFeign 核心机制篇
- 正文状态：未开始
- 基于版本：`OpenFeign 13.14-SNAPSHOT`

## 文章定位

- 核心困惑：第一篇已经讲清 OpenFeign 的主运行链是 `builder -> proxy -> MethodHandler -> Client.execute()`，但读者仍然会问：这些 `MethodHandler` 是怎么来的？注解上的 path/query/header/body 到底在什么时候被识别？为什么有的参数变成 path 变量，有的变成 body，有的变成 `@QueryMap` / `@HeaderMap` 的特殊槽位？
- 一句话顿悟：OpenFeign 把“接口长什么样”这件事尽量提前到 build-time 完成：`Contract` 负责把注解接口翻译成 `MethodMetadata`，`MethodMetadata` 保存方法级蓝图和 `RequestTemplate` 原型，`RequestTemplate.Factory` 再在调用期根据 `argv` 解析出最终 Request。也就是说，注解不是运行时一遍遍反射解释的，而是先被压成 metadata 和模板语法，再在每次调用时只做实参填充。
- 文章边界：本篇重点讲 `Contract`、`DefaultContract`、`MethodMetadata`、`RequestTemplate`、参数角色分类、build-time 与 invoke-time 的分层；只点到 `RequestTemplateFactoryResolver` 如何消费这些结果，不深入 `Client.execute()` / `ResponseHandler`（上一/下一篇负责），也不进入 Spring MVC Contract。

## 前置依赖

### HARD

- `ch10-openfeign-core/01-runtime-spine-builder-proxy-http.md`

### SOFT

- 不要求先懂 Spring MVC 注解体系。
- 不要求先懂 Encoder/Decoder 细节。

### NAV

- 后续可接：`Encoder / Decoder / ErrorDecoder / Retryer / Capability`
- 后续可接：Spring Cloud OpenFeign 的 `SpringMvcContract`

## 一句话困惑

Feign 到底是怎么把注解接口压成可以复用的请求蓝图的？哪些东西在 build-time 就确定了，哪些又必须等到每次方法调用时才填进去？

## 一句话顿悟

`Contract` 在 build-time 就把接口方法翻译成 `MethodMetadata`，其中已经固化了参数角色、请求方法、相对 URI、header/query/body 模板和各种特殊参数索引；每次调用只是基于这份 blueprint 克隆一个 `RequestTemplate`，用这次的实参把变量填进去，而不是重新理解一次接口。

## 读者理解路径

1. 先否定“`@Param` 就天然是 query/path 参数”的粗糙理解。
2. 建立最小总图：interface annotations -> Contract -> MethodMetadata -> RequestTemplate prototype -> per-call resolve。
3. 解释 `Contract.parseAndValidateMetadata()` 的主流程。
4. 解释 `MethodMetadata` 保存了哪些 build-time 信息。
5. 解释 `RequestTemplate` 为什么是原型而不是最终请求。
6. 解释参数角色分类：path/query/header/body/headerMap/queryMap/URI/options。
7. 解释 build-time 固定与 invoke-time 填充的边界。
8. 收束到：Feign 真正优化的是“结构预编译，参数后填充”。

## 失败方案推演

### 失败方案一：`@Param` 就等于 query/path 参数

- `@Param` 只是“给参数起名字”，最终是 path/query/header 变量还是 form param，要看这个名字出现在哪些模板位置。
- 如果不出现在任何请求变量里，它甚至会被推成 form param。
- 所以 `@Param` 不决定语义位置，模板上下文才决定。

### 失败方案二：`RequestTemplate` 就是最终 Request

- `MethodMetadata.template()` 保存的是 unresolved prototype。
- 真正的 Request 只有在每次调用时，把 argv 填进克隆出来的模板，再 `resolve()` 和 `request()` 之后才形成。
- 所以 template 和 request 不是一个阶段的对象。

### 失败方案三：body/query/header 的分类都靠运行时判断

- OpenFeign 尽量把这些判断提前到 build-time：bodyIndex、queryMapIndex、headerMapIndex、name bindings、formParams 等都在 metadata 里固化。
- 所以运行时不需要重新解析注解，而只需要按 metadata 去填参数。

## 必须澄清的误解

1. `MethodMetadata` 不是“方法注解缓存”，而是完整的请求蓝图。
2. `@QueryMap` / `@HeaderMap` 不参与普通 `{var}` 模板解析，而是在后续阶段追加。
3. `Request.Options` 不是 metadata 字段，而是运行期特例参数。
4. `RequestTemplate` 的 target 与 uri 是分开的两个层次，不应混成一个字符串。
5. `@Body` 和 body parameter 不是同一个概念：一个是固定/模板 body，一个是把未消费参数编码进 body。

## 文章结构与字数预算

1. 困惑开场：为什么 Feign 不能在调用时现解注解（800-1000 字）
2. 最小总图：Contract -> MethodMetadata -> RequestTemplate prototype（1000-1400 字）
3. `Contract` 主流程（1400-2000 字）
4. `MethodMetadata`：方法蓝图里到底存了什么（1600-2200 字）
5. 参数角色分类：path/query/header/body/headerMap/queryMap/options（1800-2400 字）
6. `RequestTemplate`：原型、resolve 与 request materialization（1600-2200 字）
7. build-time vs invoke-time 的边界（1000-1400 字）
8. 收网总结（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `core/src/main/java/feign/Contract.java:49` — parseAndValidateMetadata
- `Contract.java:91` — 每方法创建 MethodMetadata
- `Contract.java:120` — parameter annotations 处理
- `Contract.java:136` — body/URI/options 分类
- `Contract.java:241` — nameParam 绑定
- `core/src/main/java/feign/DefaultContract.java:34` — annotation processors 注册
- `DefaultContract.java:57` — RequestLine 解析
- `DefaultContract.java:78` — Body literal vs template
- `DefaultContract.java:97` — Param 处理
- `DefaultContract.java:117` — form param 推断
- `DefaultContract.java:121` — QueryMap
- `DefaultContract.java:130` — HeaderMap
- `core/src/main/java/feign/MethodMetadata.java:28` — metadata state
- `MethodMetadata.java:37` — RequestTemplate prototype
- `MethodMetadata.java:52` — template back-link
- `MethodMetadata.java:146` — template accessor
- `MethodMetadata.java:212` — isAlreadyProcessed
- `core/src/main/java/feign/RequestTemplate.java:53` — template fields
- `RequestTemplate.java:123` — clone from prototype
- `RequestTemplate.java:182` — resolve
- `RequestTemplate.java:287` — request()
- `core/src/main/java/feign/RequestTemplateFactoryResolver.java:40` — choose template factory
- `RequestTemplateFactoryResolver.java:85` — clone metadata.template()
- `RequestTemplateFactoryResolver.java:107` — argv resolve / queryMap/headerMap append

## 测试证据清单

- `DefaultContractTest.java:67`
- `DefaultContractTest.java:99`
- `DefaultContractTest.java:237`
- `DefaultContractTest.java:301`
- `DefaultContractTest.java:331`
- `DefaultContractTest.java:388`
- `RequestTemplateTest.java:128`
- `RequestTemplateTest.java:348`
- `RequestTemplateTest.java:460`
- `ContractWithRuntimeInjectionTest.java:62`
- `AlwaysEncodeBodyContractTest.java:87`

## 版本边界

- 当前分析对象固定为 `OpenFeign 13.14-SNAPSHOT`。
- 本篇只讲 OpenFeign core 的 Contract / metadata / template 模型，不展开 SpringMvcContract。
- Encoder/Decoder/Retryer 只在边界上提及，不展开实现。

## 与其他篇的边界

### 本篇要讲清

- 注解接口如何变成 `MethodMetadata` 和 `RequestTemplate` blueprint。
- 参数角色是如何在 build-time 被分类的。
- template 原型与最终 Request 的差异。

### 本篇不深讲

- 真正 HTTP 执行和响应解释（上一篇 / 下篇）。
- Spring Contract 适配。
- Encoder/Decoder 细节。

## 写作后检查

- [ ] 开篇先抓“为什么不能调用时现解注解”，而不是直接讲 `Contract`。
- [ ] 至少展开 3 个失败方案，且包含“`@Param` 天然就是 query/path 参数”“template 就是最终 request”。
- [ ] 明确给出 build-time blueprint 总图。
- [ ] 不把本文写成注解说明手册。
- [ ] 每个参数角色结论都落到 file:line 和测试。
- [ ] 删除代码块后，读者仍能复述 Contract / MethodMetadata / RequestTemplate 的三层关系。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。