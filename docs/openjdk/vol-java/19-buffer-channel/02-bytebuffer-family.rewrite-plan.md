# 19-buffer-channel/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ByteBuffer` 及其生成出来的 Heap/Direct/AsXBuffer 视图类。本文聚焦模板生成体系、`allocate/allocateDirect/wrap`、字节序、视图（slice/duplicate/asXBuffer）与共享底层语义；FileChannel 与 mmap 放到下一篇。
> 目标：把“ByteBuffer 家族与生成体系”改写成一篇围绕“为什么 ByteBuffer 看起来像一堆近亲类，实际上却围绕同一个模板、同一套底层共享语义和字节序视角构建”的机制文章。

## 1. 读者困惑

- `ByteBuffer`、`CharBuffer`、`IntBuffer` 这些类为什么长得几乎一样，源码却不想手写七份？
- `wrap`、`slice`、`duplicate`、`asIntBuffer` 到底有没有复制底层数据？
- `order(ByteOrder)` 为什么能改变你读到的数值，却不改变底层字节？
- `allocate` 和 `allocateDirect` 返回的都叫 ByteBuffer，为什么底层成本路径完全不同？

## 2. 一句话顿悟

**ByteBuffer 家族真正统一的不是“都叫 Buffer”，而是：同一套状态机可以落在堆内数组、堆外地址、只读视图和跨类型解释视图上；JDK 为了避免七种原始类型手写七套近同实现，用模板在构建期生成类族。`wrap/slice/duplicate/asXBuffer` 则继续坚持一条原则——尽量共享底层存储，真正变化的是视角、游标和字节解释方式。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖模板生成、wrap 零拷贝、字节序、视图家族和 heap/direct 差异。
- 已抓住“共享底层、独立游标”的视图核心语义。
- 已把 mmap/FileChannel 放到下一篇，边界合理。

### 必须重写

- 主要不是内容缺失，而是需要一份与其他域一致的计划和更强的问题驱动开场。
- 模板生成要更明确回到“为什么不手写七份近同代码”这条工程问题上。
- 视图部分要继续强调“改变的是解释与游标，不是底层字节”这条统一主线。
- direct/heap 差异应紧扣“稳定地址与额外拷贝”成本边界，而不是展开成 cleaner/unsafe 全景。

## 4. 理解路径

### 第一节：从“七个近亲为什么不用手写七遍”开场

用 ByteBuffer/CharBuffer/IntBuffer API 高度近同开场，引出总问题：JDK 如何避免重复维护七套近同实现。

### 第二节：模板生成体系为什么是这个家族的工程地基

证据：
- 现文已有模板与 GensrcBuffer 路径说明，可保留
- `X-Buffer.java.template`、`Heap-X-Buffer.java.template`、`Direct-X-Buffer.java.template`、`ByteBufferAs-X-Buffer.java.template` 作为关键族谱

主线：
- 抽象逻辑相同，元素类型不同，模板替代七份手写代码。
- 构建期生成类族，运行期调用方只看到最终产物类。

### 第三节：wrap 为什么是“把数组借给 ByteBuffer 用”，不是复制

证据：
- `X-Buffer.java.template:389-398`（现文已有）
- `Heap-X-Buffer.java.template:55` / `154`（offset 与 ix）

主线：
- wrap 返回 HeapByteBuffer，底层共享同一数组。
- 修改 buffer 会影响原数组，修改数组也会反映到 buffer。
- 这条共享语义要和 Arrays.copyOf 的复制语义明显对照。

### 第四节：字节序和视图为什么都在改变“解释方式”，而不是数据本身

证据：
- `X-Buffer.java.template:1636-1670`：`bigEndian/nativeByteOrder/order`
- `Heap-X-Buffer.java.template:429-445`：`asIntBuffer`
- `ByteBufferAs-X-Buffer.java.template:39`：底层 `bb`

主线：
- order 改的是多字节如何组装，不改底层字节排列。
- asXBuffer 改的是“同一块字节按哪种元素类型解释”，不是复制出新数组。
- 这把字节序和跨类型视图统一收束为“解释视角”问题。

### 第五节：slice/duplicate 为什么是“共享底层、分离游标”的不同切片方式

证据：
- `ByteBufferAs-X-Buffer.java.template:79-94`：slice / duplicate

主线：
- slice 只暴露 position..limit 这段范围；duplicate 覆盖全范围但保留当前位置状态。
- 两者都共享底层，但游标独立。
- 要和前一篇 Buffer 状态机的 flip/position/limit 心智紧密回扣。

### 第六节：heap vs direct 为什么是同一 API 下的两条性能路径

证据：
- 旧稿中对 heap/direct 模板字段与 I/O shadow buffer 的定位可沿用

主线：
- API 一样，底层存储位置不同。
- direct 的核心价值是给 I/O 提供稳定地址、减少额外拷贝；heap 更轻便但 I/O 常需要额外中转。
- 不把讨论扩成所有 direct 内存生命周期细节，只立清性能边界。

## 5. 失败方案清单

1. 把 ByteBuffer 家族当成七套手写独立实现，而不是模板生成的同构类族。
2. 以为 wrap/slice/duplicate 会复制底层数据，所以误判共享语义。
3. 把字节序切换当成“重排字节”，忽略它只是解释方式变化。
4. 用 asIntBuffer 后以为拿到了一份独立 int 数组视图。
5. 看到 DirectBuffer 就无脑当成总是更优方案。

## 6. 误解清单

1. ByteBuffer/CharBuffer 的差别主要在 API，内部实现路线无关。
2. wrap 的 offset 只是初始 position，不影响真实索引换算。
3. nativeByteOrder 只是查询信息，不参与任何性能路径。
4. slice 和 duplicate 只是名字不同的同一功能。
5. 只读/大小端/跨类型视图都会各自复制底层存储。

## 7. 证据清单

- 模板路径与 GensrcBuffer 生成规则（现文已有）
- `X-Buffer.java.template:271`：堆内存储字段模板
- `X-Buffer.java.template:389-398`：wrap
- `Heap-X-Buffer.java.template:55`：offset
- `Heap-X-Buffer.java.template:154`：`ix(i)`
- `X-Buffer.java.template:1636-1670`：byte order 字段与 API
- `Heap-X-Buffer.java.template:429-445`：`asIntBuffer`
- `ByteBufferAs-X-Buffer.java.template:39`：底层 `bb`
- `ByteBufferAs-X-Buffer.java.template:79-94`：slice / duplicate

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦 ByteBuffer 家族生成与视图语义，不展开 Channel、mmap 或 direct 内存完整生命周期。
- 模板文件锚点可能依构建产物差异略有偏移，正文应保持以机制解释为主。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“模板生成为什么能统一七种 Buffer → wrap/slice/duplicate/asXBuffer 为何都共享底层 → 字节序改变的只是解释方式 → direct/heap 为什么导出两条 I/O 性能路径”。
- 必须把‘共享底层、改变视角’讲成全篇统一主线。
- 必须自然引到 `03-filechannel-mmap.md`。
