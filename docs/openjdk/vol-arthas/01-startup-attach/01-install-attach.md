# 01. 服务不能重启时，Arthas 到底是怎么挂进去的？——安装、Attach 与“进门/连门”分离

> 基于 `arthas` 当前源码与脚本实现讨论；本文聚焦 Linux / JDK Attach API / 外部 `as.sh` 入口，不等于所有 JVM、所有部署方式或 Starter 自 attach 的统一路径。
> **前置依赖**：知道 JVM 进程、`java -jar`、telnet/http 端口这些基本概念；最好先读过 [vol-tools/ch02 — jcmd 万能诊断命令](../../vol-tools/ch02.md) 里对 attach 的直觉性介绍。
> → **后续**：[02 —— attach 之后，JVM 里到底多了什么？](../01-startup-attach/02-bootstrap-spyapi.md)：AgentBootstrap、ArthasClassloader、SpyAPI 注入链。
> 关联域：36-attach、47-instrumentation、40-launcher。
> 本篇所有命令与源码锚点均已回对 `arthas` 仓库，不靠猜。

## 先看一个线上现场：你只有 PID，但服务不能重启

场景：线上 JVM CPU 飙高、接口超时，服务又不能重启。你手里只有一台机器、一个 PID，以及十分钟排障窗口。此时最关键的问题不是“thread 命令怎么用”，而是更前面那一步：**Arthas 凭什么能在不停机的前提下进到目标 JVM 里？**

很多人第一次用 Arthas，只记住了一条命令：

```bash
./as.sh <pid>
```

于是很容易把整个过程想成一种“远程 shell”体验：

```text
敲命令
  → 连上目标 JVM
    → 出现交互终端
      → 开始排障
```

这个直觉不算完全错，但它会把两件根本不同的事情混在一起：

1. **进门**：把 Arthas agent 动态装进目标 JVM；
2. **连门**：再去连 Arthas 在目标 JVM 里开出来的 telnet/http 服务。

这两步一旦混在一起，后面的很多现象都会看不清：

- 为什么 `--attach-only` 只挂不连；
- 为什么 `exit` 只是退出终端，不等于 Arthas 从 JVM 里消失；
- 为什么有时 attach 已经成功，但终端还是连不上；
- 为什么 tunnel 模式解决的是“怎么连门”，不是“怎么进门”。

所以本篇真正要回答的不是“Arthas 安装命令是什么”，而是：

**当服务不能重启时，Arthas 如何先借 JDK Attach API 进入目标 JVM，再决定要不要立刻把交互终端接上来？**

先把总图立住：

```text
外部 shell / 运维脚本
  → as.sh 解析参数
    → 启动独立 JVM 执行 arthas-core.jar
      → VirtualMachine.attach(pid)
        → loadAgent(arthas-agent.jar)
          → AgentBootstrap.agentmain()
            → bind telnet/http/tunnel
              → 调用方再去连接终端
```

这张图里最重要的一刀就是：

```text
attach = 进门
connect = 连门
```

后面所有细节都围绕这条边界展开。

---

## 一、先排除一个最直觉、也最容易想错的方案：Arthas 直接“远程控制”目标 JVM

### 1.1 为什么很多人会自然想到这种模型

从使用感受看，`./as.sh <pid>` 很像一条“进入目标进程”的命令。终端里很快出现欢迎信息，你开始执行 `thread`、`dashboard`、`watch`，于是很容易把 Arthas 想成这样：

```text
本机终端
  → 直接连到目标 JVM
    → 目标 JVM 立刻暴露交互能力
```

如果真是这样，那么 Arthas 似乎只要解决两件事：

- 怎么找到目标 JVM；
- 怎么把命令发进去。

但这个模型解释不了几个关键事实：

- `--attach-only` 为什么能只把工具挂进去，却不打开交互终端；
- 为什么 attach 成功后，后续还可能卡在端口、认证或网络可达性上；
- 为什么 tunnel 模式要多出一层“目标 JVM 主动注册”的链路；
- 为什么 `stop` 要显式销毁 agent、Transformer、SpyAPI，而不是“断开连接就完事”。

### 1.2 真正的问题不是“怎么发命令”，而是“怎么把工具寄生进去”

