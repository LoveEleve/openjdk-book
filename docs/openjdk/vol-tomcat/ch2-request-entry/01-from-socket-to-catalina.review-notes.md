# Tomcat Ch2-01 请求进入闭环 — review notes

## 第一轮：事实审

### 目标
核对：
- 类名、路径、角色归属是否准确
- `file:line` 引用是否真实存在
- 代码块是否来自真实源码，而不是凭记忆改写

### 当前需核对的关键锚点
- `org/apache/catalina/connector/Connector.java:999`
- `org/apache/catalina/connector/Connector.java:1000`
- `org/apache/tomcat/util/net/NioEndpoint.java:71`
- `org/apache/coyote/http11/Http11Processor.java:70`
- `org/apache/catalina/connector/CoyoteAdapter.java:64`
- `org/apache/catalina/core/StandardWrapperValve.java:141`
- `org/apache/catalina/core/ApplicationFilterFactory.java:57`

### 初步判断
- 当前主线与 T-2 规划一致：`Connector / Endpoint / Processor / Adapter`
- `CoyoteAdapter` 被正确定位为跨层边界，而不是普通小工具类
- 正文目前还没有大段展开 `Mapper/Pipeline/FilterChain` 内部细节，边界意识是对的

## 第二轮：因果审

### 目标
检查正文中所有“所以/说明/意味着”是否由源码支撑，而不是作者脑补。

### 当前因果链
1. `Connector` 只是门面入口，而不是整条运行时主线
2. `NioEndpoint` 更靠近连接接收与事件入口
3. `Http11Processor` 已经进入协议处理，但还没有进入 Catalina 容器执行
4. `CoyoteAdapter` 是请求从 Coyote 世界切进 Catalina 世界的边界

### 当前风险
- 以上判断在机制上都合理，但写作时必须补足真实源码锚点，尤其是 `NioEndpoint` 与 `Http11Processor` 的职责边界，不能只靠类名和常识讲
- “请求终于进了门”这类比喻是允许的，但要确保前文已有足够源码支撑

## 第三轮：结构审

### 目标
检查结构是否遵守“困惑 -> 失败方案 -> 总图 -> 分层拆解 -> 收网”的方法论，而不是被源码顺序牵着走。

### 当前结构评价
当前结构是：
1. 困惑开场
2. 失败方案
3. 最小总图
4. `Connector`
5. `NioEndpoint`
6. `Http11Processor`
7. `CoyoteAdapter`
8. 收网总结
9. 下篇桥接

### 当前结构优点
- 没有按源码文件顺序硬翻译
- 把 `CoyoteAdapter` 明确立成后半篇的关键桥接角色
- 提前控制了与 `Mapper/Pipeline/FilterChain` 的边界

### 当前结构风险
- `Connector`、`NioEndpoint`、`Http11Processor` 三节如果后续精修时篇幅失衡，容易让 `CoyoteAdapter` 的关键性被稀释
- 若没有补充一个更清晰的“Coyote -> Catalina”边界提示，读者可能在 `Processor` 与 `Adapter` 之间仍觉得跳跃

## 第四轮：读者审

### 目标
检查第一次接触 Tomcat 请求链的读者是否能跟住，而不是只看到一串类名。

### 当前读者收益
读完后，读者至少应能回答：
- 为什么“Tomcat 收到请求”这句话不够
- 为什么不能把整条链压成一个 `Connector` 章节
- 为什么 `CoyoteAdapter` 是最不能跳过的边界点
- 为什么本篇收在“进入 Catalina 的门口”而不是直接跳到 Servlet

### 当前读者风险
- `ProtocolHandler / Endpoint / Processor / Adapter / Catalina` 这五层抽象，对第一次看请求主线的读者仍有一定密度
- 如果没有在事实审后继续补几处更硬的源码证据，读者会感觉这里“像是对的”，但抓不住具体支点

## 第五轮：边界审

### 目标
检查本篇是否提前透支后续主题，或是否漏掉本篇必须收住的边界。

### 当前边界控制
本篇明确不深讲：
- `Mapper` 四级匹配
- `Pipeline-Valve` 传播细节
- `FilterChain` 内部装配细节
- `Servlet.service()` 之后的执行
- async / timeout / error 的完整状态机

### 当前边界风险
- 如果后续补源码时顺手把 `StandardWrapperValve`、`ApplicationFilterFactory` 展开太深，就会提前吃掉 T-3
- 如果引入 `TestAsync` 之类测试证据时不加节制，又可能过早透支 T-4

## 第六轮：依赖审

### 目标
检查前置依赖与后续桥接是否清楚。

### 前置依赖
- 依赖 Ch1-01 已立住“配置树 -> 运行时系统”的总装配闭环
- 不依赖 T-3/T-4 已完成，只把它们作为后续导航

### 后续桥接
- 已自然桥接到 T-3：`Mapper + Valve + FilterChain + Servlet`
- 没有把 T-4 async/error 提前写成主线

### 风险
- 如果 Ch2-02 不紧接着写容器执行闭环，而去写别的专题，会削弱本篇收尾的自然过渡

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
- 当前代码块数量不多，且都用于证明前文判断
- 仍需在事实审阶段逐字核实，避免把规划期锚点直接搬进正文

## 当前结论

这篇已经完成一次性深审收口，当前主问题已从“结构是否成立”收敛为“证据表达是否足够稳”。本轮收口重点修了三件事：
- 收紧了 `NioEndpoint` 的职责表述，避免把类定义锚点写成过强的实现断言
- 把“请求终于进了 Catalina 的门”改成更精确的“完成协议层到容器层的跨层切换”
- 补出了 `ApplicationFilterFactory.createFilterChain(...)` 在后续容器执行主线中的角色提示，使正文里引用过的证据点与下篇桥接更一致

当前判断：
- `Connector / Endpoint / Processor / Adapter` 主线已经立住
- `CoyoteAdapter` 作为跨层边界已经足够突出
- 这篇可以视作可收口状态

## 建议的下一步

1. 以当前稿为准收口 Ch2-01
2. 进入 T-3 容器执行闭环的 `rewrite-plan`
3. 延续一次性深审，而不是回到分轮停顿模式
