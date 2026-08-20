# 39-jfr/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `jdk.jfr` 注解体系、`EventType`、`ValueDescriptor`、`EventFactory`。本文聚焦自定义事件类、注解元数据、事件 Schema 与动态事件；字节码注入放到下一篇。
> 目标：把“自定义事件与注解”改写成一篇围绕“JFR 自定义事件的关键，不是继承一个基类这么简单，而是把业务行为声明成一份既能被记录引擎识别、又能被分析工具展示、还能在配置中被启停和筛选的事件 Schema”展开的机制文章。

## 1. 读者困惑

- 为什么写一个 JFR 事件不只是“继承 `Event` 然后加字段”？
- `@Label`、`@Description`、`@Name`、`@Category`、`@Threshold` 这些注解到底是在控制什么？
- 事件类里的字段为什么会变成可配置、可展示的元数据，而不只是普通 Java 成员？
- `EventType` 和 `ValueDescriptor` 与事件类本身是什么关系？
- 什么时候该用静态继承写事件，什么时候又需要 `EventFactory` 动态造事件？

## 2. 一句话顿悟

**JFR 自定义事件的本体不是“一个继承了 `Event` 的 POJO”，而是一份事件 Schema：类和字段提供数据槽位，注解提供显示名、分类、阈值、默认启用状态等元数据，JFR 再把这一切收束成 `EventType`/`ValueDescriptor` 这样的结构化描述。只有当事件先被描述成正式 Schema，录制器、配置模板和分析工具才能用统一方式启停、过滤、展示和消费它。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖静态事件、注解元数据、`EventType` / `ValueDescriptor`、`EventFactory` 动态事件。
- 已指出 MXBean 式“描述 + 数据分离”的影子，方向是对的。
- 已把 `commit` 与上一篇事件协议接上，衔接合理。

### 必须重写

- 旧稿偏 API 枚举，需要先立住总问题：为什么 JFR 事件要先被描述成正式 Schema。
- 注解体系要放到“元数据控制记录/展示/配置”的统一主线上，不宜只是表格列举。
- `EventType` 与 `ValueDescriptor` 要讲成运行时元模型，而不是术语介绍。
- `EventFactory` 要作为“当结构不能在编译期写死时的 Schema 工厂”来讲。

## 4. 理解路径

### 第一节：从“为什么继承 `Event` 还不够”开场

承接上一篇：有了事件协议还不够，继续追问——录制器和分析器怎么知道这个事件叫什么、归哪类、字段代表什么、什么时候该记。先立住总问题：事件必须先被描述成 Schema。

### 第二节：静态事件为什么是“类 + 字段 + 注解”三件套

证据：
- `Event.java` 继承关系来自上一篇
- 旧稿中的 `Event` 用法与 Javadoc 线索
- 注解类定义：`Label.java:48`、`Description.java:45`、`Name.java:46`、`Category.java:123`、`Enabled.java:45`、`Period.java:43`、`Threshold.java:44`、`StackTrace.java:44`

主线：
- 类和字段只是数据形状；
- 注解决定显示、分类、启用和阈值等记录元数据；
- 这说明自定义事件本质上是“带元数据的事件声明”。

### 第三节：为什么 `EventType` / `ValueDescriptor` 才是运行时真正消费的事件 Schema

证据：
- `EventType.java:47/62/99/112`

主线：
- 每个事件类会在运行时对应一个 `EventType`；
- 字段被整理成 `ValueDescriptor` 列表；
- 分析工具、配置模板和消费者真正依赖的是这套结构化描述，而不是直接盯着 Java 源码。

### 第四节：注解为什么不是“UI 标签”,而是记录行为的一部分

证据：
- `Enabled.java:45`
- `Period.java:43`
- `Threshold.java:44`
- `StackTrace.java:44`

主线：
- 有些注解控制展示（如 label/description/category）；
- 有些注解直接控制事件记录行为（默认启用、周期、阈值、是否带栈）；
- 这说明元数据不只是美化输出，而是在参与录制策略。

### 第五节：为什么 `EventFactory` 代表“动态 Schema 工厂”

证据：
- `EventFactory.java:80/120/188`

主线：
- 当事件结构不能在编译期写死时，可以在运行时提供注解元素和字段描述，动态造出事件类型。
- 这让 JFR 事件模型不局限于静态类定义。
- 但动态能力换来的是类型安全让位于灵活性。

### 第六节：为什么静态继承仍然是默认路径

主线：
- 静态类事件更清晰、类型安全、可维护；
- 动态事件只在结构运行时才确定的场景下有意义；
- 这回扣“Schema 是核心，静态/动态只是 Schema 产生方式不同”。

## 5. 失败方案清单

1. 以为继承 `Event` 后随便放几个字段就够，不需要元数据设计。
2. 把 JFR 注解只当成显示标签，忽略其记录行为控制作用。
3. 认为分析工具直接读取 Java 类定义，而不是运行时事件 Schema。
4. 在固定结构场景滥用动态事件工厂，降低可维护性。
5. 不区分字段数据和值的描述，导致事件消费端难以稳定理解。

## 6. 误解清单

1. JFR 自定义事件就是一个带 `commit()` 的普通 POJO。
2. `@Label`、`@Description` 这类注解只影响 UI，不影响录制系统本身。
3. `EventType` 只是事件类名的另一层包装，没有额外价值。
4. 动态事件工厂比静态继承“更高级”，所以应优先使用。
5. 远程或离线分析时，工具必须拿到业务事件类的字节码才能理解事件数据。

## 7. 证据清单

- `Label.java:48`
- `Description.java:45`
- `Name.java:46`
- `Category.java:123`
- `Enabled.java:45`
- `Period.java:43`
- `Threshold.java:44`
- `StackTrace.java:44`
- `EventType.java:47/62/99/112`
- `EventFactory.java:80/120/188`
- 旧稿中的 `Event` 用法与 Javadoc 线索

## 8. 版本与边界

- 基于 JDK 11。
- 本篇讲事件声明与元模型，不展开字节码注入和 native 注册细节。
- 不把所有 JFR 注解一网打尽，只聚焦事件描述和录制控制直接相关的核心注解。
- 消费 API 和录制配置细节留到后续篇章。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么自定义事件必须先被描述成 Schema → 静态事件为何是类+字段+注解三件套 → 注解如何同时控制展示与记录行为 → `EventType`/`ValueDescriptor` 为什么是运行时元模型 → `EventFactory` 如何在运行时生成动态事件 Schema”。
- 必须把自定义事件讲成‘事件 Schema 声明’，而不是 POJO 教程。
- 必须自然引到 `03-bytecode-instrumentation.md`。
