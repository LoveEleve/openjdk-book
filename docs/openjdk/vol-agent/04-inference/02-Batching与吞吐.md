# Batching 与吞吐：如何同时服务多个用户

> 前置：`01-KV Cache.md`
> 本篇任务：理解 batching 如何提高 GPU 利用率，以及 continuous batching 为什么是现代 LLM Serving 的核心。

---

## 一、这一章真正的问题

单用户单请求的推理只需要 KV Cache。但生产环境是：

> 同时有几十、几百个用户在请求，GPU 怎么分配？

这一章要回答：
1. 为什么简单的 batching 不够？
2. continuous batching 是什么？
3. 吞吐和延迟怎么取舍？
4. 一个 Serving 系统的基本架构是什么？

---

## 二、最小前置知识

- 理解 KV Cache（`04-01`）
- 理解生成是逐 token 的
- 理解"等待"和"排队"的基本概念

---

## 三、直觉方案为什么不够好

### 直觉方案 1：一个一个串行处理

> 一个请求结束了再处理下一个。

问题：
- GPU 利用率极低（大部分时间在等待）
- 如果 100 个请求，每个 10 秒，总时间 = 1000 秒

### 直觉方案 2：简单批处理（等一批都 prefilled 再一起 decode）

> 把多个请求拼成一个 batch，一次推理。

问题：
- 不同请求长度不同，短的请求必须等长的
- 每步所有请求都要参与，但有些请求可能已经结束了
- 浪费计算

---

## 四、正式机制

### 1. 静态 Batching

把多个请求拼成一个 batch：

```text
请求 A: "今天天气"
请求 B: "什么是 Attention"
请求 C: "请写一段代码"
        ↓
拼成 batch：(3, max_seq_len)
短的请求用 <pad> 补齐
```

问题：
- 短的请求被填充了很多无关 token
- 必须等所有请求都完成，才能释放 batch
- 某个请求提前结束，它的位置仍然被占用

### 2. Continuous Batching（持续批处理）

核心思想：**每步 decode 后，重新组织 batch。**

- 完成生成的请求 → 移出 batch，返回结果
- 新到达的请求 → 加入 batch
- 每步都重新排列

```text
第 1 步：A, B, C 都在生成
第 2 步：A 完成 → 移出，返回结果，D 加入
第 3 步：B, C, D 继续 ...
```

优势：
- 没有填充浪费
- 不会让完成的请求"空占位置"
- 新请求不需要等待整个 batch 结束

### 3. 吞吐 vs 延迟

#### 吞吐（throughput）
- 每秒能生成的 token 数
- 单位：token/s 或 requests/s
- 提高方法：增大 batch size

#### 延迟（latency）
- 单个请求从发出到完成的时间
- 单位：秒
- 减少方法：减小 batch size

两者的关系：

```text
batch size 增大 → 吞吐 ↑ → 延迟 ↑
batch size 减小 → 吞吐 ↓ → 延迟 ↓
```

这是 Serving 系统最基本的权衡。

### 4. 首 token 延迟 vs 生成延迟

#### 首 token 延迟（TTFT）
- 从请求到达到返回第一个 token 的时间
- 主要受 prefill 阶段影响
- 对交互式用户体验至关重要

#### 生成延迟（TPOT）
- 每生成一个 token 的时间
- 主要受 decode 阶段影响
- 决定生成速度

---

## 五、最小实现 / 伪代码

### 1. 模拟连续批处理

```python
import numpy as np

class ContinuousBatchingScheduler:
    def __init__(self):
        self.running = {}   # request_id -> {remaining, step}
        self.waiting = []   # 排队中的请求
        self.completed = []

    def add_request(self, req_id, max_tokens):
        self.waiting.append({"id": req_id, "remaining": max_tokens, "step": 0})

    def step(self, max_batch_size):
        # 把完成的请求移出
        done_ids = [rid for rid, r in self.running.items()
                    if r["remaining"] <= 0]
        for rid in done_ids:
            self.completed.append(self.running.pop(rid))

        # 从等待队列补入新请求
        empty_slots = max_batch_size - len(self.running)
        for _ in range(min(empty_slots, len(self.waiting))):
            new_req = self.waiting.pop(0)
            self.running[new_req["id"]] = new_req

        # 一轮生成：每个 running 请求生成一个 token
        for rid, r in self.running.items():
            r["step"] += 1
            r["remaining"] -= 1

        return len(self.running)

# 模拟
scheduler = ContinuousBatchingScheduler()
scheduler.add_request("A", 5)
scheduler.add_request("B", 8)
scheduler.add_request("C", 3)
scheduler.add_request("D", 6)

batch_size = 2
for t in range(1, 12):
    running = scheduler.step(batch_size)
    print(f"步 {t}: running={running}, completed={len(scheduler.completed)}")
```

### 2. 吞吐计算示意

```python
# 假设：单请求生成 100 token，batch size = 4

tokens_per_step = 1      # 每步生成 1 个 token
batch_size = 4
steps_per_token = 0.01   # 秒（简化）

# 每步生成 batch_size 个 token
throughput = batch_size / steps_per_token
latency = 100 * steps_per_token

print(f"batch_size={batch_size}: 吞吐 = {throughput:.0f} token/s, "
      f"延迟 = {latency:.2f} s")
```

---

## 六、复杂度与边界

1. **Continuous Batching 是 Serving 框架标配**
   - vLLM、TensorRT-LLM、TGI 都实现了
   - 没有它，GPU 利用率会很低

2. **batch size 受限于显存**
   - 每个请求都有自己的 KV Cache
   - batch 越大，KV Cache 显存越大
   - 实际 batch size 由显存和请求长度共同决定

3. **TTFT 和 TPOT 需要平衡**
   - 交互式应用：TTFT 更重要（首字延迟）
   - 长文本生成：TPOT 更重要（生成速度）
   - 不同场景需要不同的优化方向

4. **请求到达不均匀时，调度策略很重要**
   - 高峰时排队，低峰时空闲
   - 需要做负载均衡

---

## 七、论文与真实系统映射

- vLLM / PagedAttention：Continuous Batching + 高效 KV Cache 管理
- TensorRT-LLM：NVIDIA 的推理优化框架
- HuggingFace TGI：Text Generation Inference

在真实系统里：
- 所有 LLM API 服务（OpenAI、DeepSeek、Qwen）都使用 continuous batching
- 服务质量取决于 batch size、KV Cache 成本和请求分布

---

## 八、下一章为什么必须接着读

你已经知道：
- Continuous Batching 提高 GPU 利用率
- 吞吐和延迟需要权衡

但还有一个关键问题：

> 模型太大、显存不够怎么办？

这就是：

- `../04-inference/03-量化与推理成本.md`

它用更少的 bit 表示参数，让模型更小、更快、更省显存。

---

## 一句话结论

> **Continuous Batching 让每步解码后重新组织 batch，移出完成的请求、加入新请求，避免填充浪费和空占位置。它是现代 LLM Serving 提升吞吐的核心技术。**