# Netty Ch1-03 视图与陷阱 — 正文深审记录

## 第一轮：事实审

- 核对 slice/duplicate/asReadOnlyBuffer 的共享存储与独立状态语义。
- 核对 hasArray/array 的能力边界，避免把 HeapBuffer 能力外推到 Direct/ReadOnly。
- 核对 equals/compareTo 的 remaining 区间语义。
- 核对 order、bulk get/put、mark/reset 的状态影响。
- 补充 view 构造源码锚点：`Heap-X-Buffer.java.template:104-145`、`X-Buffer.java.template:601-630`。

## 第二轮：因果审

- 把“视图共享数据”与“视图独立游标”分开解释。
- 把 read-only 权限隔离与线程安全分开解释。
- 把直接地址/共享数组的零复制机会与绝对零拷贝区分。
- 把 order 的解释状态与底层字节重排区分。

## 第三轮：结构审

- 按共享视图 → 数组能力 → 比较语义 → 字节序 → bulk → mark/reset 组织。
- 没有提前展开 Channel 和 Netty ByteBuf，只在篇末建立导航桥。
- slice/duplicate/readonly/wrap 的边界没有重复成一个“共享内存”段落。

## 第四轮：读者审

- 删除代码后仍能复述视图、remaining、order、bulk、mark/reset 的核心行为。
- 误解清单覆盖：深复制、read-only 并发、array 能力、equals 范围、order、bulk position、单层 mark。
- 通过协议消息切分、固定字段 peek、Heap/Direct 生产差异等场景建立动机。

## 第五轮：边界审

- 说明 view 共享底层存储会延长数据生命周期，但未把它误写成引用计数语义。
- 明确 read-only 不提供同步。
- 明确 Netty reader/writer index、引用计数和 LE API 只作为后续对照。

## 第六轮：方法论审

- 篇级规划已落盘：`03-views-and-traps.rewrite-plan.md`。
- 正文位于 `vol-netty`，不修改 `vol-02`/`vol-java`。
- 禁用词扫描通过。
- 当前篇幅以问题闭环、深度、广度和删码后成立为准，不以固定字数作为硬门槛。
- 当前未发现需要返工的高风险事实问题。
