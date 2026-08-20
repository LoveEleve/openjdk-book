# M-2 MapperProxy 动态代理与方法分发 — review notes

## 事实审

- 已核对 `binding/MapperRegistry.java:41`、`binding/MapperRegistry.java:58`，注册与获取 mapper 的主线成立。
- 已核对 `binding/MapperProxyFactory.java:31`、`binding/MapperProxyFactory.java:47`、`binding/MapperProxyFactory.java:51`，代理工厂与 `methodCache` 位置成立。
- 已核对 `binding/MapperProxy.java:80`、`binding/MapperProxy.java:92`、`binding/MapperProxy.java:114`，拦截入口、缓存 invoker、default method 分支成立。
- 已核对 `binding/MapperMethod.java:57`、`binding/MapperMethod.java:87`、`binding/MapperMethod.java:101`、`binding/MapperMethod.java:120`、`binding/MapperMethod.java:146`，方法分发路径成立。
- 已核对 `binding/MapperMethod.java:181`、`binding/MapperMethod.java:269`、`binding/MapperMethod.java:316`、`binding/MapperMethod.java:323`，`SqlCommand` 与 `MethodSignature` 的解析边界成立。
- 已补测试证据：default method submitted 用例支撑 default method 分支；`TooManyResultsException` 路径支撑 `selectOne()` 结果数量边界；mapper 未注册与 statement 缺失异常由 `BindingException` / `Invalid bound statement` 路径支撑。
## 因果审

- `Configuration.getMapper()` → `MapperRegistry.getMapper()` → `MapperProxyFactory.newInstance()` → `MapperProxy.invoke()` → `MapperMethod.execute()` 的总链成立。
- default method 不进 `MapperMethod`，而是走 `MethodHandle`，正文成立。
- `SqlCommand + MethodSignature` 决定方法分发而非方法名字符串本身，正文成立。
- mapper 未注册、statement 不存在、primitive 返回 null、多 `RowBounds/ResultHandler` 的失败路径都在本层被 fail-fast，正文成立。

## 结构审

- 从“为什么接口没有实现也能执行 SQL”切入，再落到注册、代理、缓存、签名、失败路径，结构收束良好。
- 没有按 binding 包目录机械平铺，符合方法论。

## 读者审

- 读完应能回答：Mapper 方法为什么能自动分到 `selectOne/list/map/cursor/flush`。
- 读完应能理解 default method 为什么不等于 SQL 方法。
- 读完后能够自然衔接 `SqlSession` 生命周期，而不会把代理层和执行器层混成一块。

## 边界审

- 本篇没有提前透支 `SqlSession` 事务收束、执行器细节和 Spring 集成。
- 只触及 `SqlSession` 作为被调用者的角色，符合 M-2 边界。

## 依赖审

- 前置依赖：M-1 已立住 `Configuration` 与 `MappedStatement` 元数据中心。
- 后续桥接：M-3 资源生命周期、M-4 执行器主线都成立。

## 结论

M-2 已完成单域四件套的事实回填与六层审查，可进入下一域。