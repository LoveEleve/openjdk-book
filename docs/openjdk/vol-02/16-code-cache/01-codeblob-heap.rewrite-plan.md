# 16-code-cache/01-codeblob-heap 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JIT 产出的机器码为什么不能像普通 malloc 那样随便找地方一放，而必须经历 `CodeBuffer -> CodeBlob -> CodeHeap -> CodeCache` 这条受类型、可见性、可执行内存与生命周期共同约束的安家链路

## 1. 选题判断

现稿已经覆盖了不少事实：
- `CodeBuffer` 三段
- `CodeBlob` 类型枚举
- `CodeCache::allocate/commit`
- `CodeHeap` 的 freelist 与 segmap
- Code cache segmentation 的开关条件

但现稿主要还是“源码事实卡片”。真正该打穿的读者困惑更集中：

**为什么 JIT 机器码不能像普通对象那样“编完就 malloc 一块内存放进去”？为什么 HotSpot 要先用 `CodeBuffer` 当临时工地，再把成品包装成 `CodeBlob`，最后放进按类型切开的 `CodeHeap`，而且还要把 allocate 与 commit 分成两步？**

只有把这个问题钉住，`CodeBlob`、`CodeHeap`、segmap、分段开关这些零散事实才会收成一个闭环。

## 2. 一句话顿悟

**机器码的“家”不是一块普通内存，而是一套发布协议：编译阶段先在可丢弃、可扩容的 `CodeBuffer` 里搭临时工地；成品再包装成带布局与身份的 `CodeBlob`；最后放进只管理可执行代码的 `CodeHeap`。`CodeCache` 还要按代码寿命和用途把堆切开，并用 allocate/commit 两段式发布保证半成品代码不会暴露给执行器、GC 和遍历器。**

## 3. 总图

