# OpenFeign：Contract、MethodMetadata 与 RequestTemplate — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `ReflectiveFeign` 在 build-time 调用 `Contract.parseAndValidateMetadata(target.type())`，而不是在每次调用时现解接口，证据：`core/src/main/java/feign/ReflectiveFeign.java:140`。
2. `Contract.BaseContract.parseAndValidateMetadata(Class, Method)` 会为每个方法创建 `MethodMetadata`，设置 `targetType`、`method`、`returnType`、`configKey`，再处理类注解、方法注解和参数注解，证据：`core/src/main/java/feign/Contract.java:91`、`:101`、`:106`、`:120`。
3. `DefaultContract` 负责把 `@RequestLine`、`@Headers`、`@Body`、`@Param`、`@QueryMap`、`@HeaderMap` 映射到 metadata/template，证据：`core/src/main/java/feign/DefaultContract.java:34`、`:57`、`:78`、`:97`、`:121`、`:130`。
4. `@RequestLine` 会把 HTTP method 和 relative URI 写入 `RequestTemplate` 原型，证据：`DefaultContract.java:64`、`:65`。
5. `@Body` 会根据是否包含模板变量，选择写 literal body 或 body template，证据：`DefaultContract.java:78`、`:80`。
6. `@Param` 先命名，再通过 `template().hasRequestVariable(name)` 判断是否成为 form param，说明它本身不决定 path/query/header 位置，证据：`DefaultContract.java:97`、`:117`、`core/src/main/java/feign/RequestTemplate.java:1012`。
7. body fallback 发生在 `BaseContract`：未被消费的普通参数可能成为 bodyIndex/bodyType，证据：`Contract.java:136`、`:155`。
8. `MethodMetadata` 内含完整蓝图：`bodyIndex/urlIndex/queryMapIndex/headerMapIndex/formParams/indexToName/indexToExpanderClass`，以及共享的 `RequestTemplate template` 原型，证据：`core/src/main/java/feign/MethodMetadata.java:28`、`:37`、`:52`、`:146`。
9. `RequestTemplateFactoryResolver` 每次调用时都会先 `RequestTemplate.from(metadata.template())` 克隆原型，再根据 argv resolve / append，证据：`core/src/main/java/feign/RequestTemplateFactoryResolver.java:40`、`:85`、`:107`。
10. `RequestTemplate.resolve(...)` 会分别处理 URI、query、header、body template 的变量替换，最终 `request()` 才 materialize 成真正的 `Request`，证据：`core/src/main/java/feign/RequestTemplate.java:182`、`:203`、`:239`、`:255`、`:287`。
11. `Request.Options` 是运行期特例参数，不保存在 metadata 的专用槽位中，而在运行期被识别，证据：`core/src/main/java/feign/SynchronousMethodHandler.java:154`。

### 测试证据已核对

1. `DefaultContractTest.java:67` — body parameter detection。
2. `DefaultContractTest.java:99` — query extraction from `@RequestLine`。
3. `DefaultContractTest.java:237`、`:276` — form param 推断。
4. `DefaultContractTest.java:301`、`:701` — header variable 不应退化成 form param。
5. `DefaultContractTest.java:331`、`:348`、`:388` — QueryMap/HeaderMap 约束。
6. `RequestTemplateTest.java:128`、`:348`、`:460` — template resolve / body / slash 语义。
7. `ContractWithRuntimeInjectionTest.java:62` — runtime expander injection。
8. `AlwaysEncodeBodyContractTest.java:87` — always-encode-body 特例。

### 深审发现

1. **高风险：容易把 OpenFeign 第二篇写成注解语法手册。** 当前正文已把重点压在 build-time blueprint，而不是注解 feature list。  
2. **高风险：容易把 `RequestTemplate` 误写成最终 request。** 当前正文已反复强调 prototype / clone / resolve / request 的四层。  
3. **中风险：容易把 `@Param` 误当成“路径参数注解”。** 当前正文已明确它只是命名，模板上下文才决定角色。  
4. **中风险：容易忽略 `@QueryMap` / `@HeaderMap` 是后追加语义。** 当前正文已拆开模板变量与 map 追加。  
5. **低风险：容易低估 build-time 预计算对 runtime 性能的意义。** 当前正文已强调“结构预编译，参数后填充”。  

## 第二轮：因果审

- Contract 必须在 build-time 固化请求结构，否则每次方法调用都要重新解析注解，runtime 成本过高：✅
- `MethodMetadata` 必须保存参数角色和模板原型，否则 `MethodHandler` 运行期无法快速决定怎么组 request：✅
- `RequestTemplate` 必须先作为 unresolved prototype 存在，再在每次调用时 clone/resolve，否则并发调用之间会互相污染模板状态：✅
- `@Param` 必须只负责命名而不是直接决定位置，否则 path/query/header/form 等语义就会被注解本身写死，失去模板上下文判断能力：✅
- `Request.Options` 必须保留为运行期特例，而不是写进 metadata，否则一次 build-time blueprint 无法适配每次调用动态 timeout/options 的差异：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → blueprint 总图 → Contract -> DefaultContract -> MethodMetadata -> RequestTemplate -> 调用期填充 -> 误解澄清 -> 收网总结”推进，没有退化成注解清单。

失败方案已覆盖：
- `@Param` 天然就是 query/path 参数  
- `RequestTemplate` 就是最终 Request  
- body/query/header 分类都靠运行期判断  

每一层拆解均围绕“什么在 build-time 固定，什么在 invoke-time 填充”展开，符合 OpenFeign build-time 核心篇定位。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- Contract 怎样把接口变成 `MethodMetadata`  
- `MethodMetadata` 保存了哪些请求蓝图信息  
- `RequestTemplate` 为什么是 prototype 而不是 final request  
- 参数角色如何被 build-time 分类  
- 为什么 OpenFeign 能把“接口解释成本”前移到 build-time  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未重讲 `Client.execute()` / `ResponseHandler` 主链（第一篇已覆盖）。✅
- 未展开具体 Encoder/Decoder 算法。✅
- 未进入 SpringMvcContract / Spring Cloud OpenFeign。✅
- 重点仍压在 core contract / metadata / template blueprint，边界收得住。✅

## 第六轮：依赖审

- 已承接第一篇 runtime spine：这篇把 `MethodHandler` 的 build-time 来源打透。✅
- 后续可自然接 Encoder/Decoder/Retryer/Capability 专题与 SpringMvcContract 集成篇。✅
- `DefaultContractTest`、`RequestTemplateTest`、`ContractWithRuntimeInjectionTest` 足以支撑本文最关键的角色分类和 blueprint 结论。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅
- 代码块：使用少量 blueprint 总图，不承担主叙事骨架。✅
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `Contract`、`DefaultContract`、`MethodMetadata`、`RequestTemplate`、`RequestTemplateFactoryResolver`、`SynchronousMethodHandler`。✅
- 去掉代码块后正文仍成立：是。✅
- 叙述性正文字符数（不含代码块与空白行）：约 `13,398`。  
- 目标定位：OpenFeign build-time blueprint 核心篇，篇幅与结构满足要求。✅

## 结论

本篇的目标是把 OpenFeign 的注解接口解析过程，从“看到注解时临时解释”提升到“预编译成 `MethodMetadata` 和 `RequestTemplate` 蓝图”，让读者理解为什么运行期几乎只需要做参数填充，而不需要重新理解接口。