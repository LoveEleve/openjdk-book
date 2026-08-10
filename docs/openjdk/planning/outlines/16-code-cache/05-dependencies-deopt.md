# 05. 赌错了怎么办？— 依赖、Deopt 与调试

> 🔴 Deep | 5 KP 中的安全网
> 读者处境: C2 编译 `animal.speak()` 时发现只有 Dog 类覆盖了这个方法→直接内联 Dog::speak。但运行时新加载了 Cat 类也覆盖 speak→旧的假设全破。

### 1. "我的赌注是什么？" — Dependencies 的十种假设

场景: C2 编译完一个方法，生成了激进的优化（去虚拟化、内联、静态绑定）。但这些优化基于"类层次不会变"的假设。

**10 种 dep 类型** (`dependencies.hpp:90-180`):
```
✅ 类层次假设:
  unique_concrete_method(m)           // m 只有一个实现→静态绑定
  abstract_with_unique_concrete_subtype(K) // 抽象类只有唯一子类→去虚拟化
  concrete_with_no_concrete_subtype(K)    // 具体类无子类→单态内联
  no_finalizable_subclasses(K)            // 无 Finalizer→跳过 finalizer 寄存器
⚠️ 方法假设:
  evol_declared_methods(K)               // 方法不会被重新定义→inline
  call_site_target_value(callsite, mh)   // invokedynamic 的 target 不变
✅ 类型断言:
  leaf_type(K)                           // 类型为叶子→无子类→单态
  concrete_klass(K)                      // 类为具体类→直接分配
```

**编译时记录** (`dependencies.hpp:320-400`):
- C2 编译时 → ciEnv → Dependencies 对象 → assert_xxx() 记录假设
- assert_unique_concrete_method: "我编译时 m 只有一个实现——如果有新的，我失效"
- 嵌入 nmethod 的 dependencies 段: `nmethod.hpp:106` _dependencies_offset

**运行时验证** (`dependencies.cpp:200-260`):
- 新的类加载 → Klass::add_to_hierarchy → SystemDictionary::notice_modification → DepChange
- `Dependencies::check_all_dependencies(DepChange& changes)`: 遍历所有 nmethod 的 dep → 检查每个是否被 changes 影响
- 关键设计: 不是每次类加载都全局检查——只有受影响的方法/类的 dep 才被检查。用 `DependencySignature` 对 dep bucket 做哈希索引

**dep 失效后果**:
```
dep 匹配失败 → nmethod 标记 not_entrant
  → IC 清理 → 调此方法的 IC 回退到解释器
  → MethodData profiling 重置 → 可能触发重新编译(不同假设)
```
- 源码: `dependencies.cpp:340-372` DepChange::spot_check_dependency_at nmethod→每个 dep 逐一比较→失效→返回 true→上层标记 not_entrant

### 2. "出了事怎么自救？" — Deopt + Uncommon Trap

场景: 栈顶是 C2 代码，但依赖假设在运行时破了——要把 C2 栈帧变回解释器栈帧。

**DeoptimizationBlob** (`codeBlob.hpp:554-634`):
```cpp
DeoptimizationBlob 入口:
  - unpack()                    // 正常 deopt: pc→scope→重建解释器帧
  - unpack_with_exception()     // deopt + 抛异常
  - unpack_with_reexecution()   // deopt + 重新执行(rare trap 修复后可继续)
  - unpack_with_exception_in_tls()  // C1 专用: exception/pc 在 TLS
```
- 源码: `codeBlob.hpp:605-618` 四个入口的实现偏移
- 关键设计: deopt 桩的代码是一段精心编写的手写汇编——不调用 C++ 函数（因为 deopt 发生时可能已经栈溢出）。直接操作 rsp/rbp 重建帧

**unpack 流程**:
```
1. 从 PC 找到 nmethod (CodeCache::find_blob)
2. PcDesc 找到当前 scope (PC→scope mapping)
3. ScopeDesc 递归遍历内联树 (最内→最外)
4. 每层重建一个解释器栈帧:
   - copy bci, method, locals(ScopeValues), monitors
5. 切回解释器继续执行
```
- 源码: `scopeDesc.hpp:38-66` ScopeDesc(CompiledMethod*, address pc) — 在 nmethod 的 scopes_pcs 段中找到对应
- [C++: ScopeValue = {Location, ConstantOopWriteValue, ObjectValue} — Location 编码值在寄存器/栈偏移处，ConstantOopWriteValue 编码常量 oop。deopt 扫描 ScopeValue 数组重建每个 local/expression stack slot]

