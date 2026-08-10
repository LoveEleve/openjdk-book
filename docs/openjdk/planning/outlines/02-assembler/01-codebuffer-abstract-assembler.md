# 01. CodeBuffer + AbstractAssembler — JIT 怎么生成可用的机器码？

> 🔴 Deep | 15 KP 中的 3 个基础设施机制
> 读者处境: JIT 编译了 Java 方法——然后呢？生成的机器码放哪、怎么打补丁？

### 1. CodeBuffer 三段布局 — code / stubs / consts 分离

**三节结构** (`codeBuffer.hpp:73-370`):
- sect_code: JIT 生成的指令 (Java 方法 body) — 需要 CodeEntryAlignment (32B, icache line)
- sect_stubs: 异常/deopt stub — 与主代码相邻，short jump 可达
- sect_consts: OOP 常量表、浮点表 — GC 可见 (oop_reloc)
- locator: 16+16=32 位编码 (高16位=section tag, 低16位=节内偏移) (`codeBuffer.hpp:160`)
- [x86: icache line = 64B — 对齐到 32B (一半 cache line) 减少 icache miss。section 间对齐用 `CodeBuffer::finalize()` 插入 NOP 填充]

**CodeBuffer 扩展** (`codeBuffer.cpp:136-198`):
- 初始 seed: 1KB/方法 → 5% 缓冲 → JIT 填充
- 溢出 → C2 bail out → fallback 到 C1 或解释器
- [C++: CodeBuffer 内部用 `BufferBlob` (CodeCache 中的连续内存)。sizeof(CodeBuffer) ~200B 在栈上——只持有指针向 BufferBlob 的内容]

**NOP 填充优化** (`codeBuffer_x86.hpp`):
- 1B nop → 多字节最优序列 (Intel optimization manual 推荐: 3B=0F 1F 00, 4B=0F 1F 40 00 等)
- [x86: NOP 不光占位——x86 有 17 种不同长度的 NOP 编码。最佳选择是按长度选编码: 2B=66 90, 3B=0F 1F 00, 4B-9B=0F 1F 40/44/80/84 00。减少 decoder 的压力]

### 2. AbstractAssembler — 平台无关的汇编接口

**抽象层干吗？** (`assembler.hpp:147-194`):
- `pc()` / `offset()`: 返回当前汇编位置——独立于 x86/ARM
- `code_section()`: 切换到不同 section 汇编 (stubs→code→consts)
- `emit_int8/16/32/64`: 原始字节发射——自动递增 pc (`assembler.inline.hpp:37`)
- [C++: inline 函数在 header 中定义——emit_int8 内联为 1 条 C++ 语句→1 条 x86 mov 指令。不使用虚函数——避免 C++ virtual dispatch 开销在每条指令发射时]
- `relocate()`: 在当前位置插入 relocation 标记 (`assembler.inline.hpp:72`)

**delayed_nop — 最重要的设计** (`assembler.hpp:194`):
- JIT 生成 forward jump 时不知道目标地址——需要预留 5-8 字节
- x86 jmp 可以是 2B (jmp rel8) 或 5B (jmp rel32) 字节——只有目标 resolve 后才知道用哪种
- delayed_nop: 占位，不 commit 指令，等目标 resolve → 回填正确的编码
- [x86: jmp rel8 范围= -128~+127, jmp rel32 范围= ±2GB。JIT 先在内部 buffer 记录"这里有 jump 指向 Label L"，L bind 后遍历补丁列表回填偏移——这是 Label 系统的 core use case]

### 3. Label 系统 — 前向/后向分支的补丁

**Label 三状态** (`assembler.hpp:212-236`):
- unbound: 刚创建，无地址
- patched: 一个链表——所有引用这个 label 的指令位置串在一起
- bound: `bind(loc)` → 所有 patched 位置一次性 resolve

**补丁链** (`assembler.hpp:218`):
- `link_to(addr)`: 新引用加入 patched 链
- 为什么用链表？→ 多条 forward jump 指向同一个未 resolve 的 label——链表存每个待补丁位置的 offset，bind 时遍历

---

### 核心悬念

**"JIT 怎么在生成代码时还不知道目标地址的情况下继续工作？"** — delayed_nop 占位 + Label 链表存所有 forward reference → target resolve 后全部回填。CodeBuffer 三节分离让 GC 能看到常量、异常 stub 在主代码附近。下一章: x86 的 ModR/M→REX→VEX→EVEX——为什么一条指令需要这么多前缀？

> → [02-x86-register-operand-encoding.md](02-x86-register-operand-encoding.md)
