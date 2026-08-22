# 容器与 Kubernetes 编排：从“换机器就跑不起来”到声明式自愈

> 主题：微服务架构｜第 10 篇
> 前置文章：`09-service-mesh.md`、`07-microservices-design.md`
> 本篇后续：`11-cloud-native-patterns.md`
> 一句话困惑：服务在 101.132.1.34 上能跑，换节点后为什么失败？
> 一句话顿悟：Kubernetes 解决的不是“启动容器”一个动作，而是把不可变交付物、资源隔离、服务发现、版本发布和故障自愈组织成声明式控制循环；能力越强，控制平面和运维复杂度也越高。
> 依赖分类：
> - 硬依赖：`09-service-mesh.md` 已建立服务网格治理；`07-microservices-design.md` 已建立服务边界。本篇把这些服务放到容器编排底座上。
> - 软依赖：Docker、微服务、Service Mesh、Linux namespace/cgroup 的基本经验会帮助理解本文，但不是本文成立前提。
> - 导航依赖：下一篇 `11-cloud-native-patterns.md` 会把视角推进到 CI/CD、GitOps、12-Factor、弹性伸缩与 Serverless；本篇先把容器运行时和 K8s 编排讲清。
> 版本说明：本文是微服务架构的容器编排篇，重点在容器/VM、Pod/Service/Deployment、发布策略、镜像构建和 K8s/Swarm 的稳定心智模型，不对应某个编排产品的完整实现源码。本文锚在容器隔离、K8s 抽象、声明式控制循环和镜像供应链这些工程机制本身，不把某一版 Docker 运行时、K8s 资源版本或发布策略细节写成跨版本契约，而把重点放在“容器不是轻量 VM，Kubernetes 也不是启动容器的脚本”。

## 现在真正该问的，不再是“容器能不能跑”，而是“运行时、网络、配置、副本和发布怎样被组织成声明式控制循环”

前几篇已经建立了服务边界、韧性、服务网格治理，但所有这些服务最终都要跑在某台机器上。一旦机器更换、IP 变化、进程崩溃，问题就立刻回到原点。

所以微服务架构的最后一层基础设施，就是容器编排。它要回答的不再是“服务怎么通信”，而是：

- 运行时怎么被隔离和打包成可搬运交付物；
- 进程怎么被调度到不同节点；
- 副本怎么保持期望数量；
- 服务入口怎么在 Pod 重建后仍然稳定；
- 版本怎么滚动替换而不中断业务；
- 配置和密钥怎么与镜像分离。

先把总图记住：

```text
代码/依赖
  → 镜像/Registry
  → Pod namespace/cgroup
  → Deployment 控制副本
  → Service 稳定发现
  → Rolling/Canary 流量与回滚
  → controller/kubelet 持续 reconcile
```

这篇最该先记住的一句话是：**Kubernetes 解决的不是“启动容器”一个动作，而是把不可变交付物、资源隔离、服务发现、版本发布和故障自愈组织成声明式控制循环；能力越强，控制平面和运维复杂度也越高。**

## 一、容器与虚拟机：共享内核与完整 OS 的边界

### 1. 最朴素的错误世界：容器就是更轻的虚拟机

这个直觉在“都能跑应用”的层面成立，但容器和 VM 的隔离成本完全不同：

- 容器与宿主机共享内核，通过 namespace 隔离进程视图，通过 cgroup 限制资源；
- VM 在虚拟硬件上运行完整 guest OS，隔离更强，但启动和资源成本通常更高。

所以容器不是“更小的 VM”，而是“共享内核的隔离进程”。

### 2. 容器与 VM 的最小对照图

```text
Container:
  image filesystem layers
  + namespace(PID/NET/MNT/IPC/USER 等)
  + cgroup(CPU/memory/IO 等限制)
  + runtime
  → 共享宿主机内核

VM:
  guest kernel/userspace
  → hypervisor/virtual hardware
  → 更强 OS 隔离, 启动/资源成本通常更高

image:
  immutable-ish build artifact
  → registry → node pull → container start
```

### 3. 为什么容器不能当成“更小的 VM”

因为共享内核意味着：

- 内核漏洞可能影响所有容器；
- 系统调用和权限边界由 seccomp/capability/LSM 等机制决定；
- 容器不自动保证无状态、可观测、数据持久化或网络安全。

所以容器是隔离进程，不是隔离操作系统。这里还要补一个反直觉的提醒：容器的启动时间、内存占用和资源特征高度依赖 runtime 和 workload，不能用一个“秒级启动”“内存很小”的固定数字代表所有容器。

### 4. 本节最该记住的结论：容器通过 namespace 和 cgroup 隔离进程和资源，与宿主机共享内核，不是“更小的 VM”；启动快、资源占用少，但内核隔离和权限边界由不同机制共同决定

一句最短人话是：**VM 像每个租户有独立整栋房子和水电系统，容器像同一栋楼里的隔离套间；套间启动快，但共享楼宇基础设施。**

