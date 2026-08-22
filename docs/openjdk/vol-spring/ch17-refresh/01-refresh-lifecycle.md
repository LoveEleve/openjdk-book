# Spring 容器到底是谁真正启动起来的：`refresh()` 如何把前面所有主线串成一次完整启动

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring 容器总启动主线：为什么前面已经拆开的 `BeanDefinition`、`BeanFactory`、循环依赖、依赖注入、后处理器、作用域这些机制，并不是各自独立漂浮的知识点，而是最终都要在 `AbstractApplicationContext.refresh()` 这条总链里被按顺序组织起来。`@Configuration` 解析纵深、条件装配纵深和 BeanFactory 后处理器专题已各自独立，本篇不重复拆细这些子域，而是负责做一次总串联。

## 为什么前面那些零散机制，最后一定要有一个“总指挥”把它们接起来

前面 Spring 这一卷一路写下来，我们已经分别把很多关键机制拆开过：

- 资源怎么抽象
- 值怎么转换
- 环境和占位符怎么解析
- 顺序语义怎么统一
- 注解元数据怎么搜索和合并
- `@Profile` 怎么做条件装配
- 任务执行怎么抽象
- `BeanDefinition` 怎么描述未来对象
- `BeanFactory` 怎么分层
- Bean 生命周期链怎么跑
- 循环依赖为什么有时能解有时不能
- `@Autowired` / `@Resource` / `@Qualifier` 如何裁决依赖
- `BeanPostProcessor` 如何沿实例生命周期各阶段切入
- `BeanFactoryPostProcessor` 如何先改写定义世界
- 作用域又如何把同一张定义分流成不同生命周期

只要这些篇一多，一个很自然的问题就会出现：

- 这些东西到底是谁在什么时候调起来的？

因为如果没有一个总启动链把它们组织起来，整卷就很容易变成这样：

- 你知道每个零件各自怎么工作
- 但不知道它们在一次真实容器启动里是怎样被串起来的

也就是说，Spring 最终不能只靠很多“局部机制篇”成立，它还必须回答：

**容器到底是怎样把这些定义世界、实例世界和扩展世界，压缩进一次真正的启动主线里的。**

第一层问题是：**Spring 容器启动不是“创建几个对象”，而是“按阶段推进多个世界”。**

这点特别关键。

因为只要回头看前面几篇，你会发现 Spring 启动时其实至少同时在推进三件事：

- 定义世界：BeanDefinition 集合什么时候才完整
- 实例世界：单例 Bean 什么时候真正开始创建
- 扩展世界：BFPP、BPP、条件装配、作用域、事件这些机制什么时候插进来

也就是说，`refresh()` 面对的不是“一次方法调用”，而是：

- **很多不同阶段、不同责任面的统一排程。**

第二层问题是：**这些阶段不能乱序。**

前面很多专题其实已经暗示过这个约束：

- `BeanFactoryPostProcessor` 必须先于 Bean 实例化
- `BeanPostProcessor` 必须先注册，再谈 Bean 生命周期插点
- `@Configuration` 解析和 `${...}` 占位符替换必须先整理定义世界
- 单例预实例化必须等到上面这些都做完以后才能开始

也就是说，Spring 容器启动里最重要的能力之一，不是“会做很多事”，而是：

- **知道这些事必须按什么顺序做。**

第三层问题是：**`refresh()` 不只是顺序清单，它还是一个模板方法骨架。**

这里也要先把范围边界说清：本篇讲的是 **ApplicationContext 级总启动链**，也就是“整个容器怎样被点亮”。它不是上一组篇章里那个“单个 Bean 怎样出生、注入、初始化、代理和登记销毁”的局部生命周期链。

这意味着 Spring 不想把整个启动流程写成一个无法扩展的大函数。

相反，它要的是：

- 主骨架顺序固定
- 关键步骤留出受控扩展点
- 子类或上层框架能在特定步骤插入自己的启动动作

这也解释了为什么像：

- `ServletWebServerApplicationContext`
- Spring Boot 的 Web 容器装配

