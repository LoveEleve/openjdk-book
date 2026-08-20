# 03. 既然 `as.sh <pid>` 已经能进 JVM，为什么 Arthas 还要自 attach？——外部 attach、Starter 与“多入口，单系统”

> 基于 `arthas` 当前源码实现讨论；本文聚焦外部 attach 与 Spring Boot starter 自 attach 两条入口，不重复展开 `AgentBootstrap`、`ArthasClassloader`、`SpyAPI` 的内部细节，也不把 bind/tunnel/destroy 写成本篇主线。
> **前置依赖**：[02 —— Arthas 进了 JVM，为什么既不和业务依赖打架，又能让所有增强代码找到同一个入口？](../01-startup-attach/02-bootstrap-spyapi.md)：知道 Arthas 住进目标 JVM 后如何装配出单例、隔离类加载器与全局 Spy 入口。
> → **机制回指**：[04 —— Arthas 明明已经进 JVM 了，为什么你还可能连不上？](../01-startup-attach/04-bind-destroy.md)：两条入口最终都会汇合到同一套 bind/destroy 生命周期。
> 关联域：36-attach、47-instrumentation、Spring Boot 生命周期。
> 本篇源码锚点均已回对，不靠猜。

## 先看一个真正的选择题：既然 `as.sh <pid>` 已经能进 JVM，为什么还要 Starter 自 attach

场景：前几篇已经把 Arthas 的基本寄生链讲清楚了：外部 JVM 可以通过 `VirtualMachine.attach()` + `loadAgent(...)` 把 Arthas 打进一个已经运行中的目标 JVM。按直觉看，这条链好像已经够用了。

可一旦把现场拉回真实工程，两个方向完全不同的需求会同时冒出来：

- 有时候你面对的是一个**已经在线上跑起来**、又不能重启的 JVM，这时最需要的是临时、低耦合地进去；
- 有时候你面对的是一个**从一开始就希望常驻诊断能力**的 Spring Boot 服务，这时你更希望它在应用启动时就把诊断能力带上，而不是依赖运维后续再拿 PID 去挂。

于是问题立刻分叉：

```text
一种入口不够
  → 那就加另一种入口？
    → 可入口一多，目标 JVM 里会不会变成两套 Arthas？
```

所以本篇真正要回答的不是：

> Arthas 还有哪些 attach 方式？

而是：

> **既然外部 `as.sh <pid>` 已经能进 JVM，为什么还需要 starter 自 attach；而既然入口不同，为什么目标 JVM 内又绝不能跑出两套 Arthas 系统？**

先把全篇总图立住：

```text
入口一：外部控制面
  shell → as.sh → 外部 JVM → Attach API → 目标 JVM

入口二：进程内控制面
  Spring Boot 启动链 → ByteBuddyAgent.install() → 当前 JVM

两条入口都只解决“谁来发起进入”
                ↓
最终都必须汇合到同一个 ArthasBootstrap 单例
                ↓
同一套 Spy / Transformer / bind / destroy 生命周期
```

这张图里最重要的一刀就是：

```text
入口可以多样化
寄生系统必须单一化
```

后面所有细节，都围绕这条边界展开。

---

## 一、先排除两个最直觉、也最容易把系统搞乱的方案

### 1.1 错觉一：既然外部 attach 能用，那就没必要再搞自 attach

外部 `as.sh <pid>` 的确很强：

- 不改业务启动参数；
- 目标 JVM 已经在跑，也能临时进入；
- 非常适合线上救火、临时排查、批量挂载。

所以一个很自然的直觉就是：

> 有了外部 attach，为什么还要多维护一条 starter 自 attach？

这个想法的问题在于，它默认把所有诊断场景都看成“先把服务跑起来，等出事了再去挂工具”。但有些场景并不满足这个假设：

- 你想让应用**启动后就带着诊断能力**常驻运行；
- 你希望把诊断系统纳入应用自己的生命周期与配置中心；
- 你不想依赖外部机器、人工 PID、额外运维流程，尤其在某些平台化部署里，应用自己最知道何时初始化诊断能力。

