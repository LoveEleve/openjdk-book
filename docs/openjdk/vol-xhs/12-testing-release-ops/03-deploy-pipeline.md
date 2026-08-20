# 03 Deploy Pipeline：为什么这套部署不是“把 zip 传上去再 docker compose up -d”这么简单

如果只看 `config/` 和若干部署说明文档，最容易得出的结论是：`my-xhs` 的部署流程已经被整理得很完整，compose、SQL、Nacos 配置、说明文档、脚本都在，剩下的无非就是把包传到远程机，执行 `docker compose up -d`，再做一点健康检查。

这正是最容易把部署写浅的地方。因为在 `my-xhs` 里，部署从来不只是“启动容器”或“重启服务”，而是一条把**中间件拓扑、配置导入、平台初始化、微服务参数、重启窗口、验证标准和遗留修复动作**串在一起的工程交付链。换句话说，部署包如果只包含 compose 和镜像引用，没有把 Nacos 配置、XXL-Job 建表、Sentinel 规则导入、从库复制状态、EIP 稳定性、healthcheck、restart policy、JDK 前置条件和部署后验证一起纳入，就不是一个真正可运行的交付物，而只是一个看起来完整的目录。

前面的历史材料已经反复说明这一点。`DEPLOY-CLOUD-GUIDE.md` 明确把“按量计费云服务器开关机”拉进了部署问题，把 `restart: always`、Docker daemon 开机自启和 EIP 稳定性当作第一优先级，而不是细枝末节。`HANDOFF-TASK4.md` 又进一步把部署拆成试验机先验证成功、再作为云主机上传源的两步走，并把“部署后必须做 Nacos 3 配置导入、Sentinel 规则导入、从库复制核对”写成硬要求。更关键的是，`review-production-config.md` 还记录过一类特别典型的交付失败：部署包里 compose、sql、配置文件都在，唯独 Nacos 3 个 yaml 没固化进去，导致所谓“上传即用”的部署包其实并不能上传即用。`docs/test-2/DEPLOY-CLOUD-GUIDE.md:8` `docs/test-2/HANDOFF-TASK4.md:88` `docs/test-2/review-fresh/review-production-config.md:485`

所以本篇真正要回答的，不是“部署步骤有哪些”，而是：**为什么这套系统必须把部署当成一条多阶段、带显式验证口径的交付流水线；为什么部署包不仅要能启动容器，还要能交代配置来源、导入顺序和验证结果；以及为什么“容器都 Up 了”在这里远远不等于“部署成功”。**

## 先给结论：`my-xhs` 的部署流水线，核心不是拉起中间件，而是把“上传即用”从口号变成有前置、有导入、有验证的可执行协议

先别急着看 compose 文件，先把本篇最重要的人话答案钉住：`my-xhs` 的部署流程最核心的目标，不是把容器拉起来，而是把“**拿到一个部署包 → 在一台远程机器上按固定顺序执行 → 形成可验证的运行拓扑**”这件事变成有明确边界的工程协议。

这句话在项目里至少有三层含义。

第一，部署包不能只包含“能启动”的东西，还必须包含“能初始化并对齐环境”的东西。SQL、Nacos 配置、告警规则、脚本、README、healthcheck、restart policy，这些都属于部署包的一部分。第二，部署不是一次动作，而是多阶段流水线：前置检查、启动容器、导入配置、平台初始化、部署后验证、必要时再执行运维脚本。第三，部署成功必须有层级化证据，而不是一句“我执行过 compose up 了”。`docs/test-2/HANDOFF-TASK4.md` 甚至专门把远程试验部署验证清单拆成 A/B/C/D/E/F 六段，就是在把这条流水线显性化。`docs/test-2/HANDOFF-TASK4.md:153`

也就是说，部署在 `my-xhs` 里不是命令行操作，而是交付协议。

## 直觉方案为什么不够：compose 文件齐了、容器都 Up 了、配置以后再补，这些都会让部署变成假成功

### 失败方案一：部署包只要有 compose 和 sql，就算“上传即用”