都最终会把自己的逻辑挂在 `refresh()` 某些固定步骤上，而不是在外部再平行造一套启动链。

因此，本文真正要回答的问题不是“`refresh()` 有 12 步”，而是：

**为什么对 Spring 来说，容器启动必须被组织成一条有严格阶段顺序、还能承载扩展点的总主线，而 `refresh()` 正是这条总主线的模板骨架？**

## 先看 `refresh()` 源码：它不是概念，而是本地源码里真实存在的模板方法骨架

在开始拆失败方案之前，先直接看 Spring 容器真正启动的总入口：

```java
@Override
public void refresh() throws BeansException, IllegalStateException {
    this.startupShutdownLock.lock();
    try {
        this.startupShutdownThread = Thread.currentThread();
        StartupStep contextRefresh = this.applicationStartup.start("spring.context.refresh");

        prepareRefresh();                                          // 1. 准备启动状态
        ConfigurableListableBeanFactory beanFactory = obtainFreshBeanFactory(); // 2. 获取刷新后的 BeanFactory
        prepareBeanFactory(beanFactory);                           // 3. 准备 BeanFactory

        try {
            postProcessBeanFactory(beanFactory);                   // 4. 子类扩展 BeanFactory
            invokeBeanFactoryPostProcessors(beanFactory);          // 5. 执行 BFPP → 定义世界收口
            registerBeanPostProcessors(beanFactory);               // 6. 注册 BPP → 实例扩展器入场

            initMessageSource();                                   // 7. 初始化消息源
            initApplicationEventMulticaster();                     // 8. 初始化事件广播器

            onRefresh();                                           // 9. 子类扩展（如 Web 容器创建）

            registerListeners();                                   // 10. 注册监听器
            finishBeanFactoryInitialization(beanFactory);          // 11. 预实例化单例
            finishRefresh();                                       // 12. 发布刷新完成事件
        }
        catch (RuntimeException | Error ex) {
            destroyBeans();                                        // 失败时销毁已创建的单例
            cancelRefresh(ex);                                     // 重置 active 标志
            throw ex;
        }
        finally {
            contextRefresh.end();
        }
    }
    finally {
        this.startupShutdownThread = null;
        this.startupShutdownLock.unlock();
    }
}
```

来源：`spring-framework/spring-context/.../AbstractApplicationContext.java:588-658`。

这段代码证明了四件事：

- 容器启动不是一个大函数，而是一个阶段明确的模板方法骨架
- 定义世界处理（BFPP）在实例世界扩展器（BPP）注册之前，BPP 注册又在单例创建之前
- 失败时通过 `destroyBeans()` / `cancelRefresh()` 回滚，不是直接抛异常就结束
- 每个阶段都是 `protected` 方法，子类可以覆写（如 `onRefresh()` 被 `ServletWebServerApplicationContext` 重写用于创建内嵌 WebServer）

## 先看失败方案：为什么不能“定义读完就实例化”“先注册 BPP 再补定义”“把启动写成一个大方法”

理解 `refresh()` 最好的方式，不是先背 12 个步骤，而是先看几种特别顺手、但一放到 Spring 容器里就会迅速失效的朴素方案。

### 失败方案一：定义一读完就立刻开始实例化 Bean

这是最容易产生的直觉。

因为从普通工厂视角看，流程似乎很自然：

- 配置已经读进来了
- 那就赶紧把对象创建出来

如果 Spring 只是个轻量对象工厂，这样做当然没问题。

但对 Spring 容器来说，这会立刻把很多前置阶段彻底跳过：

- `BeanFactoryPostProcessor` 还没来得及改写定义世界
- `@Configuration`、`@ComponentScan`、`@Import` 带来的定义扩张还没完成
- `${...}` 占位符还没在定义值层被替换
- `BeanPostProcessor` 体系甚至都还没注册完成

也就是说，实例化一旦太早开始，后面实例世界吃到的就只是一个“未整理、未扩张、未收口”的定义输入。

所以 Spring 真正要避免的不是“创建早一点”，而是：

**让实例世界在定义世界还没准备好的情况下提前启动。**

