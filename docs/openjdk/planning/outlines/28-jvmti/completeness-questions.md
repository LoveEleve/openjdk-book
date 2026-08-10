## 全视角提问：JVMTI (域28)

| # | 身份 | 子主题 | 问题 | 覆盖 |
|:--:|------|------|------|:--:|
| 1 | 开发者 | Capability | 怎么声明 can_tag_objects？两阶段何时生效？ | ✅ 篇1-§3 |
| 2 | 开发者 | Event | SetEventNotificationMode 怎么 per-thread 控制？ | ✅ 篇1-§2 |
| 3 | 开发者 | RedefineClasses | 类重定义——InstanceKlass 原地替换涉及哪些字段？ | ✅ 篇2-§1 |
| 4 | 开发者 | MethodComparator | 逐字节码比较——遇到 ldc/branch 怎么处理？ | ✅ 篇2-§2 |
| 5 | 开发者 | TagMap | SetTag/GetTag 用 weak hash table——GC 怎么清理 stale entry？ | ✅ 篇3-§1 |
| 6 | 架构师 | Redefine 设计 | 为什么是原地替换而非创建新类？ | ✅ 篇2-§1 |
| 7 | 架构师 | Deferred event | 为什么事件延迟分派(Synchronous vs deferred)？ | ✅ 篇3-§2 |
| 8 | 学生 | Agent 是什么 | JVMTI agent = .so/.dll——怎么写到 agent 代码？ | ✅ 篇1-§1 |

8问全✅
