# 04. 一个 SIGSEGV，JVM 为什么能解释出五种主要语义？

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论
> 本文讲的是 HotSpot 当前 Linux x86_64 实现，不等于所有 JVM、操作系统或 CPU 的统一行为
> **前置依赖**：[02 — 虚拟内存](02-virtual-memory.md)：保护页如何把访问变成 fault；[03 — 线程与同步](03-threads-and-sync.md)：线程角色与暂停协议
> → **后续**：域 02 [Assembler — `test [polling_page], rax` 这 4 字节怎么生成](openjdk/vol-02/02-assembler/01-codebuffer-abstract-assembler.md)
> 关联域：18-safepoint、22-deoptimization、24-frame、28-jvmti
> 工具实证：`jcmd <pid> VM.info` 的 Signal Handlers 输出

## 先别把 SIGSEGV 直接翻译成“崩溃”

在普通 C/C++ 程序里，线程访问了一个不可访问地址，Linux 生成 `SIGSEGV`，程序通常会进入崩溃处理：打印 core、写日志、退出。

所以当我们看到下面这条链时，第一反应通常是：

```text
访问非法地址 → SIGSEGV → 进程崩溃
```

但 HotSpot 偏偏把这条链拆开了。

JVM 在运行时主动制造了一些“访问不可访问页面”的场景：

- 栈接近边界时，用保护页发现栈溢出
- safepoint 请求时，把 polling page 改成不可读，让线程路过时停下
- JIT 生成代码时，利用访问零地址附近触发隐式空指针异常
- 内存序列化时，用页面权限变化帮助完成跨 CPU 协调

于是在本文聚焦的主要路径中，同一个 `SIGSEGV` 可能意味着：

```text
SIGSEGV 到达 HotSpot handler
        │
        ├─ fault 地址在栈保护区      → StackOverflowError
        ├─ fault 地址在 polling page  → safepoint
        ├─ fault 地址在 null 附近     → 隐式 NullPointerException
        ├─ fault 地址在序列化页       → 内存序列化等待
        └─ 都不是                    → 真正崩溃，生成 hs_err
```

这里最关键的顿悟是：

**SIGSEGV 本身没有“这是栈溢出”或“这是安全点”的语义。语义来自 HotSpot 对 fault 地址、当前线程、出错 PC 和上下文的联合解释。**

所以这篇不从“信号是什么”开始背 API，而是沿着一个信号进入 JVM 后的真实问题往下走：

> handler 手里到底有什么信息？它为什么必须按顺序判断？每个判断命中后，JVM 如何把一次硬件 fault 变成 Java 异常、线程暂停或崩溃报告？

---

## 一、统一 handler 手里拿到的不是“一个信号”，而是一份现场

### 1.1 `JVM_handle_linux_signal` 是解释器入口

HotSpot 在 Linux x86_64 下把主要判断集中在 `JVM_handle_linux_signal`，入口位于 `os_linux_x86.cpp:268` 附近。

这个函数收到的不是一个简单整数，而是一组现场信息：

- `sig`：信号编号，例如 `SIGSEGV`
- `siginfo_t`：包括 `si_code` 和 `si_addr`
- `ucontext_t`：fault 发生时保存的寄存器和程序计数器
- 当前线程：这个 fault 是哪条 Java/VM 线程产生的
- 当前 PC：哪一条机器指令触发了访问

其中 `si_addr` 只是“访问了哪个地址”，PC 才能告诉 JVM“是哪一条指令访问了它”。

这两个信息必须一起看。

同一个地址附近的 fault，如果来自不同机器指令，可能对应不同语义；同一条指令，如果访问的地址不同，也可能进入不同路径。

### 1.2 为什么判断顺序不能随便换

一个 fault 可能同时满足多个粗略条件。

例如：

- 某个保护页地址看起来也可能是低地址映射范围
- 某个异常现场可能发生在线程栈附近
- 某些未映射地址也可能落在某个特殊范围判断中

因此 handler 必须按设计好的优先级逐层排除：

