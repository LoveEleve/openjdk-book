# Tomcat Ch1-01 启动与装配闭环 — review notes

## 第一轮：事实审

### 目标
核对：
- 类名、路径、角色归属是否准确
- `file:line` 引用是否真实存在
- 代码块是否来自真实源码，而不是凭记忆改写

### 已核对的关键锚点
- `org/apache/catalina/startup/Tomcat.java:435`
- `org/apache/catalina/core/StandardService.java:97`
- `org/apache/catalina/core/StandardService.java:103`
- `org/apache/catalina/core/StandardService.java:151`
- `org/apache/catalina/connector/Connector.java:999`
- `org/apache/catalina/connector/Connector.java:1000`
- `org/apache/catalina/core/StandardEngine.java:62`
- `org/apache/catalina/core/StandardHost.java:69`
- `org/apache/catalina/core/StandardContext.java:160`
- `org/apache/catalina/core/StandardWrapper.java:87`

### 本轮事实审修订记录
- 抓到并修正一处真实锚点错误：正文最初把 `Tomcat.start()` 的源码位置写成了 `Tomcat.java:1260`，该位置实际是 `main` 中调用 `tomcat.start()` 的地方；真实方法定义位于 `Tomcat.java:435`
- 该修正已同步到：正文、rewrite-plan、review-notes 三处

### 当前结论
- 正文主线引用的关键类、路径、行号目前已与源码逐条对上
- 启动总图中的四类角色与源码扫描结论一致
- 文中代码块目前都对应真实源码片段，没有凭记忆拼装伪代码

### 仍需二次核对的点
- 如果后续补 Spring Boot 嵌入式桥接，必须增加 Spring Boot 侧真实源码锚点，不能沿用当前文中的概括性描述

## 第二轮：因果审

### 目标
检查文中所有“因此/所以/说明/意味着”是否真的由源码支撑。

### 当前因果链核查
1. **`Tomcat.start()` 不是核心启动执行器，而是外层门面入口**
   - 依据：`Tomcat.start()` 内部回落到 `server.start()`
   - 结论成立

2. **`StandardService` 是装配汇合点，而不只是容器持有者**
   - 依据：同时持有 `Engine`、`Mapper`、`MapperListener`
   - 且在运行态切换 Engine 时显式 stop/start `MapperListener`
   - 结论成立

3. **`Connector.initInternal()` 是协议层与容器层打通的关键焊点**
   - 依据：`adapter = new CoyoteAdapter(this)` + `protocolHandler.setAdapter(adapter)`
   - 结论成立

4. **启动不是静态组树，而是运行态接线**
   - 依据：`MapperListener` 重启、Adapter 延迟挂接
   - 结论成立，但这是解释性抽象，最终稿要避免写得像作者设计意图；应持续用“这说明/从这里可见”而不是“Tomcat 就是为了……”这类意图化句式

### 当前因果风险
- “启动真正完成的标志”这一节是很好的总结，但要注意这是本文抽象出的判断标准，不是源码原注释里给出的术语。正式稿应保持“可从源码归纳出”而不是“官方定义如此”的口吻。

### 本轮因果审修订记录
- 已把几处容易滑向“作者意图推断”的句子收紧为“从当前源码看/可归纳出”的表达
- 重点修订了以下类型：
  - `本质上就是...` → `看起来更像...`
  - `这两个世界之间必须有桥` → `从当前实现看，这两个世界之间需要一个桥接层`
  - `系统才真正具备...能力` → `协议处理链有了明确的下游去处`
  - `特别适合被看作...` → `从本文分析视角看，很适合作为...来理解`
  - `真正跨过分界线` → `我们才有充分理由把它理解为跨过分界线`

## 第三轮：结构审

### 目标
检查正文是否仍被源码文件顺序牵着走，或是否存在前向引用打断主线。

### 当前结构评价
当前结构是：
1. 困惑开场
2. 失败方案
3. 四类角色总图
4. 三个关键接线点
5. 启动完成后系统新增的四种能力
6. 结论与下篇桥接

这个结构基本符合方法论要求，没有退化成按 `Tomcat.java -> StandardService -> Connector.java` 的源码顺序翻译。

### 当前结构优点
- 先建立问题，再让源码出场
- 先讲“为什么不够”，再讲“真实接线点”
- 代码块只承接前文判断，不承担文章骨架

### 当前结构风险
- `StandardService` 一节目前比 `Tomcat.start()` 和 `Connector.initInternal()` 都更重，这是合理的，但正式稿要控制篇幅，避免让读者误以为 `StandardService` 就是整个启动主线的全部
- `MapperListener` 当前是“启动期必须出现的桥接角色”，这个定位是对的；但如果展开过多，会提前透支后文的路由专题

