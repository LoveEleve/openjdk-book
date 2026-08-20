# vol-netty-agent 运行计划

- 仓库: `/data/workspace/source-code/code/spring/netty`
- 版本: 当前 checkout (`4.2.x` 预期)
- 目标: `book`
- 范围: `全量跑`
- 对标基线: `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-netty`
- 输出目录: `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-netty-agent`

## 强约束

1. 不覆盖现有 `vol-netty/` 产物
2. 长跑优先，依赖 checkpoint / continue / auto
3. 质量下限不低于 `vol-netty/`
4. 所有运行中间产物写入 `run-artifacts/`
5. 所有验证报告写入 `reports/`

## 运行前检查

- Netty 仓库可读
- LLM 网关已验证可调用
- 输出目录已隔离创建
- 当前关注点: 章节相关性 / 领域层质量 / 大仓稳定性
