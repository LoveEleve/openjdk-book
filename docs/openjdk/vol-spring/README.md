# 卷 Spring · Spring Framework 源码分析

> 本卷当前聚焦 **Spring Framework 6.x**，并按“主干机制 -> 规范层 -> 集成层 -> 机制补深层 -> 生产层”的完整卷方式组织。写作目标不是把 `spring-core`、`spring-beans`、`spring-context` 等模块按目录翻译一遍，而是把 Spring 最核心的 IoC / DI / AOP / Tx / MVC 主线，连同它兑现的外部契约、它与 Tomcat / Spring Boot 的装配桥、以及生产环境中的诊断与调优，一起组织成可连续阅读、可迁移到真实项目的源码书。

## 当前卷级状态

当前已经完成：
- **主干层**：1 篇
- **规范层**：0 篇
- **集成层**：0 篇
- **机制补深层**：0 篇
- **生产层**：0 篇

也就是说：
- **Spring 主干卷** 还在起步阶段
- 但 **Spring 完整卷骨架** 已经按复盘方法论补齐

## 一、整卷结构

本卷按五层组织：

### 1. 主干层

回答：
- 容器如何读取资源、装配 Bean、完成依赖注入
- AOP / 事务 / MVC 如何接到这条主线上
- 请求进入 `DispatcherServlet` 之后如何被真正分发与执行

### 2. 规范层

回答：
- Spring 在兑现哪些外部契约
- `@Inject` / `@Resource` / `@PostConstruct` / Servlet 规范与 Spring 自身抽象的边界是什么

### 3. 集成层

回答：
- Spring Boot 如何把 Spring Framework 装起来
- `DispatcherServlet` 如何被接到 Tomcat 容器里

### 4. 机制补深层

回答：
- 主干中已经出现、但值得独立深挖的生命周期与销毁问题
- `ApplicationContext` 和 `BeanFactory` 的完整退场链

### 5. 生产层

回答：
- 循环依赖、事务失效、代理失效、条件注解不生效等问题如何诊断
- Spring 的启动、运行与内存成本如何调优

## 二、主干层目录骨架

### Core 基础层
- `ch1-core-resource/`：`Resource` 资源抽象
- `ch2-core-conversion/`：`ConversionService` 与类型转换
- `ch3-core-environment/`：`Environment` 与属性源
- `ch4-core-ordered/`：`Ordered` / `PriorityOrdered` / `@Order`
- `ch5-core-annotation/`：注解元数据与合并
- `ch6-core-profile/`：`@Profile` 与环境隔离
- `ch7-core-taskexecutor/`：`TaskExecutor` 抽象

### Bean 容器层
- `ch8-beandefinition/`：`BeanDefinition` 模型
- `ch9-beanfactory/`：`BeanFactory` 层次
- `ch10-bean-lifecycle/`：Bean 生命周期
- `ch11-circular-dependency/`：循环依赖与三级缓存
- `ch12-di-injection/`：`@Autowired` / `@Resource` / `@Qualifier`
- `ch13-bpp/`：`BeanPostProcessor` 体系
- `ch14-bfpp/`：`BeanFactoryPostProcessor` 体系
- `ch15-factorybean/`：`FactoryBean` 机制
- `ch16-scope/`：Bean 作用域与 Web Scopes

### Context 主线层
- `ch17-refresh/`：`refresh()` 生命周期
- `ch18-configuration/`：`@Configuration` 配置类处理
- `ch19-import/`：`@Import` / `@EnableXxx`
- `ch20-conditional/`：`@Conditional` 条件注册
- `ch21-event/`：事件机制
- `ch22-parent-context/`：父子容器
- `ch23-async/`：`@Async`
- `ch24-scheduled/`：`@Scheduled`
- `ch25-cacheable/`：`@Cacheable`
- `ch26-lazy-primary-depends/`：`@Lazy` / `@Primary` / `@DependsOn`
- `ch27-aot/`：AOT 与 Native Image

