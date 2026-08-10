# 17-VTable-IC-Compiler-Infra — 编译底座：vtable stub 缓存 + IC buffer + CompileCommand + nmethod 依赖跟踪

> **Phase**: 01-jvm-startup
> **前置**: [01-CodeCache]（vtable stub 在 CodeCache 中）、[10-JNIHandle-CompileQueue-JVMTI]（CompileQueue）、[15-StubRoutines-SharedRuntime]（resolve blob）
> **配套**: [14-Interpreter]（invokevirtual/invokeinterface 字节码）
> **阅读收益**: 追踪 init_globals 中编译底座的 4 个调用——理解 vtableStubs 的 256 槽哈希表（N=256 编译期常量）+ chunk_factor=32 bump-pointer 批量分配（VtableBlob 在 CodeCache 内，非 C-Heap）+ code_size_limit first→observed 自适应迭代机制 + _ame_offset/_npe_offset 异常偏移供 JVMTI 定位；IC buffer 的 10KB C-Heap StubQueue + InlineCacheBuffer_lock + sentinel stub + 三种 IC 形式（单态/双态/多态）及 ICStub→VM_ICBufferFull→回填的完整过渡路径；compilerOracle 的 CompileCommand/CompileOnly 解析 + .hotspot_compiler warning；DependencyContext 的 4 PerfCounter nmethod 依赖跟踪；x86_64 平台上 vtable/itable stub 的完整机器码生成流程（load_klass→vtable lookup→jmp / 两步 lookup_interface_method→jmp）；掌握"虚方法调用如何缓存分派桩"和"CompileCommand 为何不生效"的诊断路径

---

## §〇 Production Scenario

### 场景 1: 虚方法调用触发 `vtable_index` 越界

```java
interface Service { void execute(); }
class Impl1 implements Service { public void execute() { ... } }
class Impl2 implements Service { public void execute() { ... } }
Service s = new Impl2();
s.execute();  // invokeinterface → itable lookup
```

`invokeinterface` 指令需要从 itable（接口方法表）中查找 `execute()` 的 Method*。itable 在 `universe_post_init()` 中通过 `reinitialize_itables()` 构建，但 `vtableStubs_init()` 创建了 256 槽哈希表用于缓存虚方法分派的桩代码。如果 `_receiver_location`（接收者寄存器位置）设置错误 → itable 查找到错误偏移 → 跳转到错误方法 → `AbstractMethodError` 或 SIGSEGV。

**三步诊断**：
```bash
# 1. 验证 vtableStubs 哈希表已创建
gdb -ex "break vtableStubs.cpp:299" \
    -ex "run" \
    -ex "print VtableStubs::_table[0]" \
    --args java -jar app.jar
# 期望: _table 非 NULL（已分配 256 个槽位，初始全部 NULL）

# 2. 验证 receiver 寄存器位置
gdb -ex "print VtableStub::_receiver_location" \
    --args java -jar app.jar
# 期望: rcx（x86_64 C2 约定）
```

**反事实**：如果没有 vtableStubs 哈希表 → 每次虚方法调用都需要遍历 vtable（O(vtable_size)）→ 每个 invokevirtual 增加 ~10 次内存访问。vtableStubs 缓存已生成的桩代码 → O(1) 哈希查找 → ~1 次内存访问。

### 场景 2: `-XX:CompileCommand` 配置不生效

```bash
java -XX:CompileCommand=exclude,com/example/Foo.bar -jar app.jar
# Foo.bar 仍然被 JIT 编译——CompileCommand 未生效
```

`compilerOracle_init()` (`compilerOracle.cpp:767`) 解析 `-XX:CompileCommand` 和 `-XX:CompileOnly` 参数。如果参数格式错误（如方法签名不匹配），`parse_from_line()` 解析失败但无错误提示 → 编译策略未应用。如果同时指定了 `.hotspot_compiler` 文件但未使用 `-XX:CompileCommandFile` → 文件被忽略并输出 warning。

### 场景 3: IC buffer 满导致 inline cache 更新失败

```
# JVM warning: ICBuffer full
```

`InlineCacheBuffer_init()` (`icBuffer.cpp:167`) 创建 10KB 的 `StubQueue` 用于存储 inline cache 更新 stub。当大量方法同时触发 IC 更新（如大规模反射调用或动态代理）→ IC buffer 可能填满 → 后续 IC 更新失败 → 方法调用回退到解释器 → 性能骤降。

---

## §一 ★★★ 编译底座 4 调用全链路源码走读

### 1.1 Interview Story Format Answer

"`vtableStubs_init()` at `vtableStubs.cpp:299` (3 lines) delegates to `VtableStubs::initialize()` (11 lines, :124-134) which sets `VtableStub::_receiver_location = SharedRuntime::name_for_receiver()` — the register that holds the receiver object during virtual dispatch (rcx on x86_64). It then initializes `_table[0..N-1]` — a hash table of `VtableStub*` pointers, N=256 (compile-time constant, not CodeCache-based). Each slot caches a generated vtable dispatch stub (a small code fragment that indexes into the vtable and jumps to the target method). `InlineCacheBuffer_init()` at `icBuffer.cpp:167` (3 lines) delegates to `InlineCacheBuffer::initialize()` (6 lines, :112-117) which creates `_buffer = new StubQueue(new ICStubInterface, 10*K, InlineCacheBuffer_lock, "InlineCacheBuffer")` — a 10KB StubQueue in C-Heap (NOT CodeCache!) protected by `InlineCacheBuffer_lock`. `init_next_stub()` creates a sentinel stub to mark the start. `compilerOracle_init()` at `compilerOracle.cpp:767` (22 lines) parses `CompileCommand` (e.g., `exclude,com/example/Foo.bar`) and `CompileOnly` (e.g., `com/example/*`) from the command line via `parse_from_string()`. If no command file is specified, it checks for the default `.hotspot_compiler` file and issues a warning if found but not loaded. It also validates print commands against `PrintAssembly` and `DebugNonSafepoints` flags. `dependencyContext_init()` at `dependencyContext.cpp:39` (3 lines) delegates to `DependencyContext::init()` (13 lines, :43-55) which conditionally creates 4 `PerfData` counters (if `UsePerfData=true`): `_perf_total_buckets_allocated_count` (nmethod buckets allocated), `_perf_total_buckets_deallocated_count` (nmethod buckets deallocated), `_perf_total_buckets_stale_count` (stale buckets), `_perf_total_buckets_stale_acc_count` (accumulated stale). The key architectural insight: these 4 calls collectively build the dispatch infrastructure that sits between the interpreter's bytecode dispatch and the JIT compiler's compiled code — vtable stub caching avoids vtable traversal, IC buffer enables concurrent inline cache updates, CompileCommand gives users control over compilation, and DependencyContext ensures class redefinition invalidates dependent nmethods."

### 1.2 vtableStubs_init() → VtableStubs::initialize() — 256 槽哈希表

`vtableStubs.cpp:299-301` 是外部入口：

```cpp
void vtableStubs_init() {
  VtableStubs::initialize();
}
```

**VtableStubs::initialize()**（`vtableStubs.cpp:124-134`，11 行）：

```cpp
void VtableStubs::initialize() {
  VtableStub::_receiver_location = SharedRuntime::name_for_receiver();
  {
    MutexLocker ml(VtableStubs_lock);
    assert(_number_of_vtable_stubs == 0, "potential performance bug: VtableStubs initialized more than once");
    assert(is_power_of_2(N), "N must be a power of 2");
    for (int i = 0; i < N; i++) {
      _table[i] = NULL;
    }
  }
}
```

**N 的定义**（`vtableStubs.hpp:77-80`）：

```cpp
enum {
  N    = 256,    // size of stub table; must be power of two
  mask = N - 1
};
```

