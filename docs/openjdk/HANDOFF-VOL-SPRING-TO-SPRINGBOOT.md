# Spring → Spring Boot 交接文档

> 交接目的：把当前 `vol-spring` 的完成状态、存在的问题、后续进入 `vol-spring-boot` 的正确顺序交给下一个 AI，确保后续工作不断层、不返工。
> 当前日期：2026-08-20
> 当前仓位：`/data/workspace/source-code/openjdk-book/docs/openjdk/`

---

## 一、当前结论先说清

当前 **Spring Framework 主干卷已经基本铺完**，已经完成的内容包括：

- IoC / DI 主线
- AOP 主线
- 事务主线
- JDBC 主线
- MVC 主线
- 规范层（已补到 JSR-330 / JSR-250 / Servlet contract）
- 集成层（已补到 `DispatcherServlet` 接入 Tomcat、Spring Boot 装配 Spring Framework）
- 机制补深层骨架

也就是说：

- `vol-spring` 已经不是“只写了几篇”，而是已经形成了一整卷的主线骨架和大量正文
- 但它**还没有统一补源码证据层**（真实代码块、逐段 file:line 证据）
- `README`、篇间交叉引用、规范层与生产层仍有后续整理空间

因此，当前最优策略不是继续在 `vol-spring` 上无限往后写，而是：

1. 暂停 `vol-spring` 的继续铺文
2. 转入 `vol-spring-boot`
3. 等 Spring + Spring Boot 两卷都铺完后，再统一做源码证据层补强

---

## 二、下一个 AI 的第一优先级：**先 review 规划，不要立刻写正文**

这是本次交接里最重要的一条。

### 后续第一步必须做：

**先 review Spring Boot 既有的域规划和大纲规划。**

不要一上来就写 `vol-spring-boot` 正文。

原因：

- Spring Framework 这边已经暴露出一个教训：**原始规划只覆盖了模块域，没有自动长出“规范层 / 集成层 / 机制补深层 / 生产层”**
- 这些层后来是通过 `Spring源码学习范围规划-缺陷修复版.md` 才补上的
- Spring Boot 也很可能存在类似问题：
  - 自动装配主干有了
  - 但集成层 / 生产层 / 机制补深层可能不完整

所以后续 AI 的第一动作，必须是：

### 1. review 这几份文档

- 原始规划：
  - `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/issue/SpringBoot源码学习范围规划.md`
- 执行总计划：
  - `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/issue/源码分析执行计划.md`
- 复盘方法论：
  - `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/issue/源码范围规划复盘方法论.md`
- 写作方法论：
  - `/data/workspace/source-code/openjdk-book/docs/openjdk/WRITING-METHODOLOGY.md`

### 2. review Spring Boot 现有分析材料

重点目录：
- `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/source-analysis/spring/`
- `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/source-analysis/spring/knowledge-planning/`
- `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/source-analysis/spring/outlines/`

注意：目前 Boot 的很多规划其实散落在 Spring 的 `knowledge-planning/` 与 `outlines/` 里，尤其是：
- `b1` ~ `b29` 这一批 `knowledge-planning` 文件
- `s65` ~ `s93` 这一批 `outlines` 文件

也就是说，**Boot 的规划材料已经存在，但还没有被正式收束成 `vol-spring-boot` 正文卷。**

### 3. review 的目标不是“确认有无文件”，而是“判断这些 outline 是否能直接支撑写书”

必须检查：

- 是否只做了模块域规划，没有卷级分层
- 是否缺规范层
- 是否缺集成层
- 是否缺机制补深层
- 是否缺生产层
- 是否遗漏关键失败路径、回收路径、诊断入口
- 是否遗漏和 Spring Framework 的桥接关系

也就是说，先做一轮 **Boot 版的“缺陷修复 review”**，必要时先补 `SpringBoot源码学习范围规划-缺陷修复版.md` 或等价文档。

---

## 三、进入 `vol-spring-boot` 的建议顺序

卷目录名已经约定：

- `vol-spring-boot`

后续 AI 应在：

- `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-spring-boot/`

下工作。

### 推荐顺序

#### 第一阶段：先建卷骨架

在 review 规划完成后：
- 建 `vol-spring-boot/README.md`
- 按经过 review 的最终骨架建目录

建议至少覆盖：

##### 主干层
- `@SpringBootApplication`
- `SpringApplication.run()`
- 自动装配总入口
- 条件注解体系
- `@ConfigurationProperties`
- Starter 机制
- Web 自动装配
- 嵌入式容器自动装配
- DataSource/Redis/事务/缓存自动装配
- TaskExecutor / AOT
- FailureAnalyzer

##### 生产层
- Logging 系统
- ConfigData
- Availability / Liveness / Readiness
- Actuator 端点
- Health / Metrics
- Test slice

##### 集成层
- Boot 如何把 Spring Framework 装起来
- Boot 如何桥接 Tomcat / DispatcherServlet / DataSource / Cache / MVC

