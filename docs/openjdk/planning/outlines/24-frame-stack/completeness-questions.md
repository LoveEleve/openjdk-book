## 全视角提问验证：Frame & Stack Walking (域24)

> 域: 大域 (~7000 行, 24 文件) | 3 篇 | 目标 15+ 题

| # | 身份 | 子主题 | 问题 | 覆盖 |
|:--:|------|------|------|:--:|
| 1 | 开发者 | frame类型 | compiled/interpreted/native/C四种帧的sender()怎么不同？ | ✅ 篇1-§1 |
| 2 | 开发者 | OopMap | compiled frame的OopMap哪来的？解释器frame没有OopMap怎么扫描？ | ✅ 篇1-§2 |
| 3 | 开发者 | vframe sender | compiledVFrame::sender()和frame::sender()区别？ | ✅ 篇2-§1 |
| 4 | 开发者 | vframeStream | vframeStream::next()怎么从inline scope切换到物理帧？ | ✅ 篇2-§2 |
| 5 | 开发者 | vframeArray fill_in | ScopeValue→StackValue 三种转换路径？ | ✅ 篇3-§1 |
| 6 | 开发者 | MonitorChunk | 为什么MonitorChunk是C-heap不是栈？flexible array怎么分配？ | ✅ 篇3-§3 |
| 7 | 性能工程师 | sender链开销 | frame::sender()每步开销——find_blob二分搜索O(log N)影响？ | ⚠️ 未量化 |
| 8 | 架构师 | frame vs vframe | 为什么需要双层抽象？物理帧+虚拟帧的设计意图？ | ✅ 篇2-§1 |
| 9 | 架构师 | vframeArray设计 | vframeArray为什么选C-heap中间表示而非直接在栈上构建？ | ✅ 篇3-§1 |
| 10 | 子系统开发者 | GC oops_do | GC调用frame::oops_do的完整路径——OopMap→RegisterMap→标记？ | ✅ 篇3-§4 |
| 11 | 学生 | 帧不等于方法调用 | 1个物理帧可以有多个源级方法(内联)——怎么展开？ | ✅ 篇2-§2 |
| 12 | 学生 | 为什么需要sender | 为什么栈帧的caller信息不直接存到帧中而是从rbp/PC反推？ | ✅ 篇1-§1 |

总计 12 问, 11✅ + 1⚠️ (0 ❌)
