# 02. JNI GetIntField 200 cycles → 怎么做到 30 cycles?— JNI Fast Path

> **前置依赖**:[27-jni/01 — jobject 在 JVM 内部怎么存的?— JNI Handle 系统](openjdk/vol-02/27-jni/01-handle-system.md):handle 槽、resolve、fieldID 都在这里;[18-safepoint/01 — JVM 怎么让所有线程同时停住?— Safepoint 编排](openjdk/vol-02/18-safepoint/01-safepoint-orchestration.md):safepoint counter 的奇偶语义;[20-vm-operations/02 — 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](openjdk/vol-02/20-vm-operations/02-background-init.md):quicken_jni_functions 在 create_vm 里被调用
> → **后续**:[27-jni/03 — JNI 调用参数错了——JVM 怎么检测?— JNI Check + 平台层](03-jni-check-platform.md)
> 关联域: 31-unsafe(另一条绕过 JNI 的通道)、16-code-cache(stub 生成)、04-logging

`GetIntField` 读一个 int 字段,逻辑上就是"解引用 + 读 4 字节"。但走普通 JNI 路径,每次调用要经过: 函数表间接调用(`env->GetIntField` 是函数指针)、线程状态转换(native→VM)、JVMTI 检查、handle 解析。实测快路径关闭时约 **15 ns/次**,快路径开启时约 **1.4 ns/次**(约 10 倍差距);换算成 cycles(按 2-3 GHz 估算)大致就是标题里的"200 → 30"这个量级。本篇要回答的核心问题:

1. 普通路径慢在哪几步？
2. 快路径凭什么敢"投机读"——读完后怎么知道 GC 没动对象？
3. 投机读错了怎么办——会不会崩？

答案会反复落到一句话:**快路径用 safepoint counter 的奇偶语义做门票，先投机读字段，再读一次 counter 校验；读错了也不怕，信号处理器捕获 SIGSEGV 后查 pc 地址表，把执行流改到慢路径重做。**

---

## 1. 开场困惑——读个 int 怎么会要 200 cycles

`GetIntField` 读一个 int 字段,逻辑上就是"取对象 → 算偏移 → 读 4 字节"。但 JNI 的每次调用还包括:

- 从 `JNIEnv*` 里取出当前线程、做 native→VM 状态转换（同时检查 safepoint）;
- 把 `jobject` 解析成 oop（handle 解引用）;
- 把 `jfieldID` 翻译成字段偏移（带校验）;
- 检查 JVMTI 字段访问钩子;
- 最后才读那 4 字节。

每次调用都做这全套,而读字段本身只有 4 字节。**大头在调用框架与安全检查,不在读。**

JVM 的设计者当然知道这个开销问题。于是有了一个"投机"的解决方案:不做状态转换,不 resolve handle,不检查 JVMTI,直接读——但读完之后要能证明"GC 没在这期间移动对象"。

---

## 2. 两个朴素方案为什么都不对

### 方案一: 直接读裸 oop 指针

如果 JNI 函数直接返回裸 oop 地址而不走 handle,确实可以省掉 resolve 步骤。但 01 篇已经讲过:裸 oop 在 GC 移动后悬空。而且 native 代码没有 GC 的回调,无法知道地址已变。

### 方案二: 每次读都加锁保护

另一种思路是:读字段时加锁,防止 GC 同时移动对象。但锁的获取/释放成本远高于读 4 字节本身,而且会阻塞 GC 线程——safepoint 本就需要等待所有线程到达安全点,加锁会让这个等待变成死锁候选。

正确方案是:不加锁,但用 safepoint counter 的奇偶语义验证"读窗口里没有 safepoint"。

---

## 3. 普通路径——慢在哪

`jni_GetIntField` 不是单独写的,是用宏生成的(jni.cpp:2082-2106):

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
  if (JvmtiExport::should_post_field_access()) { \
    o = JvmtiExport::jni_GetField_probe_nh(thread, obj, o, k, fieldID, false); \
  } \
  ret = o->Fieldname##_field(offset); \
  return ret; \
