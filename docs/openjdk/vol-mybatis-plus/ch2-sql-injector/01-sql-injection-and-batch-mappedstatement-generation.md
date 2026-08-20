# 为什么 MyBatis-Plus 的 `BaseMapper` 不写 XML，也能直接长出一批 CRUD `MappedStatement`

> 本文基于 MyBatis-Plus 3.5.7 当前源码。本文只讲 SQL 自动注入：`AbstractSqlInjector.inspectInject()`、`DefaultSqlInjector.getMethodList()`、`AbstractMethod.inject()` 与 `BaseMapper` 的关系，回答批量 CRUD statement 是怎样在 mapper 注册流程里生成出来的。不展开表元数据与插件细节。

## 为什么“MP 自带 CRUD”这个说法还远远不够

很多人一提到 MyBatis-Plus，第一句话就是：

- 它自带 CRUD

这句话当然不假，但它几乎没有解释任何关键问题。

因为只要你真的顺着源码往里走，很快就会继续问：

- 这些 CRUD 到底是谁生成的？
- 为什么不是在 `BaseMapper` 接口里直接写死实现？
- 为什么有些 `xxById` 方法依赖主键，有些实体没主键时又会被裁掉？
- 为什么自定义注入器可以替换默认方法集？
- 为什么注入发生在 mapper 注册时，而不是等第一次执行时再动态补？

这些问题都说明：

**所谓“自带 CRUD”，本质上不是现成功能点，而是一套挂在 mapper 注册流程里的批量 `MappedStatement` 生成协议。**

## SQL 自动注入的最小总图

```text
MybatisMapperAnnotationBuilder.parse()
  -> parserInjector()
    -> GlobalConfigUtils.getSqlInjector(configuration)
      -> AbstractSqlInjector.inspectInject(...)
        -> TableInfoHelper.initTableInfo(...)
        -> getMethodList(...)
        -> method.inject(...)
          -> injectMappedStatement(...)
            -> assistant.addMappedStatement(...)
```

这条链里最重要的不是“最后多了几条 SQL”，而是：

1. 注入入口发生在 mapper 注册流程里
2. 方法清单与实体元数据是联动的
3. `AbstractMethod` 才是真正把“一个增强方法”翻译成 `MappedStatement` 的地方

## 一、`AbstractSqlInjector.inspectInject()`：为什么说注入不是后置扫描，而是注册期内联行为

核心入口在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/injector/AbstractSqlInjector.java:43` `inspectInject(...)`

这段逻辑可以压成：

1. 先从 mapper 泛型参数推导出 `modelClass`
2. 取 `mapperRegistryCache`
3. 如果这个 mapper 还没注入过：
   - 先 `TableInfoHelper.initTableInfo(...)`
   - 再 `getMethodList(...)`
   - 然后逐个 `method.inject(...)`
   - 最后把当前 mapper 记进 cache

也就是说，MyBatis-Plus 并不是在系统启动结束后再统一扫一遍 CRUD 方法，而是：

**在 mapper annotation builder 已经接管注册流程之后，直接在这条路径里把注入做掉。**

这说明 `MP-2` 的前置条件就是 `MP-1` 已经成立：

- 没有注册桥，就没有稳定的注入入口

## 二、为什么 `TableInfoHelper.initTableInfo(...)` 会在注入前发生

`inspectInject()` 一上来就先做：

- `TableInfoHelper.initTableInfo(builderAssistant, modelClass)`

这说明 MyBatis-Plus 在决定“有哪些 CRUD 方法之前”，必须先知道：

- 这张表叫什么
- 有没有主键
- 有没有逻辑删除字段
- 哪些字段可插入、可更新、可作为条件

也就是说：

**方法清单不是固定模板，而是建立在实体元数据已经被解析完成的前提上。**

这也是为什么 `MP-2` 不能和 `MP-3` 混成一篇：

- `MP-2` 回答“何时注、注什么、怎样落 statement”
- `MP-3` 回答“这些判断依赖的表元数据到底从哪来”

## 三、`DefaultSqlInjector.getMethodList(...)`：默认 CRUD 方法清单不是常量表，而是带条件分支的声明集

关键点在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/injector/DefaultSqlInjector.java:38` `getMethodList(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/injector/AbstractSqlInjector.java:92` `getMethodList(...)`

`DefaultSqlInjector.getMethodList(...)` 并不是简单 return 一个固定 list。

它会先放入一组基础方法：

- `Insert`
- `Delete`
- `Update`
- `SelectCount`
- `SelectMaps`
- `SelectObjs`
- `SelectList`

然后再根据：

- `tableInfo.havePK()`

决定是否追加：

- `DeleteById`
- `DeleteByIds`
- `UpdateById`
- `SelectById`
- `SelectBatchByIds`

如果实体没有 `@TableId`，它不会强行注这些方法，而是只打 warn。

这说明默认注入清单不是“统一全量 CRUD 套餐”，而是：

**一组受表元数据约束的 statement 模板声明集。**

所以 `BaseMapper` 并不自动等于“完整 CRUD 能力”——它仍然受实体定义影响。

