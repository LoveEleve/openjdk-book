# prompt-01: Debug Info & Metadata — compiled code 的元数据编码系统

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**场景 1: 线上 jstack 无法展开 Compiled 帧**
线上应用崩溃前 jstack 输出出现 `...` 省略号，编译方法栈帧无法展开——因为没有 pcDesc 或 scopeDesc 损坏。运维通过 `jcmd <pid> Compiler.CodeHeap_Analytics` 收集 nmethod 元数据完整性检查。

**场景 2: 去优化（Deoptimization）触发 incorrect ScopeValue 解码**
C2 编译了一个内联多层的 hot 方法，运行时触发 uncommon trap → deoptimize → scopeDesc::decode_body() 从压缩流中读取 ScopeValue，因为 `read_object_value()` 遇到越界偏移 → SIGSEGV，导致 hs_err 中含 PcDesc 和 scope 验证日志。

**场景 3: CDS 归档验证 conflicts**
`-XX:+VerifySharedSpaces` 发现 shared nmethod 的 oopRecorder::find_index() 返回与运行时 `archived nmethod::oop_at()` 不一致的 oop——根源是 relocInfo 的 oop_type 被 CDS randomize 打乱了 `oop_addr_at()` 的查找表。

**Counterfactual**: 如果 debugInfo 不使用压缩流而是扁平数组，每条记录可节省解码时间 (~0.3μs) 但元数据体积膨胀 ~2.5×，CodeCache 压力大增。

---

## §一 Task + Narrative + Beginner Callouts

**任务**: 生成 `01-Debug-Info-Metadata.md`，覆盖编译器元数据子系统——ScopeDesc、PcDesc、DebugInformationRecorder、relocInfo、compressedStream、oopRecorder——的深度分析。

**叙事线索**: 以 "编译器生成一条 safepoint → 调试信息记录 → nmethod 打包" 为时间线，串起 debugInfoRec → pcDesc → relocInfo 的全流程：
```
Compiler.o → describe_scope → DebugInformationRecorder::describe_scope()
  → DebugInfoWriteStream::write_handle() → CompressedWriteStream
  → debugInfoRec.cpp::add_new_pc_offset()
  → copy_to(nmethod) → nmethod::scopes_data_begin()
  → PcDesc::scope_decode_offset()
  → ScopeDesc(CompiledMethod*, decode_offset)
  → debugInfoReadStream::read_method() / read_bci() / read_object_value()
```

**7 个 Beginner Callout**（每个用 `> **Callout N — 标题**: 正文` 格式，**全部嵌入 §一**）：
1. **为什么需要 debugInfoRec** — 编译器在 JIT 时记录 safepoint 处的变量/表达式/monitor，用于 GC oop 扫描和 deoptimize 恢复。否则每次 GC 遇到 compiled 帧时找不到哪些寄存器/栈槽是 oop。
2. **PcDesc 不是 PE/ELF 的 PE header** — 是 "PC → scope decode offset" 的 4 字段 compact struct (16 字节)
3. **CompressedStream 不是 zlib** — 是 UNSIGNED5 编码（最多 5 字节表示 32-bit int），跟 J2SE Pack200 相同
4. **relocInfo 不是 ELF relocation** — 是 nmethod 内 metadata section 的 "数据块索引表"（8 种类型，每种编码不同长度的 offset/data）
5. **ScopeValue 类型多态** — 7 种子类（Location/ConstantInt/Long/Double/OopRead/OopWrite/Object），通过虚函数 `write_on()`/`read_from()` 序列化
6. **oopRecorder 双模** — find_index() 用于共享 oop（同一 java mirror 只存一次），allocate_index() 用于唯一 oop（每次分配新建索引）
7. **SLEB128 符号编码** — CompressedStream 使用 SIGNED5 编码（基于 Pack200），零值 1 字节，大值最多 5 字节

---

## §二 Standard Environment

