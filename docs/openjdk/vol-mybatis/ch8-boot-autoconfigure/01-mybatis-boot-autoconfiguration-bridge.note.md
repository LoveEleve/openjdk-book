# S-2 MyBatis Boot 自动装配桥 — note

## 本篇主张

- Spring Boot 没有重写 MyBatis/Spring 集成层，而是在条件满足时自动把 `S-1` 那座桥装起来。
- `MybatisProperties` 不是普通 DTO，而是把 Boot 配置翻译成 `SqlSessionFactoryBean` 与 MyBatis CoreConfiguration 输入的编排器。
- mapper 自动扫描不是魔法，而是自动注册 `MapperScannerConfigurer` / `AutoConfiguredMapperScannerRegistrar`。

## 本篇边界

- 不重讲 MyBatis 核心执行链。
- 不重讲 `S-1` 的事务同步内部细节。
- 只在需要时点到语言驱动自动配置和属性条件。

## 下篇桥接

- 下一步应回到卷级收尾：统一做 `vol-mybatis` 的六层复审、README、导读与总图索引。