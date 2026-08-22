# 08 · 最小实验与验证

> 目标：用可运行的小实验验证公式、模型机制和 Agent Runtime 不变量。

## 实验规划

1. 手写一个两层神经网络与反向传播
2. 手写一个最小 Self-Attention
3. 手写一个 decoder-only Transformer
4. 可视化 Attention 与 token 概率
5. 实现 KV Cache 并比较 decode 成本
6. 实现 greedy、temperature、top-k、top-p sampling
7. 实现最小 RAG pipeline
8. 实现 ReAct 风格 Tool Loop
9. 实现事件源、Projection 与恢复重放
10. 实现 bounded evaluator 与完成判定
11. 构造 Prompt Injection 与工具越权 hostile fixtures
12. 实现 offline trajectory evaluator 与回归报告

## 实验要求

每个实验都应记录：
- 输入与假设
- 最小实现
- 运行结果
- 复杂度与内存成本
- 与真实项目源码的对应关系
- 哪些结论不能从实验直接推广