这是最直觉也最常见的误解。compose 里把 22 个容器都写好，`sql/init-all.sql` 也在，镜像标签能拉到，理论上就能把环境起起来。这样看当然很接近“可部署”。

但 `review-production-config.md` 已经记录过一次非常典型的反例：当时仓库里 compose、sql、配置文件看起来都齐了，结果部署说明还要求“从现环境导出再导入”3 个 Nacos 配置，而这 3 个配置本身并不在部署包里。也就是说，部署包表面完整，实际上在最关键的配置中心这一步留了隐形人工依赖，根本不满足“上传即用”。`docs/test-2/review-fresh/review-production-config.md:485`

后来之所以要补 `config/nacos/` 固化 3 个 yaml，本质上就是在修复这个交付缺口：部署包不仅要描述依赖，还要把依赖本身一起打包好。

### 失败方案二：`docker compose up -d` 没报错，就说明部署成功

这类思路在中间件部署里非常危险。因为对 `my-xhs` 来说，容器只是最外层壳，很多关键事实根本不在“容器启动”这一层上结束。

举几个直接来自文档的例子：

- MySQL 从库能不能真正工作，要看 `SHOW REPLICA STATUS` 是否 IO/SQL Running=Yes，而不是容器 Up 不 Up。`docs/test-2/HANDOFF-TASK4.md:172`
- Nacos 起没起来，不只看 18848 端口通不通，还要看 my-xhs 命名空间和 3 个配置是否真的导入。`docs/test-2/HANDOFF-TASK4.md:195`
- Sentinel Dashboard 本身起来，也不等于 16 个服务的规则已经导入。`docs/test-2/HANDOFF-TASK4.md:196`
- Prometheus / OAP / exporter / Alertmanager 等有些是“容器在跑”，有些还要验证指标是否真出数、端口是否真监听。`docs/test-2/review-fresh/review-production-config.md:767`

也就是说，`docker compose up -d` 充其量只是流水线 B 段“容器启动”通过，不是整条流水线完成。

### 失败方案三：远程试验机和云主机部署只是同一件事的两次执行

`my-xhs` 的交接材料并没有把“先在远程机试验部署”写成可有可无的演练，而是明确把它当成云主机交付之前的必要阶段：**先在远程中间件机试验成功 → 再作为云主机上传源。** `docs/test-2/HANDOFF-TASK4.md:88`

这背后的工程意义非常关键。因为当前环境里，中间件机和微服务机分离，部署包又包含一堆 restart policy、healthcheck、JDK 路径、Canal 自定义镜像、EIP 决策、Nacos / Sentinel 导入、从库重建等条件。如果不先在试验机跑通，就直接拿去云主机执行，任何一个细节失败都会把“部署问题”直接变成“生产环境问题”。

所以 `my-xhs` 的部署流水线本来就不是单阶段，而是“验证源部署包 → 试验机通过 → 再进入正式上传”的链式交付方式。忽略这一层，就会把它误写成普通 docker 化服务的发布流程。

## 先画总图：`my-xhs` 的部署流水线其实分成了六段

先把结构用文字图立住：

```text
A. 前置检查
   - JDK17/JDK8 路径
   - docker / containerd enable
   - Canal 自定义镜像已 load
   - EIP / IP 稳定性决策

B. 启动容器
   - docker compose up -d
   - restart: always
   - healthcheck / depends_on

C. 中间件功能核对
   - MySQL / Redis / Sentinel / ES / Nacos / RocketMQ / Canal / SkyWalking / XXL-Job / Prometheus / Kibana

D. 开机自恢复与 restart 策略验证
   - reboot / docker restart / compose ps / health 状态

E. 部署后业务配置导入
   - Nacos 3 配置
   - Sentinel 规则
   - 从库复制状态

F. 成功判定
   - A/B/C/D/E 全部通过
   - 才能把部署包视为“试验成功”与“可上传”
```

这张图最重要的不是步骤多，而是它说明部署在这里天然是**多阶段验证流水线**。每一段失败，含义都不同：

- A 段失败 = 部署前提不成立
- B 段失败 = 容器没正确起来
- C 段失败 = 容器起来了但中间件功能没成立
- D 段失败 = 重启 / 开机恢复语义没成立
- E 段失败 = 平台和业务配置没有进入正确状态
- F 段才是部署成功