### AOP 与事务层
- `ch28-aop-proxy/`：代理机制
- `ch29-advice-chain/`：Advice 链执行
- `ch30-aspectj/`：`@AspectJ` 注解解析
- `ch31-autoproxy/`：自动代理流程
- `ch32-transactional/`：`@Transactional` 完整链路
- `ch33-tx-failures/`：事务失效场景
- `ch34-tx-propagation/`：事务传播行为
- `ch35-tx-exception/`：`DataAccessException` 体系

### JDBC 与 Web 层
- `ch36-jdbctemplate/`：`JdbcTemplate`
- `ch37-datasource/`：`DataSource` 抽象
- `ch38-dispatcherservlet/`：`DispatcherServlet`
- `ch39-requestmapping/`：`@RequestMapping` 注册与匹配
- `ch40-requestbody/`：`@RequestBody` 反序列化
- `ch41-responsebody/`：`@ResponseBody` 序列化
- `ch42-interceptor/`：拦截器链
- `ch43-web-exception/`：异常处理体系
- `ch44-spel/`：SpEL 表达式引擎

### 测试层
- `ch45-mockmvc/`：`MockMvc`
- `ch46-test-context/`：`TestContext`

## 三、规范层目录骨架

- `ch47-jsr330/`：JSR-330 依赖注入规范（`@Inject` / `@Named`）
- `ch48-jsr250/`：JSR-250 通用注解规范（`@PostConstruct` / `@PreDestroy` / `@Resource`）
- `ch49-servlet-contract/`：Servlet 规范与 Spring MVC 契约边界

## 四、集成层目录骨架

- `ch50-dispatcherservlet-tomcat/`：`DispatcherServlet` 如何接入 Tomcat
- `ch51-boot-assembly/`：Spring Boot 如何装配 Spring Framework

## 五、机制补深层目录骨架

- `ch52-applicationcontext-lifecycle/`：`ApplicationContext` 完整生命周期总图
- `ch53-beanfactory-destroy/`：`BeanFactory` 销毁与回收

## 六、生产层目录骨架

- `ch54-runtime-diagnostics/`：循环依赖 / 事务 / AOP / 条件注解诊断
- `ch55-performance/`：启动与运行时性能调优

## 七、当前已完成正文

### Ch1 Core Resource
- [01. Spring 为什么不直接用 `File`：`Resource` 如何把 classpath、磁盘和 URL 统一成一种资源句柄](ch1-core-resource/01-resource-abstraction.md)

回答：
- 为什么容器不能直接用 `File`、`URL` 或 `InputStream` 作为统一资源模型
- `Resource -> AbstractResource -> 具体实现 -> ResourceLoader` 这条资源抽象链如何成立

### Ch2 Core Conversion
- [01. Spring 为什么不直接 `Integer.parseInt`：`ConversionService` 如何把字符串、安全类型和泛型集合接成一条统一转换链](ch2-core-conversion/01-conversion-service.md)

回答：
- 为什么 Spring 要把类型转换升级成统一框架协议，而不是散落成 `parseXxx()`
- `ConversionService -> Converter 家族 -> TypeDescriptor -> GenericConversionService -> TypeConverterDelegate` 这条转换主线如何成立

### Ch3 Core Environment
- [01. Spring 里的 `${server.port}` 到底从哪来：`Environment`、`PropertySource` 与占位符解析如何组成一条配置主线](ch3-core-environment/01-environment-and-propertysource.md)

回答：
- 为什么 Spring 要把配置来源组织成一条有优先级的责任链，而不是一张拍平的配置表
- `${...}` 为什么不是正则替换，而是一套带默认值、嵌套和转义的小语法

### Ch4 Core Ordered
- [01. Spring 为什么总能先执行“该先执行的人”：`Ordered`、`PriorityOrdered` 与 `@Order` 如何把顺序变成一条统一排序协议](ch4-core-ordered/01-ordered-and-priority.md)

回答：
- 为什么 Spring 的顺序问题不是局部 sort，而是统一的顺序语义协议
- `Ordered / PriorityOrdered / @Order / OrderComparator / AnnotationAwareOrderComparator` 如何一起成立

