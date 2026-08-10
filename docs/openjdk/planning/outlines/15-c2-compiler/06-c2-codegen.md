# 06. Matcher + ADL — DFA 指令选择 → x86

> 🟡 Working | 36815 行 .ad 文件——C2 编译 pipeline 的 40%

场景: C2 Ideal Graph→Matcher→DFA matcher (from `.ad` files)。`x86.ad`(9834)+`x86_32.ad`(13656)+`x86_64.ad`(13325)=36815行——描述每条 x86 指令的 DFA pattern——`match(AddI dst, src1, src2)`→emit `addl reg,reg` or `addl mem,reg`。

**AD 文件** (`x86_64.ad`): define each x86 instruction——`instruct addI_reg_reg(rRegI dst, rRegI src1, rRegI src2) %{ match(Set dst (AddI src1 src2)); format %{ "addl $dst, $src2" %} ins_encode %{ __ addl($dst$$Register, $src2$$Register); } %}`

**Matcher** (`matcher.cpp`): DFA——遍历 Ideal Node→match→machine node (MachNode)。GCM (`gcm.cpp`): Global Code Motion——schedule MachNodes to basic blocks——按执行频率 (frequent first)。

---

### 核心悬念

**"36815 行 .ad 文件——C2 的 40% 行数在这些文件中——描述 x86 ISA 的每条指令——ADL 编译器 (adlc) 编译为 C++ DFA matcher。"** — 下一篇: MacroExpand。

> → [07-c2-macro-intrinsics.md](07-c2-macro-intrinsics.md)
