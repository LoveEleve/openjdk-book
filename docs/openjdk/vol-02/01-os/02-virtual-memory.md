# 02. `16G` 堆为什么有时能在 `8G` 机器上启动？— 虚拟内存、大页面与栈保护

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论
> 本文讨论的是 HotSpot 在 Linux 上的实现，不等于所有 JVM 或所有操作系统的统一行为；uncommit、大页面和容器统计的具体细节以所选 11u 更新版本源码为准
> **前置依赖**：[01 — 平台探测](01-platform-detection.md)：JVM 先确认自己能看到多少资源
> → **后续**：[03 — 线程与同步](03-threads-and-sync.md)：线程栈如何创建，以及谁在使用这些栈
> 关联域：09-memory-core、10-metaspace、16-code-cache、26-g1-gc、34-nmt
> 工具实证：[卷 T ch05](openjdk/vol-tools/ch05.md) 的 GC Configuration 页

## 先看一个像违反常识的现场

在一台只有 `8GB` 物理内存的机器上启动：

```text
-Xmx16g
```

程序没有立刻报错。

再用 `ps` 或监控工具看进程：

- VSZ 可能已经接近 `16GB` 甚至更大
- RSS 却可能只有几百 MB，或者只是实际已经触碰到的那一小部分

很多人第一次看到这个现象，会先怀疑监控错了：

“堆都 16GB 了，机器才 8GB，为什么物理内存没有马上爆？”

另一个常见猜测是：

“JVM 是不是偷偷把 16GB 压缩了？或者 `-Xmx` 只是一个建议值？”

都不是。

真正发生的事情是：**虚拟地址空间的占有，和物理内存的兑现，被操作系统拆成了两个不同动作。**

JVM 正是利用了这条边界：先向操作系统预订一段地址范围，后面真正用到哪一部分，再逐步让那一部分变得可访问并兑现物理页。

如果把一个进程的地址空间想成一座还没有完全入住的城市，那么：

- `reserve` 是先把地块圈给 JVM
- `commit` 是给某些地块通水通电，让它们可以真正使用
- `uncommit` 是把已经不用的房屋拆掉，但保留规划好的地块
- `release` 是连地块也退回给操作系统

先把这四个动作画出来：

```text
地址空间的生命周期：

reserve
  地址范围归 JVM
  但页面仍然不可访问
      │
      ▼
commit
  指定范围变得可访问
  物理页按需兑现，或被 pre-touch 提前兑现
      │
      ▼
uncommit
  撤回物理页/访问权限
  地址范围继续保留
      │
      ▼
release
  地址范围本身也归还给 OS
```

这四个动作不是某个 GC 的小技巧，而是 HotSpot 内存子系统的地基：

- GC 堆需要它来管理大块连续地址空间
- Metaspace 需要它来按块扩张和回收
- CodeCache 需要它来保留代码区域的地址布局
- NMT 需要它来追踪不同区域的虚拟内存与物理兑现

但这篇还不止讲“四态”。

同一套“先划边界，再按需兑现，再在失败时快速暴露”的思想，还会出现在两个地方：

- 大页面：优化地址翻译成本，但不能破坏 GC 的管理边界
- 栈保护：提前划出不可访问区域，让栈溢出时还有机会构造异常、执行信号处理

所以这篇真正要讲的不是“虚拟内存是什么”，而是：

**JVM 如何把一块地址空间变成可管理、可回收、可优化、可失败的运行时内存。**

---

## 一、JVM 为什么不直接 `malloc(16GB)`

### 1.1 最朴素的办法为什么不够

假设 JVM 要建立一个 16GB 的堆，最直觉的写法是：

```text
malloc(16GB)
```

这看起来很简单，但它同时违反了 JVM 的几个核心要求。

第一，JVM 不想在启动时立刻兑现全部物理页。

堆的最大值是一个上限，不代表程序一启动就会把整块空间写满。如果启动阶段就要求操作系统准备好 16GB 物理内存，那么：

