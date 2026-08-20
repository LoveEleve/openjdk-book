# 为什么 `ApplicationContext` 不只是一个大接口：Spring 如何用几种上下文实现把“定义加载阶段”和“refresh 激活阶段”分成两段

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring 上下文实现体系的第一层：为什么 `ApplicationContext` 在前面已经作为最外层门面出现之后，Spring 仍然要继续拆出 `GenericApplicationContext`、`AnnotationConfigApplicationContext`、`ClassPathXmlApplicationContext`、`GenericWebApplicationContext` 这些实现，并把“先把 BeanDefinition 装进去”与“再通过 refresh() 激活容器”做成两段式模型。Spring Boot 的 `ServletWebServerApplicationContext` 和内嵌容器创建，会在后续集成层继续展开。

## 为什么前面都从 `refresh()` 开始讲，现在还必须回头补一篇“上下文实现体系”

前面这卷一路写下来，我们已经把很多最关键的主线都拆开了：

- `BeanDefinition` 如何描述未来对象
- `BeanFactory` 如何组织容器能力树
- Bean 生命周期、循环依赖、依赖注入、BPP / BFPP 如何在实例世界和定义世界各自推进
- `refresh()` 又怎样把这些子链在一次容器启动里总串起来

看到这里，很多人会自然产生一个疑问：

- 如果 `refresh()` 已经是总启动链，那前面那个 `new AnnotationConfigApplicationContext(...)` 到底还做了什么？

这个问题很重要，因为它会把读者从“容器激活阶段”重新拉回“容器加载阶段”。

也就是说，前面我们一直在讲：

- 容器真正开始启动以后，内部世界按什么顺序被点亮

但我们还没有系统回答：

- **这些定义世界一开始是怎么被塞进容器里的？**

第一层问题是：**`ApplicationContext` 不是一创建出来就已经有完整容器内容。**

这也是很多人第一次学 Spring 时最容易自然脑补错的一点。

因为日常代码里最常见的写法看起来都像：

- `new AnnotationConfigApplicationContext(AppConfig.class)`
- `new ClassPathXmlApplicationContext("applicationContext.xml")`

于是很容易误会成：

- 上下文构造器一调用，整个容器世界就已经就位了

但 Spring 真正做的其实是两段式：

- 先把 BeanDefinition 读进来 / 注册进来
- 再由 `refresh()` 把定义世界推进成真正的可用容器

这说明对 Spring 来说，上下文实现体系不是“换个构造器语法”，而是在回答：

**容器总启动链开始之前，定义世界究竟是怎么被加载和安放进去的。**

第二层问题是：**不同上下文实现的真正差异，并不在 `refresh()` 骨架本身，而在 refresh 之前的“装货阶段”。**

比如：

- `GenericApplicationContext` 更像一个空骨架，允许你手工往里塞定义
- `AnnotationConfigApplicationContext` 则带着 reader + scanner，能把注解类和包扫描结果读进来
- `ClassPathXmlApplicationContext` 走的是 XML reader 路线
- `GenericWebApplicationContext` 又多了一层 ServletContext / Web Scope 桥接

也就是说，这些实现类真正区分的不是“后面怎么启动”，而是：

- **在 `refresh()` 之前，定义世界是按哪种入口被准备好的。**

第三层问题是：**Spring 上下文实现体系不是在替代 `refresh()`，而是在给 `refresh()` 提供不同形态的前置输入。**

这也是本篇最核心的一层视角切换。

很多人会下意识把：

- `ApplicationContext` 的各种实现
- 和 `refresh()` 模板方法

看成彼此竞争的两套架构。

其实完全不是这样。

更准确地说：

- 上下文实现体系负责“加载阶段”
- `refresh()` 负责“激活阶段”

两者不是替代关系，而是：

- **前后接力关系。**

因此，本文真正要回答的问题不是“Spring 有几种 ApplicationContext 实现”，而是：

**为什么对 Spring 来说，容器必须先通过不同上下文实现完成定义加载，再统一交给 `refresh()` 激活，而不能把这两件事糊成一次构造函数调用？**

