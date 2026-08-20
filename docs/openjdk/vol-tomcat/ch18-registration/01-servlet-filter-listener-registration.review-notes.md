# Tomcat Ch18-01 Servlet / Filter / Listener 注册体系纵深 — review notes

## 第一轮：事实审

### 目标
核对：
- `StandardContext`、SCI、`ServletContextInitializerBeans`、`TomcatStarter` 的角色归属是否准确
- `file:line` 引用是否真实存在
- 是否把“组件最终会生效”误写成“组件会自然出现”

### 当前需核对的关键锚点
- `StandardContext` 里与 listener / filter / wrapper / initializers 相关字段和启动链方法
- `jakarta.servlet.ServletContainerInitializer`
- Spring Boot 侧：
  - `ServletContextInitializerBeans`
  - `TomcatStarter`
  - 注册 Bean / Initializer 回放链

### 初步判断
- 当前主线与 Ch18 规划一致：规范扩展点 -> Context 托管 -> Boot 回放链
- 没有把 Spring Boot 注册写成平行于容器主线的额外封装
- 当前最大事实风险在于：方法级和字段级硬锚点还没补齐，尤其 `StandardContext` 与 `ServletContextInitializerBeans` 的具体落点还不够硬

## 第二轮：因果审

### 目标
检查正文中所有“组件不会自己出现”“Boot 在复用容器注册链”这类判断，是否由规范层、Tomcat 层、Boot 层三侧共同支撑。

### 当前因果链
1. 组件不会自然存在于容器里，而是被注册进去的
2. Servlet / Filter / Listener 虽然职责不同，但都必须被统一纳入应用级托管
3. SCI / Initializer 是注册链的契约起点
4. Spring Boot 不是绕开 Tomcat，而是在复用并回放容器注册主线

### 当前风险
- 这些结论方向是对的，但如果没有更硬的三层锚点支撑，容易显得像“合理的架构解释”
- `Context` 作为应用级托管者这点必须再压一层方法级证据，否则会和前一篇太像概念呼应

## 第三轮：结构审

### 目标
检查结构是否遵守“困惑 -> 失败方案 -> 总图 -> 注册链拆解 -> 收网”的方法论，而不是退化成注册方式清单。

### 当前结构评价
当前结构是：
1. 困惑开场
2. 失败方案
3. 最小总图
4. 规范扩展点
5. `StandardContext` 托管层
6. Servlet / Filter / Listener 统一看待
7. Spring Boot 回放链
8. 收网总结
9. 下篇桥接

### 当前结构优点
- 没有写成 API 列表或注解清单
- 先立“组件不会自己出现”，再讲三层注册链
- 与 Ch7 / Ch17 形成很好衔接

### 当前结构风险
- `StandardContext` 与 `TomcatStarter` 两节如果后续补源码时失衡，会让中段一头重一头轻
- 若开始展开太多 Spring Bean 注册细节，容易偏成 Boot 使用教程

## 第四轮：读者审

### 目标
检查读者是否能从“组件写好了就会自己生效”切到“组件是被系统性装进 Context 的”这个视角。

### 当前读者收益
读完后，读者至少应能回答：
- 为什么组件不会自然出现在容器里
- 为什么 Servlet / Filter / Listener 要统一纳入应用托管体系
- 为什么 Boot 的注册动作不是额外封装，而是容器注册链的现实入口

### 当前读者风险
- 如果前文 Ch7 / Ch17 没读透，这篇会显得抽象
- 如果不补方法级锚点，读者会认可概念，但未必能定位到具体实现入口

## 第五轮：边界审

### 目标
检查本篇是否提前透支后续线程池专题，或是否把单个组件内部逻辑拉得太深。

### 当前边界控制
本篇明确不深讲：
- 单个组件内部执行细节
- Session / 类加载深层机制
- 生产层排障和治理

### 当前边界风险
- 如果为了说明注册体系而展开太多 `StandardWrapper` 细节，会重新吃掉 Ch9
- 如果为了说明 Boot 回放链而展开太多 Bean 后处理逻辑，会偏成 Spring 教程

## 第六轮：依赖审

### 目标
检查前置依赖与后续桥接是否清楚。

### 前置依赖
- 强依赖 Ch7（Boot 集成桥）
- 强依赖 Ch17（应用运行单元与 Context 编排中心）
- 规范层 Ch8 也提供 SCI / Initializer 的契约边界

### 后续桥接
- 当前桥接到线程池 / Executor 专题是合理的：注册链立住后，继续补“运行单元如何承压和调度”是顺的

## 机械检查

### 禁用词
当前首稿主线中未明显使用以下禁用词：
- 此处不再赘述
- 不再展开
- 类似地
- 同理
- 依此类推
- 篇幅所限
- 显然
- 容易看出
- 细节读者自行阅读源码

### 代码块角色检查
- 当前正文仍以主线解释为主
- 后续事实审时必须补三层锚点：规范层、Context 托管层、Boot 回放层

## 当前结论

这篇已经完成一次性深审收口，当前主问题已从“结构是否成立”收敛为“注册链三层证据是否够硬”。本轮补强后，这个缺口已经被明显压实：
- 规范层：`ServletContainerInitializer.onStartup(...)`
- Context 托管层：`applicationEventListenersList` / `applicationLifecycleListenersObjects` / `initializers` / `listenerStart()` / `filterStart()`
- Boot 回放层：`ServletContextInitializerBeans` + `TomcatStarter.onStartup(...)`

### 本轮收口修订记录
- 已把“规范扩展点 -> Context 托管 -> Boot 回放链”三层都补上了明确锚点
- 现在这篇不再只是概念上把前文拼起来，而是能直接落到注册链的具体结构位置

## 建议的下一步

1. 以当前稿为准收口 Ch18-01
2. 进入线程池 / Executor 专题
3. 继续延续一次性深审方式
