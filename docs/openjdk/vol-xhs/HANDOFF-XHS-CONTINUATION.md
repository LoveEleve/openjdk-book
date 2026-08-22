# HANDOFF-XHS-CONTINUATION — vol-xhs 续写交接文档

> 状态：2026-08-19
> 目标：把当前 `vol-xhs` 的写作进度、方法论约束、部署运行态事实、已完成篇章与后续优先级一次性交给下一个 AI。
> 使用方式：新 AI 先读 `HANDOFF-XHS.md`、`README.md`、`METHODOLOGY.md`，再读本文件，最后继续写作。

---

## 一、当前阶段一句话总结

当前 `vol-xhs` 已经不再停留在“代码修复和服务恢复”阶段，而是已经进入**业务深度分析正文生产阶段**。

并且已经完成了两类重要工作：

1. **卷级方法论和入口文件已经修顺**：`HANDOFF-XHS.md`、`README.md`、`METHODOLOGY.md` 已对齐，不再有篇幅、证据层级、阅读顺序等硬冲突。
2. **若干核心业务域正文已经起稿并多轮 review 收敛**：尤其是全局架构、商品链、交易前置链、交易主链、用户会话链、搜索推荐链、内容链、通知/IM 感知链，已经从“只有目录规划”进入“有真实正文”的状态。

但要明确：**现在完成的是主骨架，不是全卷完工。** 许多域已经讲清主线、边界和关键状态机，但离“全业务全分支都打透”还有距离。

---

## 二、先读什么（强制顺序）

新 AI 接手后，建议严格按这个顺序阅读：

1. `docs/openjdk/vol-xhs/HANDOFF-XHS.md`
2. `docs/openjdk/WRITING-METHODOLOGY.md`
3. `docs/openjdk/WRITING-GUIDELINES.md`
4. `docs/openjdk/vol-xhs/README.md`
5. `docs/openjdk/vol-xhs/METHODOLOGY.md`
6. 本文件 `docs/openjdk/vol-xhs/HANDOFF-XHS-CONTINUATION.md`

然后再按需要读部署和运行态材料：

7. `/data/workspace/my-xhs/config/docker-compose.yml`
8. `/data/workspace/my-xhs/docs/FINAL-HANDOFF.md`
9. `/data/workspace/my-xhs/docs/HANDOFF.md`
10. `/data/workspace/my-xhs/docs/test-3/REVIEW-METHODOLOGY.md`
11. `/data/workspace/my-xhs/docs/test-3/` 相关手册、cases、pitfalls

如果不先读这些文件，后面很容易出现两类问题：

- 写作上重新犯“按源码顺序抄一遍”的旧错
- 运行态上重新犯“只看源码、不看部署现实”的旧错

---

## 三、当前方法论已经收敛到什么程度

### 1. 卷级方法论已经落地

`docs/openjdk/vol-xhs/METHODOLOGY.md` 已明确规定：

- **按模块组织，不按问题类型组织**
- **每个模块按 4 视角解剖**：业务逻辑 / 工程问题 / 分布式问题 / 微服务问题
- **三层证据法**：
  - L0 源码静态证据
  - L1 框架/语义证据
  - L2 运行态证据
- **每篇必须包含真实故障案例**
- **每篇必须有证据清单和边界清单**
- **删码测试必须通过**

### 2. 本轮写作的真实执行策略

到目前为止，实际已经形成了一套可继续沿用的执行策略：

- 先写**全局心智模型**，再写**交易主链**，再回补用户、搜索、内容、通知等用户可见域
- 先立**主骨架**，再回头做**二轮/三轮深审补强**
- 每写完一篇，都先做一次**方法论 review**，再按 review findings 修补
- review 重点不是文风，而是：
  - 事实级错误
  - 证据不够
  - 口径过满
  - 边界不清
  - 故障案例太虚

### 3. 当前最重要的写作纪律

新 AI 必须延续这些纪律：