### Ch5 Core Annotation
- [01. 为什么 `@RestController` 没写 `@Component` 也能被扫到：Spring 的注解元数据、合并视图与 `@AliasFor` 主线](ch5-core-annotation/01-merged-annotations.md)

回答：
- 为什么 Spring 不能只靠 `getAnnotation()`，而必须建立一套元注解搜索、合并与映射体系
- `MergedAnnotation / MergedAnnotations / @AliasFor / AnnotationTypeMapping / AnnotatedElementUtils` 这条元数据主线如何成立

### Ch6 Core Profile
- [01. `@Profile("dev")` 到底是谁在判：Spring 如何把环境开关升级成一条条件装配主线](ch6-core-profile/01-profile-and-condition.md)

回答：
- 为什么 `@Profile` 不是运行时 if 开关，而是装配期条件裁决入口
- `@Profile / @Conditional / ConditionEvaluator / ProfileCondition / Environment / AbstractEnvironment` 这条条件装配主线如何成立

### Ch7 Core TaskExecutor
- [01. `@Async` 到底跑在哪个线程：Spring 为什么要把执行器升级成一条统一任务执行主线](ch7-core-taskexecutor/01-taskexecutor-abstraction.md)

回答：
- 为什么 Spring 统一的不是某个线程池，而是跨异步、事件、调度、测试场景的执行协议
- `TaskExecutor / SyncTaskExecutor / SimpleAsyncTaskExecutor / ThreadPoolTaskExecutor / ConcurrentTaskExecutor` 这条执行器主线如何成立

### Ch8 BeanDefinition
- [01. Spring 为什么先定义 Bean 再创建 Bean：`BeanDefinition` 如何把 XML、注解和 `@Bean` 统一成一张容器蓝图](ch8-beandefinition/01-beandefinition-model.md)

回答：
- 为什么 Spring 不会一看到 `@Component`、`<bean>` 或 `@Bean` 方法就立刻创建对象
- `BeanDefinition / AbstractBeanDefinition / scope / lazy / dependsOn / role / factory metadata / init-destroy metadata` 这条定义蓝图主线如何成立

### Ch9 BeanFactory
- [01. Spring 为什么不把一切都塞进 `ApplicationContext`：`BeanFactory` 继承树如何把“取 Bean”“枚举 Bean”“配置容器”拆成不同能力层](ch9-beanfactory/01-beanfactory-hierarchy.md)

回答：
- 为什么 Spring 容器能力不能压成一个大接口，而必须按读取、父子、枚举、配置、组合分层
- `BeanFactory / HierarchicalBeanFactory / ListableBeanFactory / ConfigurableBeanFactory / ConfigurableListableBeanFactory / ApplicationContext` 这条能力树如何成立

### Ch10 Bean Lifecycle
- [01. 一个 Bean 是怎么活起来的：Spring 为什么把生命周期压成 `doCreateBean()` 这一整条创建链](ch10-bean-lifecycle/01-bean-lifecycle-full-chain.md)

回答：
- 为什么 Bean 不能被理解成一次构造函数调用，而必须经过实例化、填充、初始化、增强和退场登记
- `createBeanInstance / populateBean / initializeBean / registerDisposableBeanIfNecessary` 这条生命周期主线如何成立

### Ch11 Circular Dependency
- [01. 为什么有的循环依赖 Spring 能解，有的直接炸：三级缓存与 `getEarlyBeanReference` 的精确协作](ch11-circular-dependency/01-three-level-cache.md)

回答：
- 为什么构造器循环依赖天然不可解，而字段 / Setter 注入会出现一个可提前暴露窗口
- `singletonObjects / earlySingletonObjects / singletonFactories / getEarlyBeanReference(...)` 这条循环依赖主线如何成立

### Ch12 DI Injection
- [01. 为什么 `@Autowired`、`@Resource`、`@Qualifier` 看起来像在“自动注入”，其实背后是三套不同的候选选择协议](ch12-di-injection/01-autowired-resource-qualifier.md)

