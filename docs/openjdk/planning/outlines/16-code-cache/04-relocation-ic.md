# 04. 代码如何自描述？— Relocation 与 Inline Caches

> 🔴 Deep | 4 KP 中的自描述机制
> 读者处境: GC 移动了对象——嵌在机器码里的 oop 指针怎么自动更新？方法调用怎么从查 vtable 变成直接 call？
>
> ⚠️ 写作期修正(2026-08-12, vol-02/16-code-cache/04 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **位布局错**: "4 type + 12 offset" 是通用格式注释(relocInfo.hpp:75-83);x86-64 有 `format_width=2`(relocInfo_x86.hpp:38-41),实际 **4 type + 2 format + 10 offset**(offset_width=nontype_width-format_width relocInfo.hpp:432),单条最大偏移 1024 字节(offset_limit :344),非 4095
> - **"只用 9 种余量充足"错**: 枚举 0-15 全部有定义(relocInfo.hpp:257-275:none/oop/virtual_call/opt_virtual_call/static_call/static_stub/runtime_call/external_word/internal_word/section_word/poll/poll_return/metadata/trampoline_stub/runtime_call_w_cp/data_prefix_tag)
> - **"pseudo reloc"→filler**: filler_relocInfo(relocInfo.hpp:458-460)=none+offset_limit-offset_unit,三用途注释 :337-343(跳大段/对齐/禁用);prefix(data_prefix_tag)携带数据,advance_over_prefix relocInfo.cpp:222-237,10 位以内压进前缀本身(:350-352)
> - RelocIterator: 构造 relocInfo.cpp:128-155(_addr 从 content_begin);next() 累积 delta(relocInfo.hpp:569-590 `_addr += addr_offset`);set_limits 顺序推进(:196);用途: oops_do immediate oop(nmethod.cpp:1578-1608,oop_index()==0 relocInfo.hpp:941)、CompiledIC 定位(compiledIC.cpp:196-201)、**sweeper 清 IC**(cleanup_inline_caches_impl compiledMethod.cpp:556-589 遍历 virtual/opt_virtual/static_call 三类);oops_reloc_begin 从 verified_entry_point 起(compiledMethod.cpp:234-240,not_entrant 开头被 jmp 覆盖)
# **CMPXCHG16B 编造**: 无 16 字节原子写;原地补丁=set_destination_mt_safe(nativeInst_x86.cpp:261)写序技巧(①前 2 字节改 jmp rel8 -2 跳自身 ②写后 3 字节位移 ③覆盖前 2 字节;每步 ICache flush "Opteron requires a flush after every write";前提 Patching_lock/safepoint :265-266)
# **ICBuffer 机制**(大纲"先写 stub→cmpxchg 切换"不实): create_transition_stub icBuffer.cpp:172-194=组装(ICStub::set_stub :71-79 写 lea rax,[cached];jmp entry,icBuffer_x86.cpp:52-62)→切换(ic->set_ic_destination(stub) 只改 call 目标)→safepoint finalize(:50-58 写回调用点两字段);桩队列=StubQueue(:112-119,InlineCacheBufferSize=10K globals.hpp:412),满→VM_ICBufferFull(new_ic_stub :120-143)
# NativeInst 行号漂移: NativeCall :156(instruction_size=5,displacement_offset=1 :160-162,set_destination :172-177)/NativeMovConstReg :253(0xB8+REX.W,size=10 :262-269,data/set_data :273-274)/NativeJump :494(0xe9,5)
# IC miss: handle_wrong_method_ic_miss(sharedRuntime.cpp:1421-1434)→handle_ic_miss_helper(:1552,CompiledIC_lock :1575): 静态可绑定→reresolve;mono 路径 compute_monomorphic_entry+set_to_monomorphic;否则 set_to_megamorphic(失败 set_to_clean);返回 verified_code_entry
# 大纲 [x86] "cmp [rsi+8]...call cached_target" 是旧版形态,真实调用点/入口检查见 16-02 ⚠️ 块(movq rax,imm64+call / UEP cmp rax,[rdi+8]);"reloc ~code 10%" 无依据已弃用

### 1. "我身体里的指针在哪？" — relocInfo 压缩编码

场景: 一段 x86 机器码 `mov rax, [rip+12345]` — 这条指令里的 12345 偏移指向一个 Java heap oop。GC 移动这个 oop 后，指令需要更新。

**relocInfo 16-bit 设计** (`relocInfo.hpp:75-80`):
```
16 bits = 4 bits type + 12 bits offset delta
  type (4 bits): 0=oop, 1=IC, 2=call, 3=internal_word, 4=external_word, ...
  offset delta (12 bits): 当前 reloc 对应指令距上一个 reloc 的偏移
```
- 源码: `relocInfo.hpp:75-80` 格式说明 + `relocInfo.hpp:80-90` relocType enum
- 关键设计: 偏移是 delta 编码不是绝对地址——节省一半内存（12-bit delta cover most cases, 超范围的用 prefix entry）。为什么选 16-bit fixed 而非 LEB128? LEB128 压缩率更高(典型 1-2 bytes per entry on short deltas)但访问必须是顺序扫描——GC 遍历时已经顺序访问, 所以优先考虑密度。16-bit fixed 支持 O(1) 索引: entry[i] 的地址 = base + i*2——更快且仍然比 32-bit 压缩 2x
- 关键设计: 4-bit type (最多 16 种类型)——当前只用 9 种, 余量充足。12-bit delta (最大 4095 bytes 偏移)——超过这个范围时插入一个 pseudo reloc(no-op type, offset=0→skip→接着累加)。典型 nmethod 的 reloc entry 数 ≈ code_size/100, 极少需要 pseudo reloc
- [C++: `relocInfo::type()` 提取低 4 bit, `relocInfo::addr()` 累积 delta。存储密度: 典型 nmethod 的 reloc 总大小 ~ code 大小的 10%]

**五种 relocation 类型** (`relocInfo.hpp:62-70`):
```
oop_Relocation:         GC 需要更新的 oop 指针 → [GC 走 oops_do 更新] 
ic_Relocation:          Inline Cache → [调用方类型变化时 patch]
runtime_call_Relocation:运行时 stub 调用 → [call target 可能在 CodeCache compact 时变]
internal_word_Relocation: 内部数据引用 → [oop/metadata/scope data]
external_word_Relocation: 外部数据引用 → [Non-collected 内存引用]
```
- [x86: `NativeMovConstReg` 包装 `mov reg, imm64` — C2 用它加载 oop 常量。RelocIterator 找到这条指令 → 类型=oop_Relocation → GC 时更新 imm64]

**RelocIterator — 按 PC 范围遍历** (`relocInfo.hpp:53`):
- 源码: `relocInfo.cpp:138-170` RelocIterator — 构造时指定 begin/end PC → 按 delta 偏移累积 → 每次 next 返回对应 Relocation
- 用途: GC 的 nmethod::oops_do 对每个 oop reloc→oop->oop_iterate。sweeper 检查 IC→清理指向 zombie nmethod 的 call

### 2. "调用谁？不用每次都查了" — CompiledIC 状态机

场景: `obj.foo()` 在 x86 上编译成 `call [rax+vtable_offset]`。第一次查 vtable 找到实际方法→存起来→后续直接 call 存的地址。

**Clean → Monomorphic → Megamorphic** (`compiledIC.hpp:39-48`):
```
Clean(IC=NULL) ← 初始状态 — 每次查 vtable/itable
    ↓ [首次调用]
Monomorphic(IC=Klass*) ← 存一个 receiver type + 对应 target
    ↓ [收到不同 receiver type]
Megamorphic(IC=CompiledICHolder*) ← 回退到解释器
```
- 源码: `compiledIC.hpp:36-56` 状态机注释

**Monomorphic 的实现 (x86 两个步骤)**:
```
step 1: cmp [rsi+8], cached_klass   // 比较 receiver 的 Klass*
        jne miss                     // 不匹配→miss stub
step 2: call cached_target           // 匹配→直接 call（不走 vtable）
```
- [x86: IC patch 在 x86 上改 5 字节——call 指令的 4 字节位移。CompiledIC_to_compiledIC→比较 Klass → 相同→只改 target → 不同→需要改 Klass+target]
- 关键设计: 为什么两步不合并? 分步的原因——(1) 类型检查(Klass) 和 target 是两个独立的优化决策。Klass 可能不变但 target 变了（C1→C2 recompile with same Klass assumption）。(2) MT: 只改 target 只需要原子写 4 字节（call rel32），改 Klass+target 需要 CMPXCHG16B（16 字节原子操作）

**ICBuffer — MT-safe 的 IC transition** (`icBuffer.hpp`):
- 问题: 一个线程在读 IC(查 Klass)/另一个在写 IC(改 target) → 读到半改的 8 字节数据
- 方案: 改 IC 时先在 ICBuffer 里写好新 stub→ 用原子写(double-word cmpxchg) 切换 IC 指针 → 旧 stub 延迟回收
- 源码: `icBuffer.cpp:103-145` InlineCacheBuffer::create_transition_stub→写 stub→atomic update
- [x86: CMPXCHG8B/CMPXCHG16B 指令 — 原子比较+交换 8 或 16 字节。CompiledIC 的两个字段(cached_klass+cached_target) 在 64-bit 机器上共 16 字节→CMPXCHG16B 原子切换]

**IC miss 路径**:
1. monomorphic IC → cmp 不匹配 → 跳到 miss stub
2. miss stub → 调用 `SharedRuntime::handle_ic_miss()` → 查 vtable
3. vtable 结果与当前 cached type 不同 → 升级到 megamorphic → 存 CompiledICHolder
4. 如果 too many misses → 回退到解释器重新 profiling→可能重新编译

### 3. NativeInst — x86 指令的 C++ 视角

场景: 要 patch IC——在 x86 机器码里找到 call 指令并改写它的 target 偏移。怎么定位这条指令？

**NativeCall** (`nativeInst_x86.hpp:60-90`):
```
NativeCall: x86 call instruction wrapper
  - set_destination_mt_safe(address dest) → 原子改写 4 字节 target 位移
  - destination() → 读取当前 target
  - instruction_size = 5 (call rel32 编码)
```
- [x86: `E8 cd` = call rel32 — 机器码为 E8 + 4 字节有符号偏移。`set_destination(dest, start)` = dest - (start+5) 算出新 rel32。MT-safe 版本: 先用 ICBuffer 写新 call→CMPXCHG16B 原子切换]
- 关键设计: NativeCall 包装了 unsafe 的 x86 汇编操作——不是抽象类而是 raw instruction adapter。每 NativeCall 构造在堆上→不依赖 CodeBlob 边界→可以作用于任何 code 地址（nmethod/stub/buffer 通用）。verify() 方法在 DEBUG 模式检查 opcode=E8 确保没误读到别的指令

**NativeMovConstReg** (`nativeInst_x86.hpp:120-150`):
```
NativeMovConstReg: mov reg, imm64 wrapper (48 B8+reg)
  - set_data(intptr_t data) → 改写 8 字节立即数(oop 指针更新)
  - data() → 读取 8 字节立即数
  - 用于 oop/metadata/constant 的 GC 更新
```

**NativeJump** (`nativeInst_x86.hpp:160-180`):
```
NativeJump: unconditional jmp (E9 cd)
  - jump_destination() → 读取跳转目标
  - set_jump_destination(address dest) → 改写跳转
  - 用于 IC 的 miss stub 跳转
```

---

### 核心悬念

**"Relocation 系统让机器码自描述——GC 遍历 reloc 表更新嵌入的 oop，IC 状态机让动态调用变成静态 cmp+jmp。"** — 但 C2 编译时做的乐观假设(类层次/单实现)可能破裂——这些依赖是什么？下一篇: Dependencies + Deopt。

> → [05-dependencies-deopt.md](05-dependencies-deopt.md)
