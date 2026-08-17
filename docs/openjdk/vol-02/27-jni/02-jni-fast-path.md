# 02. JNI GetIntField 200 cycles → 怎么做到 30 cycles?— JNI Fast Path

> **前置依赖**:[27-jni/01 — jobject 在 JVM 内部怎么存的?— JNI Handle 系统](openjdk/vol-02/27-jni/01-handle-system.md):handle 槽、resolve、fieldID 都在这里;[18-safepoint/01 — JVM 怎么让所有线程同时停住?— Safepoint 编排](openjdk/vol-02/18-safepoint/01-safepoint-orchestration.md):safepoint counter 的奇偶语义;[20-vm-operations/02 — 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](openjdk/vol-02/20-vm-operations/02-background-init.md):quicken_jni_functions 在 create_vm 里被调用
> → **后续**:[27-jni/03 — JNI 调用参数错了——JVM 怎么检测?— JNI Check + 平台层](03-jni-check-platform.md)
> 关联域: 31-unsafe(另一条绕过 JNI 的通道)、16-code-cache(stub 生成)、04-logging

## 读一个整型字段要花多少

`GetIntField` 读一个 int 字段,逻辑上就是"解引用 + 读 4 字节"。但走普通 JNI 路径,每次调用要经过: 函数表间接调用(`env->GetIntField` 是函数指针)、线程状态转换(native→VM)、JVMTI 检查、handle 解析——大纲说 200 cycles,实测快路径关闭时约 **15 ns/次**(本机),快路径开启时约 **1.4 ns/次**([实证:](openjdk/planning/outlines/00-jvm-tools/materials/commands/27-jni-fastpath-demo.txt),2000 万次循环,**约 10 倍差距**)。这篇拆: 普通路径慢在哪、快路径凭什么安全地绕开它。

## 1. 普通路径: 为什么慢

`jni_GetIntField` 不是一个函数,是一个宏生成的 8 个函数之一(`DEFINE_GETFIELD`,jni.cpp:2082-2106):

```cpp
// jni.cpp:2082-2106(截取核心,逐字)
#define DEFINE_GETFIELD(Return,Fieldname,Result \
  , EntryProbe, ReturnProbe) \
\
  DT_RETURN_MARK_DECL_FOR(Result, Get##Result##Field, Return \
  , ReturnProbe); \
\
JNI_QUICK_ENTRY(Return, jni_Get##Result##Field(JNIEnv *env, jobject obj, jfieldID fieldID)) \
  JNIWrapper("Get" XSTR(Result) "Field"); \
\
  EntryProbe; \
  Return ret = 0;\
  DT_RETURN_MARK_FOR(Result, Get##Result##Field, Return, (const Return&)ret);\
\
  oop o = JNIHandles::resolve_non_null(obj); \
  Klass* k = o->klass(); \
  int offset = jfieldIDWorkaround::from_instance_jfieldID(k, fieldID);  \
  /* Keep JVMTI addition small and only check enabled flag here.       */ \
  /* jni_GetField_probe_nh() assumes that is not okay to create handles */ \
  /* and creates a ResetNoHandleMark.                                   */ \
  if (JvmtiExport::should_post_field_access()) { \
    o = JvmtiExport::jni_GetField_probe_nh(thread, obj, o, k, fieldID, false); \
  } \
  ret = o->Fieldname##_field(offset); \
  return ret; \
JNI_END
```

开销清单: ①`JNI_QUICK_ENTRY`(interfaceSupport.inline.hpp:532-540)展开成函数表入口——`thread_from_jni_environment(env)` 取线程、`ThreadInVMfromNative` 状态转换(native→VM,伴随 safepoint 检查)、`VM_QUICK_ENTRY_BASE`(debug 下 `NoHandleMark`);②`resolve_non_null(obj)` 解析 handle(01 篇);③`from_instance_jfieldID` 把 fieldID 译成 offset(还带 `VerifyJNIFields` 校验);④`should_post_field_access()` 判断 + 可能的 JVMTI probe;⑤真正读字段。**每次调用都做这全套,而字段本身只有 4 字节**——大头在调用框架与安全检查,不在读。

## 2. 快路径: 一个"投机"的 stub

### 接管: 启动时替换函数表

快路径不改变 JNI 函数本身——它在**启动时把函数表里的槽换成生成的 stub**。`quicken_jni_functions`(jni.cpp:3829-3873)在 `Threads::create_vm` 里被调用(thread.cpp:3916,20-02 的第三段):

```cpp
// jni.cpp:3829-3873(截取核心,逐字)
void quicken_jni_functions() {
  // Replace Get<Primitive>Field with fast versions
  if (UseFastJNIAccessors && !JvmtiExport::can_post_field_access()
      && !VerifyJNIFields && !CountJNICalls && !CheckJNICalls
      ...
  ) {
    address func;
    func = JNI_FastGetField::generate_fast_get_boolean_field();
    if (func != (address)-1) {
      jni_NativeInterface.GetBooleanField = (GetBooleanField_t)func;
    }
    func = JNI_FastGetField::generate_fast_get_byte_field();
    if (func != (address)-1) {
      jni_NativeInterface.GetByteField = (GetByteField_t)func;
    }
    ...
    func = JNI_FastGetField::generate_fast_get_double_field();
    if (func != (address)-1) {
      jni_NativeInterface.GetDoubleField = (GetDoubleField_t)func;
    }
  }
}
```

