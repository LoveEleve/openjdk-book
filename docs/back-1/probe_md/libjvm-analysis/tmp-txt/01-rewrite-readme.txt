You are a JVM documentation architect. Enhance 01-jvm-startup/README.md. Do NOT restructure — only APPEND new sections at the end.

## Existing 9 chapters (must preserve in-place, don't touch structure):
- §〇 上手指南 (skill levels, reading paths, terminology, GDB setup)
- §一 启动链
- §二 核心源码文件表
- §三 create_vm() 15 阶段 ASCII
- §四 JVM 参数系统
- §五 Mutex 层级
- §六 探针覆盖
- §七 早期日志说明
- §八 文档清单 (22 docs in 4 tiers)
- §九 覆盖率表 (35 structures)

## Only ADD these 5 sections at the END:

### §十 面试高频问题 × 文档直接对应
| 面试问题 | 直接看这篇 | 为什么这篇能回答 |
|----------|-----------|----------------|
| "java Main 到 main() 执行，中间发生了什么？" | 04 | 17 阶段完整追踪 |
| "为什么 -Xms 和 -Xmx 设为一样？" | 01 | 堆初始化 + ergo 决策 |
| "JVM 启动时创建了多少个线程？" | 15 + 04 | 线程创建时间线 |
| "G1 堆从 0 到 8GB 的具体步骤？" | 07 | G1CollectedHeap 12 步 |
| "TemplateInterpreter 是什么？为什么需要？" | 10 | 解释器生成 + 设计理由 |
| "symbol 表为什么用 Symbol 而不是 String？" | 03 | 内存效率分析 |
| "Safepoint 在启动阶段什么时候第一次出现？" | 04 | Phase 12 首次 safepoint init |
| "G1CMBitMap 为什么是这个大小？" | 03b | bitmap sizing 推导 |

### §十一 生产故障 × 文档诊断指引
| 生产场景 | 症状 | 看这篇 | 怎么诊断 |
|---------|------|--------|---------|
| 启动慢 (>5s) | java -version 卡住 | 04 + 17 | 按阶段查耗时 |
| RSS > -Xmx | top 显示 10GB, -Xmx=4GB | 21 | /proc/maps 对照 |
| GC 日志异常 | Full GC 频繁 | 01 + 07 | 验证 Region 大小 |
| Metaspace 初始占 20MB | 为什么还没加载类就用了这么多 | 06 | Universe::genesis |
| 参数不生效 | -XX:xxx 没反应 | 01 + 04 | 四重来源 + parse 顺序 |
| 线程数爆炸 | top -H 显示 200 线程 | 15 | 哪些是 JVM 自身线程 |

### §十二 深度评审检查点（自检 22 篇已写文档是否达标）
- 每篇是否有生产故障能直接参考？如果没有 → ⚠️ 缺失
- 每篇是否有面试题能直接回答？如果没有 → ⚠️ 缺失
- 每篇是否解释了"为什么这样设计"而非"代码做了什么"？如果没有 → ⚠️ 需重写
- 每个 sizeof 是 GDB 实测的还是拷贝自 header？如果不是 GDB → ⚠️ 需验证

### §十三 深度问题（用于审计现有文档）
≥12 个问题，分到 4 个 tier。每个问题标注"这个问题的答案应该在 XX 文档的 XX 节"。
格式: `❓ 为什么先 parse 参数再 init GC？如果反过来会怎样？ → 应出现于: 04 §阶段分析`

### §十四 和后续阶段的连接（前瞻）
Phase 01 是起点——列出后续 11 个阶段各自"从 01 学到了什么"：
| 后续阶段 | 依赖 01 的 |
|---------|-----------|
| 02-class-loading | Universe::genesis 创建的基础 Klass |
| 03-object-model | §九 的 35 结构 sizeof |
| ... | ... |
| 12-cpu-layer | 01 的 XV 阶段创建了 CodeCache |

## Operating instruction
1. Read the current README fully
2. Append the 5 new sections ( §十 to §十四 ) after §九
3. Do NOT modify, delete, or reorder any existing content
4. The interview x doc table and production fault x doc table must be concrete — not generic placeholders