N=256 是编译期常量——不是基于 CodeCache 大小的自适应值。所有槽位初始化为 NULL，运行时首次遇到 vtable_index 时生成 VtableStub 并缓存。

**VtableStubs::hash()**（`vtableStubs.cpp:245-249`）：

```cpp
inline uint VtableStubs::hash(bool is_vtable_stub, int vtable_index) {
  int hash = ((vtable_index << 2) ^ VtableStub::receiver_location()->value()) + vtable_index;
  return (is_vtable_stub ? ~hash : hash) & mask;
}
```

vtable 和 itable 使用互补 hash（~hash vs hash）——防止 vtable stub 和 itable stub 冲突到同一槽位。

**VtableStub 对象布局**（`vtableStubs.hpp:116-140`）：

```cpp
class VtableStub {
  static VMReg _receiver_location;
  VtableStub* _next;          // hash 链指针
  const short _index;         // vtable index
  short _ame_offset;          // AbstractMethodError offset
  short _npe_offset;          // NullPointerException offset
  bool  _is_vtable_stub;      // vtable vs itable
  /* code follows here */     // stub code 紧跟在对象头后
public:
  address code_begin() const { return (address)(this + 1); }
  address entry_point() const { return code_begin(); }
};
```

**追问**：为什么 `_receiver_location` 是 rcx 而非 this 寄存器？→ x86-64 的 C++ ABI 中 this 指针在 rdi——但 JIT 编译器使用自定义的寄存器约定。C2 使用 rcx 传递 receiver，C1 使用 rax。`name_for_receiver()` 返回平台特定的寄存器名称字符串（用于调试），实际的寄存器编号在 sharedRuntime 中定义。

**反事实**：如果 vtableStubs 哈希表使用固定大小 256 而非基于 CodeCache？→ CodeCache 大小可配置（`-XX:ReservedCodeCacheSize`）。但实际 N=256 就是固定值——是编译期常量，不是 `memory->code_cache_size() / 1M`。固定 256 在大多数场景下够用（hash 碰撞率低），且编译期常量允许编译器优化。基于 CodeCache 的自适应大小（prompt 中的描述）与实际源码不符——实际就是固定的 256。

### 1.3 InlineCacheBuffer_init() — IC 更新缓冲

`icBuffer.cpp:167-169` 是外部入口：

```cpp
void InlineCacheBuffer_init() {
  InlineCacheBuffer::initialize();
}
```

**InlineCacheBuffer::initialize()**（`icBuffer.cpp:112-117`，6 行）：

```cpp
void InlineCacheBuffer::initialize() {
  if (_buffer != NULL) return; // already initialized
  _buffer = new StubQueue(new ICStubInterface, 10*K, InlineCacheBuffer_lock, "InlineCacheBuffer");
  assert(_buffer != NULL, "cannot allocate InlineCacheBuffer");
  init_next_stub();
}
```

**init_next_stub()**（`icBuffer.cpp:106-110`）创建 sentinel stub：

```cpp
void InlineCacheBuffer::init_next_stub() {
  ICStub* ic_stub = (ICStub*)buffer()->request_committed(ic_stub_code_size());
  assert(ic_stub != NULL, "no room for a single stub");
  set_next_stub(ic_stub);
}
```

**ICStubInterface**（由 `DEF_STUB_INTERFACE(ICStub)` 宏生成，`stubs.hpp`）定义了 stub 的虚接口：`initialize()`、`finalize()`、`size()`、`code_size_to_size()`、`code_begin()`、`code_end()`、`verify()`。

**ICStub 类**（`icBuffer.hpp:45-84`）：

```cpp
class ICStub: public Stub {
  int     _size;       // total size of the stub incl. code
  address _ic_site;    // points at call instruction of owning ic-buffer
public:
  void set_stub(CompiledIC *ic, void* cached_value, address dest_addr);
  address code_begin() const { return (address)this + align_up(sizeof(ICStub), CodeEntryAlignment); }
  address code_end() const   { return (address)this + size(); }
};
```

**is_empty()**（`icBuffer.cpp:162-164`）始终保留 sentinel：

```cpp
bool InlineCacheBuffer::is_empty() {
  return buffer()->number_of_stubs() == 1;    // always has sentinel
}
```

**追问**：为什么 IC buffer 在 C-Heap 而非 CodeCache？→ IC update stub 是临时性的——更新 inline cache 条目（修改 call 指令的目标地址）后 stub 即被废弃（`ICStub::finalize()` 回填 IC 后 stub 可被覆盖）。放在 C-Heap 避免占用 CodeCache 的宝贵空间（NonNMethodCodeHeap 已被解释器 codelet、StubRoutines、resolve blob 占据 ~400KB）。

**反事实**：如果 IC buffer 满了怎么办？→ `new_ic_stub()` 中 `buffer()->request_committed()` 返回 NULL → 触发 `VM_ICBufferFull` VM 操作 → 强制 safepoint → `update_inline_caches()` 回填所有 pending IC → `remove_all()` 清空 buffer → 重新分配。性能影响：IC buffer 满时回退到解释器 ~100ns vs IC hit ~5ns → 20× 慢，但只在 IC buffer 满的短暂窗口内发生。

### 1.4 compilerOracle_init() — 编译指令解析

`compilerOracle.cpp:767-788`（22 行）：

```cpp
void compilerOracle_init() {
  CompilerOracle::parse_from_string(CompileCommand, CompilerOracle::parse_from_line);
  CompilerOracle::parse_from_string(CompileOnly, CompilerOracle::parse_compile_only);
  if (CompilerOracle::has_command_file()) {
    CompilerOracle::parse_from_file();
  } else {
    struct stat buf;
    if (os::stat(default_cc_file, &buf) == 0) {
      warning("%s file is present but has been ignored.  "
              "Run with -XX:CompileCommandFile=%s to load the file.",
              default_cc_file, default_cc_file);
    }
  }
  if (lists[PrintCommand] != NULL) {
    if (PrintAssembly) {
      warning("CompileCommand and/or %s file contains 'print' commands, but PrintAssembly is also enabled", default_cc_file);
    } else if (FLAG_IS_DEFAULT(DebugNonSafepoints)) {
      warning("printing of assembly code is enabled; turning on DebugNonSafepoints to gain additional output");
      DebugNonSafepoints = true;
    }
  }
}
```

**执行流程**：
1. 解析 `-XX:CompileCommand=...` → 逐行调 `parse_from_line()`（支持 exclude/compileonly/inline/print/break/log）
2. 解析 `-XX:CompileOnly=...` → 逐行调 `parse_compile_only()`（仅编译指定类/方法）
3. 如果 `-XX:CompileCommandFile=...` 已设置 → 读文件逐行解析；否则检查 `.hotspot_compiler` 文件 → 存在则 warning
4. 如果有 `print` 命令但 `PrintAssembly` 已开启 → warning；否则自动打开 `DebugNonSafepoints`

**default_cc_file**（`compilerOracle.cpp:684`）：

```cpp
static const char* default_cc_file = ".hotspot_compiler";
```

**追问**：为什么 `.hotspot_compiler` 文件被忽略时需要 warning？→ 用户在项目目录放置 `.hotspot_compiler` 文件期望它被加载——但 JVM 不会自动加载。这是常见的配置错误。warning 提示用户显式使用 `-XX:CompileCommandFile=.hotspot_compiler`。

### 1.5 dependencyContext_init() → DependencyContext::init() — nmethod 依赖跟踪

`dependencyContext.cpp:39-41` 是外部入口：

```cpp
void dependencyContext_init() {
  DependencyContext::init();
}
```

**DependencyContext::init()**（`dependencyContext.cpp:43-55`，13 行）：

