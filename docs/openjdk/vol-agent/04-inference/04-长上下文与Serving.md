# 长上下文与 Serving：一个完整的推理服务如何运行

> 前置：`01-KV Cache.md`、`02-Batching与吞吐.md`、`03-量化与推理成本.md`
> 本篇任务：把 KV Cache、batching、量化、长上下文串成一张完整的 Serving 架构图。

---

## 一、这一章真正的问题

前面三篇分别讲了：
- KV Cache：加速单请求
- Batching：提高吞吐
- 量化：降低显存和带宽

但一个真正的推理服务要把它们全部组合起来，还面对更复杂的问题：

> 用户发来一个很长的 prompt，或者一个 Agent 要进行多轮长对话，系统如何同时保证稳定、成本和性能？

这一章要回答：
1. 长上下文对 KV Cache 的显存压力有多大？
2. Agent 多轮对话为什么特别吃上下文？
3. 一个完整 Serving 系统有哪些组件？
4. 为什么 Agent 场景需要"上下文工程"而不只是"推理优化"？

---

## 二、最小前置知识

- 理解 KV Cache（`04-01`）
- 理解 Continuous Batching（`04-02`）
- 理解量化（`04-03`）

---

## 三、直觉方案为什么不够好

### 直觉方案 1：直接把整个长上下文全都塞进 KV Cache

> 反正有 KV Cache，多长的上下文都能处理。

问题：
- KV Cache 显存随序列长度线性增长，甚至平方级（attention 分数）
- 8k token 的 prompt 可能就要占好几 GB
- 128k 上下文在一些模型上会让 KV Cache 超过模型本身

### 直觉方案 2：Agent 对话时把每一轮都完整保留

> Agent 每轮都要理解全部历史，那就全保留。

问题：
- Agent 会话历史越来越长
- 每轮请求都带完整历史，KV Cache 越来越大
- 上下文越长，首 token 延迟越高、成本越高
- 后面会发现 Attention 还对中间信息"丢失"（Lost in the Middle）

---

## 四、正式机制

### 1. 长上下文的显存压力

KV Cache 显存估算：

```text
KV per token = 2 (K+V) × num_layers × num_heads × head_dim × bytes

以 70B 模型、FP16、128k 上下文为例：
KV Cache 可达数百 GB，远超模型参数本身
```

所以"能支持 128k 上下文"和"在 128k 上下文中高效运行"是两回事。

### 2. 长上下文的常见优化

#### RoPE / ALiBi 位置编码
- 新的位置编码让模型能泛化到训练长度之外
- 但效果因模型和任务而异

#### FlashAttention
- 减少 attention 的内存占用量（分块计算）
- 不降低 KV 本身，但降低中间矩阵显存

#### Attention Sinks / Sliding Window
- 不保留全部上下文，只保留开头一部分 + 最近窗口
- 权衡：显存下降，但可能丢失中间信息

#### Prefix Caching
- 多个请求共享相同前缀时，复用相同的 KV Cache
- 特别适合 Agent 多轮对话（历史前缀相同）

### 3. 完整 Serving 系统架构

一个生产级 LLM Serving 系统通常包含：

```text
客户端
  → 网关（认证、限流、路由）
    → 调度器（continuous batching / 优先级）
      → 推理引擎（KV Cache / 量化 / 并行）
        → 输出（token 流 / 完整响应）
```

#### 网关
- 认证：谁在调用
- 限流：防止超载
- 路由：把请求路由到正确的模型/实例

#### 调度器
- 排队：请求等待被调度
- 优先级：重要请求优先
- Continuous Batching：动态调整 batch

#### 推理引擎
- KV Cache 管理
- 量化模型
- Tensor/Pipeline 并行（跨多 GPU）

### 4. Agent 场景的特殊性

Agent 对话与普通聊天的区别：

```text
普通对话：每轮一次性请求
Agent 对话：多轮 + 工具调用 + 长任务
```

Agent 的问题：
- 历史对话 + 系统提示 + 工具描述 + 工具结果 = 很长
- 每轮都要重新把上下文喂给模型
- KV Cache 和 token 成本都随会话增长

所以 Agent 需要"上下文工程"：
- 压缩/摘要历史
- 检索相关记忆而不是全量历史
- 控制每轮进入模型的 token 量

这正好和前面 `vol-agent` 里讲过的 OpenCode / Reasonix / Pi / Hermes / dsh 的上下文管理设计对应。

---

## 五、最小实现 / 伪代码

### 1. KV Cache 显存估算

