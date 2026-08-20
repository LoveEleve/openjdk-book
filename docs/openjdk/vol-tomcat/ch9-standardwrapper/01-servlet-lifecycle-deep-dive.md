# Servlet 生命周期在 Tomcat 里为什么会变成一整条实例管理链

> 本文基于 Tomcat 10.1.34 当前源码。本文只讲 `StandardWrapper` 这条线：Servlet 生命周期契约在 Tomcat 里为什么没有停在 `init -> service -> destroy` 三个结果语义上，而是被压成了 `loadServlet() / initServlet() / allocate() / deallocate() / unload() / unavailable` 这一整条实例管理链。Filter、Mapper、Session、async/error 等主线只作为边界背景，不在本文主叙事中展开。

## 为什么规范只讲三件事，Tomcat 却围着一个 Servlet 搭出了这么长一条链

从 Servlet 规范的表面视角看，Servlet 生命周期似乎并不复杂。

最容易被记住的只有三件事：

- 容器初始化 Servlet
- 请求到来时调用 `service()`
- 容器销毁 Servlet

如果只停在这个层面，Servlet 生命周期看起来像一个非常干净的三段式契约：

```text
init -> service -> destroy
```

这当然没错，但它只描述了外部结果，没有回答容器内部必须解决的一连串更具体的问题：

- 实例到底什么时候创建？
- 是不是每次请求都 new 一个？
- 多个请求并发来时，谁把“那个正确的实例”交给执行链？
- 初始化失败了怎么办？
- Servlet 暂时不可用时，请求为什么还会继续进来或者被拒绝？
- Context 停止或重载时，谁真正负责销毁和清理？

也就是说，规范给的是“容器最终必须兑现什么语义”，而实现层还必须回答“为了兑现这些语义，内部到底要怎么组织实例的一生”。

Tomcat 当前的答案，就集中压在了 `StandardWrapper` 这一条线上。

它不是只在容器树里记录“这个 URL 对应哪个 Servlet 类”，也不是一个单纯转发请求的末端节点。它更像一个实例管理中心：

- 负责持有或创建 Servlet 实例
- 负责初始化和分配
- 负责 unavailable 故障状态
- 负责在容器关闭或重载时销毁

所以，本文真正要回答的问题不是“`StandardWrapper` 里有哪些方法”，而是：

**为什么 Servlet 生命周期契约到了 Tomcat 这里，会展开成一条完整的实例管理链，而不是停留在 `init -> service -> destroy` 的表面结果上？**

## 先看失败方案：为什么不能把生命周期理解成三个回调

### 失败方案一：Servlet 生命周期无非就是 `init -> service -> destroy`

这是从规范视角出发最自然的理解。

它当然抓住了外部契约结果，但对容器实现来说远远不够。

因为一旦真正落到 Tomcat 当前实现里，立刻会碰到几个必须回答的问题：

- `service()` 调用之前，实例是谁创建的？
- 如果实例还没准备好，请求在何处等待或失败？
- `destroy()` 调用之前，是否还会有请求继续拿到这个实例？
- 如果初始化本身失败了，这个 Servlet 接下来处于什么状态？

也就是说，`init -> service -> destroy` 只是生命周期的外层契约，并不是容器内部的控制流程。

如果把 Tomcat 的 Servlet 生命周期压缩成这三步，后面所有关于分配、并发、故障状态、销毁边界的解释都会失去抓手。

### 失败方案二：`StandardWrapper` 只是容器树里的最后一个配置节点

从前面 `Mapper -> Valve -> FilterChain -> Servlet` 的执行主线看，`Wrapper` 很容易被理解成：

- 容器树最底层
- 最终对应一个 Servlet
- 请求最后会落到它

这个理解只抓住了“它是最终目标节点”，却没有抓住“它还是生命周期控制中心”。

在 Tomcat 当前实现里，`StandardWrapper` 不是一个被动标签，它还主动承担：

- 实例创建
- 初始化控制
- 请求分配
- 故障状态记录
- 销毁与卸载

所以它不是树底部一个静态配置点，而是 Servlet 实例生命史的管理者。

### 失败方案三：`allocate()`、`loadServlet()`、`initServlet()` 只是同一件事拆成多个方法

只看方法名时，很容易产生这种错觉：

- 最后目的都是把 Servlet 弄出来
- 拆这么细只是代码风格问题

这个理解同样不对。

因为这几个方法回答的是不同层次的问题：

- `loadServlet()`：实例怎样被真正创建出来
- `initServlet()`：规范要求的初始化语义何时兑现
- `allocate()`：请求到来时，当前链路拿到的是哪个实例

如果把这些动作糊成一步，后面很多关键问题就解释不通：

- 为什么初始化失败和分配失败不是一回事
- 为什么 unavailable 会影响后续请求分配
- 为什么 unload 也不是简单把字段置空

所以，这几步不是“多余拆分”，而是容器内部把生命周期契约压成可控流程时必须做的职责切分。

