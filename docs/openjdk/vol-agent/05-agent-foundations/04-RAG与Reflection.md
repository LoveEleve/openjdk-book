# RAG 与 Reflection：Agent 如何检索知识并自我改进

> 前置：`03-Planning与Memory.md`
> 本篇任务：理解 RAG（检索增强生成）和 Reflection（反思）的原理，以及它们如何让 Agent 不依赖模型参数"死记硬背"。

---

## 一、这一章真正的问题

Agent 的知识来源有三个：

1. **模型参数内的知识**（预训练时学的）
2. **上下文中的知识**（对话历史、工具结果）
3. **外部知识库**（文档、数据库、搜索结果）

前两个我们已经讲了。但有一个问题：

> 模型不知道的事怎么办？它怎么主动获取外部知识？怎么判断自己的输出是否正确？

这一章要回答：
1. RAG 的基本流程是什么？
2. 检索、重排、生成三步怎么做？
3. Reflection 是什么？
4. 为什么模型需要"自我反思"？

---

## 二、最小前置知识

- 理解 embedding 向量（`02-01`）
- 理解 Agent Loop（`05-01`）
- 理解"模型概率高≠事实正确"（`00-4`）

---

## 三、直觉方案为什么不够好

### 直觉方案 1：让模型完全依赖参数知识

> 模型已经学过很多知识，直接回答就行。

问题：
- 模型的知识有截止日期
- 不知道私有知识（公司内部文档）
- 会产生幻觉（编造事实）

### 直觉方案 2：把整个文档库塞进上下文

> 把所有相关文档都放进 prompt，让模型参考。

问题：
- 上下文窗口有限
- 全量文档中真正相关的只有一小部分
- 成本高、延迟大

---

## 四、正式机制

### 1. RAG 的基本流程

RAG（Retrieval-Augmented Generation）的三步：

```text
用户问题
  → 检索（从知识库中找到相关文档）
  → 增强（把文档拼进 prompt）
  → 生成（模型基于文档 + 问题生成答案）
```

### 2. 检索

关键问题：从海量文档中找到与问题最相关的几篇。

常用方法：

#### 向量检索
- 把文档和问题都转成向量
- 计算余弦相似度
- 返回最相似的 top-k 文档

#### BM25（关键词检索）
- 基于词频和逆文档频率
- 不依赖向量，简单高效
- 适合短文本、精确匹配

#### 混合检索
- 向量检索 + BM25 结合
- 两者结果合并，解决各自的盲区

### 3. 增强

检索到的文档不能直接丢给模型，需要处理：

- **拼合**：把多篇文档组合成一段文本
- **排序**：最相关的文档放在最前面
- **引用标注**：标注每个信息来自哪篇文档

### 4. 生成

模型基于"问题 + 检索到的文档"生成答案。

关键要求：
- 模型必须基于检索到的文档回答，而不是"自己编"
- 回答要引用来源
- 如果检索不到相关信息，应该说"不知道"

### 5. RAG 的局限

- 检索质量决定生成质量
- 检索可能不相关（检索失败）
- 检索可能被污染（检索到错误信息）
- 多个文档可能矛盾

### 6. Reflection：自我反思与改进

Reflection 是让模型回顾自己的输出，找出问题并改进。

基本流程：

```text
模型生成输出
  → 反思：检查输出是否正确、完整
  → 如果发现问题 → 修正
  → 再反思 → 再修正 → ... 直到满意
```

#### Reflection 的典型应用

- **代码调试**：模型写完代码后，自己跑一遍检查
- **事实核查**：模型生成答案后，自己验证事实
- **完成判定**：模型检查自己是否真的完成了任务

### 7. Reflection vs RAG

| 维度 | RAG | Reflection |
|------|-----|------------|
| 信息来源 | 外部知识库 | 模型自身输出 |
| 目的 | 获取知识 | 改善质量 |
| 触发 | 每次生成前 | 生成后 |
| 成本 | 检索 + 生成 | 额外生成调用 |

两者可以结合：
- RAG 获取知识
- Reflection 验证生成的答案是否正确使用了这些知识

---

## 五、最小实现 / 伪代码

### 1. 最小 RAG 流程

