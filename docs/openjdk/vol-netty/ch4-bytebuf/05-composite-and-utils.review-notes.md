# Ch4-05 CompositeByteBuf — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| Composite 是虚拟缓冲区并保存组件表 | `CompositeByteBuf.java:44-75` | ✅ |
| 空/非空 capacity 由组件 endOffset 决定 | `CompositeByteBuf.java:837-841` | ✅ 已补空 Composite capacity=0 边界 |
| addComponent 转移 release ownership | `CompositeByteBuf.java:154-164`、`:213-223` | ✅ |
| 默认 add 不增加 writerIndex，boolean 重载才可增加 | `CompositeByteBuf.java:154-158`、`:221-223`、`:263-267` | ✅ |
| add 失败 finally release 回滚 | `CompositeByteBuf.java:280-309` | ✅ |
| newComponent 解包并保留 srcBuf/buf | `CompositeByteBuf.java:320-348` | ✅ |
| Component 双引用与 adjustment | `CompositeByteBuf.java:1913-1942` | ✅ |
| reposition 更新 offset/adjustment | `CompositeByteBuf.java:1948-1954` | ✅ |
| Component transferTo 与 free | `CompositeByteBuf.java:1956-1960`、`:1979-1984` | ✅ |
| Component slice 惰性缓存 | `CompositeByteBuf.java:1962-1967` | ✅ |
| 逻辑索引二分定位 | `CompositeByteBuf.java:912-945` | ✅ |
| lastAccessed 弱缓存 | `CompositeByteBuf.java:1614-1654` | ✅ |
| getByte 组件定位后局部访问 | `CompositeByteBuf.java:952-962` | ✅ |
| consolidate 申请、transfer、替换组件 | `CompositeByteBuf.java:1768-1793` | ✅ |
| add 后组件数超过上限才 consolidate | `CompositeByteBuf.java:234-267`、`:562-573` | ✅ 已补精确条件 |
| capacity 扩缩容布局变化 | `CompositeByteBuf.java:844-886` | ✅ |
| discardReadComponents 释放完整组件并重排 | `CompositeByteBuf.java:1798-1843` | ✅ |
| discardReadBytes 部分组件调整/切片 | `CompositeByteBuf.java:1845-1900` | ✅ |

### 深审发现

1. **低风险：空 Composite 的 capacity 边界未明说。** 已补充“没有组件时 capacity 为 0”。
2. **中风险：自动 consolidate 的触发条件需要精确。** 初稿使用“达到上限”容易让人理解成 `>=`；当前源码是组件数 `>` `maxNumComponents`，已补引用并改文。

未发现 ownership 转移、Component 双引用、consolidate 复制或 discard 释放路径的事实错误。

## 第二轮：因果审

- header/body 已分别存在 -> 直接复制会产生不必要搬运 -> 组件表虚拟拼接：✅
- ownership 转移 -> Composite 负责 release -> 失败 finally 回滚：✅
- 原始包装对象与解包访问对象可能不同 -> srcBuf/buf 双引用 + 两套 adjustment：✅
- 逻辑 offset -> lastAccessed 快速命中或二分 -> 组件内访问：✅
- 组件数增长 -> 定位/跨组件成本上升 -> 超限 consolidate：✅
- 完整组件已读 -> 直接 free 并重排 -> 避免搬未读内容：✅

未把“组件化”误写成所有访问零成本或所有路径 O(1)。✅

## 第三轮：结构审

正文按“虚拟拼接 -> ownership -> Component 双引用 -> 索引定位 -> consolidate -> discardReadComponents -> 收网”组织，符合理解路径。✅

源码证据服务于逻辑连续/物理分散的主线，没有按 Composite 文件顺序逐段翻译。✅

## 第四轮：读者审

删掉代码块后仍能复述：Composite 用 offset 表把多个组件映射成一个逻辑 ByteBuf，srcBuf 负责原始 ownership，buf 负责访问，二分/缓存负责定位，consolidate 在必要时复制，discardReadComponents 释放完整已读组件。✅

误解澄清覆盖 zero-copy、direct 标志、writerIndex、双引用、discard 复杂度。✅

## 第五轮：边界审

- Composite 的 `direct` 标志没有被写成所有已有组件必须同类型。✅
- addComponent ownership 转移已明确。✅
- Component 双引用限定为当前实现，不写成公开通用结构。✅
- lastAccessed 与二分的复杂度边界已区分。✅
- consolidate 明确是复制后释放，不是 zero-copy。✅
- discardReadComponents 只把完整组件释放优势与复制成本比较，没有绝对声称所有情况严格 O(1)。✅
- Pooled/Arena/完整 NIO API 留后续。✅

## 第六轮：依赖审

- Ch4-01 双指针/refCnt、Ch4-02 allocator、Ch4-03 Heap/Direct、Ch4-04 views 均已完成并正确复用。✅
- Ch5 EventLoop、Ch8 pooling 只做导航。✅
- 没有把 Composite 作为 Ch5 的硬前置，也没有引入未分析的 ByteBufUtil 结论。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 455。
- 去码后字符数：约 9,060。
- 去码去空白后字符数：约 8,170。
- 符合重大机制篇幅要求。✅

## 结论

Ch4-05 六轮 review 完成，发现 2 项边界表述并已修正。Ch4 ByteBuf 五篇全部完成，可进入 Ch5 EventLoop。
