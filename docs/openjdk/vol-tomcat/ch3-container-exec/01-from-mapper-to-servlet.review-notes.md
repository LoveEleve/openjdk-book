# Tomcat Ch3-01 容器执行闭环 — review notes

## 第一轮：事实审

### 目标
核对：
- 类名、路径、角色归属是否准确
- `file:line` 引用是否真实存在
- 代码块是否来自真实源码，而不是凭记忆改写

### 当前需核对的关键锚点
- `org/apache/catalina/mapper/Mapper.java:47`
- `org/apache/catalina/mapper/MapperListener.java:47`
- `org/apache/catalina/core/StandardEngineValve.java:35`
- `org/apache/catalina/core/StandardHostValve.java:50`
- `org/apache/catalina/core/StandardContextValve.java:40`
- `org/apache/catalina/core/StandardWrapperValve.java:50`
- `org/apache/catalina/core/StandardWrapperValve.java:141`
- `org/apache/catalina/core/StandardWrapperValve.java:155`
- `org/apache/catalina/core/ApplicationFilterFactory.java:57`
- `org/apache/catalina/core/ApplicationFilterChain.java:46`

### 初步判断
- 当前主线与 T-3 规划一致：`Mapper -> Valve -> FilterChain -> Servlet`
- `StandardWrapperValve` 被正确定位为容器链与执行链的边界点
- `ApplicationFilterFactory` / `ApplicationFilterChain` 没被降级成附属细节，这是对的

## 第二轮：因果审

### 目标
检查正文里所有“所以/说明/意味着”是否由源码支撑，而不是靠常识补完。

### 当前因果链
1. `Mapper` 是容器执行闭环入口，而不是普通工具类
2. 四层 `Valve` 不是重复套壳，而是逐层收束执行上下文
3. `StandardWrapperValve` 不是最终执行点，而是容器链与执行末端链的边界
4. `ApplicationFilterChain` 不是附属实现，而是执行末端真正成型的地方

### 当前风险
- `Mapper` 这一节目前更多是位置判断，还需要后续事实审确认正文是否已经用足够的源码锚点支撑“入口”这个定位
- “四层 Valve 逐层收束执行上下文”这一抽象是合理的，但正式收口时要持续保持“从当前实现归纳出”的语气

## 第三轮：结构审

### 目标
检查结构是否遵守“困惑 -> 失败方案 -> 总图 -> 分层拆解 -> 收网”的方法论，而不是被源码目录顺序牵着走。

### 当前结构评价
当前结构是：
1. 困惑开场
2. 失败方案
3. 最小总图
4. `Mapper`
5. 四层 `Valve` 链
6. `StandardWrapperValve`
7. `ApplicationFilterFactory / ApplicationFilterChain`
8. 收网总结
9. 下篇桥接

### 当前结构优点
- 没有被 `StandardEngineValve -> StandardHostValve -> StandardContextValve -> StandardWrapperValve` 的源码顺序牵着走
- 先把执行主线拆成“路由入口 / 容器收束 / 执行末端”三段，再展开类和方法
- `StandardWrapperValve` 被单独拎出来，结构上已经承认它是边界点，而不是单纯第四层 Valve

### 当前结构风险
- 如果后续事实审时补了太多 `Mapper` 细节，可能会提前透支 T-6 路由专题
- 如果 `ApplicationFilterChain` 一节展开过深，又可能吞掉后续更细的 Filter 机制专题

## 第四轮：读者审

### 目标
检查第一次接触 Catalina 执行主线的读者是否能跟住，而不是只对层层类名有印象。

### 当前读者收益
读完后，读者至少应能回答：
- 为什么请求进入 Catalina 后不能直接调 Servlet
- 为什么 `Mapper` 是执行主线第一跳
- 为什么四层 `Valve` 不能一句“责任链模式”带过
- 为什么 `StandardWrapperValve` 还不是最后一站
- 为什么 `ApplicationFilterChain` 必须独立看待

### 当前读者风险
- `Engine/Host/Context/Wrapper` 四层收束关系，对第一次接触 Tomcat 的读者仍然可能显得密集
- `Mapper -> Valve -> FilterChain -> Servlet` 虽然已经拆开，但 `Mapper` 与 `Valve` 的边界如果证据不够硬，读者还是可能觉得这只是作者主观切分

## 第五轮：边界审

### 目标
检查本篇是否提前透支后续主题，或是否漏掉本篇必须收住的边界。

### 当前边界控制
本篇明确不深讲：
- Mapper 四级匹配算法细节
- MapperListener 动态更新机制
- async / timeout / error 的完整控制流
- Session 生命周期和持久化

### 当前边界风险
- 如果后续补异常/async 例子时不克制，就会提前吃掉 T-4
- 如果补太多 Mapper 结构细节，又会吃掉 T-6

## 第六轮：依赖审

### 目标
检查前置依赖与后续桥接是否清楚。

### 前置依赖
- 依赖 Ch1-01 已立住总体装配闭环
- 依赖 Ch2-01 已讲清“请求如何进入 Catalina”

### 后续桥接
- 目前桥接到 T-4（async/timeout/error）是合理的
- 但也要注意：若后续全书结构更强调先把主线正常路径写完，再统一处理失败路径，也可以考虑先写更细的容器执行补篇

### 风险
- 若下一篇不接 T-4，而跳去 T-5 或 T-6，会削弱本篇“正向执行主线之后接反向控制流”的自然过渡

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
- 当前代码块数量少，且都服务于前文判断
- 后续事实审时仍需逐字与源码核实，尤其是 `StandardWrapperValve` 和 `ApplicationFilterFactory` 那两段

## 当前结论

这篇已经完成一次性深审收口，当前主问题已从“结构是否成立”收敛为“表达是否足够稳”。本轮收口主要修了三点：
- 修正了篇首一句里的病句表达（`Servlet.service()` 前后 → 直接到 `Servlet.service()`）
- 收紧了 `Mapper` 的定位，避免仅凭类定义锚点把它写成过强断言，改为“执行闭环入口侧的第一个关键角色”
- 放松了下一篇桥接的口吻，把 `T-4` 表述成“最自然的继续点之一”，避免过度预设唯一顺序

当前判断：
- `Mapper -> Valve -> FilterChain -> Servlet` 主线已经立住
- `StandardWrapperValve` 作为边界点已经足够突出
- 这篇可以视作可收口状态

## 建议的下一步

1. 以当前稿为准收口 Ch3-01
2. 进入 T-4 的 `rewrite-plan`
3. 延续一次性深审方式