**Source roots** — 所有引用均从项目根开始：
```
/data/workspace/openjdk-cut-new/
├── make/hotspot/lib/CompileJvm.gmk:153          # BUILD_LIBJVM
└── src/hotspot/share/code/
    ├── debugInfo.hpp/cpp                         # ScopeValue 层次 + DebugInfoRead/WriteStream
    ├── debugInfoRec.hpp/cpp                      # DebugInformationRecorder
    ├── scopeDesc.hpp/cpp                         # ScopeDesc + SimpleScopeDesc
    ├── pcDesc.hpp/cpp                            # PcDesc (12/16 字节)
    ├── oopRecorder.hpp/cpp                       # ValueRecorder<oop/Metadata>
    ├── compressedStream.hpp/cpp                  # UNSIGNED5 压缩编码
    ├── relocInfo.hpp/cpp                         # relocInfo 类型系统 (8 种)
    └── location.hpp/cpp                          # Location (寄存器/栈偏移)
```

**Build command**:
```bash
bash configure --with-debug-level=slowdebug --with-native-debug-symbols=internal
make jdk
```

**Binary**: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so`

**Syscall 速查表** (本文档覆盖的 debug info 子系统不直接调用 syscall，但 oopRecorder 依赖 nmethod 的 `oops_begin()` 间接引用 `memcpy(3)` 打包 oop 表)：

| Syscall | man | 用途 | 场景 |
|---------|-----|------|------|
| `memcpy(3)` | `man 3 memcpy` | 打包 oop 表到 metadata section | oopRecorder::copy_to() |

**全局状态** (编译器阶段，在 nmethod 生成前):

| 变量 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `_recording_non_safepoints` | const bool | debugInfoRec.hpp:162 | 是否记录 non-safepoint scope |
| `_all_chunks` | GrowableArray<DIR_Chunk*> | debugInfoRec.hpp:169 | scope 描述块链表 |
| `_pcs` / `_pcs_length` | PcDesc[] / int | debugInfoRec.hpp:178-180 | PcDesc 数组 + 长度 |
| `_oop_recorder` | OopRecorder* | debugInfoRec.hpp:166 | oop 索引记录器 |
| `_position` | int | compressedStream.hpp:37 | 压缩流当前位置 |
| `_hands` | GrowableArray<T>* | oopRecorder.hpp:74 | oop 句柄 + 索引映射 |

---

## §三 Source Files Table

| File | Full Path | Lines | Core Constructs | Role |
|------|-----------|:-----:|----------------|------|
| debugInfo.hpp | src/hotspot/share/code/debugInfo.hpp | 304 | ScopeValue, LocationValue, ObjectValue, ConstantIntValue, MonitorValue, DebugInfoReadStream, DebugInfoWriteStream | 调试信息值类型系统 + 流读写 |
| debugInfo.cpp | src/hotspot/share/code/debugInfo.cpp | 289 | read_from(), write_on() 虚函数实现, serialize | 值类型序列化/反序列化 |
| debugInfoRec.hpp | src/hotspot/share/code/debugInfoRec.hpp | 211 | DebugInformationRecorder, DIR_Chunk, describe_scope() | 编译期间调试信息收集器 |
| debugInfoRec.cpp | src/hotspot/share/code/debugInfoRec.cpp | 441 | describe_scope(), copy_to(), end_scopes(), serialization | 调试信息记录完整实现 |
| scopeDesc.hpp | src/hotspot/share/code/scopeDesc.hpp | 137 | ScopeDesc, SimpleScopeDesc, decode_body() | 内联帧解码器 |
| scopeDesc.cpp | src/hotspot/share/code/scopeDesc.cpp | 259 | ScopeDesc构造, decode_body(), sender(), locals()/expressions()/monitors() | scope 树遍历 |
| pcDesc.hpp | src/hotspot/share/code/pcDesc.hpp | 99 | PcDesc, _pc_offset, _scope_decode_offset, flags bitmask | PC→Scope 映射条目 |
| pcDesc.cpp | src/hotspot/share/code/pcDesc.cpp | 63 | PcDesc构造, real_pc() | PcDesc 构造与 real_pc 计算 |
| oopRecorder.hpp | src/hotspot/share/code/oopRecorder.hpp | 260 | ValueRecorder<T>, allocate_index(), find_index(), copy_to() | oop/metadata 索引器 |
| oopRecorder.cpp | src/hotspot/share/code/oopRecorder.cpp | 204 | add_handle(), maybe_find_index(), copy_to() | oop 索引实现 |
| compressedStream.hpp | src/hotspot/share/code/compressedStream.hpp | 160 | CompressedStream, CompressedReadStream, CompressedWriteStream, UNSIGNED5 | 压缩编码协议 |
| compressedStream.cpp | src/hotspot/share/code/compressedStream.cpp | 252 | read_int(), write_int(), encode_sign(), decode_sign() | Pack200 UNSIGNED5 实现 |
| relocInfo.hpp | src/hotspot/share/code/relocInfo.hpp | 1394 | relocInfo, 8 种 relocType, 数据段编码格式 | 重定位信息类型系统 |
| relocInfo.cpp | src/hotspot/share/code/relocInfo.cpp | 991 | find_reloc(), relocInfo_iter, relocation decode | 重定位查找与解码 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 DebugInformationRecorder::describe_scope() 的递归 scope 记录协议

① 编译器必须按什么顺序调用 debugInfoRec？`add_safepoint(pc, oopmap) → create_scope_values(locals) → create_scope_values(expressions) → create_monitor_values(monitors) → describe_scope(pc, method, bci, ...) → end_safepoint(pc)`（见 `debugInfoRec.hpp:46-61` 注释）。为什么最外层 scope 先 describe、最内层 scope 最后 describe？因为 deoptimize 时 ScopeDesc::sender() 从最内层出栈逐级恢复到 caller。

② (Counterfactual) 如果编译器可以用无序调用 describe_scope（比如先 describe 内层再外层），debugInfoRec 需要一棵语法树而非线性流——scope decode 需要树遍历而非简单 `read_int()` 跳过。HotSpot 选择有序描述是空间优化（避免存 parent offset）但约束了编译器实现。

③ 子问题: DIR_Chunk 的 `_next_chunk` / `_next_chunk_limit`（debugInfoRec.hpp:170-171）的滑块分配模型是如何工作的？为什么不用 malloc 逐条分配（内存碎片、分配器锁竞争、GC 友好性）？

### 4.2 ScopeValue 的 7 种子类型多态序列化

① ScopeValue 有 7 种子类：LocationValue, ConstantIntValue, ConstantLongValue, ConstantDoubleValue, ConstantOopWriteValue, ConstantOopReadValue, ObjectValue（debugInfo.hpp:47-234）。read_from() 使用 `read_int()` 的第一个字节作为 tag 区分类型（debugInfo.cpp 约 line 45-65）。为什么不用 RTTI（`dynamic_cast`）而是用显式 tag？因为编译后 metadata section 不包含 C++ typeinfo 表。

② (Counterfactual) 如果用 protobuf 风格的 `field_number + wire_type + value` 编码替代现在的 tag + read_from() 虚函数，每个 scope 增加 1-2 字节 tag 但支持向后兼容的 schema 演化。但 HotSpot 不需要跨版本兼容（nmethod 只在本进程内使用），所以选择更紧凑的自描述编码。

③ 子问题: ObjectValue 描述逃逸分析消除的对象（debugInfo.hpp:96-141），为什么需要 `_id` 和 `_visited` 字段？ObjectValue 在 scope 池中可能出现多次（同一对象被多个内联方法引用），`_id` 去重避免重复描述字段。

### 4.3 pcDesc 的二分查找：PC → scopeDesc 的 O(log n) 映射

① `CompiledMethod::pc_desc_at(address pc)` 在 PcDesc[] 数组中使用二分查找定位（pcDesc.hpp:34 描述 PcDesc 结构体）。为什么 PcDesc 使用顺序 `_pc_offset` 排序而非哈希表？nmethod 的 PcDesc 从低 pc 到高 pc 自然有序（编译时 safepoint 按代码顺序生成），二分 O(log n) 够快（典型 50-200 个 safepoint，~7-8 次比较）。

② (Counterfactual) 如果用哈希表（pc_offset → scope_decode_offset），查找 O(1) 但增加 ~50% 内存（哈希桶 + 冲突链表），且哈希碰撞使最坏情况退化到 O(n)。对于 nmethod 的 metadata section 空间比时间更宝贵的场景，二分是正确选择。

③ 子问题: PcDesc 的 flags 字段用 4 个标志位（reexecute, is_method_handle_invoke, return_oop, rethrow_exception，见 pcDesc.hpp:42-46）紧凑编码。为什么不在 PcDesc 中存完整的 `Method*` 而是通过 `scope_decode_offset` 间接引用？节省 8 字节/PcDesc（64-bit 下指针是 8 字节 vs 4 字节 offset）。

### 4.4 CompressedStream 的 UNSIGNED5 编码

① UNSIGNED5 编码基于 J2SE Pack200 规范（compressedStream.hpp:39-44, 70-80）：值 [0..191] 编码为 1 字节，值 [192..255] 表示高字节，后面跟低字节。最多 5 字节表示任何 32-bit int。为什么是 192/64 的分割点？Pack200 经验数据表明 Java class 文件中大部分整数偏移 < 192，使编码效率最优。

② (Counterfactual) 如果使用 LEB128（DWARF 调试格式使用的变长编码），对小值（0-127）1 字节、中等值 2 字节——对 Java 方法的 safepoint 偏移（通常 < 500）更省空间（2 vs 4 字节）。但 HotSpot 选择 UNSIGNED5 是历史原因（与 Pack200 共享编码器）且对 signed 值的编码更均一（encode_sign/decode_sign 对称）。

③ 子问题: 为什么 `CompressedWriteStream::write_int()` 不使用 `write_signed_int()` 而是分别提供？BCI 编码是 unsigned 但 `-1` 作为 InvocationEntryBci 需要 signed 语义（debugInfo.hpp:286 的 `read_bci()` 使用 `read_int() + InvocationEntryBci`）。

### 4.5 oopRecorder 的 allocate_index() vs find_index() 双模

① ValueRecorder<T> 提供 allocate_index()（总是新建索引，递增）和 find_index()（查找已有索引，无则新建）（oopRecorder.hpp:47-64）。为什么需要双模？栈上的临时 oop（如 JNI local ref）用 allocate_index() 确保每次新分配；类常量（java mirror）用 find_index() 复用索引减少 metadata section 大小。

② (Counterfactual) 如果只用 find_index()（统一策略），临时 oop 会被意外共享：两个不相关的 JNI call 可能返回同一个 oop 的索引，导致 GC 时错误地标记该 oop 为活跃（多一次引用跟踪的 false positive）。

③ 子问题: copy_to(nmethod) 是如何把 oopRecorder 的 `_handles` 数组转换成 nmethod::oops_begin() 的连续内存块的？`memcpy(3)` 把 GrowableArray 线性拷贝到 nmethod metadata section 的 oop 表末尾。

### 4.6 relocInfo 的 8 种重定位类型

① relocInfo 定义了 8 种重定位类型：none, oop_type, metadata_type, internal_word_type, external_word_type, call_type, poll_type, poll_return_type（relocInfo.hpp 约 line 40-80）。每种类型在 metadata section 中的 data 段编码长度不同：oop_type 和 metadata_type 含 2 字节的 oop/metadata index，call_type 含 3-4 字节的 call offset。

② (Counterfactual) 如果不用 relocInfo 而使用 ELF 风格的 `.rela.text`（每个重定位条目含 r_offset + r_type + r_addend = 24 字节），64 个 safepoint 消耗 1.5KB vs HotSpot relocInfo 的约 300 字节（平均 4-5 字节/条）。relocInfo 效率的关键在于 data 段的变长编码和紧凑的 per-type 格式。

③ 子问题: 为什么 poll_type 和 poll_return_type 需要独立类型？safepoint 轮询指令（test %eax, <polling_page>）在 nmethod 入口和循环回边处生成，GC 需要精确知道这些位置的轮询点以暂停线程——poll_return 类型还包含 return address 信息用于 deoptimize 恢复。

---

## §五 Article Structure

```
# 01-Debug Info & Metadata — compiled code 的元数据编码系统

