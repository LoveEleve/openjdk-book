# 8.1 VM_Version_init -- CPU 特性检测

> **本文定位**：JVM 初始化序列中的第 5 个步骤。你要理解的是 HotSpot 如何通过动态生成的汇编桩执行 `CPUID` 指令，从 x86_64 CPU 中读出 42 个特性位和虚拟化信息，并把它们转换成 JVM 运行时 flag -- 整个 JIT 编译器的指令选择都依赖这些检测结果。
>
> 本机是 96 核 x86_64，标准 Tiered 模式。`ICache::stub_size` 由 `ICache::line_size`（64 字节）和 `ICache::log2_line_size`（6）确定。

---

## 0. 完整源码清单

本文涉及的所有源码均列于此。正文中直接以 `vm_version_x86.cpp:1728` 的格式引用行号 -- 你在清单中找到对应文件即可。

### 0a. `vm_version.cpp` -- 入口函数

**文件**: `src/hotspot/share/runtime/vm_version.cpp`

```cpp
// line 31
void VM_Version_init() {
  VM_Version::initialize();

  if (log_is_enabled(Info, os, cpu)) {
    char buf[1024];
    ResourceMark rm;
    LogStream ls(Log(os, cpu)::info());
    os::print_cpu_info(&ls, buf, sizeof(buf));
  }
}
```

在 `init_globals()` 的第 108 行被调 (`init.cpp:108`)：

```cpp
VM_Version_init();
```

### 0b. `abstract_vm_version.hpp` -- 基类

**文件**: `src/hotspot/share/runtime/abstract_vm_version.hpp`

```cpp
// line 47
class Abstract_VM_Version: AllStatic {
 protected:
  // -- line 56 --
  static uint64_t _features;           // CPU 特性位掩码
  static const char* _features_string; // 特性名的可读字串

  // -- lines 60-74 -- 硬件能力字段
  static bool         _supports_cx8;
  static bool         _supports_atomic_getset4;
  static bool         _supports_atomic_getset8;
  static bool         _supports_atomic_getadd4;
  static bool         _supports_atomic_getadd8;
  static unsigned int _logical_processors_per_package;
  static unsigned int _L1_data_cache_line_size;
  static unsigned int _data_cache_line_flush_size;
  static unsigned int _parallel_worker_threads;
  static bool         _parallel_worker_threads_initialized;

  // -- line 76 --
  static VirtualizationType _detected_virtualization;
};
```

`VirtualizationType` 枚举（同文件 `line 31`）：

```cpp
typedef enum {
  NoDetectedVirtualization,
  XenHVM, KVM, VMWare, HyperV, HyperVRole,
  PowerVM, PowerFullPartitionMode, PowerKVM
} VirtualizationType;
```

### 0c. `vm_version_x86.hpp` -- VM_Version 类

**文件**: `src/hotspot/cpu/x86/vm_version_x86.hpp`