## 二、Pod、Service、Deployment 与配置：Kubernetes 的四个视角

### 1. 第二个朴素误解：Pod 就是容器，No，Pod 是容器的调度单元

“Pod 就是容器”这个误解忽略了 Pod 的共定位语义：一个 Pod 里的多个容器共享同一个 network namespace，可以互相通过 localhost 通信，也能共享部分 volume。

### 2. Kubernetes 四个核心对象的最小图

```text
Pod:
  最小调度单元
  → 一个 network namespace
  → 多容器共享网络/部分 volume

Deployment/ReplicaSet:
  声明期望副本与版本
  → controller 创建/替换 Pod
  → readiness/liveness 影响可用状态

Service:
  稳定 DNS/VIP
  → selector/EndpointSlice 找后端 Pod
  → 提供 L4 访问入口

ConfigMap/Secret:
  配置/敏感值与镜像分离
  → env/file/volume 等注入方式
```

### 3. 为什么 Service 不只是一个“固定 IP”

因为 Pod 是动态的：

- Pod 会重建、IP 会变化；
- Deployment 控制着副本的生命周期；
- Endpoint 会动态变化；
- Service 通过 selector 和 EndpointSlice 始终指向当前可用的后端 Pod。

所以 Service 是一个稳定发现抽象，不是固定 IP 地址。

### 4. 本节最该记住的结论：Pod 是最小调度单元和一个 network namespace，Service 是稳定发现抽象，Deployment 声明期望副本，ConfigMap/Secret 分离配置与镜像

一句最短人话是：**Pod 是一起出差的一组进程，Service 是不会随成员更换而改变的总机号码，Deployment 是负责补齐人员数量的调度员。**

## 三、Rolling、Blue-Green、Canary：发布策略是流量与回滚策略

### 1. 第三个朴素误解：Pod 成功后，发布就安全了

Pod 启动成功只说明进程活着，不代表业务正确、依赖兼容、数据迁移安全和尾延迟正常。所以发布策略不是“替换 Pod”，而是“流量与回滚策略”。

### 2. 三种发布策略的最小图

```text
RollingUpdate:
  新 Pod Ready
  → 逐步减少旧 Pod/增加新 Pod
  → maxSurge/maxUnavailable 控制过程

Blue-Green:
  v1/v2 同时运行
  → Service/入口切 selector
  → 快速回滚
  → 需要额外资源与状态兼容

Canary:
  v2 先接小比例/特定用户
  → 观察错误率/P99/业务指标
  → 逐步放量或回滚
```

### 3. 为什么 Pod Ready 不等于版本安全

因为“进程启动成功”和“业务功能正确”之间还有很长的路：

- 依赖是否兼容；
- 数据 schema 是否前后兼容；
- 消息版本是否匹配；
- 尾延迟是否正常。

所以发布必须结合业务指标、数据库 schema 兼容、消息版本和回滚路径一起验证。这里要连回 09 篇：Service Mesh 能做请求级流量切分，但它只能帮你把流量按权重或用户分布过去，不能替代发布验收本身。

### 4. 本节最该记住的结论：Rolling、Blue-Green、Canary 分别控制替换节奏、资源占用和流量切分；Pod Ready 不等于版本安全，发布必须结合业务指标和回滚路径

## 四、镜像构建：不可变交付物也需要供应链治理

### 1. 第四个朴素误解：镜像越小越好，越小越安全

镜像大小确实影响拉取和存储，但“小”不等于“安全”。基础镜像漏洞、运行时权限、依赖供应链、签名、secret 和可复现构建同样重要。

### 2. 镜像构建的最小图

```text
多阶段:
  builder: JDK/Maven/编译工具
  → artifact
  runtime: 最小运行时 + artifact

缓存顺序:
  先复制依赖描述
  → 下载依赖
  → 再复制源码
  → 编译/打包

交付:
  build → scan/sign → registry
  → node pull → runtime start

安全:
  非 root、最小权限、漏洞扫描、secret 不烘进镜像
```

### 3. 为什么镜像更小不等于更安全

因为镜像供应链还有许多其他风险：

- 基础镜像的漏洞；
- 运行时权限配置；
- 依赖供应链攻击；
- 签名和 secret 管理；
- 可复现构建。

Alpine/Distroless/不同 libc 也可能带来兼容和调试成本；选“更小的基础镜像”不代表“一定更适合生产”，要在镜像体积和排查便捷之间权衡。镜像层共享减少存储/拉取，但不改变运行时内存和应用本身的资源需求。

### 4. 本节最该记住的结论：多阶段构建和层缓存优化镜像尺寸，但镜像安全取决于基础镜像、权限、签名、secret 和供应链；更小不等于更安全

## 五、Kubernetes 与 Swarm：声明式控制循环的复杂度

### 1. 第五个朴素误解：Docker Compose 能启动几个服务，Kubernetes 就是“更大号的 Compose”