- 不要凭记忆或常识脑补“这个系统应该怎样”，一律以源码 + 部署 + 交接文档为准
- 不要把“目录里计划要写的主题”误写成“代码里已经有完整实现的能力”
- 不要把“推断”写成“既成事实”，尤其是：
  - 独立 promotion engine
  - 完整人工审核平台
  - 完整物流平台
  - 统一 RBAC 权限平台
- 不要只靠源码推进，部署/运行态事实要及时合并进证据链

---

## 四、部署与运行态事实（必须记住）

这是当前续写最容易遗漏、但又非常关键的一层。

### 1. 远程中间件机与服务机

根据 `docker-compose.yml` 与交接文档，当前应这样理解环境：

- **中间件机**：`21.130.247.89`
- **服务机**：`21.214.97.212`（交接文档和测试材料里多次出现）

注意：很多正文里引用的“对外访问端口”和 `docker-compose` 里的“容器内部 host 模式端口”不是一个层次。

### 2. docker-compose 是运行态核心事实源之一

`/data/workspace/my-xhs/config/docker-compose.yml` 已明确：

- 单机部署 22 容器
- `network_mode: host`
- 关键组件包括：
  - MySQL 主从 `3306 / 3307`
  - Redis `6379 / 6380 / 26379`
  - RocketMQ `9876 / 11911 / 18081`
  - ES `19200 / 19201`
  - Nacos `18848`
  - Sentinel `8858`
  - XXL-Job `18080`
  - SkyWalking OAP/UI `11800 / 12800 / 8080`
  - Prometheus `19090`
  - Grafana `13000`
  - Kibana `15601`
  - Logstash `15044 / 15045`

### 3. 对外访问端口与业务文档中的端口不同层

`docs/FINAL-HANDOFF.md:197` 之后给出的对外访问现实是：

- MySQL：`13306 / 13307 / 13308 / 13309`
- Redis：`16379 / 16380 / 16381`
- ES：`19200`
- SkyWalking ES：`19201`
- Nacos：`18848`
- RocketMQ：`9876 / 9877`
- XXL-Job：`18080`
- Sentinel：`8858`
- Prometheus：`19090`
- Grafana：`13000`
- SkyWalking UI：`8080`

新 AI 写文时一定要分清：

- **服务端口**：`19000~19016`
- **容器 host 模式端口**：`3306/6379/9876...`
- **对外暴露/代理/多库拆分端口**：`13306/16379...`

不要把这三层写混。

### 4. 运行态材料不是附录，是正文证据源

后续所有重要篇章，只要涉及：

- Nacos
- RocketMQ
- Redis Sentinel
- SkyWalking
- Prometheus / Grafana
- Kibana / Logstash
- XXL-Job

都应该结合：

- `docker-compose.yml`
- `FINAL-HANDOFF.md`
- `HANDOFF.md`
- `docs/test-3/` 的运行手册与 review 方法论

不能只盯源码。

---

## 五、当前已经起稿并经过多轮 review 的篇章

以下文件已经存在正文，且多数经过“写作 → review → 修补 → 再 review”的收敛过程。

### 00-overview-architecture

1. `00-overview-architecture/01-service-topology.md`
2. `00-overview-architecture/02-business-domains.md`
3. `00-overview-architecture/03-data-flow.md`
4. `00-overview-architecture/04-technology-stack.md`

当前状态：
- 全局心智模型已基本立住
- 对“模块边界 / 数据流 / 技术栈”已有骨架级解释
- 还能继续补运行态证据，但主线已可用

### 01-user-account-auth

1. `01-user-account-auth/01-user-registration.md`
2. `01-user-account-auth/02-jwt-auth.md`
3. `01-user-account-auth/03-permission-model.md`
4. `01-user-account-auth/04-session-management.md`

当前状态：
- 用户入口链已基本立住
- 注册 / JWT / 权限 / 会话 4 篇主线都在
- 其中权限模型篇和会话篇对“JWT + Redis + Gateway + 二次门禁”的边界已经比较细

### 02-content-feed-interaction

