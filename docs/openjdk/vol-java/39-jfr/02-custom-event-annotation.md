# 02. 自定义事件与注解 — 事件子类、元数据、EventFactory

> **前置依赖**: [39-jfr/01 — JFR 全景与事件模型](01-jfr-overview-event-model.md)(三物件、commit 机制)、[04-reflection-annotation/04 — 注解模型](../04-reflection-annotation/04-annotation.md)(注解元数据)
> → **后续**: [03-bytecode-instrumentation.md](03-bytecode-instrumentation.md)
> 关联: 内部卷 32-jfr(事件类型的 native 侧注册)

## 事件怎么写

上一篇讲了事件模型三物件——这一篇看业务埋点: 自定义事件怎么定义、注解各管什么、事件类怎么被描述成可配置的、以及运行期动态事件。

## 1. "自定义事件的标准写法" — 继承 Event

### 1.1 三步定义

```java
// 用法示意(API 形式,非源码片段)
@Label("订单创建")
class OrderEvent extends Event {
    @Label("订单ID") String orderId;
    @Label("耗时ms") long durationMs;
}
```

继承 `Event` + 字段 + 注解——字段即事件数据,注解即元数据。

### 1.2 使用与注册

```java
// 用法示意(API 形式,非源码片段)
OrderEvent event = new OrderEvent();
event.orderId = "A1001";
event.durationMs = 42;
event.commit();
```

- 使用: 字段赋值后 `commit()`——未调 end 时 commit 自动补 end(第 1 篇 §3)
- 注册: 事件类**无需显式注册**即可用(Event 类 Javadoc 示例直接 commit——`Event.java:57-66`);`FlightRecorder.register`(`:133`,显式注册,用于监听注册事件)/`unregister`(`:155`) 为显式管理入口;`MetadataRepository` 维护事件类镜像(`MetadataRepository.java:60`),注册链统一到内部事件类(`jdk.jfr.Event extends jdk.internal.event.Event`——`Event.java:91`)

生产: 关键路径埋点(耗时/失败/大对象)。

关键设计(斜体):*"事件=带注解的类"——字段即事件数据,注解即元数据;commit 后事件进入录制器(注入后才有行为)。面试"埋点怎么写": 继承 + 字段 + commit 三件套。*

## 2. "注解体系" — 元数据控制

### 2.1 核心注解

| 注解 | 锚点 | 作用 |
|------|------|------|
| `@Label` | `jdk/jfr/Label.java:48` | 显示名(UI/文件分析用) |
| `@Description` | `jdk/jfr/Description.java:45` | 描述 |
| `@Timestamp` | `jdk/jfr/Timestamp.java:44` | 时间字段标注(单元常量 TICKS/MILLISECONDS_SINCE_EPOCH) |
| `@Period` | `jdk/jfr/Period.java:43` | 周期事件(如"每秒统计",NAME="period" 设置) |

### 2.2 行为注解

- `@Enabled` — 默认开关
- `@Threshold` — 低于阈值不记录
- `@StackTrace` — 是否抓栈
- `@Category` — 分组

面试"JFR 注解有哪些": Label/Timestamp/Period/Threshold/StackTrace 五类。

关键设计(斜体):*"注解 = 事件的可视化/行为元数据"——分析工具据此渲染与配置。面试"JFR 注解有哪些": Label/Timestamp/Period/Threshold/StackTrace 五类;生产: 事件设计时把显示名/单位/分类写全(分析阶段友好)。*

## 3. "EventType 与 ValueDescriptor" — 元数据模型

### 3.1 结构

- **EventType** — 事件类型元数据(名称/字段列表/设置)——**每个事件类一个**: `getFields()`(`:62`)、`getName()`(`:99`)、`getLabel()`(`:112`)
- **ValueDescriptor** — 字段描述(名称/类型/注解)
- **AnnotationElement** — 注解的元数据表示

### 3.2 关系

```
事件类 → EventType(含 ValueDescriptor[] + 注解)
```

面试"EventType 和 Event 关系": 类与元数据——一个事件类对应一个 EventType。

关键设计(斜体):*"EventType = 事件的 Schema"——字段与设置的结构化描述;JFR 文件里的类型定义(消费者按 Schema 解析)。*

## 4. "EventFactory 动态事件" — 免写类

### 4.1 运行时定义

`EventFactory.create(List<AnnotationElement>, List<ValueDescriptor>)`(`EventFactory.java:120`)——**运行时定义事件类型**,不必继承 Event;随后 `newEvent()`(`:188`)实例化事件(构造器句柄调用),字段用 `Event#set(int,Object)`(第 1 篇 §3,`:169`)按索引赋值。

### 4.2 适用场景

- 静态继承: 编译期事件(类型安全)——大部分场景
- 动态工厂: 运行期事件(灵活)——结构运行时确定的场景(规则引擎/热配置埋点)

面试"动态事件什么时候用": 结构运行时确定(规则引擎等)。

关键设计(斜体):*"静态继承 vs 动态工厂"——编译期事件(类型安全)vs 运行期事件(灵活)。面试"动态事件什么时候用": 结构运行时确定(规则引擎等);生产: 大部分场景静态继承,动态用于热配置埋点。*

跨层标注: [域 04 注解——注解元数据模型(jdk.jfr 注解是普通 RUNTIME 注解,被 JFR 元数据化);内部卷 32-jfr——事件类型的 native 侧注册与元数据下发]

## 核心悬念

事件类写了——**commit 之后发生了什么**?事件类的字节码被谁改写?怎么用 ASM 注入?为什么注入后 commit 才"有行为"?——下一篇: 字节码增强机制。

> → [03-bytecode-instrumentation.md](03-bytecode-instrumentation.md)