# 实验：最小 RAG + Tool Loop

> 目标：用最简代码验证"检索 → 判断 → 生成"的 RAG 流程和"循环调用工具"的 Agent Loop。
> 对应理论：`../05-agent-foundations/04-RAG与Reflection.md`、`../05-agent-foundations/01-Agent Loop与ReAct.md`
> 前置：Python 基础、numpy

---

## 一、实验目标

1. 实现一个最简 RAG：检索文档 → 拼接 prompt → LLM 生成答案
2. 实现一个最简 Tool Loop：LLM 决定调工具 → 执行 → 把结果喂回 → 循环直到完成
3. 观察"检索质量"和"工具调用次数"对结果的影响

---

## 二、输入与假设

### 输入
- 一个玩具知识库（3 段文档）
- 一个玩具工具集（calculator、lookup）
- 一个 LLM 模拟器（基于规则，不用真模型）

### 假设
- 检索到相关文档 → 答案更准确
- 检索不到 → LLM 编造或回答"不知道"
- 工具调用次数越多，不一定越好——可能存在循环

---

## 三、最小实现

### 0. 玩具知识库

```python
knowledge_base = {
    "doc1": "Python 是一种解释型编程语言，由 Guido van Rossum 于 1991 年发布。",
    "doc2": "Transformer 架构由 Vaswani 等人在 2017 年的论文 'Attention Is All You Need' 中提出。",
    "doc3": "Redis 是一个开源的内存数据结构存储系统，可用作数据库、缓存和消息代理。",
}

def simple_retriever(query, k=1):
    """最简检索器：基于关键词匹配（不用向量）"""
    scores = {}
    query_words = set(query.lower().split())
    for doc_id, text in knowledge_base.items():
        doc_words = set(text.lower().split())
        overlap = len(query_words & doc_words)
        scores[doc_id] = overlap
    
    # 返回 top-k
    ranked = sorted(scores.items(), key=lambda x: -x[1])
    return [doc_id for doc_id, _ in ranked[:k]]

# 测试检索
print("检索 'Python 编程语言':", simple_retriever("Python 编程语言"))
print("检索 'Transformer 注意力':", simple_retriever("Transformer 注意力"))
print("检索 '量子计算':", simple_retriever("量子计算"))
```

### 1. 最简 RAG

```python
def rag_generate(query, knowledge_base, retriever, k=1):
    """RAG 流程：检索 → 拼接 → 生成"""
    # 1. 检索
    doc_ids = retriever(query, k=k)
    docs = [knowledge_base[doc_id] for doc_id in doc_ids]
    
    # 2. 拼接 prompt（模拟 LLM 输入）
    context = "\n".join(docs)
    prompt = f"根据以下信息回答问题。\n\n信息：{context}\n\n问题：{query}\n答案："
    
    # 3. 模拟 LLM 生成（基于规则）
    if not docs or all(d == "" for d in docs):
        return "我不知道。", prompt
    else:
        # 简单规则：返回最相关的文档片段作为"答案"
        return docs[0][:50] + "...", prompt

# 测试 RAG
answer, prompt = rag_generate("Python 是什么", knowledge_base, simple_retriever)
print("Prompt:\n", prompt)
print("答案:", answer)
```

### 2. 最简 Tool Loop（Agent Loop）

