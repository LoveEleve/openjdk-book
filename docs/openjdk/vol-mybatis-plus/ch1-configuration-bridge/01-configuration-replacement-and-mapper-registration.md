# 为什么 MyBatis-Plus 的第一步不是“多几个功能”，而是先替换掉 MyBatis 的核心桥

> 本文基于 MyBatis-Plus 3.5.7 当前源码。本文只讲 `MybatisSqlSessionFactoryBuilder`、`MybatisConfiguration`、`MybatisMapperRegistry`、`MybatisMapperAnnotationBuilder` 这四个核心桥节点如何被替换，以及这层替换为什么比 `BaseMapper`、分页插件更接近 MP 的架构入口。不展开 SQL 自动注入、表元数据和插件家族的细节。

## 为什么“MP 只是给 MyBatis 多了几个 CRUD 方法”这个理解会一开始就把主线看浅

很多人第一次接触 MyBatis-Plus，会形成一个很顺手的归纳：

- 它就是在 MyBatis 上多加了 `BaseMapper`
- 再加个分页插件、乐观锁、自动填充
- 于是整体还是 MyBatis，只是多了些开箱即用能力

这在使用层不算离谱，但一旦回到源码，会立刻把你带偏。

因为如果 MP 只是“在外面再加几个功能”，它根本没必要去碰：

- `SqlSessionFactoryBuilder`
- `Configuration`
- `MapperRegistry`
- `MapperAnnotationBuilder`

而当前源码恰恰说明，MP 的第一层增强不在外围 API，而在：

**先替换掉 MyBatis 的几个关键桥节点，再把后续的 SQL 注入、元数据解析和插件增强挂到这些桥上。**

也就是说，MP 不是“外挂几个工具类”，而是先接管 MyBatis 核心入口上的控制点。

## MP 核心桥替换的最小总图

```text
MybatisSqlSessionFactoryBuilder.build(configuration)
  -> MybatisConfiguration
    -> MybatisMapperRegistry
      -> MybatisMapperAnnotationBuilder.parse()
        -> parserInjector()
```

这个总图里最重要的地方不是类名替换，而是责任转移：

1. `SqlSessionFactory` 构造时就接入 `GlobalConfig`、`IdentifierGenerator`、`SqlRunnerInjector`
2. `Configuration` 默认语义被改写：驼峰、enum handler、language driver、`StrictMap`
3. mapper 注册与移除不再完全沿用原生 MyBatis 逻辑
4. annotation builder 在 mapper 解析期就为后续 SQL 注入预埋钩子

## 一、`MybatisSqlSessionFactoryBuilder.build(configuration)`：为什么 MP 连工厂构造入口都要接管

关键入口在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisSqlSessionFactoryBuilder.java:80` `build(Configuration configuration)`

这一步做的事情很集中：

1. 先通过 `GlobalConfigUtils.getGlobalConfig(configuration)` 取全局配置
2. 如果还没有 `IdentifierGenerator`，就根据 `GlobalConfig.Sequence` 或网卡地址创建 `DefaultIdentifierGenerator`
3. 把生成器写回 `GlobalConfig`，同时 `IdWorker.setIdentifierGenerator(...)`
4. 如果开启了 `enableSqlRunner`，就 `new SqlRunnerInjector().inject(configuration)`
5. 然后才 `super.build(configuration)`
6. 最后把生成出的 `SqlSessionFactory` 缓回 `globalConfig`

也就是说，MP 并不是等工厂建完了再去补增强，而是在工厂建之前就把：

- 全局 ID 生成策略
- SQL Runner 注入
- `SqlSessionFactory` 回填

这三件事嵌进构造入口。

所以这一步真正说明的是：

**MP 认为增强不是执行期外挂，而是工厂期就要注入的运行时前提。**

## 二、`MybatisConfiguration`：MP 真正接管的是默认语义和注册语义

关键点在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisConfiguration.java:58` 类声明
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisConfiguration.java:90` 构造函数
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisConfiguration.java:104` `addMappedStatement(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisConfiguration.java:127` `addMapper(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisConfiguration.java:149` `removeMapper(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisConfiguration.java:444` `StrictMap.put(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisConfiguration.java:472` `StrictMap.get(...)`