### 失败方案二：那就先注册 BPP，后面再慢慢跑 BFPP 和定义扩张

如果意识到“不能太早实例化”，第二种自然的想法就是：

- 好，那先把 BeanPostProcessor 都注册起来
- 后面再补 BFPP、配置类解析、占位符替换

这个方案的问题在于，它把实例世界的扩展器提前放到了定义世界还没收口之前。

这会直接导致：

- 有些 BPP 看到的定义集合还不完整
- 后面新扩出来的定义，前面注册/排序阶段又没被完整纳入
- 依赖注入与生命周期链会开始站在一套还没完全定型的定义输入上工作

也就是说，Spring 真正要守住的不是“先注册点扩展”，而是：

- **先让定义世界收口，再让实例世界扩展体系进场。**

所以 BFPP 和 BPP 的先后，不是实现习惯，而是世界顺序。

### 失败方案三：12 步太啰嗦，不如直接写成一个大启动函数

如果继续往设计层想，还有一种很诱人的做法：

- 反正容器启动就这些动作
- 全塞一个大方法里按顺序写完不就行了

这个方案在短期实现上当然很直接，但对 Spring 这种框架来说会带来两个严重问题。

第一，扩展点会变得非常模糊。

因为像：

- Web 容器创建
- 上下文子类自定义启动动作
- 某些特殊环境准备工作

都需要知道：

- 我到底该插在定义收口前，还是实例化前，还是事件广播器之后

如果只有一个大函数，这些扩展点就只能靠“猜位置”插进去。

第二，读者和框架维护者都很难形成阶段心智图。

也就是说，Spring 需要的不是“能跑通的启动函数”，而是：

- **一个阶段清晰、责任清晰、可覆写和可收口的启动骨架。**

这就是模板方法在这里必须出现的原因。

源码上也直接证明了这种扩展能力：`onRefresh()` 在 `AbstractApplicationContext` 里默认是空实现（定义在第 903 行），子类通过覆写它来插入自己的启动逻辑：

```java
protected void onRefresh() throws BeansException {
    // For subclasses: do nothing by default.
}
```

来源：`spring-framework/spring-context/.../AbstractApplicationContext.java:903`。

调用点在第 622 行：`refresh()` 内部在 `initMessageSource` 和 `initApplicationEventMulticaster` 之后、`finishBeanFactoryInitialization` 之前调用 `onRefresh()`。`ServletWebServerApplicationContext` 就覆写了它——在 `onRefresh()` 里调用 `createWebServer()`，把嵌入式 Tomcat 创建挂进 `refresh()` 主线的第 9 步。

## Spring `refresh()` 的最小总图

如果把这条总主线先压缩成最小模型，它可以写成下面这样：

```text
prepare context state
   -> prepare bean factory
   -> mutate definition world
   -> register instance-world processors
   -> initialize infrastructure beans
   -> pre-instantiate singletons
   -> publish refreshed state
```

如果再换一种更容易理解的拆法，这条链可以分成六段职责：

```text
[启动前状态准备]
prepareRefresh / obtainFreshBeanFactory / prepareBeanFactory

   ->

[定义世界处理]
postProcessBeanFactory / invokeBeanFactoryPostProcessors

   ->

[实例世界扩展器入场]
registerBeanPostProcessors

   ->

[基础设施准备]
initMessageSource / initApplicationEventMulticaster / onRefresh / registerListeners

   ->

[实例世界正式启动]
finishBeanFactoryInitialization

   ->

[容器完成收口]
finishRefresh
```

这张图最重要的价值，不是让读者死记 12 个方法名，而是先把六个问题分开：

### 一、启动前状态准备

回答：容器在真正碰 BeanFactory 之前，自己要先处于什么状态？

### 二、定义世界处理

回答：为什么 BFPP、配置类解析、占位符替换都必须站在实例化前处理？

### 三、实例世界扩展器入场

回答：为什么 BPP 必须在单例创建前先完整注册？

### 四、基础设施准备