Compose 描述的是“一组容器怎么启动”，Kubernetes 描述的是“期望状态持续被 reconcile”。两者的核心差异，不在规模，而在**控制循环**。

### 2. Kubernetes 控制循环的最小图

```text
用户提交:
  desired replicas/image/service/config
  → API server 持久化对象

scheduler:
  → 选择节点

controller:
  → 创建/删除/重启/滚动替换 Pod

kubelet/runtime:
  → 在节点执行容器生命周期

reconcile loop:
  observed != desired
  → 继续修复直到收敛或报告错误
```

### 3. 为什么 Kubernetes 更强也更复杂

因为 K8s 把运维动作转成了控制循环，但控制面本身也是故障域：

- API Server、Controller、Scheduler 和 etcd 都有自己的可用性和一致性要求；
- 对象、控制器、网络、存储、权限、升级和观测形成更大的控制平面。

Swarm 更简单，但扩展生态和高级调度能力不同。不存在“Swarm 小于某规模、K8s 大于某规模”的固定门槛，团队平台能力和故障成本更重要。

### 4. 本节最该记住的结论：Kubernetes 的核心是声明式控制循环，持续比较期望状态和观测状态并执行修复动作；能力更强，但控制平面本身也是故障域，不存在固定门槛的选型公式

## 六、把本篇收成一张图：容器编排把不可变交付物、资源隔离、服务发现、版本发布和故障自愈组织成声明式控制循环

现在可以把整篇彻底收回来。

一开始我们要解决的问题是：服务在 101.132.1.34 上能跑，换节点后为什么失败。答案已经闭环了：因为运行时、依赖、配置和网络没有被封装成可搬运的交付物，也没有被声明式控制循环持续管理。

容器通过 namespace 和 cgroup 隔离进程，不是更小的 VM。Pod 是最小调度单元，Service 是稳定发现，Deployment 声明期望副本，ConfigMap/Secret 分离配置。发布策略是流量与回滚策略，不是 Pod 替换。镜像构建需要多阶段和供应链治理。Kubernetes 的核心是声明式控制循环，能力更强，但控制平面复杂度也更高。

把这一切压成最短总图，就是：

```text
代码/依赖
  → 镜像/Registry
  → Pod namespace/cgroup
  → Deployment 控制副本
  → Service 稳定发现
  → Rolling/Canary 流量与回滚
  → controller/kubelet 持续 reconcile
```

所以本篇最该记住的一句话是：**Kubernetes 解决的不是“启动容器”一个动作，而是把不可变交付物、资源隔离、服务发现、版本发布和故障自愈组织成声明式控制循环；能力越强，控制平面和运维复杂度也越高。**

## 七、几个最容易说错的地方

### 容器就是更小的 VM？

不是。容器与宿主机共享内核，通过 namespace 和 cgroup 隔离进程，不是虚拟化完整 OS。

### Pod 就是容器？

不是。Pod 是一个 network namespace 和一个调度单元，多容器可共享网络和 volume。

### Service 就是一个固定 IP？

不是。Pod 会重建，Service 通过 selector 动态指向当前可用的后端 Pod。

### Pod Ready 就等于版本安全？

不是。进程活着不代表业务正确、依赖兼容、数据迁移安全和尾延迟正常。

### 镜像越小就越安全？

不是。镜像安全取决于基础镜像、权限、签名、secret 和供应链，不是只看大小。

### Kubernetes 就是更大号的 Compose？

不是。Compose 描述启动，K8s 描述期望状态持续被 reconcile，核心差异在控制循环。

## 收束：容器编排的价值，不是“让容器跑起来”，而是“跑起来后还能被持续修复”

回到开头那个问题：服务在 101.132.1.34 上能跑，换节点后为什么失败。答案已经闭环了：因为运行时、依赖、配置和网络没有被封装成可搬运的交付物，也没有被声明式控制循环持续管理。容器编排真正解决的问题，不是“第一次跑起来”，而是“跑起来后 IP 变了、节点换了、进程挂了、版本升级了，系统还能自动恢复期望状态”。

这就是为什么说：**Kubernetes 解决的不是“启动容器”一个动作，而是把不可变交付物、资源隔离、服务发现、版本发布和故障自愈组织成声明式控制循环；能力越强，控制平面和运维复杂度也越高。** 只要这条主线站稳，下一篇进入云原生模式时，你就不会再把 CI/CD、GitOps 和弹性伸缩看成“各自独立的工具”，而会自然去问：它们怎样把容器编排的声明式能力进一步扩展到代码、配置、测试、灰度、回滚和弹性。

## 下一篇桥接

现在编排解决了部署和自愈，但怎样把代码、配置、测试、灰度、回滚和弹性统一成可重复交付流水线：**CI/CD、GitOps、12-Factor、弹性伸缩与 Serverless 如何共同构成云原生模式？**

下一篇 `11-cloud-native-patterns.md` 会把视角推进到云原生模式：CI/CD 流水线、GitOps、12-Factor 应用、弹性伸缩与 Serverless。