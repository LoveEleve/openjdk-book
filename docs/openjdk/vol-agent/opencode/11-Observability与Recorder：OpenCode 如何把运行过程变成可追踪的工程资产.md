# Observability 与 Recorder：OpenCode 如何把运行过程变成可追踪的工程资产

> 项目：OpenCode (`v1.18.18` 基线)
> 角色：主线机制正文 10
> 对应范围规划：`01-OpenCode源码学习范围规划.md`
> 依据材料：`Agent/analysis/opencode/01-闭环笔记/q31-observability.md`

---

## 零、阅读前提示

- 建议先读：
  1. `00-OpenCode主线总图.md`
  2. `03-Agent源码前置认知桥.md`
  3. `03-SessionRunner与SessionExecution...`
  4. `07-SessionProjector与History...`
  5. `10-SessionFacade与Snapshot...`
- 推荐源码阅读路径：
  1. `packages/core/src/observability/shared.ts`
  2. `packages/core/src/observability/logging.ts`
  3. `packages/core/src/observability/otlp.ts`
  4. `packages/http-recorder/src/cassette.ts`
  5. `packages/http-recorder/src/redaction.ts`

## 一、这一章真正的问题

一个复杂 Agent 系统，如果只能“跑”，但不能：
- 追踪一次运行到底做了什么
- 把日志和 trace 关联起来
- 把对外 HTTP / WebSocket 交互录下来复盘
- 在测试里安全地回放这些流量

那它就很难进入工程化稳定阶段。

所以这一章真正的问题是：

> **OpenCode 如何把 Agent 的运行过程，从一次次临时执行，提升成可追踪、可诊断、可复盘、可安全录制的工程资产。**

也就是说，这章不是在讲“日志怎么打印”，而是在讲：
- 运行关联键怎么统一
- logs 和 traces 怎么贯通
- 录制与回放怎么防泄漏
- 为什么 observability 不是附属功能，而是系统持续演进的前提

---

## 二、先给结论：可观测性在 OpenCode 里不是日志模块，而是运行控制面的延伸

最容易犯的错，是把 observability 看成：
- 打日志
- 接个 OTLP
- 录个 HTTP cassette

这样理解太浅。

OpenCode 真正做的是把可观测性拆成三层：

1. **结构化日志层**
   - 给人类和机器读
2. **OTLP 双通道层**
   - logs + traces
3. **录制与回放层**
   - HTTP / WebSocket 交互作为测试和调试资产保存

这三层合起来解决的是：

> **一次 Agent 运行，事后还能不能被定位、关联、解释、复现。**

所以 observability 在这里不是“外围运维功能”，而是：
> **长期维护 Agent 系统的内建能力。**

---

## 三、runID 为什么不是小工具，而是整套运行的关联键

OpenCode 在这里做了一个很成熟的设计：
- 为每次运行生成一个短 `runID`
- 它会进入：
  - 日志
  - OTLP resource attributes
  - service.instance.id

这件事的重要性在于：

### 1. 你不再是在看散落日志，而是在看“一次运行”
当系统复杂到：
- 有多轮 turn
- 有工具调用
- 有 trace span
- 有可能有后台任务

如果没有 runID，事后你会很难回答：
- 这条日志属于哪次运行？
- 这条 trace 和哪次用户操作相关？
- 一次失败到底跨了哪些组件？

### 2. 它让跨通道关联成为可能
- file logger
- stderr
- OTLP logs
- OTLP traces
都能被同一 runID 串起来。

所以 runID 的意义不是“日志里多一个字段”，而是：
> **把一次运行变成可统一观察的分析单位。**

---

## 四、为什么 OTLP 要做成 logs + traces 双通道

很多系统做 observability 时会先选一个偏好：
- 只打日志
- 或只做 tracing

OpenCode 没停在这一步，它明确把两者都纳进来了。

### 1. logs
适合：
- 看状态变化
- 看错误消息
- 看配置和边界决策