§〇 生产场景 (3 场景 + 反事实)
§一 Source Files Table + 7 Beginner Callout
§二 Standard Environment (CompileJvm.gmk:153 + syscall 表 + 全局状态表)
§三 端到端时间线 — 从 describe_scope 到 scopeDesc 的全流程
  §三.1 add_safepoint → describe_scope → end_safepoint 协议
  §三.2 scopeDesc::ScopeDesc() 构造函数 — 从压缩流解码到 sender() 链
  §三.3 SimpleScopeDesc 的快速路径 (无对象池)
§四 ScopeValue 类型系统精析
  §四.1 7 种子类的 write_on() / read_from() 虚函数表
  §四.2 ObjectValue 与逃逸分析对象的序列化
  §四.3 MonitorValue 的 lock/eliminated 编码
§五 CompressedStream — UNSIGNED5 编码与 Pack200
  §五.1 encode_sign / decode_sign 的有符号处理
  §五.2 编码效率分析 (zero-heavy 分布的优势)
  §五.3 DebugInfoReadStream 与 DebugInfoWriteStream 的高层封装
§六 PcDesc — PC → Scope 的 O(log n) 二分映射
  §六.1 PcDesc 结构体 (16 字节紧凑布局)
  §六.2 find_pc_desc() 的二分查找实现
  §六.3 real_pc() 将 _pc_offset 转为运行时地址