## 先看失败方案：为什么不能“构造器里直接把容器全启动完”“所有实现共享同一种加载入口”“Web 上下文只是普通上下文加点字段”

理解 Spring 上下文实现体系，最好的方式不是先背类图，而是先看几种特别自然、但一放到真实容器世界里就会迅速失效的朴素方案。

### 失败方案一：构造器里直接把定义加载和 `refresh()` 全做完不就行了

这是最符合很多人直觉的方案。

因为从使用者视角看，下面这种写法的体验确实很顺：

- `new AnnotationConfigApplicationContext(AppConfig.class)`
- 容器就起来了

于是很容易进一步推断：

- 那干脆所有上下文都在构造器里直接完成加载 + 启动

这个想法的问题在于，它会把 Spring 最重要的一条分界线抹掉：

- 定义世界准备阶段
- 容器激活阶段

一旦这两段被揉进一个不可拆开的构造器里，立刻就会带来几个问题：

- 你很难在 `refresh()` 之前再追加、修改或编程式注册 BeanDefinition
- 子类也很难在加载阶段和激活阶段之间插自己的逻辑
- Web 场景下某些上下文依赖的外部对象（如 ServletContext）也会被迫过早绑定

也就是说，Spring 真正需要的不是“构造器里一步到位”，而是：

**保留定义加载与容器激活之间的明确分界。**

### 失败方案二：所有上下文实现只要共享 `refresh()`，那前面的加载方式也统一掉就行了

如果意识到两段式模型重要，第二种自然思路就会变成：

- 好，那 `refresh()` 后半段共享
- 但前半段 BeanDefinition 加载也没必要分 Reader / Scanner / XML / Web 这些实现

这个判断同样不稳。

因为对 Spring 来说，定义世界的来源本来就不统一：

- 有的来自注解类显式注册
- 有的来自包扫描
- 有的来自 XML 文件
- 有的来自 Web 环境额外绑定

这说明“加载阶段”本来就不是一个单一路径，而是：

- **很多不同入口向同一个定义世界收敛。**

所以 Spring 真正要统一的，不是加载方式本身，而是：

- 加载结果最终都必须变成同一个 BeanDefinition 世界，再交给 `refresh()`

### 失败方案三：Web 上下文只不过是普通上下文多带几个 Web 字段而已

这也是一个很容易被低估的直觉。

因为从表面看，Web 上下文似乎只是：

- 多一个 ServletContext
- 多几个 request/session scope

但对 Spring 来说，这种差异根本不是“多几个字段”这么轻。

因为一旦进入 Web 世界，容器真正要处理的是：

- 外部 ServletContext 如何接进容器
- request / session / application 这些 scope 在哪个阶段注册
- 定义加载和上下文绑定的先后顺序怎么守住

也就是说，Web 上下文并不是“普通上下文 + 一点附加信息”，而是：

- **一个会把外部容器世界重新桥接进 Spring 容器世界的实现分支。**

这也解释了为什么它必须单独被理解，而不能被压平进普通上下文构造器故事里。

## Spring 上下文实现体系的最小总图

如果把这条主线先压缩成最小模型，它可以写成下面这样：

```text
context implementation chooses definition loading style
   -> bean definitions registered into an internal bean factory
   -> refresh() activates the container using the same template lifecycle
```

如果再换一种更容易理解的拆法，这条链可以分成四段职责：

```text
[基础骨架]
GenericApplicationContext

   ->

[注解入口]
AnnotationConfigApplicationContext

   ->

[XML 入口]
ClassPathXmlApplicationContext

   ->

[Web 入口]
GenericWebApplicationContext
```

这张图最重要的价值，不是让读者记住几个实现类，而是先把四个问题分开：

### 一、基础骨架

回答：如果完全不预设 XML、注解或 Web 入口，最通用的上下文骨架长什么样？

### 二、注解入口

回答：reader + scanner + register 三部曲是怎样在 `refresh()` 之前把定义世界装进去的？

### 三、XML 入口