1. `02-content-feed-interaction/01-note-publish.md`
2. `02-content-feed-interaction/02-feed-flow.md`
3. `02-content-feed-interaction/03-interaction.md`
4. `02-content-feed-interaction/04-content-moderation.md`
5. `02-content-feed-interaction/05-analytics-social-graph.md`
6. `02-content-feed-interaction/06-counter-view.md`

当前状态：
- 内容主链已立住：发布 → Feed → 互动 → 审核边界
- 互动链已补出两个单独的关系/计数视角：`analytics` 持有社交关系真相，`counter` 持有计数展示视图
- 审核篇已经明确：当前实现是 DFA 前置 + 审核语义预留，不是完整人工审核平台

### 03-product-sku-catalog

1. `03-product-sku-catalog/01-spu-sku-model.md`
2. `03-product-sku-catalog/02-category-price.md`
3. `03-product-sku-catalog/03-product-detail.md`
4. `03-product-sku-catalog/04-inventory-link.md`

当前状态：
- 商品域四篇比较完整
- `SPU / SKU / Inventory` 三层分工已经讲清
- 商品详情聚合和库存链接边界已立住

### 04-cart-coupon-marketing

1. `04-cart-coupon-marketing/01-cart-merge.md`
2. `04-cart-coupon-marketing/02-coupon-lifecycle.md`
3. `04-cart-coupon-marketing/03-promotion-rules.md`
4. `04-cart-coupon-marketing/04-marketing-stack.md`

当前状态：
- 购物车 / 优惠券 / 当前营销收敛边界已立住
- 明确写清：当前没有独立 promotion engine，只是“基础价 + 单券规则 + 订单收敛”的有限营销链

### 05-inventory-order-payment

1. `05-inventory-order-payment/01-inventory-three-level.md`
2. `05-inventory-order-payment/02-order-create.md`
3. `05-inventory-order-payment/03-transaction-message.md`
4. `05-inventory-order-payment/04-payment-flow.md`
5. `05-inventory-order-payment/05-fulfillment.md`

当前状态：
- 交易主链五篇已经成闭环
- 库存三级扣减 / 下单编排 / 事务消息 / 支付 / 履约退款后半段都已有正文
- 这是当前全卷最成熟的一组

### 06-search-recommendation-home

1. `06-search-recommendation-home/01-es-search.md`
2. `06-search-recommendation-home/02-recommend-pipeline.md`
3. `06-search-recommendation-home/03-hot-search.md`
4. `06-search-recommendation-home/04-home-bff.md`
5. `06-search-recommendation-home/05-search-module.md`
6. `06-search-recommendation-home/06-home-module.md`

当前状态：
- 流量入口组已经补到 6 篇
- 搜索、推荐、热搜、BFF 的主线都立住了
- 已新增 search / home 两个模块专章，并补入真实故障案例与修复前后对比

### 07-im-notification-message

1. `07-im-notification-message/01-websocket-im.md`
2. `07-im-notification-message/02-sse-notification.md`
3. `07-im-notification-message/03-message-aggregation.md`
4. `07-im-notification-message/04-cross-instance.md`
5. `07-im-notification-message/05-im-module.md`
6. `07-im-notification-message/06-notification-module.md`

当前状态：
- IM / SSE 通知 / 通知聚合与未读数 / 跨实例路由四篇主线已齐
- 已新增 `im` / `notification` 两个模块专章，并补入真实故障案例
- “通知 ≠ IM”的边界已经比较清楚

---

## 六、哪些篇章虽然有稿，但仍适合继续打磨

即使已有篇章已经“过线”，也要知道哪些地方仍有可继续打磨空间。

### 1. 全局总览组（00）

可继续增强的方向：

- 引入更多部署/运行态实证
- 把 compose / 远程访问端口 / 交接材料更深地并入正文
- 做图谱型总串联（但不要脱离当前业务主线）

### 2. 搜索推荐组（06）

可继续增强的方向：