- 8GB 物理机无法容纳 16GB 的即时兑现
- 容器只给 2GB 内存时，默认堆很容易越过 cgroup 限额
- 一个还没有真正使用的上限，提前变成了真实资源承诺

第二，JVM 管理的不只有一个堆。

它至少还要分别管理：

- Java heap
- Metaspace
- CodeCache
- 线程栈
- 一些 GC 辅助结构
- 本地分配与映射区域

这些区域生命周期不同、权限不同、回收时机不同。

如果所有东西都塞进 `malloc/free` 这一套模型里，JVM 很难做到：

- 堆可以单独扩大和收缩
- CodeCache 可以保留特定地址范围
- 未提交区域不能被误访问
- 回收物理页但保留虚拟地址布局

第三，JVM 很多数据结构依赖稳定的地址布局。

以按 region 管理的堆为例，GC 需要把一大片连续地址切成规则区域，然后通过地址快速映射到对应 region。`malloc` 返回的是一块“当前足够大的内存”，但它不是 JVM 想要的那种可分阶段管理、可独立回收、布局稳定的地址空间抽象。

因此，JVM 需要的不是“给我一块内存”，而是：

**给我一片我能自己管理生命周期的地址空间。**

Linux 下，这个请求的主要入口不是 `malloc`，而是 `mmap`。

### 1.2 四态不是四个同义词

在进入源码前，先把几个容易混淆的概念分开：

| 状态 | JVM 拥有什么 | 页面能否访问 | 物理页是否必须已驻留 |
|---|---|---|---|
| reserve 后 | 地址范围 | 通常不能访问 | 不要求 |
| commit 后 | 地址范围 + 可访问映射 | 可以访问 | 可能按需建立 |
| uncommit 后 | 地址范围 | 恢复为不可访问 | 对应物理页可被撤回 |
| release 后 | 什么也不保留 | 不存在这段映射 | 已归还 |

这里最容易犯的错误是把 `commit` 直接等同于“物理页已经全部在 RAM 里”。

更准确地说，`commit` 首先建立的是：

- 这段地址应该由 JVM 使用
- 这段地址具备相应访问权限
- 操作系统可以在后续访问时为它兑现页

如果 JVM 再使用 `pre-touch`，才会主动逐页访问，把 page fault 的成本提前支付。

所以要记住：

**地址空间占有、访问权限、物理页驻留，是三个相关但不能混成一个概念的层次。**

---

## 二、reserve：先圈地址，再把它锁成不可访问

### 2.1 reserve 到底在向操作系统要什么

reserve 阶段的目标不是“马上拿到 16GB 物理内存”，而是：

> 请操作系统把这段连续的虚拟地址范围留给 JVM；在 JVM 明确 commit 之前，任何代码都不能把它当成可用内存访问。

Linux 实现集中在 `anon_mmap`：

```cpp
// os_linux.cpp:3838 起（截取核心）
static char* anon_mmap(char* requested_addr, size_t bytes, bool fixed) {
  char* addr;
  int flags;

  flags = MAP_PRIVATE | MAP_NORESERVE | MAP_ANONYMOUS;
  if (fixed) {
    assert((uintptr_t)requested_addr % os::Linux::page_size() == 0,
           "unaligned address");
    flags |= MAP_FIXED;
  }

  addr = (char*)::mmap(requested_addr, bytes, PROT_NONE,
                       flags, -1, 0);
  ...
}
```

这段实现需要拆成三个问题看。

### 2.2 `MAP_ANONYMOUS`：这不是文件映射

`MAP_ANONYMOUS` 表示这段映射不对应一个普通文件。

JVM 要的是进程自己的匿名内存区域，不是把某个文件内容映射进地址空间。

这很重要，因为 Java heap、线程栈、Metaspace 的生命周期都由 JVM 管理，不应该绑定到一个文件的大小和内容。

### 2.3 `MAP_NORESERVE`：地址先占着，交换空间不要现在就全记账

`MAP_NORESERVE` 允许 JVM 先建立一段“不等于立即承诺同等物理资源”的映射。

它解决的是开头那个反直觉现场：

