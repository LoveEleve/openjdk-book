# 09 · 安全、评测与可靠性

> 目标：回答“模型看起来能用，如何证明它可靠、不会越权、不会被提示注入带偏”。

## 章节规划

1. 语言模型的不确定性、幻觉与校准
2. Prompt Injection、Indirect Injection 与数据边界
3. Tool Sandboxing、Capability Security 与最小权限
4. 数据泄露、Secret Scope 与输出过滤
5. Agent 评测：正确性、轨迹、成本、延迟与安全
6. LLM-as-a-Judge 的偏差与独立评估器
7. Red Team、Hostile Fixture 与故障注入
8. 可靠性：重试、幂等、恢复与停止条件
9. 生产监控：质量、成本、漂移与回归
10. Responsible AI 与模型治理

## 阅读目标

读完本组后，应该能解释：
- 为什么模型概率高不等于事实可靠；
- 为什么 Prompt Injection 是数据/指令边界问题，而不只是提示词问题；
- 为什么工具权限、沙箱、凭证和输出过滤必须分层；
- 为什么 Agent 评测不能只看最终文本；
- 为什么 judge 也需要被评测，且不能成为唯一真相；
- 如何把失败样本、攻击样本和生产轨迹变成持续回归测试。

## 重点论文与标准

- TruthfulQA
- HELM
- Holistic Evaluation of Language Models
- Constitutional AI
- Red Teaming Language Models with Language Models
- AgentBench
- SWE-bench
- OWASP Top 10 for LLM Applications