§七 oopRecorder — 编译期 oop/metadata 索引器
  §七.1 allocate_index vs find_index 双模语义
  §七.2 copy_to(nmethod) 的内存打包
  §七.3 nmethod::oops_do() 回溯 oop 表
§八 relocInfo — 8 种重定位类型的紧凑编码
  §八.1 relocInfo 类型枚举 + data 段变长格式
  §八.2 relocInfo_iterator 的遍历引擎
  §八.3 call_type vs oop_type vs metadata_type 差异
§九 边缘场景
  §九.1 scope 深度超限 (JVM 默认 InlineSmallCode=2000 但深度无硬限制)
  §九.2 oopRecorder 容量溢出 (nmethod 最多 oop 数 = 2^16-1)
  §九.3 compressedStream 越界读取 (metadata section 末尾保护)
§十 Counterfactual 对比表 (≥5 个设计决策的反事实)
§十一 GDB 断点验证 (≥7 断言)
§十二 "不要写成→应该写成" 对照表 (≥8 行)
§十三 Cross-Reference
```

---

## §六 Writing Requirements

**源码是证据（20%），原理是正文（80%）**。不要写成源码翻译。

| 不要写成 | 应该写成 |
|---------|---------|
| "debugInfoRec::describe_scope() 接受 9 个参数，分别是 pc_offset, methodH, method, bci, reexecute..." | "describe_scope() 的 9 个参数组成编译器→VM 的闭包协议：pc_offset 定位 safepoint、method+methodH 双引用解决 JIT 期间 GC 移动 method 对象、bci 记录字节码位置、reexecute/rethrow/return_oop 三个 bool 用于 deoptimize 恢复语义（见 `debugInfoRec.hpp:100-110`）" |
| "CompressedReadStream::read_int() 读取 1-5 字节" | "UNSIGNED5 编码的设计假设是 HotSpot debug info 中的整数大部分 < 192（PC offset, BCI, scope depth），所以 1 字节编码覆盖了 ~75% 的整数。Pack200 的数据集验证了这个假设（`compressedStream.hpp:70-80`）" |
| "ScopeValue 有 is_location(), is_object() 等虚函数" | "ScopeValue 不用 RTTI 的原因是：nmethod 打包到 metadata section 后丢失 C++ typeinfo，只能靠自描述 tag（`read_from()` 中第一个 read_int() 区分类型，`debugInfo.cpp~45-65`）。这跟 JVM 不依赖 C++ exception 的哲学一致" |
| "relocInfo 有 8 种类型" | "relocInfo 的类型数（8 种）是最小完备集：call_type 处理直接调用、oop_type 处理 GC root、poll_type 处理 safepoint 轮询。缺少任何一种都会导致 GC 无法找到所有 oop 或 deoptimize 无法恢复栈帧" |
| "PcDesc 包含 pc_offset, scope_decode_offset, obj_decode_offset, flags" | "PcDesc 的 3 个 offset 字段（12 字节）+ 4 位 flags（1 字节）= 16 字节总大小——这是一个 cache-line 友好的设计。如果存 Method* 指针而非 offset，每条 PcDesc 多 4 字节，200 个 safepoint 就多 800 字节——CodeCache 空间宝贵" |
| "oopRecorder::find_index() 先查找再分配" | "find_index() 的双重逻辑（先 maybe_find_index 再 add_handle）确保了 oop 去重但不丢失首次访问的语义——如果只查找不加分配，新 oop 返回 -1 需要上层处理，增加所有调用点的复杂度" |
| "compressedStream 的位置通过 set_position 设置" | "compressedStream 不是 ostream 的 'position()'——它是 metadata section 内的偏移量，编译后冻结。set_position() 只在打包阶段调用，不是运行时操作。这使压缩流是 append-only 的，适合 nmethod 的不可变语义" |
| "debugInfoRec 的内容通过 copy_to 复制到 nmethod" | "copy_to() 不只是 memcpy——它把 scatter 的 DIR_Chunk 链表线性化 + PcDesc[] 排序 + oopRecorder 表打包成连续内存块（`debugInfoRec.cpp` 约 line 300-350）。这个线性化使得 nmethod metadata section 的随机访问（scopeDesc::sender()）可以在 O(1) 偏移完成" |

---

## §七 Output Format

文档格式要求：
- 标题 `# 01-Debug Info & Metadata — compiled code 的元数据编码系统`
- 每节用 `## §X Section-Name` 格式
- 所有技术断言标注 `file:line`
- 代码片段使用 ` ```cpp ` 包围
- Callout 使用 `> **Callout N — 标题**:` 块引用
- Mermaid 图至少 1 张（序列图或类图）
- §十 Counterfactual 对比表：左列"当前实现"，右列"如果相反"，含量化数据

---

## §八 Prohibited（≥8）

1. ❌ 不要列出所有 14 个源文件的每一行代码机械翻译
2. ❌ 不要把 describe_scope() 的 9 个参数逐一解释而不解释其协作语义
3. ❌ 不要忽略 DIR_Chunk 的滑块分配模型（debugInfoRec.hpp:170-171）对 GC 性能的影响
4. ❌ 不要混淆 DebugInfoReadStream 和 DebugInfoWriteStream 的对称编码——read_int 和 write_int 必须是 UNSIGNED5 的逆操作
5. ❌ 不要跳过 ObjectValue 的 `_field_values` 递归描述如何避免循环引用（`_visited` flag）
6. ❌ 不要省略 PcDesc::flags 的 4 位标志如何在 deoptimize 中恢复 execute/return_oop 语义
7. ❌ 不要忽略 relocInfo 的 format() 虚拟函数——每种类型有自己的二进制格式
8. ❌ 不要不解释 compressedStream 的 UNSIGNED5 与 LEB128 的区别（哪个更快/更省空间）
9. ❌ 不要在 §一 外出现 Callout 框（它们必须嵌入在 §一的叙事中）
10. ❌ 不要缺失 ScopeValue::equals() 的比较逻辑对 oop 去重的影响

---

## §九 Required（≥8）

1. ✅ 必须展示 DebugInformationRecorder 的完整调用协议（add_safepoint → describe_scope → end_safepoint）
2. ✅ 必须有 ScopeValue 7 种子类的类图（用 ASCII 或 Mermaid）
3. ✅ 必须包含 PcDesc::real_pc() 的二分查找源码片段（含初始 low/high 设置）
4. ✅ 必须展示 compressedStream 的 encode_sign/decode_sign 位操作公式
5. ✅ 必须有 oopRecorder 的双模 index 分配流程图（allocate_index vs find_index 的分叉）
6. ✅ 必须有 relocInfo 的 8 种类型的 data format 对照表（每种的大小和格式）
7. ✅ 必须包含端到端编码/解码示例：给定一个方法 `int foo(int a, int b) { return a+b; }`，写出它的 ScopeDesc 内容（method, bci, locals=[LocationValue(stack,0), LocationValue(stack,1)]）
8. ✅ 必须提供 >=7 个 GDB 脚本验证点
9. ✅ 必须有 ≥5 个 counterfactual 的反事实讨论
10. ✅ 必须有"不要写成→应该写成"对照表 ≥8 行

---

## §十 GDB Verification（≥7 assertions）

```bash
# 1. 验证 nmethod::pc_desc_at() 的二分查找
(gdb) p nm->pc_desc_at(nm->code_begin() + 0x42)
# 预期输出: {_pc_offset=0x42, _scope_decode_offset=0x120, ...}

