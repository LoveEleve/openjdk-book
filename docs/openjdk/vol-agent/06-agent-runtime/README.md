# 06 · Agent Runtime 工程

> 目标：把 AI / Agent 原理落到可持续运行、可恢复、可观测的工程系统。

## 章节规划

1. Agent Runtime 的共同结构
2. 事件、会话与真相层
3. 工具协议与副作用边界
4. 上下文构建与压缩
5. 完成判定、恢复与可观测性
6. 事件溯源、Session Tree 与 Projection
7. 权限、沙箱、租约与共享执行世界
8. Plugin、Capability Seam 与多模型路由
9. Workflow、State Machine 与 Durable Execution
10. 运行时成本：Token、延迟、并发与预算控制

## 现有源码实践

- OpenCode：事件溯源 runtime
- Reasonix：受控长跑任务系统
- Pi：共享运行时与会话状态机
- Hermes：多平台长期代理与账本系统
- dsh：一切皆插件的 Agent 框架

详细文章位于上级 `vol-agent/` 根目录及五个项目子目录中。
