# 为什么 Boot 不需要外部应用服务器：嵌入式 Servlet 容器自动装配如何把 Web 应用自己带起来

> 本文基于 Spring Boot 3.5.x 与 Spring Framework 6.2.x 当前源码。本文承接前一篇 Web MVC 自动装配，继续往更外层推进：既然 Boot 能把一个 MVC Web 应用默认装起来，那最外层承载 HTTP 请求的 Servlet 容器到底是谁创建、谁配置、谁和 ApplicationContext 接起来？重点放在 `ServletWebServerFactoryAutoConfiguration`、Tomcat/Jetty/Undertow 工厂、`ServletWebServerApplicationContext` 与 WebServer 创建桥接。下一篇将继续进入 `DispatcherServlet` 注册与默认映射细节。

## 为什么明明没有外部 Tomcat，也没有手工部署 WAR，Boot Web 应用却还是自己跑起来了

只要用过 Spring Boot Web 应用，几乎都会有一个强烈的感受：

- 没有单独安装外部 Tomcat
- 没有把 WAR 包部署到应用服务器
- 甚至都没有显式写任何容器创建代码
- 应用却依然能监听端口、接请求、返回响应

这件事熟悉到很容易被当成理所当然。

但如果退回到传统 Servlet 应用世界，这其实是一个很大的变化。

因为在传统模型里，很多事情通常由外部容器承担：

- Servlet 容器进程本身先启动
- 应用被部署进去
- ServletContext、Servlet、Filter 注册在容器启动期完成

也就是说，应用默认并不“自带容器”。

而到了 Boot 世界，结构被倒了过来：

- **应用自己带着容器依赖、容器工厂和容器配置启动起来。**

第一层问题是：**Web MVC 自动装配默认成立，不代表最外层 HTTP 容器已经自动存在。**

前一篇已经说明：

- MVC 默认体验是协同自动配置结果

但那主要是在应用内部世界里成立的：

- `DispatcherServlet`
- MVC 基础设施
- 消息转换器
- 静态资源与默认 Web 行为

这些东西都默认依赖一个更外层前提：

- 已经有一个正在运行的 Servlet WebServer

也就是说，MVC 自动装配不是从空气里接请求，它必须落在一个已经被创建出来的容器上。

第二层问题是：**Boot 不能把 Tomcat、Jetty、Undertow 写死成唯一容器，而必须先抽象一个工厂层。**

如果 Boot 直接把容器创建逻辑写死在某个 Tomcat 专用流程里，后面马上就会出现问题：

- Jetty 怎么接
- Undertow 怎么接
- 用户怎么通过替换 starter 切换实现
- 共性的 server properties 又该落在哪一层

所以 Boot 需要先建立：

- `ServletWebServerFactory`

也就是说，容器创建在 Boot 这里首先不是“直接 new Tomcat”，而是：

- **先建立一个 Servlet WebServer 工厂抽象，再让具体容器实现往里挂。**

第三层问题是：**容器自动装配的关键，不只是创建工厂 Bean，而是把它和 `ServletWebServerApplicationContext` 的启动时机接起来。**

这是本篇最重要的边界。

因为哪怕容器工厂 Bean 已经存在，如果没有一个地方在合适时机真正调用它：

- WebServer 还是不会启动
- 端口也不会监听
- ServletContext 也不会建立

也就是说，Boot 在这里要解决的不只是：

- “容器配置怎么出现”

而是：

- **容器工厂怎样在 ApplicationContext 启动过程中被真正调用，创建出可运行的 WebServer。**

因此，本文真正要回答的问题不是“Boot 默认用 Tomcat”，而是：

**为什么对 Boot 来说，必须先通过 `ServletWebServerFactoryAutoConfiguration` 把容器实现抽象成工厂 Bean，再由 `ServletWebServerApplicationContext` 在启动过程中把这个工厂调用起来，整个 Web 应用才算真正具备可监听端口、可承载 Servlet 世界的外层运行环境。**