回答：为什么 XML 路线虽然来源不同，后续 `refresh()` 仍能共享同一条激活骨架？

### 四、Web 入口

回答：为什么 Web 上下文的关键不在“能跑 Web”，而在“如何把外部 Servlet 世界桥回 Spring 定义和作用域世界”？

只要先把这四层职责分开，`ApplicationContext` 实现体系就不再像“几种构造器写法”。

## 一、`GenericApplicationContext`：Spring 先准备的不是某种具体配置入口，而是一块已经内置 BeanFactory 的上下文骨架

如果从实现体系最底层往上看，`GenericApplicationContext` 最重要的地方在于：

- 它并不先决定你用 XML 还是注解
- 它先决定：**上下文骨架里已经内置了一个可用的 BeanFactory**

这一步特别关键。

因为它说明 Spring 在这里的第一层设计不是“怎么加载配置”，而是：

- 先提供一个可以承接定义世界的通用宿主

也就是说，`GenericApplicationContext` 真正回答的是：

- 如果我先不管定义从哪里来
- 只问“容器前半段的承载体是什么”
- 那答案就是：一个已经持有 `DefaultListableBeanFactory` 的上下文骨架

这也解释了为什么它和前面 `refresh()` 总串联之间是前后接力关系：

- `GenericApplicationContext` 负责准备宿主
- `refresh()` 负责点亮宿主里的定义世界和实例世界

所以 `GenericApplicationContext` 不能被看成“最简单上下文实现”这么浅。

更准确地说，它是：

- **把 BeanFactory 先内嵌到上下文里的基础骨架。**

## 二、为什么 `GenericApplicationContext` 的 BeanFactory 在构造期就存在：它强调的是“先装定义，再激活容器”

只要继续往 `GenericApplicationContext` 看，一个特别值得停一下的点就是：

- 它的 BeanFactory 不是在 `refresh()` 里临时创建出来的
- 而是在上下文骨架构造时就已经存在

这一步很重要，因为它把“加载阶段”和“激活阶段”的分界线直接物化了出来。

也就是说，对 `GenericApplicationContext` 来说：

- 你可以在 `refresh()` 之前就开始往里注册 BeanDefinition
- 但那时容器还没真正激活

这也反过来解释了为什么它的 `refresh()` 只能成功完成一次：正因为 BeanFactory 早已内嵌存在，`refresh()` 不再承担“重新造一个全新的 BeanFactory”这类重建语义，它更像是在现有宿主上完成一次从加载世界到激活世界的单向切换。切换一旦完成，再重复刷新就不再是“再跑一遍启动链”这么简单，而会直接撞上这块内置宿主的状态边界。

这正是两段式模型最清楚的一种体现：

- 宿主先在
- 定义先装进去
- 最后 `refresh()` 再统一点火

也就是说，Spring 在这里不是“懒得在 refresh 里创建 BeanFactory”，而是在有意识地强调：

- **定义世界可以先于容器激活而存在。**

这就是为什么后面像 `registerBean(...)`、程序化注册、reader/scanner 注册这些动作，都能站在 `refresh()` 之前先发生。

## 三、`AnnotationConfigApplicationContext`：reader + scanner + register 三部曲不是小工具组合，而是注解世界的加载阶段骨架

只要从 Generic 骨架继续往上走，`AnnotationConfigApplicationContext` 最重要的差异就会出现：

- 它不再只是一块空宿主
- 它开始带上“怎么把注解世界装进去”的前置装载能力

这就是 reader + scanner + register 三部曲的意义。

很多人第一次看它时，会觉得：

- reader 注册一个类
- scanner 扫一些包
- 最后 refresh

这当然没错，但如果只停在这层描述，就会把它讲扁。

更准确地说，这三者本来就在扮演不同角色：

- reader 负责“我已经明确知道这个类，就是要注册它”
- scanner 负责“我现在还不知道有哪些类，先去发现它们”
- register 则把显式注册入口和扫描发现入口统一收束回 BeanDefinition 世界

也就是说，`AnnotationConfigApplicationContext` 真正提供的不是几个便利方法，而是：