- `-Xmx16g` 可以先对应一大片虚拟地址范围
- 但启动时不要求操作系统立刻准备 16GB 的物理页和 swap backing
- 只有后续真正 commit、真正访问时，物理资源压力才逐步显现

这里必须谨慎：`MAP_NORESERVE` 不是“物理内存不存在也没关系”，更不是“未来一定能成功”。

它只是把资源兑现时间推迟了。

当 JVM 后面真正需要 commit，或者访问已经提交的页面时，操作系统仍然可能因为：

- 物理内存不足
- swap 不足
- overcommit 策略严格
- 地址空间冲突

而让操作失败。

Linux 的 overcommit 策略会影响 reserve 是否容易成功：

- heuristic 模式会做估算
- always 模式更宽松
- strict 模式会更早拒绝无法兑现的承诺

因此，“16GB 地址空间能在 8GB 机器上 reserve 成功”是一个实现和内核策略相关的事实，不应该写成任何 Linux 配置下的绝对保证。

### 2.4 `PROT_NONE`：为什么未 commit 的区域必须不能碰

reserve 的另一个关键参数是 `PROT_NONE`。

它告诉内核：

> 这段映射存在，但当前不允许读，也不允许写。

这一步看似保守，实际上是 JVM 的安全边界。

假设 reserve 阶段只建立地址范围，却把权限设成可读写。那会出现一个危险问题：

- 某段代码错误地把“已经 reserve、尚未 commit”的地址当成可用内存
- CPU 访问这段地址
- 内核可能因为某些 overcommit 或 backing 条件，让访问暂时看起来成功
- 错误在更晚、更远的地方才暴露

这类错误最难排查，因为“越界访问”不会在边界第一时间停下来。

`PROT_NONE` 则把规则钉死：

- reserve 只是占地址
- commit 之前就是不可访问
- 谁提前碰，谁立刻收到 page fault，最终进入 SIGSEGV 路径

这就是“失败要快”。

注意它和普通崩溃的关系：

- 在 reserve/uncommit 区域里误访问，会触发保护机制
- JVM 的信号处理器会尝试判断这是不是某种已知场景
- 如果不是 JVM 能解释的合法 fault，才会落入真正的崩溃报告路径

下一篇信号文章会详细讲这个分发过程；本篇只需要把边界记住：

**不可访问权限不是 reserve 的副作用，而是 JVM 用来阻止错误越过生命周期边界的主动设计。**

### 2.5 为什么不用 `brk`

`brk` 更接近传统 C 运行时的进程堆扩张：沿着一个连续的 data segment 往后长。

但 JVM 的内存区域不是一个“大家共用的一条 C 堆”：

- Java heap 需要自己的地址范围
- Metaspace 需要自己的地址范围
- CodeCache 需要不同的权限和生命周期
- 线程栈需要各自独立的映射与保护页

`mmap` 允许每个区域独立 reserve、commit、uncommit 和 release，`brk` 不适合表达这种多区域生命周期。

### 2.6 为什么不用 `malloc`

`malloc` 的抽象是“返回一块当前可用的进程内存”，它把很多平台细节交给 glibc 管理。

而 JVM 需要自己知道：

- 这段地址从哪里开始
- 这段地址多大
- 哪些页已经 commit
- 哪些页可以 uncommit
- 哪些区域必须保持连续
- 哪些区域需要特殊权限

尤其对需要稳定地址布局的 GC 堆来说，JVM 不能只满足于“拿到一块足够大的空间”。它需要一套能按地址映射 region、能控制页权限、能反复撤回和兑现的机制。

因此 `malloc` 不是完全不能用，而是不适合作为 HotSpot 主要的区域生命周期抽象。

这一节先停一下：

**reserve 的核心不是“申请内存”，而是“先把地址边界立起来，并把未兑现区域锁成不可访问”。**

---

## 三、commit：地址有了，什么时候才算真的能用

### 3.1 commit 不是简单地“再申请一遍”