## 先看失败方案：为什么不能把 Tomcat 直接写死、不能只创建工厂不真正启动容器、也不能把容器启动和 ApplicationContext 脱开

### 失败方案一：Boot 只支持 Tomcat，把容器逻辑直接写死在主链里

这是最容易想到、也最粗暴的做法。

因为从默认体验看，Tomcat 确实是最常见路径。

但只要这么做，Boot 很快就会失去它最重要的一个优点：

- 容器实现可替换

用户将无法自然地：

- 用 Jetty 替代 Tomcat
- 用 Undertow 替代 Tomcat
- 在同一套 Boot Web 启动协议下切换实现

而这正是 Boot 一直想守住的能力：

- 同一套应用装配模型，不绑定唯一容器实现

所以 Boot 必须先抽象出容器工厂层，而不能把 Tomcat 写死进整个启动门面。

### 失败方案二：自动配置只负责创建一个容器工厂 Bean，至于容器什么时候启动以后再说

这个方案比第一种更像框架设计，但仍然不够。

因为工厂 Bean 的存在只说明：

- 现在有能力创建容器了

却不说明：

- 容器已经真的被创建出来了
- 端口已经监听了
- ServletContext 已经成立了

也就是说，光有工厂还不够，Boot 还必须有一个明确时机去调用工厂，把：

- Bean 级能力

推进成：

- 运行中的 WebServer 实例

否则整个 Web 应用仍然只停留在“理论上可以有容器”的状态。

### 失败方案三：容器自己启动，ApplicationContext 自己 refresh，双方靠约定偶然汇合

如果再往后退一步，也许会有人想：

- 那就让容器和上下文各跑各的
- 最后通过某种监听关系接起来

这个方案最大的问题是：

- 容器启动时机和上下文激活时机会失去统一控制

后果包括：

- ServletContext 何时可用会变得模糊
- `DispatcherServlet`、Filter、Listener 注册时机容易错位
- WebServer 生命周期和 ApplicationContext 生命周期难以保持一致

所以 Boot 不能容忍“容器和上下文各管一半”，而必须让它们落在同一条启动主线上。

## 嵌入式 Servlet 容器自动装配的最小总图

如果把这条链先压缩成最小模型，它可以写成下面这样：

```text
starter-web
   -> servlet container implementation on classpath
   -> ServletWebServerFactoryAutoConfiguration
   -> ServletWebServerFactory bean
   -> ServletWebServerApplicationContext
   -> createWebServer()
   -> running embedded servlet container
```

如果再换一种更适合理解职责的拆法，它可以分成下面五层：

```text
[依赖前提]
Tomcat / Jetty / Undertow starter 进入 classpath

   ->

[工厂抽象]
ServletWebServerFactory

   ->

[具体工厂自动配置]
TomcatServletWebServerFactory / Jetty / Undertow

   ->

[上下文桥接]
ServletWebServerApplicationContext

   ->

[运行时容器]
createWebServer() -> WebServer 实例 + 端口监听 + ServletContext
```

这张图最重要的价值，不是背类名，而是把五个问题分开：

### 一、依赖前提

回答：为什么只要 starter 一换，容器实现也可以跟着换？

### 二、工厂抽象

回答：为什么 Boot 必须先抽象 `ServletWebServerFactory`，而不是直接面向 Tomcat 编码？

### 三、具体工厂自动配置

回答：Tomcat / Jetty / Undertow 的具体工厂 Bean 是怎样按条件出现的？

### 四、上下文桥接

回答：谁负责在 ApplicationContext 启动过程中真正调用这个工厂？

### 五、运行时容器

回答：什么时候应用才算真正拥有一个可运行的 Servlet WebServer？

## 一、starter 先改变的是容器实现的 classpath 事实，而不是直接启动容器

上一篇已经讲过 starter 的本质：

- 它首先是依赖入口

所以回到嵌入式容器场景，第一步仍然不能直接问：

