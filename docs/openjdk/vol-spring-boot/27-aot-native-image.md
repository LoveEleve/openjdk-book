# 为什么 Native Image 不是把 JVM 应用直接“编译一下”：Boot AOT 如何把启动时装配提前变成生成代码

> 本文基于 Spring Boot 3.5.x、Spring Framework 6.2.x 与本机可用相关源码。本文承接前一篇虚拟线程支持，进入 Boot 补深层的 AOT / Native Image 主题。重点放在 `SpringApplicationAotProcessor`、Framework AOT 贡献、生成的 `__ApplicationContextInitializer`、运行时 AOT 检测，以及 Native Image 启动时如何跳过部分动态装配路径。本文不重复 GraalVM Native Image 编译器原理，也不重复 `vol-spring` 中 `BeanFactoryInitializationAotContribution` 的 Framework 机制，而聚焦 Boot 如何把 AOT 处理接到应用构建与运行入口。

## 为什么 Native Image 应用不能只是把现有 JVM jar 换一种方式打包

很多人第一次接触 Spring Boot Native Image 时，最容易形成的直觉是：

- JVM 应用已经能启动
- 那就把它编译成 native executable
- 运行时应该还是同一套动态启动流程

这个直觉忽略了 Native Image 最关键的约束：

- 很多运行时反射、动态代理、类路径扫描和资源发现，不能再像 JVM 模式那样随意发生
- 启动时临时做的大量容器分析，如果全部保留，Native Image 的启动和可达性模型会变得非常困难

也就是说，Native Image 并不是：

- 把 JVM 启动过程原封不动搬到另一个二进制里

而更像是：

- **把一部分原本在运行时完成的应用装配决策，提前在构建阶段分析并生成代码。**

第一层问题是：**Boot 启动时很多事情是动态完成的，但 Native Image 更需要构建阶段就知道这些事情。**

前面已经讲过 Boot 的启动主线：

- `SpringApplication.run()`
- Environment 准备
- 自动配置导入
- 条件裁决
- `refresh()`
- Bean 创建

在 JVM 模式里，这些步骤可以依赖：

- 反射
- 类路径资源
- 动态代理
- 运行时条件判断

而在 Native Image 模式里，越多动态路径被保留，越容易遇到：

- 反射不可达
- 代理未注册
- 资源未打包
- 初始化时机不兼容

所以 AOT 要做的不是简单优化，而是：

- **提前把容器启动所需的部分信息转化成构建产物。**

第二层问题是：**Boot 不能自己重新发明一套 AOT 容器，而必须把应用启动入口接到 Spring Framework 的 AOT 贡献体系。**

前面 `vol-spring` 已经讲过：

- Framework 会围绕 BeanFactory 初始化、BeanDefinition、RuntimeHints 等机制生成 AOT 贡献

Boot 这一层要解决的是：

- 如何从构建工具接收应用入口
- 如何创建 AOT 分析上下文
- 如何触发 Framework AOT 处理
- 如何把生成结果组织成应用可加载的 initializer

也就是说，Boot 的任务不是替代 Framework AOT，而是：

- **把应用构建流程与 Framework AOT 分析世界接起来。**

第三层问题是：**Native Image 运行时必须知道自己处于 AOT 生成路径，而不能继续无条件走普通动态启动路径。**

如果运行时已经有生成的 initializer，却仍然重复执行完整动态导入与扫描流程，会带来：

- 重复工作
- 运行时开销
- AOT 与 JVM 路径语义不一致

所以 Boot 必须在启动时明确判断：

- 当前是否使用生成 artifacts
- 是否应该加载 `__ApplicationContextInitializer`
- 是否应该跳过普通 source 加载路径

因此，本文真正要回答的问题不是“Boot 支持 GraalVM 吗”，而是：

**为什么对 Boot 来说，Native Image 必须通过 `SpringApplicationAotProcessor` 把 Framework AOT 分析接入构建阶段，再由运行时检测选择生成 initializer 路径，把部分动态容器装配提前转换成可执行生成代码。**

## 先看失败方案：为什么不能原封不动保留 JVM 动态启动、不能只靠 RuntimeHints、也不能把 AOT 当成一个编译插件黑盒