回答：
- 为什么 `@Autowired`、`@Resource`、`@Qualifier` 不是同一种注入机制的不同语法皮肤
- 注入点扫描、依赖请求建模、候选查找与裁决这条依赖注入主线如何成立

### Ch13 BeanPostProcessor
- [01. Spring 的“魔法注解”为什么到处都能生效：`BeanPostProcessor` 如何沿着 Bean 生命周期各阶段切进去](ch13-bpp/01-beanpostprocessor-panorama.md)

回答：
- 为什么 Spring 的很多“魔法感”能力本质上都站在同一套生命周期插点体系上
- `BeanPostProcessor / InstantiationAwareBeanPostProcessor / SmartInstantiationAwareBeanPostProcessor / DestructionAwareBeanPostProcessor` 这条后处理主线如何成立

### Ch14 BeanFactoryPostProcessor
- [01. 为什么有的扩展改的是对象，有的改的是定义：`BeanFactoryPostProcessor` 如何在 Bean 创建前改写整个定义世界](ch14-bfpp/01-beanfactorypostprocessor-panorama.md)

回答：
- 为什么 `BeanFactoryPostProcessor` 和 `BeanPostProcessor` 不是同一套扩展点的前后版本，而是定义世界与实例世界的分界线
- `BeanFactoryPostProcessor / BeanDefinitionRegistryPostProcessor / ConfigurationClassPostProcessor / PropertySourcesPlaceholderConfigurer` 这条定义后处理主线如何成立

### Ch15 Scope
- [01. 为什么 `singleton` 不是默认就完了：Spring 的作用域、Web Scope 与 Scoped Proxy 如何把“同一个定义”分流成不同生命周期](ch15-scope/01-scope-and-scoped-proxy.md)

回答：
- 为什么作用域不是“创建几次”这么简单，而是容器责任边界与生命周期策略分流
- `BeanDefinition.scope / doGetBean 分支 / Scope / RequestContextHolder / ScopedProxy` 这条作用域主线如何成立

### Ch17 Refresh
- [01. Spring 容器到底是谁真正启动起来的：`refresh()` 如何把前面所有主线串成一次完整启动](ch17-refresh/01-refresh-lifecycle.md)

回答：
- 为什么 `refresh()` 不是简单方法串联，而是定义世界、实例世界、扩展世界和基础设施世界的总启动骨架
- `prepareRefresh / obtainFreshBeanFactory / invokeBeanFactoryPostProcessors / registerBeanPostProcessors / finishBeanFactoryInitialization / finishRefresh` 这条总串联主线如何成立

### Ch18 Configuration
- [01. 为什么 `@Configuration` 不只是一个标记：Spring 如何把配置类解析成会继续扩张的定义世界](ch18-configuration/01-configuration-class-processing.md)
- [02. 为什么 `@Bean` 方法彼此调用不会不断 new 新对象：Spring 如何用方法级定义与 CGLIB 增强守住配置类单例语义](ch18-configuration/02-bean-method-and-cglib-enhancement.md)

回答：
- 为什么配置类处理首先属于定义世界，而不是实例世界
- `ConfigurationClassPostProcessor / ConfigurationClassParser / ConfigurationClassBeanDefinitionReader / ConfigurationClassEnhancer / BeanMethodInterceptor` 这条配置类扩张与增强主线如何成立

### Ch19 Import / Scan
- [01. 为什么 `@ComponentScan` 和 `@Import` 不是两个小注解：Spring 如何把它们组织成定义世界的递归扩张引擎](ch19-import/01-componentscan-recursive-scanning.md)

回答：
- 为什么 `@ComponentScan` 是配置候选扩增器，而不是一次性包扫描
- `@Import` 的三路分发、`DeferredImportSelector` 的延迟处理、`ImportStack` 的导入关系管理如何协同成立

### Ch20 Conditional
- [01. 为什么有的配置类一开始就被跳过，有的 `@Bean` 方法要等后面才判断：Spring 的 `@Conditional` 两阶段装配主线](ch20-conditional/01-conditional-evaluator.md)

