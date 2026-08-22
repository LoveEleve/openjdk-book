# 卷 Spring Boot · 自动装配与运行时装配总线

> 本卷用于承接 `vol-spring` 之后的上层装配世界：`SpringApplication.run()`、`@SpringBootApplication`、自动装配、嵌入式 Web 容器、Actuator、运行时可用性、测试切片与生产诊断。继续写作前先遵循交接文档：
>
> `../HANDOFF-VOL-SPRING-TO-SPRINGBOOT.md`

## 当前状态

- 已完成既有 Boot 规划域与 outline 的第一轮 review
- 已补：`SpringBoot源码学习范围规划-缺陷修复版.md`
- 已完成第 1 阶段主干层 + 集成层主体正文，并推进到生产层 / 测试层
- 现阶段正文仍以“机制叙事体 + 真实源码证据逐篇补强”的方式推进
- 源码证据层仍未做统一二次升级，后续应和 `vol-spring` 一起回补

## 必看前置

先 review：

- `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/issue/SpringBoot源码学习范围规划.md`
- `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/issue/SpringBoot源码学习范围规划-缺陷修复版.md`
- `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/issue/源码分析执行计划.md`
- `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/issue/源码范围规划复盘方法论.md`
- `../WRITING-METHODOLOGY.md`
- `../HANDOFF-VOL-SPRING-TO-SPRINGBOOT.md`

## 写作原则

延续当前统一正文风格：

- 困惑开场
- 失败方案
- 最小总图
- 主线拆解
- 易错判断
- 收网桥接

注意：

- 当前阶段继续先铺正文主线
- 每篇完成后立刻做深度 review / 修补
- 源码证据层（代码块 / file:line 密集补强）后续统一回补

## 已完成正文

### 总开篇

1. `01-why-spring-boot.md`：为什么有了 Spring，还要 Spring Boot

### 主干层：入口 / 自动配置 / 启动 / 配置绑定

2. `02-springbootapplication.md`：`@SpringBootApplication` 与应用定义入口
3. `03-enableautoconfiguration-and-importselector.md`：`@EnableAutoConfiguration` 与 `AutoConfigurationImportSelector`
4. `04-boot-conditional-system.md`：Boot 条件注解体系
5. `05-springapplication-run.md`：`SpringApplication.run()` 启动流程
6. `06-configurationproperties.md`：`@ConfigurationProperties` 与类型安全绑定
7. `07-starter-mechanism.md`：Starter 机制

### 主干层：Web / Servlet / MVC / JSON

8. `08-webmvc-autoconfiguration.md`：Web MVC 自动装配
9. `09-servlet-webserver-autoconfiguration.md`：嵌入式 Servlet 容器自动装配
10. `10-dispatcherservlet-registration.md`：`DispatcherServlet` 注册与默认映射
11. `11-httpmessageconverters-and-json.md`：`HttpMessageConverters` 与 JSON 默认体验

### 主干层：数据访问 / 缓存 / 事务

12. `12-datasource-jdbc-autoconfiguration.md`：DataSource / JDBC 自动配置
13. `13-redis-autoconfiguration.md`：Boot 原生 Redis 自动配置
14. `14-redisson-spring-boot-starter.md`：`redisson-spring-boot-starter` 与 Redis 基础设施接管边界
15. `15-cache-autoconfiguration.md`：缓存自动配置
16. `16-transaction-autoconfiguration.md`：事务自动配置

### 生产层

17. `17-failure-analyzer.md`：启动失败诊断 `FailureAnalyzer`
18. `18-configdata.md`：`ConfigData` 外部配置装载主线
19. `19-logging-system.md`：日志系统自动配置
20. `20-application-availability.md`：`ApplicationAvailability`
21. `21-actuator-endpoints.md`：Actuator 端点体系
22. `22-metrics-and-health.md`：Metrics / Health 深化

### 测试层

23. `23-test-autoconfiguration.md`：测试自动配置

## 当前推荐阅读顺序

### Boot 主干闭环

1. `01-why-spring-boot.md`
2. `02-springbootapplication.md`
3. `03-enableautoconfiguration-and-importselector.md`
4. `04-boot-conditional-system.md`
5. `05-springapplication-run.md`
6. `06-configurationproperties.md`
7. `07-starter-mechanism.md`

### Web 主线

8. `08-webmvc-autoconfiguration.md`
9. `09-servlet-webserver-autoconfiguration.md`
10. `10-dispatcherservlet-registration.md`
11. `11-httpmessageconverters-and-json.md`

### 数据与事务主线

12. `12-datasource-jdbc-autoconfiguration.md`
13. `13-redis-autoconfiguration.md`
14. `14-redisson-spring-boot-starter.md`
15. `15-cache-autoconfiguration.md`
16. `16-transaction-autoconfiguration.md`

### 生产层 / 测试层

17. `17-failure-analyzer.md`
18. `18-configdata.md`
19. `19-logging-system.md`
20. `20-application-availability.md`
21. `21-actuator-endpoints.md`
22. `22-metrics-and-health.md`
23. `23-test-autoconfiguration.md`

## 当前阶段性判断

- `vol-spring-boot` 主干层主体已经铺开，Web / 数据 / 事务 / Redis / 缓存等核心路径已覆盖
- 生产层已进入：失败诊断、配置装载、日志、Availability、Actuator、Metrics/Health
- 测试层已进入总论篇，但还有切片 / MockBean / MockMvc / JSON tester 等可继续细化
- 后续还可以继续补：Validation、WebFlux、虚拟线程、AOT、Elasticsearch 等补深层

## 目前明显欠账

- 全卷还没统一做第二轮源码证据增强
- 篇间交叉引用还可以继续补密
- 仍需补一份当前卷的阶段性交接文档
- 仍需确保后续新篇保持“写完即深审”的节奏
