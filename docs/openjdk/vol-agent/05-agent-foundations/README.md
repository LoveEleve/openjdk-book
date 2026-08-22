# 05 · Agent 原理

> 目标：解释语言模型如何通过工具、计划、记忆和反馈变成任务执行系统。

## 章节规划

1. 从语言模型到 Agent Loop
2. ReAct、Tool Use 与行动闭环
3. Planning：为什么 Agent 需要计划
4. Memory：短期上下文与长期记忆
5. RAG：检索如何进入推理
6. Reflection、Critic 与完成判定
7. Context Engineering：上下文不是无限内存
8. Multi-Agent 与任务委派
9. Browser Use、Computer Use 与环境交互
10. Agent 评测：任务成功不等于模型自称完成
9. 提示注入、工具安全与副作用边界

## 阅读目标

读完本组后，应该能解释：
- Agent Loop 与普通聊天循环的差异；
- 工具调用为什么是协议而不是函数绑定；
- 计划、执行、评估如何形成控制闭环；
- 记忆、RAG、Reflection 和 Subagent 分别解决什么问题；
- Agent 为什么必须拥有停止、恢复和安全边界。