也就是说，外部 attach 解决的是：

```text
运行中的 JVM，怎样低耦合地临时进门
```

而它并不自动覆盖：

```text
应用启动期，怎样把诊断能力一起带进来
```

### 1.2 错觉二：入口都不同了，那各自跑一套系统也没关系

第二个更危险的直觉是：

> 既然外部 attach 和 starter 自 attach 的入口这么不同，那干脆让它们各自维护一套 Arthas 系统。

这个想法听起来很“模块化”，但一进目标 JVM 就会出大问题：

- 两套服务端可能争抢端口；
- 两套 Transformer 可能重复增强同一批类；
- 两套 Spy 可能争全局入口；
- 两套 lifecycle 会让 stop、reset、destroy 根本不知道该撤谁。

也就是说，入口差异只允许存在于**控制面**，一旦进入目标 JVM 的寄生系统层，就必须立刻收束成单一实例。否则你得到的不是“灵活入口”，而是“同一 JVM 内多套诊断系统互相踩踏”。

所以本篇最需要先记住的一句话是：

**Arthas 可以允许多种“进门方式”，但绝不能允许多套“住下来的系统”。**

---

## 二、第一层：外部 attach 解决的是“低耦合进入已运行 JVM”

### 2.1 外部 attach 的真正价值，不是 shell，而是控制面在 JVM 外

外部 attach 链在前几篇已经见过：

- `bin/as.sh:893-899` 启动独立 JVM 执行 `arthas-core.jar -pid <pid>`；
- `Arthas.java:103-126` 里调用 `VirtualMachine.attach(pid)` 与 `loadAgent(...)`；
- 目标 JVM 内由 `agent334/AgentBootstrap.java:67-99` 接住这次注入。

把它压成一句话就是：

```text
外部 attach = 控制面在 JVM 外，数据面在目标 JVM 内
```

这条设计特别适合“目标 JVM 已经在跑，但我现在才需要诊断”的场景。因为它把进入能力放在了一个**独立于业务进程之外**的控制面上：

- 你不用改应用启动参数；
- 你不用让应用自己提前知道 Arthas；
- 你只需要 PID 和相应权限，就能在业务进程外发起这次寄生。

关键设计（斜体）：*外部 attach 的核心价值不是“有个 shell 脚本”，而是让诊断能力的发起者留在业务 JVM 外部。*[模式: 外部控制面 + 目标进程数据面] 这样临时排查和业务运行时生命周期就不会绑死在一起。

### 2.2 为什么这条路径特别适合临时排查与批量挂载

一旦控制面在 JVM 外部，很多场景自然就顺了：

- 临时排查：不改启动参数，出事了再进；
- 批量挂载：脚本/平台能遍历 PID 去挂；
- 低耦合：应用本身不需要知道 Arthas 的存在。

这也是为什么 `--attach-only`、tunnel、bind/destroy 这些能力都优先沿外部 attach 这条链形成工程习惯：它天生就是为“应用先跑起来，诊断后进入”服务的。

但它的边界也很清楚：如果你希望 Arthas 作为应用启动能力的一部分常驻存在，仅靠外部控制面就不够顺手了。

---

## 三、第二层：自 attach 解决的是“在应用启动期就把诊断能力带进来”

### 3.1 为什么 starter 不需要另一个外部 JVM

Spring Boot starter 的路径和外部 attach 最大的不同，不在于“它会不会也调用某些 attach API”，而在于：**它把控制面直接放回了业务 JVM 自己的启动链里。**

`arthas-agent-attach/ArthasAgent.java:88-134` 是 starter 初始化主体。它不是先去起一个外部 JVM，而是在当前进程里直接调用：

```java
ByteBuddyAgent.install()
```

对应 `ArthasAgent.java:90`，它在当前进程内拿到 `Instrumentation`。这就是 starter 路径的根本特征：**Instrumentation 不再由外部 Attach API 送进来，而是在业务 JVM 自己的启动期获得。**

### 3.2 为什么这条路径天然更靠近业务启动链