### 失败方案一：Native Image 继续完整执行 JVM 模式的动态启动流程

这是最自然的想法。

因为从应用行为看，大家都希望：

- Native 模式和 JVM 模式启动结果一致

但这不等于：

- 两者必须执行完全相同的动态路径

如果 Native Image 继续依赖大量运行时动态行为，就会面临：

- 反射元数据不完整
- 自动配置候选资源不可达
- 动态代理生成失败
- 启动成本和镜像分析复杂度增加

所以 Native Image 必须允许一部分决策在构建阶段提前完成。

### 失败方案二：只补 RuntimeHints，所有容器启动逻辑仍在运行时动态完成

RuntimeHints 很重要，但它解决的是：

- 哪些反射、资源、代理和序列化访问需要被保留

它不能完全替代：

- BeanDefinition 分析
- AOT 代码生成
- 应用上下文初始化路径

也就是说，RuntimeHints 是 Native 可达性的一部分，不是完整 AOT 启动方案。

### 失败方案三：把 AOT 当成构建插件黑盒，Boot 应用代码不需要理解生成结果

这会让排障变得非常困难。

因为一旦生成 initializer 缺失、生成代码和应用入口不一致或某个动态能力没有贡献进去，用户需要知道：

- 生成阶段分析了什么
- 运行时加载了哪个 initializer
- 为什么没有走普通 source 加载

所以 AOT 不能只是“插件执行成功或失败”，而应该被理解成：

- **应用启动路径的一次构建期重编排。**

## Boot AOT / Native Image 的最小总图

如果把这条链先压缩成最小模型，它可以写成下面这样：

```text
application sources
   -> SpringApplicationAotProcessor
   -> Framework AOT analysis/contributions
   -> generated __ApplicationContextInitializer
   -> Native Image build
   -> SpringApplication detects generated artifacts
   -> generated initializer starts context
```

如果再换一种更适合理解职责的拆法，它可以分成下面六层：

```text
[应用入口]
SpringApplication / application main class

   ->

[AOT 构建入口]
SpringApplicationAotProcessor

   ->

[Framework 分析]
BeanFactory / BeanDefinition / RuntimeHints contributions

   ->

[生成产物]
__ApplicationContextInitializer

   ->

[Native 构建]
GraalVM Native Image

   ->

[Native 启动]
AOT initializer path instead of full dynamic source path
```

这张图最重要的价值，不是背类名，而是把六个问题分开：

### 一、应用入口

回答：AOT 分析要围绕哪个 Boot 应用入口展开？

### 二、AOT 构建入口

回答：谁负责把应用构建过程接到 Spring AOT 分析？

### 三、Framework 分析

回答：哪些容器定义、运行时提示和初始化贡献会被分析？

### 四、生成产物

回答：为什么会出现应用专属的 initializer 类？

### 五、Native 构建

回答：生成代码怎样进入最终 native executable？

### 六、Native 启动

回答：运行时怎样选择生成 initializer，而不是重复走普通动态 source 加载？

## 一、`SpringApplicationAotProcessor`：Boot AOT 的关键不是“编译”，而是“把启动分析接入构建过程”

从 Boot 角度看，AOT 处理最重要的入口不是 GraalVM 命令本身，而是：

- `SpringApplicationAotProcessor`

它的职责不是替代 GraalVM 编译器，而是：

- 接收应用入口
- 创建合适的 AOT 分析上下文
- 调用 Framework AOT 处理链
- 生成应用启动相关代码和运行时提示

本地源码里它直接继承 `ContextAotProcessor`，并在 `prepareApplicationContext(...)` 中通过反射调用应用 main 方法；AOT 专用的 `SpringApplicationHook` 会在 `contextLoaded(...)` 时抛出 `AbandonedRunException`，把已经装配出的上下文交给 AOT 分析，而不是让构建进程继续完整运行应用。

也就是说，Boot 在这里承担的是：

- **应用级 AOT 编排入口。**

它把前面已经讲过的：

- `SpringApplication`
- ApplicationContext
- BeanFactory
- 自动配置