```python
# 说明：以下依赖外部定义
#   documents   : 知识库文本列表（如 ["文档1", "文档2", ...]）
#   embed       : 文本 → 向量的函数（返回 numpy 数组）
#   cosine_sim  : 计算两个向量余弦相似度
#   numpy as np : 数组运算

def rag_pipeline(query, doc_embeddings, model, top_k=3):
    # 1. 检索
    query_emb = embed(query)
    scores = [cosine_sim(query_emb, doc_emb) for doc_emb in doc_embeddings]
    top_indices = np.argsort(scores)[-top_k:][::-1]

    # 2. 增强
    context = "\n\n".join([documents[i] for i in top_indices])
    prompt = f"基于以下文档回答问题。\n\n文档：\n{context}\n\n问题：{query}"

    # 3. 生成
    answer = model.generate(prompt)
    return answer, top_indices
```

### 2. 最小 Reflection 流程

```python
def reflect_and_improve(model, task, initial_answer, max_rounds=3):
    current = initial_answer
    for round in range(max_rounds):
        # 反思
        reflection = model.generate(
            f"检查以下回答是否正确完整。\n问题：{task}\n回答：{current}\n"
            f"如果发现错误，请给出修正；如果正确，回复 OK。"
        )

        if "OK" in reflection:
            return current    # 已通过

        # 修正
        current = model.generate(
            f"基于以下反思修正回答：\n问题：{task}\n"
            f"原回答：{current}\n反思：{reflection}\n修正回答："
        )

    return current
```

### 3. RAG + Reflection 结合

```python
def agent_with_rag_and_reflection(question, knowledge_base, model):
    # 1. 检索
    docs = retrieve(question, knowledge_base)

    # 2. 基于检索生成回答
    answer = generate_with_context(question, docs, model)

    # 3. 反思：验证回答是否基于文档
    verification = model.generate(
        f"验证以下回答是否基于提供的文档，不要编造。\n"
        f"文档：{docs}\n回答：{answer}\n"
        f"如果回答有编造内容，请指出；如果正确，回复 OK。"
    )

    if "OK" not in verification:
        # 如有问题，重新生成
        answer = generate_with_context(question, docs, model,
                                        extra_hint=verification)

    return answer
```

---

## 六、复杂度与边界

1. **RAG 的质量取决于检索质量**
   - 检索不到 → 模型不知道
   - 检索到错误信息 → 模型被误导

2. **Reflection 不是万能的**
   - 模型可能认为自己是对的，即使错了
   - 独立审查器（separate judge）通常比模型自我反思更可靠

3. **RAG 的延迟成本**
   - 检索 + 生成 = 比直接生成慢
   - 需要做检索缓存和性能优化

4. **Reflection 的累加成本**
   - 每轮反思都要调用模型
   - 需要限制最大反思轮数

---

## 七、论文与真实系统映射

- **RAG**（Lewis et al. 2020）：检索增强生成
- **REALM**（Guu et al. 2020）：检索增强预训练
- **Self-RAG**（Asai et al. 2023）：检索 + 自我反思
- **Reflexion**（Shinn et al. 2023）：语言反馈驱动的自我改进

在真实系统里：
- Agent 系统中，RAG 用于获取知识和工具结果
- Reflection 用于代码调试、答案验证、完成判定
- Reasonix 的 Goaleval 和 Hermes 的 GoalJudge 都实现了独立审查器
- 独立审查器比 self-reflection 更可靠，因为它是"另一个视角"

---

## 八、下一章为什么必须接着读

至此，`05-agent-foundations` 的四篇核心文章已经完成：

```text
01 Agent Loop 与 ReAct：执行骨架
02 Tool Use 与行动闭环：外部能力
03 Planning 与 Memory：规划与记忆
04 RAG 与 Reflection：检索与反思
```

但 Agent 在真实环境中运行，还需要解决更系统的工程问题：

> Agent 怎么持久化会话？怎么恢复崩溃？怎么控制权限？怎么确保安全？

这就是下一阶段 `06-agent-runtime` 和 `09-safety-evaluation` 要回答的问题。

---

## 一句话结论

> **RAG 让 Agent 能获取外部知识，Reflection 让 Agent 能自我改进。两者结合，Agent 不再依赖"模型参数里有哪些知识"，而是能主动检索并验证自己的输出。但独立审查器通常比自我反思更可靠，真正的 Agent 系统需要两者配合。**