### 2. traces
适合：
- 看链路跨度
- 看父子调用关系
- 看一次请求/运行跨越哪些步骤

如果只有 logs：
- 你知道发生了什么
- 但不一定知道它们怎么串起来

如果只有 traces：
- 你知道链路结构
- 但不一定能看清楚每一步具体上下文

OpenCode 的选择说明：

> **Agent 系统的可观测性，不应在 logs 和 traces 之间二选一。**

而且它还额外解决了一个细点：
- Effect 本身不自动给 AI SDK 注册全局 context manager
- 但 AI SDK 需要 `AsyncLocalStorageContextManager` 来维持 span 父子关系

这件事说明什么？
说明它不是“接上 OTLP 就完了”，而是在认真处理：
> **不同运行时 / SDK 之间的 trace 连通性。**

这很工程化。

---

## 五、结构化日志为什么采用 key=value 扁平化，而不是任意对象输出

OpenCode 的日志层还有一个很值得学的点：
- 它不是“把对象 console.log 出去”
- 而是把嵌套对象 flatten 成 key=value

这看起来像格式偏好，但其实在解决一个系统级问题：

> **日志既要可读，也要可机器消费。**

如果日志只是：
- 一坨对象
- 有时嵌套
- 有时循环引用
- 有时空格乱七八糟

那后面：
- grep
- parser
- collector
- log query
- incident review
都会很难做。

所以 OpenCode 的选择体现的是：
- run-time 日志不是临时调试输出
- 而是应长期进入分析链路的结构化资产

这和前面 session message / durable event / output store 的思路是统一的：
> **所有东西都应该能稳定地被后续系统消费。**

---

## 六、HTTP Recorder 为什么是“测试安全能力”，不是小工具

这是这章里最容易被低估的点之一。

很多项目的 HTTP recorder 只是：
- 把请求和响应录下来
- 存成 fixture
- 后面回放

OpenCode 在这里明显更谨慎。

它不只录，还会在写入前做：
- secret detection
- redaction
- unsafe cassette reject

也就是说：
- 录制不是“多存一份调试样本”
- 而是“生成一份以后会长期进入测试资产库的文件”

如果这份文件里有：
- API key
- token
- cookie
- credential
- secret header

那你不是在录调试样本，而是在往仓库里写泄漏物。

所以 OpenCode 的判断非常成熟：

> **HTTP recording 不是纯调试能力，它也是安全治理能力。**

这点很值得学，因为很多项目到了后期才意识到：
- 测试资产本身也可能成为安全负债

而 OpenCode 在 recorder 层就直接防这一点。

---

## 七、为什么 WebSocket recording 也要被纳入体系

这也是一个很强的信号。

如果 recorder 只处理普通 HTTP，那说明团队还停留在“请求-响应型系统”的思维。

OpenCode 还把：
- socket
- websocket

纳进 recorder 体系，说明它的目标不是“录几个 API”，而是：

> **把真正复杂的交互通道也纳入可复盘资产。**

这对 Agent 项目特别重要，因为 Agent 未来可能越来越多地依赖：
- streaming
- event channel
- server push
- long-lived protocol connection

如果 recorder 只会录简单请求，那么在最关键的复杂交互面前就失明了。

---

## 八、这一章真正解决了哪些工程问题？

### 1. 如何把一次 Agent 运行定义成可追踪对象
OpenCode 的解法：runID 贯穿 logs / traces / instance id

### 2. 如何让 logs 与 traces 不割裂
OpenCode 的解法：OTLP 双通道 + 全局 context manager

### 3. 如何让日志既可读又可机器消费
OpenCode 的解法：扁平化 key=value 结构化日志

### 4. 如何让调试录制变成可长期保留的测试资产
OpenCode 的解法：cassette + redaction + secret detection + unsafe reject

### 5. 如何把复杂交互（WebSocket 等）也纳入可复盘链路
OpenCode 的解法：socket / websocket recorder

这一章真正教你的，不是“接了个 observability stack”，而是：

> **一个复杂 Agent 系统必须把“运行后还能解释发生了什么”当成内建设计目标。**