```cpp
// line 31
class VM_Version : public Abstract_VM_Version {
 public:
  // cpuid 结果寄存器布局 -- 全部是 uint32_t union + bitfield struct
  // 常用的有:
  union StdCpuid1Eax {  // line 39, 含 family/model/stepping
    uint32_t value;
    struct {
      uint32_t stepping   : 4, model : 4, family : 4, proc_type : 2,
                          : 2, ext_model : 4, ext_family : 8, : 4;
    } bits;
  };
  union StdCpuid1Ecx {   // line 63, 含 sse3/ssse3/sse4_1/sse4_2/avx/popcnt/aes/hv
    uint32_t value;
    struct { /* ... 各特性位 */ } bits;
  };
  union StdCpuid1Edx {   // line 96, 含 sse/sse2/tsc/cmov/cmpxchg8/mmx/ht
    uint32_t value;
    struct { /* ... 各特性位 */ } bits;
  };
  union SefCpuid7Ebx {   // line 203, 含 avx2/bmi1/bmi2/avx512/rtm/sha
    uint32_t value;
    struct { /* ... 各特性位 */ } bits;
  };
  union XemXcr0Eax {     // line 272, OS 对 xcr0 的配置: ymm/zmm512
    uint32_t value;
    struct { /* ... */ } bits;
  };

  // -- line 370 -- CpuidInfo 结构体: 所有 CPUID 查询结果
  struct CpuidInfo {
    uint32_t std_max_function;         // cpuid(0) eax -- 最高支持的标准功能号
    uint32_t std_vendor_name_0;        // vendor 字串 "Genu" / "Auth" / "Cent"
    uint32_t std_vendor_name_1;        // "ineI" / "enti" / "aurH"
    uint32_t std_vendor_name_2;        // "ntel" / "cAMD" / "auls"

    StdCpuid1Eax std_cpuid1_eax;       // cpuid(1) eax: family/model/stepping
    StdCpuid1Ebx std_cpuid1_ebx;       // cpuid(1) ebx: brand/clflush/threads/apic
    StdCpuid1Ecx std_cpuid1_ecx;       // cpuid(1) ecx: sse3-avx 特性位
    StdCpuid1Edx std_cpuid1_edx;       // cpuid(1) edx: sse/sse2 特性位

    DcpCpuid4Eax dcp_cpuid4_eax;       // cpuid(4) eax: cache type/cores
    DcpCpuid4Ebx dcp_cpuid4_ebx;       // cpuid(4) ebx: L1 line size
    /* dcp_cpuid4_ecx/edx unused */
    uint32_t dcp_cpuid4_ecx, dcp_cpuid4_edx;

    SefCpuid7Eax sef_cpuid7_eax;       // cpuid(7) eax
    SefCpuid7Ebx sef_cpuid7_ebx;       // cpuid(7) ebx: avx2/bmi/avx512
    SefCpuid7Ecx sef_cpuid7_ecx;       // cpuid(7) ecx: avx512_vbmi/vaes
    SefCpuid7Edx sef_cpuid7_edx;       // cpuid(7) edx

    // cpuid(0xB) 处理器拓扑 (ecx=0,1,2)
    uint32_t tpl_cpuidB0_eax; TplCpuidBEbx tpl_cpuidB0_ebx;
    uint32_t tpl_cpuidB1_eax; TplCpuidBEbx tpl_cpuidB1_ebx;
    uint32_t tpl_cpuidB2_eax; TplCpuidBEbx tpl_cpuidB2_ebx;

    uint32_t ext_max_function;         // cpuid(0x80000000) eax
    ExtCpuid1Ecx ext_cpuid1_ecx;       // cpuid(0x80000001) ecx
    ExtCpuid1Edx ext_cpuid1_edx;       // cpuid(0x80000001) edx

    // cpuid(0x80000002-0x80000004) 品牌字串 "Intel(R) Core(TM)..."
    uint32_t proc_name_0 .. proc_name_11;

    ExtCpuid5Ex ext_cpuid5_ecx;        // cpuid(0x80000005) L1 data cache
    ExtCpuid5Ex ext_cpuid5_edx;        // L1 instruction cache
    ExtCpuid7Edx ext_cpuid7_edx;       // cpuid(0x80000007) tscinv
    ExtCpuid8Ecx ext_cpuid8_ecx;       // cpuid(0x80000008) cores per cpu

    XemXcr0Eax xem_xcr0_eax;          // XCR0 xgetbv 结果

    int ymm_save[8*4];                 // 信号处理后保存 ymm 寄存器
    int zmm_save[16*4];                // 信号处理后保存 zmm 寄存器
  };

  // -- line 467 --
  static CpuidInfo _cpuid_info;

  // -- line 295 -- Feature_Flag 枚举: 42 个特性位号
  enum Feature_Flag {
    CPU_CX8      = (1 << 0),
    CPU_CMOV     = (1 << 1),
    CPU_FXSR     = (1 << 2),
    CPU_HT       = (1 << 3),
    CPU_MMX      = (1 << 4),
    CPU_3DNOW_PREFETCH = (1 << 5),
    CPU_SSE      = (1 << 6),
    CPU_SSE2     = (1 << 7),
    CPU_SSE3     = (1 << 8),
    CPU_SSSE3    = (1 << 9),
    CPU_SSE4A    = (1 << 10),
    CPU_SSE4_1   = (1 << 11),
    CPU_SSE4_2   = (1 << 12),
    CPU_POPCNT   = (1 << 13),
    CPU_LZCNT    = (1 << 14),
    CPU_TSC      = (1 << 15),
    CPU_TSCINV   = (1 << 16),
    CPU_AVX      = (1 << 17),
    CPU_AVX2     = (1 << 18),
    CPU_AES      = (1 << 19),
    CPU_ERMS     = (1 << 20),
    CPU_CLMUL    = (1 << 21),
    CPU_BMI1     = (1 << 22),
    CPU_BMI2     = (1 << 23),
    CPU_RTM      = (1 << 24),
    CPU_ADX      = (1 << 25),
    CPU_AVX512F  = (1 << 26),
    CPU_AVX512DQ = (1 << 27),
    CPU_AVX512PF = (1 << 28),
    CPU_AVX512ER = (1 << 29),
    CPU_AVX512CD = (1 << 30),
  };
  // enum 只能 31 位, 剩余用 #define:
  #define CPU_AVX512BW        UC(0x100000000)
  #define CPU_AVX512VL        UC(0x200000000)
  #define CPU_SHA             UC(0x400000000)
  #define CPU_FMA             UC(0x800000000)
  #define CPU_VZEROUPPER      UC(0x1000000000)
  #define CPU_AVX512_VPOPCNTDQ UC(0x2000000000)
  #define CPU_AVX512_VPCLMULQDQ UC(0x4000000000)
  #define CPU_VAES            UC(0x8000000000)
  #define CPU_HV_PRESENT      UC(0x400000000000)

  // -- line 47 -- 关键字段 (_cpu 等来自 vm_version_x86.cpp 静态变量定义)
  static int _cpu;
  static int _model;
  static int _stepping;
  static address _cpuinfo_segv_addr;
  static address _cpuinfo_cont_addr;

  // -- line 688 --
  static void initialize();
  // -- line 653 --
  static void get_processor_features();
  // -- line 949 --
  static void check_virtualizations();
};
```

### 0d. `vm_version_x86.cpp` -- 类定义: 全局变量和 StubGenerator