### 本轮结构审修订记录
- 已把章节顺序从“Tomcat.start -> StandardService -> Connector.initInternal -> MapperListener”调整为：
  - `Tomcat.start()` 外层入口
  - `Connector.initInternal()` 协议入口接线
  - `StandardService` 作为运行时汇合点
  - `MapperListener` 为什么不能完全后移
- 调整后，主线从“外层启动入口”更自然地下沉到“请求入口接线”，再回到“谁把容器树、请求入口和路由同步组织到一起”，结构更顺
- 同时削弱了 `StandardService` 一节对全文的压迫感，避免它提前吞掉 Connector/Mapper 的角色边界

## 第四轮：读者审

### 目标
检查不熟源码的读者是否能跟住主线，而不是只对类名有印象。

### 当前读者收益
读完后，读者至少应该能回答：
- 为什么只有容器树还不够
- 为什么 Connector 不是附属对象
- 为什么 `CoyoteAdapter` 是桥接角色
- 为什么 `MapperListener` 必须出现在启动篇里
- 为什么 Tomcat 启动要理解成“配置树 -> 运行时系统”的转变

### 当前读者风险
- `Server / Service / Engine / Host / Context / Wrapper` 六层角色，对新读者仍然有信息密度压力
- 正文现在是“启动闭环篇”，但对 `Host/Context/Wrapper` 只点到为止；这没问题，但要在篇首/篇尾持续提醒：这些细节会在请求主线篇展开

### 本轮读者审修订记录
- 已在两张总图之间补了一段“第一次看不用急着记全类名”的缓冲说明，明确区分：
  - 第一张图 = 静态装配
  - 第二张图 = 运行时流动
- 已把“容器树”一节改成“先记两层关系，再展开完整六层角色”，降低第一次阅读的类名密度
- 这轮修订的目标不是减少信息，而是控制信息第一次出现时的负担

### 删码测试预判
- 当前文章删掉三段代码后，主线仍然成立
- 说明代码目前基本在扮演证据角色，而不是骨架角色

## 第五轮：边界审

### 目标
检查本文是否把不该在本篇展开的内容带得太深，或者漏掉关键边界。

### 当前边界控制
本文明确没有深入：
- `NioEndpoint` 内部线程模型
- `Http11Processor` 协议解析细节
- `Mapper` 四级匹配细节
- `Valve / FilterChain / Servlet` 逐层执行细节
- async / timeout / error 的完整状态机

这符合“启动篇只讲装配，不深讲运行时”的要求。

### 当前边界仍需加强的点
- Spring Boot 只应作为导航式桥接，不应在本文里引入 `TomcatServletWebServerFactory` 的实现细节
- 不要把 XML 配置时代的 Tomcat 认知混入当前 Java 路径叙事
- 不要把 `Connector` 的协议实现细节提前透支到本篇

## 第六轮：依赖审

### 目标
检查前置依赖、后续桥接、跨域引用是否真实且方向正确。

### 前置依赖
- 仅要求读者知道 Tomcat 是 Servlet 容器，以及容器链几个角色名
- 不依赖后文既成事实

### 后续桥接
- 已正确桥接到 T-2 请求进入与协议处理闭环
- 也对 T-3 容器执行闭环做了导航，但没有提前透支细节

### 依赖风险
- 如果下一篇不是 T-2，而改成 T-3，会削弱本篇末尾的自然过渡
- 因此当前卷内顺序仍建议保持：T-1 -> T-2 -> T-3

## 机械检查

### 禁用词
当前稿件主线中未使用以下禁用词：
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
- 每个代码块前都有“为什么现在看它”的动机
- 每个代码块后都回答了“它证明了什么”

### 结构闭环检查
- 有困惑开场
- 有失败方案
- 有总图
- 有关键接线点
- 有收网总结
- 有下篇桥接

## 当前结论

这篇正文已经完成了一次性深审收口，并在收口过程中抓到并修复了一个真实结构问题：
- `Connector.initInternal()` 段落曾因结构调整被重复插入，导致出现两次 `## 四` 标题；现已删除重复块并恢复单一主线

当前剩余的主问题已经明显收敛为：
- 关键代码块若再做终稿级发布，仍建议逐字再核一遍
- 如果后续补 Spring Boot 侧桥接，必须新增真实源码锚点
- 当前正文已可以视作“可收口状态”，不再需要为这一篇继续无限细修

## 建议的下一步

1. 以当前稿为准收口 Ch1-01
2. 进入 `T-2 请求进入与协议处理闭环` 的 `rewrite-plan`
3. 保持同样的一次性深审方式，而不是重复分轮停顿