Arthas 不是把命令远程送给 JVM 里一个预置的诊断服务，而是先把**一整套寄生式诊断系统**动态装进目标 JVM，再决定用什么方式去连接它暴露出来的服务端。

也就是说，最笨但最直觉的想法是：

> 目标 JVM 早就有一个 Arthas 服务，我只是去连它。

而真实情况更接近：

> 目标 JVM 本来没有 Arthas；`as.sh` 先借 Attach API 把 Arthas agent 动态装进去；agent 在 JVM 内完成初始化、绑定端口和服务编排；然后外部调用方才去连它。

这一点不只是概念上的“更精确”，而是整条启动链的主线。先记住一句话，后面会反复回收：

**Arthas 的第一步不是“打开终端”，而是“先把自己变成目标 JVM 里的一部分”。**

---

## 二、第一层：`as.sh` 不是 Arthas 本体，它只是外部发令器

### 2.1 `./as.sh <pid>` 背后其实有多条命令入口

最常见的启动命令当然是：

```bash
./as.sh <pid>
```

脚本参数解析集中在 `as.sh:559-820`。默认端口在脚本开头直接给出：telnet `3658`、http `8563`（`as.sh:100-105`）。除了最常见的 PID 形式，它还有几条关键变体：

```bash
./as.sh <pid>@<ip>:<telnetPort>:<httpPort>
./as.sh --attach-only <pid>
```

无参数运行时，脚本还会先调用 `jps` 枚举本机 JVM，再让你交互选择目标，这段逻辑在 `as.sh:751-819`。

这里先别急着抠每个参数。主线只需要记住两件事：

- `as.sh` 负责把外部使用者的意图整理成一条启动请求；
- 它本身并不驻留在目标 JVM 内，也不直接承载后续的诊断服务。

### 2.2 为什么还要再起一个独立 JVM

脚本最终不会自己完成 attach，而是执行：

```bash
java -jar arthas-core.jar -pid <pid>
```

这条真正发令的命令在 `as.sh:893-899`。这一步非常关键，因为它说明：

- 外层 shell 只是参数门面；
- 真正使用 Attach API 的，是一个**独立启动出来的 Java 进程**；
- 这个外部 JVM 负责连目标 JVM、投递 agent，但不负责承载 Arthas 的长期运行态。

如果删掉脚本包装，外部控制面的本质其实是：

```text
shell
  → java -jar arthas-core.jar
    → Attach API
```

关键设计（斜体）：*脚本不是 Arthas 本体，而是把“PID/端口/隧道/认证参数”翻译成外部控制面的启动请求。*[模式: 门面脚本 + 外部控制面] 这样做的好处是，shell 层保持轻，真正复杂的 attach 逻辑集中在 Java 侧；脚本擅长处理参数和交互，Java 擅长处理 Attach API 和后续协议。

### 2.3 这里为什么不能让 shell 直接完成全部工作

一个直觉问题是：既然最终只是把 agent 装进目标 JVM，为什么不直接在 shell 里把这件事做完？

因为 attach 不是简单的文件复制或进程注入。Arthas 要利用的是 **JDK Attach API**，而这条 API 本身就在 Java 世界里。shell 可以决定“我要 attach 谁”“我要不要后续连终端”，但它不适合承担：

- `VirtualMachine.attach(pid)` 的 provider 选择；
- `loadAgent(...)` 的参数构造；
- 后续 Java 侧返回结果的处理。

也就是说，shell 在这里最合理的职责不是“实现 attach”，而是“把 attach 所需上下文交给更适合做这件事的 Java 控制面”。

---

## 三、第二层：真正的“进门”发生在 Attach API，而不是终端连接

### 3.1 `VirtualMachine.attach()` 与 `loadAgent()` 才是外部 JVM 的核心动作

这里先把证据链补齐。外层脚本在 `as.sh:893-899` 启动独立 JVM 执行 `arthas-core.jar -pid <pid>`；进入 Java 侧后，`core/Arthas.java:103` 会调用：

```java
VirtualMachine.attach(pid)
```

建立到目标 JVM 的 attach 连接；随后在 `core/Arthas.java:125` 调：

```java
loadAgent(arthas-agent.jar)
```

把 agent 投递进目标 JVM。

这两步的语义必须分开理解：

- `attach(pid)`：连上目标 JVM；
- `loadAgent(...)`：把 agent 装进去，让目标 JVM 自己执行这段 agent 初始化链。

