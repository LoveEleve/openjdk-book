# sca 架构解析 — 让技术不再难学(源码学习 Agent)

> 读者:项目拥有者(希望看懂每一行 AI 写的代码)
> 配套:HANDOVER.md(进度)、HANDOVER-session005.md(实现过程)、源码解析(本目录另一篇)
> 定位:讲**为什么这么设计**,不逐行讲代码(逐行见源码解析)

---

## 一、一句话架构

```
用户输入 "帮我分析 JVM 的 G1"
  → 对齐(规格书)
  → 逐章执行(读源码 → 写章节)
  → 验收门(证据/教学/覆盖)
  → 结论入库 + 写书
  → 成书验收 + 索引
  全程:每一步落事件日志 = 可重放真相源
```

**核心哲学**:这个 Agent 不是"替你做事",是"让你学会"。所以质量门(验收)和真相源(日志)是骨架,LLM 只是执行器。

---

## 二、四大支柱(设计骨架)

| 支柱 | 解决的问题 | 对应模块 |
|------|-----------|---------|
| 1. 事件溯源 | 真相不丢、可重放、可审计 | core/(event-log, reducer, atomic) |
| 2. 反幻觉双闸 | LLM 会编造,证据必须真实 | acceptance/gate + knowledge/extract |
| 3. 验收门 = 状态机 | 未验收不准进下一章(质量门禁工程化) | acceptance/(gate, revise) + session/checkpoint |
| 4. 交接 = 日志本身 | 断点续跑无人工,跨 session 无损 | session/(resume, checkpoint, snapshot) |

---

## 三、模块地图

```
src/
├── core/         事件溯源地基(追加写/重放校验/原子写)
│   ├── event-log.ts    JSONL 追加写 + seq 分配 + 字段校验 + 串行写链
│   ├── reducer.ts      重放校验(损坏拒绝:8 类)+ 增量重放基线
│   └── atomic.ts       temp+rename 原子写(崩溃只留 .tmp)
├── types/         数据契约(21 种事件 + spec)
│   ├── event.ts        EVENT_TYPES / LIVE_ONLY_EVENTS / payload 类型
│   └── spec.ts         规格书类型 + Normalize/Validate
├── llm/           LLM 层缝(换模型不改业务)
│   ├── provider.ts     接口(stream/generateObject/chatWithTools)
│   └── deepseek.ts     deepseek-v4-flash 实现(OpenAI 兼容)
├── spec/          对齐(用户目标 → 规格书)
│   └── align.ts        6 维盘问 + 规格书生成 + spec.admitted
├── engine/        执行引擎(读源码的循环)
│   ├── loop.ts         双层循环:LLM → 工具 → 压缩 → 检查点
│   ├── context.ts      上下文组装(规格书冻结 + 7 段交接)
│   └── errors.ts       错误分类(transient/overflow/...) + 重试
├── tools/         工具系统(只读安全集 + M9 沙箱决策)
│   ├── registry.ts     注册 + 结算七步 + 权限
│   └── readonly.ts     read/grep/glob(有界输出 + 路径安全)
├── acceptance/    验收(质量门)
│   ├── gate.ts         确定性门(证据真实性/教学完整性/覆盖/深度)
│   ├── ledger.ts       验收留痕 + 收敛判定
│   └── revise.ts       修订循环(失败回注 LLM 自修 → 重验)
├── compression/   上下文压缩(M8)
│   ├── token.ts        CJK 感知 token 估算
│   ├── decider.ts      压缩决策状态机(防 thrash/一代一票/溢出一次)
│   ├── summarizer.ts   7 段摘要模板 + 预算缩放
│   ├── ghost.ts        幽灵重注入(关键指令原样保留)
│   └── compressor.ts   协调器 + 提交栅栏
├── knowledge/     知识库(结论 + 书)
│   ├── conclusions.ts  结论库(subject 冲突版本++ + 快照 seed)
│   ├── extract.ts      结论提取(反幻觉双闸)
│   ├── book.ts         书组织(spec/chapters/MEMORY.md)
│   └── book-audit.ts   书级验收 + 索引
├── session/       恢复/检查点/快照(断点续跑三件套)
│   ├── resume.ts       跨 session 恢复(重放 → 投影 → 7 段摘要)
│   ├── checkpoint.ts   章节检查点(上下文用尽自动收尾)
│   └── snapshot.ts     Raft 式快照 + 归档(日志不膨胀)
├── cli/           命令面
│   ├── main.ts         sca/--continue/--auto/status
│   └── book-flow.ts    全书循环 + 检查点收尾 + 快照归档 + 成书
```

---

## 四、数据流(一次完整运行)

### 4.1 事件流(真相怎么落盘)

