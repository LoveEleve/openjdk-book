# Ch4-05 CompositeByteBuf — rewrite-plan

## 篇章定位

- 核心困惑：header 和 body 已经分别存在于两个 ByteBuf，为什么为了把它们当成一条消息还要再分配并复制一个大 buffer？多个组件如何被看成一个连续 ByteBuf？
- 一句话顿悟：CompositeByteBuf 不把组件内容搬到一起，而是维护“逻辑偏移 -> 组件局部偏移”的索引表；它用组件 ownership 负责释放，用 `findComponent` 负责定位，用 `consolidate` 在组件过多或确实需要连续存储时一次性付出复制成本。
- 篇章边界：讲虚拟拼接、Component 双引用、逻辑索引定位、自动/手动 consolidate、discardReadComponents；不展开 Pooled Arena、Composite 全部 NIO API、ByteBufUtil 搜索/字符串工具。

## 依赖

### HARD

- Ch4-01：ByteBuf 双指针、refCnt、release ownership。
- Ch4-02：allocator/compositeBuffer、heap/direct 意图与 allocBuffer。
- Ch4-03：Heap/Direct 与 copyMemory/array/address 能力。
- Ch4-04：slice/duplicate、派生视图、共享存储与生命周期。

### SOFT

- Ch2/Ch3：消息由多个 I/O 阶段产生的场景。
- Pooled ByteBuf：本篇只用 pooled slice 说明 srcBuf/buf 双引用，不展开池化。

### NAV

- Ch5 EventLoop：事件循环如何驱动 Composite 的读写和释放。
- Ch8：池化组件和 Arena 资源管理。
- 后续 ByteBufUtil 专题：搜索、字符串编码和 SWAR 路径。

## 素材事实卡片

### 卡片 A：虚拟缓冲区与组件表

- `CompositeByteBuf.java:44-75`：Composite 是 virtual buffer；保存 allocator、direct、maxNumComponents、componentCount、Component[]。
- `CompositeByteBuf.java:837-841`：capacity 取最后组件 endOffset。
- `CompositeByteBuf.java:140-143`：组件数组初始容量猜测。
- `CompositeByteBuf.java:263-267`、`:280-309`：addComponent、ownership 转移、失败 finally release、可选 writerIndex 增长。
- `CompositeByteBuf.java:320-348`：newComponent 记录原始 srcBuf 与解包后的访问 buf。
- `CompositeByteBuf.java:844-886`：capacity 扩缩容通过 padding/尾组件裁剪，组件超限可 consolidate。
- Composite 的 `direct` 只影响 `allocBuffer` 的新分配方向，已有组件可由不同存储类型组成；本篇以源码行为谨慎表述。

### 卡片 B：Component 双引用与索引

- `CompositeByteBuf.java:1913-1934`：srcBuf 原始添加对象；buf 解包后的数据访问对象；srcAdjustment/adjustment/offset/endOffset。
- `CompositeByteBuf.java:1936-1942`：srcIdx 用于原始对象索引，idx 用于解包对象索引。
- `CompositeByteBuf.java:1948-1954`：组件重排时调整 offset 与两个 adjustment。
- `CompositeByteBuf.java:1956-1967`：transferTo 复制后释放；slice 惰性缓存且基于 srcBuf 创建。
- `CompositeByteBuf.java:1979-1984`：free 始终 release srcBuf，因包装/派生对象与解包对象 refCnt 可能不同。
- `CompositeByteBuf.java:320-348`：解包 Wrapped/Swapped/Sliced/Duplicated/Pooled derived 以减少访问代理层，同时保留原始 srcBuf。

### 卡片 C：逻辑偏移定位

- `CompositeByteBuf.java:912-945`：toComponentIndex 对组件 offset/endOffset 做二分，1/2 组件有快路径。
- `CompositeByteBuf.java:952-962`：getByte 找组件后以 c.idx(index) 访问 buf。
- `CompositeByteBuf.java:1614-1654`：lastAccessed 单槽弱缓存，命中直接返回，否则二分；访问后更新缓存。
- 不把“每次 getByte 都 O(log N)”写成绝对事实；顺序访问命中 lastAccessed 可摊销接近 O(1)，随机访问通常需要二分。
- 跨组件多字节读取会回退到逐字节拼接路径，正文可简述不展开所有字节序分支。

### 卡片 D：consolidate

- `CompositeByteBuf.java:1768-1793`：校验范围，allocBuffer，组件 transferTo，移除旧组件，替换首组件并更新 offsets。
- `Component.transferTo` 是 writeBytes + free，见 `CompositeByteBuf.java:1956-1960`。
- addComponent 后 `consolidateIfNeeded` 在组件数达到上限时可能触发；正文引用 `CompositeByteBuf.java:234-267` 的调用链。
- consolidate 是复制并释放，不是零拷贝；收益是减少组件数和后续定位/跨组件处理。
- 不能简单写“合并后所有访问 O(1)”：单组件定位简化，但读写、分配和复制成本已提前支付。

### 卡片 E：discardReadComponents