```text
先判断 JVM 明确建立的保护区
    ↓
再判断 polling page
    ↓
再判断 JIT 能解释的隐式异常
    ↓
再判断序列化页
    ↓
最后才把它当成未知崩溃
```

如果一上来就把所有 `SIGSEGV` 交给 crash handler，栈溢出和 safepoint 都会变成崩溃。

如果一上来就把所有低地址 fault 都当成隐式空指针，真正的内存破坏又可能被错误吞掉。

所以这里的 handler 本质上是一个地址和上下文分类器。

### 1.3 先建立总路标

后面会分五段看，但每段都只回答同一组问题：

1. 谁制造了这次 fault？
2. fault 地址和 PC 有什么特征？
3. JVM 命中后把线程带到哪里？
4. 如果判断失败，为什么不能继续假装这是合法场景？

只要沿着这四问走，就不会被 `si_addr`、stub、mprotect 和信号链这些局部名词带偏。

---

## 二、第一分流：栈保护页如何变成 `StackOverflowError`

### 2.1 栈溢出不是“栈满了”这么简单

上一篇已经建立了线程栈的多级保护区。

线程继续向栈底增长时，最终会访问 `PROT_NONE` 页面，Linux 生成 `SIGSEGV`。此时 JVM 不能简单说“栈溢出，退出”，因为它还要区分：

- 现在是否仍有空间构造并抛出 `StackOverflowError`
- 还是连异常处理路径本身都已经没有安全余量

这就是为什么 handler 的第一阶段先检查 fault 地址是否落在当前线程的栈保护区域。

### 2.2 Yellow zone：把硬件 fault 翻译成 Java 异常

在 `os_linux_x86.cpp:357-397` 附近，HotSpot 会检查当前 fault 是否落在当前线程的 yellow/reserved 区域。

命中可恢复的保护区时，JVM 会：

1. 识别这是栈边界 fault，而不是任意非法访问
2. 调整栈保护状态，给异常处理路径留下可用空间
3. 设置栈溢出相关状态
4. 通过异常 continuation 进入 `StackOverflowError` 路径

这条路径的价值是：

```text
栈增长越界
    → Linux SIGSEGV
    → HotSpot 识别保护区
    → 暂时调整保护状态
    → Java 层看到 StackOverflowError
```

这不是“信号处理器直接 new 一个异常”这么简单。

信号处理阶段首先要把 CPU 上下文和线程状态调整到一个可以继续执行异常路径的位置，真正的异常对象创建和 Java 异常传播仍然要遵循 HotSpot 的运行时机制。

### 2.3 Red zone：什么时候不能再恢复

如果 fault 已经落到 red zone，说明前面的可恢复空间已经被消耗。

这时继续走普通异常路径存在一个明显风险：

- 构造异常需要栈
- 填充异常栈帧需要栈
- 进入运行时处理需要栈
- 处理 SIGSEGV 本身也可能需要调用链

如果这些空间已经没有，强行“优雅恢复”反而会再次 fault。

因此 red zone 的语义是不可恢复：HotSpot 进入 fatal 路径，并报告不可恢复的栈溢出。

这就是多级保护区和统一信号 handler 的第一个闭环：

**硬件只报告“访问权限错误”，保护区位置决定 JVM 是把它翻译成 Java 异常，还是承认已经无法恢复。**

---

## 三、第二分流：一个页面如何让所有 Java 线程看到 safepoint 请求

### 3.1 为什么不用每次轮询一个普通 flag

JVM 需要周期性地让 Java 线程检查：

> VM 现在是否要求你停下来？

最朴素的办法是在 JIT 代码中生成：

```text
读取一个共享 flag
如果 flag 表示 safepoint，就跳转到处理代码
```

但这条检查会出现在大量方法和循环里。

即使 safepoint 很少发生，正常运行路径也会不断付出：

- 一次共享内存读取
- 一次条件判断
- 可能的分支预测压力
- 额外的机器码空间

HotSpot 的办法是把“正常状态”做得尽量便宜，把“真的要停”时的异常成本集中支付：