回答：MessageSource、事件广播器、监听器、子类刷新钩子为什么不能等到单例全建完以后再说？

### 五、实例世界正式启动

回答：前面那么多准备最终是在哪一步真正点火，开始创建绝大多数单例 Bean？

### 六、容器完成收口

回答：什么时刻 Spring 才真正把自己宣布成“已经 refresh 完成”的容器？

只要先把这六层职责分开，`refresh()` 就不再像一个“方法很多的总入口”。

## 一、为什么 `refresh()` 首先是模板方法，而不是启动脚本

只要先从整体设计看，`refresh()` 最重要的第一层身份其实不是“启动方法”，而是：

- **模板方法骨架**

这意味着什么？

意味着 Spring 不是先关心“启动时要做多少事”，而是先关心：

- 哪些步骤的顺序必须被框架锁死
- 哪些步骤允许子类或上层框架在受控位置插入自己的逻辑

也就是说，`refresh()` 面对的不是简单任务清单，而是：

- 一条既要稳定、又要可扩展的容器启动协议

这也是为什么它会被拆成很多显式步骤，而不是一段无法切开的实现代码。

像：

- `postProcessBeanFactory()`
- `onRefresh()`

这类方法之所以存在，不是因为源码作者喜欢拆函数，而是因为：

- 它们就是模板方法里留给子类的合法扩展点

也就是说，子类并不是可以随便撕开 `refresh()` 任意改步骤，而是只能沿这些受控钩子把自己的逻辑接入骨架。Spring 真正开放给扩展者的，不是“随意改启动顺序”的自由，而是“在被框架认可的阶段里插入自己的动作”的能力。

也正因为如此，像 Spring Boot 这种更上层框架才能把自己的 Web 容器装配动作稳定挂到 `onRefresh()` 一类步骤上，而不必去篡改整条主线。

所以 `refresh()` 的第一层理解，不是“12 步很多”，而是：

**Spring 先把启动骨架定型，再把扩展点嵌到骨架里。**

## 二、前半段为什么先准备容器自己，再准备 BeanFactory

只要继续往前半段看，就会发现 `refresh()` 一开始做的并不是立刻碰具体 Bean 创建，而是先做两类准备：

- 容器自身状态准备
- BeanFactory 可用性准备

这一步特别容易被忽略，因为大家天然更关心 Bean。

但对 Spring 来说，如果连容器自己的状态都没切进“活跃可刷新”语义，后面的定义世界和实例世界就没有稳定宿主。

也就是说：

- 先 `prepareRefresh()`
- 再 `obtainFreshBeanFactory()`
- 再 `prepareBeanFactory()`

并不是前戏太长，而是在回答一个很基础的问题：

- **谁来承载后面的定义和实例主线，以及它现在准备好了吗？**

这也说明 Spring 启动首先不是“建对象”，而是：

- 先把容器本身和它要使用的 BeanFactory 环境搭稳

## 三、为什么 Step 5 和 Step 6 之间那条线最关键：先收口定义世界，再放实例世界扩展器进场

只要走到中段，`refresh()` 里最核心的一条分界线就会出现：

- `invokeBeanFactoryPostProcessors()`
- `registerBeanPostProcessors()`

这条线为什么重要？

因为它几乎正好把前面两篇的世界边界硬性排成了先后顺序：

- 先定义世界
- 后实例世界

也就是说：

- BFPP / BDRPP 先把定义世界扩张、修改、占位符替换、配置类解析做完
- BPP 体系再被完整注册进 BeanFactory，准备接管之后的实例生命周期插点

这里还要再钉一句特别容易被误解的边界：`registerBeanPostProcessors()` 做的不是“BPP 已经开始加工 Bean”，而是“BPP 现在正式进入后续实例世界的统一插点队列”。

这条顺序一旦乱掉，后果会非常直接：

- BPP 看到的定义集合可能还不完整
- 某些新扩出来的定义来不及纳入实例世界主线
- `${...}` 还没替换好，实例阶段就已经开始取值

所以这一段不是“两个专题各自执行一下”，而是：

**`refresh()` 在这里硬性地把定义世界和实例世界接成正确顺序。**

