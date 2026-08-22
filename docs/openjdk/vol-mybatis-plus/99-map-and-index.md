# vol-mybatis-plus 总图与索引

## 总图

```text
MP-8 BaseMapper / IService / ServiceImpl  [应用边界层]
  |
  +-- BaseMapper<T> (mybatis-plus-core)
  |     -> insert / deleteById / updateById / selectById / selectList / selectPage
  |     -> insert(Collection) / updateById(Collection) / insertOrUpdate(Collection)  [3.5.7 batch]
  |     -> deleteById(Object, boolean useFill)  [3.5.7 logic-delete fill]
  |
  +-- IService<T> (mybatis-plus-extension)
  |     -> save / remove / update / getOne / list / page
  |     -> saveBatch / saveOrUpdateBatch / updateBatchById  [batch]
  |     -> lambdaQuery / lambdaUpdate  [chain]
  |
  +-- ServiceImpl<M, T> (mybatis-plus-extension)
        -> @Autowired protected M baseMapper
        -> getSqlSessionFactory()
        -> executeBatch(Collection, int, BiConsumer)

MP-7 Spring Boot 自动装配桥  [Boot 装配层]
  |
  +-- MybatisPlusAutoConfiguration
  |     -> sqlSessionFactory(DataSource)
  |     -> sqlSessionTemplate(SqlSessionFactory)
  |     -> AutoConfiguredMapperScannerRegistrar
  |
  +-- MybatisPlusProperties
  |     -> CoreConfiguration.applyTo(MybatisConfiguration)
  |     -> GlobalConfig
  |
  +-- IdentifierGeneratorAutoConfiguration
  +-- MybatisPlusInnerInterceptorAutoConfiguration
  +-- MybatisPlusLanguageDriverAutoConfiguration

MP-5 插件总线与 SQL 改写入口  [机制补深层]
MP-6 内置运行时增强专题组
  |
  +-- MybatisPlusInterceptor (总线)
  |     -> InnerInterceptor 接口
  |     -> @InterceptIgnore
  |
  +-- 参数侧增强家族
  |     -> MybatisParameterHandler
  |     -> 自动填充 (MetaObjectHandler)
  |     -> ID 生成 (IdentifierGenerator)
  |
  +-- SQL 改写侧增强家族
        -> 分页 (PaginationInnerInterceptor)
        -> 乐观锁 (OptimisticLockerInnerInterceptor)
        -> 租户 (TenantLineInnerInterceptor)
        -> 权限 (DataPermissionInterceptor)
        -> 安全 (BlockAttackInnerInterceptor / IllegalSQLInnerInterceptor)
        -> 动态表名 (DynamicTableNameInnerInterceptor)

MP-1 Configuration 替换与 Mapper 注册桥  [核心主干层]
MP-2 SQL 自动注入与 MappedStatement 批量生成
MP-3 表元数据解析与 GlobalConfig 边界
MP-4 Wrapper / Lambda 条件构造器
  |
  +-- MybatisConfiguration (替换原生 Configuration)
  +-- AutoMapperScanner / AutoSqlInjector
  +-- DefaultSqlInjector / AbstractMethod / SqlMethod
  +-- TableInfoHelper / TableInfo / GlobalConfig / DbConfig
  +-- AbstractWrapper / QueryWrapper / UpdateWrapper / LambdaQueryWrapper
```

## 索引

| 域 | 篇名 | 文件 |
|---|---|---|
| MP-1 | Configuration 替换与 Mapper 注册桥 | ch1-configuration-bridge/01-configuration-replacement-and-mapper-registration.md |
| MP-2 | SQL 自动注入与 MappedStatement 批量生成 | ch2-sql-injector/01-sql-injection-and-batch-mappedstatement-generation.md |
| MP-3 | 表元数据解析与 GlobalConfig 边界 | ch3-tableinfo/01-tableinfo-and-globalconfig-boundary.md |
| MP-4 | Wrapper / Lambda 条件构造器 | ch4-wrapper/01-wrapper-and-lambda-condition-builder.md |
| MP-5 | 插件总线与 SQL 改写入口 | ch5-interceptor/01-interceptor-bus-and-sql-rewrite-entry.md |
| MP-6 | 内置运行时增强专题组 | ch6-runtime-enhancements/01-runtime-enhancement-family-map.md |
| MP-7 | Spring Boot 自动装配桥 | ch7-boot-autoconfigure/01-mybatis-plus-boot-autoconfiguration-bridge.md |
| MP-8 | BaseMapper / IService 应用边界层 | ch8-mapper-service/01-base-mapper-service-boundary.md |

## 跨卷位置

本卷是四卷体系第二阶段的第二卷：

- 本卷覆盖：MyBatis-Plus 增强机制（Configuration 替换、SQL 注入、表元数据、Wrapper、插件总线、增强家族、Boot 装配、应用边界）
- 前置卷：`vol-mybatis` — 本卷以 MyBatis 原生体系为阅读前提
- 无关卷：`vol-hikaricp` / `vol-druid` — ORM 与连接池正交，无交叉引用
