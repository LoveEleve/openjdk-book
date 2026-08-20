# 为什么 `@Service`、`@Repository`、`@Controller` 不只是换个名字：Spring 如何把语义元注解、候选扫描、校验分组和字段格式化接回容器主线

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring context 注解驱动主线的补充层：为什么 `@Component`、`@Service`、`@Repository`、`@Controller` 这些注解既共享组件候选语义，又保留不同的上层框架语义；为什么 `@Validated` 能把 Bean Validation 分组接入方法校验；为什么 `@DateTimeFormat` 最终要通过 Formatter SPI 接入数据绑定与类型转换。本文不重新展开配置类解析、MVC 请求主线或 AOP 基础，只负责把这几条看似分散的注解扩展桥接回前面已经建立的机制。

## 为什么几个看起来只是“语义标签”的注解，最后会牵动扫描、异常翻译、MVC 和校验

前面这卷已经讲过：

- 注解元数据如何通过元注解链被合并读取
- `@ComponentScan` 如何扫描候选并把结果放回定义世界
- `@Configuration`、`@Import`、`@Bean` 如何扩张配置类定义
- `BeanPostProcessor` 如何在实例生命周期各阶段切入
- `@Autowired` 如何通过 BPP 完成依赖注入

走到这里，Spring context 里还有一批经常被当成“小注解”的能力：

- `@Component`
- `@Service`
- `@Repository`
- `@Controller`
- `@Validated`
- `@DateTimeFormat`

它们看起来彼此差别很大：

- 前四个像是组件分类
- `@Validated` 像是校验配置
- `@DateTimeFormat` 像是日期格式声明

如果只从业务代码表面看，这种理解很自然。

但它们并不处在同一条运行时链上，而是三条不同的桥接线：

- stereotype 主要连接组件扫描与 BeanDefinition 注册
- `@Validated` 主要连接注解元数据与方法校验代理
- `@DateTimeFormat` 主要连接字段元数据与 Formatter / ConversionService 数据绑定

它们被放在同一篇里，不是因为它们会按同一条调用链连续执行，而是因为它们共同展示了“声明注解如何接入不同基础设施”的 Spring 设计。

但从 Spring 容器主线看，它们其实共同暴露了一个更深的问题：

**框架如何把声明式注解翻译成扫描资格、基础设施行为、方法校验和类型转换策略。**

第一层问题是：**`@Service`、`@Repository`、`@Controller` 不是简单的类名别名，而是共享 `@Component` 候选语义后，再由上层模块解释自己的角色。**

也就是说：

- `@Service` 首先要能被组件扫描发现
- `@Repository` 首先要能进入容器
- `@Controller` 首先要能成为 MVC 处理候选

但它们之后是否触发额外行为，又不是注解本身单独决定的。

第二层问题是：**`@Repository`、`@Controller` 的额外行为依赖其他基础设施，而不是注解自己暗中执行。**

例如：

- `@Repository` 的异常翻译要依赖 `PersistenceExceptionTranslationPostProcessor`
- `@Controller` 的请求映射注册要依赖 MVC 的 HandlerMapping 体系

这说明语义注解本身和行为基础设施之间存在明确边界：

- 注解提供声明信号
- BPP、扫描器或 MVC 基础设施负责兑现信号

第三层问题是：**`@Validated` 和 `@DateTimeFormat` 看起来属于 Web 或校验层，但它们最终又会回到 Spring 的通用元数据、代理和类型转换协议。**

也就是说：

- `@Validated` 会进入方法校验拦截器
- `@DateTimeFormat` 会进入 Formatter / ConversionService 数据绑定链

它们并不是孤立的功能注解，而是把外部契约接回 Spring 既有基础设施的桥。

因此，本文真正要回答的问题不是“这些注解分别有什么用”，而是：

**为什么 Spring 这些看似零散的注解，最终都必须被解释成既能进入候选扫描、又能接入后处理器、AOP、MVC 和类型转换体系的声明式控制信号？**

## 先看失败方案：为什么不能把 stereotype 当纯别名、把校验写死、把日期格式交给 Controller 自己解析

### 失败方案一：`@Service`、`@Repository`、`@Controller` 只是更好看的 `@Component` 别名

这是最常见的直觉。

因为从组件扫描角度看，它们确实都能被当成组件候选。

但如果把它们完全压成同一个别名，就会丢掉三个重要事实：

- `@Service` 表达业务服务层语义
- `@Repository` 表达数据访问层语义，并可能参与异常翻译
- `@Controller` 表达 MVC 处理入口语义

