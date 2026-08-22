# MP-7 Spring Boot 自动装配桥 — note

## 本篇主张

- MP 的 Boot 装配不是"帮你省配置"，而是在条件满足时自动把 `MP-1` 到 `MP-6` 建立的整套增强体系装起来。
- `MybatisPlusProperties` 不是普通 DTO，而是 Boot 配置语言到 `CoreConfiguration` / `GlobalConfig` 的翻译器。
- `MybatisSqlSessionFactoryBean` 替换原生 `SqlSessionFactoryBean`，是 Boot 装配桥的核心动作。
- `AutoConfiguredMapperScannerRegistrar` 说明"不写 `@MapperScan` 也能扫到 mapper"不是魔法，而是自动补注册的扫描桥。

## 本篇边界

- 不重讲 MyBatis 核心机制（`MP-1` 到 `MP-6` 已覆盖）。
- 不展开每个子自动配置类的完整算法实现。
- 只在需要时点到条件退场和失败路径。

## 下篇桥接

- `MP-8` 将收束 `BaseMapper` / `IService` 应用边界层，回答"用户代码如何与增强体系对接"。
- 之后进入卷级六层总审、README、导读、总图索引。