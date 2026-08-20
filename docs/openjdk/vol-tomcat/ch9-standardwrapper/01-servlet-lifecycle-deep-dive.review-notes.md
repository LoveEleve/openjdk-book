# Tomcat Ch9-01 StandardWrapper 生命周期深挖 — review notes

## 第一轮：事实审

### 目标
核对：
- 类名、路径、角色归属是否准确
- `file:line` 引用是否真实存在
- 是否把方法名和生命周期语义混写成未验证结论

### 当前需核对的关键锚点
- `org/apache/catalina/core/StandardWrapper.java`
- `org/apache/catalina/core/StandardWrapperValve.java`
- `jakarta/servlet/Servlet.java`
- 如正文涉及门面层，再补 `StandardWrapperFacade`

### 初步判断
- 当前主线与 Ch9 规划一致：`load / init / allocate / deallocate / unload / unavailable`
- `StandardWrapper` 被正确定位为实例管理中心，而不是末端配置节点
- 这篇没有把 Filter / Session / async/error 重新拉成主线，边界控制目前是对的

## 第二轮：因果审

### 目标
检查正文里所有“为什么要拆这么多方法 / 为什么 `StandardWrapper` 是中心”这类判断，是否真的由源码与前置契约支撑。

### 当前因果链
1. Servlet 规范只给外部生命周期语义，不给 Tomcat 内部实现路径
2. `StandardWrapper` 不是被动节点，而是 Servlet 实例生命史的管理中心
3. `loadServlet()`、`initServlet()`、`allocate()` 回答的是不同层次问题
4. `deallocate()`、`unload()`、unavailable 共同组成退出与故障分支

### 当前风险
- 目前正文里对 `StandardWrapper` 的定位在结构上合理，但还需要方法级锚点来压实，不然容易停留在“概念上很像”
- `allocate()` 作为“生命周期和请求执行链交界点”的说法非常关键，后续事实审必须特别核实

## 第三轮：结构审

### 目标
检查结构是否遵守“困惑 -> 失败方案 -> 总图 -> 分层拆解 -> 收网”的方法论，而不是退化成 `StandardWrapper` 方法罗列。

### 当前结构评价
当前结构是：
1. 困惑开场
2. 失败方案
3. 最小总图
4. `StandardWrapper`
5. `loadServlet()`
6. `initServlet()`
7. `allocate()`
8. `deallocate()/unload()/unavailable`
9. 收网总结
10. 下篇桥接

### 当前结构优点
- 没有退化成“方法列表说明书”
- 先立“实例生命史”总概念，再讲方法分工
- `allocate()` 被提成关键交界点，而不是淹没在生命周期杂项里

### 当前结构风险
- 如果后续补源码时把 `loadServlet()` 和 `initServlet()` 都展开太多，容易让篇幅在中段膨胀失衡
- `deallocate()/unload()/unavailable` 这一节如果证据不足，可能会看起来像人为并列，而不是同一条退出/故障链

## 第四轮：读者审

### 目标
检查第一次从“主干执行链”转入“Servlet 实例生命史”的读者是否能跟住，而不是觉得只是换了几个方法名。

### 当前读者收益
读完后，读者至少应能回答：
- 为什么 `init -> service -> destroy` 只够描述契约结果，不够描述容器内部控制流程
- 为什么 `StandardWrapper` 不只是配置节点
- 为什么 `allocate()` 是与请求执行链接触的关键点
- 为什么 unavailable 不能被当成附属状态

### 当前读者风险
- 如果没有更硬的源码锚点，读者会理解这套生命史的抽象，但不一定能真正信服“Tomcat 源码就是这样组织的”
- `deallocate()` 与 `unload()` 的边界若后续不压实，第一次阅读的人仍可能觉得它们差不多

## 第五轮：边界审

### 目标
检查本篇是否提前透支后续主题，或是否漏掉本篇必须收住的边界。

### 当前边界控制
本篇明确不深讲：
- Filter 链内部机制
- Mapper 细节
- Session 生命周期
- async/error 反向控制流
- ClassLoader 隔离细节

### 当前边界风险
- 如果为了讲实例创建而过早引入太多类加载细节，会提前吃掉后面的 ClassLoader 专题
- 如果为了讲 unavailable 而展开太多错误处理细节，也会把 async/error 那条线重新拉回来

## 第六轮：依赖审

### 目标
检查前置依赖与后续桥接是否清楚。

### 前置依赖
- 依赖 Ch3-01 已立住 `StandardWrapperValve -> FilterChain -> Servlet` 的执行边界
- 依赖 Ch8-01 已立住“生命周期契约 vs Tomcat 实现”的规范边界

### 后续桥接
- 当前桥接到 `WebappClassLoaderBase` 与应用隔离是合理的：因为实例创建/持有/卸载与类加载隔离天然相邻

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
- 当前正文几乎没有大段代码块，主线以机制解释为主
- 后续事实审时要确保方法级锚点足够硬，避免这篇变成“概念性补深”而不是“源码补深”

## 当前结论

这篇已经完成一次性深审收口，当前主问题已从“结构是否成立”收敛为“方法级硬锚点是否足够”。本轮收口后，这个缺口已经基本补上：
- `StandardWrapper` 类定义：`StandardWrapper.java:80`
- `allocate()`：`StandardWrapper.java:558`
- `deallocate()`：`StandardWrapper.java:606`
- `loadServlet()`：`StandardWrapper.java:735`
- `initServlet()`：`StandardWrapper.java:816`
- `unavailable()`：`StandardWrapper.java:902`
- `unload()`：`StandardWrapper.java:920`

### 本轮收口修订记录
- 已把正文里原先较松的文件级锚点全部压到方法级
- 现在“实例准备 / 契约兑现 / 请求分配 / 退出与故障”四段都已有对应方法支撑
- `StandardWrapper` 的“实例管理中心”定位因此不再只是概念判断，而有了完整方法链托底

## 建议的下一步

1. 以当前稿为准收口 Ch9-01
2. 进入 `WebappClassLoaderBase` 与应用隔离专题
3. 继续延续一次性深审方式