```cpp
void DependencyContext::init() {
  if (UsePerfData) {
    EXCEPTION_MARK;
    _perf_total_buckets_allocated_count =
        PerfDataManager::create_counter(SUN_CI, "nmethodBucketsAllocated", PerfData::U_Events, CHECK);
    _perf_total_buckets_deallocated_count =
        PerfDataManager::create_counter(SUN_CI, "nmethodBucketsDeallocated", PerfData::U_Events, CHECK);
    _perf_total_buckets_stale_count =
        PerfDataManager::create_counter(SUN_CI, "nmethodBucketsStale", PerfData::U_Events, CHECK);
    _perf_total_buckets_stale_acc_count =
        PerfDataManager::create_counter(SUN_CI, "nmethodBucketsStaleAccumulated", PerfData::U_Events, CHECK);
  }
}
```

**4 个 PerfCounter**（命名空间 `SUN_CI`，`perfData.hpp` CounterNS 枚举）：

| 计数器 | PerfData 名称 | 含义 |
|--------|-------------|------|
| `_perf_total_buckets_allocated_count` | `nmethodBucketsAllocated` | 分配的依赖桶总数 |
| `_perf_total_buckets_deallocated_count` | `nmethodBucketsDeallocated` | 释放的依赖桶总数 |
| `_perf_total_buckets_stale_count` | `nmethodBucketsStale` | 当前过期桶数（count=0 但未释放） |
| `_perf_total_buckets_stale_acc_count` | `nmethodBucketsStaleAccumulated` | 累计过期桶总数 |

**依赖桶链表结构**：每个 nmethod 通过 `nmethodBucket` 单链表维护依赖关系。`add_dependent_nmethod()`（:89-105）在链表中查找或追加桶；`remove_dependent_nmethod()`（:114-156）递减计数，计数归零时标记为 stale；`expunge_stale_entries()`（:161-193）遍历链表删除 count=0 的桶。

**追问**：为什么依赖跟踪需要 PerfCounter？→ 如果 nmethod 被频繁标记为 not_entrant（依赖破坏）→ `_perf_total_buckets_stale_count` 持续增长 → 说明类重定义或类卸载过于频繁 → 性能问题。PerfCounter 提供量化指标。