reserve 之后，JVM 手里有了一段地址范围，但这段范围仍然是 `PROT_NONE`。

接下来如果 GC 堆要开始使用其中一部分，JVM 必须向操作系统表达：

> 这一段地址现在进入可用状态，请把它变成可读写映射。

Linux 下的核心实现是 `commit_memory_impl`：

```cpp
// os_linux.cpp:3211 起（核心）
int os::Linux::commit_memory_impl(char* addr, size_t size, bool exec) {
  int prot = exec ? PROT_READ|PROT_WRITE|PROT_EXEC
                  : PROT_READ|PROT_WRITE;
  uintptr_t res = (uintptr_t)::mmap(
      addr, size, prot,
      MAP_PRIVATE|MAP_FIXED|MAP_ANONYMOUS, -1, 0);
  ...
}
```

它和 reserve 的共同点是：都在调用 `mmap`。

区别在于：

- reserve 建立的是 `PROT_NONE` 的不可访问边界
- commit 用指定权限重新建立可访问映射
- commit 通过 `MAP_FIXED` 把这段映射放回已经预留的地址

所以 commit 并不是“从任意地方再拿一块内存”，而是：

**把先前圈好的那块地，切换成 JVM 当前允许使用的状态。**

### 3.2 `MAP_FIXED` 为什么危险，HotSpot 为什么还敢用

`MAP_FIXED` 的语义很强：映射必须放在调用者指定的地址。

如果目标地址原本已经有别的映射，`MAP_FIXED` 可能直接替换它。

这对普通应用程序非常危险。

HotSpot 之所以能使用它，是因为它遵守了一个严格前提：

```text
先 reserve 一整段地址
确认这段范围归 JVM 所有
只在这段已知范围内 commit
```

也就是说，`MAP_FIXED` 不是独立安全的；它的安全性来自前面的地址所有权建立。

如果绕过 reserve 直接对任意地址使用 `MAP_FIXED`，可能把：

- 共享库映射
- 其他 mmap 区域
- 线程相关区域

直接覆盖掉。

这也是四态设计的一个隐藏价值：

**前一个状态为后一个状态提供前置条件。**

reserve 不只是为 commit 找地址，它还建立了“这里是谁的地盘”这一事实。

### 3.3 commit 成功，物理页是不是已经全部在 RAM 里

这里必须把三个层次分开：

1. 地址范围已经存在
2. 地址范围权限已经打开
3. 对应物理页已经实际驻留

commit 主要解决前两件事。

对匿名内存来说，物理页通常会在第一次真正访问时通过 page fault 逐步兑现：

```text
CPU 访问某个已 commit 地址
    │
    ▼
页表发现当前页尚未建立有效映射
    │
    ▼
CPU 触发 page fault
    │
    ▼
内核分配/清零/映射物理页
    │
    ▼
重新执行刚才那条指令
```

因此，commit 后 RSS 不一定马上等于 commit 的总容量。

这正是 VSZ 和 RSS 能够暂时分离的原因：

- VSZ 反映进程地址空间中已经建立的映射范围
- RSS 反映当前实际驻留在物理内存中的页面

但这也意味着：第一次访问某个区域时，应用线程可能需要承担 page fault 成本。

### 3.4 pre-touch：为什么要主动把 page fault 的账提前付掉

JVM 有时不希望让 GC 或业务第一次访问页面时才临时付这个成本。

假设一个新提交的堆区域很大，GC 后面要遍历它。如果 page fault 全部集中在第一次扫描过程中，停顿时间就会受到页面建立成本的影响。

HotSpot 提供了 `pretouch_memory`：

```cpp
// os.cpp:1873
void os::pretouch_memory(void* start, void* end, size_t page_size) {
  for (volatile char* p = (char*)start; p < (char*)end; p += page_size) {
    *p = 0;
  }
}
```

它做的事情很朴素：按页写一下。

这次写入的目的不是业务初始化，而是主动触发每一页的 page fault，让内核现在就建立对应页面。

`volatile` 的作用也很实际：告诉编译器这次写入不可随意删除，循环必须真的执行。