这也解释了为什么 `my-xhs` 的部署说明不能只是一串命令，而必须带清单和预期值。

## A 段：前置检查为什么不是附录，而是部署语义本身的一部分

`DEPLOY-CLOUD-GUIDE.md` 一上来就把“必须做的 3 件事”列出来：

1. compose 全量 `restart: always`
2. Docker daemon / containerd 开机自启
3. EIP / IP 稳定性处理

`docs/test-2/DEPLOY-CLOUD-GUIDE.md:8`

很多人会把这些理解成运维环境准备工作，和部署流程本身分开。但对 `my-xhs` 来说，它们其实就是部署语义的一部分。因为按量计费云机如果不开 daemon 自启，关机再开机后中间件就不会自动恢复；如果不解决 IP 稳定性，compose、Sentinel、Nacos、brokerIP1、Canal、XXL-Job、微服务连接串里硬编码的 `21.130.247.89` 就会整体失效。也就是说，不做这些前置动作，后面的 compose 与配置导入就算“执行成功”，也只是一次性的临时启动，不是可持续运行的部署结果。

这特别能说明为什么部署在这里是“协议”而不是“命令”：没有前置条件，后面的动作没有意义。

## B 段：compose 启动的关键不只是 `up -d`，而是 `restart: always`、healthcheck 和 depends_on 被整体固化进包里

`config/docker-compose.yml` 当前并不是一个裸 compose，而是已经被多轮运维复盘改造成了带 restart policy、healthcheck、depends_on condition 的运行版基线。`HANDOFF-TASK4.md` 直接写明：22 个服务全部 `restart: always`，并且 healthcheck 全覆盖。`docs/test-2/HANDOFF-TASK4.md:45`

这里最重要的工程点不是某一个参数，而是“启动容器”和“未来是否还能自动恢复”在同一个包里被固化了。很多系统会把 restart 策略留给线上手工调，或者把健康探测留给别的系统做；`my-xhs` 则把它们视作部署包自带的可运行性前提。这正符合三层验证法里的 L0 / L1 纪律：部署包不只要能拉起，还要把“拉起之后怎样被判定为健康、怎样在重启后恢复”一起编码进去。

## C 段：为什么中间件“功能核对”比容器状态本身更重要

`HANDOFF-TASK4.md` 的 C 段清单特别值得写进正文，因为它把部署成功从“容器列表”明确拉到了“功能证据”。例如：

- MySQL 主库不仅要 `SELECT 1`，从库还要看 `SHOW REPLICA STATUS`
- Redis 不只要 PONG，还要 Sentinel `get-master-addr-by-name mymaster` 返回正确主节点
- ES 业务 / SkyWalking 两套集群都要各自检查 health
- Nacos 要看到命名空间与配置
- RocketMQ、Canal、SkyWalking、XXL-Job、Prometheus、Kibana 都要各自验证接口或进程

`docs/test-2/HANDOFF-TASK4.md:169`

这套验证之所以关键，是因为 `my-xhs` 的很多中间件问题都不是“容器挂了”，而是“容器活着但语义没成立”。Canal 的 JDK 17 不兼容、从库复制中断、Nacos 配置缺失、Sentinel 规则未导入、OAP telemetry 端口未监听，这些都属于容器在跑但功能不成立的典型。部署策略如果停留在 `docker ps` 就收工，等于把最关键的验证层砍掉了。

## D 段：为什么开机自恢复演练是部署成功判定标准，而不是上线后再观察

`DEPLOY-CLOUD-GUIDE.md` 明确把“关机→开机→等 2-3 分钟→22 个容器全部 Up”写成建议动作，`HANDOFF-TASK4.md` 则更进一步，把 reboot 场景放进成功判定清单里。`docs/test-2/DEPLOY-CLOUD-GUIDE.md:59` `docs/test-2/HANDOFF-TASK4.md:188`