带进构建期分析世界。

## 二、为什么生成的是应用专属 initializer，而不是一份所有应用共享的启动代码

不同应用的定义世界并不相同：

- 配置类不同
- 自动配置命中结果不同
- BeanDefinition 不同
- RuntimeHints 需求不同

所以 AOT 不可能只生成一个完全通用的启动器。

它需要针对当前应用生成：

- 应用专属初始化代码
- 应用专属运行时提示
- 应用专属 Bean 注册和初始化贡献

这就是为什么 Native Image 运行时会寻找类似：

- `App__ApplicationContextInitializer`

这样的生成类。当前源码中，Boot 会以主应用类名拼接 `__ApplicationContextInitializer`；如果生成类不存在，会直接抛出 `AotInitializerNotFoundException`，而不是静默退回普通动态路径。

也就是说，AOT 的目标不是“给所有应用一个更快的 SpringApplication”，而是：

- **把当前应用已经分析得到的启动知识固化成当前应用自己的生成产物。**

## 三、为什么 Native 启动要区分普通 source 路径与生成 initializer 路径

只要生成 initializer 已经存在，运行时就面对一个重要选择：

- 继续走普通动态 source 加载
- 还是直接加载生成 initializer

Boot 必须把这两条路径分开。

因为普通 JVM 路径需要动态完成很多事情：

- 读取 source
- 解析配置类
- 处理自动配置导入
- 建立 BeanDefinition

而 AOT 路径已经把其中一部分决策提前生成了。

如果两条路径同时重复执行，就会造成：

- 重复注册
- 重复扫描
- 运行时成本增加
- 动态路径与生成路径冲突

当前 `SpringApplication.prepareContext(...)` 的源码边界更准确地说是：当 `AotDetector.useGeneratedArtifacts()` 为 true 时，Boot 会把生成 initializer 放到 initializer 列表前面，并跳过普通 `getAllSources()` / `load(...)` 这条 source 加载分支；这不是所有运行时动态行为都消失，而是应用 source 的常规装载路径被生成 initializer 接替。

所以 Native 启动必须明确：

- 当前是否使用 generated artifacts
- 如果使用，就把生成 initializer 放到 initializer 链
- 普通 source 加载是否需要跳过

## 四、为什么 AOT 不意味着所有动态能力都自动消失，而是把可分析部分提前固化

AOT 很容易被误解成：

- 运行时不再有任何动态行为

这并不准确。

更现实的理解是：

- 能在构建期分析和生成的部分，提前固化
- 仍然需要运行时事实的部分，继续保留运行时路径
- 通过 RuntimeHints 把 Native Image 需要的动态访问能力显式注册出来

也就是说，AOT 不是把 Spring 变成静态代码生成器，而是：

- **把启动中最适合提前分析的一部分转移到构建期。**

## 五、为什么 AOT 与前面自动配置主线并不矛盾

前面自动配置篇讲过：

- 候选配置发现
- 条件过滤
- BeanDefinition 导入
- `refresh()` 激活

AOT 并没有推翻这条模型。

它改变的是：

- 其中一部分分析和注册动作在什么时候完成

JVM 模式中，它们更多发生在运行时；
Native 模式中，很多结果可以在构建期生成。

所以 AOT 更准确的定位是：

- **同一套 Spring / Boot 装配语义的提前执行与代码化。**

## 六、最小源码证据：Boot 确实在构建期生成 initializer，并在 Native 启动时切换路径

如果只讲到这里，读者仍然可能会觉得：

- 这是不是只是 Native Image 的概念描述
- Boot 代码里有没有直接证据说明生成和运行切换真的存在

先看 Boot 的 AOT 处理入口：

```java
public class SpringApplicationAotProcessor extends ContextAotProcessor {

    @Override
    protected GenericApplicationContext prepareApplicationContext(Class<?> application) {
        return new AotProcessorHook(application).run(() -> {
            Method mainMethod = getMainMethod(application);
            mainMethod.setAccessible(true);
            ReflectionUtils.invokeMethod(mainMethod, null, new Object[] { this.applicationArgs });
            return Void.class;
        });
    }
}
```