这也就是为什么前面必须把 BFPP 和 BPP 分成两篇来讲。因为只有分开，读者到这里才会真正看见：

- 不是两个名字像的扩展点
- 而是两个必须按世界顺序排队进入总启动链的系统

## 四、为什么 MessageSource、事件广播器、监听器和 `onRefresh()` 不能被当成“后面再补”的外围功能

一旦 Step 5 和 Step 6 过去，很多人会自然把后面的：

- `initMessageSource()`
- `initApplicationEventMulticaster()`
- `onRefresh()`
- `registerListeners()`

看成某种“容器外围功能”。

这个判断不够稳。

因为这些步骤虽然不像 BeanDefinition、BPP 那样贴着 IoC 主线，但它们并不是可有可无的尾部装饰。

更准确地说，它们在 `refresh()` 里承担的是：

- **把容器要依赖的基础设施先搭好，再让单例世界大规模启动。**

这一步特别重要。

因为只要单例预实例化开始，后面很多 Bean 自己就可能：

- 访问消息源
- 发布或监听事件
- 依赖某些子类在 `onRefresh()` 中创建的容器能力

所以这几步不是“晚点做也行”，而是：

- 必须在实例世界全面点火前先就位

也就是说，这些步骤不是 Bean 实例世界的附属功能，而是后面很多 Bean 可能直接依赖的运行基础设施。

这也解释了为什么像 Web 容器创建这种动作，会放在 `onRefresh()` 这种受控步骤里，而不是放到外部随便调用。

## 五、为什么 Step 11 才是前面十几篇第一次真正一起点火的地方

只要走到 `finishBeanFactoryInitialization()`，前面整卷已经拆开的很多主线才会第一次真正一起被点燃。

这一步之所以重要，不是因为“终于开始创建单例了”这么表面，而是因为：

- 前面的所有准备，到这里才第一次真正进入实例世界大规模执行期

也就是说，Step 11 不是一个普通阶段，而是：

**定义世界、扩展世界、生命周期协议第一次在大规模 Bean 创建上汇流。**

这时前面讲过的东西才会真正开始整体联动：

- `BeanDefinition` 提供蓝图
- `BeanFactory` 提供容器能力
- BFPP 提供整理后的定义输入
- BPP 提供生命周期插点
- 循环依赖逻辑开始在单例创建时生效
- `@Autowired` / `@Resource` 开始在 `populateBean` 里注入
- AOP 代理开始在初始化后阶段出现
- 作用域分流也开始在 `doGetBean()` 里走不同路径

也就是说，Step 11 才是前面那十几篇真正第一次在一次容器启动里一起发生的地方。

这也是为什么本篇必须在主干前半段写到这个位置。因为如果没有这篇总串联，前面那些专题虽然都懂了，读者仍然不知道：

- 它们在真实容器启动里到底什么时候集体开始工作

## 六、为什么 `finishRefresh()` 不是句号，而是容器对外宣布“我现在真的活了”的那一刻

只要所有前面的准备和单例预实例化都完成以后，Spring 还不会立刻粗暴结束 `refresh()`。

因为对容器来说，真正重要的最后一步不是“我事情做完了”，而是：

- **我现在可以对外宣布自己已经进入可用状态了吗？**

这就是 `finishRefresh()` 的位置。

它站在总主线最末端，真正做的是：

- 容器状态收口
- 刷新完成事件发布
- 让外部世界知道“这个 ApplicationContext 已经从定义世界和实例世界的启动链里走出来了”

这意味着 `refresh()` 的最后一步不是技术细节，而是：

- 容器生命周期对外可见状态的切换点

也正因为如此，它不能被随便看成“最后顺手发个事件”。

对 Spring 来说，这一步是：

- **我现在不只是把内部工作做完了，而是正式成为一个可用容器了。**

换句话说，`finishRefresh()` 不只是在做“对外宣布”，它同时也意味着：

- 前面模板方法骨架里的定义准备、扩展点注册、基础设施就位、单例点火这些阶段，已经全部收口完成

