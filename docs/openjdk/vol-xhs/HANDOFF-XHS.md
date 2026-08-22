# HANDOFF-XHS — 小红书电商平台业务深度分析交接文档

> **状态**: 2026-08-22 | 代码修复阶段已多轮收口，业务深度分析正文已大面积落稿
> **交接范围**: `my-xhs` 微服务平台（16+ 服务）的代码修复 + 运行状态恢复 + 业务深度分析正文与方法论收束
> **接收者**: 新 AI —— 读本文件即可继续，不要依赖旧会话记忆

---

## 〇、三十秒总览

**项目**: 小红书（my-xhs）微服务平台，Spring Cloud + Nacos + RocketMQ + MySQL + Redis + ES + SkyWalking 全栈电商系统。

**当前状态**: 代码级 bug 修复已继续推进并补出多轮真实修复；核心业务端口 `19000/01/02/03/04/08/09/10/11/12/13/14/15/16` 全通；`vol-xhs` 已从目录规划推进到大部分目录组存在正文与模块专章。

**下一步（阶段转折）**: 业务梳理主骨架已建立，下一阶段从“起稿”转为**横切目录收口 + 运行态证据补强**。优先继续 `09-data-model-storage → 10-async-task-transaction → 11-runtime-failure-review → 12-testing-release-ops`。详见 §〇·五。

**铁律**: ① 读源码再写，不凭记忆；② 每篇必须有"读者困惑→机制拆解→设计取舍"主线；③ 删掉代码后文章主线仍能成立；④ 故障案例必须有根因→修复→验证三段。

---

## 〇·五、下一步计划（阶段转折点）

### 背景

前一阶段（2026-08-18 及之前）完成了：
- 20+ 项代码级 bug 修复（inventory/coupon/order/payment/cart/home/search/gateway/common 等）
- 14 个核心服务的运行状态恢复（端口全通、启动日志正常）
- 可观测性全链路闭环（SkyWalking/Prometheus/Grafana/ES 日志）

**代码修复阶段已多轮收口。当前阶段是"横切目录收口 + 运行态证据补强"。**

### 下一阶段目标

在 `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-xhs/` 下，继续把剩余横切目录系统收口，并同步把已修代码问题、运行态证据和交接口径持续对齐。

这不是"把源码抄一遍"，而是：
- 把每个业务域和横切目录的**核心流程**讲清楚（用户怎么下单、库存怎么扣减、补偿怎么收口）
- 把每个域的**设计取舍**讲清楚（为什么用三级扣减而不是直接扣、为什么用事务消息而不是本地事务）
- 把每个域的**真实故障案例**讲清楚（端口冲突、死信消息、Feign 超时、启动失败）
- 把跨域的**依赖关系**讲清楚（order 怎么编排 inventory/coupon/payment，gateway/common 怎么影响全站）
- 把**代码修复状态、文档结论、运行态证据**持续收成一致口径

### 执行路径

```
第一步：00-overview-architecture（全局架构，建心智模型）
    ↓
第二步：主交易链（P0）
  03-product → 04-cart-coupon → 05-inventory-order-payment
    ↓
第三步：用户入口（P1）
  01-user → 06-search-recommendation-home
    ↓
第四步：内容与消息（P2）
  02-content → 07-im-notification → 08-gateway-security
    ↓
第五步：横切面（P3）
  09-data-model → 10-async → 11-failure-review → 12-testing
```

### 每个子目录的产出

每个子目录通常包含 3-5 篇技术文档，按问题闭环决定篇数，不做硬性上限，每篇：
- 中等专题篇 5000-8000 字；主链路篇/总串联篇不少于 8000 字，目标 10000-15000 字
- 有源码证据（至少到文件级，关键结论尽量到 file:line，不编造）
- 有故障/失败案例
- 有设计取舍分析
- 有桥接下一篇的悬念

### 与 openjdk-book 方法论的关系

本卷遵循 `docs/openjdk/WRITING-METHODOLOGY.md` 和 `docs/openjdk/WRITING-GUIDELINES.md` 的核心原则，并由 `docs/openjdk/vol-xhs/METHODOLOGY.md` 负责落地到 `my-xhs` 微服务场景。

