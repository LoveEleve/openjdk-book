# Tomcat Ch4-01 异步、超时与错误处理闭环 — review notes

## 第一轮：事实审

### 目标
核对：
- 类名、路径、角色归属是否准确
- `file:line` 引用是否真实存在
- 代码块是否来自真实源码，而不是凭记忆改写

### 当前需核对的关键锚点
- `org/apache/coyote/AbstractProcessor.java:85`
- `org/apache/coyote/AsyncStateMachine.java:129`
- `org/apache/catalina/core/AsyncContextImpl.java:442`
- `org/apache/catalina/core/StandardWrapperValve.java:152`
- `org/apache/catalina/core/StandardWrapperValve.java:164`
- `org/apache/catalina/core/StandardHostValve.java:231`
- `org/apache/catalina/valves/ErrorReportValve.java:61`

### 初步判断
- 当前主线与 T-4 规划一致：`Processor 状态机 -> 容器协调 -> HostValve/ErrorReportValve`
- `AsyncStateMachine` 被正确立成状态核心，而不是 Servlet API 的附属细节
- `ErrorReportValve` 被正确定位为失败路径末端执行角色，而不是外围装饰物

## 第二轮：因果审

### 目标
检查正文里所有“所以/说明/意味着”是否由源码支撑，而不是靠抽象常识硬推。

### 当前因果链
1. async 不是 Servlet API 的薄封装，而会深入 `Processor` 状态机
2. `AsyncContextImpl` 不是纯 API 包装对象，而承担容器侧协调职责
3. `StandardWrapperValve` 在 async dispatching 分支里重新成为关键边界点
4. `StandardHostValve.throwable(...)` 说明异常会重新回到更外层容器语义中处理
5. `ErrorReportValve` 是失败路径的输出末端角色之一

### 当前风险
- 当前正文对 `AsyncStateMachine` 的状态中心定位是合理的，但正式收口时仍要确保至少有足够具体的源码锚点支撑，不要只靠 `AbstractProcessor` 构造里 new 了它就下过重结论
- `AsyncContextImpl` 一节目前是高层定位，后续深审时要确认有没有把它写成“协调中心”而缺少更实的支撑

## 第三轮：结构审

### 目标
检查结构是否遵守“困惑 -> 失败方案 -> 总图 -> 分层拆解 -> 收网”的方法论，而不是把 async/error 写成 API 杂糅笔记。

### 当前结构评价
当前结构是：
1. 困惑开场
2. 失败方案
3. 最小总图
4. `AsyncStateMachine`
5. `AsyncContextImpl`
6. `StandardWrapperValve`
7. `StandardHostValve.throwable(...)`
8. `ErrorReportValve`
9. 收网总结
10. 下篇桥接

### 当前结构优点
- 没有被源码目录顺序牵着走
- 先立“偏离路径重新收束链”总图，再拆类
- `StandardHostValve` 和 `ErrorReportValve` 被纳入同一失败路径，而不是散着提

### 当前结构风险
- `AsyncStateMachine` 与 `AsyncContextImpl` 两节如果后续精修时都写得太重，可能会让后半段 `HostValve/ErrorReportValve` 的收束价值被压住
- 若后续补太多 async/timeout 细枝末节，容易把这一篇拉成状态机细节大全，而偏离“闭环”主线

## 第四轮：读者审

### 目标
检查第一次接触 Tomcat async/error 路径的读者是否能跟住，而不是只看到一堆异常出口类。

### 当前读者收益
读完后，读者至少应能回答：
- 为什么正常执行主线讲完还不够
- 为什么 async 不是“换个线程继续跑”这么简单
- 为什么异常出口会重新回到 HostValve 和 ErrorReportValve
- 为什么 Tomcat 的请求主线不只一条正向执行链

### 当前读者风险
- `Processor 状态机 -> 容器协调 -> 兜底输出` 这三层虽然已经拆开，但如果事实支撑不够硬，读者仍可能觉得是作者自己整理的逻辑分层
- 若正文里 `timeout / complete / onError` 这些词出现太快太密，也会让第一次阅读的人感觉节奏变快

## 第五轮：边界审

### 目标
检查本篇是否提前透支后续主题，或是否漏掉本篇必须收住的边界。

### 当前边界控制
本篇明确不深讲：
- Session 生命周期
- Mapper 路由树算法
- Valve 链正常路径细节
- WebSocket / HTTP2 专项异步模型

### 当前边界风险
- 如果后续补 `TestAsync` 细节时太深，可能会把 HTTP/2 专项语义提前带进来
- 如果为了讲错误出口而展开太多错误页匹配/错误页策略细节，也会吞掉更细的错误页专题空间

## 第六轮：依赖审

### 目标
检查前置依赖与后续桥接是否清楚。

### 前置依赖
- 依赖 Ch2-01 已立住请求进入 Catalina 的边界
- 依赖 Ch3-01 已立住 Catalina 的正向执行闭环

### 后续桥接
- 当前稿件已把“正向执行链 + 偏离后重新收束链”这对结构立住
- 桥接到 T-5 Session 生命周期是成立的，因为此时请求正向/反向路径都已铺好

### 风险
- 若后续全卷结构更想继续深挖 async 状态机自身，也可以在 T-5 前插一篇 T-4 补篇；当前稿件已保留这种弹性

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
- 当前代码块数量少，且服务于前文判断
- 后续事实审时仍需逐字与源码核实，尤其是 `AsyncContextImpl` 和 `StandardWrapperValve` 的那些关键锚点

## 当前结论

这篇已经完成一次性深审收口，当前主问题已从“结构是否成立”收敛为“表达是否足够稳”。本轮收口主要修了两点：
- 收紧了 `AsyncContextImpl` 的定位，避免只凭单一锚点就把它写成过强的“协调中心”，改成“容器侧 async 协调的关键落点”
- 把 `ErrorReportValve` 的意义重新贴近源码注释，强调它是在下游 `Valve` 返回后检查错误状态并继续触发失败处理，而不只是抽象地说“稳定和可输出”

当前判断：
- `AsyncStateMachine -> AsyncContextImpl -> HostValve/ErrorReportValve` 主线已经立住
- 偏离路径的重新收束链已经足够清楚
- 这篇可以视作可收口状态

## 建议的下一步

1. 以当前稿为准收口 Ch4-01
2. 进入 T-5 的 `rewrite-plan`
3. 延续一次性深审方式