### 1. 默认语义改写

构造函数一上来就把几个关键默认值改了：

- `mapUnderscoreToCamelCase = true`
- 默认 enum handler 改成 `CompositeEnumTypeHandler`
- 默认 scripting language 改成 `MybatisXMLLanguageDriver`

这不是“便利性偏好”，而是在告诉你：

- MP 想让运行时默认行为更适合它自己的增强体系

### 2. `addMappedStatement(...)` 的优先级改写

它明确写死了一个规则：

- 如果 `mappedStatements` 已经有同 id，后来的 statement 会被忽略并记日志

源码注释把顺序写得很清楚：

- XML SQL
- SqlProvider SQL
- CurdSql

优先级是：

- `XmlSql > sqlProvider > CurdSql`

这说明 MP 的增强不是“无脑注入更多 statement”，而是：

**在已有 statement 主线上强制维持一套覆盖优先级。**

### 3. `addMapper()` / `removeMapper()`

MP 还额外提供了：

- `addNewMapper()`
- `removeMapper()`

`removeMapper()` 不只是删 mapper registry，还会：

- 清实体表信息缓存
- 清 `loadedResources`
- 清 mapper method 对应的 `mappedStatements`

这说明 MP 甚至考虑了动态替换 mapper 的场景，它接管的不是“注册一次”这么简单，而是整个 mapper 缓存责任链。

## 三、`MybatisMapperRegistry.addMapper()`：为什么 MP 要自己接管 mapper 注册