回答：
- 为什么条件装配必须拆成 `PARSE_CONFIGURATION / REGISTER_BEAN` 两阶段
- `@Conditional / ConditionEvaluator / ConfigurationCondition / ConditionContext` 这条条件裁决主线如何成立

### Ch22 ApplicationContext
- [01. 为什么 `ApplicationContext` 不只是一个大接口：Spring 如何用几种上下文实现把“定义加载阶段”和“refresh 激活阶段”分成两段](ch22-parent-context/01-applicationcontext-implementations.md)

回答：
- 为什么上下文实现体系最大的差异在 refresh 之前的定义加载入口，而不是 refresh 之后的激活骨架
- `GenericApplicationContext / AnnotationConfigApplicationContext / ClassPathXmlApplicationContext / GenericWebApplicationContext` 这条上下文实现主线如何成立

## 八、推荐阅读顺序

在进入顺序之前，先把依赖关系讲清楚：

- **硬依赖**：不先读很难理解后文主线，例如 `ch1` ~ `ch16` 对 `ch17` 之后很多文章都是硬前置，`ch38-dispatcherservlet` 又是 `ch39` ~ `ch43` 的硬前置。
- **软依赖**：最好先读，但当前篇也可以提供局部闭环，例如 `ch44-spel` 常作为 `@Value`、`@Cacheable` 的补层，而不是每次都必须严格前置。
- **导航依赖**：当前篇只建立桥接，不把后文当既成事实，例如规范层、集成层、生产层很多时候会回指主干结论，但不会要求主干读者先掌握全部后层内容。

如果是第一次系统学习 Spring Framework，建议顺序：

1. `ch1` ~ `ch7`：先把 Spring Core 地基打稳，其中 `ch5-core-annotation` 是 `ch4-core-ordered` 往下理解注解感知排序的硬后续
2. `ch8` ~ `ch16`：进入 Bean 容器与依赖注入主线
3. `ch17` ~ `ch27`：补齐 `ApplicationContext` 与注解驱动主线
4. `ch28` ~ `ch35`：再进入 AOP 与事务
5. `ch36` ~ `ch43`：最后进入 JDBC 与 MVC 请求执行链
6. `ch44`：SpEL 作为**软依赖/插读层**处理——在 `@Value`、`@Cacheable`、条件表达式等主线碰到时按需回读
7. `ch47` ~ `ch49`：回头校准规范边界
8. `ch50` ~ `ch51`：再补 Tomcat / Spring Boot 集成桥
9. `ch52` ~ `ch55`：最后收机制补深与生产层
10. `ch45` ~ `ch46`：测试层可后置通读，也可在 MVC 主线写完后按需插读

这个顺序的好处是：
- 先立住 Spring 的资源、Bean、Context 主干
- 再理解 AOP / Tx / MVC 为什么是“接在主干上的能力”
- 测试层不强行抢在规范层、集成层之前，而是按依赖成熟度灵活插入
- 最后再补规范、集成和生产视角

## 九、与其他卷的桥接

### 与 Tomcat 卷
- `ch49-servlet-contract/` 对应 `vol-tomcat/ch8-servlet-spec/`
- `ch50-dispatcherservlet-tomcat/` 对应 `vol-tomcat/ch7-springboot-integration/` 与 Tomcat 请求主线

### 与 Spring Boot 相关内容
- `ch19-import/`、`ch20-conditional/`、`ch27-aot/` 是后续 Boot 自动装配正文的硬前置
- `ch51-boot-assembly/` 会直接桥接到 Boot 自动装配、`SpringApplication.run()` 与 WebServer 装配链
- 如果后续单独拆卷，再确定最终卷名；当前 README 不预先承诺 `vol-spring-boot` 这一命名

## 十、当前结论

到目前为止，这一卷已经明确了三件事：
- Spring 不能只按模块目录写，必须按知识主线写
- 这卷不只要讲 IoC / AOP / Tx / MVC 主干，还必须补规范层、集成层、机制补深层和生产层
- `vol-spring` 现在已经具备整卷骨架，可以按方法论持续往下写正文

也就是说：
- **Spring 完整卷骨架已成立**
- **正文主线刚刚开始**
