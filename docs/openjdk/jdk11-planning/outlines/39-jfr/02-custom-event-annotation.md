# 02. 自定义事件与注解 — 事件子类、元数据、EventFactory

> 🔴 Deep | 域 39 JFR 第 2 篇(巨型域 6 篇之二)| Layer 4
> 读者处境: 生产业务埋点——自定义事件怎么写、注解怎么用、动态事件怎么建。

### 1. "自定义事件的标准写法" — 继承 Event

场景: 埋点"订单创建耗时"——三步写法

- 继承 `Event` + 字段 + 注解:
  ```java
  @Label("订单创建")
  class OrderEvent extends Event {
      @Label("订单ID") String orderId;
      @Label("耗时ms") long durationMs;
  }
  ```
- 使用: `event.orderId = ...; event.commit();`(自动 begin/end)
- 注册: 事件类加载时 **JVM 自动检测**(Event 子类)+ `FlightRecorder.register`(133,显式注册可用于监听注册事件)/`unregister`(155)
- 关键设计 (斜体): *"事件=带注解的类"——字段即事件数据,注解即元数据;commit 后事件进入录制器(注入后才有行为,域 39 第 3 篇);面试"埋点怎么写"——继承+字段+commit 三件套*
- [关联: 域 04 注解(注解元数据模型);内部卷 32-jfr(事件类型的 native 侧注册)]
- 生产: 关键路径埋点(耗时/失败/大对象)

### 2. "注解体系" — 元数据控制

场景: @Label/@Description/@Timestamp/@Period — 各管什么?

- `jdk/jfr/Label.java:48` — 显示名(UI/文件分析用)
- `jdk/jfr/Description.java:45` — 描述
- `jdk/jfr/Timestamp.java:44` — 时间字段标注(Instant 类型)
- `jdk/jfr/Period.java:43` — 周期事件(如"每秒统计")
- 其他: @Enabled(默认开关)/@Threshold(低于阈值不记录)/@StackTrace(是否抓栈)/@Category(分组)
- 关键设计 (斜体): *"注解 = 事件的可视化/行为元数据"——分析工具据此渲染与配置;面试"JFR 注解有哪些"——Label/Timestamp/Period/Threshold/StackTrace 五类*
- 生产: 事件设计时把显示名/单位/分类写全(分析阶段友好)

### 3. "EventType 与 ValueDescriptor" — 元数据模型

场景: 事件类怎么被描述成"可配置的"?

- `EventType` — **事件类型元数据**(名称/设置/字段列表)——每个事件类一个
- `ValueDescriptor` — 字段描述(名称/类型/注解)
- `AnnotationElement` — 注解的元数据表示
- 关系: 事件类 → EventType(含 ValueDescriptor[] + 注解)
- 关键设计 (斜体): *"EventType = 事件的 Schema"——字段与设置的结构化描述;JFR 文件里的类型定义(消费者按 Schema 解析,域 39 第 5 篇)*
- 面试: "EventType 和 Event 关系"——类与元数据;一个事件类对应一个 EventType

### 4. "EventFactory 动态事件" — 免写类

场景: 运行时才知道事件结构——动态创建

- `EventFactory` — `create(annotations, fields)` — **运行时定义事件类型**(不必继承 Event)
- 适用: 插件化/动态埋点(结构运行时确定)
- 关键设计 (斜体): *"静态继承 vs 动态工厂"——编译期事件(类型安全)vs 运行期事件(灵活);面试"动态事件什么时候用"——结构运行时确定(规则引擎等)*
- 生产: 大部分场景静态继承;动态用于热配置埋点

---

### 核心悬念

事件类写了——**commit 之后发生了什么**?事件类的字节码被谁改写?`EventInstrumentation` 怎么用 ASM 注入?为什么注入后 commit 才"有行为"?——下一篇: 字节码增强机制。

> → [03-bytecode-instrumentation.md](03-bytecode-instrumentation.md)