也就是说，它们共享候选资格，但不共享全部上层解释。

所以 Spring 的设计不是：

- 每个注解都重新发明一套组件注册机制

也不是：

- 所有注解最终都没有角色差异

而是：

**先共享 `@Component` 的最低层候选协议，再让不同基础设施按角色继续解释。**

### 失败方案二：`@Repository` 写上以后，异常翻译自然就自动发生

这个理解非常容易误导。

因为注解名称很像已经包含了行为：

- `@Repository` 既然表示仓储，那异常翻译应该自动发生

但 Spring 当前设计不是注解自己直接执行异常翻译，而是：

- `@Repository` 提供候选和角色元数据
- `PersistenceExceptionTranslationPostProcessor` 被注册后，才通过 BPP / Advisor 体系提供异常转换

这说明注解和基础设施之间不是“写上即执行”的关系，而是：

- **声明信号必须和兑现它的基础设施同时存在。**

### 失败方案三：日期格式直接在 Controller 里手工 parse，校验也在方法里自己 if

这看似简单，实际会把框架能力全部打散：

- 每个 Controller 自己选择日期格式
- 每个方法自己决定校验分组
- 错误格式和校验异常没有统一入口
- 同一 DTO 在不同入口的语义可能不一致

Spring 选择的是另一条路：

- 注解只声明格式和校验意图
- Formatter、ConversionService、MethodValidationInterceptor 负责统一兑现

这样业务方法只处理已经转换、已经通过指定校验边界的数据。

## Spring 这些注解扩展的最小总图

```text
annotation metadata
   -> candidate / role / validation / format signal
   -> scanner / BPP / AOP / Formatter SPI
   -> container or MVC behavior
```

可以分成四段：

```text
[组件候选]
@Component / @Service / @Repository / @Controller

   ->

[角色语义]
异常翻译 / MVC HandlerMapping / 业务层标识

   ->

[方法校验]
@Validated -> MethodValidationPostProcessor

   ->

[格式化绑定]
@DateTimeFormat -> Formatter SPI -> ConversionService
```

## 一、`@Component`：最底层共享的是候选资格，不是所有上层行为

`@Component` 是这些 stereotype 注解的共同地基。

它最关键的意义不是“让类变成 Bean”，而是给组件扫描提供一条稳定判断：

- 这个类是否具备组件候选资格

`@Service`、`@Repository`、`@Controller` 通过元注解链继承这一资格，所以扫描器可以在 ASM 元数据阶段识别它们，而不必要求每个类都直接写 `@Component`。

这正是前面注解元数据篇建立的“合并视图”在真实扫描器里的落地：

- `@RestController` 能沿元注解链抵达 `@Component`
- `@Service` 能被当成组件候选
- 组件注册得到 `ScannedGenericBeanDefinition`

同时，`@Indexed` 又把候选识别进一步连接到编译期索引机制：

- 编译期索引器可以根据候选注解生成 `META-INF/spring.components`
- 运行时扫描器在具备索引产物、且当前扫描路径使用索引的条件下，才可能借此减少全量 classpath 扫描
- 仅仅写了 `@Indexed`，并不等于运行时必然跳过所有扫描

这和前面 AOT 的“编译期前移”思路同源，但两者不是同一个机制：

- `@Indexed` 主要优化候选发现
- AOT 还会进一步前移容器初始化和注册逻辑

因此，`@Component` 首先代表的是：

**进入容器定义世界的最低层候选协议。**

## 二、`@Service`、`@Repository`、`@Controller`：共享候选协议，但不抹平角色语义

这三个注解都建立在 `@Component` 之上，但它们的角色语义不同。

- `@Service` 是服务层语义标记
- `@Repository` 是数据访问层语义标记
- `@Controller` 是 MVC 处理层语义标记

这里最重要的设计是：

- Spring 不要求每个角色注解重新实现组件扫描
- 但也不把角色注解压平为毫无意义的别名

`@Repository` 的异常翻译尤其能说明边界：

- 写了 `@Repository` 不代表异常翻译自动发生
- 只有对应的异常翻译基础设施被注册后，相关 BPP / Advisor 才会介入

`@Controller` 也类似：

- 注解让组件进入容器
- MVC 初始化链中的 HandlerMapping 再根据 Controller 语义发现其请求映射方法

真正注册 `@RequestMapping` 方法的，是 MVC 的 HandlerMapping / HandlerMethod 初始化流程，不是 `@Controller` 注解自身直接执行注册。

所以注解和行为之间始终隔着一层基础设施。

## 三、`@Validated`：校验分组是方法拦截语义，不是注解本身直接执行