**反事实**：如果没有依赖跟踪 → 类重定义（JVMTI RedefineClasses）后，已编译的 nmethod 可能调用旧版本的方法 → 类型系统不一致 → ClassCastException 或静默错误。`DependencyContext::mark_dependent_nmethods()`（:62-81）遍历依赖链表，标记所有依赖旧类的 nmethod 为 deoptimization——下次调用时去优化并重新编译。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/hotspot/share/code/vtableStubs.cpp` — vtableStubs_init() (:299), VtableStubs::initialize() (:124)
- `src/hotspot/share/code/vtableStubs.hpp` — VtableStub 类, VtableStubs 类, N=256 常量
- `src/hotspot/share/code/icBuffer.cpp` — InlineCacheBuffer_init() (:167), InlineCacheBuffer::initialize() (:112)
- `src/hotspot/share/code/icBuffer.hpp` — ICStub 类, InlineCacheBuffer 类
- `src/hotspot/share/compiler/compilerOracle.cpp` — compilerOracle_init() (:767)
- `src/hotspot/share/code/dependencyContext.cpp` — dependencyContext_init() (:39), DependencyContext::init() (:43)

Build: `make jdk`

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **vtableStubs.cpp** | `src/hotspot/share/code/vtableStubs.cpp` | 329 | `vtableStubs_init()`(:299), `VtableStubs::initialize()`(:124) | vtable stub 哈希表 |
| 2 | **icBuffer.cpp** | `src/hotspot/share/code/icBuffer.cpp` | 235 | `InlineCacheBuffer_init()`(:167), `InlineCacheBuffer::initialize()`(:112) | IC update buffer |
| 3 | **compilerOracle.cpp** | `src/hotspot/share/compiler/compilerOracle.cpp` | ~800 | `compilerOracle_init()`(:767) | 编译指令解析 |
| 4 | **dependencyContext.cpp** | `src/hotspot/share/code/dependencyContext.cpp` | 274 | `dependencyContext_init()`(:39), `DependencyContext::init()`(:43) | nmethod 依赖跟踪 |

---

## §四 ★★★ 7 Beginner Callout 框

> **1. vtable vs itable**: vtable（虚函数表）存储实例方法的 Method* 指针——每个类一个 vtable，继承父类 vtable 并追加自己的方法。itable（接口方法表）存储接口方法的 Method* 指针——类实现的每个接口一个 itable。`invokevirtual` 走 vtable，`invokeinterface` 走 itable。VtableStub 的 hash 函数（`vtableStubs.cpp:245`）对 vtable 和 itable 使用互补 hash（~hash vs hash），防止冲突到同一槽位。

> **2. VtableStub 哈希表 N=256**: `_table` 大小 N=256（编译期常量，`vtableStubs.hpp:77`），不是基于 CodeCache 大小的自适应值。每个槽位是一个 `VtableStub*` 指针（8 字节）→ 256 × 8 = 2048 字节。哈希函数：`((vtable_index << 2) ^ receiver_location->value()) + vtable_index`，与 mask=255 取余。VtableStub 对象通过 `operator new` 以 32 个为一组批量分配 VtableBlob（`vtableStubs.cpp:53-78`），code 紧跟在对象头后（`code_begin() = this + 1`）。

> **3. IC buffer 在 C-Heap 而非 CodeCache**: `InlineCacheBuffer::_buffer` 是 C-Heap 分配的 StubQueue（10KB），不是 CodeCache。IC update stub 是临时性的——更新 inline cache 条目后 stub 即被废弃（`ICStub::finalize()` at `icBuffer.cpp:50` 回填 IC 后 stub 可被覆盖）。放在 C-Heap 避免占用 CodeCache 的宝贵空间。`InlineCacheBuffer_lock` 保护并发更新。buffer 始终保留一个 sentinel stub（`is_empty()` = number_of_stubs == 1），保证始终有空间进行下一次 `init_next_stub()`。

> **4. CompileCommand 的三种格式**: `-XX:CompileCommand=exclude,com/example/Foo.bar`（排除方法）、`-XX:CompileCommand=compileonly,com/example/*`（仅编译指定类）、`-XX:CompileCommand=inline,com/example/Helper.help`（强制内联）。还支持 `print`（打印汇编）、`break`（在编译时断点）、`log`（记录编译日志）。多个命令用换行符或空格分隔。`parse_from_string()`（`compilerOracle.cpp:724`）按换行符切分后逐行调用对应的解析函数。

> **5. DependencyContext 的 nmethod 依赖跟踪**: 当 C2 编译方法 A 时，如果 A 内联了方法 B，A 的 nmethod 依赖 B 不被修改（如类重定义）。`DependencyContext` 为每个 nmethod 维护一个依赖桶（nmethodBucket）链表——每个桶有一个原子计数（`Atomic::sub(1, &_count)`），计数归零标记为 stale。`mark_dependent_nmethods()`（`dependencyContext.cpp:62`）遍历链表标记依赖旧类的 nmethod 为 deoptimization。4 个 PerfCounter（`SUN_CI` 命名空间）跟踪桶的分配/释放/过期统计。

> **6. vtable/itable stub 的自适应大小**：`_vtab_stub_size` 和 `_itab_stub_size` (`vtableStubs.hpp:86-87`) 初始为 0，首次生成 stub 时 `code_size_limit()` (`vtableStubs.cpp:137-143`) 返回平台特定的保守估计值——`first_vtableStub_size`/`first_itableStub_size`。PRODUCT 模式下分别为 64/256 字节（`vtableStubs.cpp:101-102`），debug（非 PRODUCT）模式下分别为 1024/512 字节（`vtableStubs.cpp:119-120`，因 `-XX:+DebugVtables` 和 `-XX:+CountCompiledCalls` 增加调试代码）。stub 生成后，`bookkeeping()` → `check_and_set_size_limit()` (`vtableStubs.cpp:146-176`) 将实测 (code_size+padding) 更新为 `_vtab_stub_size`/`_itab_stub_size`——后续所有 stub 使用精确尺寸分配而非保守估计，大幅节省 CodeCache 空间。`-Xlog:vtablestubs=trace` 可观察 "size estimate needed adjustment from X to Y bytes" 的迭代收敛过程。

> **7. _ame_offset 与 _npe_offset**：`_ame_offset`（AbstractMethodError offset）和 `_npe_offset`（NullPointerException offset）记录 stub 代码中可能抛出异常的两条关键指令到 `code_begin()` 的相对偏移（`vtableStubs.hpp:126-127`，初始均为 -1）。x86_64 上：`npe_addr` 标记 `load_klass(rax, j_rarg0)` 指令（`vtableStubs_x86_64.cpp:82-83`）——解引用 receiver 指针隐式做空指针检查，若 receiver==NULL 则触发 SIGSEGV 被 JVM 信号处理器转为 NullPointerException；`ame_addr` 标记 `jmp [rbx+from_compiled_offset]` 跳转指令（:131-132）——当目标 Method* 为 NULL（抽象方法）时跳转到 0 地址触发 SIGSEGV。`set_exception_points()` (`vtableStubs.hpp:153-159`) 计算相对偏移并 assert 验证：`is_abstract_method_error(ame_addr)` 和 `is_null_pointer_exception(npe_addr)` 必须为 true，且两地址互不重合。JVMTI 的 `ExceptionCallback` 通过 `is_null_pointer_exception(epc)` / `is_abstract_method_error(epc)` (`vtableStubs.hpp:176-177`) 在收到异常事件后正确定位 vtable/itable stub 内部的实际抛出位置——若没有这两个偏移字段，JVMTI agent 会错误报告异常发生在 StubRoutines 某处，无法定位到具体虚方法调用。

---

## §五 ★★★ vtable stub 哈希表 + IC buffer

### 5.1 VtableStubs::initialize() 的 _receiver_location + _table 分配

- `_receiver_location = SharedRuntime::name_for_receiver()` — x86_64 返回 rcx（C2 约定）
- `_table = new VtableStub*[256]()` — 全部初始化为 NULL
- 运行时通过 `lookup()`（:252）查找，`enter()`（:261）插入

### 5.2 VtableStub 的哈希函数和碰撞处理

```cpp
inline uint VtableStubs::hash(bool is_vtable_stub, int vtable_index) {
  int hash = ((vtable_index << 2) ^ VtableStub::receiver_location()->value()) + vtable_index;
  return (is_vtable_stub ? ~hash : hash) & mask;  // mask = 255
}
```

碰撞处理：开地址法——每个槽位是链表头，冲突的 stub 通过 `_next` 指针链接。

### 5.3 IC buffer 的 StubQueue 结构 + InlineCacheBuffer_lock

- `_buffer = new StubQueue(new ICStubInterface, 10*K, InlineCacheBuffer_lock, "InlineCacheBuffer")`
- 10KB 环形缓冲区在 C-Heap
- `ICStubInterface` 定义 stub 大小和对齐：`ic_stub_code_size()` 最坏情况 = `2 * NativeMovConstReg::instruction_size + 3`
- 始终保留一个 sentinel stub（`init_next_stub()` 预分配）

### 5.4 ICStubInterface 的 stub 大小和对齐定义

`ICStub::code_size_to_size()`（`icBuffer.hpp`）：

```cpp
static int code_size_to_size(int code_size) {
  return align_up((int)sizeof(ICStub), CodeEntryAlignment) + code_size;
}
```

`ic_stub_code_size()`（`icBuffer_x86.cpp:35`）计算最坏情况：`MAX2(best=lea+jmp, worst=2*lea+3)`。

### 5.5 VtableStub 块分配机制 — bump-pointer + chunk_factor=32

VtableStub 对象不在 C-Heap 分配，而是通过重载的 `operator new(size_t, int code_size)`（`vtableStubs.cpp:53-78`）直接在 **CodeCache** 的 VtableBlob 空间中批量分配。核心机制是 bump-pointer 分配器：

```
_chunk ────────────────────────►  _chunk_end
  │                                    │
  ├── VtableStub[0] ────────────┤      │
  ├── VtableStub[1] ────────────┤      │
  ├── VtableStub[2] ────────────┤      │
  ...                                │
  └── VtableStub[31] ────────────┤    │
      剩余空间 ───────────────────►___│
```

**分配细节**（`vtableStubs.cpp:53-78`）：

```cpp
void* VtableStub::operator new(size_t size, int code_size) throw() {
  const int real_size = align_up(code_size + sizeof(VtableStub), wordSize);
  const int chunk_factor = 32;  // 每批分配 32 个 stub
  if (_chunk == NULL || _chunk + real_size > _chunk_end) {
    const int bytes = chunk_factor * real_size + pd_code_alignment();
    VtableBlob* blob = VtableBlob::create("vtable chunks", bytes);
    _chunk = blob->content_begin();
    _chunk_end = _chunk + bytes;
    Forte::register_stub("vtable stub", _chunk, _chunk_end);
    align_chunk();  // 按 pd_code_alignment() 对齐
  }
  void* res = _chunk;
  _chunk += real_size;
  align_chunk();  // 下次分配已对齐
  return res;
}
```

**chunk_factor=32 的设计理由**：32 是平衡内存浪费与分配频率的工程经验值：
- 每次 `VtableBlob::create()` 调用都通过 `CodeCache::allocate()` 分配内存——涉及 CodeCache 大锁竞争、Blob 头部开销（~16-32 字节/VtableBlob）、以及 NonNMethodCodeHeap 的 `mmap` 可能触发。太频繁的分配 → 锁竞争加剧 + Blob 碎片化
- 批量 32 个一次分配 → 将 CodeCache 交互频率降低 32×
- 如果取 128 或更大 → 空槽浪费（实际上大多数应用产生的 vtable stub 不足 32 个），且 CodeCache 中 VtableBlob 粒度太大不利于回收
- x86_64 `pd_code_alignment() = wordSize = 8`（`vtableStubs.hpp:264-268`），对齐开销极小不改变批次数选择

**反事实**：如果 `chunk_factor=1`（每个 stub 单独一个 VtableBlob）→ CodeCache 产生大量小 Blob 对象 → `CodeCache::allocate()` 调用量 32× → `CodeCache_lock` 争用加剧 + Blob 链表遍历开销 O(n_blobs)。如果 `chunk_factor=256` → 大多数应用浪费数百个 VtableStub 的预分配空间 → CodeCache 中被 VtableBlob 无谓占用 ~1MB+。

### 5.6 _vtab_stub_size/_itab_stub_size — first→observed 自适应迭代

`_vtab_stub_size` 和 `_itab_stub_size`（`vtableStubs.hpp:86-87`）初始化为 0（`vtableStubs.cpp:96-97`），表示"尚未实际测量"。

**首次分配时**，`code_size_limit()`（`vtableStubs.cpp:137-143`）返回预设保守值：

```cpp
int VtableStubs::code_size_limit(bool is_vtable_stub) {
  if (is_vtable_stub) {
    return _vtab_stub_size > 0 ? _vtab_stub_size : first_vtableStub_size;
  } else {
    return _itab_stub_size > 0 ? _itab_stub_size : first_itableStub_size;
  }
}
```

保守值定义（`vtableStubs.cpp:99-121`）：

| 模式 | `first_vtableStub_size` | `first_itableStub_size` | 说明 |
|------|------------------------|------------------------|------|
| **PRODUCT** | 64 | 256 | 无 DebugVtables/CountCompiledCalls |
| **debug (non-PRODUCT)** | 1024 | 512 | 包含调试检查码（如 `bad_compiled_vtable_index` 调用）|

debug 模式下 vtable stub 初始值 1024 比 itable 512 大一倍——因为 `DebugVtables` 在 vtable stub 中插入更多检查代码（如 vtable_index 越界检查的 `call_VM(bad_compiled_vtable_index)`）。

**实测后更新**：stub 生成完毕后，`bookkeeping()` (`vtableStubs.cpp:179-205`) 调用 `check_and_set_size_limit()`（:146-176）：

```cpp
void VtableStubs::check_and_set_size_limit(bool is_vtable_stub, int code_size, int padding) {
  if ( (code_size + padding) > _vtab_stub_size ) {
    _vtab_stub_size = code_size + padding;  // 更新为实测最大值
  }
}
```

更新仅在实测值 **超过** 当前值时发生（单调递增保证后续 stub 不溢出）。`-Xlog:vtablestubs=trace` 日志输出：
```
vtable size estimate needed adjustment from 64 to 132 bytes
itable size estimate needed adjustment from 256 to 336 bytes
```

**追问**：为什么 `_vtab_stub_size` 可能从 64 调整到 >64（即使机器码固定）？→ `check_and_set_size_limit` 的参数 `(code_size + padding)` 包含 `slop_bytes`——汇编器中可变长度指令（如 `cmp` 的 8/32 位立即数变体、`jcc` 的 8/32 位偏移变体）的松驰余量。首次 stub 的 slop_bytes 是所有变长指令的最坏情况差值——后续 stub 从精确实测值分配，不再包含 slop。

**反事实**：如果始终使用保守值（如 debug 1024）而不自适应 → 每个 vtable stub 浪费 ~900 字节（实测 ~120 字节 vs 分配 1024）→ 256 个 vtable stub × 900 = 230KB 无谓浪费。`code_size_limit` 自适应机制确保每个 stub 分配大小精确匹配实际代码 + slop。

### 5.7 InlineCacheBuffer 的三种 IC 形式与状态变迁

Inline cache（IC）是 JIT 编译器优化虚方法调用的核心机制。对于 `invokevirtual` 或 `invokeinterface` 指令位置（call site），编译器根据运行时观察到的 receiver 类型数量产生不同形式的 IC：

**形式 1: 单态（Monomorphic）**——直接 call 目标方法
```
  mov    rbx, <cached_klass_A>       ; 加载缓存的类
  cmp    [rcx + klass_offset], rbx    ; 检查 receiver 类是否匹配
  jne    <resolve_stub>               ; 不匹配 → 去解析
  call   <method_A_entry>             ; 匹配 → 直接调用
```
最简形式——一次类检查 + 直接调用。IC hit 延迟 ~5 个 CPU 周期（1 load + 1 cmp + predicted jmp）。这是最频繁的形式，覆盖 >90% 的调用点。

**形式 2: 双态（Bimorphic）**——两个缓存条目
```
  mov    rbx, <cached_klass_A>
  cmp    [rcx + klass_offset], rbx
  je     <call_A>
  mov    rbx, <cached_klass_B>
  cmp    [rcx + klass_offset], rbx
  jne    <resolve_stub>               ; 两个都不匹配 → 去解析
call_A:
  call   <method_A_entry>
  jmp    <done>
  call   <method_B_entry>
done:
```
两个缓存条目——成本略高但仍直接调用。覆盖 ~8% 的调用点（如两个实现类的接口调用）。

**形式 3: 多态（Megamorphic / vtable dispatch）**——走 vtable stub
```
  load_klass rax, [rcx]               ; 获取 receiver klass
  mov    rbx, [rax + vtable_start + index*8]  ; vtable lookup
  call   rbx                          ; 间接调用
```
不再 cached klass 检查——直接走 vtable stub（vtable 偏移 + 间接跳转）。延迟 ~15-20 个 CPU 周期。覆盖 ~2% 的调用点（如 Spring 的依赖注入代理、大规模 switch-case 调度模式）。

**过渡状态（Transition state）**：当 IC 需要从单态变迁到双态或从双态变迁到多态时，正在运行的 nmethod 不能直接修改 code 段（不是多线程安全的）→ 使用 ICStub 作为过渡：

```
nmethod code (旧 IC)          ICStub (过渡)            CodeCache
┌─────────────────────┐      ┌───────────────┐       ┌────────────┐
│ cmp  [rcx+8], rbx   │      │ lea  rax, [rip]│       │ 新目标方法  │
│ jne  ───────────────┼─────►│ jmp  [dest]    │──────►│ entry      │
│ call <old_dest>     │      │ nop            │       └────────────┘
└─────────────────────┘      └───────────────┘
```

`InlineCacheBuffer::create_transition_stub()` (`icBuffer.cpp:172-194`) 执行：
1. 如果已有旧 stub (`ic->is_in_transition_state()`)，先 `old_stub->clear()` 清理
2. `get_next_stub()` 获取预分配的 ICStub
3. `ic_stub->set_stub(ic, cached_value, entry)` 填充 stub 代码（`assemble_ic_buffer_code()` 生成机器码）
4. `ic->set_ic_destination(ic_stub)` 修改 nmethod 的 call 指令指向 ICStub
5. `set_next_stub(new_ic_stub())` 预分配下一个 stub（可能触发 safepoint→IC 回填）

**完整路径：ICStub → VM_ICBufferFull → update_inline_caches → 回填**：

当 IC buffer 满了（`request_committed()` 返回 NULL），`new_ic_stub()` (`icBuffer.cpp:120-142`) 触发 `VM_ICBufferFull` VM 操作：

```
new_ic_stub() → 发现 buffer 满
  ├→ VM_ICBufferFull ibf;
  ├→ VMThread::execute(&ibf);     // 强制 safepoint
  │    └→ update_inline_caches()  // VM 操作体
  │         ├→ buffer->remove_all()      // 遍历所有 ICStub → finalize() → 回填 nmethod
  │         ├→ init_next_stub()          // 创建新 sentinel
  │         └→ release_pending_icholders()  // 释放 CompiledICHolder
  └→ 回到 new_ic_stub() → retry request_committed()
```

`ICStub::finalize()` (`icBuffer.cpp:50-59`) 回填 nmethod 的 inline cache 条目：
```cpp
void ICStub::finalize() {
  CompiledIC *ic = CompiledIC_at(CodeCache::find_compiled(ic_site()), ic_site());
  ic->set_ic_destination_and_value(destination(), cached_value());
}
```

将 nmethod 的 call 指令更新为直接指向目标方法——从此以后不再走 ICStub 间接跳转。

**追问**：如果 safepoint 中 `update_inline_caches()` 回填后仍有新的 IC 更新？→ 回填后的 buffer 已清空并创建新 sentinel → `new_ic_stub()` 的重试路径（while(true) 循环）会再次尝试分配 → 如果用户线程正经历海量 IC 更新（如类重定义后所有 nmethod 同时去优化），可能反复触发 VM_ICBufferFull，但每次 safepoint 都会回填所有 pending → 最终收敛。

### 5.8 IC 生死周期：从 CompiledIC 到 ICStub 再回到 CompiledIC

追踪一个方法调用从首次编译到 IC 回填的完整生命周期：

```
阶段 1: 方法首次 JIT 编译 (C1 or C2)
  CompiledIC ic;  // call site 的 inline cache 对象
  ic.set_to_monomorphic(klass_A, method_A_entry);
  ─────────────────────────────────────────────

阶段 2: 运行时遇到不同的 receiver 类型 (klass_B)
  // 需要从单态变为双态——但 nmethod 正在其他线程执行
  CompiledIC_lock->lock();
  ic->set_to_megamorphic(&call);  // 临时设为多态走 vtable
  InlineCacheBuffer::create_transition_stub(ic, klass_B, method_B_entry);
  // nmethod 调用现在走 ICStub (在 C-Heap StubQueue 中)
  CompiledIC_lock->unlock();
  ─────────────────────────────────────────────

阶段 3: 下次 safepoint
  // 所有线程暂停 → 安全修改 nmethod code
  VM_ICBufferFull::doit() {
    InlineCacheBuffer::update_inline_caches();  // 回填所有 pending
      ├→ ICStub::finalize()                    // 每个 stub
      │    ├→ CodeCache::find_compiled(ic_site)  // 找到 owning nmethod
      │    └→ ic->set_ic_destination_and_value() // 直接写入新目标
      └→ buffer->remove_all()                  // 清空 StubQueue
  }
  ─────────────────────────────────────────────

阶段 4: nmethod 代码已更新为新 IC 形式
  // ICStub 被清空，StubQueue 重新分配 sentinel
  // 下次调用直接走 nmethod 的新 call 目标——不再经过 C-Heap 间接跳转
```

**反事实**：如果没有 IC 过渡机制（在 safepoint 外直接修改 nmethod code）→ 一个线程在修改 call 指令中间（如只写了一半地址），另一个线程执行到 call 指令 → 跳转到不完整地址 → SIGILL（非法指令）或跳转到错误方法 → 类型系统一致性破坏。ICStub 的过渡方案避免了代码段的非原子修改窗口。

## §六 ★★ CompileCommand + DependencyContext

### 6.1 CompileCommand 的解析流程

```
compilerOracle_init()
  ├→ parse_from_string(CompileCommand, parse_from_line)
  │    └→ 按 '\n' 切分 → 逐行 parse_from_line()
  │         └→ 解析 "exclude|compileonly|inline|print|break|log,class.method"
  ├→ parse_from_string(CompileOnly, parse_compile_only)
  │    └→ 按 '\n' 切分 → 逐行 parse_compile_only()
  ├→ has_command_file()?
  │    ├→ YES: parse_from_file() → fopen → 逐行 parse_from_line()
  │    └→ NO:  stat(".hotspot_compiler") == 0 → warning
  └→ lists[PrintCommand] != NULL?
       ├→ PrintAssembly? → warning (冲突)
       └→ DebugNonSafepoints default? → 自动开启
```

### 6.2 .hotspot_compiler 文件的 warning 机制

```cpp
if (os::stat(default_cc_file, &buf) == 0) {
  warning("%s file is present but has been ignored.  "
          "Run with -XX:CompileCommandFile=%s to load the file.",
          default_cc_file, default_cc_file);
}
```

### 6.3 print 命令与 PrintAssembly/DebugNonSafepoints 的交互

- `print` 命令存在且 `PrintAssembly` 已开启 → warning（冲突，print 命令的输出被 PrintAssembly 覆盖）
- `print` 命令存在且 `DebugNonSafepoints` 为默认值 → 自动开启 `DebugNonSafepoints`（增加 safepoint 间的调试信息）

### 6.4 DependencyContext 的 4 PerfCounter + bucket 链表结构

每个 nmethod 通过 `nmethodBucket` 单链表维护依赖：

```
nmethod A → bucket → bucket → NULL
              |         |
            nm B      nm C
```

`add_dependent_nmethod()` 追加桶，`remove_dependent_nmethod()` 原子递减计数，计数归零时 `expunge_stale_entries()` 删除。`mark_dependent_nmethods()` 在类重定义时遍历标记所有依赖 nmethod。

---

## §七 ★ GDB 断点验证 — 7 断点

```
断言 1: _receiver_location 设置 (vtableStubs.cpp:125)
  (gdb) break vtableStubs.cpp:125
  (gdb) run
  (gdb) print SharedRuntime::name_for_receiver() → 期望: "rcx" (x86_64)

断言 2: StubQueue 创建 (icBuffer.cpp:114)
  (gdb) break icBuffer.cpp:114
  (gdb) continue
  (gdb) print InlineCacheBuffer::_buffer → 期望: 非 NULL StubQueue*
  (gdb) print InlineCacheBuffer::_buffer->total_size() → 期望: 10240

断言 3: CompileCommand 解析 (compilerOracle.cpp:768)
  (gdb) break compilerOracle.cpp:768
  (gdb) print CompileCommand → 期望: 命令行参数值

断言 4: PerfCounter 创建 (dependencyContext.cpp:43)
  (gdb) break dependencyContext.cpp:43
  (gdb) print UsePerfData → 期望: true
  (gdb) continue
  (gdb) print DependencyContext::_perf_total_buckets_allocated_count → 期望: 非 NULL

断言 5: _table 分配 (vtableStubs.cpp:299)
  (gdb) break vtableStubs.cpp:299
  (gdb) continue
  (gdb) print VtableStubs::_table → 期望: 非 NULL
  (gdb) print VtableStubs::_table[0] → 期望: NULL (初始)

断言 6: VtableStub chunk 分配 (vtableStubs.cpp:64)
  (gdb) break vtableStubs.cpp:64
  (gdb) continue
  (gdb) print VtableStub::_chunk → 期望: 非 NULL (VtableBlob 已创建)
  (gdb) print VtableStub::_chunk_end - VtableStub::_chunk → 期望: chunk_factor * real_size (如 debug: 32×1024=32768)
  (gdb) print VtableStub::_vtab_stub_size → 期望: 0 (首次分配前)
  (gdb) print VtableStub::_itab_stub_size → 期望: 0 (首次分配前)

断言 7: _ame_offset/_npe_offset 设置 (vtableStubs.cpp:204)
  (gdb) break vtableStubs.cpp:204
  (gdb) continue
  # 在 create_vtable_stub 中 bookkeeping 调用 set_exception_points 后
  (gdb) print s->_ame_offset → 期望: 非 -1 (有效偏移)
  (gdb) print s->_npe_offset → 期望: 0 (npe_addr == code_begin(), load_klass 是第一指令)
  (gdb) print s->is_null_pointer_exception(s->code_begin()+s->_npe_offset) → 期望: true
  (gdb) print s->is_abstract_method_error(s->code_begin()+s->_ame_offset) → 期望: true
```

---

## §八 ★ Cross-Reference

- **01-CodeCache** — vtable stub 在 CodeCache 中通过 VtableBlob 分配，IC buffer 在 C-Heap——两者互补使用 CodeCache 和非 CodeCache 存储
- **10-JNIHandle-CompileQueue-JVMTI** — CompileQueue 管理编译任务，CompilerOracle 控制哪些方法进入队列
- **15-StubRoutines-SharedRuntime** — resolve blob 处理未缓存的虚方法分派——vtable stub 缓存已解析的分派结果
- **14-Interpreter** — invokevirtual 和 invokeinterface 字节码触发虚方法分派——vtable stub 和 IC buffer 加速这些高频操作

---

## §九 诊断工具

- **jcmd `<pid>` Compiler.CodeHeap_Analytics** — 验证 vtable stub 在 CodeCache 中（VtableBlob 显示在 NonNMethod segment）
- **jcmd `<pid>` PerfCounter.print** — 验证 dependencyContext 计数器（SUN_CI 命名空间：nmethodBucketsAllocated/Deallocated/Stale/StaleAccumulated）
- **`-XX:+PrintCompilation`** — 验证 CompileCommand 生效（排除的方法不应出现编译事件）
- **GDB: `print VtableStubs::_table`** — 验证哈希表已分配（256 个槽位全部 NULL 初始）
- **GDB: `print InlineCacheBuffer::_buffer->number_of_stubs()`** — 验证 IC buffer 中至少 1 个 sentinel stub
- **strace `-e mmap,mprotect`** — 验证 VtableStub 首次分配时 VtableBlob 在 CodeCache 中的 mmap（`VtableStub::operator new` → `VtableBlob::create` → `CodeCache::allocate`）
- **/proc/`<pid>`/maps** — 验证 IC buffer 在 C-Heap（`[heap]` 段）vs vtable stub 在 CodeCache（`[anon]` 段）的地址分布
- **jstack `<pid>`** — 验证 IC buffer 满时触发的 `VM_ICBufferFull` VM 操作阻塞线程（safepoint 中所有 Java 线程暂停等待 IC buffer 清理）