阅读顺序建议：
1. `HANDOFF-XHS.md`
2. `../WRITING-METHODOLOGY.md` 和 `../WRITING-GUIDELINES.md`
3. `README.md`
4. `METHODOLOGY.md`

其中 `METHODOLOGY.md` 额外规定了：
- 按模块组织，不按问题类型组织
- 每个模块按业务/工程/分布式/微服务四视角解剖
- 结论区分源码静态、框架语义、运行态实测三层证据
- 每篇必须包含真实故障案例

相对 vol-02，这里还额外适配了 Java 微服务的特点：
- 行号精度：正文引用至少到文件级，关键结论尽量到 file:line，不编造
- 增加"故障案例"作为必选要素
- 增加"跨服务调用链"作为结构维度

---

## 一、项目全貌

### 1.1 服务清单与端口

| 服务 | 端口 | 模块路径 | 职责 |
|---|---|---|---|
| gateway | 19000 | `my-xhs-gateway/` | API 网关、路由、限流、JWT |
| user | 19001 | `my-xhs-user/` | 用户注册/登录、验证码、JWT 签发 |
| content | 19002 | `my-xhs-content/` | 笔记发布、Feed 流、点赞评论收藏 |
| analytics | 19003 | `my-xhs-analytics/` | 数据分析、埋点、统计 |
| counter | 19004 | `my-xhs-counter/` | 计数服务（点赞/收藏/浏览） |
| product | 19006(配置) / 19008(实际) | `my-xhs-product/` | 商品/SPU/SKU 管理 |
| inventory | 19009 | `my-xhs-inventory/` | 库存管理、三级扣减、TCC |
| coupon | 19010 | `my-xhs-coupon/` | 优惠券发放、核销、对账 |
| order | 19011 | `my-xhs-order/` | 下单、事务消息、分库分表 |
| payment | 19012 | `my-xhs-payment/` | 支付、退款、策略模式 |
| notification | 19013 | `my-xhs-notification/` | 通知、SSE 推送、聚合 |
| cart | 19014 | `my-xhs-cart/` | 购物车、合并、Feign 调用 |
| home | 19015 | `my-xhs-home/` | 首页 BFF、并行聚合 |
| search | 19016 | `my-xhs-search/` | ES 搜索、推荐、热搜 |
| im | — | `my-xhs-im/` | 即时通讯、WebSocket |
| ai-app | — | `my-xhs-ai-app/` | AI 应用层 |
| ai-mcp | — | `my-xhs-ai-mcp/` | AI MCP 协议 |
| ai-tools | — | `my-xhs-ai-tools/` | AI 工具层 |

### 1.2 中间件与基础设施

| 组件 | 地址 | 用途 |
|---|---|---|
| MySQL | 21.130.247.89:13306/13307/13308/13309 | 业务数据（分库分表） |
| Redis Sentinel | 16379(S) / 16380(Cache) / 16381(Biz) | 缓存 + 分布式锁 |
| Elasticsearch | 19200 | 业务搜索 + 日志 |
| ES SkyWalking | 19201 | 链路追踪存储 |
| Nacos | 18848 | 服务发现 + 配置中心 |
| RocketMQ | 9876;9877 | 异步消息 |
| XXL-Job | 18080 | 分布式调度 |
| Sentinel | 8858 | 限流熔断 |
| Prometheus | 19090 | 指标采集 |
| Grafana | 13000 | 可视化 |
| SkyWalking | 8080(UI) / 11800(gRPC) | 链路追踪 |
| Canal | 11111 | MySQL binlog 同步 |

### 1.3 git 仓库

- 路径：`/data/workspace/my-xhs/`
- 远程：`git@git.n.xiaomi.com:mishop-group/my-xhs.git`
- 分支：`main`

---

## 二、本轮已完成工作（代码修复 + 服务恢复）

### 2.1 已修复的代码级 bug（共 20+ 项）

