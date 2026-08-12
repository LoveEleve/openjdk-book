# 02. 一段编译方法里装了什么？— nmethod 的内部结构

> 🔴 Deep | 5 KP 中的核心数据结构
> 读者处境: C2 花了几百毫秒编译一个方法，生成了几 KB 的机器码。但这不只是机器码——附带了 8 种元数据让 GC、deopt、JVMTI 都能看懂这段代码。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/16-code-cache/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **入口/IC 机制全部重写**(大纲 [x86] 框与"5 字节 IC call stub"均不实): 未验证入口 = C2 的 MachUEPNode(x86_64.ad:1685-1692): `cmp rax,[j_rarg0+8]; jne ic_miss_stub; nops 对齐`——**期望 Klass 在 rax**,由调用方动态调用点传入并存在 `movq rax,imm64` 的立即数里;调用点 = movq rax,imm64(10B)+call(5B)=15B,即 MachCallDynamicJavaNode::ret_addr_offset(x86_64.ad:574-578,CallDynamicJavaDirect :12834);NativeMovConstReg::instruction_size=10(nativeInst_x86.hpp:264);CompiledIC::_value=get_load_instruction(compiledIC.cpp:171-179),set_data/get_data 读写 mov 立即数
> - **非优化单态调用走 entry_point(未验证入口),不是 verified_entry_point**(compiledIC.cpp:492-496 compute_monomorphic_entry: optimized→verified/:495 非优化→entry);只有优化/静态绑定直连 verified_entry
> - IC 状态图 compiledIC.hpp:39-48 ✓ 四态;Megamorphic 走 **VtableStubs 桩**(compiledIC.cpp:218-268)非"走解释器",且缓存值不可靠(注释 compiledIC.cpp:275 "Cannot rely on cached_value");Interpreted 态(c2i 入口+CompiledICHolder)才走解释器(compiledIC.cpp:508-516)
> - **状态机枚举 6 值非 5**: not_installed=-1/in_use=0/**not_used=1**/not_entrant=2/zombie=3/unloaded=4(compiledMethod.hpp:188-197);not_used 实际不被赋值——make_not_used() 直接 make_not_entrant()(nmethod.hpp:342)
> - **make_not_entrant_or_zombie 非原子 CAS**: Patching_lock 互斥+双重检查(nmethod.cpp:1144 起,早退 :1148-1153,锁内复查 :1182-1186);转 not_entrant 时 patch verified entry 5 字节 jmp→handle_wrong_method_stub(:1190-1193);mark_as_seen_on_stack :1212-1214;x86-64 用 8 字节 Atomic::store(nativeInst_x86.cpp:561)
> - 行号漂移: entry_bci 在 **nmethod.hpp:63**(非 :125,is_osr_method :270);set_to_monomorphic 在 compiledIC.cpp:**373-455**(非 :112-131);SECT_CONSTS 枚举在 **codeBuffer.hpp:353-361**(非 :167,16-01 已回填)
> - 布局顺序: 真实为 header→relocation→consts→code→stubs(含 exception/deopt handler,:718-722)→oops 表→metadata 表→scopes 数据→scopes pcs→dependencies→handler table→null check table;偏移链在 nmethod.cpp:685-746(JIT ctor);consts 在 content 区、代码之前(loadConD movsd [constantaddress] x86_64.ad:6076-6085)
> - ScopeDesc 无 `_parent` 指针: 是压缩流里的 `_sender_decode_offset` 链(scopeDesc.cpp:79-86;sender :152-155;is_top :149),PcDesc 字段 pcDesc.hpp:37-39
> - 其余 ✓: nmethod.hpp:91-93 三入口、:95-109 偏移字段(12 个)、:321-325 状态访问(is_in_use=_state<=in_use)、:127-128 Patching_lock、:361-369 oops 索引 0 保留 NULL、:630-669 nmethodLocker(Atomic::inc/dec nmethod.cpp:2035-2049;is_locked_by_vm :438;can_convert_to_zombie nmethod.cpp:999-1007)、compile.cpp:932-937(Verified_Entry=_first_block_size,compile.hpp:608)、output.cpp:89-91(非静态才插 UEP)、UEP nop 注释 x86_64.ad:1696-1697

### 1. "我有三扇门" — entry points 策略

场景: 调一个方法时，JVM 可能已经验证过 receiver 类型——要不要重复验证？

**三个入口** (`nmethod.hpp:91-93`):
```
_entry_point          → 完整入口 — 先检查 receiver Klass 是否匹配预期
_verified_entry_point → 已验证入口 — 跳过 Klass 检查（IC 已确认）
_osr_entry_point      → OSR 入口 — 从解释器跳入编译代码中间位置
```
- 源码: `nmethod.hpp:91-93` + `nmethod.hpp:125` entry_bci(!=InvocationEntryBci → OSR)
- 关键设计: 第一次调用走 entry_point→做 Klass check→发现匹配→把 IC 指向 verified_entry_point→后续调用跳过检查。`entry_point` 开头 5 字节是 IC call stub——patch 后直连。
- [x86: entry_point 的指令：`cmp [rsi+8], expected_klass; jne miss; jmp verified_entry` ——rsi=receiver this, rsi+8=Klass*, expected_klass=嵌入的 64-bit immediate。C2 在 `MachCallJavaNode::ret_addr_offset` 报告这个 IC 偏移]

