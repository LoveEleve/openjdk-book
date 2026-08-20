# Tomcat Ch5-01 Session 生命周期闭环 — review notes

## 第一轮：事实审

### 目标
核对：
- 类名、路径、角色归属是否准确
- `file:line` 引用是否真实存在
- 代码块是否来自真实源码，而不是凭记忆改写

### 当前需核对的关键锚点
- `org/apache/catalina/session/StandardSession.java:80`
- `org/apache/catalina/session/StandardManager.java:57`
- `org/apache/catalina/session/ManagerBase.java`
- `org/apache/catalina/session/FileStore.java`
- `org/apache/catalina/session/JDBCStore.java`
- `org/apache/catalina/ha/session/DeltaManager.java`
- `org/apache/catalina/ha/session/BackupManager.java`

### 初步判断
- 当前主线与 T-5 规划一致：`StandardSession -> Manager -> expire / persist / replicate`
- `StandardSession` 被正确定位为状态实体，而不是完整机制本体
- `Manager` 被正确定位为生命周期控制者，而不是简单工厂

## 第二轮：因果审

### 目标
检查正文里所有“所以/说明/意味着”是否由源码支撑，而不是靠常识补完。

### 当前因果链
1. Session 不是普通对象，而是有独立生命周期的状态载体
2. `StandardSession` 只是被管理实体，不是完整机制本身
3. `ManagerBase / StandardManager` 是生命周期控制者
4. 过期、持久化、复制是同一条生命周期在请求结束之后的延伸

### 当前风险
- 以上四条在机制上是合理的，但正式收口时仍要确认：正文不能只凭类名和常识把 `Manager` 写成过强结论，必须有实际生命周期入口/持有/扫描证据支撑
- `FileStore / JDBCStore / DeltaManager / BackupManager` 目前更多是边界性存在证明，正文要防止把它们提前写成和单机生命周期同等重的实现主线

## 第三轮：结构审

### 目标
检查结构是否遵守“困惑 -> 失败方案 -> 总图 -> 分层拆解 -> 收网”的方法论，而不是退化成 Session API/类图讲解。

### 当前结构评价
当前结构是：
1. 困惑开场
2. 失败方案
3. 最小总图
4. `StandardSession`
5. `ManagerBase / StandardManager`
6. 过期与回收
7. 持久化
8. 复制
9. 收网总结
10. 下篇桥接

### 当前结构优点
- 没有退化成“Session API 说明书”
- 先立生命史，再看实体/控制者/请求外延伸三层关系
- 把持久化与复制挂回生命周期主线，而不是当作孤立附录

### 当前结构风险
- “持久化”和“复制”如果后续补证据时展开太深，容易压缩单机生命周期主线的中心地位
- 如果 `Manager` 这一节不够硬，文章会重新滑回“Session 就是个对象”的窄理解

## 第四轮：读者审

### 目标
检查第一次接触 Tomcat Session 机制的读者是否能跟住，而不是只看到一堆类名和扩展项。

### 当前读者收益
读完后，读者至少应能回答：
- 为什么 Session 不是普通对象
- 为什么只讲 `StandardSession` 不够
- 为什么 `Manager` 才是生命周期控制者
- 为什么过期、持久化、复制属于同一条生命史在请求之外的延伸

### 当前读者风险
- `FileStore / JDBCStore / DeltaManager / BackupManager` 这几块如果证据一多，容易让第一次阅读的人觉得主题突然横向膨胀
- 如果没有足够硬的 `Manager` 支撑，读者会接受“生命周期控制者”这个说法，但记不住它到底是怎么控制的

## 第五轮：边界审

### 目标
检查本篇是否提前透支后续主题，或是否漏掉本篇必须收住的边界。

### 当前边界控制
本篇明确不深讲：
- 集群复制协议细节
- 持久化具体介质优化
- Spring Session 的外部替代实现

### 当前边界风险
- 如果后续为了补证据把 `tribes/ha` 的集群细节拉太多，本篇会从“生命周期主线篇”变成“Session 全景篇”
- 如果引 Spring Session 作为对照太早，可能把 Tomcat 本体主线稀释掉

## 第六轮：依赖审

### 目标
检查前置依赖与后续桥接是否清楚。

### 前置依赖
- 依赖 Ch3-01 已立住请求执行主线
- 依赖 Ch4-01 已立住偏离正常路径后的重新收束链

### 后续桥接
- 当前稿件已把持久化与复制挂回 Session 生命周期主线
- 桥接到 T-6 Mapper 专题是可行的，但也要注意：从主题连续性上，继续补 Session 持久化/复制专题其实更直接

### 风险
- 当前篇末桥接到 T-6，是按全卷顺序在收；但从单主题连续性上，先写 `Session 持久化/复制` 专题可能更顺

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
- 当前稿件几乎没有展开代码块，后续事实审时要特别注意：正文不能只靠抽象叙述而缺失关键源码支撑

## 当前结论

这篇已经完成一次性深审收口，当前主问题已从“结构是否成立”收敛为“证据分层是否足够清楚”。本轮收口主要修了两点：
- 把 `FileStore / JDBCStore / DeltaManager / BackupManager` 从“正文核心证据”降回“后续专题角色提示”，避免在本篇里使用没有精确行号的文件级锚点撑核心论断
- 把篇末桥接收束成“按整卷顺序先去 T-6；按单主题连续性则可继续 Session 深挖”的更清晰表达

当前判断：
- `StandardSession -> Manager -> expire / persist / replicate` 主线已经立住
- 单机生命周期主线没有再被持久化/复制喧宾夺主
- 这篇可以视作可收口状态

## 建议的下一步

1. 以当前稿为准收口 Ch5-01
2. 进入 T-6 的 `rewrite-plan`
3. 继续延续一次性深审方式