| 编号 | 模块 | 问题 | 修复 | 验证 |
|---|---|---|---|---|
| F-004 | inventory | Lua 脚本 confirm 扣减后 bucket 残留 | 修正 Lua 逻辑 | 单测通过 |
| F-005 | inventory | ReinitRequest DTO 冗余校验 | 新建 ReinitRequest.java | 单测通过 |
| F-006 | coupon | 缺失对账 Job | 新建 CouponReconcileJob.java | 单测通过 |
| F-007 | order | traceId 未跨 MQ 传播 | +MqTraceHelper | 单测通过 |
| F-008 | order | Feign URL override ×3 | application.yml | 服务启动正常 |
| F-010 | payment | extractPaymentNo JSON 解析 | PaymentController.java | 单测通过 |
| F-012 | notification | uk_aggregate 唯一约束过严 | DROP UNIQUE → REGULAR INDEX | 服务启动正常 |
| F-015 | home | Feign URL override ×9 | application.yml | 服务启动正常 |
| F-016 | home | LoadBalancer name null 兜底 | +1 行 null check | 服务启动正常 |
| F-021 | common | 读写分离 SQL 分析路由失效 | 新建 ReadWriteRoutingInterceptor | 单测通过 |
| F-023 | search | ES _id 排序 → all shards failed | 移除 _id tiebreaker | 搜索正常 |
| F-024 | search | Search After FieldValue 序列化 | +serializeSearchAfter | 翻页正常 |
| F-025 | gateway | recommend 路由缺失 | application.yml | 路由可达 |
| F-036 | analytics | 端口 19003 冲突启动失败 | 重启服务 | 端口通 |
| F-037 | inventory | `skuId=6` 不存在的死信消息无限重试 | 确认已过期，不再重试 | 日志无新增 |
| F-038 | search | 端口 19016 冲突启动失败 | 重启服务 | 端口通 |
| F-039 | coupon | 端口 19010 冲突启动失败 | 重启服务 | 端口通 |
| F-041 | cart | 合并跳过 SKU 不存在（999999999998） | 确认为防御逻辑，非 bug | 日志正常 |
| F-042 | product | SKU 不存在（999）告警 | 确认为业务异常，非 bug | 日志正常 |
| F-043 | 15 模块 | LOGSTASH appender 缺 includeMdcKeyName → ES 无 traceId | 15 个 logback-spring.xml | traceId 可查 |

### 2.2 服务恢复状态（2026-08-18 22:24 验证）

```
gateway:19000 OPEN      user:19001 OPEN       content:19002 OPEN
analytics:19003 OPEN    counter:19004 OPEN    product:19008 OPEN
inventory:19009 OPEN    coupon:19010 OPEN     order:19011 OPEN
payment:19012 OPEN      notification:19013 OPEN  cart:19014 OPEN
home:19015 OPEN         search:19016 OPEN
```

所有服务启动日志显示 `Started ... in X seconds`，无 `APPLICATION FAILED TO START`。

### 2.3 遗留的分布式时序问题（非代码 bug）

以下问题属于分布式环境下的时序/一致性问题，需要在隔离环境做回归验证：

- `F-037`：inventory 历史坏消息（`skuId=6` 不存在）的死信处理——已在运行态确认不再重试
- 跨服务 Feign 调用的超时与重试策略——需要压测验证
- 事务消息的最终一致性——需要端到端交易链验证

---

## 三、vol-xhs 目录规划与写作指引

### 3.1 目录结构总览

