# 02. JNI GetIntField 正常 200 cycles → 怎么做到 30 cycles？— JNI Fast Path

> 🔴 Deep | 2 KP 中的性能优化
> 读者处境: Android/JNI heavy 应用——每秒 1000 次 JNI GetIntField→正常路径 200 cycles×1000=200K cycles→fast path 30 cycles×1000=30K cycles→节省 85%。

> ⚠️ 写作期修正(2026-08-14, vol-02/27-jni/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"jni.cpp:2146-2160 正常路径" 行号错**: 2146 起是 jni_GetXXXField_addr() 系列;普通实现是 **DEFINE_GETFIELD 宏**(jni.cpp:2082-2106,JNI_QUICK_ENTRY + resolve_non_null + from_instance_jfieldID + should_post_field_access probe + 读字段)
> - **"Fast path 6 条指令" 少算**: 真实 ~16 条(mov32 counter/testb/jcc/xor×2(MP 数据依赖屏障)/mov offset/shr/try_resolve 2 条/投机读/lea+xor×2+cmpl 二次校验/jcc/ret);MP 上用 **XOR 数据依赖代替 lfence**(jniFastGetField_x86_64.cpp:38-39 注释);二次 counter 校验的 lea 注释 "ca is data dependent on rax"(:109)
> - **伪代码漏二次 counter 加载(重要)**: 真实=第一次偶数作门票→resolve→投机读字段(登记 pc)→**再读 counter 比较**,相等才返回(hpp:31-55 注释,jniFastGetField_x86_64.cpp:107-116);不等→慢路径
> - **"GetObjectField/GetStatic*Field" 编造**: 只有 **8 个实例字段 Get**(Boolean/Byte/Char/Short/Int/Long/Float/Double),无 Object 无 Static(quicken_jni_functions jni.cpp:3840-3870);原因=stub 只能返回寄存器标量(无法 make_local),静态 fieldID 是 JNIid* 非偏移
> - **"safepoint_counter begin 前 +1/end 后 +1" 位置微调**: begin() 内部 :448-450(Threads_lock 已拿到)与 end() :501-503 各 +1;safepoint.hpp:112-118 注释权威("incremented ONLY at the beginning and end of each safepoint...Threads_lock held throughout...guarantees race freedom");初值 0(safepoint.cpp:145);18-01 已提双加载,同源
> - **缺机制(重要)**: ①**quicken_jni_functions**(jni.cpp:3829-3873,create_vm thread.cpp:3916)+**5 条件**(UseFastJNIAccessors globals.hpp:916 && !can_post_field_access && !VerifyJNIFields && !CountJNICalls && !CheckJNICalls);copy_jni_function_table safepoint 原子替换(jni.cpp:3820-3827,注释 "each function pointers are copied automically",jvmtiEnv.cpp:108);②**fieldID 编码**: 低 2 位 checked/instance,偏移=BitsPerWord-2 位(枚举 address_bits,位布局注释"30"是 32 位遗留;shrptr roffset,2);③**try_resolve_jobject_in_native**(barrierSetAssembler_x86.cpp:213-217)=clear_jweak_tag+movptr [obj] 两行,不区分引用类型;④**信号救场**(os_linux_x86.cpp:494-501): 投机读期间 GC 收缩堆→SIGSEGV/SIGBUS→find_slowcase_pc 查 speculative_load_pclist(jniFastGetField.cpp:28-39)→跳 slowcase_entry_pclist(hpp:94-104 注释含调试坏值动机);⑤慢路径=**尾跳**(jump ExternalAddress(jni_GetIntField_addr()),:120-133,不递归)
> - **实证**: 27-jni-fastpath-demo.txt(UseFastJNIAccessors=true 默认;2000 万次 GetIntField: 快 ~1.4ns/次 vs 慢 ~15ns/次,**约 10 倍**)
> - **悬念指向 03 ✓**(正确,标题以大纲 03 实际标题为准)

### 1. "正常路径 —— 为什么慢？"

场景: 标准 JNI GetIntField 调用——Java→Native→JNIEnv→函数表→check→resolve→读 field。

**正常 GetIntField 开销** (`jni.cpp:2146-2160`):
```
JNI_GetIntField:
  1. JNIEnv→functions→GetIntField(jenv, obj, fieldID)  // 2 indirections
  2. jniCheck: verify jenv 匹配当前线程, obj is non-null     // ~10 insn
  3. JNIHandles::resolve(obj) → oop                          // ~5 insn
  4. field_offset = jfieldIDWorkaround(fieldID)              // ~3 insn
  5. RawAccess<>::load(oop+offset)                           // read field
  6. return value
```
- 总开销 ~200 cycles——大部分在 JNIEnv 用虚拟函数表跳转和线程检查
- [C++: JNI 函数表是 `JNINativeInterface_` 结构——每个 JNI 函数是一个函数指针——Java 调用→通过指针表跳转→2次 load+2次间接跳转+1次 call→~30 cycles just for dispatch]

### 2. "Fast path —— safepoint counter 优化"

场景: jniFastGetField 旁路掉 JNIEnv 和 handle resolution——直接读 safepoint counter→如果偶数→读 oop+field→返回。

**jniFastGetField 实现** (`jniFastGetField.hpp:40-80 + cpu/x86/jniFastGetField_x86_64.cpp:40-200`):
```
Fast path (x86_64 assembly):
  mov rcx, [safepoint_counter_addr]  // load counter
  test cl, 1                           // 偶数? (bit 0 = 0)
  jnz slow_path                        // 奇数→走慢路径
  mov rdi, [obj_handle]                // resolve handle
  mov eax, [rdi + field_offset]        // read int field
  ret                                  // 6 instructions, ~30 cycles

Slow path:
  call JNI_GetIntField  // full path (~200 cycles)
```
- 源码: `jniFastGetField.hpp:40-80` + `cpu/x86/jniFastGetField_x86_64.cpp:40-200`
- 关键设计: safepoint counter 是偶数=无正在进行 safepoint→thread 在 _thread_in_native 状态→GC 不会动 oop→handle 指向的 oop 不变→可以直接读 field。counter 奇数=有 safepoint 在进行→必须走慢路径让 GC 安全 resolve 和 check
- [C++: `_safepoint_counter`(域18) 在 SafepointSynchronize::begin() 前+1(变奇数)，end() 后+1(变偶数)。Fast path 通过 `test cl,1; jnz` 检查——如果 counter 变奇数，fast path 自动 fall back to slow path]

### 3. "支持哪些类型？"

**FastGetField 覆盖** (`jniFastGetField_x86_64.cpp:56-100`):
```
GetIntField, GetFloatField, GetLongField, GetDoubleField, GetObjectField
GetStaticIntField, GetStaticFloatField, ... 等
```
- 每个类型有对应的 x86_64 stub——Int/Long 读不同字节数，Float/Double 用 xmm0 返回

---

### 核心悬念

**"jniFastGetField 用 safepoint_counter 偶数检查绕过 JNIEnv 虚拟函数表——6 条 x86 指令, 30 cycles vs 正常 200 cycles。"** — 下一篇: JNI Check + 平台层。

> → [03-jni-check-platform.md](03-jni-check-platform.md)