**Uncommon Trap** (`codeBlob.hpp:642-666`):
- C2 在编译时插入 uncommon_trap——"走到这里说明假设错了"
- 触发 → UncommonTrapBlob → Deoptimization::uncommon_trap
- 报告 MethodData: 增加 `_trap_count[]` → 如果太频繁 → 永久禁用该优化

### 3. "怎么看懂这段代码？" — Debug Info 栈帧反推

场景: JFR 采了一个 stack trace —— PC 指向 C2 代码→要还原成 Java 方法名+行号。

**scopeDesc + pcDesc** (`scopeDesc.hpp:38-100`):
```
ScopeDesc(CompiledMethod* cm, address pc):
  → pcDesc_at(pc)  // 找到 PcDesc
  → decode(stream) // 从 compressed 解密 scope chain
  → 构建 scope 链表: [最内 scope → 中间被内联方法 → 最外 caller]
```
- `scopeDesc.cpp:68-100` decode_body — 从 CompressedReadStream 读出 method/bci/locals/expressions/monitors
- [C++: CompressedReadStream = LEB128 编码读取—7 bit 数据+1 bit continue—小值只需要 1 字节，大值可能需要 3-5 字节]

**PcDesc 格式** (`pcDesc.hpp:40-65`):
```
struct PcDesc {
  int _pc_offset;    // nmethod code 内的偏移
  int _scope_decode_offset; // scope 压缩流的偏移
  int _flags;        // 是否在 deopt 安全点/invoke 返回/prologue 等
};
```
- PcDesc 数组在 nmethod 的 scopes_pcs 段 —二分查找定位 PC → 得到 scope offset

**location.hpp — 值在哪** (`location.hpp:40-90`):
```
Location:
  Where = { on_stack, in_register, invalid }
  Type  = { normal, oop, narrow_oop, narrowoop }
  - 寄存器: _register_number (VMReg)
  - 栈: _stack_offset (sp 相对偏移)
  - 常量: _constant (oop 直接存)
```

### 4. "虚方法调用怎么加速？" — VtableStubs 与 itable dispatch

场景: `list.add(obj)` 接口调用——编译时不知道实际类型。x86 上怎么加速第一个 vtable 查表？

**VtableStubs 架构** (`vtableStubs.hpp` + `vtableStubs_x86_64.cpp`):
```
VtableStub: per (klass+itable_index) 的 stub
  - 编号系统: Number/Name 序列—从 0 递增分配
  - x86_64 实现:
    mov rax, [rcx+klass_offset]        // 加载 receiver Klass*
    call [rax+itable_offset]           // 调 itable/vtable 方法表
```
- [x86: x86_64 的 vtable 调用: receiver (this)=rcx, Klass* 在 rcx+8, vtable[0] 在 Klass+0x118。itable 调用需要先查在 itable 中的 index]

**Monomorphic inline cache 替换**:
- 首次调用: 走 VtableStub → 存 Klass*→下次跳过 vtable 查表
- 存储: CompiledIC::set_to_monomorphic(CompiledICInfo) → IC stub
- [C++: `vtableStubs_x86_64.cpp:106-130` — emit_code 生成实际 stub 指令 → CodeBuffer → VtableBlob → CodeCache::commit]

### 5. "我的缓存用满了吗？" — CodeHeap State Analytics

场景: 生产环境 CodeCache 接近上限——需要知道哪些方法占了最多空间，碎片化程度如何。

**CodeHeap State Analytics** (`codeHeapState.hpp`):
```
aggregate(granularity):
  - 按 size bucket 统计 blob 数量
  - 按 age bucket 统计(新编译 vs 长期存在)
  - 碎片分析: free blocks 数量/总 free size/最大连续 free block
  - 按名称分组: C1/C2/JVMCI 各编译器占比
```

**DCmd 接口** (`codeCache.hpp:208-210`):
```
jcmd <pid> Compiler.CodeHeap_Analytics [granularity]
  → aggregate_detail → 按 size/age/name 输出三个矩阵
```
- 源码: `codeHeapState.cpp:150-450` aggregate→遍历所有 CodeHeap→遍历每个 nmethod→统计

---

### 核心悬念

**"C2 编译时在代码中嵌入了依赖(类层次假设)+重定位(oop/IC/call)+调试信息(scope)+deopt 桩(unpack)——这些是 '代码的源代码'——让优化可以激进、出错可以恢复、GC 可以移动对象。"** — 下一篇: Group 6 下一域 — Threads(域 17)。

> → 域 17 Threads