```
vol-xhs/
├── 00-overview-architecture/     — 全局架构、服务地图、业务主链路
│   ├── 01-service-topology.md    — 服务拓扑与依赖关系
│   ├── 02-business-domains.md    — 业务域划分与边界
│   ├── 03-data-flow.md           — 核心数据流（下单/支付/履约）
│   └── 04-technology-stack.md    — 技术栈选型与版本
│
├── 01-user-account-auth/         — 用户、账号、认证、会话
│   ├── 01-user-registration.md   — 注册流程（验证码/密码/第三方）
│   ├── 02-jwt-auth.md            — JWT 签发/验证/刷新
│   ├── 03-permission-model.md    — 角色权限模型
│   └── 04-session-management.md  — 会话管理与 Token 生命周期
│
├── 02-content-feed-interaction/  — 内容、Feed、互动
│   ├── 01-note-publish.md        — 笔记发布（图文/视频）
│   ├── 02-feed-flow.md           — Feed 流（推拉混合）
│   ├── 03-interaction.md         — 点赞/收藏/评论/分享
│   ├── 04-content-moderation.md  — 内容审核与风控
│   ├── 05-analytics-social-graph.md — analytics 关系真相层
│   └── 06-counter-view.md        — counter 计数展示层
│
├── 03-product-sku-catalog/       — 商品、SKU、类目
│   ├── 01-spu-sku-model.md       — SPU/SKU 数据模型
│   ├── 02-category-price.md      — 类目树与价格体系
│   ├── 03-product-detail.md      — 商品详情聚合
│   └── 04-inventory-link.md      — 商品与库存关联
│
├── 04-cart-coupon-marketing/     — 购物车、优惠券、营销
│   ├── 01-cart-merge.md          — 购物车合并（登录/未登录）
│   ├── 02-coupon-lifecycle.md    — 优惠券发放/领取/核销
│   ├── 03-promotion-rules.md     — 促销规则引擎
│   └── 04-marketing-stack.md     — 营销叠加与优先级
│
├── 05-inventory-order-payment/   — 库存、订单、支付主交易链
│   ├── 01-inventory-three-level.md — 三级扣减（预占/确认/回退）
│   ├── 02-order-create.md        — 下单流程（Feign 编排）
│   ├── 03-transaction-message.md — 事务消息与最终一致性
│   ├── 04-payment-flow.md        — 支付流程（策略模式）
│   └── 05-fulfillment.md         — 履约与退款
│
├── 06-search-recommendation-home/ — 搜索、推荐、首页
│   ├── 01-es-search.md           — ES 全文搜索
│   ├── 02-recommend-pipeline.md  — 推荐 Pipeline
│   ├── 03-hot-search.md          — 热搜滑动窗口
│   ├── 04-home-bff.md            — 首页 BFF 聚合
│   ├── 05-search-module.md       — search 模块专章
│   └── 06-home-module.md         — home 模块专章
│
├── 07-im-notification-message/   — IM、通知、消息
│   ├── 01-websocket-im.md        — WebSocket IM 架构
│   ├── 02-sse-notification.md    — SSE 推送
│   ├── 03-message-aggregation.md — 消息聚合与未读计数
│   ├── 04-cross-instance.md      — 跨实例消息路由
│   ├── 05-im-module.md           — im 模块专章
│   └── 06-notification-module.md  — notification 模块专章
│
├── 08-gateway-security-observability/ — 网关、安全、可观测
│   ├── 01-gateway-routing.md     — 路由与过滤器链
│   ├── 02-jwt-hmac.md            — JWT + HMAC 签名
│   ├── 03-sentinel-limit.md      — Sentinel 限流熔断
│   ├── 04-observability.md       — SkyWalking + Prometheus + Grafana
│   └── 05-gateway-module.md      — gateway 模块专章
│
├── 09-data-model-storage/        — 数据模型与存储
│   ├── 01-mysql-sharding.md      — MySQL 分库分表（ShardingSphere）
│   ├── 02-redis-strategy.md      — Redis 缓存策略（三实例）
│   ├── 03-es-index.md            — ES 索引设计
│   └── 04-mq-topology.md         — MQ Topic 与消费组
│
├── 10-async-task-transaction/    — 异步与事务
│   ├── 01-async-event.md         — 异步事件驱动
│   ├── 02-transaction-message.md — 事务消息（RocketMQ）
│   ├── 03-compensation.md        — 补偿与幂等
│   └── 04-scheduled-task.md      — 定时任务（XXL-Job）
│
├── 11-runtime-failure-review/    — 运行时故障与复盘
│   ├── 01-port-conflict.md       — 端口冲突案例（coupon/analytics/search）
│   ├── 02-dead-letter.md         — 死信消息案例（inventory skuId=6）
│   ├── 03-feign-timeout.md       — Feign 超时与重试
│   └── 04-startup-failure.md     — 服务启动失败排查
│
├── 12-testing-release-ops/       — 测试、发布、运维
│   ├── 01-test-strategy.md       — 测试策略（单测/集成/E2E）
│   ├── 02-startup-script.md      — 启动脚本与参数
│   ├── 03-deploy-pipeline.md     — 部署流程
│   └── 04-monitoring-alert.md    — 监控告警
│
├── 13-common-cross-cutting/      — common 横切基础设施
│   ├── 01-common-infrastructure.md — common 横切能力总览
│   └── 02-common-module.md       — common 模块专章

├── HANDOFF-XHS.md                — 本交接文档
└── README.md                     — 卷级总览
```