这非常重要，因为按量计费云机的核心风险就在于：不开机的时候一切看起来没事，真正的问题会在“关机后再开机”这一刻暴露。restart policy、daemon enable、EIP 稳定性、容器健康检查、MySQL 从库状态，全都要在这个阶段重新接受考验。

所以在 `my-xhs` 里，reboot 演练不是 bonus，而是部署结果的一部分。没有这一段，你只能证明“当前一次拉起成功”，不能证明“这是一个能自恢复的部署”。

## E 段：Nacos / Sentinel / 从库验证为什么说明“部署包 = compose + sql + 配置导入顺序”

`review-production-config.md` 对 `P-D31` 的复盘特别值得写进部署篇。它指出，原先部署包里 compose、sql、配置文件都在，唯独 Nacos 3 个 yaml 没有固化进仓库，导致 README 要求用户“从现环境导出导入”配置，既不可靠也不满足上传即用。后来修复就是把 `config/nacos/` 补进部署包，并在 DEPLOY-README 里把部署后步骤改成“导入 config/nacos/*.yaml”。`docs/test-2/review-fresh/review-production-config.md:485`

这个案例说明一件很关键的事：在 `my-xhs` 里，部署包不是单一文件集合，而是**文件 + 导入顺序 + 初始化动作** 的组合。你就算把 compose 和 sql 都传上去，没有 Nacos 导入和 Sentinel 规则导入，这套环境也只是“容器在跑”，不是“系统在运行”。

这也解释了为什么 `HANDOFF-TASK4.md` 会把 Nacos 3 配置导入、Sentinel Dashboard 导入规则、从库复制核对明确列成试验成功前必做项。因为这些不属于“部署后优化”，而是中间件环境达成真实业务语义的必要步骤。`docs/test-2/HANDOFF-TASK4.md:194`

## 真实故障案例：部署包看起来完整，实际上 Nacos 配置没随包，导致“上传即用”是假命题

按照本卷方法论，每篇都要有一个能逼出设计问题的真实故障案例。对部署流程篇来说，最合适的主案例就是 `P-D31`：Nacos 3 配置未随包。

这个案例特别好，因为它不是某个容器挂了，而是更隐蔽的交付断裂：部署包从目录结构上看已经很完整了，但真正到了远程环境，用户仍然需要自己去找现环境导出 3 份 Nacos 配置。这样一来，“上传即用”其实只是表面成立，真实交付仍然依赖隐性上下文。`docs/test-2/review-fresh/review-production-config.md:485`

用方法论五段式收它：

- 现象：部署包具备 compose、sql、配置文件，但新环境仍无法直接运行
- 根因：Nacos 三份关键配置没有随包固化，README 依赖人工从现环境导出
- 修复：把 `config/nacos/*.yaml` 纳入仓库，README 明确导入步骤
- 验证：文档已记录“全新 Nacos 导入 3 文件后，微服务连中间件成功”
- 余波：以后任何部署包都不能只看“文件看起来很多”，而要检查“环境必要配置是否真的随包”

这个案例特别能说明部署流程篇的核心主题：交付失败往往不是命令执行错了，而是部署包并没有把真正依赖项完整表达出来。

## 为什么部署说明文档本身也是系统资产：它在承接 L0/L1/L2 结论分层

`REVIEW-METHODOLOGY.md` 强调的三层验证法，在部署这里其实体现得更明显。因为部署包本身首先要通过 L0 静态自洽：文件存在、路径正确、yaml 语法与引用一致；接着要过 L1 框架语义：restart policy、healthcheck、Exporter 默认端口、SkyWalking 采样率单位、Prometheus 热加载行为都不能猜；最后才是 L2 远程试验和云主机实际拉起。`docs/test-3/REVIEW-METHODOLOGY.md:6`

这意味着部署说明文档在 `my-xhs` 里不是附属 README，而是一种把 L0/L1/L2 串起来的执行脚本语言。它不仅告诉用户“做什么”，还在隐含地约束“做到哪一层，才允许说试验成功”。这也是为什么部署文档里会有那么多“必须执行”“试验成功前必做”“判定标准”这样的措辞——这不是形式主义，而是在控制结论强度。

## 证据清单：本篇关键结论分别站在哪一层

L0 / L1 静态与语义证据：

- `DEPLOY-CLOUD-GUIDE.md` 已明确把 `restart: always`、Docker daemon 开机自启、EIP 稳定性列为部署前必须做的 3 件事。`docs/test-2/DEPLOY-CLOUD-GUIDE.md:8`
- `HANDOFF-TASK4.md` 已把远程试验部署验证清单分成 A/B/C/D/E/F 六段，说明部署在 `my-xhs` 里本来就被设计成多阶段验证流水线。`docs/test-2/HANDOFF-TASK4.md:153`
- `config/docker-compose.yml` 当前直接可见多中间件、healthcheck、restart policy 和部署注意事项，说明部署包并不是裸 compose。`my-xhs/config/docker-compose.yml:1`
- `REVIEW-METHODOLOGY.md` 已明确规定 L0/L1/L2 验证层级和禁止直接说“没问题”的结论纪律，这在部署问题上同样适用。`docs/test-3/REVIEW-METHODOLOGY.md:14`

L2 运行态 / 交付实证：

- `review-production-config.md` 已记录 `P-D31`：Nacos 3 配置未随包这一真实交付缺口，以及后续固化修复。`docs/test-2/review-fresh/review-production-config.md:485`
- 同一份文档已记录“全新 Nacos 导入 3 文件后，微服务连中间件成功”，说明配置导入不是形式步骤，而是真实运行前提。`docs/test-2/review-fresh/review-production-config.md:487`
- `ANSWERS-DEPLOY-PACKAGE.md` 已记录 `start-all.sh` 从“几十分钟卡死”修到“冷启动约 95 秒且 15 服务 UP”，说明部署与启动链真实受脚本层影响。`docs/test-3/review/ANSWERS-DEPLOY-PACKAGE.md:164`

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出 `my-xhs` 已经沉淀出一套比“compose up”更严格的部署流水线，但不能把它写成“当前部署包已经彻底达到一键无脑部署”。历史上 Nacos 配置、规则导入、EIP 这些都说明仍有环境前置条件。

第二，当前可以明确写出远程试验机部署成功是云主机部署前的必要阶段，但不能把它写成“试验成功后云主机一定零风险”。两者共享大部分前提，但 IP、权限、镜像缓存、云盘与安全组仍可能带来新变量。

第三，当前可以明确写出部署成功必须经过多阶段验证，但不能把它写成“只要按清单全打勾，系统语义就永久正确”。部署验证解决的是当次环境就绪，不等于后续所有业务与补偿链长期无偏。

第四，当前可以明确写出 README、脚本、compose、sql、nacos 配置共同组成部署包，但不能把它们理解成完全静态资产。随着服务拓扑、规则、参数和中间件版本变化，部署包本身也需要持续演进。

## 收网：这篇 Deploy Pipeline 真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的部署流程不是“上传 zip → docker compose up -d”的机械操作，而是一条把前置依赖、容器启动、配置导入、平台初始化、开机自恢复验证和成功判定标准全部串起来的工程交付链。它真正重要的地方，不是命令有多少，而是把“上传即用”从目录口号变成了有前提、有顺序、有验证层级的可执行协议。

从业务逻辑视角看，它守住的是“这些服务和中间件到底有没有以可运行的方式一起进入世界”；从工程视角看，它把 compose、sql、nacos、脚本、daemon、EIP、healthcheck 织成了一套交付资产；从分布式视角看，它承认真正的部署成功必须跨过多中间件、多主从、多规则和多平台状态检查；从微服务视角看，它让发布不再只是单个模块的命令，而是一条系统级环境构造流程。

更重要的是，本篇把一个特别容易被讲轻的事实钉住了：**在 `my-xhs` 里，部署失败很多时候不是命令没执行，而是部署包没有把系统真正依赖的那些前提条件完整地带过去。**

下一篇如果继续沿 `12-testing-release-ops/` 推进，最自然的顺序就是进入 `docs/openjdk/vol-xhs/12-testing-release-ops/04-monitoring-alert.md`，把前面 scattered 出现的 Prometheus / Grafana / Alertmanager / 规则名与埋点对齐问题统一收束。