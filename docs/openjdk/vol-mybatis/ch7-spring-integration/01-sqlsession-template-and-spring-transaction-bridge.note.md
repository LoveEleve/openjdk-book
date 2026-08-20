# S-1 SqlSessionTemplate 与 Spring 事务桥 — note

## 本篇主张

- `SqlSessionTemplate`、`SqlSessionUtils`、`SpringManagedTransaction`、`MapperFactoryBean` 共同构成 MyBatis 进入 Spring 后的会话责任重分配协议。
- Spring 集成层不是替代 MyBatis 核心代理，而是重划会话、事务与 Bean 生命周期的控制权。
- mapper Bean 最终仍回到 MyBatis 原生 `getMapper()` 主线，只是其生命周期被 Spring 接管。

## 本篇边界

- 不展开 Boot 自动装配。
- 不重讲 MyBatis 核心执行链与结果装配。
- 只在需要时点到异常翻译和事务同步回调。

## 下篇桥接

- `S-2` 将收束 `MybatisAutoConfiguration`、`MybatisProperties`、`MapperScannerConfigurer` / `AutoConfiguredMapperScannerRegistrar` 的 Boot 装配桥。