来源：`spring-boot/src/main/java/org/springframework/boot/SpringApplicationAotProcessor.java:43-70`。

这证明第一层事实：

- Boot AOT 不是外部编译器孤立完成，而是接入 Framework `ContextAotProcessor`
- 构建期会以应用 main 入口准备上下文
- AOT hook 会在上下文加载后中止普通应用运行，把上下文交给生成分析流程

再看 `SpringApplication.prepareContext(...)` 的 Native 分支语义：

```java
addAotGeneratedInitializerIfNecessary(this.initializers);
applyInitializers(context);
...
if (!AotDetector.useGeneratedArtifacts()) {
    Set<Object> sources = getAllSources();
    load(context, sources.toArray(new Object[0]));
}
```

当 `AotDetector.useGeneratedArtifacts()` 为 true 时，Boot 会寻找应用对应的 `__ApplicationContextInitializer`；找不到就抛出 `AotInitializerNotFoundException`，找到后把它放到 initializer 链前面，并跳过普通 source 加载分支。

这证明第二层事实：

- Native 运行时确实会在“生成 initializer”与“普通动态 source”之间切换路径

也就是说，Boot AOT 的真实结构不是：

- “把 jar 编译成 native 就结束”

而是：

- **构建期分析生成应用启动代码，运行时再选择这条生成路径。**

## 七、为什么这篇适合作为虚拟线程之后的补深层主线

看到这里，最值得回收的一个问题就是：

- 为什么虚拟线程之后讲 AOT？

因为这两篇代表了 Boot 在运行时优化上的两个不同方向：

### 虚拟线程

- 不改变应用装配语义
- 改变部分任务执行的线程承载模型

### AOT / Native Image

- 不改变应用目标能力
- 改变部分应用装配与启动决策的完成时机

也就是说：

- 一个优化运行时并发承载
- 一个优化启动时动态分析与可执行产物

把它们连续放在一起，读者更容易区分：

- 性能模型优化
- 启动模型重编排

## 八、几个最容易错的判断

### 1. Native Image 只是把 JVM jar 换成 native 格式，启动流程完全不变

不成立。

AOT 会把一部分应用装配分析和初始化逻辑提前生成，并在运行时选择 generated initializer 路径。

### 2. `SpringApplicationAotProcessor` 就是 GraalVM 编译器

不成立。

它是 Boot 接入 Framework AOT 分析与生成流程的应用级入口，最终 native 编译由 Native Image 工具链完成。

### 3. RuntimeHints 就等于完整 AOT

不成立。

RuntimeHints 解决的是反射、资源、代理等可达性信息；AOT 还包含 BeanDefinition / 初始化贡献与生成代码。

### 4. AOT 模式下所有运行时动态行为都消失了

不成立。

AOT 固化的是可分析、可生成的部分，仍需运行时事实的能力依然保留。

### 5. AOT 和自动配置是两套互相冲突的机制

不成立。

AOT 更像是同一套 Boot / Framework 装配语义的构建期提前执行与代码化。

## 收网：Boot 统一的不是“把 JVM 应用编译成 native”，而是“把可分析的启动装配决策提前生成并在运行时切换到生成路径”

现在可以回到开头的问题：为什么 Native Image 不是把 JVM 应用直接编译一下？

因为真实发生的不是简单换一种二进制格式，而是一条构建期到运行期的装配重编排链：

```text
SpringApplication / application sources
   -> SpringApplicationAotProcessor
   -> Framework AOT contributions + RuntimeHints
   -> generated __ApplicationContextInitializer
   -> Native Image build
   -> AotDetector selects generated artifacts
   -> generated initializer starts application context
```

所以这篇真正该带走的结论不是“Boot 支持 Native Image”，而是：

**Boot 通过 `SpringApplicationAotProcessor` 把应用启动装配接入 Framework AOT 分析，在构建期生成应用专属 initializer 与运行时提示，再由 Native 启动路径检测 generated artifacts 并切换到生成初始化链；因此，Native Image 的核心不是换一种打包格式，而是把部分动态启动知识提前转化成构建产物。**