---

## §十 ★★★ vtable/itable stub 生成流程 (x86_64)

### 10.1 create_vtable_stub — 三步生成 vtable 分派桩

`VtableStubs::create_vtable_stub()` (`vtableStubs_x86_64.cpp:48-139`) 为给定 `vtable_index` 生成一段可直接执行的机器码片段。**核心三步**：

**Step 1: 分配空间**（:50-55）
```cpp
const int stub_code_length = code_size_limit(true); // 首次=first_vtableStub_size, 后续=实测
VtableStub* s = new(stub_code_length) VtableStub(true, vtable_index);
// → operator new → bump-pointer 从 _chunk 分配
// → VtableStub 对象头 + code buffer 紧密排列
```

**Step 2: 创建 CodeBuffer + MacroAssembler**（:66-68）
```cpp
CodeBuffer cb(s->entry_point(), stub_code_length);  // entry_point() = this + 1
MacroAssembler* masm = new MacroAssembler(&cb);       // 以 CB 写入机器码
```

**Step 3: 生成指令序列**（:70-132）

生成的 x86_64 机器码伪汇编：

```asm
; ★ 前置: rcx = receiver (C2 约定，assert in :77)
; ★ 前置: 调用者已将返回地址压栈

; === 阶段 A: 空指针检查 (隐式) ===
npe_addr:                        ; 记录此地址为 _npe_offset 基准
  mov rax, [rcx + klass_offset]   ; 加载 receiver klass (解引用 receiver 隐含 null check)
                                  ; 若 rcx==NULL → SIGSEGV → JVM 转为 NullPointerException

; === 阶段 B: vtable lookup (仅 debug 有越界检查) ===
  mov rbx, [rax + vtable_start + vtable_index*8]  ; lookup_virtual_method 宏展开
  ; rax = receiver klass
  ; rbx = Method* 指针 (从 vtable[index] 读取)

; === 阶段 C: 跳转到目标方法 ===
ame_addr:                         ; 记录此地址为 _ame_offset 基准
  jmp [rbx + from_compiled_offset] ; 间接跳转到 Method::from_compiled()
                                   ; 若 Method*==NULL (抽象方法) → SEGV → AbstractMethodError
```