```text
编译器生成机器码时
  CodeBuffer
    ├─ consts
    ├─ insts
    └─ stubs
        ↓ 定稿后计算最终布局
  CodeBlobLayout
    ├─ header
    ├─ relocations
    ├─ content(consts/insts/stubs)
    └─ data
        ↓ 申请可执行内存
  CodeCache::allocate(type)
        ↓ 放进对应 CodeHeap
  CodeHeap
    ├─ NonNMethod
    ├─ MethodProfiled
    └─ MethodNonProfiled
        ↓ 内容填完后发布
  CodeCache::commit(blob)
        ↓ 其他线程此后才把它当成正式代码
  查找/执行/GC/回收
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——编译出来的机器码到底住哪，为什么不能随便放

目标约 1200 字。

- 从上一篇 `LibraryCallKit`、`Matcher`、`Output` 已经把方法压成机器码切入
- 点出新困惑：代码不是字节数组，它马上会被执行、查找、遍历、回收
- 埋主线：这不是“找块内存”，而是“给将来要执行的代码建立合法住址”

### 第二节：两个最自然的朴素方案为什么都不行

目标约 1800 字。

必须推演至少两个失败方案：
1. 编译器边生成边直接往 CodeCache 写
2. 所有代码都放进一个统一大堆，不分类型与寿命

要讲清：
- 直接写共享代码区会把扩容、失败回滚、半成品可见性问题全暴露出来
- 不分类型会让短命编译方法与常驻 runtime blob 互相挤压
- 代码区是可执行内存，不适合像普通 Java 堆那样搬来搬去

### 第三节：`CodeBuffer`——为什么先搭临时工地

目标约 1900 字。

- `SECT_CONSTS / SECT_INSTS / SECT_STUBS`
- section 可扩容、最终拼接、跨 section 重定位
- 为什么一定先有“能失败、能重排、能扩容”的中间态
- 路标：先别记 API，记住 `CodeBuffer` 解决的是“编译期可变，发布后固定”

### 第四节：`CodeBlob`——为什么机器码提交前必须先拿到身份和布局

目标约 1900 字。

- `CodeBlob` 不是只有指令区，而是 header/reloc/content/data 的连续对象
- `CodeBlobLayout` 如何把 `CodeBuffer` 的临时三段压成最终四区
- `CodeBlobType` 的五类身份
- `RuntimeBlob` vs `CompiledMethod` 的两类寿命
- 点到 `nmethod` 只是下一篇要展开的特例

### 第五节：`CodeCache::allocate/commit`——为什么要分成两段发布

目标约 1900 字。

- 读 `CodeCache::allocate` 顶部注释
- 讲清“半成品不可见”的原因：扫描者、GC、遍历器、执行器都可能路过
- 分析扩容失败后的 fallback 逻辑
- `commit` 时做 ICache invalidate，形成真正可执行的发布边界

### 第六节：`CodeHeap`——为什么代码区只能用段级分配而不是普通堆思路

目标约 2100 字。

- `VirtualSpace`：先预留，再按需提交
- freelist + `_next_segment` 顺序后备
- segmap 如何支持“给你一个 pc，快速反查它属于哪个 blob”
- 为什么代码回收更像“代码区 malloc/free”，而不是普通对象移动整理

### 第七节：分段 CodeCache——为什么要按用途和画像拆堆

目标约 1700 字。

- `SegmentedCodeCache` 默认条件
- `NonNMethodCodeHeapSize` 默认值
- profiled / non-profiled / non-nmethod 的设计动机
- fallback 只是退路，不是常态

### 第八节：误解澄清与收网

目标约 1300 字。

至少回答：
1. `CodeBuffer` 是否就是最终代码对象
2. `CodeBlob` 是否只是一层 C++ 包装壳
3. `commit` 是否只是记账动作
4. code heap segmentation 是否只是性能微调
5. 代码回收是否等于把机器码搬走压缩

## 5. 失败方案必须写进正文

1. 边编边直接往 `CodeCache` 写
2. 所有代码混放在一个统一堆里
3. 把代码区理解成能随时搬移整理的普通堆

## 6. 证据清单

- `share/asm/codeBuffer.hpp:331`：CodeBuffer 分 section、最终拼接的总设计
- `share/asm/codeBuffer.hpp:353`：`SECT_CONSTS / SECT_INSTS / SECT_STUBS`
- `share/code/codeBlob.hpp:38`：`CodeBlobType` 五类身份
- `share/code/codeBlob.hpp:71`：CodeBlob 连续布局说明
- `share/code/codeBlob.hpp:103`：`_code_begin / _code_end / _content_begin / _data_end`
- `share/code/codeBlob.hpp:282`：`CodeBlobLayout` 从 header/reloc/content/data 计算边界
- `share/code/codeBlob.hpp:340`：`RuntimeBlob` 起点
- `share/code/codeBlob.hpp:383`：`BufferBlob::is_alive()` 恒真
- `share/code/codeCache.hpp:42`：CodeCache 由多个按类型区分的 CodeHeap 组成
- `share/code/codeCache.hpp:52`：NonNMethod heap 满时的 fallback 说明
- `share/code/codeCache.hpp:61`：segmented code cache 的默认开关条件
- `share/code/codeCache.hpp:259`：编译级别到 `CodeBlobType` 的映射
- `share/code/codeCache.cpp:475`：allocate 前的注释，说明不能让垃圾 CodeBlob 暴露出去
- `share/code/codeCache.cpp:482`：`CodeCache::allocate`
- `share/code/codeCache.cpp:506`：跨 heap fallback 分配逻辑
- `share/code/codeCache.cpp:588`：`CodeCache::commit`
- `share/memory/heap.hpp:84`：`CodeHeap` 基于 `VirtualSpace` 和 segmap
- `share/memory/heap.hpp:154`：allocate / deallocate / deallocate_tail 接口
- `share/memory/heap.cpp:285`：freelist 优先与 `_next_segment` 顺序切块
- `share/memory/heap.cpp:384`：segmap 设计说明
- `share/memory/heap.cpp:486`：`find_start`
- `share/memory/heap.cpp:493`：`find_blob_unsafe`
- `share/memory/virtualspace.cpp:255`：页对齐预留
- `share/memory/virtualspace.cpp:844`：`VirtualSpace::expand_by`
- `share/runtime/globals.hpp:89`：`ReservedCodeCacheSize`
- `share/runtime/globals.hpp:92`：`NonNMethodCodeHeapSize`
- `cpu/x86/globals_x86.hpp:40`：x86 上 `CodeCacheSegmentSize`
- `cpu/x86/globals_x86.hpp:49`：x86 + C2/JVMCI 下 `CodeEntryAlignment = 32`
- `share/code/nmethod.hpp:322`：nmethod 的活性状态边界

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇聚焦“代码如何安家与发布”，不展开 sweeper、deoptimization、AOTCodeHeap 细节
- `CodeEntryAlignment`、`CodeCacheSegmentSize` 含平台差异，正文要说明这是当前平台默认值
- `AOTCompiledMethod` 不在普通 CodeCache 内连续布局，本篇只点边界，不展开
- `nmethod` 的内部字段布局放到下一篇处理

## 8. 完成后 review

- 删除代码后，能否复述“机器码的家其实是一套发布协议”
- 是否清楚推演了至少两个失败方案，而不是直接罗列类名
- 是否明确区分编译期临时态与提交后正式态
- 是否明确区分 runtime blobs 常驻寿命与 compiled methods 可回收寿命
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