也就是说，外部 JVM 到这里做完的其实是：

```text
找到目标 JVM
  → 建立 Attach 通道
    → 投递 arthas-agent.jar
```

而不是“在外部 JVM 里开始执行 Arthas 服务端”。

### 3.2 为什么说“外部发起，目标 JVM 内执行”

这一步最容易被误读成“外部 JVM 替目标 JVM 做了初始化”。实际情况恰好相反：

- attach 请求由外部 JVM 发起；
- agent 的真正执行落点在目标 JVM 内；
- 目标 JVM 里的 attach listener 收到请求后，才进入 `AgentBootstrap.agentmain()`。

这一跳在后续篇章已有精确锚点：`agent334/AgentBootstrap.java:67-68` 是 `agentmain()` 入口，继续进入同步 `main()`（`AgentBootstrap.java:90`）；如果发现 `SpyAPI.isInited()`，还会在 `:91-99` 直接短路重复启动。也就是说，到 `loadAgent(...)` 为止，外部 JVM 只完成“投递”；真正把 Arthas 接住并往下带的第一落点，已经是目标 JVM 内的 `AgentBootstrap`。

这也是 HotSpot 动态 attach 路径最有价值的地方：**进程外负责投递，进程内负责装载和托管。**

这条边界直接决定了 Arthas 的几项核心能力：

- 不要求业务 JVM 在启动参数里预埋 Arthas；
- 不要求服务重启；
- 只要满足 Attach API 条件，就能在运行中“补装”诊断能力。

关键设计（斜体）：*Attach API 把“谁发起诊断”与“谁承载诊断”拆成了两个 JVM。*[模式: 外部控制面 + 目标进程数据面] 外部 JVM 只负责把 agent 送进去；真正的服务线程、类加载器、命令系统和增强链，都要在目标 JVM 内落地。

### 3.3 如果 attach 成功，为什么还不能说“已经进入 Arthas”

因为 attach 只解决了“工具进门”，还没解决“用户怎么连到这套工具”。

到 `loadAgent(...)` 成功为止，外部调用方能确认的是：

- agent 已经进入目标 JVM；
- 目标 JVM 正在或已经完成 Arthas 初始化链。

但这还不是完整的终端体验。后续还要看：

- 目标 JVM 内部服务端是否真正 bind 成功；
- telnet/http 端口是否可用；
- 监听地址、认证、网络可达性、隧道配置是否成立。

这就是为什么“attach 成功”和“终端可连接”不是同一个判定点。前者是 Attach API 问题，后者是 bind/network 问题。

---

## 四、第三层：进门之后，还要分清“我只是挂进去”还是“我要立刻连进去”

### 4.1 `--attach-only` 不是次要参数，它直接暴露了两阶段模型

如果 Arthas 真是“attach = 进入终端”，那 `--attach-only` 这个参数就很难解释。

它的实际含义是：

```bash
./as.sh --attach-only <pid>
```

只负责把 agent 装进目标 JVM，不进入交互终端。这个行为说明 Arthas 的启动天然分成两阶段：

```text
阶段一：attach / loadAgent / agent 初始化
阶段二：连接 telnet/http/tunnel 会话
```

很多自动化脚本“挂住”的根因，就在于误把默认 `as.sh <pid>` 当成“只做 attach”。事实上，普通路径 attach 成功后还会继续进入终端连接阶段；而 `--attach-only` 明确要求停在第一阶段。

### 4.2 为什么这两阶段必须拆开

最直觉的方案当然是：

> 只要 attach 成功，就自动把终端体验一起做完。

但这个方案一进入生产环境就会暴露问题：

- CI/批处理并不需要交互终端；
- 有些场景只想预先把 agent 挂进去，稍后再由别的入口连接；
- 网络和端口问题会让“进门成功”和“连门失败”交织在一起，排障根因变模糊。

拆成两阶段之后，诊断链的边界立刻清楚了：

```text
attach 失败
  → 查权限、PID、Attach API、目标 JVM 状态

attach 成功但连不上
  → 查 bind、端口、认证、网络、隧道
```

这不是“多设计了一层”，而是在工程上把两类故障隔离开。

### 4.3 退出终端为什么不等于 Arthas 已经消失

一旦理解了“进门/连门”分离，另一个常见误解也会自然消失：