- **注解世界在 refresh 之前的完整加载阶段骨架。**

这也解释了为什么它会成为最典型的现代 Spring 上下文实现。

因为它天然站在：

- `@Configuration`
- `@ComponentScan`
- `@Import`
- `@Bean`

这些前面几篇已经铺好的配置类主线上。

## 四、为什么 XML 路线看起来老，但它更能说明“加载阶段”和“激活阶段”确实是两段

如果说注解上下文太符合现代直觉，以至于容易被看成“本来就该这样”，那 XML 路线反而更能帮助我们看清 Spring 上下文体系的两段式本质。

因为在 `ClassPathXmlApplicationContext` 这里，加载阶段和激活阶段的边界会显得非常明确：

- 先有 XML Reader 把 `<bean>` 读成 `BeanDefinition`
- 再由 `refresh()` 用完全相同的总启动骨架去点亮容器

这一步特别重要，因为它说明：

- Spring 真正统一的不是配置写法
- 而是配置写法最终都要先降到同一个定义世界，再进入同一个激活骨架

也就是说，无论你前半段用的是：

- XML
- 注解
- 程序化注册

后半段真正启动容器的方式，都还是：

- 同一个 `refresh()`

这就是上下文实现体系最深的一层共同点。

所以 XML 路线不是“过时补充”，而是：

- **最能帮助你看懂加载阶段 / 激活阶段分界的一条对照线。**

## 五、`GenericWebApplicationContext`：Web 上下文真正增加的不是“能处理 Web”，而是“外部 Servlet 世界的桥接入口”

只要进入 Web 上下文，最容易犯的错误就是把它理解成：

- 普通上下文 + 多几个 Web 能力

这个理解太轻。

因为对 Spring 来说，Web 上下文真正新增的不是“更多功能菜单”，而是：

- **一条从外部 Servlet 世界回到 Spring 容器世界的桥。**

这条桥至少会牵涉：

- ServletContext 如何进入上下文
- request/session/application 这些作用域何时注册
- 外部请求上下文与 Spring 作用域主线如何重新接上

也就是说，Web 上下文最关键的差异不是“能跑网页”，而是：

- 它开始让外部容器语义变成 Spring 内部可以理解和消费的上下文条件

这和上一篇 scope 主线完全呼应：

- request/session scope 之所以能成立，本来就依赖 Web 世界先被桥接进来

所以 `GenericWebApplicationContext` 真正回答的不是“Web 功能怎么配”，而是：

- **Spring 容器在 refresh 之前，怎样先接住外部 Servlet 世界。**

这里也要把边界说清：它在这一层做的不是“已经启动 Web 容器”，而是先把 ServletContext、Web Scope 这类外部上下文条件挂进 Spring 容器宿主，好让后续 refresh 激活链能在一个已经具备 Web 语义的上下文里继续工作。真正的内嵌容器启动与 Boot/Tomcat 集成，是后面集成层的事，不该在这里混进来。

## 六、为什么这几种上下文实现的共同点，比它们的差异更重要

看到这里，很容易陷入另一种误区：

- AnnotationConfig 和 XML 不一样
- Web 又和它们都不一样
- 那 ApplicationContext 实现体系是不是就是各种路径并列摆一排？

这个理解仍然不够稳。

因为它会让你只看到“加载入口差异”，却看不到更深的共同结构。

对 Spring 来说，这几种实现真正共享的那一层，反而更重要：

- 它们都先负责把定义世界装进上下文骨架
- 然后都把最终激活动作交给同一个 `refresh()` 模板方法

也就是说，Spring 在这里真正坚持的不是：

- 所有上下文实现长得一样

而是：

- **所有上下文实现最终都要把定义世界降到同一 BeanFactory 世界，再交给同一条总启动链。**

这也就是为什么 ApplicationContext 实现体系在整卷里必须被单独成篇。

因为如果不把这层共性讲出来，读者会很容易误以为：

- AnnotationConfig、XML、Web 各有各的启动逻辑

而实际上，它们最大的差异只是前半段“怎么装定义”，不是后半段“怎么点亮容器”。

