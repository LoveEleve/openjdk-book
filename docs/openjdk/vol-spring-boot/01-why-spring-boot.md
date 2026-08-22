# 为什么有了 Spring，还要 Spring Boot：从“能力框架”到“应用装配系统”

> 本篇是 `vol-spring-boot` 的总开篇。它不急着进入 `SpringApplication.run()` 的逐方法执行，而是先回答一个更根本的问题：Spring Framework 已经有 IoC、AOP、事务、MVC 和测试支持，Spring Boot 到底新增了什么价值？后续文章再分别展开自动装配、启动流程、配置绑定、Web 容器、数据访问、生产诊断和测试切片。

## 为什么 Spring 已经这么强了，还要再加一层 Spring Boot

如果已经认真读完 Spring Framework，很容易产生一个合理的问题：

- Spring 已经有 `ApplicationContext`
- 有 BeanDefinition、BeanFactory、`refresh()`
- 有 AOP、事务、缓存、异步、MVC
- 甚至连 `DispatcherServlet` 如何注册进 Servlet 容器都可以自己理解

那为什么还要 Spring Boot？

难道 Spring Boot 只是：

- 少写几段 XML
- 少写几个 `@Bean`
- 自动帮忙填几个默认值

如果只是这样，Boot 不值得单独成为一卷源码书。

更准确的答案是：

**Spring Framework 解决的是“应用具备哪些可组合的基础能力”，Spring Boot 解决的是“这些能力怎样被判断、选择、装配、启动并交付成一个可运行的应用”。**

这两者不是同一层问题。

第一层问题是：**Spring Framework 给了你组件，但没有替你决定一套完整应用应该怎样组装。**

例如，Framework 可以提供：

- 一个 `ApplicationContext`
- `DataSource`、`PlatformTransactionManager` 等基础设施可以接入容器的扩展点和抽象
- 一组 MVC 基础设施

但一个真实应用仍然要回答：

- 当前类路径上有没有 JDBC 驱动
- 用户是否已经声明了自己的 `DataSource`
- 当前应用是不是 Servlet Web 应用
- 应该创建 Tomcat、Jetty 还是 Undertow
- 有没有 Redis 客户端
- 哪些默认 Bean 应该创建，哪些必须让用户覆盖

这些问题不是单个基础组件的问题，而是：

- **应用装配决策问题。**

第二层问题是：**Spring Framework 的扩展点很多，但“如何把扩展点组织成默认路径”仍需要应用层自己完成。**

Framework 提供了大量可扩展接口：

- `BeanFactoryPostProcessor`
- `BeanPostProcessor`
- `ImportSelector`
- `Condition`
- `ApplicationContextInitializer`
- `ServletContextInitializer`

但如果每个项目都要自己把这些扩展点串起来：

- 自己扫描候选配置
- 自己按 classpath 判断是否启用
- 自己处理配置属性
- 自己组装 WebServer
- 自己准备失败提示

那么框架的能力虽然存在，项目仍然会重复承担大量装配成本。

Boot 的价值就在这里：

- **把 Framework 的扩展点组织成一套可复用的应用装配协议。**

第三层问题是：**真实应用不仅要启动成功，还要能被诊断、暴露健康状态、接受环境配置并适配部署平台。**

一个生产应用还需要：

- 配置文件和环境变量统一绑定
- 启动失败时给出可操作的原因
- 暴露健康检查和就绪状态
- 记录日志并按环境切换输出方式
- 提供测试切片，避免每个测试都完整启动整个应用

这些能力不属于单一 IoC 容器机制，却决定了应用是否容易运行和维护。

因此，本卷真正要回答的问题不是“Boot 比 Spring 多了哪些注解”，而是：

**为什么 Spring Boot 必须成为建立在 Spring Framework 之上的应用装配层，而不是一组方便的配置模板？**

## 先看失败方案：为什么只用 Spring Framework、复制配置模板或全量自动配置都不够

### 失败方案一：每个项目都直接使用 Spring Framework，自行完成全部装配

这是完全可行的方案，很多传统 Spring 项目也确实这样做。

项目可以自己：

- 创建 `ApplicationContext`
- 注册配置类
- 声明 `DataSource`
- 注册事务管理器
- 配置 MVC
- 注册 Servlet
- 处理环境属性

问题不在于它不能工作，而在于：

- 每个项目都要重复做同一批装配决策
- 默认配置容易产生细微差异
- 设施替换和版本升级成本高
- 启动失败时缺少统一诊断入口

也就是说，这个方案把“应用基础设施装配”变成了每个团队自己维护的局部框架。