- Tomcat 为什么启动了

而要先问：

- 为什么 Boot 现在有资格选择并创建某种 Servlet 容器

以最常见的默认路径为例，`spring-boot-starter-web` 通过依赖聚合会把：

- `spring-boot-starter-tomcat`

带进来。

这意味着：

- Tomcat 相关实现类现在在 classpath 上可见
- Tomcat 专用的自动配置条件有机会命中

这里特别要说准：starter 到这一步做的仍然不是“启动 Tomcat”，而是：

- **先把某种容器实现变成可被自动装配选择的候选。**

## 二、为什么 Boot 必须先抽象 `ServletWebServerFactory`

只要 classpath 前提已经成立，Boot 下一步必须面对的问题就是：

- 容器创建逻辑到底该怎么抽象

如果没有工厂抽象，Boot 后面很快就会被具体实现细节绑死。

而一旦引入：

- `ServletWebServerFactory`

整个问题就被改写成了：

- 当前应该创建哪种 Servlet WebServer 工厂 Bean
- 后续统一由谁调用这个工厂

也就是说，Boot 在这一层解决的不是“哪种容器最好”，而是：

- **先把容器创建收口成一个稳定接口。**

这样，后面的启动协议才能继续保持统一：

- 外面看到的是同一套 WebServer 创建语义
- 里面才由不同工厂去落到 Tomcat、Jetty 或 Undertow

## 三、`ServletWebServerFactoryAutoConfiguration`：它先决定“工厂层”怎么进入容器

如果说 starter 改变的是 classpath 前提，`ServletWebServerFactory` 是抽象层，那么真正把它们接进容器的关键自动配置就是：

- `ServletWebServerFactoryAutoConfiguration`

它的关键价值不在于自己直接启动了容器，而在于：

- 把“嵌入式 Servlet 容器工厂”这件事正式引入自动配置世界

也就是说，Boot 在这里先解决的是：

- 当前应用是不是 Servlet Web 应用
- 当前 classpath 上有没有对应容器实现
- 应该把哪条具体工厂配置路径导入容器

这一步看起来像“只是多了一个工厂 Bean”，但它实际上完成的是：

- **从依赖前提到容器创建能力的第一次落地。**

## 四、Tomcat / Jetty / Undertow：同一套抽象下的不同工厂实现

只要工厂层已经被引入，后面的具体差异就可以被安放到各自的实现路径里。

以最常见的 Tomcat 路径来说，最终会出现的是：

- `TomcatServletWebServerFactory`

如果切换 Jetty 或 Undertow，对应则会是：

- `JettyServletWebServerFactory`
- `UndertowServletWebServerFactory`

这一步最重要的不是记住类名，而是理解 Boot 的分层取舍：

- 应用代码面对的是统一的 `ServletWebServerFactory` 抽象
- 具体容器差异被包进不同工厂实现和各自定制器里

也就是说，Boot 不是消灭容器差异，而是：

- **把容器差异约束在工厂实现层。**

这样用户既能享受统一启动模型，又能在需要时切换底层容器。

## 五、为什么光有工厂还不够：真正把容器拉起来的是 `ServletWebServerApplicationContext`

到这里是本篇最关键的一步。

因为很多人读到容器自动配置时，容易停在：

- 工厂 Bean 已经有了

然后下意识觉得：

- 那容器自然就启动了

这中间其实还隔着最关键的一跳：

- 谁去调用这个工厂？

Boot 给出的答案不是某个独立启动线程，也不是某个外部部署器，而是：

- `ServletWebServerApplicationContext`

也就是说，容器启动这件事最终被挂回了：

- ApplicationContext 的启动主线

这一步特别关键，因为它保证了：

- WebServer 生命周期和 ApplicationContext 生命周期被绑在一起
- ServletContext 建立时机与后续 Servlet / Filter / Listener 注册语义保持一致语境
- 整个 Web 应用从里到外都服从同一条启动协议