**文件**: `src/hotspot/cpu/x86/vm_version_x86.cpp`

```cpp
// lines 39-57: 静态字段定义 + stub 基础设施
int VM_Version::_cpu;
int VM_Version::_model;
int VM_Version::_stepping;
VM_Version::CpuidInfo VM_Version::_cpuid_info = { 0, };
address VM_Version::_cpuinfo_segv_addr = 0;
address VM_Version::_cpuinfo_cont_addr = 0;

static BufferBlob* stub_blob;
static const int stub_size = 2000;

extern "C" {
  typedef void (*get_cpu_info_stub_t)(void*);
  typedef void (*detect_virt_stub_t)(uint32_t, uint32_t*);
}
static get_cpu_info_stub_t get_cpu_info_stub = NULL;
static detect_virt_stub_t detect_virt_stub = NULL;

// line 60
class VM_Version_StubGenerator: public StubCodeGenerator {
 public:
  VM_Version_StubGenerator(CodeBuffer *c) : StubCodeGenerator(c) {}

  address generate_get_cpu_info() {
    /* ~480 行汇编 -- 分段展示在正文第 2 节, 此处省略 */

    return start;
  };
  void generate_vzeroupper(Label& L_wrapup) { /* ... */ }

  address generate_detect_virt() {
    /* ~30 行汇编 -- 分段展示在正文第 2 节, 此处省略 */

    return start;
  };
};
```

### 0e. `vm_version_x86.cpp` -- VM_Version::initialize()

**文件**: `src/hotspot/cpu/x86/vm_version_x86.cpp`

```cpp
// line 1728
void VM_Version::initialize() {
  ResourceMark rm;
  // Making this stub must be FIRST use of assembler

  stub_blob = BufferBlob::create("VM_Version stub", stub_size);
  if (stub_blob == NULL) {
    vm_exit_during_initialization("Unable to allocate stub for VM_Version");
  }
  CodeBuffer c(stub_blob);
  VM_Version_StubGenerator g(&c);
  get_cpu_info_stub = CAST_TO_FN_PTR(get_cpu_info_stub_t,
                                     g.generate_get_cpu_info());
  detect_virt_stub = CAST_TO_FN_PTR(detect_virt_stub_t,
                                    g.generate_detect_virt());

  get_processor_features();
  if (VM_Version::supports_hv()) { // Supports hypervisor
    check_virtualizations();
  }
}
```

### 0f. `vm_version_x86.cpp` -- generate_detect_virt()

**文件**: `src/hotspot/cpu/x86/vm_version_x86.cpp`

```cpp
// line 567
address generate_detect_virt() {
  StubCodeMark mark(this, "VM_Version", "detect_virt_stub");
  address start = __ pc();

  __ push(rbp);
  __ push(rbx);
  __ push(rsi); // for Windows

#ifdef _LP64
  __ mov(rax, c_rarg0); // CPUID leaf
  __ mov(rsi, c_rarg1); // register array address (eax, ebx, ecx, edx)
#else
  __ movptr(rax, Address(rsp, 16)); // CPUID leaf
  __ movptr(rsi, Address(rsp, 20)); // register array address
#endif

  __ cpuid();

  // Store result to register array
  __ movl(Address(rsi,  0), rax);
  __ movl(Address(rsi,  4), rbx);
  __ movl(Address(rsi,  8), rcx);
  __ movl(Address(rsi, 12), rdx);

  __ pop(rsi);
  __ pop(rbx);
  __ pop(rbp);
  __ ret(0);

  return start;
};
```

### 0g. `vm_version_x86.cpp` -- get_processor_features() 核心逻辑

**文件**: `src/hotspot/cpu/x86/vm_version_x86.cpp`

```cpp
// line 606
void VM_Version::get_processor_features() {

  _cpu = 4; // 486 by default
  _model = 0;
  _stepping = 0;
  _features = 0;
  _logical_processors_per_package = 1;
  _L1_data_cache_line_size = 16;

  // Get raw processor info
  get_cpu_info_stub(&_cpuid_info);

  assert_is_initialized();
  _cpu = extended_cpu_family();
  _model = extended_cpu_model();
  _stepping = cpu_stepping();

  if (cpu_family() > 4) { // it supports CPUID
    _features = feature_flags();
    _logical_processors_per_package = logical_processor_count();
    _L1_data_cache_line_size = L1_line_size();
  }

  _supports_cx8 = supports_cmpxchg8();
  _supports_atomic_getset4 = true;
  _supports_atomic_getadd4 = true;
  LP64_ONLY(_supports_atomic_getset8 = true);
  LP64_ONLY(_supports_atomic_getadd8 = true);

  // ... UseSSE/UseAVX 级联屏蔽 + 厂商特化设置 + 级联 flag
};
```

`feature_flags()` 函数（`vm_version_x86.hpp:492`）从 `_cpuid_info` 提取各 union 的位域，填入 `_features` 位掩码。本文正文第 3 节拆解。

### 0h. `vm_version_x86.cpp` -- check_virtualizations()

**文件**: `src/hotspot/cpu/x86/vm_version_x86.cpp`