## 四、`AbstractMethod.inject()`：为什么真正把方法模板翻译成 `MappedStatement` 的不是 injector 本身

关键点在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/injector/AbstractMethod.java:82` `inject(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/injector/AbstractMethod.java:421` `addMappedStatement(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/injector/AbstractMethod.java:446` `createSqlSource(...)`

`AbstractSqlInjector` 只是决定 method list，而真正把“一个方法模板”落成 statement 的，是每个 `AbstractMethod` 子类。

`inject(...)` 的职责很明确：

1. 拿 `builderAssistant`
2. 拿 `configuration`
3. 拿默认 `languageDriver`
4. 调具体子类的 `injectMappedStatement(...)`

也就是说，SQL injector 并不直接自己组 SQL；它只是挑选方法模板，真正的 SQL 生成与 `MappedStatement` 构造是分发给 method 实例完成的。

这条分层很重要，因为它解释了为什么自定义注入器扩展点会落在：

- 自定义 `ISqlInjector` / `AbstractSqlInjector`
- 自定义 `AbstractMethod`

而不是去改 `BaseMapper` 本身。

## 五、`GlobalConfigUtils`：为什么注入器和注册缓存都必须从全局配置里取

关键点在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/GlobalConfigUtils.java:88` `getGlobalConfig(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/GlobalConfigUtils.java:106` `getSqlInjector(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/GlobalConfigUtils.java:126` `getMapperRegistryCache(...)`

这说明 SQL 自动注入从来不是一个局部工具函数，而是绑定在 `GlobalConfig` 世界里：

- 当前用哪个 `ISqlInjector`
- 当前 mapper 注入过没有
- 当前是否允许 SQL Runner、是否有 MetaObjectHandler、是否有自定义 AnnotationHandler

都要从 `GlobalConfig` 里拿。

也就是说，MP 的 SQL 注入协议并不是“annotation builder 里私藏一套逻辑”，而是：

**annotation builder 只是入口，真正的策略和状态仍然归全局配置管理。**

## 六、`BaseMapper`：为什么它只是方法声明表，而不是注入逻辑本体

关键点在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/mapper/BaseMapper.java:163` `delete(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/mapper/BaseMapper.java:369` `selectList(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/mapper/BaseMapper.java:558` `insertOrUpdate(...)`

很多人会以为：

- `BaseMapper` 里既然已经有这些方法声明，那 CRUD 能力是不是就来自接口本身？

不是。

`BaseMapper` 只是在声明：

- 希望系统最终能提供这些方法语义

它并不负责：

- 什么时候注册
- 哪些方法可用
- SQL 怎么生成
- `MappedStatement` 怎么落库

真正的注入逻辑都在前面的 `inspectInject -> getMethodList -> AbstractMethod.inject` 链里。

所以 `BaseMapper` 更像是：

**对外暴露的能力目录，而不是能力生成器。**

## 七、失败路径：为什么 `MP-2` 的核心不是“默认帮你生成了很多 SQL”，而是“何时不该生成”

### 1. 重复注入

`mapperRegistryCache` 明确阻止同一个 mapper 重复注入。

### 2. 没有主键

`DefaultSqlInjector` 不会强塞 `xxById` 系列方法，而是只保留无主键依赖的方法并告警。

### 3. method list 为空

`inspectInject()` 会记录 `No effective injection method was found.`，说明并不是任何场景都保证一定有可注入方法。

### 4. 自定义注入器冲突

由于 `GlobalConfigUtils.getSqlInjector(configuration)` 是唯一入口，只要全局配置切换了 injector，整套默认方法清单就会被替换或扩展。

这说明 `MP-2` 的真正价值不在“默认很多”，而在：

**它是一套带条件、可替换、能防重、受实体元数据约束的批量 statement 生成协议。**

## 到这里，MP-2 真正立住的不是 CRUD 清单，而是“批量 `MappedStatement` 生成协议”

如果只看表面，这篇很容易被读成：

- `DefaultSqlInjector` 里列了很多方法
- `AbstractMethod` 会生成 SQL
- `BaseMapper` 有很多 CRUD 定义

这当然都对，但还是太平了。

更稳的理解方式应该是：

1. `parserInjector()` 把控制权从注册桥转交给 SQL 注入桥
2. `inspectInject()` 决定这次 mapper 是否需要注入以及注入流程的时机
3. `getMethodList()` 决定当前 mapper 该拥有哪些方法模板
4. `AbstractMethod.inject()` 把模板翻译成真正的 `MappedStatement`
5. `BaseMapper` 只是面向用户的能力目录，不是生成逻辑本身

所以这篇真正立住的是：

**MyBatis-Plus 的 CRUD 能力不是预制代码，而是 mapper 注册期批量生成的一组 `MappedStatement`。**

## 这篇之后，最自然的继续方向

到这里，已经知道“什么时候注、注什么、怎样落 statement”。下一步最自然的问题就是：

- 这些判断依赖的 `TableInfo / TableFieldInfo / GlobalConfig.DbConfig` 到底是怎样建立起来的？

也就是说，下一篇应该进入 `MP-3 表元数据解析与 GlobalConfig 边界`。