- 索引构建链的源码实证
- 推荐链的运行态行为验证
- 热搜快照、反作弊和修正规则的更多运行态案例

### 3. IM / 通知组（07）

可继续增强的方向：

- 补离线消息 / 已读回执 / 未读对账的更强运行态证据
- 强化通知聚合窗口与 SSE 多实例路由的实锚
- 继续补 IM 与 SSE 跨实例链的多实例实测材料（当前正文已建立代码与历史证据边界）

---

## 七、当前还没系统展开、优先级很高的目录

以下目录仍是后续重点。

### P1：已立主干，但可继续补深

- `01-user-account-auth/`
- `06-search-recommendation-home/`
- `07-im-notification-message/`

### P2：还没真正系统开写或仅起了局部骨架

- `09-data-model-storage/`
- `10-async-task-transaction/`
- `11-runtime-failure-review/`
- `12-testing-release-ops/`

这些目录后续很重要，因为它们会把前面已经写完的主链再做一次横切收束。

尤其要注意：

- `09` 会把分库分表、Redis、ES、MQ Topic 这些基础数据结构串起来
- `10` 会把异步/事务/补偿统一成一组跨域机制
- `11` 会把端口冲突、死信、Feign 超时、启动失败这些真实故障系统复盘
- `12` 会把测试、发布、巡检、脚本、监控告警收口

---

## 八、当前最新代码修复与剩余风险

### 已落代码修复（本轮新增）

1. `my-xhs-home/src/main/java/com/myxhs/home/job/FeedCleanupJob.java`
   - 修复清理任务限速计数器作用域，恢复“每 100 条 sleep 50ms”节流
2. `my-xhs-search/src/main/java/com/myxhs/search/job/IncrementalIndexSyncJob.java`
   - Redis 补偿集合改原子 `pop()`，避免多实例重复补偿
3. `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java`
   - 支付成功改成先 Feign 通知订单，再发结果 MQ，缩小乱序窗口
4. `my-xhs-im/src/main/java/com/myxhs/im/handler/ImWebSocketHandler.java`
   - 心跳续期前先校验本地 session 仍存在且 `isOpen()`
5. `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java`
   - 共同关注改成 `intersectAndStore + range`，避免把完整交集先拉回 JVM
6. `my-xhs-counter/src/main/java/com/myxhs/counter/dto/CounterBatchRequest.java`
   - 批量计数查询增加输入上限
7. `my-xhs-user/src/main/java/com/myxhs/user/controller/UserController.java`
   - 新增批量公开用户信息接口
8. `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java`
   - 作者信息改成单次批量 Feign；大 V 关注列表增加 5 分钟缓存
9. `my-xhs-payment/src/main/java/com/myxhs/payment/consumer/PayResultConsumer.java`
   - 空壳消费者默认关闭，不再默认订阅后只打日志
10. `my-xhs-payment/src/main/java/com/myxhs/payment/consumer/RefundResultConsumer.java`
    - 空壳消费者默认关闭，不再默认订阅后只打日志
11. `my-xhs-content/src/main/java/com/myxhs/content/mapper/CommentMapper.java`
    - 去掉 MySQL 8 窗口函数依赖，改成 MySQL 5.7 兼容写法
12. `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java`
    - `getOrderPayAmount()` 只对待支付订单返回金额，和支付补偿链语义对齐
13. `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java`
    - 修复用户偏好分计算：改为按 `userId + category` 真正参与精排
14. `my-xhs-common/src/main/java/com/myxhs/common/aspect/ReadWriteRoutingInterceptor.java`
    - `SELECT ... FOR UPDATE` 不再误路由到从库

### 仍有风险但未继续硬改

- `my-xhs-search/src/main/java/com/myxhs/search/recommend/ContentRecallStrategy.java`
  - 标签召回仍靠 MySQL `LIKE`，数据量上来后会是慢查询热点；这更像读模型容量上限，后续宜迁到 ES / 倒排视图，而不是继续在现有表上做 SQL 小修补