**只有 8 个槽**: Boolean/Byte/Char/Short/Int/Long/Float/Double——全部是实例字段的 Get,**没有 `GetObjectField`,也没有 `GetStatic*Field`**([实证:] 27-jni-fastpath-demo.txt)。替换的 5 个条件: `UseFastJNIAccessors`(默认 true,globals.hpp:916)且无 JVMTI 字段访问钩子且无校验/计数/检查——任一开启就整体不替换(`-XX:-UseFastJNIAccessors` 就是[实证]的慢路径开关)。函数表本身的更新有并发安全顾虑: native 线程可能正在读函数表,所以 JVMTI 侧替换走 `copy_jni_function_table`(jni.cpp:3820-3827)——**在 safepoint 里逐槽原子写**("To avoid this each function pointers are copied automically",注释 :3815-3819;JvmtiExport 用, :3820-3827)。

### stub: 一次奇偶检查 + 两次 counter 加载

stub 的机制注释在 jniFastGetField.hpp:31-55,先看它再对照汇编:

```
// load _safepoint_counter into old_counter
// IF old_counter is odd THEN
//   a safepoint is going on, return jni_GetXXXField
// ELSE
//   load the primitive field value into result (speculatively)
//   load _safepoint_counter into new_counter
//   IF (old_counter == new_counter) THEN
//     no safepoint happened during the field access, return result
//   ELSE
//     a safepoint might have happened in-between, return jni_GetXXXField()
//   ENDIF
// ENDIF
```

**两次 counter 加载,不是一次**: 第一次(偶数)只是"门票",读字段是**投机**的——读的瞬间 GC 可能开始收缩堆。所以读完必须**再读一次 counter**,两次相等才证明"读的整个窗口里没有 safepoint"。x86_64 的生成代码(jniFastGetField_x86_64.cpp:56-138):

```cpp
// jniFastGetField_x86_64.cpp:75-118(截取核心,逐字)
  ExternalAddress counter(SafepointSynchronize::safepoint_counter_addr());
  __ mov32 (rcounter, counter);
  __ mov   (robj, c_rarg1);
  __ testb (rcounter, 1);
  __ jcc (Assembler::notZero, slow);
  if (os::is_MP()) {
    __ xorptr(robj, rcounter);
    __ xorptr(robj, rcounter);                   // obj, since
                                                // robj ^ rcounter ^ rcounter == robj
                                                // robj is data dependent on rcounter.
  }

  __ mov   (roffset, c_rarg2);
  __ shrptr(roffset, 2);                         // offset

  // Both robj and rtmp are clobbered by try_resolve_jobject_in_native.
  BarrierSetAssembler* bs = BarrierSet::barrier_set()->barrier_set_assembler();
  bs->try_resolve_jobject_in_native(masm, /* jni_env */ c_rarg0, robj, rtmp, slow);
  DEBUG_ONLY(__ movl(rtmp, 0xDEADC0DE);)

  assert(count < LIST_CAPACITY, "LIST_CAPACITY too small");
  speculative_load_pclist[count] = __ pc();
  switch (type) {
    ...
    case T_INT:     __ movl   (rax, Address(robj, roffset, Address::times_1)); break;
    ...
  }

  if (os::is_MP()) {
    __ lea(rcounter_addr, counter);
    // ca is data dependent on rax.
    __ xorptr(rcounter_addr, rax);
    __ xorptr(rcounter_addr, rax);
    __ cmpl (rcounter, Address(rcounter_addr, 0));
  } else {
    __ cmp32 (rcounter, counter);
  }
  __ jcc (Assembler::notEqual, slow);

  __ ret (0);
```

要点: ①**LoadLoad 屏障用"数据依赖"代替 lfence**(:38-39 注释 "Instead of issuing lfence for LoadLoad barrier, we create data dependency between loads, which is more efficient than lfence")——`robj ^ counter ^ counter == robj`,硬件上 robj 的读取被强制排在 counter 之后,比栅栏便宜;②**fieldID 右移 2 位**(`shrptr roffset, 2`)——01 篇没展开的 jfieldID 编码: 低 2 位是 checked/instance 标记,其余 `BitsPerWord - 2` 位是字段偏移(jfieldIDWorkaround.hpp:28-60,枚举 `address_bits = BitsPerWord - checked_bits - instance_bits`;位布局注释里的 "30" 是 32 位时代的遗留;`raw_instance_offset` 同样右移,普通路径与快路径对同一编码的解释一致);③**resolve 是 barrier assembler 的两行**(`try_resolve_jobject_in_native`,barrierSetAssembler_x86.cpp:213-217): `clear_jweak_tag(obj)` + `movptr obj, [obj]`——清掉可能的 jweak 低位后直接解引用,不区分引用类型;④投机读的**指令地址被登记**(`speculative_load_pclist[count] = __ pc()`,:96)——救场用(见 §4);⑤二次 counter 加载(MP 下同样用 XOR 数据依赖制造屏障,:107-112),不等就 `jcc notEqual, slow`;⑥慢路径是**尾跳**(:120-133,`jump ExternalAddress(jni_GetIntField_addr())`)——不递归,直接跳到普通函数。