pre-touch 是一个典型的成本搬移：

- 不开启时：运行期第一次触碰页面，成本分散到业务或 GC 路径
- 开启时：启动期或扩容期集中触碰，运行期页面访问更稳定

它不是免费优化。

如果你 pre-touch 一个很大的堆，启动阶段就会：

- 触碰大量页面
- 消耗真实物理内存
- 付出大量 page fault 和清零成本

所以它的真正目标不是减少总成本，而是把不可预测的运行期成本转换成更可控的启动/扩容成本。

这里要修正一个常见的过度说法：

**pre-touch 不能保证所有 page fault 成本都消失，它只是把首次触碰的部分成本主动前置。**

---

## 四、uncommit 与 release：回收时到底还给操作系统什么

### 4.1 物理页不要了，地址布局还想保留

GC 的世界里，“这块内存暂时不用了”和“这个地址范围以后永远不再属于我”不是一回事。

例如一个堆区域在当前阶段没有存活对象，JVM 可能希望：

- 把这部分物理页还给操作系统
- 降低 RSS 和内存压力
- 但保留整个堆的虚拟地址布局
- 后面需要时，再在原地址重新 commit

这就是 `uncommit` 的价值。

如果每次回收都直接 `release`，地址空间就会被拆碎。后面重新扩张时：

- 可能找不到连续地址
- region 到地址的映射关系更复杂
- 元数据和指针布局更难保持稳定
- 大区域重新拼装成本更高

所以 uncommit 和 release 必须分开：

```text
uncommit：我暂时不用这些页，但这块地址仍然是我的规划
release：我连这块地址规划也不要了
```

### 4.2 OpenJDK 11u Linux 实现：uncommit 重映射回 `PROT_NONE`

当前讨论的 Linux 实现中，uncommit 不是简单调用 `madvise(MADV_DONTNEED)`，而是重新用 `mmap` 把这段地址映射成 `PROT_NONE`：

```cpp
// os_linux.cpp:3642
bool os::pd_uncommit_memory(char* addr, size_t size) {
  uintptr_t res = (uintptr_t)::mmap(
      addr, size, PROT_NONE,
      MAP_PRIVATE|MAP_FIXED|MAP_NORESERVE|MAP_ANONYMOUS,
      -1, 0);
  return res != (uintptr_t)MAP_FAILED;
}
```

这一动作同时完成两件事：

- 原来的可访问映射被替换，物理页可以被撤回
- 这段地址恢复成 `PROT_NONE`，再次变成不可访问

这和 reserve 的安全语义重新接上了：

```text
reserve：PROT_NONE
commit：可读写
uncommit：PROT_NONE
```

也就是说，未兑现区域和已经撤回区域共享同一个“不可访问”状态。

这带来一个很强的边界保证：

- 代码不能把 uncommit 区域误当成仍可用的旧内存
- 如果错误访问，尽早进入 fault 路径
- 后续重新 commit 时，JVM 再明确打开权限

而 `release` 走的是 `munmap` 路径：

- 地址空间本身撤销
- 物理页和映射一起归还
- 后续 JVM 不能再假设这段地址仍属于自己

### 4.3 为什么不能把 uncommit 和 release 合成一个动作

失败方案看起来很简单：不用的区域一律 `munmap`，以后需要再申请。

但它会把地址空间管理变成“不断拆掉、不断重新拼装”：

- 重新申请不保证拿回同一段地址
- 连续大区域可能被其他 mmap 碎片化
- 依赖地址规律的数据结构需要反复更新
- GC 的 region 边界和元数据映射变得更难维护

JVM 选择 uncommit，不是为了省一个系统调用，而是为了把两个生命周期问题分开：

- 物理资源是否暂时占用
- 地址所有权是否彻底结束

这也是为什么四态不是四个 API 名字，而是一套资源状态机。

---

## 五、大页面：地址翻译优化为什么会和 GC 边界发生冲突

### 5.1 JVM 为什么在乎页大小

CPU 访问虚拟地址时，不能直接把虚拟地址当物理地址用。