## 七、为什么这篇必须放在 `refresh()` 之后，而不是一开始就讲上下文实现列表

看到这里，最值得回收的一个问题就是：

- 为什么不在最开始就先把几个 ApplicationContext 实现类列表讲一遍？

因为如果没有前面十几篇已经铺好的世界，读者很难真正看懂这篇在讲什么。

这里也要先把卷内坐标再说清：本篇讲的是 **ApplicationContext 实现体系如何承接 refresh 之前的加载世界**，不是再回头重讲 BeanFactory 能力树本身。前面 BeanFactory 那篇回答的是“容器有哪些能力层”，而这一篇回答的是“这些能力在不同上下文实现里，怎样先被装进一个可交给 refresh 激活的宿主里”。

比如：

- 不先懂 `BeanDefinition`，就看不出 reader/scanner 注册的核心意义
- 不先懂 `refresh()`，就看不出“加载阶段 vs 激活阶段”的真正分界
- 不先懂 scope，就看不出 Web 上下文为什么必须桥接 Servlet 世界

也就是说，这篇不是类图导览，而是：

- 在总启动主线已经立住之后，反过来回答“这些定义世界一开始是怎么装进去的”

所以它必须放在 `refresh()` 之后，才能真正发挥作用。

## 八、几个最容易错的判断

### 1. `ApplicationContext` 实现之间最大的差异在于后面的启动逻辑不同

不成立。

它们最大的差异首先在 refresh 之前的定义加载入口，后面的激活骨架反而高度共享。

### 2. `GenericApplicationContext` 只是最简单、最没用的那个上下文实现

不成立。

它最重要的价值是把内置 BeanFactory 的上下文骨架先立起来，为程序化注册和前置加载阶段提供宿主。

### 3. `AnnotationConfigApplicationContext` 只是“注解版 XML 容器”

不完整。

它真正组织的是 reader + scanner + register 三部曲，把注解世界系统性装进定义世界。

### 4. Web 上下文只是普通上下文多几个 Web 字段

不成立。

它的关键在于把外部 Servlet 世界桥接回 Spring 定义与作用域体系。

### 5. 构造器调用和 `refresh()` 没有本质分工，都是在“启动容器”

不成立。

构造器和前置 register 更接近加载阶段，`refresh()` 才是真正把容器点亮的激活阶段。

## 收网：Spring 要统一的从来不是“提供几种上下文写法”，而是“不同定义加载入口如何共享同一条激活骨架”

现在可以回到开头那个问题：为什么前面已经讲了 `refresh()`，Spring 仍然还要有一整套 `ApplicationContext` 实现体系？

因为对 Spring 这种 IoC 容器来说，它真正要面对的不只是：

- 容器最后怎么启动

还包括：

- 定义世界一开始从哪里来
- 这些定义是通过注解、XML、程序化注册还是 Web 桥接进入的
- 上下文在 `refresh()` 之前怎样先把宿主和加载入口准备好

所以 Spring 的答案不是让每种上下文都自带一套启动链，而是建立一个清晰的两段式模型：

```text
ApplicationContext 实现体系
   -> 决定定义世界如何被加载进来

AbstractApplicationContext.refresh()
   -> 决定定义世界如何被统一激活成可用容器
```

因此，这篇真正该带走的结论不是“Spring 有几种常见 ApplicationContext 实现”，而是：

**Spring 把上下文问题从“换几种容器写法”提升成了“不同定义加载入口如何先装好定义世界，再共享同一条 refresh 激活骨架”的容器级协议。**

这也留下了下一篇最自然的问题：既然上下文骨架、配置类处理、条件装配都已经立住了，那真正负责“定义世界是否继续保留”的另一个高频入口——父子容器与层次可见性——在 ApplicationContext 级别又是怎样体现出来的？

也就是说，接下来最自然的继续点就是：

- parent application context
- child application context
- Web 根容器 / DispatcherServlet 子容器
- 为什么父子容器不是实现细节，而是应用架构边界

下一篇进入 Spring 的父子容器主线。