```text
正常运行：polling page 可读，test 通过
请求 safepoint：polling page 改为 PROT_NONE
线程下一次 test：触发 SIGSEGV
handler：识别 polling page，转入 poll stub
```

### 3.2 polling page 是一个地址分类标签

HotSpot 在 `os.hpp:427-431` 附近保存全局 polling page，并通过地址范围判断它：

```cpp
// os.hpp:427-431
static address _polling_page;

static bool is_poll_address(address addr) {
  return addr >= _polling_page &&
         addr < (_polling_page + os::vm_page_size());
}
```

这里的关键不在“有一个 page”，而在于：

**这个页面的地址被 HotSpot 当成一种特殊事件编码。**

在典型的 x86 JIT poll 路径中，代码正常时只需要对这个地址做一次无分支访问。

当 VM 要求进入 safepoint，`os_linux.cpp:5720` 附近会通过 `guard_memory` 把 polling page 设为不可访问。

下一次 Java 线程执行 poll 指令，CPU 触发 `SIGSEGV`，handler 检查：

```text
si_addr 是否落在 polling page？
```

命中后，JVM 不把它当成崩溃，而是取出对应 poll stub，让线程进入 safepoint 协作路径。

### 3.3 `test [polling_page], rax` 为什么适合正常路径

x86 上，JIT 可以生成类似：

```text
test [polling_page], rax
```

这条指令的结果并不是为了计算业务值，唯一目的就是：

- 页面可读时，快速完成一次检查
- 页面不可读时，借助硬件 fault 把控制流交给 JVM

这形成一种非常有代表性的 JVM 设计：

```text
常态：一条便宜的内存访问
异常态：一次昂贵的信号与上下文切换
```

如果 safepoint 请求是低频事件，这种交换就很划算。

但不要把“正常路径 1 cycle”当成所有 CPU、所有代码布局下的固定测量值。它是一个解释设计倾向的量级示例，真实成本依赖 CPU、缓存、指令布局和内存系统状态。

### 3.4 handler 命中后发生了什么

在 `os_linux_x86.cpp:431` 附近，HotSpot 对 polling page 做专门判断，并通过 `SharedRuntime::get_poll_stub(pc)` 找到与当前 PC 对应的 poll stub。

随后线程不再沿着原来的普通机器码继续执行，而是进入 safepoint 相关的阻塞/协作逻辑。

这条路径和栈溢出有一个共同点：

- Linux 只负责产生 fault
- HotSpot 根据 fault 地址解释语义
- 解释成功后，跳转到预先准备好的 runtime continuation/stub

安全点并不是“SIGSEGV 发生了，线程就自动停住”。

真正的停顿协议还包括：

- VM 发起 safepoint 请求
- polling page 权限改变
- 各线程到达 poll 点
- 线程进入阻塞状态
- VM 操作执行
- polling page 恢复，线程继续运行

本篇只把信号分流讲到入口，完整的 safepoint 全局协议属于 `18-safepoint` 域。

---

## 四、第三分流：JIT 为什么敢不写显式 null check

### 4.1 显式判空当然能做，但常态路径会变胖

普通编译器可以把：

```java
value.field
```

翻译成：

```text
if value == null:
    跳到 NullPointerException
读取 value + field_offset
```

这个方案直观，也容易理解。

但在 Java 程序中，空指针通常是异常路径，不是每次访问的常态。

如果每次字段访问都显式生成比较和分支，所有正常访问都要为极少发生的异常支付机器码和控制流成本。

HotSpot 在满足平台条件时，选择另一条路：

```text
直接访问 object + offset
如果 object 是 null，访问落到低地址附近
Linux 生成 SIGSEGV
HotSpot 把它解释为隐式 null
```

### 4.2 `continuation_for_implicit_exception`

在 `os_linux_x86.cpp:483-485` 附近，handler 会检查：

- 当前信号是不是 `SIGSEGV`
- fault 地址是否属于需要显式 null check 的范围之外
- 当前 PC 是否能被解释为隐式异常位置

命中后，HotSpot 调用：

