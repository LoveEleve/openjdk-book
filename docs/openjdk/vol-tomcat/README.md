# 卷 Tomcat · 嵌入式 Tomcat 源码分析

> 本卷当前聚焦 **嵌入式 Tomcat 10.1.34** 及其在 **Spring Boot 3.5.16** 中的真实落地路径。写作目标不是把 Tomcat 源码仓库按目录翻译一遍，而是把“主干机制 -> 集成桥 -> 规范边界 -> 后续专题层”组织成可连续阅读、可迁移到真实项目的源码书。

## 当前卷级状态

当前已经完成：
- **主干层**：6 篇
- **集成层**：1 篇
- **规范层**：1 篇

也就是说：
- **嵌入式 Tomcat 主干卷** 已经阶段性完结
- **Tomcat 完整卷** 还缺机制补深层与生产层

## 一、主干层（当前已完成）

### Ch1 Startup
- [01. Tomcat 启动时到底发生了什么：从配置树到可收请求的运行时容器](ch1-startup/01-from-config-to-runtime.md)

回答：
- Tomcat 为什么不是“把对象树 new 出来”就算启动
- `Connector / CoyoteAdapter / MapperListener` 为什么必须和容器树一起接好线

### Ch2 Request Entry
- [01. 一个 HTTP 请求是怎么进入 Tomcat 的：从 Socket 到 Catalina](ch2-request-entry/01-from-socket-to-catalina.md)

回答：
- `Connector / Endpoint / Processor / Adapter` 各自做什么
- 请求是在哪里从 Coyote 世界切进 Catalina 世界的

### Ch3 Container Execution
- [01. 请求进入 Catalina 之后发生了什么：从 Mapper 到 Servlet](ch3-container-exec/01-from-mapper-to-servlet.md)

回答：
- `Mapper -> Valve -> FilterChain -> Servlet` 为什么是一条必须拆开的执行主线
- `StandardWrapperValve` 为什么是容器链和执行链的边界点

### Ch4 Async / Timeout / Error
- [01. 请求一旦偏离正常路径，Tomcat 怎么把它重新接住：async、timeout 与 error](ch4-async-error/01-async-timeout-error.md)

回答：
- Tomcat 不只有正向执行链，还有偏离后的重新收束链
- `AsyncStateMachine / AsyncContextImpl / HostValve / ErrorReportValve` 如何协作

### Ch5 Session
- [01. Session 为什么不是一个普通对象：Tomcat 里的生命周期、过期、持久化与复制](ch5-session/01-session-lifecycle.md)

回答：
- Session 为什么不是“请求旁边的一个 Map”
- `StandardSession -> Manager -> expire / persist / replicate` 这条生命史怎样成立

### Ch6 Mapper
- [01. 为什么 Tomcat 还要单独搞一套 Mapper：路由树、匹配规则与运行态更新](ch6-mapper/01-mapper-routing-and-updates.md)

回答：
- 为什么容器树本身还不够，请求主线必须再拥有一棵运行时路由树
- `Mapper` 与 `MapperListener` 的职责边界是什么

## 二、集成层（当前已完成）

### Ch7 Spring Boot Integration
- [01. Spring Boot 到底是怎么把嵌入式 Tomcat 装起来的](ch7-springboot-integration/01-how-spring-boot-assembles-tomcat.md)

回答：
- 为什么真实项目里几乎不手写 `new Tomcat()`
- `ServletWebServerApplicationContext -> TomcatServletWebServerFactory -> TomcatStarter -> TomcatWebServer` 这条装配桥如何成立

## 三、规范层（当前已完成）

### Ch8 Servlet Spec
- [01. 哪些是 Servlet 规范要求，哪些是 Tomcat 自己的实现取舍](ch8-servlet-spec/01-spec-vs-tomcat.md)

回答：
- 生命周期、Filter、Async、Session、SCI 等行为里，哪些是契约，哪些是 Tomcat 当前实现
- 为什么规范层不是附录，而是反向校准主干理解边界的关键视角

## 四、当前还未补完的层次

### 1. 机制补深层（待补）

优先建议：
- `StandardWrapper` 生命周期深挖
- `WebappClassLoaderBase` 与 WebApp 隔离
- `Mapper` 四级匹配补篇
- `MapperListener` 动态更新补篇
- Session 持久化 / 复制补篇

### 2. 生产层（待补）

优先建议：
- 性能调优专题
- 安全运维专题
- 故障排查专题

## 推荐阅读顺序

如果是第一次系统学习嵌入式 Tomcat，建议顺序：

1. Ch1 启动与装配
2. Ch2 请求进入
3. Ch3 容器执行
4. Ch4 async / timeout / error
5. Ch5 Session
6. Ch6 Mapper
7. Ch7 Spring Boot 集成
8. Ch8 Servlet 规范与实现边界

这个顺序的好处是：
- 先立住 Tomcat 本体怎么跑
- 再补 Spring Boot 怎么把它装起来
- 最后回头校准“哪些是规范要求，哪些是实现取舍”

## 当前结论

到目前为止，这一卷已经能回答：
- 嵌入式 Tomcat 怎么被装起来
- 请求怎么进入、怎么执行、怎么偏离、怎么被重新接住
- Session 怎么活
- 路由树怎么存在
- Spring Boot 怎么把这套系统接进真实项目
- 哪些行为来自规范，哪些来自当前实现

也就是说：
- **Tomcat 主干卷已成立**
- **Tomcat 完整卷仍可继续补深与补生产专题**