它要先通过页表完成转换。为了不让每次内存访问都走完整页表，CPU 会缓存最近使用过的虚拟地址到物理地址映射，这个缓存就是 TLB。

页越小，同样大小的堆需要的页越多；页越多，TLB 覆盖范围越容易不够。

举一个量级示例：

- `2GB / 4KB` 约等于 `524288` 个页
- `2GB / 2MB` 约等于 `1024` 个页

大页面用更少的页覆盖同样地址范围，因此可能减少 TLB miss 和页表遍历压力。

但这里的“可能”必须保留。

真实收益还取决于：

- CPU 的 TLB 层级与容量
- 访问是否具有局部性
- 工作集大小
- 内核是否真的成功建立大页
- GC 是否频繁拆分或回收这些页面

所以不能把“2MB 页一定比 4KB 页快”写成普遍真理。

HotSpot 会维护页面大小列表，并根据 region 大小、最小页数等约束选择适配的页面：

- `_page_sizes` 保存候选页面大小
- `page_size_for_region()` 根据区域参数选择页面

这说明大页面不是一个简单的全局开关，而是地址区域选择的一部分。

### 5.2 三条大页面路径，各自承担什么代价

#### hugetlbfs

通过挂载的 hugetlbfs 文件系统映射大页。

它的优势是语义明确、页大小确定；代价是需要系统预先配置 huge page 池，池用完就可能失败，并且这些页通常不能像普通页一样灵活换出。

#### System V SHM

通过 `shmget(SHM_HUGETLB)` 和 `shmat` 使用带大页属性的共享内存。

它依赖另一套系统接口和权限配置，适用边界与 hugetlbfs 不同。

#### THP

通过 `madvise(MADV_HUGEPAGE)` 告诉内核：这片区域适合尝试透明大页。

后续由内核线程异步扫描、合并连续小页。

THP 的优点是应用不必预先准备固定 huge page 池，代价是：

- 是否成功由内核策略决定
- 合并和拆分可能在运行期发生
- 应用的逻辑边界未必等于内核的大页边界

### 5.3 为什么大页面可能和 G1 region 打架

G1 管理堆时有自己的 region 边界。

但 THP 关注的是虚拟地址上是否存在足够大的连续页面，它不天然理解“这几页属于 Old region，那几页属于 Young region”。

于是可能出现这种关系：

```text
G1 视角：
[Old region][Young region][Old region]

THP 视角：
[          一个连续的 2MB huge page          ]
```

如果这种跨越多个 region 的大页确实形成，而 G1 又要独立回收其中一部分 region，那么从 Linux 页管理与 G1 region 管理的边界推导，底层大页可能需要拆分、更新页表或重新建立小页映射。这里是基于两套边界的潜在冲突分析，不是本文所依据的 HotSpot 源码直接证明每次都会发生的固定结果。

可能出现的额外成本包括：

- 页表更新
- TLB 失效通知
- 拆页过程中的同步和内核开销
- 回收路径中额外的 fault 或映射工作

所以“大页面优化”不是无条件正收益。

一个看似简单的失败方案是：

> 既然大页面能减少 TLB miss，那就对整个 Java heap 无条件打开 THP。

问题在于，JVM 的堆不是一块永远整体使用、整体释放的数组。

它有 region、分代、回收、迁移、重映射等自己的边界。如果底层大页跨越这些边界，某些 GC 动作就可能为了维护自己的局部生命周期而付出拆分成本。

这就是一个很典型的系统设计冲突：

- CPU 希望页面尽量大，减少地址翻译
- GC 希望回收边界足够细，独立管理 region
- 内核只看虚拟地址连续性，不理解 JVM 的 region 语义

真正的工程选择不是“永远大页”或“永远小页”，而是根据平台、工作负载、GC 实现和内核行为做权衡。

---

## 六、栈保护：为什么 JVM 连“失败时怎么失败”都要提前分配空间

### 6.1 栈溢出不是一个瞬间，而是一段失败过程