```cpp
stub = SharedRuntime::continuation_for_implicit_exception(
    thread, pc, SharedRuntime::IMPLICIT_NULL);
```

这里的 `stub` 不是“忽略错误继续执行”，而是把当前机器码现场转移到一个专门的异常 continuation，后续进入解释器/runtime 的异常处理路径。

所以真正的链条是：

```text
JIT 省掉显式判空分支
    → null + offset 访问低地址
    → SIGSEGV
    → handler 识别 IMPLICIT_NULL
    → continuation stub
    → Java 异常语义
```

### 4.3 这个优化为什么值得付出信号成本

显式方案的成本是每次访问都付出。

隐式方案把成本集中到真正出现空指针时：

- 正常字段访问没有额外的显式比较分支
- 真正空指针时，才进入信号、上下文和异常 continuation

这是一种典型的“异常稀少、正常访问极多”条件下的优化。

但必须明确边界：

- 不是所有地址 fault 都能当成隐式 null
- 不是所有平台都采用同样的隐式检查策略
- JIT 需要知道当前指令、访问地址和平台规则是否匹配

如果 handler 只看“地址很小”就把所有 fault 都翻译成 `NullPointerException`，真正的野指针或代码错误就会被伪装成 Java 异常，调试结果会完全失真。

因此这一阶段必须排在 polling page 之后，并且仍要结合 PC 和平台判断。

---

## 五、第四分流：memory serialize page 为什么也能使用 SIGSEGV

### 5.1 这不是普通业务页面

HotSpot 还维护一类特殊页面，用于某些平台上的内存序列化协调。

当 `UseMembar` 等策略选择页面方式时，JVM 会通过页面权限变化和 fault，让线程在特定点等待另一个线程完成全局协调。

handler 在 `os_linux_x86.cpp:508-510` 附近检查：

```text
当前 fault 地址是否是当前线程对应的 memory serialize page？
```

命中后进入 `block_on_serialize_page_trap()`，等待页面恢复，再继续原来的执行路径。

这和 safepoint 的相似点是：

- 都利用不可访问页面制造硬件 fault
- 都在 handler 中通过 fault 地址识别特殊语义
- 都把正常路径的检查成本压到很低

不同点是：

- safepoint 是 VM 对线程集合的全局协调
- serialize page 更偏向内存可见性/序列化机制的底层实现

### 5.2 为什么页面权限变化能参与跨 CPU 协调

这里必须把源码事实和硬件推导分开。

源码层面可以确认：

- JVM 会识别 serialize page
- 命中后线程进入 `block_on_serialize_page_trap()`
- 页面权限由 `mprotect` 等机制改变

从 Linux/x86 硬件机制看，权限变化可能触发页表和 TLB 相关同步，包括跨 CPU 的 TLB shootdown。这类同步为页面权限变化提供了全局可见的顺序基础。

但不能把它简单写成：

> `mprotect` 本身就等价于任意场景下的完整内存栅栏。

实际语义依赖 HotSpot 的使用方式、Linux 内核实现和目标 CPU 内存模型。

因此本篇只保留稳固结论：

**HotSpot 可以把“页面权限恢复”作为线程继续运行的条件，从而把一次 fault 变成一次等待和序列化点。**

### 5.3 为什么要按线程区分页面

如果所有线程都访问同一个 serialize page，多个线程在切换权限时会争抢同一块共享状态，可能增加 cache line 和同步压力。

HotSpot 为线程计算独立的页面偏移，让不同线程在可能的情况下使用不同位置。

这体现了一个熟悉的底层设计：

- 语义上都是“序列化页”
- 物理布局上尽量分散到不同 cache line
- 避免把所有线程的协调压力集中到一个地址

---

## 六、第五分流：剩下的才是真正崩溃

### 6.1 为什么未知 fault 不能强行恢复

如果当前 fault：

- 不在栈保护区
- 不在 polling page
- 不是可识别的隐式异常
- 不在 memory serialize page

那 JVM 就没有足够证据把它解释成自己的合法机制。

这时最危险的做法是“先尝试恢复看看”。

