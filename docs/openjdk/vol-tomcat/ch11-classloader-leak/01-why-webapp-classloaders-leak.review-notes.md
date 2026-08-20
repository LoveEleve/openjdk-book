# Tomcat Ch11-01 类加载器泄漏与卸载失败 — review notes

## 第一轮：事实审

### 目标
核对：
- `WebappClassLoaderBase.stop()/clearReferences()` 及其子清理方法的角色归属是否准确
- `file:line` 引用是否真实存在
- 是否把“容器尽力清理”误写成“容器保证清干净”

### 当前需核对的关键锚点
- `org/apache/catalina/loader/WebappClassLoaderBase.java:1523` (`stop()`)
- `org/apache/catalina/loader/WebappClassLoaderBase.java:1574` (`clearReferences()`)
- `org/apache/catalina/loader/WebappClassLoaderBase.java:1642` (`clearReferencesJdbc()`)
- `org/apache/catalina/loader/WebappClassLoaderBase.java:1678` (`clearReferencesThreads()`)
- `org/apache/catalina/loader/WebappClassLoaderBase.java:2081` (`clearReferencesRmiTargets()`)
- `org/apache/catalina/loader/WebappClassLoaderBase.java:2151` (`clearReferencesObjectStreamClassCaches()`)
- 与 `clearReferencesThreadLocals` 相关字段/方法锚点

### 初步判断
- 当前主线与 Ch11 规划一致：`class space -> residual references -> stop()/clearReferences()`
- 没有把类加载器泄漏简化成“只是 ThreadLocal 问题”
- 也没有把 `clearReferences()` 写成万能开关，这一点目前是对的

## 第二轮：因果审

### 目标
检查正文里所有“为什么退场失败 / 为什么容器要主动清理 / 为什么清理仍然有限”这些判断，是否由源码结构支撑，而不是靠常识硬推。

### 当前因果链
1. 应用停了不等于类空间就能退出
2. 类空间退不出去，本质是因为残留引用链还在
3. `WebappClassLoaderBase.stop()/clearReferences()` 说明 Tomcat 会主动进入清理流程
4. 线程、JDBC、缓存、RMI targets 等都是不同方向上的残留源
5. Tomcat 可以尽力清理，但不可能完全替应用兜底

### 当前风险
- 当前正文已经把“万能兜底”这个误解压住了，但后续事实审仍要确保：每个清理源的描述都不要超过源码实际暴露出来的程度
- `modified()` 被引入为“重载入口”，这在结构上合理，但正式收口时要防止它被写成“重载和泄漏完全同一件事”

## 第三轮：结构审

### 目标
检查结构是否遵守“困惑 -> 失败方案 -> 总图 -> 分层拆解 -> 收网”的方法论，而不是退化成泄漏症状罗列。

### 当前结构评价
当前结构是：
1. 困惑开场
2. 失败方案
3. 最小总图
4. `stop()`
5. `clearReferences()`
6. JDBC / 线程 / 缓存 / RMI targets
7. `modified()` 与重载
8. 容器兜底边界
9. 收网总结
10. 下篇桥接

### 当前结构优点
- 没有退化成“泄漏原因清单”
- 先讲为什么退场失败，再讲容器清理动作
- 把“重载”和“泄漏”挂在同一条类空间退场主线上，结构上是通的

### 当前结构风险
- JDBC / 线程 / 缓存 / RMI targets 这一节如果后续再补太多细节，容易变成碎片化并列
- `modified()` 这一节需要继续控制篇幅，避免把重载主线写得比清理主线还重

## 第四轮：读者审

### 目标
检查第一次接触 Tomcat 类加载器泄漏问题的读者是否能真正理解“应用停了 != 类空间退场”这个核心结论。

### 当前读者收益
读完后，读者至少应能回答：
- 为什么请求不来了，类空间仍可能退不掉
- 为什么类加载器泄漏本质上是引用链没断
- 为什么 Tomcat 要主动清理 JDBC/线程/缓存/RMI targets
- 为什么 `clearReferences()` 不是万能橡皮擦

### 当前读者风险
- 当前正文已经比较稳，但如果后续精修时把清理源越讲越多，读者会重新失去主线
- `modified()` 如果处理不好，也会让第一次阅读的人误以为这篇在讲“热部署功能”，而不是讲“退场失败”

## 第五轮：边界审

### 目标
检查本篇是否提前透支后续主题，或是否漏掉本篇必须收住的边界。

### 当前边界控制
本篇明确不深讲：
- 生产排障具体命令与案例
- JVM 类卸载全景
- Spring Boot Loader 细节

### 当前边界风险
- 如果为了说明泄漏而展开太多 MAT / jcmd / arthas 等工具细节，会吃掉生产排障专题
- 如果为了说明清理源而展开太多第三方框架案例，也会把本篇写偏成“泄漏大全”

## 第六轮：依赖审

### 目标
检查前置依赖与后续桥接是否清楚。

### 前置依赖
- 依赖 Ch10 已立住“应用自己的类世界”这个概念
- 依赖 Ch9 已立住 Servlet 实例生命史，这样才容易看清实例与类空间为什么一起退不掉

### 后续桥接
- 当前桥接到生产层是合理的：因为类加载器泄漏是最典型的“主干机制 -> 生产故障表现”连接点之一

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
- 当前正文没有堆代码块，主线以机制解释为主
- 后续事实审时仍需确保“多种清理源”有足够硬的源码托底，不要变成经验判断

## 当前结论

这篇已经完成一次性深审收口，当前主问题已从“结构是否成立”收敛为“清理源表述是否足够贴源码”。本轮补强后，这一点也被进一步压实：
- `clearReferencesThreadLocals` 字段与 `checkThreadLocalsForLeaks()` 调用都已补进正文
- 现在“ThreadLocal 是高风险源头之一，但不是全部”这条判断，不再只是常识性总结，而有了更硬的源码托底

当前判断：
- `stop() -> clearReferences() -> 多源清理 -> 容器兜底边界` 主线已经立住
- 正文没有滑成“Tomcat 清理功能列表”
- 这篇可以视作可收口状态

## 建议的下一步

1. 以当前稿为准收口 Ch11-01
2. 正式转入生产层专题
3. 继续延续一次性深审方式
