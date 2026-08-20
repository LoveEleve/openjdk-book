# 16-code-cache/04-relocation-ic 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释机器码为什么必须带一张“可更新地址地图”，以及 HotSpot 如何把“知道哪里能改”“怎么改字节”“如何并发安全地切换调用点”拆成 relocation、NativeInst、ICBuffer 三层

## 1. 选题判断

现稿已经有较扎实的事实基础：
- relocInfo 的 16 位编码与类型枚举
- RelocIterator 的顺序遍历
- `CompiledMethod::oops_reloc_begin`
- `NativeCall::set_destination_mt_safe`
- `InlineCacheBuffer::create_transition_stub`

但当前正文偏“从实现层往上堆”。真正该打穿的读者困惑更集中：

**GC 要更新代码里的 oop，运行时要补丁调用点，safepoint 轮询也要被识别——可机器码本身只是一串字节，它怎么知道自己哪些字节代表地址、哪些地址还能改、并发改的时候又怎么避免线程看到半成品？**

进一步说：

**为什么 HotSpot 不把“代码里哪里有地址”硬编码在各处逻辑里，而要专门设计 relocation 流、指令包装类和 IC 过渡桩三层机制？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**HotSpot 不是直接“去代码里找指针再改”，而是把可补丁性拆成三层：relocation 流先给机器码附上一张顺序可解码的地址地图，`NativeInst` 再教运行时怎样精确读写某种指令里的位移或立即数，Inline Cache 切换则在这两层之上再加一层过渡桩，保证调用点在并发补丁时任何时刻都只有旧形态或完整新形态，没有半成品。**

## 3. 总图