- `exit` / `logout`：只是结束当前终端会话；
- `stop`：才是停止 Arthas 服务，并触发完整销毁链；
- `reset`：撤销 watch/trace/tt 等增强。

现稿和后续篇章已经给出这些命令在 `StopCommand.java`、`ResetCommand.java` 以及 `ArthasBootstrap.destroy()` 链里的真实落点。这里先只记住一句话：

**断开会话，不等于把寄生系统从目标 JVM 里撤走。**

这也是为什么 attach 阶段和连接阶段要分开写：只有先承认 Arthas 是“先寄生，再会话”，`exit`/`reset`/`stop` 三者的层级才不会混掉。

---

## 五、第四层：为什么 tunnel 模式解决的是“怎么连门”，不是“怎么进门”

这里先给一个路标：这一节属于主线上的“会话层分支”。如果你现在只关心本机 `as.sh <pid>` 为什么能把工具挂进去，可以先记住结论——**tunnel 不改写 attach，本质只改写 connect 方向**——然后直接跳到下一节安全边界。

### 5.1 本机 attach 只是最舒服的情况

在本机直连场景里，`./as.sh <pid>` 往往很顺手，于是很容易低估后半段的网络问题。

但到了容器、K8s、跳板机或隔离内网场景，真正困难的往往不是 Attach API，而是：

- 你不一定能从外部直接访问目标 JVM 暴露的 3658/8563；
- Pod/容器端口未必稳定；
- 统一审计或网络策略不允许随便开入站连接。

这时 Arthas 提供的不是“另一种 attach”，而是另一种**会话连通方式**：

```bash
./as.sh --tunnel-server http://tunnel.aliyun.com --agent-id <id>
```

参数拼装在 `as.sh:838-891`。它背后的模型不是“让外部更容易闯进来”，而是：

```text
目标 JVM 内的 Arthas
  → 主动向 tunnel-server 注册
    → 使用者再从 tunnel-server 取会话
```

### 5.2 为什么这不是 attach 链，而是连接链的改写

这里特别容易想错成：

> tunnel 模式是不是绕开了 Attach API？

不是。attach 这一步仍然要发生，agent 仍然要先进入目标 JVM。区别只在于 attach 完成后，用户不再直接连 telnet/http 端口，而是借 tunnel-server 做中转。

所以更准确的链路应该是：

```text
attach 先完成
  → 目标 JVM 内的 Arthas 启动 tunnel-client
    → target 主动注册到 tunnel-server
      → 用户经 tunnel-server 取会话
```

关键设计（斜体）：*隧道模式改写的是“连接方向”，不是“进入方式”。*[模式: 反向连接 + 会话中转] 不容易放行的入站连接，被改写成更容易落地的出站注册；但前面的 agent 注入链并没有消失。

### 5.3 为什么这个设计特别适合生产与容器环境

因为它正好对冲了线上网络的几个现实限制：

- K8s Pod 不一定暴露稳定的诊断端口；
- 内网策略通常更愿意放行业务进程主动发起的出站连接；
- 运维希望所有诊断会话汇聚到统一入口，方便审计和管理。

当然，代价也必须明说：tunnel-server 引入了额外链路和安全边界。公共 tunnel-server 还会带来数据出境与合规问题，所以生产里更稳妥的做法通常是自建 tunnel-server，并让 `agent-id` 具备明确的应用身份语义。

---

## 六、第五层：安全不是 attach 之后顺手补的，它从进门第一步就开始了

### 6.1 为什么诊断工具的危险边界比普通服务更靠前

Arthas 能看线程、看类、做字节码增强、改运行时行为。也就是说，一旦它进入目标 JVM，它拥有的观察和干预能力就非常强。

因此 attach 链不是“先把工具挂进去，安全以后再说”，而是从第一步就要承认：

**诊断能力越强，接入边界就越应该在进门时定清楚。**

### 6.2 绑定到 `0.0.0.0` 时为什么必须强制补密码

后续 bind 篇会详细展开 `ArthasBootstrap.bind()`，这里先抓一个足够说明问题的事实：

当监听到 `0.0.0.0` 且没有显式配置密码时，Arthas 会强制生成随机密码。对应逻辑在 `ArthasBootstrap.java:415-426`。