## Servlet 在 Tomcat 里的最小生命史总图

如果把这条链先压缩成最小模型，它大概可以写成下面这样：

```text
Wrapper config
   -> loadServlet()
   -> initServlet()
   -> allocate()
   -> service()
   -> deallocate()/unload()/unavailable
```

如果换一种更便于理解的拆法，这条链可以分成四段职责：

```text
[实例准备]
loadServlet()

   ->

[契约兑现]
initServlet()

   ->

[请求分配]
allocate() -> service()

   ->

[退出与故障]
deallocate() / unload() / unavailable
```

这张图最重要的价值，不是让读者背方法名，而是先把四个问题分开：

### 一、实例准备
回答：Servlet 实例是怎么被真正构造出来的？

### 二、契约兑现
回答：规范要求的初始化语义，容器是在什么时候兑现的？

### 三、请求分配
回答：请求到来时，执行链拿到的到底是哪个实例？

### 四、退出与故障
回答：实例什么时候退出？暂时不可用时又怎么影响后续请求？

只要先把这四段职责分开，`StandardWrapper` 为什么不是普通配置节点，就会变得清楚很多。

## 一、`StandardWrapper`：它首先是一个实例管理中心，而不是配置标签

`StandardWrapper` 的定义位置：

证据：`org/apache/catalina/core/StandardWrapper.java:80`

前面几篇已经说明过，`Wrapper` 在容器树里是最终落点。但在这一篇里，更重要的不是“它在树里的位置”，而是“它在实例生命史里的位置”。

更准确地说，`StandardWrapper` 至少同时承担两层角色：

- 从容器视角看，它是 `Context` 下面最终对应一个 Servlet 的节点
- 从生命周期视角看，它是 Servlet 实例的一生被组织起来的中心

这也是为什么只把它当“最后一层配置节点”会讲扁。因为一旦请求真的落到某个 Servlet，Tomcat 接下来面对的问题已经不再只是路由，而是：

- 实例是否已存在
- 是否已经初始化
- 当前能不能分配给请求
- 是否处于 unavailable 状态
- 是否该在容器关闭/重载时卸载

换句话说，`StandardWrapper` 不只是“知道哪个 Servlet 该被执行”，它还负责“管理这个 Servlet 在运行中的生命史”。

## 二、`loadServlet()`：实例真正被造出来的地方

生命周期契约里虽然有 `init()`，但它并不等于“实例已经存在”。在 Tomcat 当前实现里，实例真正被构造出来，要看 `loadServlet()` 这一步。

证据：`org/apache/catalina/core/StandardWrapper.java:735`

这一步的重要性在于：它回答的是比“初始化”更靠前的问题——

**这个 Servlet 对象到底什么时候被真正创建出来？**

也就是说，在规范的视角里：
- 我只关心容器最终会完成初始化

而在 Tomcat 的视角里：
- 在初始化之前，我必须先把实例拿到手
- 还要处理实例化、注解处理、相关上下文准备等问题

所以 `loadServlet()` 的存在证明了一件事：Servlet 生命周期在实现层不能直接从 `init()` 开始，因为 `init()` 之前还存在实例准备阶段。

这一步如果不单独讲，后面就很容易把“实例创建”和“规范初始化”混成一个动作。

## 三、`initServlet()`：规范语义不是一句口号，而要在正确时机被兑现

实例被造出来以后，还不等于生命周期契约已经兑现。因为规范要求的是：

- 容器要在合适时机完成初始化
- 之后请求处理才能进入稳定的 `service()` 阶段

所以在 Tomcat 当前实现里，`initServlet()` 不是和 `loadServlet()` 重复的一步，而是把“实例已经准备好”推进到“规范要求的初始化语义已兑现”的那一步。

证据：`org/apache/catalina/core/StandardWrapper.java:816`

也就是说，这里其实有一个非常重要的分界：

- `loadServlet()` 回答“对象有没有被造出来”
- `initServlet()` 回答“容器有没有把生命周期契约推到可服务状态”

这也是为什么前面在规范层里我们说：
- 生命周期契约是规范层问题
- `StandardWrapper + load/init/...` 是 Tomcat 当前实现问题

两者在这里正好严丝合缝地接上。

## 四、`allocate()`：请求到来时，到底是谁把实例交给执行链

如果说 `loadServlet()` 和 `initServlet()` 解决的是“实例有没有准备好”，那么真正和请求主线碰头的地方就是：

- `allocate()`

因为从执行链视角看，真正的问题不是“生命周期概念是否成立”，而是：

**请求已经走到这里了，现在究竟由谁把那个正确的 Servlet 实例交出来？**

这也是为什么 `allocate()` 特别关键。它不是“又一个生命周期方法”，而是实例生命史与请求执行链真正接触的交界点。

证据：`org/apache/catalina/core/StandardWrapper.java:558`

