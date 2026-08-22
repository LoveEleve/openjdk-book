# 如何阅读本卷

## 本卷是什么

本卷是 MyBatis-Plus 3.5.7 的源码分析，不是 API 文档翻译。目标是回答"MP 为什么能让用户只写一个接口就拥有完整 CRUD + 批量操作 + 分页 + Wrapper + 插件增强"。

## 阅读前提

- 读过 `vol-mybatis`，知道 MyBatis 的 Configuration、SqlSession、Executor、MappedStatement、MapperProxy
- 了解 Spring Boot 自动装配的基本概念

## 推荐阅读顺序

```
MP-1 -> MP-2 -> MP-3 -> MP-4 -> MP-5 -> MP-6 -> MP-7 -> MP-8
```

### 第一段：核心主干层（MP-1 ~ MP-4）

先建立 MP 自身的增强版协议：

- **MP-1**：`MybatisConfiguration` 如何替换原生 `Configuration`，`AutoMapperScanner` 如何注册 Mapper
- **MP-2**：`DefaultSqlInjector` 如何在启动时批量注入增强版 MappedStatement
- **MP-3**：`TableInfo` / `GlobalConfig` 如何管理表元数据与全局配置
- **MP-4**：`Wrapper` / `LambdaQueryWrapper` 如何把条件构造器从字符串拼接升级为类型安全 API

### 第二段：机制补深层（MP-5 ~ MP-6）

再解释插件与增强家族：

- **MP-5**：`MybatisPlusInterceptor` / `InnerInterceptor` 如何建立插件总线与 SQL 改写入口
- **MP-6**：自动填充、逻辑删除、乐观锁、租户、分页、权限、安全如何挂进插件总线

### 第三段：集成层（MP-7 ~ MP-8）

最后解释它如何被 Spring Boot 自动装起来，以及用户代码如何与增强体系对接：

- **MP-7**：`MybatisPlusAutoConfiguration` 如何在 Spring Boot 下自动装配增强版 SqlSessionFactory
- **MP-8**：`BaseMapper` / `IService` / `ServiceImpl` 如何把所有增强机制收束到用户代码可直接调用的 CRUD 边界

## 每篇的结构

每篇包含四个文件：

1. `rewrite-plan.md`：写作规划，包含读者问题、主结论、结构设计、必须回填的源码锚点
2. `.md`（正文）：源码分析正文
3. `.note.md`：本篇主张、边界、下篇桥接
4. `.review-notes.md`：六层审查笔记（事实审、因果审、结构审、读者审、边界审、依赖审）

## 如果你想快速了解

只读每篇的 `.note.md`，它包含本篇的核心主张和边界。

## 如果你想深入源码

读每篇的正文 `.md`，它包含完整的源码分析和锚点引用。

## 如果你想做代码审查

读每篇的 `.review-notes.md`，它包含六层审查笔记。

## 本卷在四卷体系中的位置

本卷是四卷体系的第二阶段——ORM 层第二卷：

```
第一阶段（数据源层）：
  vol-hikaricp（9篇）← 建立连接池的参照系
    └──→ vol-druid（9篇）← 以 HikariCP 为对照基准

第二阶段（ORM 层）：
  vol-mybatis（11篇）← 先读，建立 MyBatis 原生体系
    └──→ vol-mybatis-plus（8篇）← 以 MyBatis 为阅读前提
```

本卷与 MyBatis 的关系：本卷以 `vol-mybatis` 为阅读前提。MP 的所有增强机制（Configuration 替换、SQL 注入、Wrapper 等）都建立在 MyBatis 原生体系之上。本卷与 `vol-hikaricp` / `vol-druid` 正交，无交叉引用。
