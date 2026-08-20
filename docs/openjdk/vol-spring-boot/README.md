# 卷 Spring Boot · 自动装配与运行时装配总线

> 本卷用于承接 `vol-spring` 之后的上层装配世界：`SpringApplication.run()`、`@SpringBootApplication`、自动装配、嵌入式 Web 容器、Actuator、运行时可用性与测试切片。写作前请先遵循交接文档：
>
> `../HANDOFF-VOL-SPRING-TO-SPRINGBOOT.md`

## 当前状态

- 目录已创建
- 正文未开始
- **第一优先级不是写正文，而是先 review Boot 既有规划域与 outlines**

## 后续第一步

先 review：

- `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/issue/SpringBoot源码学习范围规划.md`
- `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/issue/源码范围规划复盘方法论.md`
- `../WRITING-METHODOLOGY.md`
- `../HANDOFF-VOL-SPRING-TO-SPRINGBOOT.md`

## 写作原则

延续 `vol-spring` 当前阶段的正文风格：

- 困惑开场
- 失败方案
- 最小总图
- 主线拆解
- 易错判断
- 收网桥接

注意：

- 当前阶段先铺正文主线
- 源码证据层（代码块 / file:line 密集补强）后续统一回补

## 推荐总入口

完成规划 review 后，建议从以下二选一开始：

1. `SpringApplication.run()`
2. `@SpringBootApplication`

优先建议：

- `SpringApplication.run()`

因为它最像整卷的总指挥入口，最适合把 Boot 的装配世界与 `vol-spring` 里的 `refresh()` 总链桥接起来。