这里也要把先后关系说准：`createWebServer()` 发生在 `onRefresh()`，但具体的 Servlet / Filter / Listener 真正注册到容器里，还要依赖后续通过 `ServletContextInitializer` 进入容器启动过程，而不是在这一行代码之前就全部完成。

所以真正让嵌入式容器“活起来”的，不只是自动配置类，而是：

- **自动配置给出工厂，`ServletWebServerApplicationContext` 在启动过程中真正把工厂调用起来。**

## 六、什么时候应用才算真正拥有了嵌入式 Servlet 容器

从用户视角看，“容器启动了”往往是一句很粗的描述。

但从这条装配链看，更准确的完成标志应该是：

- `ServletWebServerApplicationContext` 已经调用工厂创建出 `WebServer`
- 端口开始监听
- `ServletContext` 已经建立
- 后续 `DispatcherServlet`、Filter、Listener 等注册链有了真正落点

也就是说，只有到了这里，前面几篇讲过的：

- Web starter
- MVC 自动装配
- `DispatcherServlet` 默认体验

才算真正拥有了一个外层运行壳。

否则它们都还只是“应用内部已经准备好”，却没有真正对外承载 HTTP。

## 七、最小源码证据：这条链确实是“工厂自动配置 + 上下文桥接”，不是 Tomcat 自己偷偷跑起来

如果只讲概念，读者仍然可能会觉得：

- 这是不是只是对启动现象的事后解释
- 源码里有没有更直接的证据说明“工厂”和“上下文桥接”分别存在

先看 `ServletWebServerFactoryAutoConfiguration` 的条件入口：

```java
@AutoConfiguration(after = SslAutoConfiguration.class)
@AutoConfigureOrder(Ordered.HIGHEST_PRECEDENCE)
@ConditionalOnClass(ServletRequest.class)
@ConditionalOnWebApplication(type = Type.SERVLET)
@EnableConfigurationProperties(ServerProperties.class)
@Import({ ServletWebServerFactoryAutoConfiguration.BeanPostProcessorsRegistrar.class,
        ServletWebServerFactoryConfiguration.EmbeddedTomcat.class,
        ServletWebServerFactoryConfiguration.EmbeddedJetty.class,
        ServletWebServerFactoryConfiguration.EmbeddedUndertow.class })
public class ServletWebServerFactoryAutoConfiguration {
```

它证明了第一层事实：

- 这条自动配置只在 Servlet Web 场景成立
- 它并没有把容器写死为一种实现，而是并列导入 Tomcat / Jetty / Undertow 的工厂配置路径
- `ServerProperties` 也在这一层被接入容器配置世界

再看 `ServletWebServerApplicationContext` 对工厂的实际调用：

```java
protected void onRefresh() {
    super.onRefresh();
    try {
        createWebServer();
    }
    catch (Throwable ex) {
        throw new ApplicationContextException("Unable to start web server", ex);
    }
}
```

以及：

```java
private void createWebServer() {
    WebServer webServer = this.webServer;
    ServletContext servletContext = getServletContext();
    if (webServer == null && servletContext == null) {
        StartupStep createWebServer = getApplicationStartup().start("spring.boot.webserver.create");
        ServletWebServerFactory factory = getWebServerFactory();
        this.webServer = factory.getWebServer(getSelfInitializer());
        createWebServer.tag("factory", factory.getClass().toString());
        createWebServer.end();
        getBeanFactory().registerSingleton("webServerGracefulShutdown",
                new WebServerGracefulShutdownLifecycle(this.webServer));
        getBeanFactory().registerSingleton("webServerStartStop",
                new WebServerStartStopLifecycle(this, this.webServer));
    }
```

这两段代码共同证明：

- 自动配置先负责把 `ServletWebServerFactory` 这类工厂能力放进容器
- 真正调用工厂创建 `WebServer` 的时机，挂在 `ServletWebServerApplicationContext.onRefresh()` 里
- 创建完成后，Boot 还会顺手注册 `webServerGracefulShutdown` 和 `webServerStartStop` 这类生命周期 bean
- 嵌入式容器不是外部偷偷启动，而是被绑进 ApplicationContext 启动协议里