Spring Boot 解决的不是 Framework 做不到，而是：

- **把重复的应用装配决策收敛成可复用的默认协议。**

### 失败方案二：复制一份公司模板，所有项目从模板改出来

这比完全手工配置更实际，但模板也有自己的边界：

- 模板只能覆盖创建时已知的场景
- 项目添加新依赖后，模板不一定知道怎样装配
- 默认配置和用户覆盖之间没有统一的条件规则
- 模板升级容易变成多份分叉配置

更重要的是，模板通常是静态文件集合，而应用装配需要根据运行时事实做判断：

- 类是否存在
- Bean 是否已经存在
- 配置项是否打开
- 当前应用类型是什么

所以 Boot 使用的不是一份静态模板，而是一套带条件、排序和回退规则的装配机制。这里的“回退”也不是所有场景都自动覆盖用户定义，而是由具体自动配置上的条件决定，例如 `@ConditionalOnMissingBean` 允许默认 Bean 在用户已有候选时退出，其他条件则可能要求唯一候选、特定属性或特定类路径。

### 失败方案三：把所有自动配置都加载，再让用户决定是否使用

这个方案看似最省事：

- 把所有默认配置类都导入
- 需要的就使用
- 不需要的忽略

但它会把“不应该存在的定义”提前放进容器：

- 缺少依赖类的配置可能直接失败
- 用户已有 Bean 可能与默认 Bean 冲突
- 不同技术栈的默认设施会互相争抢
- 启动时间和定义数量都会无谓增加

所以 Boot 的自动配置不能是全量导入，而必须是：

- 候选配置发现
- 条件评估
- 排序与去重
- 用户定义优先或按条件回退
- 最终只导入当前应用需要的定义

这不是抽象口号，Boot 在源码里确实把这件事做成了明确的导入裁决链：

```java
public String[] selectImports(AnnotationMetadata annotationMetadata) {
    if (!isEnabled(annotationMetadata)) {
        return NO_IMPORTS;
    }
    AutoConfigurationEntry autoConfigurationEntry = getAutoConfigurationEntry(annotationMetadata);
    return StringUtils.toStringArray(autoConfigurationEntry.getConfigurations());
}

protected AutoConfigurationEntry getAutoConfigurationEntry(AnnotationMetadata annotationMetadata) {
    AnnotationAttributes attributes = getAttributes(annotationMetadata);
    List<String> configurations = getCandidateConfigurations(annotationMetadata, attributes);
    configurations = removeDuplicates(configurations);
    Set<String> exclusions = getExclusions(annotationMetadata, attributes);
    configurations.removeAll(exclusions);
    configurations = getConfigurationClassFilter().filter(configurations);
    return new AutoConfigurationEntry(configurations, exclusions);
}
```

这段代码来自 `spring-boot-project/spring-boot-autoconfigure/src/main/java/org/springframework/boot/autoconfigure/AutoConfigurationImportSelector.java:113`。它证明的不是 Boot 已经把所有自动配置都直接塞进容器，而是：

- 先取候选
- 再去重
- 再处理排除项
- 再经过配置类过滤器做条件筛选
- 最后才把真正留下来的配置类交回定义世界

这也是后续 `AutoConfigurationImportSelector` 和条件体系必须单独展开的原因。

## Spring 与 Spring Boot 的最小分层图

如果把两者的关系先压缩成一张图，可以写成：

```text
Spring Boot
  应用启动 / 自动配置 / 条件裁决 / 配置绑定 / Starter / Actuator / 测试切片
        |
        v
Spring Framework
  IoC / refresh / AOP / 事务 / MVC / Web / Environment / TestContext
        |
        v
基础设施与运行环境
  Servlet 容器 / Tomcat / HikariCP / Redis 客户端 / 日志系统 / JVM / 操作系统
```

这张图里最容易混淆的，是 Spring Boot 和 Spring Framework 的边界。

### Spring Framework 更关心什么

- 容器怎样定义和创建 Bean
- Bean 生命周期怎样推进
- AOP 代理怎样生成
- 事务拦截器怎样执行
- MVC 请求怎样分发
- `refresh()` 如何激活整个上下文

### Spring Boot 更关心什么

- 哪个上下文实现适合当前应用
- 哪些自动配置候选应该进入定义世界
- 当前类路径、环境和已有 Bean 是否满足启用条件
- 如何把配置文件绑定成类型安全对象
- 如何把 Framework 能力接到 Tomcat、HikariCP、Redis 等基础设施
- 启动失败、健康状态和测试环境如何提供统一默认能力

这些不是 Boot 在启动时凭空创造的基础设施，而是 Boot 根据应用事实选择并注册到 Framework 容器里的定义。