### 3.2 当前进度快照（2026-08-22）

- `00` 到 `12` 各目录都已存在主稿
- `02`、`06`、`07`、`08`、`13` 已补出模块专章（如 `analytics/counter`、`search/home`、`im/notification`、`gateway/common`）
- `09`、`10`、`11`、`12` 也已经建立主骨架，不再是空白目录
- `SUMMARY.md` 当前模块正文统计已更新到 `62` 篇；另有 7 篇入口/方法论/交接文件

### 3.3 每篇写作要求

每篇文档必须包含：

1. **开篇困惑**：读者带着什么问题来？
2. **机制拆解**：角色→动机→障碍→手段
3. **源码证据**：关键代码片段（截取可，编造不可）
4. **设计取舍**：为什么这么做而不是那么做？
5. **故障案例**：真实的 bug/故障及其修复
6. **桥接下一篇**：悬念引向下一个主题

### 3.4 写作优先级建议

**当前优先级已经转移到横切目录收口**：
- `09-data-model-storage/` — 数据层
- `10-async-task-transaction/` — 异步机制
- `11-runtime-failure-review/` — 故障复盘
- `12-testing-release-ops/` — 工程实践

**次优先级**：
- 回头补 `07-im-notification-message/` 多实例运行态证据
- 回头补 `06-search-recommendation-home/` 的容量热点与运行态风险
- 把最新代码修复同步回更多测试 / 故障 /交接文档

---

## 四、已有文档索引

### 4.1 项目内文档（`/data/workspace/my-xhs/docs/`）

| 文档 | 路径 | 内容 |
|---|---|---|
| 最终交接 | `docs/FINAL-HANDOFF.md` | 2026-08-01 完整交接（16 模块 + 可观测性） |
| 模块交接 | `docs/HANDOFF.md` | 16 模块逐一梳理状态 |
| 可观测性问题 | `docs/observability-issues.md` | SkyWalking/ES/Prometheus 问题记录 |
| SkyWalking 问题 | `docs/skywalking-issue.md` | SkyWalking 排查全过程 |
| Canal 问题 | `docs/canal-issue.md` | Canal 同步问题 |
| traceId 问题 | `docs/traceid-es-issue.md` | traceId 不进 ES 的根因 |
| Review 方法论 | `docs/review-method/` | 代码 review 方法 |
| Test-3 手册 | `docs/test-3/` | 运行时验证手册（F-037 等） |

### 4.2 本轮新增文档

| 文档 | 路径 | 内容 |
|---|---|---|
| 本交接文档 | `vol-xhs/HANDOFF-XHS.md` | 业务梳理阶段交接 |
| 卷级总览 | `vol-xhs/README.md` | vol-xhs 目录结构与阅读顺序 |

---

## 五、方法论约束

### 5.1 必须遵守的写作规范

先读：
- `docs/openjdk/WRITING-METHODOLOGY.md`
- `docs/openjdk/WRITING-GUIDELINES.md`

最低执行要求：
1. **三步分离**：素材提取 → 理解路径设计 → 叙事写作
2. **正文不是源码翻译**：删掉代码块后主线仍能成立
3. **先问题、场景、障碍，再设计与代码证据**
4. **每篇必须有故障/失败案例**
5. **篇末必须桥接下一篇**
6. **代码块 = 真实源码**：截取可，编造不可

### 5.2 与 vol-02（OpenJDK 卷）的区别

| 维度 | vol-02 | vol-xhs |
|---|---|---|
| 源码 | jdk11u hotspot C++ | my-xhs Java/Spring Cloud |
| 行号精度 | 逐行 grep 验证 | 文件级引用，不伪造行号 |
| 侧重点 | JVM 内部机制 | 业务流程 + 分布式架构 |
| 故障案例 | 源码级 bug | 线上运行时故障 |
| 工具实证 | jcmd/jstat/JFR/SIGQUIT | curl/jcmd/SkyWalking/Grafana |

---

## 六、环境与工具

### 6.1 开发环境

- **JDK**: `/data/tmp/opencode/jdk11`（Temurin 11.0.32）
- **Maven**: 系统自带
- **IDE**: 无（纯 CLI 操作）

### 6.2 常用命令