# 2. 验证 ScopeDesc 从 pcDesc 解码
(gdb) p PcDesc* pd = nm->pc_desc_at(some_pc); p ScopeDesc(nm, pd->scope_decode_offset(), false, false, false)
# 预期输出: method=0x..., bci=5

# 3. 验证 compressedStream 的 UNSIGNED5 解码
(gdb) p (int)CompressedReadStream(buf, 0).read_int()
# 预期输出: 对应 write_int() 的原始值

# 4. 验证 oopRecorder::find_index() 去重
(gdb) p rec->find_index(some_oop); p rec->find_index(same_oop)
# 两次调用返回相同 index

# 5. 验证 relocInfo 的迭代
(gdb) p relocInfo* r = nm->relocation_begin(); p r->type()
# 预期输出: call_type=1

# 6. 验证 ScopeValue 的类型 tag
(gdb) p ScopeValue::read_from(&stream)->is_location()
# 预期输出: true (当 stream 当前偏移是 LocationValue tag 时)

# 7. 验证 debugInfoRec::pcs_length
(gdb) p nm->compiler()->debug_info()->pcs_length()
# 预期输出: nmethod 中 safepoint 数量

# 8. 验证 DIR_Chunk 链表遍历
(gdb) p DebugInformationRecorder* dir = nm->compiler()->debug_info()
(gdb) p dir->_all_chunks->length()
```
(共计 8 断言)

---

## §十一 与 README 和同组 prompt 的连续性

**与 README 的关系**: README §二 明确本文档覆盖 "Debug Info & Metadata" (9 source files, ~3,500 lines)，拆分方案与 README 一致。

**与 prompt-00 (nmethod) 的关系**: prompt-00 覆盖 nmethod 的宏观布局（三段内存 + 状态机），本文档聚焦 metadata section 的**内部编码格式**——当读者从 prompt-00 知道 "nmethod 有 metadata section" 后，本文档解释 metadata section 里的 scope/oopmap/reloc 数据如何编码和解码。

**与 prompt-02 (Dependencies) 的关系**: prompt-02 分析 nmethod metadata section 中的 Dependencies 子块——本文档分析 DebugInfo + relocInfo 子块。两者互补构成 metadata section 的完整图景。