## 3. 为什么"偶数"就安全: counter 的协议

`_safepoint_counter` 的语义写在 safepoint.hpp:112-118:

```cpp
// safepoint.hpp:112-118(截取核心,逐字)
  // This counter is used for fast versions of jni_Get<Primitive>Field.
  // An even value means there is no ongoing safepoint operations.
  // The counter is incremented ONLY at the beginning and end of each
  // safepoint. The fact that Threads_lock is held throughout each pair of
  // increments (at the beginning and end of each safepoint) guarantees
  // race freedom.
```

初值 0(safepoint.cpp:145);safepoint 开始时加 1 变奇数(begin() 内部 :448-450,`Threads_lock` 已经拿到),结束时再加 1 回偶数(end() :501-503)。**奇数的"持续期"覆盖整个 safepoint**(线程挂起→操作→唤醒),所以: 读到偶数 → 没有 safepoint 在进行;读完字段再读到同一个偶数 → 整个读窗口里没发生过 safepoint → 读到的 oop 没被移动过、字段值一致。反过来看论证的另一半: 对象移动**必然**发生在 begin 与 end 之间、必然让 counter 变号,所以即使投机读真的读到了"移动前的旧位置"(旧内存尚未回收、值也读出来了),二次校验也必然失败、结果被整体丢弃走慢路径——**读错不可怕,可怕的是读错还不知道**。**"Threads_lock 全程持有保证 race freedom"** 是协议的核心: 一次 safepoint 的两次加 1 之间,任何线程看到的 counter 不会处于"半同步"的中间态。hpp:54-55 还承认一个理论上的 counter 回绕(2 的 32 次方次 safepoint 后旧值重现),注释自己判定 "not a practical concern"。18 域的 jniFastGetField 双加载与此同源。

## 4. 谁给投机读兜底: 信号处理器

投机读最危险的情形: 偶数 counter 已加载、正要读字段时,GC 开始并**收缩了堆**(比如 Full GC 的压缩),那么读字段的指令会访问已移动/无效的地址——**SIGSEGV 或 SIGBUS**。这不会崩,因为有专门救场:

```cpp
// os_linux_x86.cpp:494-501(截取核心,逐字)
    // jni_fast_Get<Primitive>Field can trap at certain pc's if a GC kicks in
    // and the heap gets shrunk before the field access.
    if ((sig == SIGSEGV) || (sig == SIGBUS)) {
      address addr = JNI_FastGetField::find_slowcase_pc(pc);
      if (addr != (address)-1) {
        stub = addr;
      }
    }
```

信号处理器拿当前 pc 查 `speculative_load_pclist`(生成 stub 时登记的投机读指令地址,与 `slowcase_entry_pclist` 一一配对,jniFastGetField.cpp:28-39),命中就把执行流改到对应的慢路径尾跳点——**投机的读被"罚"到慢路径重做**。hpp:94-104 的注释交代了另一个动机: GC 在调试模式下可能往 handle 里塞坏值,同样靠这个映射兜底。

## 5. 边界: 为什么没有 Object 和 Static

快路径的形态决定了边界: stub 返回**寄存器里的标量**(rax/xmm0)直接 `ret`,它无法创建新的本地引用——而 `GetObjectField` 的返回值要成为 jobject(`make_local`),`GetStatic*Field` 的 fieldID 是 `JNIid*` 而不是偏移(编码完全不同,jfieldIDWorkaround.hpp:30-37: instance=1 低位标记),都不符合"读一个偏移处的标量"这个模板。所以 8 个 Get 就是全部: [实证:](openjdk/planning/outlines/00-jvm-tools/materials/commands/27-jni-fastpath-demo.txt) `UseFastJNIAccessors=false` 时每调用 ~15ns,开启时 ~1.4ns——**约 10 倍**,大纲的"30 vs 200 cycles"换成实测数字更直观。

## 核心悬念

快路径拆完: 它不改变 JNI 语义,只在启动时(`quicken_jni_functions`,5 条件全满足才替换)把 8 个 Get 槽换成投机 stub——**偶数 counter 作门票、读字段、再读 counter 校验、尾跳慢路径兜底、信号处理器给投机读收尸**;`Threads_lock` 全程持有让 counter 的两次加 1 原子成对,数据依赖代替 lfence 是 x86_64 的锦上添花。代价是这些 stub 一旦生成就固定下来,而普通路径至少还做着"参数校验"这件小事——**参数错了谁来抓**?`-Xcheck:jni` 开启时快路径直接失效(条件之一),换来的是一整套 JNI 调用合法性检查。下一篇: JNI Check 与平台层。

> → [27-jni/03 — JNI 校验与平台层](03-jni-check-platform.md)