```text
编译期
  机器码 + relocation 记录
    └─ 这条指令里埋的是 oop / metadata / 调用点 / poll / 内部地址

运行时读取
  RelocIterator
    └─ 顺序解码：给你一个代码区范围，告诉你哪些位置值得看

运行时改字节
  NativeInst / NativeCall / NativeMovConstReg / NativeJump
    └─ 根据指令格式读写位移、立即数、入口补丁

并发切换调用点
  InlineCacheBuffer
    ├─ 先在桩里组装 (cached_value, entry)
    ├─ 调用点原子改向桩
    └─ safepoint 再把新状态落回调用点本体
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——机器码怎么知道自己身上哪里埋了地址

目标约 1200 字。

- 从 GC 更新 oop、IC 补丁、safepoint poll 识别切入
- 点出机器码自己只是字节流，不带“这是 oop”标签
- 埋主线：可更新性需要地图、读写协议和无中间态切换

### 第二节：两个朴素方案为什么都不行

目标约 1800 字。

必须推演：
1. 需要时临时反汇编整段机器码，现找哪里有地址
2. 直接按已知偏移原地改调用点两个字段，不做中间态保护

结论：
- 运行时不能每次重新猜测语义位置
- 补丁不仅要知道“哪里能改”，还要保证并发线程看不到半成品

### 第三节：relocation 流——为什么先要一张顺序地图

目标约 2200 字。

- `relocInfo` 16 位编码与 delta offset
- x86 的 format 位与多操作数区分
- type 家族按职责分组
- prefix / filler 解决“16 位装不下”和“大跨度无重定位”
- 强调 reloc 记录的是“指令起点语义”，不是子字段裸地址

### 第四节：RelocIterator——为什么顺序解码就够用

目标约 1800 字。

- `_addr += addr_offset` 的累积模型
- `oops_reloc_begin()` 为什么从 verified entry 开始
- GC、IC 清理、调用点定位三类典型消费方
- 解释为什么这里不追求随机索引

### 第五节：NativeInst——为什么有地图还不够，还要懂指令格式

目标约 2100 字。

- relocation 只说“这里有个调用点/常量/地址”，不教你怎么改字节
- `NativeCall`、`NativeMovConstReg`、`NativeJump` 各自负责的字段
- `set_destination_mt_safe` 的自旋栅栏写序
- 路标：这一层解决的是“精确写哪几个字节”

### 第六节：Inline Cache 为什么要多一层过渡桩

目标约 2200 字。

- 调用点同时带 `mov rax, imm64` 和 `call target`
- 两字段不能原子同改
- `InlineCacheBuffer::create_transition_stub`
- `ICStub::finalize` 在 safepoint 落地
- `InlineCacheBufferSize`、队列满时强制 safepoint
- 强调“先切引用，再落数据”的两阶段协议

### 第七节：IC miss——补丁由谁发起、最终如何闭环

目标约 1700 字。

- `CompiledIC::internal_set_ic_destination`
- 过渡态判断 `is_in_transition_state`
- miss 处理只是简述发起者与落点，不展开 SharedRuntime 全流程
- 统一回主线：调用点永远只有旧形态或完整新形态

### 第八节：误解澄清与收网

目标约 1300 字。

至少回答：
1. relocation 是否等于“实际地址表”
2. RelocIterator 是否必须支持随机定位
3. NativeInst 是否只是反汇编工具壳
4. IC 过渡桩是否只是性能补丁
5. safepoint 时落地是否说明运行时过渡态不安全

## 5. 失败方案必须写进正文

1. 运行时临时反汇编猜测哪里有 oop/调用目标
2. 原地同时改调用点的 cached value 与 call target
3. 把 relocation、NativeInst、ICBuffer 三层职责混成一层

## 6. 证据清单

- `share/code/relocInfo.hpp:75`：16 位编码与累积偏移说明
- `share/code/relocInfo.hpp:88`：format 位设计动机
- `share/code/relocInfo.hpp:257`：relocType 枚举
- `share/code/relocInfo.hpp:343`：`offset_limit`
- `share/code/relocInfo.hpp:360`：filler 的三种用途
- `share/code/relocInfo.hpp:569`：`RelocIterator::next`
- `cpu/x86/relocInfo_x86.hpp:30`：x86 的 `offset_unit` 与 `format_width`
- `share/code/compiledMethod.cpp:234`：`oops_reloc_begin`
- `share/code/compiledMethod.cpp:556`：`cleanup_inline_caches_impl`
- `cpu/x86/nativeInst_x86.cpp:250`：MT-safe call patching 总注释
- `cpu/x86/nativeInst_x86.cpp:261`：`NativeCall::set_destination_mt_safe`
- `share/code/compiledIC.cpp:70`：`internal_set_ic_destination`
- `share/code/compiledIC.cpp:132`：`ic_destination`
- `share/code/compiledIC.cpp:142`：`is_in_transition_state`
- `share/code/icBuffer.cpp:50`：`ICStub::finalize`
- `share/code/icBuffer.cpp:71`：`ICStub::set_stub`
- `share/code/icBuffer.cpp:112`：`InlineCacheBuffer::initialize`
- `share/code/icBuffer.cpp:120`：`new_ic_stub`
- `share/code/icBuffer.cpp:145`：`update_inline_caches`
- `share/code/icBuffer.cpp:172`：`create_transition_stub`
- `cpu/x86/icBuffer_x86.cpp:52`：过渡桩的机器码形态

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇聚焦“地址地图与补丁协议”，不深入 deopt 语义和 dependency 策略
- 指令级细节以 x86_64 为例，其他平台只保留边界提醒
- relocation 的消费者很多，本篇只挑 GC、IC 清理、调用点补丁三类主线
- `SharedRuntime` 的 IC miss 解析只点闭环，不扩成运行时解析专题

## 8. 完成后 review

- 删除代码后，能否复述“可更新机器码需要地图 + 读写协议 + 过渡态切换”
- 是否清楚区分 relocation、NativeInst、ICBuffer 三层职责
- 是否至少完整推演了两个失败方案，而不是直接列 API
- 是否明确解释了为什么调用点补丁不能直接原地双写
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