```cpp
// line 1691
void VM_Version::check_virtualizations() {
  uint32_t registers[4] = {0};
  char signature[13] = {0};

  for (int leaf = 0x40000000; leaf < 0x40010000; leaf += 0x100) {
    detect_virt_stub(leaf, registers);
    memcpy(signature, &registers[1], 12);

    if (strncmp("VMwareVMware", signature, 12) == 0) {
      Abstract_VM_Version::_detected_virtualization = VMWare;
      VirtualizationSupport::initialize();
    } else if (strncmp("Microsoft Hv", signature, 12) == 0) {
      Abstract_VM_Version::_detected_virtualization = HyperV;
    } else if (strncmp("KVMKVMKVM", signature, 9) == 0) {
      Abstract_VM_Version::_detected_virtualization = KVM;
    } else if (strncmp("XenVMMXenVMM", signature, 12) == 0) {
      Abstract_VM_Version::_detected_virtualization = XenHVM;
    }
  }
}
```

---

## 需要的前置知识

| 概念 | 解释 |
|------|------|
| CPUID 指令 | x86 的 CPU 信息查询指令。`eax` 设功能号，执行 `cpuid` 后 `eax/ebx/ecx/edx` 返回对应信息。支持标准功能号（0, 1, 4, 7, 0xB）和扩展功能号（0x80000000+ 查品牌字串/AMD 特性） |
| `BufferBlob` | CodeBlob 的子类，存放手写汇编 stub。第 7 章已讲过 header/payload 布局 -- 本节直接引用 |
| `StubCodeGenerator` | stub 生成器的基类。内部有 `_masm`（MacroAssembler），本节只需要知道它能通过 `_masm` 生成 x86 机器码。Chapter 9 展开 `MacroAssembler` 实现 |
| `CAST_TO_FN_PTR` | 把生成的机器码地址（`address`）转成 C 函数指针类型：`CAST_TO_FN_PTR(get_cpu_info_stub_t, g.generate_get_cpu_info())`。这样就能像普通 C 函数一样调用机器码 |
| `Feature_Flag` 枚举 | `vm_version_x86.hpp:295`。42 个位定义，每位的含义见清单 0c。`_features` 是一个 `uint64_t` 位掩码，检测到某特性时对应位被置 1 |

---

## 1. VM_Version_init 全貌

`VM_Version_init()` 是 `init_globals()` 中第 108 行调用的第 5 个初始化步骤。它位于参数解析之后、`os::init_globals()` 之前 。调用顺序（`init.cpp:108`）：

```
VM_Version_init();  // line 108
os_init_globals();  // line 109 -- 依赖 VM_Version 的结果
```

`VM_Version_init()` 本身非常简单。清单 0a 中可以看到，它只做两件事：

1. 调用 `VM_Version::initialize()` -- 执行 CPU 特性检测的全部逻辑
2. 如果日志 `os+cpu` 在 info 级开，打印 CPU 型号摘要（`os::print_cpu_info` 从 `/proc/cpuinfo` 读）

第 2 步是纯日志输出，初始化逻辑全部在第 1 步。下面看 `VM_Version::initialize()` 的完整流程。

---

## 2. 两个汇编桩

在读取 CPU 寄存器之前，需要先生成能执行 `CPUID` 指令的机器码。C 编译器不提供 `cpuid` 关键字（那是 MSVC/ICC 的扩展），HotSpot 选择自己生成。

### 2.1 分配 stub 内存

`VM_Version::initialize()` 的第一段（`vm_version_x86.cpp:1729-1741`）展示了全过程：

```cpp
// line 1729
ResourceMark rm;

// line 1732
stub_blob = BufferBlob::create("VM_Version stub", stub_size);
if (stub_blob == NULL) {
  vm_exit_during_initialization("Unable to allocate stub for VM_Version");
}
```

`BufferBlob::create` 在 code cache 的 NonNMethod 堆里分配一块 2000 字节的内存（`stub_size = 2000`，定义在 `vm_version_x86.cpp:50`）。这 2000 字节是固定大小，不随 CPU 型号变化 -- 是为容纳所有分支（386 检测到 AVX-512 信号测试）的汇编代码预留的最大空间。

```cpp
// line 1736
CodeBuffer c(stub_blob);
VM_Version_StubGenerator g(&c);
```

创建一个 `CodeBuffer` 包装 `BufferBlob`，然后创建 `VM_Version_StubGenerator`。`StubCodeGenerator` 的构造函数将 `CodeBuffer` 传给内部的 `MacroAssembler`（ch09 展开），使 `_masm` 指令直接编码到 code cache 内存。

### 2.2 get_cpu_info_stub -- 执行 CPUID + 读回全部寄存器

```cpp
// line 1738
get_cpu_info_stub = CAST_TO_FN_PTR(get_cpu_info_stub_t,
                                   g.generate_get_cpu_info());
```

`generate_get_cpu_info()` （`vm_version_x86.cpp:65`）是整个初始化中最大的函数（约 480 行汇编）。它的签名是 `void get_cpu_info(VM_Version::CpuidInfo* cpuid_info)` -- 接收 `_cpuid_info` 结构体的地址，把 CPUID 结果填进去。