**IC 与 entry 的关系** (`compiledIC.hpp:36-56`):
- IC 状态 Clean → IC 存 NULL → 走 entry_point 全路径(查 Klass+查 vtable)
- IC → Monomorphic → IC 存正确 Klass → 走 verified_entry_point（只做 cmp+jmp）
- IC → Megamorphic → IC 存 CompiledICHolder → 走解释器
- 源码: `compiledIC.cpp:112-131` set_to_monomorphic→存储 Klass*→写 cmp 指令→同步 IC stub

### 2. "我的八段身" — nmethod 的内部数据结构布局

场景: 一个 nmethod 在内存中不是单纯的机器码——它自带完整的"字典"让自己可以被 GC/JVMTI/deopt 理解。

**nmethod 8 段数据** (`nmethod.hpp:36-53`):

```
[header 结构体]                    — 所有 field (_entry_point, _state, _comp_level...)
[relocation 表]                    — 16-bit relocInfo 压缩流(哪些地址存 oop/IC/call target)
[consts 段: doubles/longs/floats]  — 常量池(地址池+浮点常量)
[oops 表]                          — 嵌入 oop 的索引(GC 需要更新)
[metadata 表]                      — 嵌入 Metadata 的索引(Klass*/Method*)
[code body + exception handler]   — 实际机器码
[debug info: scopes + pcs]         — 内联树+PC→scope mapping(deopt 重建栈帧)
[dependencies + handler table + null check table] — 类层次假设+异常表+隐式空指针表
```

- 源码: `nmethod.hpp:95-109` 各偏移量字段
- 关键设计: 所有段通过 header 内的 8 个 `_xxx_offset` 字段访问——不是独立分配的内存，是同一块连续内存中不同偏移——单一 mmap 块→nmethod 整体释放只需一次 munmap/free block

**consts 段** (`nmethod.hpp:100`):
- 编译时确定的 doubles/longs/floats 常量 → 在 consts 区而不是 code 区——因为机器码用 pc-relative 寻址
- 源码: `codeBuffer.hpp:167` SECT_CONSTS — CodeBuffer 的第一个 section→CodeBlob 的 content 区开头
- [x86: C2 用 `movsd xmm0, [rip+offset]` 加载 double 常量——offset 是 PC-relative，常量放在紧邻 code 之前的 consts 段 → cache-line 友好]

**scopes_pcs 段 — 内联树**:
- `ScopeDesc`: 每个 (pc,bci,method) 三元组——"在这个 PC 位置，执行的是 method 的 bytecode bci"
- `PcDesc`: PC→scope 的映射表——"PC 0x1234 对应 scope S3"
- [C++: scopeDesc 是反向链表——每个 ScopeDesc 有 `_parent` 指针指向调用者(上一内联层)。最外层 caller scope 的 `_parent`=NULL。deopt 时从最内层往外走构建 Java 栈帧]

### 3. "我的生命状态" — 五个状态 + 并发协议

场景: nmethod 活着但在 deopt→不能被调用。GC 要收集它但还不能删。多个线程同时看这段代码——怎么协同？

**五状态机** (`nmethod.hpp:128`):
```
not_installed → in_use → not_entrant → zombie → unloaded
```
- `not_installed`: 构造中——还未 commit 到 CodeCache——没有线程能看到
- `in_use`:   正常服务——可以执行、可以 GC
- `not_entrant`: 不可新进入——deopt 标记、依赖失效、类重定义——但栈上可能还有活跃帧
- `zombie`: 无活跃帧——GC swept 发现——可以回收 CodeCache 空间
- `unloaded`: 已从 CodeHeap 移除——内存已归还 FreeList
- 源码: `nmethod.hpp:321-349`

**并发保护**:
- CodeCache_lock — 保护 CodeHeap allocation + nmethod list 修改
- Patching_lock — 保护 IC 补丁 (`nmethod.hpp:127`)
- _lock_count — nmethodLocker 机制——refcount 防止 others 在它还在用时删除
- stack_traversal_mark — sweeper 验证无活跃栈帧时才标记 zombie

**状态转换触发**:
```
not_installed → in_use:       CodeCache::commit() — nmethod 可以执行
in_use → not_entrant:         make_not_entrant() — uncommon trap/依赖失效/类重定义
not_entrant → zombie:         sweeper 发现 stack_traversal_mark < sweep mark
zombie → unloaded:            NMethodSweeper::sweep() — 归还 CodeHeap 空间
```
- 关键设计: `make_not_entrant_or_zombie` 是原子 CAS——多个线程可能同时触发 deopt，只有第一个成功的做状态转移

**nmethodLocker** (`nmethod.hpp:630-669`):
- RAII 锁——在 unmount_event/stackwalk 等场景中对 nmethod 加 ref count
- lock_nmethod: atomic increment _lock_count
- unlock_nmethod: atomic decrement → 如果变 0 → 可以安全转为 zombie
- [C++: 用 `Atomic::add(1, &_lock_count)` 实现无锁 RCU——锁数计数是 int，溢出风险低（一个方法不会被锁 2^31 次）]

---

### 核心悬念

**"一段编译方法不只是机器码——它自带 8 种元数据段，让 GC 可以更新指针、让 deopt 可以重建栈帧、让 IC 可以直接跳到正确入口。"** — 但代码从生到死怎么管理？下一篇: sweeper 如何判断"这段代码不需要了"。

> → [03-nmethod-lifecycle.md](03-nmethod-lifecycle.md)