starter 不只是在当前进程拿到 `Instrumentation`，还会做两件非常“内嵌化”的事情：

- 如果没指定 Arthas home，会从 classpath 解压 `arthas-bin.zip` 到临时目录（`ArthasAgent.java:94-105`）；
- 再创建 `AttachArthasClassloader`（`ArthasAgent.java:112-113`），并反射调用 `ArthasBootstrap.getInstance(instrumentation, map)`（`ArthasAgent.java:120-122`）。

这条链说明 starter 解决的是另一类场景问题：

```text
应用启动时
  → 自己拿到 Instrumentation
    → 自己把 Arthas 系统装进来
```

它的便利性很高，但也把失败影响面推回了业务启动期本身。

### 3.3 为什么 starter 失败和外部 attach 失败不是同一种后果

`arthas-spring-boot-starter/ArthasConfiguration.java:66-69` 会在 Spring 上下文启动时触发 `arthasAgent` Bean；而 `ArthasAgent.java:128-133` 还明确区分了 `silentInit=false` 的情况：初始化失败时，异常会继续抛出，甚至可能阻断应用启动。

这和外部 attach 的失败完全不是一个等级的问题：

- 外部 attach 失败，通常只是“这次没挂进去”；
- starter 失败，可能直接变成“应用启动链被诊断系统拖死”。

关键设计（斜体）：*自 attach 的真正代价不是“代码复杂一点”，而是把诊断系统初始化纳入了业务 JVM 自己的启动成败。*[模式: 启动期装配 + 进程内控制面] 便利性上升，失败影响面也随之上移。

这正是为什么 Arthas 不能只保留一种入口：外部 attach 和 starter 自 attach，面对的是两类不同的工程现场。

---

## 四、第三层：为什么两条入口最终都必须汇合到同一个 `ArthasBootstrap`

### 4.1 这里才是本篇真正的主轴

到这里为止，我们已经把“为什么会有两条入口”讲清了：

- 外部 attach 适合临时、低耦合地进入已运行 JVM；
- starter 自 attach 适合在应用启动期就把诊断能力带进来。

但这还只解决了“为什么入口分叉”。更关键的问题是：

> 既然入口分叉了，为什么目标 JVM 内部又必须强行收回到同一个 `ArthasBootstrap`？

这不是一个实现偏好，而是目标 JVM 一致性的硬约束。

### 4.2 外部入口和内部入口，最后都在调用同一个单例

外部 attach 这条链，最后会在 `AgentBootstrap.java:176-191` 里反射进入 `ArthasBootstrap`，调用 `getInstance(...)`。

starter 自 attach 则在 `ArthasAgent.java:120-122` 直接反射调用：

```text
ArthasBootstrap.getInstance(instrumentation, map)
```

也就是说，两条入口虽然在控制面上完全不同：

```text
外部 attach：外部 JVM 发起
自 attach：业务 JVM 自己发起
```

但一旦进入目标 JVM 的寄生系统层，就必须汇合成：

```text
同一个 ArthasBootstrap 单例
  → 同一套 Spy
  → 同一套 Transformer
  → 同一套 bind/destroy 生命周期
```

### 4.3 如果不统一成同一单例，会发生什么

这正好对应前面要打掉的第二个失败方案：让两条入口各自跑一套系统。

一旦这么做，目标 JVM 内马上会出现：

- 两套服务端争端口；
- 两套增强链争同一批类；
- 两套 Spy 争同一个全局门面；
- 两套 stop/reset/destroy 链互相不知道对方的状态。

换句话说，入口可以分叉，但寄生系统一旦分叉，JVM 里的状态就会变成不可收拾的双份世界。

关键设计（斜体）：*入口多样化是为了适配场景，单例统一化是为了守住目标 JVM 内部状态的一致性。*[模式: 多入口，单系统] 外部或内部谁来发起可以不同，但一旦住进 JVM，Arthas 就只能有一套真正的本体。

---

## 五、第四层：入口不同，哪些边界会变，哪些边界绝不能变

### 5.1 真正会变化的是控制面位置与失败影响面