`generate_get_cpu_info()` 分为四个阶段：

**阶段 1 -- CPU 年代检测（386/486/586）。**

```cpp
// vm_version_x86.cpp:89-133
__ push(rbp);
__ mov(rbp, c_rarg0); // cpuid_info 地址 (rsi 在非 LP64)

__ pushf();           // 保存 EFLAGS 原始值
__ pop(rax);
__ push(rax);
__ mov(rcx, rax);

__ xorl(rax, HS_EFL_AC);  // 翻转 AC bit (0x40000)
__ push(rax);
__ popf();
__ pushf();
__ pop(rax);
__ cmpptr(rax, rcx);
__ jccb(Assembler::notEqual, detect_486);
// 386: AC 位翻不过去--不支持
```

这段检测 CPU 年代：386 无法修改 AC 标志位，486 无法修改 ID 标志位。如果是 386 直接写入 `CPU_FAMILY_386` 跳 `done`；如果是 486 写入 `CPU_FAMILY_486` 跳 `done`；586+ 才进入真正的 CPUID 查询。

**阶段 2 -- CPUID(0) + 处理器拓扑。**

586+ 路径先执行 `cpuid(0)`（`vm_version_x86.cpp:138-149`）得到 `std_max_function`（最高支持的标准功能号）和 vendor 字串。然后根据 `std_max_function` 的值决定查询哪些标准功能：

- 若 `std_max_function >= 0xB`：执行 `cpuid(0xB)` 获得处理器拓扑（线程/核/package 层级）
- 若 `std_max_function >= 0x4`：执行 `cpuid(0x4)` 获得缓存参数（L1 行大小等）
- 始终执行 `cpuid(0x1)`：获得 family/model/stepping 和 SSE/SSE2/MMX 特性位

每次 CPUID 结果通过 `lea(rsi, offset) + movl[0..3]` 写入 `_cpuid_info` 的对应偏移。

**阶段 3 -- XGETBV + CPUID(7) 扩展特性。**

若 `cpuid(1).ecx` 的 osxsave 和 avx 位都为 1（`vm_version_x86.cpp:237-239`），执行 `xgetbv` 读取 XCR0 寄存器的值。XCR0 表示 OS 允许使用哪些扩展寄存器集（ymm=bit1, zmm=bit5-7）。这决定了 AVX/AVX-512 是否可用。

然后执行 `cpuid(0x7)`（`vm_version_x86.cpp:253-264`）获得结构化扩展特性：avx2, bmi1, bmi2, rtm, sha, avx512 系列等。

**阶段 4 -- 扩展 CPUID + 信号测试。**

执行扩展 CPUID 查询（0x80000000, 0x80000001, 0x80000005, 0x80000007, 0x80000008, 0x8000001E）获得 AMD 扩展特性和品牌字串。

特别的，`generate_get_cpu_info` 还包含一个信号测试段（`vm_version_x86.cpp:362-540`）。它的目的是检测 OS 在信号处理时是否会正确地保存和恢复 YMM/ZMM 寄存器的高 128/256 位：

```cpp
// vm_version_x86.cpp:454-459
__ xorl(rsi, rsi);
VM_Version::set_cpuinfo_segv_addr(__ pc());
__ movl(rax, Address(rsi, 0));  // 触发 SEGV -- 访问 NULL 指针

VM_Version::set_cpuinfo_cont_addr(__ pc());
// 信号处理器执行后回到这里 -- 然后保存 xmm/ymm/zmm 值到 _cpuid_info
```

`get_cpu_info_wrapper()`（定义在虚拟机启动逻辑中）先设置 SEGV 信号处理器，再调用 `get_cpu_info_stub`。发生 SEGV 后，信号处理器保存寄存器上下文，然后继续执行到 `_cpuinfo_cont_addr`。此时贴标语句将 ymm/zmm 寄存器值保存到 `_cpuid_info.ymm_save` / `_cpuid_info.zmm_save`。后面 `os_supports_avx_vectors()` 逐字节对比这些值和 `0xCAFEBABE`（`ymm_test_value()`），确认 OS 没弄丢数据。

### 2.3 detect_virt_stub -- 最简单的 CPUID 桩

`detect_virt_stub` 的结构非常短（清单 0f，`vm_version_x86.cpp:567-603`）。它的签名是 `void detect_virt(uint32_t leaf, uint32_t* registers)`：

- 把 `c_rarg0`（leaf 号）放入 `rax`
- 把 `c_rarg1`（输出数组地址）放入 `rsi`
- 执行 `cpuid`
- 把 `eax/ebx/ecx/edx` 存入 `rsi[0..3]`

与 `get_cpu_info_stub` 不同，`detect_virt_stub` 是参数化调用的：调用者可以指定不同的 CPUID leaf（0x40000000, 0x40000100, ...），每次返回该 leaf 的 4 个寄存器值。这使 `check_virtualizations()` 能够遍历所有可能的 hypervisor CPUID leaf。

---

## 3. get_processor_features -- 从 CPUID 到特性位

`get_processor_features()` 在 `VM_Version::initialize()` 的第 1743 行被调用，此时两个汇编桩都已生成完毕。