`lookup_virtual_method()` 是平台特定的宏（`interp_masm_x86.hpp`），展开为：
```asm
mov  rbx, [rax + InstanceKlass::vtable_start_offset() + vtable_index * vtableEntry::size()]
```
`vtable_index * vtableEntry::size()` 是常量——vtable 的每个条目固定 8 字节（64 位 Method*）。

**slop 机制**（:61-64, 112-114）：变长 x86 指令（`cmp`/`jcc` 的 8-bit vs 32-bit 立即数/偏移）可能导致实际生成的代码比估计短。`slop_bytes` 累积变长指令的"最坏估计 - 实际"差值，在 `bookkeeping()` 中加到实际测量值——确保后续 stub 的 `code_size_limit()` 足够大。

### 10.2 create_itable_stub — 两步 lookup 的 itable 分派桩

`VtableStubs::create_itable_stub()` (`vtableStubs_x86_64.cpp:142-262`) 比 vtable 版本更复杂——需要两步 `lookup_interface_method`：

```
create_itable_stub(itable_index)
  ├→ Step 1: 分配空间 (code_size_limit(false), 首次=first_itableStub_size)
  ├→ Step 2: 获取接口信息
  │    ├→ resolved_klass_reg (rbx) = CompiledICHolder::holder_klass (DECC)
  │    └→ holder_klass_reg   (rax) = CompiledICHolder::holder_metadata (REFC)
  ├→ Step 3: 类型检查 (第一次 lookup_interface_method)
  │    └→ 验证 receiver class 实现了 REFC 接口——否则跳 L_no_such_interface
  ├→ Step 4: 方法查找 (第二次 lookup_interface_method)
  │    └→ 在 receiver class 的 itable 中，用 itable_index 查找目标 Method*
  └→ Step 5: 跳转
       ├→ 成功: jmp [rbx + Method::from_compiled_offset()]
       └→ 失败: jump SharedRuntime::get_handle_wrong_method_stub()
```