这条规则的意义不是“体验优化”，而是非常朴素的生产防线：如果你把诊断端口直接暴露给整个网段，却没有认证，那就等于把目标 JVM 的诊断与增强能力裸露给外部。

脚本层也因此提供了 `--username/--password`、`--disabled-commands stop` 这类参数。后者并不是“执行命令时再临时拦一下”，后续 `bind` 篇会看到它在 `ArthasBootstrap.java:432-445` 直接影响内置命令包注册；而 `stop` / `reset` 也不是随口的会话命令，后续源码会落到 `StopCommand.java:29-39` 先 `reset()` 再 `destroy()`，以及 `ArthasBootstrap.java:838-888`、`ArthasBootstrap.java:942-957` 的销毁与 Spy 清理链。

它们看起来像运维配置，但本质上都属于同一条接入边界：你不是在启动一个普通 CLI，而是在向业务 JVM 动态装入一套高权限诊断系统，所以认证、可用命令集合、增强恢复和最终撤离，都必须从第一步就被设计进去。

### 6.3 这里先别急着背参数，先记住安全边界属于主线

赶时间的话，这一节甚至可以先不逐项记参数。主线只需要记住：

- Attach API 解决的是“怎么进门”；
- bind 与认证解决的是“进门后怎么受控地开放能力”；
- stop/reset/destroy 解决的是“用完之后怎么撤得干净”。

换句话说，安全不是正文外的运维补充，而是 Arthas 启动机制的一部分。

---

## 收网：Arthas 的 attach 不是“连上一个 shell”，而是“先寄生，再会话”

现在把整条链收成一张图：

```text
1. shell 接收 PID、端口、隧道、认证等外部意图
2. as.sh 启动独立 JVM 执行 arthas-core.jar
3. Java 控制面调用 VirtualMachine.attach(pid)
4. 外部 JVM 通过 loadAgent(...) 把 arthas-agent.jar 投进目标 JVM
5. 目标 JVM 内执行 agent 初始化链，启动 Arthas 服务编排
6. 外部调用方再决定：直接连 telnet/http，还是经 tunnel-server 取会话
```

把这张图压成一句话，就是：

**Arthas 的 attach 不是“连上一个 shell”，而是“借 JDK Attach API，把一套寄生式诊断系统动态装进目标 JVM，再决定要不要立刻把会话接上来”。**

到这里为止，主线其实只发生了三件事：

- `as.sh` 只是发令器，不是驻留本体；
- Attach API 负责进门，目标 JVM 负责承载 Arthas；
- attach 与 connect 是两阶段，所以 `--attach-only`、tunnel、`exit/reset/stop` 才会各自有清晰边界。

这也解释了为什么“命令能不能执行”和“Arthas 有没有彻底进 JVM”不是同一个问题：

- `thread`、`dashboard`、`watch` 能工作，前提是 Arthas 已经作为寄生系统进入目标 JVM；
- `exit` 不会让 Arthas 消失，因为它只结束会话，不结束寄生；
- `stop` 必须单独存在，因为寄生系统要显式撤走。

如果你坚持把整条链误看成“连上一个 shell”，排障时就会连续犯三类错：

- 会把 attach 成功但 bind 失败误判成“JVM 不支持 Arthas”；
- 会把 tunnel 误判成另一种注入机制，而不是另一种会话连通方式；
- 会把 `exit` 误判成完整退出，遗漏 `reset` / `stop` 带来的增强恢复与资源撤离。

这正是本文反复把 `attach = 进门`、`connect = 连门` 拿回来讲的原因：两阶段一旦混掉，线上排障最先坏掉的不是概念，而是判断力。

跨层标注：[OpenJDK 36-attach——Attach API、attach listener 与动态装载链]；[OpenJDK 47-instrumentation——`loadAgent` 如何落到 `agentmain` / JPLISAgent]；[Launcher——`java -jar arthas-core.jar` 只是外部控制面]；[运维网络——tunnel 改写的是会话连通方向，不是 attach 本体]

本篇只解决“Arthas 怎么进门”。下一篇继续追更关键的第二问：**一旦进门成功，目标 JVM 里到底多了哪些类、单例、类加载器和全局入口，为什么增强后的业务代码无论由谁加载都还能找到 SpyAPI？**

**→ 下一篇：attach 之后，JVM 里到底多了什么？**