因此，Boot 不是 Framework 的替代品，而是：

- **位于 Framework 之上、面向完整应用交付的装配层。**

## 一、Spring Framework 提供“能力”，但不替应用做全部装配决策

前面 `vol-spring` 已经反复证明，Spring Framework 的强大来自它的可组合机制：

- BeanDefinition 可以注册和修改
- `ConfigurationClassPostProcessor` 可以解析配置类
- `ConditionEvaluator` 可以参与条件判断
- `ApplicationContext` 可以通过 `refresh()` 完成激活
- `ServletWebServerApplicationContext` 可以接入嵌入式 WebServer

但“机制存在”不等于“应用默认已经装好”。

以一个 Web + JDBC 应用为例，Framework 本身不会凭空知道：

- 应用想使用哪个连接池
- JDBC 驱动是否存在
- `spring.datasource.url` 应该绑定到哪个对象
- 用户是否已经自己声明了数据源
- 事务管理器是否应该跟着数据源创建

这些决策需要一个更高层的装配者完成。

Spring Boot 的自动配置就是在这个位置出现的：

- 先读取应用当前环境
- 再检查类路径和已有定义
- 然后按条件导入默认配置
- 最后把默认配置交回 Framework 的 BeanDefinition 和 `refresh()` 主线

所以 Boot 并没有绕开 Spring 容器，而是把应用级决策转换成 Framework 能执行的定义。

## 二、Spring Boot 的核心抽象不是“默认值”，而是“有条件的默认值”

“约定优于配置”经常被简化成：

- Boot 替你填好了默认配置

但这还不够准确。

Boot 真正的核心是：

- **只有在条件满足时，默认配置才进入应用。**

例如一个自动配置通常会同时关心：

- 类路径上有没有所需类
- 当前是不是特定类型的 Web 应用
- 容器里是否已经存在某个 Bean
- 用户是否显式设置了某个属性
- 当前是否已经有用户自己的替代实现

这使 Boot 的默认行为具备两个特征：

### 默认可用

新项目只引入 Starter，通常就能获得一套可运行的基础设施。

### 用户可接管

一旦用户提供自己的 Bean、配置或实现，Boot 会在满足相应条件时让默认配置退让；最典型的形式就是很多自动配置会配合 `@ConditionalOnMissingBean`，但是否退让、退让到什么粒度，要看具体自动配置类上的条件组合。

这两点必须同时存在。

只有默认没有接管能力，Boot 就会变成封闭平台；只有接管没有默认，Boot 就失去降低装配成本的价值。

## 三、为什么 Starter、自动配置和配置绑定必须组成一个整体

很多人把 Starter、自动配置和 `@ConfigurationProperties` 分开理解：

- Starter 是依赖管理
- 自动配置是 Bean 注册
- 配置绑定是读取配置

从实现位置看它们确实是不同机制，但从应用装配角度看，它们是一条连续链：

```text
Starter 引入依赖
   -> 自动配置候选进入发现范围
   -> 条件判断决定是否启用
   -> ConfigurationProperties 绑定外部配置
   -> 自动配置创建并定制基础设施 Bean
```

例如数据源场景：

- Starter 提供 JDBC、连接池和驱动相关依赖
- `DataSourceAutoConfiguration` 成为候选
- 条件系统检查类路径和已有 Bean
- `DataSourceProperties` 绑定 `spring.datasource.*`
- 自动配置创建 `DataSource`
- 事务和 `JdbcTemplate` 配置继续围绕它展开

如果只看其中一环，就无法解释 Boot 为什么能把一个依赖坐标变成一组可工作的应用能力。

## 四、为什么 Boot 最终仍然要回到 Framework 的 `refresh()`

Boot 看起来增加了很多入口：

- `SpringApplication.run()`
- `@SpringBootApplication`
- `@EnableAutoConfiguration`
- `AutoConfigurationImportSelector`
- `ConfigurationPropertiesBindingPostProcessor`

但这些入口最后都不会替代 Framework 的容器主线。

它们做的是：

- 准备环境
- 选择上下文
- 加载应用源
- 导入并筛选自动配置
- 注册初始化器和运行监听器

当定义世界准备好以后，仍然要回到：

- BeanFactory 后处理
- BeanDefinition 注册与解析
- 单例创建
- BeanPostProcessor
- 生命周期回调
- WebServer 创建

也就是前面 `vol-spring` 已经拆过的 `refresh()` 和相关扩展链。

因此，Spring Boot 的正确定位不是“另一个 Spring 容器”，而是：