JNI_END
```

开销清单:

1. **`JNI_QUICK_ENTRY`**(interfaceSupport.inline.hpp:532-540):展开成函数表入口——`thread_from_jni_environment(env)` 取线程、`ThreadInVMfromNative` 状态转换(native→VM,伴随 safepoint 检查)、`VM_QUICK_ENTRY_BASE`(debug 下 `NoHandleMark`);
2. **`resolve_non_null(obj)`**:01 篇讲的 handle 解引用;
3. **`from_instance_jfieldID`**:把 fieldID 译成 offset(带 `VerifyJNIFields` 校验);
4. **`should_post_field_access()`**:判断 + 可能的 JVMTI probe;
5. 真正读字段。

**每次调用都做这全套,而字段本身只有 4 字节。** 所以问题不是"读字段慢",而是"为了安全地读字段,付出的周边代价远大于读本身"。

---

## 4. 快路径——用 counter 做门票的投机读

### 启动时替换函数表,不是修改 JNI 函数本身

快路径不改变 JNI 函数实现。它在**启动时把函数表里的 8 个 Get 槽换成生成的 stub**。`quicken_jni_functions`(jni.cpp:3829-3873)在 `Threads::create_vm` 里被调用:

```cpp
// jni.cpp:3829-3873(截取核心,逐字)
void quicken_jni_functions() {
  // Replace Get<Primitive>Field with fast versions
  if (UseFastJNIAccessors && !JvmtiExport::can_post_field_access()
      && !VerifyJNIFields && !CountJNICalls && !CheckJNICalls
      ...
  ) {
    func = JNI_FastGetField::generate_fast_get_int_field();
    if (func != (address)-1) {
      jni_NativeInterface.GetIntField = (GetIntField_t)func;
    }
    // ... Boolean/Byte/Char/Short/Long/Float/Double 各一个
  }
}
```

**只有 8 个 Get 槽**:Boolean/Byte/Char/Short/Int/Long/Float/Double——全部是实例字段的 Get,**没有 `GetObjectField`,也没有 `GetStatic*Field`**。替换的 5 个条件: `UseFastJNIAccessors`(默认 true)且无 JVMTI 字段访问钩子且无校验/计数/检查——任一开启就整体不替换。`quicken_jni_functions` 在启动时(单线程)直接赋值,没有并发问题;JVMTI 侧若需要动态替换则走 `copy_jni_function_table`(jni.cpp:3820-3827),用 `Atomic::store` 逐槽原子写。

### stub 的整体逻辑

`jniFastGetField.hpp:31-55` 的注释描述了 stub 的核心流程:

```
load _safepoint_counter into old_counter
IF old_counter is odd THEN
  a safepoint is going on, return jni_GetXXXField
ELSE
  load the primitive field value into result (speculatively)
  load _safepoint_counter into new_counter
  IF (old_counter == new_counter) THEN
    no safepoint happened during the field access, return result
  ELSE
    a safepoint might have happened in-between, return jni_GetXXXField()
  ENDIF
ENDIF
```

**两次 counter 加载,不是一次**: 第一次(偶数)只是"门票",读字段是**投机**的——读的瞬间 GC 可能开始收缩堆(比如 Full GC 的压缩)。所以读完必须**再读一次 counter**,两次相等才证明"读的整个窗口里没有 safepoint"。

### x86_64 的生成代码

`JNI_FastGetField::generate_fast_get_int_field0`(jniFastGetField_x86_64.cpp:75-141)生成的具体指令:

```cpp
// jniFastGetField_x86_64.cpp:75-141(截取核心,逐字)
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
  ...
  // resolve 是 barrier assembler 的两行
  BarrierSetAssembler* bs = BarrierSet::barrier_set()->barrier_set_assembler();
  bs->try_resolve_jobject_in_native(masm, /* jni_env */ c_rarg0, robj, rtmp, slow);
  ...
  speculative_load_pclist[count] = __ pc();
  switch (type) {
    ...
    case T_INT:     __ movl   (rax, Address(robj, roffset, Address::times_1)); break;
    ...
  }
  ...
  __ lea(rcounter_addr, counter);
  __ xorptr(rcounter_addr, rax);
  __ xorptr(rcounter_addr, rax);
  __ cmpl (rcounter, Address(rcounter_addr, 0));
  __ jcc (Assembler::notEqual, slow);
  __ ret (0);
