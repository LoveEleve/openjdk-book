# MP-4 Wrapper / Lambda 条件构造器 — note

## 本篇主张

- Wrapper 不是链式语法糖，而是条件链、参数占位与字段解析共同组成的运行时协议。
- `AbstractWrapper` 负责条件和参数状态，`AbstractLambdaWrapper` 负责字段到列的转换。
- `LambdaUtils` + `ColumnCache` 是 Lambda 条件构造能稳定成立的元信息桥。

## 本篇边界

- 不展开分页、租户、权限等插件改写细节。
- 不展开表元数据如何建立，只消费 `MP-3` 已建立的语义中心。
- 只在需要时点到更新链的 `setSql` 风险边界。

## 下篇桥接

- `MP-5` 将收束 `MybatisPlusInterceptor + InnerInterceptor` 为什么是所有运行时增强的总线入口。