因为未知 fault 可能意味着：

- 野指针
- 越界写破坏后的二次访问
- 共享库错误
- JIT 生成代码或运行时状态已经损坏
- 外部 native 代码破坏了堆栈

如果 JVM 把未知 fault 吞掉，程序可能带着已经损坏的状态继续运行，最终在更远处以更难诊断的方式崩溃。

因此最后分流必须保守：

```cpp
VMError::report_and_die(t, sig, pc, info, ucVoid);
```

源码位置在 `os_linux_x86.cpp:617` 附近。

### 6.2 hs_err 为什么要在最坏现场工作

崩溃处理时，普通业务代码赖以生存的前提可能都已经不存在：

- 堆可能被破坏
- 锁状态可能不可信
- 当前线程栈可能接近边界
- malloc 可能再次触发内部错误

所以 hs_err 生成路径必须尽量使用低依赖的方式收集现场，记录：

- PC 和寄存器
- 当前线程栈
- 其他线程信息
- `/proc/self/maps`
- 动态库和内存映射
- 崩溃信号与 fault 地址

这就是为什么 `hs_err_pid.log` 往往比业务日志更接近事故现场。

它不是为了“让程序继续”，而是为了在程序无法继续时保留足够证据。

---

## 七、libjsig：JVM 不是唯一想处理信号的人

### 7.1 如果 profiler 也要 SIGSEGV 怎么办

JVM 不是进程里唯一可能安装信号 handler 的组件。

Profiler、agent、native 库也可能需要处理信号。如果后安装的 handler 直接覆盖先安装的 handler，就会出现：

- JVM 的隐式 null 机制失效
- profiler 的采样信号失效
- 某个库的恢复逻辑被覆盖

所以 HotSpot 通过 libjsig 提供 signal chaining 机制。

### 7.2 `sigaction` 拦截与链式保存

Linux 动态链接器支持 `LD_PRELOAD`。

如果进程预加载 `libjsig.so`，libjsig 可以先拦截 `sigaction` 调用，保存已有 handler，再让 JVM 安装自己的 handler。

HotSpot 在 `os_linux.cpp:5177` 附近通过 `dlsym(RTLD_DEFAULT, "JVM_begin_signal_setting")` 判断 libjsig 是否存在：

```cpp
begin_signal_setting = CAST_TO_FN_PTR(...,
    dlsym(RTLD_DEFAULT, "JVM_begin_signal_setting"));

if (begin_signal_setting != NULL) {
  libjsig_is_loaded = true;
}

if (libjsig_is_loaded) {
  (*begin_signal_setting)();
}
```

随后 JVM 安装自己的 SIGSEGV、SIGBUS、SIGPIPE、SIGILL、SIGFPE 等 handler。

当事件不属于 JVM 能识别的场景时，JVM 再把控制权交给链上的 handler。

所以 signal chaining 不是“多个 handler 同时执行”，而是：

```text
保存旧 handler
    ↓
JVM 先判断自己的合法场景
    ↓
不属于 JVM 的事件再交给链上的其他 handler
```

第三方 handler 是否安全、是否遵守信号处理限制，仍然是第三方自己的责任。

### 7.3 `kill -3` 为什么会得到线程转储

Linux 下 `kill -3` 发送的是 `SIGQUIT`。

普通程序默认可能因为 SIGQUIT 退出并生成 core，但 JVM 会注册自己的 SIGBREAK/SIGQUIT 处理逻辑。

HotSpot 中 `SIGBREAK` 是 `SIGQUIT` 的别名，处理分支会触发线程转储。

因此：

```text
kill -3 <pid>
    → Linux 发送 SIGQUIT
    → JVM 自己的 signal handler 收到
    → 输出所有线程栈
    → 进程不按默认行为退出
```

这也是“线程转储不是 jstack 进程直接读取出来的”这一事实的重要补充：不同工具路径可能不同，但 JVM 自己确实可以通过信号触发 ThreadDump。

---

## 八、把五阶段收成一张地址分类器

现在回到 `JVM_handle_linux_signal`。