也就是说，Boot 的嵌入式容器世界并不是：

- “Tomcat 自己跑起来了”

而是：

- **容器工厂先被自动装配，再在 Web ApplicationContext 的刷新过程中真正变成运行中的 WebServer。**

## 八、为什么这篇必须放在 `DispatcherServlet` 注册细节之前

看到这里，最值得回收的一个问题就是：

- 为什么不先讲 `DispatcherServlet` 默认映射与注册，再讲嵌入式容器？

因为如果外层容器还没立住，后面很多 Servlet 注册语义都没有真正落点。

也就是说：

- `DispatcherServlet` 注册到哪去
- `ServletContextInitializer` 到底什么时候被调用
- Filter / Listener 为什么能在容器启动期接进去

这些问题都必须建立在：

- 已经存在一个由 ApplicationContext 拉起来的嵌入式 Servlet 容器

这个前提上。

所以顺序上，先讲“容器怎么自己带起来”，再讲“Servlet 怎么注册进去”，读者才能看见完整桥接链。

## 九、几个最容易错的判断

### 1. Boot 的嵌入式容器本质上就是默认偷偷帮你起了一个 Tomcat

不完整。

默认路径常常是 Tomcat，但真正结构是：starter 提供依赖前提，工厂自动配置提供创建能力，`ServletWebServerApplicationContext` 在启动过程中真正调用工厂。

### 2. `ServletWebServerFactoryAutoConfiguration` 自己就完成了容器启动

不成立。

它主要负责把工厂层带进容器；真正调用工厂创建 `WebServer` 的是 `ServletWebServerApplicationContext`。

### 3. 只要有了 `ServletWebServerFactory` Bean，容器就已经算启动了

不成立。

工厂 Bean 只说明“具备创建能力”，不说明端口已监听、`ServletContext` 已建立。

### 4. Boot 的 Web 容器路径和 ApplicationContext 启动主线没什么关系

不成立。

恰恰相反，容器启动被明确挂在 `ServletWebServerApplicationContext.onRefresh()` 里，与上下文刷新主线紧密耦合。

### 5. Jetty / Undertow 只是另外两种依赖，Boot Web 启动逻辑其实只围绕 Tomcat 设计

不成立。

Boot 先抽象统一工厂层，再通过不同工厂实现容纳具体容器差异，Tomcat 只是默认最常见路径。

## 收网：Boot 统一的不是“如何默认使用 Tomcat”，而是“如何把 Servlet 容器能力收编进应用自己的启动协议”

现在可以回到开头的问题：为什么 Boot 不需要外部应用服务器，Web 应用却还是自己带起来了？

因为 Boot 真正做的不是“把外部 Tomcat 偷偷内置”，而是：

```text
starter 带来容器实现依赖
   -> ServletWebServerFactoryAutoConfiguration 提供工厂能力
   -> ServletWebServerApplicationContext 在 refresh 过程中调用工厂
   -> WebServer 创建、端口监听、ServletContext 建立
   -> MVC / DispatcherServlet / Filter / Listener 等有了外层运行壳
```

所以这篇真正该带走的结论不是“Boot 默认有 Tomcat”，而是：

**Boot 先把 Servlet 容器抽象成 `ServletWebServerFactory` 工厂层，再由 `ServletWebServerApplicationContext` 在 ApplicationContext 启动协议中真正把工厂调用起来；因此，嵌入式容器不再是外部部署前提，而是 Boot 应用自己携带并启动的外层运行环境。**

下一篇进入 `DispatcherServlet` 注册与默认映射：既然外层容器已经自己带起来，那 `DispatcherServlet` 到底怎样被默认注册进这个容器，又为什么最终会映射到 Boot Web 应用的默认请求入口。