#### 第二阶段：按 Spring 现在的正文风格继续写

也就是继续维持：

- 困惑开场
- 失败方案推演
- 最小总图
- 主线拆解
- 易错判断
- 收网结论
- 篇末桥接

**注意：当前阶段继续保持“机制叙事体”风格即可，不需要立刻补源码证据层。**

原因：
- `vol-spring` 目前也是机制叙事体为主
- 继续维持同一风格，等 Boot 铺完后再统一补源码证据层，成本最低

---

## 四、`vol-spring` 当前状态说明（供后续 Boot 写作时交叉引用）

### 已写正文很多，但不等于已经最终完工

当前 `vol-spring` 已写大量正文，主要特点：

- 单篇字数/字符量已经达到较长正文标准
- 主线、失败方案、总图、收网都已基本建立
- **但源码证据层普遍不足**：
  - 缺真实代码块
  - 缺精确 file:line 证据密度
  - 缺“这段代码证明了什么”的证据化写法

所以后续 Boot 这边先不要急着回头补 Spring 的证据层，而是：

- 先把 Boot 也按同样叙事标准铺完
- 最后两卷统一做“源码分析化增强”

### 和 Boot 交叉引用时要注意的篇目

后续写 Boot 时，常会需要回指这些 Spring 正文：

- `ch17-refresh/01-refresh-lifecycle.md`
- `ch18-configuration/01-configuration-class-processing.md`
- `ch18-configuration/02-bean-method-and-cglib-enhancement.md`
- `ch20-conditional/01-conditional-evaluator.md`
- `ch38-dispatcherservlet/01-dispatcherservlet.md`
- `ch39-requestmapping/01-handler-mapping-and-adapter.md`
- `ch41-responsebody/01-httpmessageconverter-pipeline.md`
- `ch50-dispatcherservlet-tomcat/01-dispatcherservlet-tomcat.md`
- `ch51-boot-assembly/01-boot-assembly.md`

其中最后两篇已经开始进入集成层，会天然和 Boot 主线相连。

---

## 五、后续写作方式的硬约束

### 1. 不要再重复我犯过的错误

我当前这轮写 Spring 时犯过一个明显问题：

- 一开始写成了“纯文字机制说明文”
- 后来才被指出：这本质上是在写源码分析正文，不能脱离源码证据意识

虽然当前决定“先继续往下铺正文，源码证据后面统一补”，但后续 Boot 写作时仍要记住：

- 你写的是源码书正文，不是泛泛的技术博客
- 即使暂时不贴代码块，也要持续保留源码锚点意识
- 章节结构、桥接关系、失败路径、设计取舍必须像“源码书”而不是“总结文”

### 2. 每写完一篇就做 review

Spring 这边目前已经证明：

- 一篇一写完就 review + 修补
- 效果远好于积压十篇以后统一返工

所以后续 Boot 写作建议继续维持这个节奏：

1. 写一篇
2. 让用户 review / 或 AI 自己先 review
3. 修补
4. 再往下写

### 3. README 要及时同步

当前 `vol-spring` 曾多次出现：
- 正文已经写了很多篇
- README 索引明显落后

后续 `vol-spring-boot` 一定要避免这一点。

要求：
- 每写完 2~3 篇正文，及时更新 README
- 至少保证“当前已完成正文”索引不落后很多

---

## 六、建议的立即动作

下一个 AI 接手后，建议严格按下面顺序执行：

### Step 1
review：
- `SpringBoot源码学习范围规划.md`
- `源码范围规划复盘方法论.md`
- `WRITING-METHODOLOGY.md`

### Step 2
检查 Boot 现有 `knowledge-planning` + `outlines` 是否完整支撑写书

### Step 3
如果发现缺卷级层次：
- 先补 `SpringBoot源码学习范围规划-缺陷修复版.md`
- 再建 `vol-spring-boot` 骨架

### Step 4
正式开始 `vol-spring-boot` 第一篇正文

建议第一篇先不要直接落到 `run()` 机制，而是先写一篇总开场：
- `为什么有了 Spring，还要 Spring Boot`

这篇的作用不是立刻讲源码细节，而是先把 Boot 这一卷的总问题立住：

- Spring Framework 已经解决了容器、AOP、事务、MVC 等主干问题
- 那 Boot 到底新增了什么不可替代的装配价值
- 它解决的是“能力有没有”还是“系统怎样可装配、可启动、可交付”

在这篇总开场之后，再进入真正的机制总入口篇：
- `SpringApplication.run()`

这样的顺序更自然，因为它先回答“为什么要 Boot”，再回答“Boot 是怎么启动和装配的”。

---

## 七、交接结论

一句话总结：

**`vol-spring` 当前已经把主体框架主线铺得很深了，后续应先对 Spring Boot 做同样层级的“规划 review → 骨架搭建 → 正文铺设”，并明确从一开始就把它当成源码书，而不是模块笔记。第一步不是写正文，而是先 review Boot 既有规划域和 outlines。**