### 3.1 调用 get_cpu_info_stub -- 填充 _cpuid_info

函数开头设置默认值（`vm_version_x86.cpp:608-614`）：

```cpp
_cpu = 4; // 486 by default
_model = 0;
_stepping = 0;
_features = 0;
_logical_processors_per_package = 1;
_L1_data_cache_line_size = 16;
```

这些默认值代表 486 的最低能力 -- 如果 `get_cpu_info_stub` 意外返回了 386 的结果，JVM 会 fallback 到 486 的参数。

然后调桩：

```cpp
// line 618
get_cpu_info_stub(&_cpuid_info);
```

这行执行后，`_cpuid_info` 被完整填充。`assert_is_initialized()` 校验 `std_cpuid1_eax.bits.family != 0` 确认桩正常执行。然后从 `_cpuid_info` 提取 CPU 版本号：

```cpp
// lines 621-623
_cpu = extended_cpu_family();
_model = extended_cpu_model();
_stepping = cpu_stepping();
```

`extended_cpu_family()`（`vm_version_x86.hpp:470`）把 `std_cpuid1_eax.bits.family + ext_family` 拼出真正的 family 号（例如 Skylake 的 `family=6, ext_family=0`，结果是 6）。

### 3.2 feature_flags() -- 从 union 位域提取 42 个特性位

`feature_flags()`（`vm_version_x86.hpp:492-610`）是一个 118 行的函数，职责是把 `_cpuid_info` 中各个 union 的 `bitfield` 转换成 `_features` 位掩码。

以 SSE 为例：`StdCpuid1Edx.bits.sse` 是 `cpuid(1).edx` 的第 25 位。`feature_flags()` 中对应的代码：

```cpp
// vm_version_x86.hpp:507
if (_cpuid_info.std_cpuid1_edx.bits.sse != 0)
  result |= CPU_SSE;
```

`CPU_SSE = (1 << 6)`，所以检测到 SSE 后 `_features` 的第 6 位被置 1。

对于有前置条件的特性（如 AVX），代码会级联检查：

```cpp
// vm_version_x86.hpp:521-528
if (_cpuid_info.std_cpuid1_ecx.bits.avx != 0 &&
    _cpuid_info.std_cpuid1_ecx.bits.osxsave != 0 &&
    _cpuid_info.xem_xcr0_eax.bits.sse != 0 &&
    _cpuid_info.xem_xcr0_eax.bits.ymm != 0) {
  result |= CPU_AVX;
  result |= CPU_VZEROUPPER;
  if (_cpuid_info.sef_cpuid7_ebx.bits.avx2 != 0)
    result |= CPU_AVX2;
  // ... AVX-512 子特性
}
```

AVX 需要四个条件同时满足：
- CPUID 说自己有 AVX（`avx` 位）
- OS 开启了 XSAVE（`osxsave` 位）
- OS 的 XCR0 启用了 SSE 状态（`xem_xcr0_eax.bits.sse`）
- OS 的 XCR0 启用了 YMM 状态（`xem_xcr0_eax.bits.ymm`）

缺任何一个条件，AVX 都不能使用 -- CPU 有指令但 OS 不会保存 YMM 寄存器的话，JVM 用 AVX 会导致数据损坏。

### 3.3 级联屏蔽

回到 `get_processor_features()`，`_features` 赋值后有一段 UseSSE/UseAVX 的级联屏蔽（`vm_version_x86.cpp:667-682`）：

```cpp
if (UseSSE < 4) {
  _features &= ~CPU_SSE4_1;
  _features &= ~CPU_SSE4_2;
}
if (UseSSE < 3) {
  _features &= ~CPU_SSE3;
  _features &= ~CPU_SSSE3;
  _features &= ~CPU_SSE4A;
}
if (UseSSE < 2)
  _features &= ~CPU_SSE2;
if (UseSSE < 1)
  _features &= ~CPU_SSE;
```

这个逻辑处理的是**命令行指定的限制**。如果用户通过 `-XX:UseSSE=2` 限制了 SSE 级别，即使硬件支持 SSE4.2，对应的特性位也会被抹掉。同样 的级联逻辑用于 UseAVX：

```cpp
// vm_version_x86.cpp:718-735
if (UseAVX < 3) {
  _features &= ~CPU_AVX512F;
  _features &= ~CPU_AVX512DQ;
  // ... 清除所有 AVX-512 子特性位
}
if (UseAVX < 2)
  _features &= ~CPU_AVX2;
if (UseAVX < 1) {
  _features &= ~CPU_AVX;
  _features &= ~CPU_VZEROUPPER;
}
```

清除顺序是**从高级到低级**：先检查 UseAVX < 3（不允许 AVX-512），再检查 UseAVX < 2（不允许 AVX2），最后检查 UseAVX < 1（不允许 AVX）。这样每个级别只清除自己引入的特性位，不会多清也不会漏清。

### 3.4 从 _features 回推 UseSSE/UseAVX

屏蔽后，`get_processor_features()` 还要做反向检测：根据 `_features` 的最终值确定 UseSSE/UseAVX 的默认值（`vm_version_x86.cpp:790-812`）：