从这里开始，Tomcat 要面对的是更现实的问题：

- 当前实例是否已经可用
- 当前请求是否能拿到它
- 如果实例不可用，该怎样处理

所以，`allocate()` 的意义不在于“它也和实例有关”，而在于：

**它把生命周期管理正式接到了请求执行链上。**

也正因为如此，前面 Ch3 里讲 `StandardWrapperValve` 是容器链与执行链的边界点，到这一篇就可以再往下压实一层：

- `StandardWrapperValve` 负责把请求推进到 Servlet 末端世界
- `allocate()` 负责把真正可执行的实例交给这条链

## 五、`deallocate()`、`unload()` 与 unavailable：退出和故障为什么也是生命史的一部分

如果只讲到 `service()` 为止，Servlet 生命周期看起来就像一条单向向前推进的成功路径：

- 实例准备好
- 初始化完成
- 请求进来开始服务

但真实容器里，生命史从来不只包含成功路径。对 Tomcat 来说，至少还有两类很关键的后半段：

- **退出路径**：请求结束后如何归还，容器停止/重载时如何卸载
- **故障路径**：Servlet 暂时不可用时，后续请求如何受到影响

这也就是为什么：

- `deallocate()`
- `unload()`
- unavailable

不能被当成附属小尾巴。

更准确地说，它们共同回答的是：

**这个实例什么时候不该再继续被拿去服务请求？**

这里面其实有三种不同层次的语义：

- `deallocate()` 更接近“这次请求用完了，实例如何从当前执行上下文里退出”
- `unload()` 更接近“容器停止、重载或整体切换时，实例如何被销毁和清理”
- unavailable 更接近“实例虽然仍处在系统里，但当前请求分配是否应该被拒绝或延后”

证据：`org/apache/catalina/core/StandardWrapper.java:606`
证据：`org/apache/catalina/core/StandardWrapper.java:902`
证据：`org/apache/catalina/core/StandardWrapper.java:920`

一旦把这几层放在一起看，Servlet 生命周期就不再只是“出生—工作—死亡”的简单三段，而是一条带有故障分支和退出分支的真正生命史。

也正因为如此，unavailable 不能被看成一个顺手挂着的小状态。它是 Tomcat 用来表达“这个 Servlet 现在能不能继续被请求拿到”的关键信号。

## 到了这里，Servlet 生命周期已经不可能再被理解成三个回调了

现在可以回到开头那个最常见的误解：Servlet 生命周期是不是就是 `init -> service -> destroy`？

看到这里，这个理解已经不够用了。因为它只能描述最终外部可见的契约结果，却讲不清容器内部必须组织出来的完整生命史：

- 先准备实例
- 再兑现初始化语义
- 再在请求真正到来时分配实例
- 再在退出与故障分支里决定它如何继续存在、暂时不可用或被卸载

也就是说，Tomcat 并不是在“管理一个 Servlet 类”，而是在**管理一个 Servlet 实例如何被创建、启用、分配、拒绝、退出和销毁。**

这也是为什么 `StandardWrapper` 会长成一整套实例管理中心，而不是一个单纯配置节点。

## 这篇真正立住的，是“Servlet 的生命史”而不是“几个生命周期回调”

如果只从规范表面看，Servlet 生命周期非常容易被压缩成：

- `init()`
- `service()`
- `destroy()`

但从 Tomcat 当前实现归纳出来，更稳妥的理解方式应该是：

1. 规范规定的是生命周期语义必须成立
2. `StandardWrapper` 负责把这些语义压成实例管理链
3. `loadServlet()`、`initServlet()`、`allocate()`、`deallocate()`、`unload()`、unavailable 共同组成一条完整生命史
4. 所以 Servlet 生命周期不能只看回调结果，还要看容器如何在内部把这一生组织起来

这也是为什么这一篇必须作为机制补深层存在。因为只有把这一层压实，读者回看 Ch3 的执行闭环和 Ch8 的规范边界时，才会真正知道：

- 生命周期契约是什么
- Tomcat 当前又是怎么把它变成真实实例管理系统的

## 这篇之后，Tomcat 完整卷最自然的继续方向是什么

到这里，Tomcat 完整卷里“Servlet 生命周期”这一条纵深已经被拉开了。

如果继续往下写，最自然的方向有两个：

1. 继续补机制补深层：
   - `WebappClassLoaderBase` 与 WebApp 隔离
   - `Mapper` 四级匹配细化
   - Session 持久化 / 复制补篇

2. 开始进入生产层：
   - 性能调优
   - 安全运维
   - 故障排查

如果按当前路线图继续推进，更自然的下一步是：

- **`WebappClassLoaderBase` 与 WebApp 隔离**

因为到这里，容器主线、集成桥、规范边界、Servlet 生命周期都已经立住了，接下来最值得补的，就是 Tomcat 和很多普通内嵌 Web 框架真正拉开差距的一条线：类加载隔离。