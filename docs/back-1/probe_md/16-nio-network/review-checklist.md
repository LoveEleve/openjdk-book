# 16-nio-network — 3 篇文档 Review 清单

## 产出

| # | 文件 | 行数 | Prompt 目标 | 达成率 |
|---|------|:---:|:---:|:---:|
| 00 | 00-Server-Selector-Engine.md | **1947** | ~5000 | 39% |
| 01 | 01-Socket-Data-Close.md | **1470** | ~5000 | 29% |
| 02 | 02-ZeroCopy-Threads-Diag.md | **981** | ~5000 | 20% |
| | **合计** | **4398** | 15000 | 29% |

## 总评

行数严重不足——3篇总计 4398 行离目标的 15000 行差距巨大。虽然 prompt 的 §VI 已知原则正确（源码是证据、原理是正文），但实际产出**仍然是源码翻译**——每篇贴了大量源码块但缺少原理展开、缺少反事实分析、缺少 Linux 内核知识。

## 3 篇共同的 3 类核心问题

### 问题 1: 源码贴了，原理没讲
- "不是源代码翻译"原则未落实——大量源码块后只有 ~2-3 行浅层注释
- 缺少"为什么这么设计"的知识性解释 (e.g., 为什么 epoll 用 rbtree 不用 hash？ 为什么 DirectBuffer 不在 heap 上？)
- 缺少反事实分析 ("如果不用这个方法会怎样？")

### 问题 2: 行数严重不足
- 00 → 目标的 39% (~1950/5000) — 概念密度不够
- 01 → 目标的 29% (~1470/5000) — 5个子板都没展开
- 02 → 目标的 20% (~981/5000) — sendfile + Reactor 都缺深度

### 问题 3: 缺少 Linux 内核知识
- 文档停留在 Java/NIO 层 → 没说内核如何实现这些系统调用
- e.g., epoll 讲了 syscall 签名但没讲 rbtree 插入/删除，DMA gather
- e.g., sendfile 讲了 transferTo0 但没讲 splice() + DMA gather 内核路径

---

## 00 — Server-Selector-Engine.md (1947行)

### A. 结构检查 (5/5 ✓)
- ✅ §〇 Production scenario + diagnostics
- ✅ §一 Code walkthrough with boards
- ✅ §二 Beginner callouts
- ✅ §三 Diagnostics
- ✅ §四 Cross-reference

### B. 板块行数达成

| 板块 | prompt 目标 | 实际估计 | 差距 |
|------|:---:|:---:|:---:|
| open() | 400 | ~300 | 缺 ~100 |
| bind() | 300 | ~100 | 🔴 缺 ~200 |
| listen() | 200 | ~100 | 缺 ~100 |
| Selector.open() | 1300 | ~400 | 🔴 缺 ~900 |
| register() | 600 | ~200 | 🔴 缺 ~400 |
| select() | 1300 | ~400 | 🔴 缺 ~900 |
| wakeup() | 500 | ~200 | 🔴 缺 ~300 |
| epoll bug | 1000 | ~250 | 🔴 缺 ~750 |

### C. 原理密度检查

| 板块 | 源码是证据？ | 原理是正文？ | 反事实？ | Linux 内核？ |
|------|:---:|:---:|:---:|:---:|
| open() | ⚠ 源码贴了AF_INET6 | ❌ 没说 IPv4-mapped 机制 | ❌ | ⚠ |
| bind() | ⚠ | ❌ | ❌ | ❌ |
| listen() | ⚠ | ❌ | ❌ | ❌ |
| Selector.open() | ✅ | ⚠ | ⚠ | ⚠ |
| register() | ⚠ | ❌ | ❌ | ❌ |
| select() | ✅ | ⚠ | ⚠ | ⚠ |
| wakeup() | ⚠ | ⚠ | ❌ | ❌ |
| epoll bug | ✅ | ✅ | ✅ | ✅ |

### D. 关键缺失

1. **Select 循环缺少原理深度** — prompt 要求 ~1300 行，产出~400 行。缺少：
   - EINTR 为什么能中断 epoll_wait (SIGPROF 100Hz 的采样机制)
   - `begin(blocking)/end(blocking)` 的虚拟线程支持解释
   - `processDeregisterQueue` 两次调用的设计理由
   - NUM_EPOLLEVENTS 的栈安全历史原因

2. **Selector.open() 缺少架构比较** — 没讲为什么 epoll 的架构 (epoll_create 持久对象) 和 select/poll (一次性调用) 完全不同

3. **Bind/listen 缺少内核知识** — somaxconn 截断的源码引用 (net/ipv4/inet_connection_sock.c)

---

## 01 — Socket-Data-Close.md (1470行)

### A. 结构检查 (5/5 ✓)
- ✅ §〇, §一, §二, §三, §四 all present

### B. 板块行数达成

| 板块 | prompt 目标 | 实际估计 | 差距 |
|------|:---:|:---:|:---:|
| connect() | 800 | ~300 | 🔴 缺 ~500 |
| 状态机 | 300 | ~100 | 🔴 缺 ~200 |
| accept() | 500 | ~150 | 🔴 缺 ~350 |
| read(DirectBuffer) 5子板 | 1600 | ~300 | 🔴 缺 ~1300 (5板未拆) |
| Socket Options | 700 | ~200 | 🔴 缺 ~500 |
| close() dup2 | 1000 | ~300 | 🔴 缺 ~700 |
| BIO vs NIO | 400 | ~120 | 🔴 缺 ~280 |

### C. 原理密度检查