```cpp
int use_sse_limit = 0;
if (UseSSE > 0) {
  if (UseSSE > 3 && supports_sse4_1()) { use_sse_limit = 4; }
  else if (UseSSE > 2 && supports_sse3()) { use_sse_limit = 3; }
  else if (UseSSE > 1 && supports_sse2()) { use_sse_limit = 2; }
  else if (UseSSE > 0 && supports_sse()) { use_sse_limit = 1; }
  else { use_sse_limit = 0; }
}
if (FLAG_IS_DEFAULT(UseSSE)) {
  FLAG_SET_DEFAULT(UseSSE, use_sse_limit);
} else if (UseSSE > use_sse_limit) {
  warning("UseSSE=%d is not supported on this CPU, setting it to UseSSE=%d",
          (int) UseSSE, use_sse_limit);
  FLAG_SET_DEFAULT(UseSSE, use_sse_limit);
}
```

两个分支：
- 用户没设 `UseSSE`：设为硬件支持的最高级别
- 用户设了 `UseSSE` 但超过了硬件能力：警告并降到硬件最大值

`UseAVX` 同理（`vm_version_x86.cpp:690-716`），额外处理了 Skylake 旧步进（stepping < 5）不支持 AVX-512 的情况。

---

## 4. 级联 flag -- 从特性位到 JVM 运行时 flag

特性的检测结果不仅影响 `_features` 位掩码，还驱动约 30 个 JVM flag 的设置。这些 flag 分两类：级联关闭和按需开启。

### 4.1 SSE 依赖链

SSE 指令集有严格的向上兼容关系：SSE2 需要 SSE，SSE3 需要 SSE2，SSE4.1 需要 SSE3，以此类推。`get_processor_features()` 中的 UseSSE 级联屏蔽（`vm_version_x86.cpp:667-682`）已经体现了这个依赖链：

```
SSE (UseSSE>=1)
  +-- SSE2 (UseSSE>=2)
       +-- SSE3 (UseSSE>=3)
       |    +-- SSSE3
       |    +-- SSE4A (AMD)
       +-- SSE4.1 (UseSSE>=4)
            +-- SSE4.2
```

### 4.2 按需开启的 flag

大部分 flag 遵循 "硬件支持 + 默认未设" 模式。例如 AES 指令的启用逻辑（`vm_version_x86.cpp:815-835`）：

```cpp
if (supports_aes()) {
  if (FLAG_IS_DEFAULT(UseAES)) {
    FLAG_SET_DEFAULT(UseAES, true);
  }
  // ... 级联开启 UseAESIntrinsics
} else if (UseAES && !FLAG_IS_DEFAULT(UseAES)) {
  warning("AES instructions are not available on this CPU");
  FLAG_SET_DEFAULT(UseAES, false);
}
```

三路分支：
- 硬件有 AES 且 flag 未设：开启
- 硬件有 AES 但用户设了 `-XX:-UseAES`：尊重用户选择
- 硬件没有 AES 但用户设了 `-XX:+UseAES`：警告并关闭

此模式在 `get_processor_features()` 中重复了约 20 次，覆盖以下 flag：

| Flag | 依赖特性 |
|------|---------|
| `UseAES` / `UseAESIntrinsics` | `CPU_AES` + SSE3 |
| `UseAESCTRIntrinsics` | `CPU_AES` + SSE4.1 |
| `UseCLMUL` / `UseCRC32Intrinsics` | `CPU_CLMUL` + SSE3 |
| `UseCRC32CIntrinsics` | `CPU_CLMUL` + SSE4.2 |
| `UseGHASHIntrinsics` | `CPU_CLMUL` + SSE3 |
| `UseBASE64Intrinsics` | `CPU_AVX512VL` + `CPU_AVX512BW` |
| `UseFMA` | `CPU_FMA` + SSE2 |
| `UseSHA` / `UseSHA1Intrinsics` / `UseSHA256Intrinsics` | `CPU_SHA` + SSE4.1 |
| `UseSHA512Intrinsics` | `CPU_SHA` + AVX2 + BMI2 |
| `UseCountLeadingZerosInstruction` | `CPU_LZCNT` |
| `UseCountTrailingZerosInstruction` | `CPU_BMI1` |
| `UseBMI1Instructions` / `UseBMI2Instructions` | `CPU_BMI1`/`CPU_BMI2` + AVX |
| `UsePopCountInstruction` | `CPU_POPCNT` |
| `UseFastStosb` | `CPU_ERMS` |
| `UseXMMForObjInit` | SSE2 + 非对齐访存 |
| `UseVectorizedMismatchIntrinsic` | `UseSSE42Intrinsics` |
| `UseSSE42Intrinsics` | SSE4.2（Intel/AMD/ZX 分别设） |

### 4.3 厂商特化设置

`get_processor_features()` 末尾有大量 `if (is_intel()) / if (is_amd()) / if (is_zx())` 的厂商特化代码。例如 Intel 上 SSE3 + SSE4.2 + HT 同时满足时启用 `UseFPUForSpilling`；AMD family 0x15 默认关闭软件预取（`AllocatePrefetchStyle = 0`）。