`@Validated` 的价值在于，它为 Bean Validation 增加了分组语义：

- 创建请求校验一组约束
- 更新请求校验另一组约束

但注解本身不会主动校验。

Spring 通过 `MethodValidationPostProcessor` 注册方法校验 advisor / interceptor，调用方法时由 `MethodValidationInterceptor`：

- 读取 `@Validated` 的分组
- 调用 Validator 校验参数或返回值
- 失败时抛出约束异常

这里还要补一个失败边界：声明了 `@Validated` 并不等于任何调用都必然经过校验代理。最终是否形成代理，还取决于方法校验基础设施是否注册、Bean 是否被自动代理链处理，以及调用是否经过代理；同类内部自调用仍可能绕过代理。

这条链再次体现了前面的统一模式：

```text
@Validated
   -> 元数据
MethodValidationPostProcessor
   -> AOP 代理
MethodValidationInterceptor
   -> 校验执行
Validator
```

`@Valid` 本身不提供 Spring 式分组选择，通常表示按默认校验语义处理；`@Validated` 则是 Spring 提供的分组入口，可以声明 `Create`、`Update` 等校验组。

所以 `@Validated` 的核心不是“加了一个校验注解”，而是：

**把方法校验分组意图接入 Spring 的代理与 Validator 执行链。**

## 四、`@DateTimeFormat`：日期格式最终要进入 Formatter / ConversionService，而不是留在 Controller 里手工解析

`@DateTimeFormat` 表达的是字段或参数的格式语义：

- pattern
- iso
- style

但真正的转换执行由 Formatter SPI 完成：

- 传统 `Date` / `Calendar` 类型由相应日期 Formatter 处理
- `LocalDate` / `LocalDateTime` 等 Java Time 类型由 JSR-310 Formatter 处理
- 数据绑定过程再通过 `FormattingConversionService` 统一调用

所以这条主线不是：

- Controller 看到字符串后自己 parse

而是：

- WebDataBinder 读取字段元数据
- FormatterFactory 根据目标类型和注解选择 Formatter
- ConversionService 完成字符串与目标类型之间的转换

这与前面 `ConversionService` 篇直接接上了：

- `@DateTimeFormat` 提供声明
- Formatter SPI 提供策略
- ConversionService 提供统一转换入口

如果格式、locale 或目标类型不匹配，转换不会静默返回一个空值，而会沿数据绑定 / 类型转换错误路径向上暴露，例如表现为字段绑定失败或类型转换异常。也就是说，格式化链不仅定义成功转换，也定义了失败如何离开绑定流程。

## 五、为什么这几个小域必须放在前面主线之后收尾

这几个注解看似属于“重要但机制简单”的边缘域，但它们实际上是前面主线的交叉验证：

- stereotype 验证了元注解合并和组件扫描
- `@Validated` 验证了 BPP、AOP 与外部校验契约
- `@DateTimeFormat` 验证了注解元数据、Formatter 和 ConversionService

也就是说，它们不是新的独立架构，而是把前面已经建立的协议重新投影到常见使用场景里。

## 六、几个最容易错的判断

### 1. `@Service`、`@Repository`、`@Controller` 完全等价

不成立。

它们共享组件候选协议，但保留不同角色语义，由不同基础设施继续解释。

### 2. `@Repository` 自动开启异常翻译

不成立。

异常翻译依赖对应的 `PersistenceExceptionTranslationPostProcessor` 或上层自动配置。

### 3. `@Validated` 本身完成校验

不成立。

它提供分组元数据，实际校验由方法校验代理和 Validator 执行。

### 4. `@DateTimeFormat` 直接调用某个日期 parse 方法

不成立。

它通过 Formatter SPI 接入 `FormattingConversionService` 与数据绑定链。

## 收网：Spring 要统一的从来不是“几个注解名字”，而是“声明信号如何接入不同基础设施协议”

这些注解共同说明了 Spring 的一条稳定设计：

```text
声明注解
   -> 元数据合并与候选识别
   -> 扫描器 / BPP / AOP / Formatter
   -> 容器、校验或 Web 行为
```

因此，`@Component`、`@Service`、`@Repository`、`@Controller`、`@Validated`、`@DateTimeFormat` 不是互相孤立的注解清单，而是：

**Spring 把声明式意图接入定义注册、实例增强、方法校验和类型转换主线的多个桥接入口。**

这篇完成了 Spring context 注解驱动补层，也为后续 Spring MVC、AOP 和 Boot 自动配置继续复用这些机制打好了基础。
