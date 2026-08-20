# Ch5-03 epoll bug 与 Selector 重建 — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| `wakenUp` 为 `AtomicBoolean` | `NioIoHandler.java:105-116` | ✅ |
| 外部线程 wakeup 走 CAS 后才真正 syscall | `NioIoHandler.java:615-618` | ✅ |
| select 返回后补偿 wakeup 的注释与代码 | `NioIoHandler.java:433-466` | ✅ |
| `selectNow()` finally 恢复 wakeup 状态 | `NioIoHandler.java:736-744` | ✅ |
| `MIN_PREMATURE_SELECTOR_RETURNS=3`、阈值 < 3 则禁用 | `NioIoHandler.java:66-88` | ✅ |
| select 循环 break 条件与 timeout/interrupt 分支 | `NioIoHandler.java:630-714` | ✅ |
| `selectCnt` 在 timeout、interrupt、rebuild 后都会被设为 1 | `NioIoHandler.java:646-650`、`:678-689`、`:697-703` | ✅ |
| `IOException` 路径先 rebuild 再退避告警 | `NioIoHandler.java:470-475`、`:498-507` | ✅ 已补文案 |
| `selectRebuildSelector()` warn + `selectNow()` | `NioIoHandler.java:747-759` | ✅ |
| `rebuildSelector0()` 顺序：新建 -> 迁移 -> 替换 -> 关闭旧 selector | `NioIoHandler.java:255-302` | ✅ |
| 迁移失败时 `handle.cancel()` | `NioIoHandler.java:281-284` | ✅ |

### 深审发现

1. **低风险：`IOException` 后续动作最初写得过于简化。** 当前实现不只是 rebuild，还会调用 `handleLoopException(e)` 做 warn 和 1 秒退避。已补充说明。
2. **低风险：阈值为 0 的后果需要更精确。** 已改为“自动检测禁用，但仍可通过上层入口手动 rebuild”，避免写成完全失去所有恢复手段。

未发现把旧 bug ID、旧 `select==0` 经验规则直接写成当前源码事实的高风险错误。

## 第二轮：因果审

- CPU 高/GC 正常/流量不高 -> 可疑点在等待路径而非业务处理：✅
- 单次 0 返回不定性 -> 先区分 timeout、wakeup、任务、interrupt：✅
- 第一层 CAS+wakeup 补偿 -> 防唤醒时序错位：✅
- 第二层 `selectCnt` -> 只累计可疑连续提前返回：✅
- 第三层 rebuild -> 替换已不可信的 selector 基础设施：✅
- 手动/自动 rebuild 边界、日志信号与误判区分：✅

因果链成立，没有把三层机制混成一个问题。✅

## 第三轮：结构审

正文按“故障场景 -> 正常返回先分清 -> 第一层 wakeup -> 第二层计数 -> 第三层重建 -> 排障信号 -> 收网”推进，符合问题 → 失败 → 恢复的理解路径。✅

没有被 `NioIoHandler.select()` 的源码顺序绑架，也没有过早深入多线程 group。✅

## 第四轮：读者审

删掉代码块后，主线仍可复述：

- 先分清什么不是 bug。
- 再看 wakeup 时序补偿。
- 再看连续提前返回如何被计数区分。
- 最后看为什么要重建整个 selector。

SRE 视角下的日志信号和误判边界也能被单独记住。✅

## 第五轮：边界审

- 没把单次 `select()==0` 写成 bug 判据。✅
- 没把 512 次阈值换算成固定秒数。✅
- 没把 wakeup CAS 说成修复 epoll bug 本身。✅
- 没对“重建期间事件绝不丢失”作源码无法支撑的绝对承诺。✅
- 区分了 timeout、interrupt、IOException、premature select 四类路径。✅
- 说明阈值为 0 只禁用自动检测，不否定手动 rebuild 可能性。✅

## 第六轮：依赖审

- Ch3-03 的 JDK Selector 问题、Ch5-01 的主循环、Ch5-02 的 select 阶段策略都已正确复用。✅
- Ch5-04 多线程 chooser 只作导航，没有提前透支。✅
- 没引用未分析的 native transport 细节作为既成事实。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 416。
- 去码后字符数：约 8,270。
- 去码去空白后字符数：约 7,370。
- 对故障恢复专题篇已形成闭环。✅

## 结论

Ch5-03 六轮 review 完成，深审发现 2 处表述边界并已修正。可进入 Ch5-04 多线程与特殊模型。