```

要点:

- **LoadLoad 屏障用"数据依赖"代替 lfence**(:38-39 注释): `robj ^ counter ^ counter == robj`,硬件上 robj 的读取被强制排在 counter 之后,比栅栏便宜。
- **resolve 是 `try_resolve_jobject_in_native`**(barrierSetAssembler_x86.cpp:213-217): `clear_jweak_tag(obj)` 清掉可能的 jweak 低位后直接 `movptr obj, [obj]` 解引用——不区分引用类型,也不走 `ThreadInVMfromNative` 状态转换。
- **fieldID 右移 2 位**(`shrptr roffset, 2`): jfieldID 的低 2 位是 checked/instance 标记(jfieldIDWorkaround.hpp:28-60),其余位是字段偏移,右移后得到真正的偏移量。
- **投机读的指令地址被登记**(`speculative_load_pclist[count] = __ pc()`,jniFastGetField.cpp:28-39): 救场用(见§6)。
- **二次 counter 加载**(MP 下同样用 XOR 数据依赖制造屏障),不等就 `jcc notEqual, slow`。
- **慢路径是尾跳**: 不递归,直接跳到普通函数入口,走完整的 `jni_GetIntField`。

---

## 5. 为什么偶数就安全——counter 的协议

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

初值 0(safepoint.cpp:145);safepoint 开始时加 1 变奇数(begin() 内部,`Threads_lock` 已经拿到),结束时再加 1 回偶数。**奇数的"持续期"覆盖整个 safepoint**(线程挂起→操作→唤醒),所以:

- 读到偶数 → 没有 safepoint 在进行;
- 读完字段再读到同一个偶数 → 整个读窗口里没发生过 safepoint → 读到的 oop 没被移动过、字段值一致。

反过来看论证的另一半: 对象移动**必然**发生在 begin 与 end 之间、必然让 counter 变号,所以即使投机读真的读到了"移动前的旧位置"(旧内存尚未回收、值也读出来了),二次校验也必然失败、结果被整体丢弃走慢路径——**读错不可怕,可怕的是读错还不知道**。

**"Threads_lock 全程持有保证 race freedom"** 是协议的核心: 一次 safepoint 的两次加 1 之间,任何线程看到的 counter 不会处于"半同步"的中间态。hpp 注释还承认一个理论上的 counter 回绕(2 的 32 次方次 safepoint 后旧值重现),但判定 "not a practical concern"。

---

## 6. 谁给投机读兜底——信号处理器

投机读最危险的情形: 偶数 counter 已加载、正要读字段时,GC 开始并**收缩了堆**(比如 Full GC 的压缩),那么读字段的指令会访问已移动/无效的地址——**SIGSEGV 或 SIGBUS**。这不会崩,因为有专门救场:

```cpp
// src/hotspot/os_cpu/linux_x86/os_linux_x86.cpp:494-501(截取核心,逐字)
    // jni_fast_Get<Primitive>Field can trap at certain pc's if a GC kicks in
    // and the heap gets shrunk before the field access.
    if ((sig == SIGSEGV) || (sig == SIGBUS)) {
      address addr = JNI_FastGetField::find_slowcase_pc(pc);
      if (addr != (address)-1) {
        stub = addr;
      }
    }
```

信号处理器拿当前 pc 查 `speculative_load_pclist`(生成 stub 时登记的投机读指令地址,与 `slowcase_entry_pclist` 一一配对,jniFastGetField.cpp:28-39),命中就把执行流改到对应的慢路径尾跳点——**投机的读被"罚"到慢路径重做**。hpp 注释还交代了另一个动机: GC 在调试模式下可能往 handle 里塞坏值,同样靠这个映射兜底。

---

## 7. 误解澄清与收网

1. **快路径是否修改了 JNI 语义?** 否。快路径是启动时替换函数表里的函数指针,正常路径的代码不变;快路径的所有路径最终都落到同一条慢路径函数,语义完全等价。
2. **为什么没有 GetObjectField 快路径?** 因为快路径 stub 返回寄存器里的标量直接 `ret`;`GetObjectField` 的返回值要成为 jobject(需要 `make_local` 创建本地引用),它无法在栈上创建 handle 然后返回。`GetStatic*Field` 的 fieldID 编码与实例字段不同(低位 bit 含义不同),也不符合"读一个偏移处的标量"这个模板。
3. **投机读失败时会不会崩?** 不会。信号处理器捕获 SIGSEGV/SIGBUS,查 pc 地址表找到对应的慢路径入口,直接跳转到慢路径重做。stub 会表现为"慢路径耗时",不会崩溃。
4. **counter 回绕是否可能?** 理论上:2 的 32 次方次 safepoint 后 counter 值重复。但 JVM 在回绕前早就重启了,注释自评"not a practical concern"。
5. **什么条件会让快路径整体失效?** 5 个条件任一成立(UseFastJNIAccessors=false、JVMTI 字段访问钩子、VerifyJNIFields、CountJNICalls、CheckJNICalls),`quicken_jni_functions` 就不做替换,函数表保持原样。

把这一篇压成三句话:

- **普通路径慢在"周边代价"**:状态转换、resolve、fieldID 翻译、JVMTI 检查——每次读字段都做全套,读 4 字节本身不是瓶颈。
- **快路径用 safepoint counter 做门票**:偶数 counter 时先投机读,再读一次 counter 校验;两次相等证明整个读窗口里无 GC 移动。
- **信号处理器兜底 SIGSEGV**:查 pc 地址表映射到慢路径入口,把投机读失败"罚"到慢路径重做,不会崩。

快路径拆完，代价是这些 stub 一旦生成就固定下来，而普通路径至少还做着"参数校验"这件小事——**参数错了谁来抓**?`-Xcheck:jni` 开启时快路径直接失效(条件之一),换来的是一整套 JNI 调用合法性检查。下一篇: JNI Check 与平台层。

> → [27-jni/03 — JNI 校验与平台层](03-jni-check-platform.md)