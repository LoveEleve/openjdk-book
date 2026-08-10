# 02. JNI GetIntField 正常 200 cycles → 怎么做到 30 cycles？— JNI Fast Path

> 🔴 Deep | 2 KP 中的性能优化
> 读者处境: Android/JNI heavy 应用——每秒 1000 次 JNI GetIntField→正常路径 200 cycles×1000=200K cycles→fast path 30 cycles×1000=30K cycles→节省 85%。

### 1. "正常路径 —— 为什么慢？"

场景: 标准 JNI GetIntField 调用——Java→Native→JNIEnv→函数表→check→resolve→读 field。

**正常 GetIntField 开销** (`jni.cpp:GetIntField`):
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

**FastGetField 覆盖** (`jniFastGetField.cpp:generate`):
```
GetIntField, GetFloatField, GetLongField, GetDoubleField, GetObjectField
GetStaticIntField, GetStaticFloatField, ... 等
```
- 每个类型有对应的 x86_64 stub——Int/Long 读不同字节数，Float/Double 用 xmm0 返回

---

### 核心悬念

**"jniFastGetField 用 safepoint_counter 偶数检查绕过 JNIEnv 虚拟函数表——6 条 x86 指令, 30 cycles vs 正常 200 cycles。"** — 下一篇: JNI Check + 平台层。

> → [03-jni-check-platform.md](03-jni-check-platform.md)