关键入口在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisMapperRegistry.java:46` `getMapper(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisMapperRegistry.java:76` `addMapper(...)`

`addMapper(...)` 和原生 MyBatis 很像，但有两个关键差异：

### 1. 已存在 mapper 时直接 return，而不是抛异常

源码里保留了原先抛 `BindingException` 的注释，但当前实现选择直接返回。

这说明 MP 在注册策略上更倾向“避免重复注册带来的中断”，而不是完全沿用原生 fail-fast 策略。

### 2. builder 已经换成 `MybatisMapperAnnotationBuilder`

注册流程还是：

- 先 put proxy factory
- 再 parse
- parse 失败则回滚缓存

但 parse 本身已经换成 MP 自己的 builder，这就意味着：

- mapper 注册期不再只是原生 MyBatis 的 annotation parse
- 而是 MP 的增强注册协议入口

所以 `MybatisMapperRegistry` 的价值不在“换了个 Map”，而在：

**它把 mapper 注册期变成 MP 插入增强逻辑的桥。**

## 四、`MybatisMapperAnnotationBuilder.parse()`：真正把增强埋进 mapper 注册流程的是它

核心入口在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisMapperAnnotationBuilder.java:87` `parse()`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisMapperAnnotationBuilder.java:125` `parserInjector()`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisMapperAnnotationBuilder.java:135` `loadXmlResource()`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisMapperAnnotationBuilder.java:271` `parseStatement(Method method)`

`parse()` 的关键步骤是：

1. 如果当前资源还没加载过，先 `loadXmlResource()`
2. `addLoadedResource(resource)`
3. 设置 namespace
4. `parseCache()` / `parseCacheRef()`
5. 初始化 `InterceptorIgnoreHelper` 的 SQL parser ignore cache
6. 遍历方法，按需 `parseResultMap()` 和 `parseStatement()`
7. 如果这个 mapper 是 `super mapper children`，则 `parserInjector()`
8. 最后 `parsePendingMethods(false)`

真正关键的是第 7 步：

- 原生 MyBatis 到这里就基本结束了
- MP 则在这里额外接入 `parserInjector()`

这说明 MP 的增强不是注册后再扫一次 mapper，而是：

**在 mapper annotation 解析流程内部，就把 SQL 自动注入挂进来了。**

## 五、为什么 `parserInjector()` 才是 MP 主线真正开始分叉的地方

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisMapperAnnotationBuilder.java:125` `parserInjector()`

它自己非常短，只干一件事：

- `GlobalConfigUtils.getSqlInjector(configuration).inspectInject(assistant, type)`

但正因为它短，反而说明了架构重心：

- MP 不是在 annotation builder 里手写所有 CRUD statement
- 它只负责在正确的时机，把控制权交给 SQL 注入器

所以 `MP-1` 真正要立住的，不是 CRUD 方法本身，而是：

**注册桥已经替后续 SQL 注入桥预埋好了切入点。**

这也意味着：

- `MP-1` 和 `MP-2` 不能混成一篇
- `MP-1` 要回答“注入为什么有入口”
- `MP-2` 才回答“注入究竟注了什么”

## 六、`StrictMap`、默认 enum handler、默认 language driver：这些不是细节，而是 MP 替换桥的默认世界观

`MybatisConfiguration` 里的 `StrictMap` 不是原样照搬。

关键差异包括：

- 自己维护 `AMBIGUITY_INSTANCE`
- 受 `useGeneratedShortKey` 开关控制短 key 缓存
- `put/get` 的冲突与歧义语义沿用但允许更灵活控制

再加上：

- `CompositeEnumTypeHandler`
- `MybatisXMLLanguageDriver`
- 默认驼峰映射

这些共同说明 MP 并不是只想“复用 MyBatis 内核再多注一点 SQL”，而是在默认行为层面就定义了自己的运行时世界。

也就是说：

**MP 的 Configuration 替换，不只是接桥，更是在改默认宇宙常量。**

## 七、失败路径：为什么 `MP-1` 真正值钱的不是替换类名，而是替换后的边界变化

### 1. 重复 mapper 注册

原生 MyBatis 倾向直接抛异常；MP 当前实现选择 return。语义已经不同。

### 2. `mappedStatement` 冲突

MP 不是抛异常，而是记录“被忽略，可能来自 xml file”，体现了它对 XML 优先级的强约束。

### 3. mapper 动态替换

`removeMapper()` 会清 table info、registry、loadedResources、mappedStatements，说明 MP 真的把动态替换视作边界问题，而不是顺手删个 key。

### 4. builder 解析失败

注册流程仍保持“先放 factory、失败再回滚”的协议，说明 MP 在替换桥时没有放弃原生 MyBatis 那套一致性要求。

## 到这里，MP-1 真正立住的不是“MP 也有自己的 Configuration”，而是“核心桥替换协议”

如果只看表面，这篇很容易被读成：

- `MybatisConfiguration` 换掉了 `Configuration`
- `MybatisMapperRegistry` 换掉了 `MapperRegistry`
- `MybatisMapperAnnotationBuilder` 换掉了 `MapperAnnotationBuilder`

这当然都对，但还太平了。

更稳的理解方式应该是：

1. MP 先接管工厂构造入口，把 `GlobalConfig`、ID 生成器和 `SqlRunner` 灌进去
2. MP 再接管 `Configuration` 默认语义、statement 优先级和 mapper 缓存责任
3. MP 再接管 mapper 注册与 annotation parse 的桥，使后续 SQL 注入有稳定切入点
4. 这样后面的注入、元数据和插件增强才能被挂到同一条增强主线上

所以这篇真正立住的是：

**MyBatis-Plus 的第一层增强不是功能堆砌，而是先替换掉 MyBatis 的核心桥。**

## 这篇之后，最自然的继续方向

桥已经接管，下一步最自然的问题就是：

- `BaseMapper` 为什么没有 XML 也能直接得到一批 CRUD `MappedStatement`

也就是说，下一篇应该进入 `MP-2 SQL 自动注入与 MappedStatement 批量生成`。