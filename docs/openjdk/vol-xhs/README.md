# 卷 XHS · 小红书电商平台业务深度分析

> 基于 `my-xhs` 微服务平台的业务梳理、故障修复与架构分析。
> 当前模块正文统计：`62` 篇；主链已立住，正在进行横切目录收口与运行态证据补强。
> 每个子目录按业务域组织，遵循 `WRITING-METHODOLOGY.md`、`WRITING-GUIDELINES.md` 与 `METHODOLOGY.md` 的方法论。

## 阅读入口

1. 先读 `HANDOFF-XHS.md` 了解项目状态、目录规划与阶段目标
2. 再读 `../WRITING-METHODOLOGY.md` 和 `../WRITING-GUIDELINES.md` 了解总写作规范
3. 再读 `METHODOLOGY.md` 明确本卷在微服务场景下的落地方法
4. 再读 `00-overview-architecture/` 建立全局心智模型
5. 然后按主交易链与业务域逐步推进

## 目录结构

```
vol-xhs/
├── 00-overview-architecture/    — 全局架构、服务地图、业务主链路、领域边界
├── 01-user-account-auth/        — 用户、账号、认证、会话、权限
├── 02-content-feed-interaction/ — 内容发布、Feed、点赞评论收藏分享
├── 03-product-sku-catalog/      — 商品/SPU/SKU、类目、价格、详情
├── 04-cart-coupon-marketing/    — 购物车、优惠券、营销规则、促销叠加
├── 05-inventory-order-payment/  — 库存、下单、支付、履约主交易链
├── 06-search-recommendation-home/ — 搜索、推荐、首页聚合与排序
├── 07-im-notification-message/  — IM、通知、消息模型、投递链路
├── 08-gateway-security-observability/ — 网关、鉴权、安全、日志、链路追踪
├── 09-data-model-storage/       — 表结构、缓存、索引、ES、MQ、数据一致性
├── 10-async-task-transaction/   — 异步任务、事件、事务消息、补偿、幂等
├── 11-runtime-failure-review/   — 线上故障、坏消息、端口冲突、复盘案例
├── 12-testing-release-ops/      — 测试策略、联调、启动脚本、发布与巡检
├── HANDOFF-XHS.md               — 交接文档（唯一入口）
├── METHODOLOGY.md               — 本卷专用方法论（模块优先 + 四视角解剖 + 三层证据）
└── README.md                    — 本文件
```

## 阅读顺序建议

1. 先读 `HANDOFF-XHS.md` 了解全局状态与阶段目标
2. 再读 `../WRITING-METHODOLOGY.md` 和 `../WRITING-GUIDELINES.md` 了解总写作规范
3. 再读 `METHODOLOGY.md` 了解本卷的写作纪律、证据分级与故障案例要求
4. 再读 `00-overview-architecture/` 建立全局心智模型
5. 按业务主线：`01-user` → `03-product` → `04-cart` → `05-inventory-order-payment` → `06-search` → `07-im`
6. 横切面：`08-gateway` → `09-data-model` → `10-async` → `11-failure` → `12-testing`
7. 当前推荐优先阅读：`09-data-model-storage/`、`10-async-task-transaction/`、`11-runtime-failure-review/`、`12-testing-release-ops/`

## 项目源码位置

- 代码仓库：`/data/workspace/my-xhs/`
- 日志目录：`/data/workspace/my-xhs/logs/`
- 启动脚本：`/data/workspace/my-xhs/scripts/`
- 测试文档：`/data/workspace/my-xhs/docs/test-*/`
- Review 文档：`/data/workspace/my-xhs/docs/review-*/`
