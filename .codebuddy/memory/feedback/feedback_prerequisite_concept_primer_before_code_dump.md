---
name: prerequisite concept primer before code dump — add §0 when reader says "很乱/不理解"
description: 读者投诉文章"很乱/不理解"时，系统扫描被使用但未解释的前置概念，在§1前添加§0"前置概念速览"
type: feedback
---

**规则**：当用户说整篇文章"讲得很乱"或"没太理解"时，不要逐段修补——先扫描全文找出"被使用但从未解释"的前置概念，在 §1 前加一个 §0 "前置概念速览"，每个概念 2-3 句给出定义即可，正文再用时只引用不解释。

**Why**: 08-02 经过两轮 MCP 深度审查（源码行号/方法名/简化代码/类声明/BFS术语 全部修完）后，用户仍然说"感觉讲的很乱，前面就没太理解"。根因不是代码错误——而是 5 个关键概念（dirty card/card table/RSet、PLAB、forwarding pointer、工作窃取队列、G1ParScanThreadState）全文满天飞但从未在一处集中讲解。读者在 §1 就遇到 "dirty card buffer" 和 "RSet" 但不知道它们是什么，越读越迷失。

**How to apply**:
1. 当用户说 "很乱/不理解/不懂" → 先不修代码 → 扫全文找"出现但未解释"的关键概念
2. 在 §1 前新增 §0 "前置概念速览"，每个概念写 2-3 句：是什么→为什么需要→在本文哪里用
3. 如果有某个类（如 G1ParScanThreadState）贯穿全文但放在最后一节——将它提前到 §0 附近
4. 判断标准：一个之前没读过 G1 源码的读者在 §0 读完应该能看懂正文的每一段

**2026-07-27 08-02 实例**：漏掉的 5 个关键前置概念:
- dirty card / card table / DCQ / RSet 数据流（§1 就用到）
- PLAB 为什么需要 per-worker 本地分配缓冲（§3.5/§6 用到）
- forwarding pointer 为什么需要（§3.5 用到）
- 工作窃取队列 push/pop/steal 约定（§3.5/§5 用到）
- G1ParScanThreadState 是什么（全文用到但排在 §6）