- `CompositeByteBuf.java:1798-1843`：释放 endOffset <= readerIndex 的完整组件，移除组件，重算 offsets/index/markers。
- `CompositeByteBuf.java:1845-1900`：普通 discardReadBytes 会保留首个未读组件的剩余部分，可能创建 slice；不是同一操作。
- 组件完整消费时可直接释放组件，避免搬剩余字节；首个组件部分消费时仍需调整 component。
- 不把所有 discardReadComponents 绝对写成单次 O(1)：遍历/移除多个组件的成本与组件数量有关；其核心优势是释放完整组件时不复制剩余内容。

## 理解路径

1. **从 header/body 复制困惑切入**：连续大 buffer 简单但会复制，多个独立 buffer 便宜但普通 API 需要连续索引。
2. **建立虚拟缓冲区模型**：Composite 维护组件数组和逻辑 offset，不合并内容。
3. **解释 ownership 转移**：addComponent 后 Composite 负责 release，失败路径也必须回滚释放。
4. **拆 Component 双引用**：srcBuf 保留原始 ownership，buf 解包后负责高效访问，两个索引 adjustment 处理不同坐标。
5. **解释 findComponent**：逻辑 offset 通过组件 endOffset 二分定位，lastAccessed 服务顺序访问。
6. **解释 consolidate 的取舍**：组件太多或需要连续布局时，主动一次复制并释放，换后续简单访问。
7. **解释 discardReadComponents**：完整读完组件直接释放，不像普通 buffer 那样搬未读数据；部分组件仍需切窗口。
8. **误解澄清与收网**：Composite 不是复制 buffer，也不是永远零成本；它把复制时机从“组件拼接时”推迟到“需要连续布局时”。

## 失败方案推演

- 每次 add component 都复制到大 buffer：访问简单但每次拼接都支付 O(total bytes) 复制和临时内存峰值。
- 只保存解包后的 buf：访问方便但 release 可能落在错误的包装层，无法准确归还原始 ownership。
- 每次 getByte 从头线性扫描组件：组件多时随机访问退化 O(N)，所以用二分和 lastAccessed。
- 组件永远不 consolidate：组件数组、定位和跨组件读写复杂度持续增长。
- 每次读完前缀都 discardReadBytes 搬数据：失去 Composite 释放完整组件的优势；应区分完整组件与部分组件。
- 把 consolidate 当零拷贝：它明确执行 transferTo，包含复制和 release。

## 文章结构与预算

1. 为什么需要虚拟拼接（1000-1300 字）
2. Composite 的组件表与 ownership 转移（1900-2400 字）
3. Component 双引用：访问与释放为何分开（1800-2300 字）
4. 逻辑偏移如何定位到组件（1600-2100 字）
5. consolidate：什么时候值得一次复制（1700-2200 字）
6. discardReadComponents：读完组件直接释放（1300-1700 字）
7. 误解澄清、总图与 Ch5 桥接（1000-1300 字）

目标：删掉代码后的叙述性正文 9000-10500 字。

## 证据清单

- `CompositeByteBuf.java:44-75`
- `CompositeByteBuf.java:154-164`
- `CompositeByteBuf.java:221-237`
- `CompositeByteBuf.java:263-309`
- `CompositeByteBuf.java:320-348`
- `CompositeByteBuf.java:837-886`
- `CompositeByteBuf.java:912-962`
- `CompositeByteBuf.java:1614-1654`
- `CompositeByteBuf.java:1768-1793`
- `CompositeByteBuf.java:1798-1900`
- `CompositeByteBuf.java:1913-1984`

## 边界清单

- Composite 是虚拟逻辑缓冲区，不等于所有操作都无需复制；consolidate 明确复制。
- `direct` 标记影响 Composite 自己需要分配 padding/consolidated buffer 时的方向，不把已有组件类型强制统一。
- addComponent 转移 release ownership；调用者不能继续假设自己仍拥有同一份 release 权。
- `srcBuf` 与 `buf` 的双引用是当前实现对派生/包装组件 ownership 与访问的分离，不当作所有 Composite 实现的通用公开结构。
- findComponent 顺序访问可命中 lastAccessed，随机访问可能走二分；不绝对写成 O(1) 或 O(log N)。
- discardReadComponents 释放完整已读组件不复制剩余数据；部分组件仍需调整/切片。
- Composite 的完整 NIO buffer、组件内部返回对象、Pooled ownership 细节留后文。

## 深审预警

- [ ] 不把 Component 双引用简化成“srcBuf 负责 refCnt、buf 负责访问”而忽略 adjustment/offset。
- [ ] 不把 `addComponent` 的 writerIndex 默认行为写反：默认不增加，需要 boolean 参数。
- [ ] 说明 addComponent 转移 ownership，失败 finally 会 release。
- [ ] 说明 `capacity()` 是最后组件 endOffset，不是简单 sum 每次现算。
- [ ] 不把 `findComponent` 的二分和 lastAccessed 混为一个复杂度结论。
- [ ] consolidate 明确是复制后释放，不是 zero-copy。
- [ ] discardReadComponents 与 discardReadBytes 分开，避免把 O(1) 释放描述成所有情况下 O(1)。
- [ ] 删除代码后仍能复述虚拟拼接、ownership、定位和合并取舍。
