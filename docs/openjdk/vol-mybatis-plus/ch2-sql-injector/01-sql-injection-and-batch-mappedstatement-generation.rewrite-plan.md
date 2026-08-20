# 篇：01 SQL 自动注入与 MappedStatement 批量生成

- 域：`MP-2 SQL 自动注入与 MappedStatement 批量生成`
- 卷：`vol-mybatis-plus`
- 目标：回答 `BaseMapper` 为什么没有 XML 也能直接拥有一批 CRUD statement，以及注入到底发生在什么时候、由谁决定方法清单、最终怎样落回 `MappedStatement`。

## 前置依赖

- HARD：已读 `MP-1`，知道 MP 已替换 `Configuration / MapperRegistry / MapperAnnotationBuilder` 核心桥。

## 读者问题

为什么 MyBatis-Plus 能做到：

1. 一个继承 `BaseMapper<T>` 的接口，不写 XML 也能直接拥有 CRUD statement
2. 不同实体的注入清单还会因为主键、逻辑删除、全局配置不同而变化
3. 注入不是扫描期一次性硬编码，而是发生在 mapper 注册流程内部
4. 自定义注入器有能力替换默认方法清单

## 主结论

MyBatis-Plus 的自动注入不是“启动后补点 SQL”，而是挂在 mapper 注册流程里的批量 `MappedStatement` 生成协议：

`MybatisMapperAnnotationBuilder.parse()`
  -> `parserInjector()`
    -> `GlobalConfigUtils.getSqlInjector(configuration)`
      -> `AbstractSqlInjector.inspectInject(...)`
        -> `TableInfoHelper.initTableInfo(...)`
        -> `getMethodList(...)`
        -> `AbstractMethod.inject(...)`
          -> `injectMappedStatement(...)`
            -> `assistant.addMappedStatement(...)`

也就是说：

- 注册桥负责提供稳定入口
- `SqlInjector` 负责决定“这个 mapper 该拥有哪些方法”
- `AbstractMethod` 负责把“一个增强方法”翻译成真正的 `MappedStatement`

## 结构设计

1. 困惑开场：为什么 `BaseMapper` 没有 XML 也能立刻增殖出一批 CRUD SQL
2. 最小总图：`parserInjector()` -> `inspectInject()` -> `getMethodList()` -> `inject()`
3. `AbstractSqlInjector.inspectInject()`：什么时候注、注一次还是多次
4. `DefaultSqlInjector.getMethodList(...)`：默认方法清单与主键条件分支
5. `AbstractMethod.inject()`：怎样把方法模板绑定到当前 mapper / model / tableInfo
6. `GlobalConfigUtils`：为什么注入器、DbConfig、mapperRegistryCache 都要从全局配置里取
7. `BaseMapper`：为什么它只是方法声明表，而不是注入逻辑本体
8. 失败路径：重复注入、无主键实体、无有效方法、自定义注入器冲突
9. 收网：这篇立住的是“批量 statement 生成协议”，不是 CRUD 方法罗列
10. 下篇桥接：进入表元数据与 `GlobalConfig` 边界

## 必须回填的源码锚点

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/injector/AbstractSqlInjector.java:43` `inspectInject(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/injector/AbstractSqlInjector.java:92` `getMethodList(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/injector/DefaultSqlInjector.java:38` `getMethodList(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/injector/AbstractMethod.java:82` `inject(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/injector/AbstractMethod.java:421` `addMappedStatement(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/injector/AbstractMethod.java:446` `createSqlSource(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/GlobalConfigUtils.java:88` `getGlobalConfig(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/GlobalConfigUtils.java:106` `getSqlInjector(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/GlobalConfigUtils.java:126` `getMapperRegistryCache(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/mapper/BaseMapper.java:163` `delete(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/mapper/BaseMapper.java:369` `selectList(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/mapper/BaseMapper.java:558` `insertOrUpdate(...)`

## 必须引用的测试/证据

- `MybatisMapperAnnotationBuilderTest`
- `MybatisConfigurationTest`（优先级与短 key 行为侧证）
- `MybatisParameterHandlerTest`（说明注入结果会进入后续运行时处理）
- `TableInfoHelperTest`（说明方法清单依赖表元数据）

## note / review 约束

- note 只记主张、边界、下篇桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。