生成的 x86_64 机器码伪汇编：

```asm
; ★ 前置: rax = CompiledICHolder (含 resolved_klass + holder_klass)
; ★ 前置: j_rarg0 (rcx) = receiver

; === 阶段 A: 加载接口信息 ===
  mov  rbx, [rax + CompiledICHolder::holder_klass_offset()]     ; resolved_klass (REFC)
  mov  rax, [rax + CompiledICHolder::holder_metadata_offset()]  ; holder_klass (DECC)

; === 阶段 B: 空指针检查 ===
npe_addr:
  load_klass r10, [rcx]            ; 加载 receiver klass (隐含 null check)

; === 阶段 C: 类型检查 —— receiver instanceof REFC? ===
  call lookup_interface_method(recv_klass=r10, iface=rbx, ...)
  ; 遍历 receiver 实现的接口列表 → 检查 REFC 是否存在
  ; 不存在 → jmp L_no_such_interface

; === 阶段 D: itable 查找 —— 获取目标 Method* ===
  load_klass r10, [rcx]            ; 恢复 recv_klass (类型检查可能破坏 r10)
  call lookup_interface_method(recv_klass=r10, iface=rax, itable_index=N, ...)
  ; 在 itable[REFC][itable_index] 位置获取 Method*
  ; 结果: rbx = Method*

; === 阶段 E: 跳转到目标 ===
ame_addr:
  jmp  [rbx + Method::from_compiled_offset()]  ; 间接跳转

; === 阶段 F: 失败处理 ===
L_no_such_interface:
  jmp  [SharedRuntime::get_handle_wrong_method_stub()]
  ; 跳转到 SharedRuntime 的 handle_wrong_method 桩
  ; → 解释器运行时做完整类型检查 → 抛出 IncompatibleClassChangeError
```

**注册分配**（:174-179）：itable stub 使用 `r10`, `r11`, `rbx`, `rax` 作为临时寄存器——避免与调用约定的 `r[cd]x`, `r[sd]i`, `r[89]` 冲突。

**index_dependent_slop**（:157-158）：
```cpp
const int index_dependent_slop = (itable_index == 0) ? 4 :     // index=0 生成更短代码
                                  (itable_index < 16) ? 3 : 0;  // 8-bit vs 32-bit 常量
```
当 `itable_index` 从 15 变为 16 时，`lookup_interface_method` 中 `cmp` 立即数从 8-bit 变为 32-bit → 指令增长 3-4 字节。`index_dependent_slop` 在 `bookkeeping()` 中补偿这个变化（`vtableStubs.cpp:195-198`）。

### 10.3 stub 在 CodeCache 中的布局

```
CodeHeap "non-nmethods"
┌──────────────────────────────────────────────────────┐
│ VtableBlob "vtable chunks" (chunk_factor=32)         │
│ ┌──────────────────────────────────────────────────┐ │
│ │ VtableStub[0] (index=5, vtable)                  │ │
│ │  ├── VtableStub header (sizeof=~32B)              │ │
│ │  └── Code[code_size_limit] (~132B)                │ │
│ ├──────────────────────────────────────────────────┤ │
│ │ VtableStub[1] (index=7, vtable)                  │ │
│ │  ├── header                                       │ │
│ │  └── Code                                         │ │
│ ├──────────────────────────────────────────────────┤ │
│ │ VtableStub[2] (index=2, itable)                  │ │
│ │  ├── header                                       │ │
│ │  └── Code (~336B, itable 更大)                    │ │
│ ├──────────────────────────────────────────────────┤ │
│ │ ... 剩余 29 个空的 VtableStub 槽位 ...            │ │
│ └──────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────┤
│ VtableBlob "vtable chunks" (第二个 chunk)            │
│ ┌──────────────────────────────────────────────────┐ │
│ │ VtableStub[32] ...                               │ │
│ └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

每个 VtableStub 的 `code_begin()` = `(address)(this+1)`（`vtableStubs.hpp:142`），即代码紧跟在对象头后。`code_end()` = `code_begin() + code_size_limit(is_vtable_stub)`——注意是 **分配大小** 而非实际代码大小（实际可能因 slop 而略小于分配）。

**验证命令**：
```bash
# 查看 CodeCache 中的 vtable chunk
jcmd <pid> Compiler.CodeHeap_Analytics | grep -A5 "vtable"