这些分支都是本机正常情况下会走的路径，在本机 96 核 Intel 环境下，最终效果是：
- `UseSSE = 4`（SSE4.2）
- `UseAVX = 3`（AVX-512，假定 stepping >= 5）
- `UseAES` / `UseCLMUL` / `UseSHA` 等全部为 `true`

---

## 5. 虚拟化检测

检测硬件特性后，`VM_Version::initialize()` 的最后一步是虚拟化检测（`vm_version_x86.cpp:1744-1746`）：

```cpp
if (VM_Version::supports_hv()) { // Supports hypervisor
  check_virtualizations();
}
```

`supports_hv()` 检查 `_features & CPU_HV_PRESENT`。这个位在 `feature_flags()` 中通过 `cpuid(1).ecx.hv` 设置（`vm_version_x86.hpp:554`）-- 只有运行在 hypervisor 中的 CPU 才置 1。

`check_virtualizations()`（清单 0h，`vm_version_x86.cpp:1691-1725`）遍历 hypervisor CPUID leaf 空间：

```cpp
for (int leaf = 0x40000000; leaf < 0x40010000; leaf += 0x100) {
  detect_virt_stub(leaf, registers);
  memcpy(signature, &registers[1], 12);
  // 比对 signature
}
```

各 hypervisor 的 CPUID 签名（写入 `ebx/ecx/edx` 即 `registers[1..3]`）：

| Hypervisor | Leaf | ebx | ecx | edx | 合并 12 字节 |
|-----------|------|-----|-----|-----|-------------|
| VMware | 0x40000000 | `VMwa` | `reVM` | `ware` | `VMwareVMware` |
| KVM | 0x40000000 | `KVMK` | `VMKV` | `M` | `KVMKVMKVM\0\0\0` |
| Hyper-V | 0x40000000 | `Micr` | `osof` | `t Hv` | `Microsoft Hv` |
| Xen HVM | 0x40000000 | `XenV` | `MMXe` | `nVMM` | `XenVMMXenVMM` |

检测结果存到 `Abstract_VM_Version::_detected_virtualization`（`abstract_vm_version.hpp:76`），后续在 `print_platform_virtualization_info` 中输出到 `java -version` 的额外信息行。

循环从 `0x40000000` 到 `0x4000FF00`，步进 `0x100`。大多数 hypervisor 只占一个 leaf，但 `0x100` 步进确保不会遗漏。`memcpy(signature, &registers[1], 12)` 取 `ebx`（偏移 4）/ `ecx`（偏移 8）/ `edx`（偏移 12）拼接成 12 字节字串，然后用 `strncmp` 比对。

如果检测到 VMware，还会额外调用 `VirtualizationSupport::initialize()` 初始化 VMware GuestLib 扩展指标。

---

## 6. 初始化后的全局状态

`VM_Version::initialize()` 返回后，所有 CPU 信息都已写入静态字段。此时 `VM_Version` 的状态可以用它的各类 `supports_xxx()` 查询。

核心字段：

| 字段 | 所属类 | 写入者 | 存储内容 |
|------|--------|--------|---------|
| `_cpuid_info` | `VM_Version` | `get_cpu_info_stub` | 全部 CPUID 查询原始结果（~300 字节结构体） |
| `_features` | `Abstract_VM_Version` | `feature_flags()` / `get_processor_features()` | 42 个特性位的位掩码 |
| `_cpu` / `_model` / `_stepping` | `VM_Version` | `get_processor_features()` | CPU 版本号 |
| `_logical_processors_per_package` | `Abstract_VM_Version` | `get_processor_features()` | 每 package 的逻辑处理器数 |
| `_L1_data_cache_line_size` | `Abstract_VM_Version` | `get_processor_features()` | L1 数据缓存行大小（字节） |
| `_detected_virtualization` | `Abstract_VM_Version` | `check_virtualizations()` | 虚拟化类型枚举值 |
| `_supports_cx8` / `_supports_atomic_*` | `Abstract_VM_Version` | `get_processor_features()` | 原子操作支持标志 |
| `_cpuinfo_segv_addr` / `_cpuinfo_cont_addr` | `VM_Version` | `generate_get_cpu_info()` | SEGV 触发/恢复地址 |
| `_features_string` | `Abstract_VM_Version` | `get_processor_features()` | 可读的特性列表字串 |

运行时查询示例：
- `VM_Version::supports_sse2()` 查 `_features & CPU_SSE2`
- `VM_Version::is_intel()` 查 `_cpuid_info.std_vendor_name_0 == 0x756e6547`（`'uneG'`）
- `VM_Version::get_detected_virtualization() == NoDetectedVirtualization` 表裸金属

---

## 7. 之后

`VM_Version_init()` 返回后，`_features` 和约 30 个 JVM flag 就已确定。后续 `os::init_globals()` 会根据 `_logical_processors_per_package` 和 `supports_atomic_*` 设置线程相关参数。JIT 编译器（C1/C2）在编译 Java 方法时，通过 `VM_Version::supports_avx()` / `VM_Version::supports_sse4_2()` 等接口决定哪些指令序列可用 -- 整条编译流水线的指令选择都取决于此时 `_cpuid_info` 中读到的数据。