它不是在执行一个“收到 SIGSEGV 就崩溃”的分支，而是在执行一套地址和上下文分类：

```text
输入：sig + si_addr + pc + 当前线程 + ucontext

1. si_addr 在当前线程栈保护区？
   → StackOverflowError 或不可恢复栈溢出

2. si_addr 是 polling page？
   → poll stub → safepoint 协作

3. si_addr 与 pc 符合隐式异常规则？
   → IMPLICIT_NULL continuation

4. si_addr 是当前线程的 serialize page？
   → 等待页面恢复

5. 以上都不是？
   → VMError::report_and_die → hs_err
```

本文聚焦的五个阶段有一个共同点：

- 事件都由硬件 fault 触发
- 正常路径不需要频繁执行复杂检查
- 进入 handler 后，JVM 用现场信息重新解释 fault
- 只有能被明确解释的 fault 才会恢复
- 未知 fault 必须保守地报告并终止

这就是本篇真正的设计顿悟：

**在本文聚焦的这些路径里，JVM 把页面权限和低地址访问当成事件编码，把 SIGSEGV 当成统一入口，再用 fault 地址和上下文把它还原成具体语义；而完整 handler 还会继续处理 SafeFetch、JNI fast get、unsafe access 等其他平台路径。**

### 误解一：SIGSEGV 在 JVM 里不再代表错误

不是。

JVM 只是主动使用了部分 SIGSEGV 场景。未知 fault 仍然会进入 fatal crash 路径。

### 误解二：只要 fault 地址在 polling page，就一定是 safepoint

不能只看地址。

真实 handler 还需要结合信号类型、线程、PC 和当前运行时上下文；地址只是分类器的重要输入，不是脱离上下文的充分证明。

### 误解三：隐式 null check 是把错误吞掉

不是。

它只是把“显式比较失败”换成“硬件 fault + continuation”，最终仍然要回到 Java 的异常语义。

### 误解四：libjsig 让多个 handler 可以随便共存

不是。

它提供保存和转发机制，但信号处理顺序、异步信号安全和第三方 handler 的正确性仍然需要各方遵守约束。

### 误解五：页面权限变化就是通用内存屏障

不能这么泛化。

本文只能确认 HotSpot 使用特殊页面和 fault 作为序列化路径；更底层的内存顺序语义必须结合具体 CPU、Linux 和 HotSpot 实现分析。

---

## 九、收网：一个 SIGSEGV，五种语义，背后是一套“正常路径便宜、异常路径集中”的设计

回到开头的问题：

为什么同一个 `SIGSEGV` 能完成五件完全不同的事情？

因为 JVM 不是让信号自己“知道含义”，而是提前布置了可识别的地址边界：

- 栈保护页代表栈资源耗尽
- polling page 代表 VM 要求线程到达 safepoint
- 低地址 fault 代表 JIT 省掉的隐式 null check
- serialize page 代表线程需要等待内存序列化条件
- 其他地址则不属于 JVM 可解释的合法机制

如果把整篇压缩成三句话：

- SIGSEGV 只是硬件报告，HotSpot 通过 `si_addr`、PC、线程和上下文给它赋予语义
- JVM 把低频事件的复杂成本集中到 fault handler，换取正常路径上的廉价检查
- 能解释的 fault 才恢复，不能解释的 fault 必须进入 `hs_err`，否则错误会被掩盖成更大的事故

这也解释了下一篇为什么要从 Assembler 开始。

本篇反复出现的 polling 指令：

```text
test [polling_page], rax
```

只有几个字节，却承担了“让每个 Java 线程低成本检查 VM 状态”的任务。

它不是凭空出现的。

下一篇要继续拆：

- 抽象汇编器如何组织指令
- CodeBuffer 如何保存机器码
- x86 assembler 如何把 `test` 这样的抽象动作编码成真正的字节

> → 域 02 [Assembler — `test [polling_page], rax` 这 4 字节是怎么生成的](openjdk/vol-02/02-assembler/01-codebuffer-abstract-assembler.md)
