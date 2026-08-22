# 02 · Transformer 与模型原语

> 目标：从 Token 到 Transformer Block，完整追踪一次模型前向计算的数据流。

## 章节规划

1. Tokenizer：文本如何变成 token
2. Token、Embedding 与位置编码
3. Attention：模型如何选择上下文
4. Multi-Head Attention 与表示子空间
5. Causal Mask：为什么模型不能偷看未来
6. Transformer Block：Norm、MLP、Residual
7. Decoder-only Language Model
8. Logits、Softmax 与下一 token 预测
9. 位置编码、RoPE 与长上下文
10. GQA、MQA 与现代 Attention 变体

## 阅读目标

读完本组后，应该能解释：
- token id 如何进入 embedding 表；
- Query、Key、Value 如何形成注意力权重；
- 多头注意力为什么能捕捉不同关系；
- residual、normalization、MLP 如何共同稳定深层网络；
- decoder-only 模型如何把 Transformer 变成语言模型。
