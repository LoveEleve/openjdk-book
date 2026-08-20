# M-6 动态 SQL、参数绑定与插件拦截 — note

## 本篇主张

- 动态 SQL 不是模板替换，而是 `SqlNode` 树在运行时 apply 成 `BoundSql` 的协议。
- `BoundSql.additionalParameters` 是 `bind/foreach` 等临时变量的责任边界。
- 插件链不是全局 AOP，而是只对声明接口与签名生效的精确拦截机制。

## 本篇边界

- 不展开类型系统与结果映射的完整细节。
- 不把插件链和 Spring AOP 混写。
- 只在执行链需要的位置点到 OGNL 与 `DynamicContext`。

## 下篇桥接

- `M-7` 将专门收束类型处理、反射映射与结果对象装配。