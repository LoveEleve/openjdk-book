# 04 · 推理与模型服务

> 目标：理解模型生成阶段的计算、内存、吞吐、延迟和工程边界。

## 章节规划

1. KV Cache：为什么生成不能每次重算全部上下文
2. Batching、吞吐与延迟
3. Sampling 与解码策略
4. 量化、LoRA 与推理成本
5. 长上下文与 Context Window
6. 结构化输出与约束采样
7. Speculative Decoding：草稿模型如何加速生成
8. PagedAttention 与显存管理
9. Streaming、取消与生成生命周期
10. 多模型路由与 Provider 抽象
11. Serving 架构：队列、路由、限流与可观测性

## 阅读目标

读完本组后，应该能解释：
- prefill 和 decode 的计算差异；
- KV Cache 如何换取生成速度；
- batch、并发、吞吐和首 token 延迟之间的关系；
- 量化为什么降低成本又可能损失质量；
- 结构化输出如何从 prompt 约束升级为运行时协议。