两条入口真的不一样的地方，主要有四类：

- 控制面在 JVM 外还是 JVM 内；
- `Instrumentation` 是由 Attach API 送进来，还是由 `ByteBuddyAgent.install()` 在当前进程拿到；
- 是否需要人工 PID 与外部运维流程；
- 失败时影响的是“这次临时挂载失败”，还是“业务启动链可能被拖住”。

这些差异是真实的，而且正是两条路径存在的意义。

### 5.2 绝不能变化的是目标 JVM 内部的系统边界

但不管入口怎么变，下面这些东西都绝不能跟着分叉：

- 只能有同一个 `ArthasBootstrap` 单例；
- 只能有同一套 Spy 全局入口；
- 只能有同一套 Transformer 体系；
- 只能有同一条 bind/destroy 生命周期。

也就是说，入口层可以多样，但系统层必须统一。

如果把这件事说得更白一点：**两条入口只是两种进门方式，不是两套 Arthas 产品。**

---

## 六、什么时候该选哪条路径

这部分保留实战价值，但必须回扣主线，而不是退回帮助文档。

| 场景 | 更合适的入口 | 为什么 |
|---|---|---|
| 临时排查已运行 JVM | 外部 attach | 不改启动参数，控制面留在业务 JVM 外 |
| CI / 脚本批量挂载 | 外部 attach + `--attach-only` | 自动化批量进入，后续是否连接会话可分离 |
| Spring Boot 常驻诊断 | starter 自 attach | 应用启动期就带上诊断能力，无需外部 PID 流程 |
| 内网 / K8s / tunnel 场景 | 外部 attach + tunnel | 入口仍是外部 attach，只是连接面改成 tunnel |

这张表真正想表达的，不是“背四种用法”，而是：

- 入口选择取决于控制面应该放在哪；
- 但无论你怎么选，目标 JVM 里都还是那一套 `ArthasBootstrap`、Spy、Transformer 和 bind/destroy 生命周期。

---

## 收网：Arthas 不是两套工具，而是一套寄生系统的两种进门方式

现在把整条链收成一张图：

```text
外部 attach
  → 外部 JVM 通过 Attach API 送入 agent

自 attach
  → 业务 JVM 在启动期自己拿到 Instrumentation

两条入口都只解决“谁来发起进入”
                ↓
最终都必须汇合到同一个 ArthasBootstrap 单例
                ↓
同一套 Spy / Transformer / bind / destroy 生命周期
```

把这张图压成一句话，就是：

**Arthas 不是两套不同的诊断系统，而是一套寄生系统的两种进门方式：外部 attach 解决“已运行 JVM 如何低耦合进入”，starter 自 attach 解决“应用启动期如何自带诊断能力”；但无论入口怎么变，目标 JVM 内部都必须只承载同一个 `ArthasBootstrap` 与同一条生命周期。**

到这里为止，主线其实只发生了三件事：

- 只有外部 attach，不足以覆盖启动期常驻诊断场景；
- 只有自 attach，也不足以覆盖临时进入已运行 JVM 的低耦合场景；
- 所以入口必须多样，但寄生系统必须单一。

这也解释了为什么 Arthas 的入口设计看起来像“两条路”，本质却是在守同一个边界：**控制面可以分叉，系统面不能分叉。**

跨层标注：[OpenJDK 36-attach——外部 JVM 如何把 agent 送进目标 JVM]；[Instrumentation——`ByteBuddyAgent.install()` 与 `loadAgent` 两种拿到 Instrumentation 的方式]；[Spring Boot——Bean 启动链触发自 attach]；[单例生命周期——两条入口最终都要收束到同一套 bind/destroy 系统]

本篇解决的是“为什么 Arthas 要允许两种入口，但目标 JVM 内最终必须只承载一套系统”。下一篇继续进入 AR-2：**当这套寄生系统已经稳定存在后，Watch/Trace 的命令链和 Transformer 又怎样把业务方法变成可观察的方法？**

**→ 下一篇：Watch/Trace 的命令系统与 Transformer 链。**
