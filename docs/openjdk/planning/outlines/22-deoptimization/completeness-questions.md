## 全视角提问验证：Deoptimization (域22)

> 域: 普通域 (~2890 行, 2 文件) | 2 篇大纲 | 目标 15+ 题

| # | 身份 | 子主题 | 问题 | 覆盖 |
|:--:|------|------|------|:--:|
| 1 | 开发者 | Reason分类 | per-bytecode vs per-method 两类 reason 的区别？trap_bits 在哪存储？ | ✅ 篇1-§1 |
| 2 | 开发者 | Action决策 | class_check→哪个 Action？unloaded→哪个？决策表在哪实现？ | ✅ 篇1-§2 |
| 3 | 开发者 | trap_state | 31-bit 怎么编码 3+5+23？覆盖写入的后果？ | ✅ 篇1-§3 |
| 4 | 开发者 | vframeArray | vframeArrayElement 包含哪些字段？和 scope 的对应？ | ✅ 篇2-§1 |
| 5 | 开发者 | unpack 循环 | unpack 逐帧的 8 步——ScopeValue copy 怎么从 register/stack/constant 三种来源选？ | ✅ 篇2-§2 |
| 6 | 开发者 | populate_monitors | deopt 后怎么重新 lock？BasicLock displaced_header 恢复的 markOop 存在哪？ | ✅ 篇2-§2 |
| 7 | 性能工程师 | deopt 频率 | trap_count 到 PerBytecodeTrapLimit=100 需要多少次 deopt？ | ✅ 篇1-§3 |
| 8 | 架构师 | Reason→Action | 为什么 null_check 和 class_check 的 Action 不同？设计意图？ | ✅ 篇1-§2 |
| 9 | 架构师 | vframeArray vs real frame | 为什么用 intermediate vframeArray 而非直接建真实帧？ | ✅ 篇2-§1 |
| 10 | 子系统开发者 | 与 dependencies 交互 | dependencies 失效→not_entrant→怎么触发 deopt？ | ⚠️ 篇1-§1 有原因列表, 交叉引用未展开 |
| 11 | 学生 | deopt vs 异常 | deopt 回解释器继续执行——异常找 handler——什么区别？ | ✅ 篇2-§3(断点继续) |
| 12 | 学生 | 为什么叫 unpack | "unpack" 指的是 unpack 编译帧的内联树→展开成多层解释器帧？ | ✅ 篇2-§1 |

## 覆盖汇总

| 状态 | 数量 | 占比 |
|:--:|:--:|:--:|
| ✅ | 11 | 92% |
| ⚠️ | 1 | 8% |
| **总计** | **12** | **100%** |

### ⚠️ (1)

| # | 缺失 | 补全 |
|:--:|------|------|
| 10 | dep失效→deopt交互 | 篇1-§1 补充: dependencies crash→DepChange→CodeCache::make_marked_nmethods_not_entrant()→所有相关nmethod标记not_entrant→下次栈扫描时发现→触发deopt |
