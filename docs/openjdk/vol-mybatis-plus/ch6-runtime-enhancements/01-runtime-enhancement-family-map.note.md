# MP-6 内置运行时增强专题组总图 — note

## 本篇主张

- MP 的内置增强不是散功能列表，而是“参数侧增强家族 + SQL 改写侧增强家族”的分层地图。
- `MybatisParameterHandler` 和 `MybatisPlusInterceptor/InnerInterceptor` 代表的是两种不同的切入协议。
- 逻辑删除、乐观锁、租户、权限、安全等功能的真正价值在于它们如何挂进这两条协议家族，而不是各自孤立存在。

## 本篇边界

- 不细拆每个增强插件的完整算法实现。
- 不展开 Boot 自动装配。
- 只在需要时点到生产候选边界和 ignore 机制。

## 下篇桥接

- `MP-7` 将收束 Spring Boot 自动装配桥如何把增强版 Configuration、插件家族和全局配置自动装起来。