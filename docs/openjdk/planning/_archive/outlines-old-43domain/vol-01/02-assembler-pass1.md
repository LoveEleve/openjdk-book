# Assembler（汇编器） — Pass 0+1 探索笔记

> vol-01 · 域 02 · 🔴 A（Hub 升级）| 2026-08-07

## Pass 0: 设计上下文

**关键 git 提交**：
- `3a1be266bb` 8231720: perf regression after 8225653 — 汇编器层的性能极致敏感
- `d147f1198d` 8206075/8208480/8209511: Label 未绑定导致 assert 崩溃 — 三次修复同一类问题，前向引用补丁系统是 bug 高发区
- `9dc882645a` 8254244: TemplateTable::branch 在分层编译下产生死代码 — 汇编器无法知道生成的代码是否可达
- `7d87cb78a0` 8284620: CodeBuffer 的 `_overflow_arena` 内存泄漏 — 分配失败后的清理路径有遗漏
- `7020d6e5ce` 8248901: Signed immediate support 有 bug — x86 立即数的正负号处理出过问题

**演进趋势**：Assembler 本身稳定（x86 指令集不变），但 Label 补丁系统的边界 case 和 CodeBuffer 内存管理是持续的 bug 来源。性能修复说明汇编器是 JIT 的性能瓶颈前沿。

**测试文件**：无独立测试文件（通过 JVM 集成测试验证，如 compiler/ 下的测试套件间接覆盖）。

## Pass 1: 结构扫描

### 继承树
```
ResourceObj
  └─ AbstractAssembler     (share/asm/assembler.hpp:41, 457行)
      ├─ CodeBuffer        (share/asm/codeBuffer.hpp, 673行)
      └─ Assembler         (cpu/x86/assembler_x86.hpp, 9501行 .cpp, 890方法)
          └─ MacroAssembler (cpu/x86/macroAssembler_x86.hpp, 10484行 .cpp, 556方法)
```

### 包结构
```
share/asm/
  assembler.hpp/cpp        — AbstractAssembler, Label (前向引用补丁)
  codeBuffer.hpp/cpp       — CodeBuffer + CodeSection (机器码容器)
  relocationInfo.hpp/cpp   — RelocationInfo (压缩 relocation 数组)

cpu/x86/
  assembler_x86.hpp/cpp    — Assembler (emit_byte/emit_word/emit_int32 → 890 个指令编码方法)
  macroAssembler_x86.hpp/cpp — MacroAssembler (movl/addl/jmp/call → 556 个高层方法)
  register_x86.hpp         — Register/XMMRegister 定义
```

### 架构图
```
调用方（编译器/解释器/StubGenerator）
    │
    ▼
MacroAssembler  (movl/addl/jmp/call — 556 方法)
    │
    ▼
Assembler       (emit_byte/emit_word — 890 编码方法)
    │
    ├─► CodeBuffer          (SECT_INSTS/SECT_STUBS/SECT_CONSTS)
    │      │
    │      └─► RelocationInfo (压缩数组：代码地址→oop/klass/method)
    │
    └─► Label               (前向引用补丁: _patches[4] + _patch_overflow)
```

### 基本元素分解

1. **指令编码器**：`Assembler` 的 `emit_byte/emit_word/emit_int32/emit_int64` 方法——直接往 CodeBuffer 追加字节。890 个方法覆盖 x86 全部指令（`assembler_x86.hpp`）
2. **高层汇编**：`MacroAssembler` 的 `movl/addl/jmp/call/push/pop`——封装常见指令组合，556 个方法（`macroAssembler_x86.hpp`）
3. **前向引用**：`Label` 的 `_patches[PatchCacheSize=4]` + `GrowableArray _patch_overflow`——`jmp(L)` 时 L 未绑定先写占位，`bind(L)` 时回填真实偏移（`assembler.hpp:74-93`）
4. **代码容器**：`CodeBuffer` + `CodeSection`（`SECT_INSTS`/`SECT_STUBS`/`SECT_CONSTS`）——多段地址空间 + `_frozen` 冻结 + `expand_locs()` 扩展（`codeBuffer.hpp:80-97`）
5. **元数据标注**：`RelocationInfo` 压缩数组——`runtime_call_type`/`external_word_type`/`oop_type`——`call_literal()` 写入时同步追加（`relocInfo.hpp:37-56, macroAssembler_x86.cpp:2296`）
6. **寄存器模型**：`Register`/`Address`/`AddressLiteral`——x86 寄存器文件 + 寻址模式（base+index*scale+disp）（`assembler_x86.hpp:354-422`）
7. **调用约定**：`j_rarg*` → `c_rarg*` 偏移映射——Java 参数寄存器故意偏移 1 位与 JNI 对齐（`assembler_x86.hpp:92-108`）

### 标记问题（≥5）

1. **为什么需要 MacroAssembler 这一层？** Assembler 已经有 890 个方法覆盖全部指令——为什么还要在上面加 556 个方法的 MacroAssembler？什么样的指令组合必须封装，什么样的留给调用方自己组合？

2. **Label 的补丁缓存为什么是 4？** `PatchCacheSize=4`——这是经验值还是有理论依据？超出 4 个未绑定引用后走 `GrowableArray` 的性能代价是多少？

3. **CodeBuffer 的三个 Section 分别装什么？** SECT_INSTS 是编译后的方法代码，SECT_STUBS 是什么？SECT_CONSTS 是什么？什么时候段之间需要打洞（slop）？

4. **Relocation 为什么不直接存完整指针？** 用压缩数组（halfword 编码）是为了节省空间——但压缩和解压缩的开销是多少？牺牲了什么精度？

5. **Java 调用约定的偏移映射在不同平台下一致吗？** Windows 只有 4 个 c_rarg，Linux 有 6 个。`j_rarg3` 在 Windows 上是 `rdi`（不在 c_rarg 序列里），在 Linux 上是 `rcx`（c_rarg3）。这对 JNI stub 生成有什么影响？

6. **Assembler::bind 失败在什么情况下会发生？** Label 从来没被绑定但被用了——JDK-8206075 的 assert 崩溃是怎么触发的？前向引用补丁系统的哪些路径可能出错？

7. **emit_byte 追加字节时怎么处理 CodeBuffer 满了？** `expand_locs()` 尝试扩展，但 CodeBuffer 的上限由谁决定？满了之后 Assembler 抛什么信号给调用方？
