# 19-buffer-channel/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Buffer` 与各类 Buffer 共用状态机抽象。本文聚焦 `mark/position/limit/capacity`、`flip/clear/rewind/mark/reset`、`remaining/hasRemaining`，以及 `isDirect` 背后的堆内/堆外边界；ByteBuffer 家族与视图生成留到下一篇。
> 目标：把“Buffer 抽象与状态机”改写成一篇围绕“为什么 Buffer 的核心不是字节数组本身，而是围绕四个游标字段建立的一套读写边界状态机；以及为什么 DirectBuffer 让这个状态机进一步分裂出堆内/堆外两条性能路径”的机制文章。

## 1. 读者困惑

- `flip()` 为什么总被问，它到底改变了什么，为什么不改就读不对？
- `position`、`limit`、`capacity`、`mark` 四个字段到底在表达什么，为什么它们的相对关系比底层数组还重要？
- `clear()` 为什么名字像擦数据，实际上并不清空任何字节？
- `rewind()` 和 `flip()` 看起来都把 position 设回 0，它们为什么不是一回事？
- `remaining()` 为什么总得放在“当前模式”里理解？
- 堆内 Buffer 和 DirectBuffer 看起来 API 一样，为什么一个常被说“IO 更快”？

## 2. 一句话顿悟

**Buffer 的本体不是“包了一层数组”，而是一套围绕 `mark/position/limit/capacity` 的状态机：写模式下它记录还能往哪写，读模式下它记录刚刚写进来的数据读到哪为止；`flip/clear/rewind` 本质上都只是 O(1) 的状态切换。DirectBuffer 则在这套状态机之外进一步改变了底层存储位置——堆内数组需要额外过渡到稳定地址，堆外原生内存则能更直接参与 I/O。**

## 3. 旧稿优点与问题

### 保留

- 已完整覆盖四字段、不变量、flip/clear/rewind/mark-reset、remaining/hasRemaining 和 direct/heap 差异。
- 已抓到“操作改状态不改底层数据”这一条总线索，这是本篇核心。
- 已把 ByteBuffer 家族和 NIO 通道细节留给后续篇章，边界合理。

### 必须重写

- 主要不是内容缺失，而是需要一份与其他域一致的计划与收束视角。
- 开头要更明确地把“为什么 Buffer 不只是数组”作为总问题立起来。
- Direct/heap 差异要更明显地回扣到“稳定地址 + 少一次拷贝”这一性能边界，而不是泛泛讲堆外内存。
- 收尾要更自然地把状态机心智和下一篇 ByteBuffer 家族衔接起来。

## 4. 理解路径

### 第一节：从“为什么不 flip 就读不对”开场

用最经典错误场景开场：往 ByteBuffer 里 put 了 N 个字节后直接 get，结果 remaining 和读边界都不对。先立住总问题：Buffer 真正控制读写的不是底层数组内容，而是四个游标字段如何划定当前模式边界。

### 第二节：四个字段为什么是状态机而不是普通属性

证据：
- `Buffer.java:198-201`：`mark/position/limit/capacity`
- `Buffer.java:217-232`：构造时不变量校验
- `Buffer.java:291-299`：`position(int)` 约束与 mark 清空

主线：
- `capacity` 是物理上限；`limit` 是当前模式边界；`position` 是下一次读/写位置；`mark` 是临时书签。
- 不变量让 Buffer 成为一个受约束状态机，而不是随便改字段的包对象。
- mark 会因 position 回退失效，说明书签本身也受状态机约束。

### 第三节：flip / clear / rewind 为什么是三种不同的状态切换

证据：
- `Buffer.java:421-426`：`clear()`
- `Buffer.java:449-454`：`flip()`
- `Buffer.java:471-475`：`rewind()`
- `Buffer.java:380-402`：`mark/reset`

主线：
- flip 把刚写入的长度转成读取边界。
- clear 恢复全容量写模式，但不抹数据。
- rewind 只回到已写起点，保留当前 limit。
- 这三者都不改底层数组，只改状态。

### 第四节：remaining/hasRemaining 为什么只有放在“当前模式”里才有意义

证据：
- `Buffer.java:483-497`：`remaining()` / `hasRemaining()`

主线：
- `remaining = limit - position` 是纯状态机查询。
- 写模式下它表示还能写多少；flip 后才表示还有多少数据可读。
- 这解释了为什么 flip 是“把写入事实转成读取边界”的关键动作。

### 第五节：isDirect 为什么把同一套状态机分成堆内和堆外两条性能路径

证据：
- `Buffer.java:580`：`isDirect()`
- （堆内/堆外模板源码可在正文中按现有旧稿点到，不强求全部精确锚点）

主线：
- 状态机逻辑相同，但底层存储位置不同：堆内数组 vs 堆外原生内存。
- Direct 更适合高频 I/O，本质是减少中间拷贝并提供稳定地址。
- 堆外的代价是回收与生命周期管理更难，不是默认更好。

## 5. 失败方案清单

1. put 完数据后不 flip 就开始按读模式消费。
2. 把 clear 当成“擦除底层数据”，而不是“重置写模式”。
3. 把 rewind 当成 flip 的别名。
4. 不看 remaining/limit，只拿数组长度猜还能读多少。
5. 看到 DirectBuffer 就无脑认为一定更好，而不考虑数据量和生命周期。

## 6. 误解清单

1. Buffer 只是数组外面包了一些便捷方法。
2. flip 的作用只是把 position 归零。
3. clear 之后旧数据就一定被抹掉了。
4. remaining 是固定属性，和读写模式无关。
5. DirectBuffer 快主要因为“JVM 特殊优化”，而不是 I/O 边界减少拷贝。

## 7. 证据清单

- `Buffer.java:198-201`：四个核心字段
- `Buffer.java:217-232`：构造与不变量
- `Buffer.java:291-299`：`position(int)`
- `Buffer.java:380-402`：`mark/reset`
- `Buffer.java:421-426`：`clear`
- `Buffer.java:449-454`：`flip`
- `Buffer.java:471-475`：`rewind`
- `Buffer.java:483-497`：`remaining` / `hasRemaining`
- `Buffer.java:580`：`isDirect`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦抽象状态机和堆内/堆外语义，不展开 ByteBuffer 家族的视图、字节序和 direct 具体清理机制的所有细节。
- 旧稿中关于堆内 shadow buffer 与 Cleaner 的细节可在后续需要时继续深化，但本篇先立状态机心智。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“Buffer 为什么首先是状态机而不是数组 → 四个字段怎样构成读写边界 → flip/clear/rewind 各自改变什么而不改数据 → remaining 为什么依赖当前模式 → direct/heap 如何在同一状态机外再分裂出两条 I/O 路径”。
- 必须把 flip 讲成读写模式切换的总开关。
- 必须自然引到 `02-bytebuffer-family.md`。