```
每一步 → EventLog.append:
  校验(类型已知/payload 必填)
  → seq = ++this.seq(单调)
  → durable? = !LIVE_ONLY_EVENTS(定稿 vs 增量)
  → 追加一行 JSONL(真追加 O(1),fsync)
  → writeChain 串行(防并发写交叉)

重放(replayFile):
  逐行 JSON.parse → 校验(seq 连续/类型已知/无分叉)
  损坏 → 拒绝(绝不静默修复)
  增量模式(afterSeq>0):只校验/返回快照基线之后的事件
```

### 4.2 三层上下文/状态管理(长跑核心)

```
                    ┌────────────────────────────────────────┐
                    │  M8 压缩(会话内,混合 GC)                 │
                    │  预算超 0.85 → 摘要 → 幽灵重注入          │
                    │  防 thrash/一代一票/溢出只一次            │
                    └────────────────────────────────────────┘
                                    │ 压缩也救不了(ineffective)
                                    ▼
                    ┌────────────────────────────────────────┐
                    │  M8.5 检查点(跨轮,Full GC)              │
                    │  单章上下文用尽 → chapter.checkpoint     │
                    │  携带进度/证据 → 续跑注入防重头           │
                    │  --auto 同进程循环(进程不死)             │
                    └────────────────────────────────────────┘
                                    │ 日志膨胀 + 恢复 O(n²)
                                    ▼
                    ┌────────────────────────────────────────┐
                    │  M8.6 快照归档(存储层)                  │
                    │  章节完成 → snapshot.json(先)            │
                    │           → 归档 live-only(后)          │
                    │  恢复:快照 seed + 尾部增量 O(增量)        │
                    └────────────────────────────────────────┘
```

**三层对应思想**:G1 分层(压缩=摊平,检查点=重置)、Raft log compaction(快照+归档)、LSM/LRU(M8.7 待做)。

### 4.3 验收门状态机

```
ADMITTED → ANALYZING → WRITING → VERIFYING → ACCEPTED → COMPLETED
                      ↘ 失败 → REVISING → 重验(≤3)
                               ↘ 超限 → BLOCKED(暂停问用户)

非法迁移拒绝(支柱 4):
  - 未验收不能写结论
  - REVISING 不能直接 ACCEPTED
  - 未完成不能进下一章
```

---

## 五、反幻觉双闸(质量核心)

```
闸 1(gate):章节文本 → 提取 file:line → grep 验证文件存在 + 行号有效
            不存在 → 验收失败(missing_evidence)

闸 2(extract):章节文本 → 提取结论(带 evidence_ids)
             evidence_ids 必须真实出现在章节文本中(realRefs)
             LLM 编造章节外的引用 → 被过滤
```

**为什么两道闸**:LLM 在"写章节"和"提取结论"两层都可能编造。gate 管章节级,extract 管结论级,两道都过才入库。

---

## 六、崩溃/长跑安全性(为什么能跑一天不断)

| 场景 | 行为 |
|------|------|
| 任意时刻 Ctrl-C | 日志已落盘 → `sca --continue` 无损续跑 |
| 上下文超限 | M8 压缩 → 救不了 → M8.5 检查点收尾 |
| 检查点反复无效 | retry ≤3 → blocked(防死循环) |
| 长跑无进展 | --auto 无进展 3 轮 → 停 |
| 日志膨胀 | M8.6 快照 + 归档(主日志保持短) |
| 归档后崩溃 | 快照先于归档 → 尾部多事件重放无害 |
| 快照损坏 | readSnapshot 抛错 → fail-closed(不静默错数据) |

---

## 七、M10 可观测

```
EventLog.append → Event.run_id(可选,旧事件兼容)
                  ↓
observability.readObservableEvents(主日志 + archive,按 seq 去重)
                  ↓
              diagnostics / toTimeline
                  ↓
        sca status / sca trace
```

可观测层遵守 content-free 原则：只输出事件类型、seq、时间、章节、工具名、策略结果、压缩代数等元数据，不输出 prompt、tool arguments 或工具结果正文。`run_id` 用于关联一次 CLI/auto 运行；旧事件缺少它时显示为 `legacy`。主日志和 archive 会严格解析、按 seq 去重，并对 malformed/fork 数据报错，不静默生成不完整诊断。

M10 不是第二个状态机：它只读事件并生成视图，不改变执行结果。审计/观测失败不应改变业务状态；安全决策本身仍通过 durable `sandbox.decided` 事件 fail-closed。

---

## 八、诚实的边界(不说谎)

1. **交接有损**:检查点/压缩的摘要是"提示",真相在事件日志(无损)。任何"无限上下文"说法都要加"有损跳变"限定
2. **免费额度 402**:外部硬约束,代码救不了;功能对免费/付费同受益
3. **单书串行**:无并发章节(多书/并行是 M12/M14)
4. **价值评分启发式**(M8.7):近似最优,不是精确