```python
tools = {
    "calculator": lambda expr: str(eval(expr)),
    "lookup": lambda topic: knowledge_base.get(topic, f"未找到 '{topic}' 的信息"),
}

def agent_loop(query, tools, max_steps=5):
    """Agent Loop：LLM 决定 → 调工具 → 喂回 → 循环"""
    messages = [{"role": "user", "content": query}]
    step = 0
    
    while step < max_steps:
        step += 1
        last_msg = messages[-1]["content"]
        
        # 模拟 LLM 决策（规则：如果包含"计算"就调 calculator，否则调 lookup）
        if "计算" in last_msg or "多少" in last_msg:
            # 提取表达式（极简：取"计算"后面的部分）
            expr = last_msg.split("计算")[-1].strip()
            tool_name = "calculator"
            tool_input = expr
        elif any(topic in last_msg for topic in knowledge_base):
            tool_name = "lookup"
            # 找到匹配的主题
            tool_input = next(
                topic for topic in knowledge_base 
                if topic in last_msg
            )
        else:
            # 无工具可调，输出最终答案
            messages.append({
                "role": "assistant", 
                "content": f"最终答案：基于以上信息，{last_msg[:100]}"
            })
            break
        
        # 执行工具
        tool_output = tools[tool_name](tool_input)
        print(f"  Step {step}: 调用 {tool_name}({tool_input}) -> {tool_output[:50]}")
        
        # 把工具结果喂回
        messages.append({
            "role": "tool", 
            "content": f"{tool_name} 返回: {tool_output}"
        })
    
    return messages

# 测试 Agent Loop
print("=== Agent Loop 测试 ===")
result = agent_loop("Python 是多少年发布的？请计算 2024 - 1991", tools)
for msg in result:
    print(f"  [{msg['role']}]: {msg['content'][:80]}")
```

### 3. 检索质量对 RAG 的影响

```python
def evaluate_rag_with_noise(query, true_answer, noise_level=0):
    """在知识库中注入噪声文档，观察 RAG 效果"""
    # 注入噪声
    noisy_kb = knowledge_base.copy()
    for i in range(noise_level):
        noisy_kb[f"noise{i}"] = f"这是无关的噪声文档 {i}，与问题无关。"
    
    answer, _ = rag_generate(query, noisy_kb, simple_retriever, k=1)
    correct = true_answer.lower() in answer.lower()
    return correct, answer

# 测试不同噪声水平
print("\n=== 检索质量影响 ===")
for noise in [0, 2, 5]:
    correct, ans = evaluate_rag_with_noise(
        "Python 是什么", "python", noise_level=noise
    )
    print(f"噪声文档数={noise}: 正确={correct}, 答案={ans[:40]}")
```

---

## 四、预期输出

```text
检索 'Python 编程语言': ['doc1']
检索 'Transformer 注意力': ['doc2']
检索 '量子计算': ['doc1']

=== Agent Loop 测试 ===
  Step 1: 调用 calculator(2024 - 1991) -> 33
  [user]: Python 是多少年发布的？请计算 2024 - 1991
  [tool]: calculator 返回: 33
  [assistant]: 最终答案：基于以上信息，Python 是多少年发布的？请计算...

=== 检索质量影响 ===
噪声文档数=0: 正确=True, 答案=Python 是一种解释型编程语言...
噪声文档数=2: 正确=True, 答案=Python 是一种解释型编程语言...
噪声文档数=5: 正确=True, 答案=Python 是一种解释型编程语言...
```

---

## 五、关键观察

1. **RAG 的检索质量决定一切**：如果检索器返回噪声文档，LLM 无法生成正确答案
2. **Agent Loop 需要终止条件**：没有"最终答案"判定，LLM 可能无限循环调工具
3. **工具调用次数 ≠ 效果更好**：简单问题一次工具就够，复杂问题可能需要多次，但过多调用可能是循环
4. **RAG 和 Tool Loop 是 Agent 的两大信息通道**：RAG 获取"知识"，Tool Loop 执行"操作"

---

## 六、与理论正文的对应

| 实验现象 | 理论正文 |
|----------|----------|
| 检索器返回相关文档 | `05-04` 中"Retriever 编码 + 向量检索" |
| 检索不到 → LLM 编造 | `05-04` 中"检索质量决定一切" |
| Agent Loop 循环调工具 | `05-01` 中"Thought → Action → Observation 循环" |
| 终止条件（最终答案） | `05-01` 中"Final Answer 判定" |
| 工具结果喂回 LLM | `06-agent-runtime/02-工具协议与幂等性.md` 中"执行结果写回会话" |

---

## 七、扩展思考

1. 如果用向量检索（cosine similarity）替代关键词匹配，检索质量会如何变化？
2. Agent Loop 的"停滞检测"（重复调同一工具）如何实现？
3. 如何让 LLM 自主决定"该用 RAG 还是该用工具"？（联系 Self-RAG 的思路）