# GDB 查看 VtableBlob 位置
(gdb) print VtableStub::_chunk          # 当前 bump-pointer
(gdb) print VtableStub::_chunk_end      # 当前 chunk 结尾
(gdb) print VtableStubs::_vtab_stub_size   # 实测 vtable stub 大小
(gdb) print VtableStubs::_itab_stub_size   # 实测 itable stub 大小
```

### 10.4 bookkeeping — 生成后记账与 slop 验证

`VtableStubs::bookkeeping()` (`vtableStubs.cpp:179-205`) 在每次 stub 生成后调用：

```cpp
void VtableStubs::bookkeeping(MacroAssembler* masm, outputStream* out, VtableStub* s,
                              address npe_addr, address ame_addr,   bool is_vtable_stub,
                              int     index,    int     slop_bytes, int  index_dependent_slop) {
  // 1. 日志记录
  log_trace(vtablestubs)("# %d at %p: size: %d, estimate: %d, slop: %d",
                         index, s->code_begin(), actual_size, estimate, slop);

  // 2. 溢出检查
  guarantee(masm->pc() <= s->code_end(), "overflowed buffer");

  // 3. 尺寸自适应: 更新 _vtab_stub_size / _itab_stub_size
  check_and_set_size_limit(is_vtable_stub, masm->offset(), slop_bytes);

  // 4. 设置异常偏移
  s->set_exception_points(npe_addr, ame_addr);
}
```

**溢出检查的必要性**：`guarantee(masm->pc() <= s->code_end())` 使用 `guarantee`（非 `assert`）——即使在 PRODUCT 模式也会检查。如果 code buffer 真的溢出了，继续执行会导致 CodeCache 的内存破坏（stub 代码覆盖相邻的 VtableBlob/nmethod 数据），比简单 crash 更难调试。`guarantee` 确保立即 fatal error 并在 hs_err 中记录精确信息。

**slop_bytes 的物理意义**：`masm->pc() - s->code_begin()` 是实际生成的代码长度，`code_size_limit()` 是分配的 buffer 长度。`slop_bytes` = 分配长度 - 实际长度（加上 `index_dependent_slop` 补偿）。这个差值被加到下一次的 `_vtab_stub_size` / `_itab_stub_size` 中——确保即使遇到最坏情况的变长指令，后续 stub 也不会溢出。

**反事实**：如果 `bookkeeping()` 中不更新 `_vtab_stub_size`（始终用 first_vtableStub_size=1024）→ debug 模式下每个 vtable stub 浪费 ~892 字节（实际 ~132 vs 分配 1024）→ 100 个 stub → 浪费 ~87KB → CodeCache segment 中 VtableBlob 占比过大 → 挤压 nmethod 空间。

### 10.5 stub 的查找与创建完整流程（从 invokevirtual 到 stub 返回）

当 JIT 编译器中遇到 `invokevirtual` 指令，生成 code 时调用 `find_vtable_stub(vtable_index)`（`vtableStubs.hpp:104`）→ `find_stub(true, vtable_index)`（`vtableStubs.cpp:208-242`）：

```
find_stub(is_vtable_stub, vtable_index)
  ├→ lookup(is_vtable_stub, vtable_index)       // hash table 查找
  │    └→ hash = ((index<<2)^receiver_location)+index & 255
  │    └→ 遍历链表: s = _table[hash]; s && !s->matches(); s = s->next()
  │    └→ HIT: return s->entry_point()            // 已缓存 → O(1)
  └→ MISS:                                          // 首次遇到此 index
       ├→ create_vtable_stub(vtable_index)      // 生成机器码 (Section 10.1)
       │    └→ NULL? → return NULL               // CodeCache 满
       ├→ enter(is_vtable_stub, index, s)       // 插入哈希表
       │    └→ s->set_next(_table[h]); _table[h] = s; _number_of_vtable_stubs++
       ├→ PrintAdapterHandlers? → Disassembler::decode()  // 解码打印汇编
       └→ JVMTI: post_dynamic_code_generated("vtable stub", begin, end)
            // 通知 JVMTI agent 新代码已生成 (DynamicCodeGenerated 事件)
```

**追问**：为什么 `lookup()` 用 `MutexLocker ml(VtableStubs_lock)` 而 `stub_containing()` 不需要锁（`vtableStubs.cpp:287-297` 注释 "No locking needed"）？→ 因为 `_table` 的插入是原子写入（`_table[h] = s` 是单次指针赋值），而读取时遍历链表即使看到旧值也无损——最多重复生成一个 stub 而被 `enter()` 中的 `assert(matches)` 检测到。

**反事实**：如果 `find_stub()` 返回 NULL（CodeCache 满无法分配 VtableBlob）→ 调用者（C2 编译器）不会 insert 失败的 stub → 编译继续但生成 `ic_call` 走解释器 resolve path → 每次 invokevirtual 都走 `SharedRuntime::resolve_virtual_call()` → 性能退化 ~50×（从 5ns IC hit 到 ~250ns 解释器 resolve）。JVM 会继续运行，但 CodeCache 满导致所有新编译使用解释器 fallback。

---

## §十一 Writing Requirements 对照表

| 不要写成 | 应该写成 |
|---------|---------|
| "vtableStubs_init 创建哈希表" | "VtableStubs::initialize() at vtableStubs.cpp:124 (11 行) 设置 VtableStub::_receiver_location = SharedRuntime::name_for_receiver() (x86_64: rcx)，初始化 _table[0..255] 全部为 NULL——N=256 编译期常量（vtableStubs.hpp:77），hash 函数 ((vtable_index<<2)^receiver_location)+vtable_index 与 mask=255，vtable/itable 用互补 hash 防冲突" |
| "IC buffer 存储 inline cache 更新" | "InlineCacheBuffer::initialize() at icBuffer.cpp:112 (6 行) 创建 _buffer = new StubQueue(new ICStubInterface, 10*K, InlineCacheBuffer_lock, "InlineCacheBuffer")——10KB StubQueue 在 C-Heap（非 CodeCache）分配，ICStubInterface 定义 stub 大小和对齐，init_next_stub() 创建 sentinel stub 始终保留——is_empty() = number_of_stubs==1" |
| "compilerOracle_init 解析编译指令" | "compilerOracle_init() at compilerOracle.cpp:767 (22 行) 通过 parse_from_string(CompileCommand, parse_from_line) 解析 -XX:CompileCommand（exclude/compileonly/inline/print/break/log），parse_from_string(CompileOnly, parse_compile_only) 解析 -XX:CompileOnly。如果 .hotspot_compiler 文件存在但未用 -XX:CompileCommandFile 加载 → warning。print 命令与 PrintAssembly 冲突时 warning，否则自动开启 DebugNonSafepoints" |
| "dependencyContext_init 创建计数器" | "DependencyContext::init() at dependencyContext.cpp:43 (13 行) 在 UsePerfData=true 时创建 4 个 PerfCounter（SUN_CI 命名空间）：nmethodBucketsAllocated/Deallocated/Stale/StaleAccumulated——跟踪 nmethod 依赖桶的分配/释放/过期统计，mark_dependent_nmethods() 在类重定义时遍历标记所有依赖 nmethod 为 deoptimization" |