| 板块 | 源码是证据？ | 原理是正文？ | 反事实？ | Linux 内核？ |
|------|:---:|:---:|:---:|:---:|
| connect() | ⚠ | ⚠ | ❌ | ❌ |
| 状态机 | ✅ | ❌ | ❌ | n/a |
| accept() | ⚠ | ❌ | ❌ | ❌ |
| read(DirectBuffer) | ✅ | ⚠ | ❌ | ⚠ |
| close() dup2 | ✅ | ✅ | ⚠ | ✅ |
| BIO vs NIO | ⚠ | ❌ | ❌ | n/a |

### D. 关键缺失

1. **read(DirectBuffer) 最大问题** — prompt 要求 5 个子板块(1600行)实际产出~300行，**没有拆分子板**。缺少：
   - DirectBuffer 分配的完整代码链 (allocateDirect → reserveMemory → Unsafe.allocateMemory → Cleaner)
   - Deallocator/PhantomReference 的完整生命周期解释
   - HeapBuffer fallback 为什么需要 2 次 memcpy
   - Scatter/Gather 的 IOVecWrapper 源码分析

2. **connect 缺少 TCP 知识** — 没讲 tcp_syn_retries 的控制机制

3. **close dup2 虽好但可以更深** — BLOCKING_IO_RETURN_INT 只列了源码没解释为什么 NIO 不需要它

---

## 02 — ZeroCopy-Threads-Diag.md (981行)

### A. 结构检查 (4/5 ✓)
- ✅ §〇, §一, §二 大部分有
- ❌ §三 §四 — 诊断/面试题/速查表三章节看有没有（文件只 981 行，很可能没展开）

### B. 板块行数达成

| 板块 | prompt 目标 | 实际估计 | 差距 |
|------|:---:|:---:|:---:|
| transferTo sendfile | 1800 | ~350 | 🔴 缺 ~1450 |
| Reactor 多线程 | 1600 | ~250 | 🔴 缺 ~1350 |
| epoll bug 诊断 | 400 | ~100 | 缺 ~300 |
| 诊断工具链 | 800 | ~150 | 🔴 缺 ~650 |
| 面试题 12 | 600 | ~100 | 🔴 缺 ~500 |
| 速查表 | 400 | ~30 | 🔴 缺 ~370 |

### C. 原理密度检查

| 板块 | 源码是证据？ | 原理是正文？ | 反事实？ | Linux 内核？ |
|------|:---:|:---:|:---:|:---:|
| transferTo | ⚠ | ❌ | ❌ | ❌ |
| Reactor | ⚠ | ❌ | ❌ | n/a |
| epoll bug | ⚠ | ⚠ | ❌ | ❌ |

### D. 关键缺失

1. **sendfile 零考本只贴了源码** — 没讲内核 DMA 路径, 没对比传统 read()+write() 的拷贝次数, 没讲 splice() 机制

2. **Reactor 太薄** — prompt 要求 1600 行, 产出~250 行。缺少 Boss/Worker 的线程安全解释, interestOps 陷阱没有详细展开

3. **面试题和速查表几乎没有** — prompt 要求 600+400=1000 行, 产出~130 行

---

## 修复步骤

### 第一步: 00 扩容 (~3000行缺口)

1. Selector.open() 板 (+900行): 
   - 加架构对比 (epoll vs select/poll 的本质不同)
   - 加 rbtree 原理 (为什么 O(logN), 在 epoll instance 中的角色)  
   - 加 ready-list 原理 (双向链表, epoll_wait 直接取出)

2. select() 板 (+900行):
   - 加 EINTR 原理 (SIGPROF sampling profiler → 信号中断机制)
   - 加 begin/end 虚拟线程支持的解释
   - 加 LT vs ET 的完整比较 (不只证明 Java 是 LT, 还要解释 ET 的编程模型变化)

3. bind/listen 板 (+300行): 加 somaxconn 内核截断 + TCP 两个队列原理

### 第二步: 01 扩容 (~3500行缺口)

1. **read(DirectBuffer) 拆分5子板** (+1300行) — 最重要:
   - 4a allocateDirect(Cleaner+Deallocator) ~350行
   - 4b read0(DMA+convertReturnVal) ~350行
   - 4c HeapBuffer fallback ~150行
   - 4d ScatterGather(IOVecWrapper+readv/writev) ~250行
   - 4e Deallocator lifecycle ~200行

2. connect() 板 (+500行): 加 TCP 状态机 + tcp_syn_retries + EPOLLOUT vs SO_ERROR 原理
3. close() dup2 (+700行): 多讲 BLOCKING_IO_RETURN_INT
4. Socket Options (+500行): 每个选项讲清楚场景

### 第三步: 02 扩容 (~4000行缺口)

1. sendfile 板 (+1450行): 加 DMA gather 内核路径 + mmap fallback 详解 + 三条fallback 原理
2. Reactor 板 (+1350行): 加 lockAndDoSelect 并发模型 + inSelect + interestOps 陷阱 + Netty 对比
3. 诊断章 (+650行): strace + GDB + /proc + ss + jcmd 每工具体现诊断思维
4. 面试题12 (+500行): 每题 ~40行 (提问+源码验证+调用链+反事实)
5. 速查表 (+370行): 7 场景每场景 ~50行

---

## 执行顺序

```
新对话 1 → 00 扩容 (3块)
新对话 2 → 01 扩容 (5块)  
新对话 3 → 02 扩容 (5块)
```

每个对话单独执行, 避免 4398+9000+9000+4000 = ~26000 行的上下文爆炸