```python
def kv_cache_memory(num_layers, num_heads, head_dim, seq_len, bytes_per_param=2):
    # K 和 V 各一份
    kv_size = 2 * num_layers * num_heads * head_dim * seq_len * bytes_per_param
    return kv_size / 1e9  # GB

# 70B 模型示例（约 80 层）
num_layers, num_heads, head_dim = 80, 64, 128
for seq_len in [2048, 8192, 32768, 131072]:
    gb = kv_cache_memory(num_layers, num_heads, head_dim, seq_len)
    print(f"序列 {seq_len:>6}: KV Cache ≈ {gb:.1f} GB")
```

### 2. Prefix Cache 示意

```python
class PrefixCache:
    def __init__(self):
        self.cache = {}   # 前缀 hash → KV

    def get_prefix_kv(self, prompt_ids):
        # 找最长已缓存前缀
        prefix = tuple(prompt_ids[:100])  # 简化
        return self.cache.get(prefix)

    def store_prefix_kv(self, prompt_ids, kv):
        self.cache[tuple(prompt_ids[:100])] = kv

# Agent 多轮对话：历史前缀相同 → 命中 prefix cache → 省去重算
agent_history_1 = [1, 2, 3, 100, ...]   # 历史
agent_history_2 = [1, 2, 3, 100, 101, ...]  # 追加一个工具结果
# 前 4 个 token 相同 → 前缀 KV 可复用
```

### 3. Serving 队列示意

```python
import queue

class LLMServer:
    def __init__(self, max_batch=4):
        self.queue = queue.Queue()
        self.max_batch = max_batch
        self.running = []

    def submit(self, request):
        self.queue.put(request)

    def schedule(self):
        # 每步：从排队中取出请求填充 batch
        while len(self.running) < self.max_batch and not self.queue.empty():
            self.running.append(self.queue.get())
        # 每步生成一个 token
        for req in self.running:
            req["remaining"] -= 1
        # 移除完成请求
        self.running = [r for r in self.running if r["remaining"] > 0]
        return len(self.running)

server = LLMServer(max_batch=2)
for i in range(3):
    server.submit({"id": i, "remaining": 5})
for step in range(6):
    running = server.schedule()
    print(f"步 {step}: running = {running}")
```

---

## 六、复杂度与边界

1. **"支持长上下文" ≠ "高效支撑长上下文"**
   - 模型能接受 128k，不代表 128k 时速度快、成本低
   - 实际部署往往限制上下文或需要压缩

2. **Agent 场景的成本是"会话级"的**
   - 单个 turn 可能不贵，但多轮累积成本高
   - 工具结果可能很大，token 消耗快

3. **前缀缓存有失效问题**
   - 一旦历史中间某处变化，整个前缀缓存失效
   - 需要设计好缓存 key 和失效策略

4. **Serving 的瓶颈可能是任何一个组件**
   - 网关、调度、推理引擎、KV Cache、网络
   - 不是只优化一个地方就行

---

## 七、论文与真实系统映射

- **FlashAttention**（Dao et al. 2022）：IO 感知 attention，降低显存
- **Attention Sinks**（Xiao et al. 2023）：长流式对话的 KV 管理
- **PagedAttention / vLLM**：KV Cache 分页管理
- **Lost in the Middle**（Liu et al. 2023）：长上下文中模型对中间信息敏感

在真实系统里：
- vLLM / TensorRT-LLM / TGI 是主流 Serving 框架
- OpenAI / DeepSeek / Qwen 的 API 都具备 continuous batching + prefix cache
- Agent 系统的上下文管理是这些能力之上的应用层

---

## 八、下一章为什么必须接着读

至此，`04-inference` 的四篇核心文章已经完成：

```text
01 KV Cache：生成加速
02 Batching：吞吐提升
03 量化：显存/带宽降低
04 长上下文与 Serving：整体架构
```

现在你已经理解：**模型怎么训练、怎么推理、怎么服务。**

接下来要解决的问题是：**光有模型还远远不够——怎么让模型真正"做事"？**

这就是 `05-agent-foundations`：

- Agent Loop、ReAct、工具调用、Planning、Memory、RAG

它们把"会生成文本的模型"升级成"会执行任务的系统"。

---

## 一句话结论

> **一个生产级 LLM 推理服务 = 网关 + 调度器（continuous batching）+ 推理引擎（KV Cache + 量化）+ 长上下文管理。Agent 场景在此基础上还需要上下文工程——因为多轮对话和工具调用的成本是"会话级"累积的，不能只靠推理优化解决。**