- `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java`
  - 大关注集第一次缓存未命中时，仍会全量扫关注 ZSet
- `my-xhs-common` 多处 Redis 故障时仍采取降级放行策略
  - 属于平台级风险窗口，不是单点 bug

## 九、建议的后续推进顺序

### 方案 A：转入真正还没写透的横切目录（推荐）

1. `09-data-model-storage/01-mysql-sharding.md`
2. `09-data-model-storage/02-redis-strategy.md`
3. `10-async-task-transaction/01-async-event.md`
4. `11-runtime-failure-review/01-port-conflict.md`

优点：
- 现在 `08`、`13` 也已经补出模块专章，用户可感知链和入口控制层都不再是空白
- 可以把前面多篇反复出现的技术机制统一收束

### 方案 B：回头继续打磨运行态热点

1. 深挖 `ContentRecallStrategy` 的标签 `LIKE` 召回容量边界
2. 继续补 `07-im-notification-message/` 的多实例运行态证据
3. 继续把已修代码问题同步进更多测试文档 / 故障文档

当前更推荐 **方案 A**，因为现在最欠缺的已经不是用户主链正文，而是 `09~12` 这些横切目录的系统收束。

---

## 十、接手后最容易犯的错（务必避免）

1. **把“有字段/有枚举/有接口”误写成“完整能力已落地”**
   - 典型例子：
     - 审核状态枚举 ≠ 完整人工审核平台
     - role claim ≠ 完整 RBAC
     - 营销目录 ≠ 独立 promotion engine
     - 发货接口 ≠ 完整物流平台

2. **只看源码，不读部署和运行态材料**
   - 当前环境认知必须同时来自：
     - 代码
     - compose
     - 交接文档
     - test-3 / review-method

3. **把推断写满**
   - 要明确区分：
     - 已证实源码事实
     - 基于实现的设计解释
     - 运行态历史事实
     - 尚未验证边界

4. **忘记 review 是正文生产的一部分**
   - 不要一次性写完一大片再不回头审
   - 当前实践证明：先成稿 → review → 修补 → 再 review 是有效路径

5. **跳过故障案例**
   - 每篇都要有故障/失败案例
   - 哪怕当前没有完整线上事故，也要至少给出“当前实现最危险的真实失败模式”

---

## 十一、下一位 AI 的开场动作

接手后建议按这个顺序开工：

1. 读 `HANDOFF-XHS.md`
2. 读 `WRITING-METHODOLOGY.md`、`WRITING-GUIDELINES.md`
3. 读 `README.md`、`METHODOLOGY.md`
4. 读本文件
5. 读 `docker-compose.yml` 和 `FINAL-HANDOFF.md`
6. 确认下一篇目标文件
7. 先做素材提取，再设计结构，再写正文
8. 写完后先做一次方法论 review，再决定是否推进下一篇

### 如果继续按当前上下文推进，建议下一篇从这里开始

优先候选：

1. `09-data-model-storage/01-mysql-sharding.md`
2. `09-data-model-storage/02-redis-strategy.md`
3. `10-async-task-transaction/01-async-event.md`
4. 回头补强 `07-im-notification-message/04-cross-instance.md` 的多实例运行态证据

当前更推荐：

**`09-data-model-storage/01-mysql-sharding.md`**

原因：
- `08-gateway-security-observability/` 和 `13-common-cross-cutting/` 已经补出模块专章，不再是最空白的位置
- 现在最需要的是把前面交易链、支付链、搜索链、通知链里反复出现的分库分表与 Redis/ES/MQ 数据平面统一收束

---

## 十二、一句话交接

当前 `vol-xhs` 已经完成了“方法论收口 + 多个核心业务域正文起稿并多轮 review 收敛”的关键阶段，最重要的交易主链、商品链、用户会话链、搜索推荐链和内容/通知感知链都已立住主骨架。下一位 AI 不要重头再铺总览，而应在**继续写未完成目录**和**回头用部署/运行态事实补强已有篇章**之间，沿着当前方法论继续推进。