- **把应用级装配决策组织好，再交给 Spring Framework 容器执行。**

## 五、为什么 Boot 还必须额外承担生产和测试层

如果 Boot 只负责自动配置，仍然不足以解释它在真实项目中的存在感。

一个应用从开发到生产至少还需要三类能力：

### 启动诊断

当配置错误、驱动缺失或 Bean 冲突导致启动失败时，开发者需要知道：

- 失败发生在哪个机制
- 缺少什么条件
- 应该如何修复

这就是 FailureAnalyzer 的位置。

### 运行时状态

应用启动成功不代表它适合接流量。平台还需要知道：

- 应用是否已经存活
- 是否已经准备好接收请求
- 数据库、Redis 等依赖是否健康
- 当前有哪些指标和运行信息

这构成 ApplicationAvailability 和 Actuator 的生产层。

### 测试裁剪

开发者也不希望每个 Controller 测试都启动完整数据库和消息系统，因此需要：

- `@SpringBootTest` 的完整应用测试
- `@WebMvcTest` 的 MVC 切片
- `@JsonTest` 的 JSON 切片
- 自动配置排除与 Mock 替换

这构成 Boot 的测试层。

因此，本卷不能只写自动装配核心，还必须把诊断、生产和测试放进完整路线中。

## 六、为什么第一篇之后应该先讲 `@SpringBootApplication`，再讲 `run()`

总开篇已经回答了：

- 为什么需要 Boot
- Boot 和 Framework 的边界是什么
- Boot 的核心价值是应用装配而不是简单默认值

接下来最自然的问题是：

- 一个 Boot 应用的定义世界从哪里开始？

答案首先落在 `@SpringBootApplication`：

- 它把应用配置类、组件扫描和自动配置入口放在一起
- 它是应用定义世界的声明性总入口

再往后才进入 `SpringApplication.run()`：

- 它负责把这个入口放进启动流程
- 准备 Environment、上下文和监听器
- 最终把定义世界交给 `refresh()` 激活

所以推荐阅读顺序是：

```text
为什么有了 Spring，还要 Spring Boot
   -> @SpringBootApplication 与应用定义入口
   -> 自动配置导入总链
   -> Boot 条件注解体系
   -> SpringApplication.run() 启动流程
```

这条顺序先回答价值，再回答声明入口，最后回答运行时执行。

## 七、几个最容易错的判断

### 1. Spring Boot 只是 Spring 的配置简化版

不完整。

Boot 的核心是根据类路径、环境和已有 Bean 做条件装配，并把应用从开发配置推进到可运行、可诊断、可测试状态。

### 2. Spring Framework 已经有自动配置，所以 Boot 没有新增核心机制

不成立。

Framework 提供了配置类解析、条件接口和容器扩展点；Boot 把这些扩展点组织成了面向应用的自动配置候选、排序、条件裁决和 Starter 发布体系。

### 3. Starter 本身就是自动配置

不成立。

Starter 主要解决依赖传递和版本组合；自动配置类负责根据条件注册 Bean，两者通过依赖和候选发现连接起来。

### 4. Boot 的默认配置会覆盖用户自己的配置

不应这样理解。

Boot 的设计重点之一就是让用户定义、用户属性和用户替代实现能够通过条件体系接管默认配置。

### 5. 学完 Spring Framework 就不需要再学 Boot 源码

不成立。

Framework 能解释单个能力怎样运行，Boot 才能解释真实应用为什么会自动拥有这些能力，以及启动失败、健康检查和测试切片怎样被统一组织。

## 收网：Spring 解决“能力如何实现”，Spring Boot 解决“应用如何被装配、启动和交付”

现在可以回到开头的问题：为什么有了 Spring，还要 Spring Boot？

因为两者解决的不是同一个问题：

```text
Spring Framework
  提供 IoC、AOP、事务、MVC、环境与测试等可组合能力

Spring Boot
  根据应用类型、类路径、环境和用户定义
  选择、裁剪、绑定、装配并启动这些能力
  再补上诊断、可观测、健康状态和测试体验
```

所以，Spring Boot 不是把 Spring Framework 重新包装一遍，而是把 Framework 从“能力集合”提升为“可直接交付的应用运行系统”。

这篇真正该带走的结论是：

**Spring Framework 负责把基础能力做成可组合机制，Spring Boot 负责把这些机制按照应用当前的事实装配成默认可运行、用户可接管、失败可诊断、生产可观测的完整应用。**

下一篇进入 `@SpringBootApplication`：一个看起来只是组合注解的入口，为什么它实际上同时打开了应用配置类、组件扫描和自动配置三个定义世界。