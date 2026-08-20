# Ch4-04 视图与零拷贝 — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| 派生共享数据表示、索引独立、copy 独立 | `ByteBuf.java:195-221` | ✅ |
| 普通/retained 派生的 refCnt 差异 | `ByteBuf.java:215-221` | ✅ |
| slice/duplicate/retained 入口 | `AbstractByteBuf.java:1200-1233` | ✅ |
| readSlice/readRetainedSlice 推进 parent readerIndex | `AbstractByteBuf.java:885-897` | ✅ |
| 派生 refCnt/isAccessible/retain/release 委托 | `AbstractDerivedByteBuf.java:34-49`、`:52-108` | ✅ |
| slice adjustment 与嵌套扁平化 | `AbstractUnpooledSlicedByteBuf.java:32-53`、`:40-48` | ✅ |
| 本地索引转 parent 索引 | `AbstractUnpooledSlicedByteBuf.java:473-480` | ✅ |
| slice 读写委托 parent | `UnpooledSlicedByteBuf.java:27-40`、`:82-85` | ✅ |
| duplicate 读写委托 parent | `UnpooledDuplicatedByteBuf.java:28-35` | ✅ |
| duplicate 覆盖 capacity、初始索引独立 | `DuplicatedByteBuf.java:41-59`、`:82-90` | ✅ 已补引用 |
| slice capacity 固定窗口长度 | `SlicedByteBuf.java:27-49` | ✅ |
| Unreleasable 阻止 refCnt 改变 | `UnreleasableByteBuf.java:22-26`、`:104-132` | ✅ |
| Unreleasable retained 派生特殊转发 | `UnreleasableByteBuf.java:52-101` | ✅ |

### 深审发现

1. **低风险：duplicate 的 capacity 与初始索引语义原先缺少直接证据引用。** 已补充 `DuplicatedByteBuf.java:41-59`、`:82-90`，明确构造时保存 parent 的 reader/writer index，capacity 委托 parent。

未发现普通视图自动 retain、release 无条件释放 parent 或 readSlice 不推进 parent 等事实错误。

## 第二轮：因果审

- 多 Handler 只需窗口 -> copy 会复制内容 -> view 共享存储：✅
- 共享存储与共享寿命独立 -> 普通 view 不 retain、retained view retain：✅
- slice 本地 index -> adjustment -> parent 实际 index：✅
- duplicate 全容量 + 独立索引：✅
- readSlice 创建窗口 + 推进 parent readerIndex：✅
- parent release -> 派生 refCnt/isAccessible 委托为 0 -> 访问失败：✅
- retained view 多一份引用 -> parent release 后仍存活 -> view release 最终归零：✅

“zero-copy”已明确限定为避免内容复制，不误写成线程安全或生命周期安全。✅

## 第三轮：结构审

正文按“copy/view 困惑 -> 两条轴 -> slice -> duplicate -> readSlice -> retained -> 特殊包装 -> 收网”组织，符合读者理解路径。✅

源码细节围绕共享存储和共享寿命两条主线出现，没有按派生类文件顺序堆叠。✅

## 第四轮：读者审

删掉代码块后仍能复述：普通派生共享内容但借用 parent 生命周期，retained 变体增加 parent 引用；slice 是固定窗口，duplicate 是全量窗口，readSlice 还推进 parent readerIndex。✅

误解澄清覆盖 zero-copy、retained、duplicate、readSlice、release 五个高频混淆点。✅

## 第五轮：边界审

- 明确普通视图不自动延长 parent 寿命。✅
- 明确 retained 仍需 release，不自动线程安全。✅
- 明确 release 委托 parent，但只有计数归零才 deallocate。✅
- adjustment 只限定当前 unpooled sliced implementation。✅
- `AbstractDerivedByteBuf` deprecated 的内部实现没有被写成稳定 API 承诺。✅
- ReadOnly/Unreleasable/Swapped 仅作包装边界说明，Composite 留后续。✅

## 第六轮：依赖审

- Ch4-01 双指针、refCnt、ownership 已完成并正确复用。✅
- Ch4-03 Heap/Direct 共享存储背景已完成并正确复用。✅
- Ch4-02 allocator 仅作背景，不成为未解释硬前提。✅
- Ch4-05 Composite、Ch8 pooling、Ch5/Ch7 只作导航。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 469。
- 去码后字符数：约 9,050。
- 去码去空白后字符数：约 8,075。
- 符合重大机制篇篇幅要求。✅

## 结论

Ch4-04 六轮 review 完成，发现一处低风险证据引用缺口并已补齐。可进入 Ch4-05 CompositeByteBuf。