前面讲堆时，我们说 JVM 会先 reserve，再 commit，再在需要时使用页面。

线程栈也有类似的边界思想，但它更强调另一个问题：

**如果栈已经快耗尽了，JVM 还要不要有空间构造 `StackOverflowError`，执行异常路径和信号处理？**

如果答案是“完全没有空间”，那么栈溢出的处理本身就可能再次栈溢出，最后只能直接把进程打死。

因此 HotSpot 会在每个 Java 线程栈的边界附近划出多级保护区。

以 x86 栈向低地址增长为例：

```text
高地址
  业务栈帧
  Yellow zone       → 进入后仍有机会抛 StackOverflowError
  Red zone          → 不可恢复，进入 fatal 路径
  Reserved zone     → 为异常处理保留的余量
  Shadow zone       → 为信号处理器和调用链保留的余量
低地址
```

这里不要把 zone 理解成四块普通业务内存。

它们本质上是四层“失败边界”：

- Yellow：第一次越界预警，仍要保留恢复能力
- Red：连正常恢复所需空间也已经耗尽
- Reserved：保证异常处理路径还有一块可用余量
- Shadow：为从 Java 栈进入 VM/native 调用以及相关异常处理路径预留最低限度的栈空间

### 6.2 `mprotect(PROT_NONE)` 如何把栈增长变成可识别事件

这些保护区不会靠 Java 代码每次检查栈指针来实现。

HotSpot 更接近操作系统的做法：用 `mprotect(PROT_NONE)` 把保护区设成不可访问。

当线程继续向栈底增长，写入落到保护区时：

```text
线程继续压栈
    │
    ▼
访问 Yellow/Red 等 PROT_NONE 页面
    │
    ▼
CPU 触发 page fault
    │
    ▼
Linux 生成 SIGSEGV
    │
    ▼
JVM 信号处理器查看 fault 地址
    │
    ├─ Yellow：切入 StackOverflowError 路径
    └─ Red：进入不可恢复 fatal 路径
```

本篇只负责讲清楚：

- 保护区在什么位置
- 它们为什么不可访问
- 不同保护区表达什么失败状态

下一篇信号文章再详细讲 JVM 如何从同一个 SIGSEGV 里区分栈溢出、安全点、隐式空指针和真正崩溃。

### 6.3 为什么一个保护页不够

最简单的设计是：

> 栈底放一页 `PROT_NONE`，碰到就抛 `StackOverflowError`。

它的问题是把所有失败都当成一种情况。

但真实的栈溢出至少有三个不同阶段：

1. 栈快满了，但异常对象和异常调用链还能运行
2. 处理异常本身需要的空间也不足
3. 连底层信号处理和错误报告都可能没有足够栈空间

如果只有一个保护页，JVM 很难同时保证：

- 正常的 `StackOverflowError` 能构造出来
- 严重溢出时不会继续执行不安全的恢复逻辑
- 信号处理路径有最低限度的运行空间

所以多级 zone 不是过度设计，而是把“可恢复失败”和“不可恢复失败”分开。

这体现了一个非常通用的系统原则：

**失败路径也需要资源；如果希望失败时还能给出有意义的结果，就必须提前为失败预留空间。**

### 6.4 `guard_memory` 与 `unguard_memory`

HotSpot 在 Linux 下用 `mprotect` 封装保护区的权限切换：

```cpp
// os_linux.cpp:3944-3950
bool os::guard_memory(char* addr, size_t size) {
  return linux_mprotect(addr, size, PROT_NONE);
}

bool os::unguard_memory(char* addr, size_t size) {
  return linux_mprotect(addr, size, PROT_READ|PROT_WRITE);
}
```

Java 线程创建栈保护页时，`create_stack_guard_pages()` 会先确定栈底地址和 guard zone 大小，再调用 `guard_memory()` 把这段区域设成 `PROT_NONE`。线程退出时，`remove_stack_guard_pages()` 才负责移除这组基础 guard pages。

Yellow、Reserved、Red 并不是“创建后永远一起保持同一种状态”。HotSpot 会根据异常处理阶段切换其中部分区域：

