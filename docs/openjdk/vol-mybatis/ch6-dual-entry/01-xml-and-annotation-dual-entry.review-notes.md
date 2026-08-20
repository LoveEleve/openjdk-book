# M-9 XML 与注解 Mapper 双入口 — review notes

## 事实审

- 已核对 `binding/MapperRegistry.java:60`，统一注册入口与先登记后解析语义成立。
- 已核对 `builder/annotation/MapperAnnotationBuilder.java:114`、`:145`、`:169`、`:191`、`:282`、`:573`，注解入口、XML 前置吸收、cache/cacheRef 与 statement 解析主线成立。
- 已核对 `builder/xml/XMLMapperBuilder.java:96`，同名 XML 进入当前 mapper 注册上下文的主线成立。
- 已核对 `builder/annotation/ProviderSqlSource.java:36`、`:100`、`:163`、`:169`、`:243`、`:252`，provider SQL 的解析与收束主线成立。
- 已补测试证据：`duplicate_statements`、`default_method`、`mapper_type_parameter`、`sqlprovider` 等都能对应双入口与冲突边界结论。

## 因果审

- mapper 注册先进入 `MapperRegistry`，再由 `MapperAnnotationBuilder.parse()` 编排 XML/注解/provider 的双入口并流，这个判断成立。
- 同名 XML 不是平行第二管线，而是注解入口中的前置吸收步骤，正文成立。
- provider 不是第三套系统，而是注解入口内部的 `SqlSource` 生成分支，正文成立。
- XML/注解/provider 最终都要落到 `assistant.addMappedStatement(...)`，正文成立。

## 结构审

- 从“XML 派 vs 注解派”的误解切入，再落到统一注册、XML 前置吸收、注解/Provider 并流与冲突边界，主线集中。
- 没有把 XML 用法和注解清单分别平铺成两个手册，符合方法论。

## 读者审

- 读完应能回答：为什么 XML 和注解不是两套并列执行系统。
- 读完应能回答：为什么 provider 只是注解入口的一个 SQL 生成后端。
- 读完后能自然进入 S-1，而不会把 Spring mapper 扫描误当成 MyBatis 核心注册逻辑。

## 边界审

- 本篇没有提前透支 Spring mapper 扫描与 Boot 自动装配。
- `MapperProxy` 运行时分发只保留为背景，不重新展开，边界成立。

## 依赖审

- 前置依赖：M-1 配置中心、M-2 Mapper 入口、M-6 动态 SQL。
- 后续桥接：S-1 Spring 会话/事务桥成立。

## 结论

M-9 已完成单域四件套的事实回填与六层审查，可进入集成层。