## 七、为什么这篇总串联不是重复，而是把前面所有局部协议第一次放进同一条时间线

看到这里，最值得回收的一个问题就是：

- 既然前面很多主题都已经单独讲过了，这篇总串联是不是只是在重复？

答案恰恰相反。

前面那些篇章解决的是：

- 每个局部协议各自怎么成立

而这篇真正解决的是：

- **它们在一次真实容器启动里到底按什么顺序被接起来。**

这两件事完全不是同一个问题。

比如：

- 知道 BFPP 处理定义世界，不等于知道它为什么必须先于 BPP
- 知道 `doCreateBean()` 很核心，不等于知道它为什么被放在 Step 11 才全面点火
- 知道 `@Autowired` 发生在 `populateBean`，不等于知道整个注入世界是在 `refresh()` 的哪一段才开始大规模启动

也就是说，总串联篇的意义从来不是再讲一遍局部机制，而是：

- 把那些已经拆开的协议第一次放进同一条时间线

这就是为什么这篇是主干卷里的关键收口点，而不是附录。

## 八、几个最容易错的判断

### 1. `refresh()` 就是把前面讲过的功能顺序调用一下

不成立。

它真正组织的是定义世界、实例世界、扩展世界和容器基础设施的阶段化推进，而不是简单方法串联。

### 2. BFPP 和 BPP 只是两个名字像的扩展点，先后无所谓

不成立。

BFPP 先收口定义世界，BPP 再进入实例世界，这条顺序是容器启动的硬边界。

### 3. Step 7~10 都是外围功能，晚点做也没关系

不成立。

它们是实例世界全面启动前的基础设施准备阶段，很多单例 Bean 之后会直接依赖这些能力。

### 4. `refresh()` 最大的工作量就是创建单例 Bean

不完整。

单例创建当然核心，但它之所以能安全开始，前面整个定义收口、后处理器注册、基础设施准备都已经先铺好了。

### 5. `finishRefresh()` 只是最后顺手发个事件

不成立。

它是容器对外宣布“刷新已完成、我现在可用了”的生命周期收口点。

## 收网：Spring 要统一的从来不只是“怎么创建 Bean”，而是“定义世界、实例世界和扩展世界如何在一次启动里被按顺序点亮”

现在可以回到开头那个问题：前面那些零散机制，到底是谁真正把它们组织起来的？

答案就是 `refresh()`。

因为对 Spring 这种 IoC 容器来说，它真正要面对的不只是：

- 定义怎么存在
- Bean 怎么创建
- 依赖怎么注入
- 代理怎么生成

而是：

- 这些世界到底按什么顺序彼此接起来
- 哪些阶段必须先于另外一些阶段
- 哪些扩展点必须在对象出生前生效
- 哪些基础设施必须在单例大规模实例化前准备好

所以 Spring 的答案不是写一个大启动脚本，而是建立一条模板方法式的总主线：

```text
prepareRefresh
obtainFreshBeanFactory
prepareBeanFactory
postProcessBeanFactory
invokeBeanFactoryPostProcessors
registerBeanPostProcessors
initMessageSource
initApplicationEventMulticaster
onRefresh
registerListeners
finishBeanFactoryInitialization
finishRefresh
```

因此，这篇真正该带走的结论不是“`refresh()` 有 12 步”，而是：

**Spring 把容器启动问题从“做很多事”提升成了“定义世界、实例世界、扩展世界和基础设施世界如何被一条模板方法总主线按阶段顺序组织起来”的容器级协议。**

这也留下了下一篇最自然的问题：既然总启动主线已经立住了，那在 Step 5 中最关键、最能继续扩张定义世界的那条链——`@Configuration`、`@ComponentScan`、`@Import`——到底是怎样被解析、递归展开并注册成更多 BeanDefinition 的？

也就是说，接下来最自然的继续点就是：

- `ConfigurationClassPostProcessor`
- `ConfigurationClassParser`
- `@ComponentScan`
- `@Bean`
- `@Import`

下一篇进入 Spring 的 `@Configuration` 配置类处理主线。