---

## 九、读者最容易学错的地方

### 误区 1：把 observability 看成日志模块
错。它在这里是运行控制面的延伸。

### 误区 2：以为 logs 和 traces 选一个就够了
错。对于 Agent 这种多步骤系统，两者解决的是不同问题。

### 误区 3：把 recorder 看成开发期调试工具
错。它生成的是长期测试与回放资产，所以必须有安全边界。

### 误区 4：以为 runID 只是方便 grep
错。它定义的是一次运行的统一关联键。

### 误区 5：忽略 context manager 这种“胶水层”
错。真正的 trace 可用性很多时候就死在这些连接层细节上。

---

## 十、分析边界

### 为什么这里不先讲监控平台或 UI 展示
因为这章关心的是：数据怎么被结构化地产生、关联、导出和安全录制；不是怎么在仪表盘里展示。

### 为什么这里要把 recorder 和 observability 放一起讲
因为它们在本质上都在解决同一个问题：
- 运行发生了什么
- 事后还能不能追出来
- 还能不能安全地复盘

### 为什么测试是关键证据
很多 recorder 与 observability 的价值，不在业务逻辑代码里直接喊出来，而是通过测试契约、录制样本、安全拒绝策略体现出来。

---

## 十一、读者分层路由

### beginner
先抓住：
1. runID 是一次运行的统一键
2. logs 与 traces 是两类不同但互补的观测方式
3. recorder 不是调试玩具，而是测试资产生成器

### intermediate
重点看：
- OTLP 双通道
- flatten logging
- cassette / redaction / secret detection
- websocket recorder 的系统地位

### advanced
重点看：
- AsyncLocalStorageContextManager 为什么是 trace 连通性的关键
- 为什么 observability 要从一开始就和运行时绑在一起
- 为什么 recorder 的安全约束是产品级要求，不是测试小技巧

---

## 十二、迁移清单

### 可迁移思想 1：runID 统一关联一次运行
- 可迁移到：任何多步骤 Agent / workflow 系统
- 前提：系统存在 logs / traces / tool execution / session spans 等多个观测面
- 不能照搬的点：极简一次性脚本收益有限

### 可迁移思想 2：logs + traces 双通道
- 可迁移到：所有需要链路 + 语义双重观察的系统
- 前提：系统真的跨多个阶段、多个运行层
- 不能照搬的点：纯同步小程序没必要引入这么重的 tracing 层

### 可迁移思想 3：recorder 写盘前先做 secret gate
- 可迁移到：任何会把录制结果进仓库/进测试夹具的系统
- 前提：录制产物会被长期保存
- 不能照搬的点：纯本地临时调试可能不需要这么严，但长期仍建议做

### 可迁移思想 4：复杂通道也要纳入 recorder
- 可迁移到：有 streaming / websocket / 长连接协议的系统
- 前提：系统调试和回放需要覆盖复杂交互
- 不能照搬的点：如果项目纯短请求，socket recorder 不是优先级最高

---

## 十三、自测问题

1. 为什么 runID 在 OpenCode 里不是简单日志字段，而是统一运行关联键？
2. 为什么 OpenCode 要同时做 logs 和 traces？
3. 为什么 HTTP recorder 必须先做密钥检测再落盘？
4. 为什么 WebSocket recorder 也要被纳入系统，而不是只录 HTTP？
5. 为什么 observability 在 Agent 系统里不是外围运维功能，而是控制面的一部分？

---

## 十四、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释 OpenCode 为什么要把可观测性设计成 logs / traces / recorder 三层。
2. 说清 runID 在系统里的真正作用。
3. 理解为什么 recorder 既是调试工具，也是安全边界。
4. 理解 observability 如何支撑长期运行、回放和问题定位。
5. 用自己的话说明：一个成熟 Agent 系统，为什么必须在“还能解释发生了什么”这件事上投入系统设计，而不是只顾着把功能跑通。

如果还做不到这些，就说明这章还没真正学懂。