```bash
# 查看服务端口
ss -ltnp | grep ':1900'

# 查看服务进程
ps -ef | grep 'my-xhs-' | grep 'target/my-xhs-'

# 查看启动日志
tail -100 /data/workspace/my-xhs/logs/my-xhs-{service}.log

# 搜索错误
rg -n "ERROR|Exception|FAILED" /data/workspace/my-xhs/logs/my-xhs-{service}.log

# 重启服务（带 SkyWalking）
nohup java -javaagent:/data/workspace/my-xhs/skywalking-agent-9.6.0/skywalking-agent.jar \
  -Dskywalking.agent.service_name=my-xhs-{service} \
  -Dskywalking.collector.backend_service=21.130.247.89:11800 \
  -Xms512m -Xmx512m -XX:+UseG1GC \
  -jar /data/workspace/my-xhs/my-xhs-{service}/target/my-xhs-{service}-1.0-SNAPSHOT.jar \
  > /data/workspace/my-xhs/logs/my-xhs-{service}.log 2>&1 &

# 一键重启所有服务
/data/workspace/my-xhs/scripts/restart-all-skywalking.sh
```

### 6.3 访问凭证

- MySQL: `21.130.247.89:13306`（root / 见 .env.local）
- Redis: `21.130.247.89:16379/16380/16381`
- ES: `21.130.247.89:19200`（elastic / Xhs@2026#Elastic）
- Nacos: `21.130.247.89:18848`
- Grafana: `21.130.247.89:13000`（admin / Xhs@2026#Admin）
- SkyWalking: `21.130.247.89:8080`

---

## 七、已知问题与避坑指南

### 7.1 端口冲突

- `coupon` 端口 19010 曾被占用（已解决）
- `analytics` 端口 19003 曾被占用（已解决）
- `search` 端口 19016 曾被占用（已解决）
- **排查方法**: `ss -ltnp | grep ':PORT'` + `lsof -iTCP:PORT -sTCP:LISTEN`

### 7.2 Feign URL override

Spring Cloud 2023.0.1 + Nacos 2.3.0 的 LoadBalancer hashCode NPE bug，所有跨服务调用都需要在 `application.yml` 配置：
```yaml
spring.cloud.openfeign.client.config.{service}.url=http://localhost:{port}
```

### 7.3 SkyWalking 插件

- `apm-springmvc-annotation-3.x/4.x/5.x` 与 `6.x` **不能共存**
- 需要从 `optional-plugins/` 移到 `plugins/` 的插件：gateway-4.x、sentinel-1.x、nacos-client-2.x、mybatis-3.x、spring-tx

### 7.4 ES traceId

- 15 个服务的 `logback-spring.xml` 需要配置 `includeMdcKeyName`（已修复）
- Logstash grok 需要提取 traceId 字段（已配置）

---

## 八、给下一位 AI 的开场动作

### 第一步：读全局架构

1. 读本文件 `HANDOFF-XHS.md`
2. 读 `vol-xhs/README.md`
3. 读 `docs/FINAL-HANDOFF.md` 了解 2026-08-01 的完整交接

### 第二步：确认服务状态

```bash
# 端口检查
python3 -c "
import socket
ports={19000:'gateway',19001:'user',19002:'content',19003:'analytics',19004:'counter',19008:'product',19009:'inventory',19010:'coupon',19011:'order',19012:'payment',19013:'notification',19014:'cart',19015:'home',19016:'search'}
for p,name in ports.items():
    s=socket.socket(); s.settimeout(0.5)
    try:
        s.connect(('127.0.0.1',p)); print(f'{name}:{p} OPEN')
    except: print(f'{name}:{p} CLOSED')
    finally: s.close()
"
```

### 第三步：开始写作

1. 选择一个子目录（建议从 `00-overview-architecture/` 开始）
2. 读对应的源码模块
3. 按方法论写第一篇
4. 写完自查 + 深审
5. 提交后进入下一篇

---

## 九、一句话总结

my-xhs 的代码修复与服务恢复已完结，下一步是按 `vol-xhs/` 的 13 个子目录，逐域做业务深度梳理与技术文档写作。核心交易链（`05-inventory-order-payment`）和全局架构（`00-overview-architecture`）是最优先的写作目标。