- 进入栈溢出处理时，可以暂时解除 Yellow 或 Reserved 区域的保护，让异常路径获得空间
- 处理完成后，再通过对应的 enable 方法重新设置保护
- Red zone 的启用和解除有独立路径，不能简单归并成 Yellow 的行为

源码里的 `enable_stack_reserved_zone()`、`disable_stack_reserved_zone()`、`enable_stack_yellow_reserved_zone()`、`disable_stack_yellow_reserved_zone()` 正是这套状态变化的证据，见 `thread.cpp:2672-2744`。

这里最重要的不是记住每个函数名，而是看见它和前面四态生命周期的关系：

- 地址范围先被规划
- 栈的可用区域被提交并允许访问
- 保护区保留在地址边界上，但权限被关闭
- 异常处理阶段根据状态临时改变权限
- 线程退出时再移除基础 guard pages

栈保护因此不是一个孤立的异常技巧，它仍然是虚拟地址、页面权限、访问 fault 和失败路径资源预留共同组成的状态机。

---

## 七、把整篇收回来：JVM 管理的不是“内存块”，而是一组边界和状态

现在回看开头的 `-Xmx16g`：

- VSZ 很大，说明 JVM 先占住了很大的地址空间边界
- RSS 很小，说明很多页面还没有真正驻留
- commit 的部分可以按需触碰和兑现
- uncommit 可以撤回暂时不用的物理页，但保留地址布局
- release 才会彻底退回地址范围

再看大页面和栈保护，它们并不是两个完全无关的附录：

```text
地址空间生命周期
  ├─ reserve / commit / uncommit / release
  │    → 管理“这块地址什么时候属于 JVM、什么时候可访问”
  │
  ├─ 大页面
  │    → 在地址边界已经确定后，优化虚拟地址到物理地址的翻译成本
  │
  └─ 栈保护
       → 在地址边界已经确定后，给失败路径划出不可访问的缓冲区
```

这几套机制共同表达了一个设计原则：

**先划清边界，再改变状态；先把资源生命周期拆开，再决定什么时候兑现、回收和优化；对错误访问，让它在越过边界的第一时间暴露。**

最后把最容易混淆的几件事再收一遍：

### 误解一：`-Xmx16g` 等于启动时已经占用 16GB 物理内存

不等于。

它更多表达的是堆的最大边界。地址空间 reserve、可访问映射 commit、物理页实际驻留，是三个不同阶段。

### 误解二：commit 成功等于所有物理页已经在 RSS 中

不等于。

匿名页可能在第一次访问时才通过 page fault 建立实际驻留。pre-touch 只是主动把这部分成本前置。

### 误解三：uncommit 就是 release

不是。

uncommit 主要撤回页面和访问权限，地址空间仍然保留；release 连地址空间也一起归还。

### 误解四：大页面越大越好

不是。

收益取决于 TLB、硬件、工作集、内核策略和 GC 的边界；THP 可能跨越 G1 region，回收时反而增加拆分成本。

### 误解五：栈溢出一定能抛出 `StackOverflowError`

不能绝对保证。

Yellow zone 的目标是提供可恢复路径；如果连异常处理或信号处理的安全余量也被耗尽，就会进入不可恢复的 fatal 路径。

如果把这篇压缩成三句话：

- JVM 用 reserve/commit 分离地址空间与物理页兑现，用 uncommit/release 分离撤页与退地址
- 大页面优化的是地址翻译，栈保护守住的是失败边界，两者都必须服从上层生命周期
- JVM 的内存设计不是“申请一块内存”，而是把地址、权限、物理驻留、回收和失败处理拆成一组可控状态

下一篇要继续回答一个更贴近线程的问题：

**这些栈到底由谁创建？JVM 内部那些 Java、VM、GC、Compiler、Watcher 线程，谁在使用它们，又是谁负责把它们停下来？**

> → [03-threads-and-sync.md](03-threads-and-sync.md)：JVM 内部线程的创建、优先级与 park/suspend
