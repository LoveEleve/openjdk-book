# 02. 地址已经知道属于哪个库，为什么名字还是不够 —— ELF、debug 补全、PLT 与 demangle

> **前置依赖**：[01 —— 采样信号只给了寄存器，为什么还能走出 native 调用链](./01-register-walking.md)：知道 native 第一跳与地址归属已经建立，但“地址属于谁”还不等于“它叫什么”。
> → **后续**：帧命名、Java 方法名和调用栈存储
>
> 本篇基于当前 async-profiler Linux ELF 路径。重点是 native 地址怎样恢复成可信的函数名，不把 JIT CodeCache、kernel symbols、C++/Rust ABI 解码混成一个步骤。

## 地址已经知道属于哪个库，为什么名字还是不可信

场景：上一章已经把 callchain 里的地址走出来了，甚至还能确定某个 PC 落在 `libc.so`、`libstdc++.so` 或某个共享对象里。用户这时最自然的想法是：“既然已经知道属于哪个库，直接查个名字不就行了？”

问题恰恰在这里才刚刚开始。因为“属于哪个库”只回答了上下文，没回答：

- 该库有没有完整 `.symtab`；
- 动态段里能不能只靠 `.dynsym`/GNU hash 找到需要的名字；
- 这个库是不是 stripped，真正的 debug symbols 在外部 `.build-id` 或 `.gnu_debuglink` 里；
- 当前地址是不是停在 `.plt` 跳板上；
- 找到的名字到底是 C++ ABI、Rust ABI，还是根本就该保持原始符号。

所以 native 帧名恢复不是：

```text
地址 → 名字
```

而更像：

```text
PC
  → 所属映射/CodeCache/内核
    → 库内地址与 ELF 表
      → 原始符号 or 外部 debug 补全
        → PLT / relocation 修正
          → ABI demangle
            → 最终可读 native frame name
```

*关键设计（斜体）：* *地址归属只是名字恢复的起点，不是终点。真正的人类可读帧名还要穿过 ELF 表、debug fallback、PLT 修正和 ABI 解码。* [模式: 多级名字恢复链]

## 先推翻四个最容易把“地址到名字”讲平的直觉

### 知道地址属于哪个库，就已经知道函数名了

不成立。库只是一个容器；里面可能有静态符号、动态符号、strip 后残留的最小表、根本不在运行文件里的外部调试符号，甚至只有 PLT 跳板入口。光知道“属于 libc”，还远远不知道应该读哪张表、按什么偏移去找名字。

### 只靠 `.dynsym` 或 `dladdr` 就够了

动态符号表更多服务运行时链接，而不是完整调试可见性；很多局部/静态符号根本不在 `.dynsym` 里。async-profiler 当前实现直接解析 ELF，不只为了拿到动态导出名，而是为了尽可能建立自己的完整地址→符号索引。

### 库 strip 了，就彻底没法看

这也不成立。当前实现有明确的降级链：先看原始 `.symtab`；缺失时再尝试 build-id、`.gnu_debuglink` 和 debuginfod cache。也就是说，“运行文件里没有完整符号”并不等于“采样器就放弃名字恢复”。

### 所有 mangled 符号都交给 `__cxa_demangle`

更不行。Rust legacy 符号看起来很像 C++ `_ZN...E`，如果不先做语言识别，就可能把 Rust 名字错误地当 C++ 处理；反过来，某些 C++ 匿名命名空间符号交给 Rust demangler 也会被还原错。demangle 之前，先判断名字属于哪种 ABI，本身就是恢复链的一部分。

## 第一层：地址归属之后，ELF 表才开始接手名字恢复

上一篇已经建立了“地址先归属”的前提：`Profiler::findNativeMethod()` 会先用 `findLibraryByAddress()` 找到所属库，再调用 `CodeCache::binarySearch()` 取符号名（`src/profiler.cpp:294-297`）。这一句恰好能说明本篇和上一篇的边界：

- 上一篇回答“这地址属于哪个世界/哪个库”；
- 本篇回答“既然已经属于某个 native 库，接下来怎样从 ELF 里恢复出名字”。

真正开始 ELF 解析的入口在 `ElfParser::parseFile()`（`src/symbols_linux.cpp:314-339`）：它 mmap 整个 ELF 文件，先校验 header，再计算虚拟装载地址差值，随后进入 `loadSymbols(use_debug)` 和 debug/unwind 相关解析。

这说明 async-profiler 在名字恢复上不是“问操作系统一个现成 API”，而是自己进入 ELF 文件结构。

## 第二层：原始名字先从哪里来——`.symtab`、动态段与 GNU hash

### `.symtab` 是完整调试名字的优先来源

`ElfParser::loadSymbols()` 在 `src/symbols_linux.cpp:505-527` 的第一分支非常关键：

- 先找 `.symtab`；
- 再用 `sh_link` 找关联字符串表；
- 调 `loadSymbolTable()` 把符号地址、大小和名字装进 `CodeCache`；
- 标记当前 `CodeCache` 拥有 debug symbols。

这说明 `.symtab` 在当前实现里不是“有就顺手看看”，而是优先级最高的原始名字来源。因为它往往比动态符号表更完整，包含更多本地/静态函数。

### 动态段不是替代品，而是另一层地址语义来源

`parseDynamicSection()`（`src/symbols_linux.cpp:364-457`）又在处理另一组表：`DT_SYMTAB`、`DT_STRTAB`、`DT_HASH`、`DT_GNU_HASH`、`DT_JMPREL`、`DT_RELA/REL` 等。

这里最容易讲错的地方是把它简化成“dynsym 解析”。更准确地说，动态段既在提供一部分符号表线索，也在提供 import、PLT、relocation 的名字恢复基础。它不是 `.symtab` 的简化版，而是运行时装载语义的另一层输入。

### GNU hash 解决的是“表有多长”这类底层问题

`ElfParser::getSymbolCount()`（`src/symbols_linux.cpp:489-502`）通过 bucket 和 chain 计算 GNU hash 中的符号数量。它看起来像小细节，但恰恰说明当前实现已经下钻到“链接器怎样组织动态符号索引”的层次，而不是只遍历一个固定长度数组。

因此，把 ELF 名字恢复讲成“读个表就完事”，会把 `.symtab`、动态段、GNU hash 各自负责的缺口全部压平。

*关键设计（斜体）：* *原始名字不是从一个统一表里拿出来的：`.symtab` 提供完整调试符号优先路径，动态段和 GNU hash 则补运行时链接与符号数量语义。* [模式: 原始名字多源输入]

## 第三层：stripped 库并不是死路，而是进入 debug 补全链

### 先用原始库的 `.symtab`，没有再降级

`loadSymbols()` 的主分支很清楚：

```cpp
if (symtab != NULL) {
    loadSymbolTable(...);
} else if (use_debug) {
    loadSymbolsUsingBuildId() || loadSymbolsUsingDebugLink();
}
```

这意味着 stripped 不是“看不到名字就算了”，而是切换到外部 debug 符号补全链。当前实现的心智模型是：**运行库可以精简，但调试符号仍可能在外部。**

### build-id：从内容身份去找外部 debuginfo

`loadSymbolsUsingBuildId()`（`src/symbols_linux.cpp:592-608`）先找 `.note.gnu.build-id`，再把 build-id 转成几个可能的外部 debug 路径：

- `/usr/lib/debug/.build-id/...`；
- debuginfod cache 对应的 `.../debuginfo`；
- 通过环境变量推导出的缓存目录。

这里补的不是“另一个库名”，而是“当前这个运行库对应的外部调试身份”。build-id 让 stripped 文件和 debug 文件不用靠路径名硬绑定，只靠内容身份关联。

### `.gnu_debuglink`：按约定位置找伴生 debug 文件

`loadSymbolsUsingDebugLink()`（`src/symbols_linux.cpp:610-649`）则是另一条降级链：

1. 同目录下的 `libjvm.so.debug`；
2. `.debug/` 子目录；
3. `/usr/lib/debug/...` 路径。

这条线和 build-id 的区别在于：它更多依赖文件布局约定，而不是二进制内容身份。二者合起来，才构成“strip 之后仍努力补名字”的完整降级策略。

### debuginfod cache 只是这条链的一站，不是通用网络层

`getDebuginfodCache()` 与 `loadSymbolsFromDebuginfodCache()`（`src/symbols_linux.cpp:530-585`）说明，当前实现并不是去联网下载什么，而是优先看本机 cache 路径，按 `DEBUGINFOD_CACHE_PATH` / `XDG_CACHE_HOME` / `HOME` 推导目录，再去找 build-id 对应的 `debuginfo` 文件。

所以把 debuginfod 写成“在线服务”会偏离当前实现边界；它在这里更像一种本机 cache 命名约定来源。

*关键设计（斜体）：* *stripped 只是把原始运行文件里的符号拿掉，不等于名字恢复彻底结束；async-profiler 还会沿 build-id / debuglink / debuginfod cache 继续往外找。* [模式: stripped 后的外部 debug 补全链]

## 第四层：`.plt` 与 relocation 为什么是独立的名字问题

即便已经知道了库、也找到了符号表，名字恢复还没完。因为当前地址可能落在 `.plt` 跳板，而不是目标函数真正实现上。

`loadSymbols()` 在 `use_debug` 分支下继续做一件额外的事（`src/symbols_linux.cpp:517-526`）：

- 找 `.plt`；
- 保存 PLT 区间；
- 找 `.rela.plt` 或 `.rel.plt`；
- 调 `addRelocationSymbols()` 为这些跳板合成名字。

`addRelocationSymbols()`（`src/symbols_linux.cpp:664-688`）会根据 relocation 表里的符号，合成类似：

- `foo@plt`；
- 或 C++ `_ZN...` 形式下带点号的 `foo.plt` 风格名字。

这一步的关键在于：**当前地址如果停在跳板上，直接显示底层地址或原 relocation 目标都容易误导。** profiler 必须把“这是 PLT 跳板”这层信息也编码到名字里。

因此 `.plt` 修正不是“小附加功能”，而是在 native 名字恢复链里解决“地址停在调用跳板而不在真正函数体”的专门问题。

## 第五层：kernel symbols 为什么又是一条特殊旁路

普通 `.so` 走的是 ELF 文件路径；内核符号不是。`Symbols::parseKernelSymbols()` 在 `src/symbols_linux.cpp:698-741`：

- 若有 fdtransfer peer，就先 `requestKallsymsFd()`；
- 否则直接 `open("/proc/kallsyms")`；
- 读出符号行后，只保留 `T/t/W/w` 这类函数型条目；
- 并给名字追加 `_[k]` 标记。

这里说明两件事：

1. kernel symbols 不是普通 ELF 库里的 `.symtab` 路径，而是 `/proc/kallsyms` 旁路；
2. 若当前环境需要权限桥，内核符号还可能借 fdtransfer 把 `kallsyms` fd 送进来。

所以“native 名字恢复”本身也不是单一路径：用户空间共享库和内核空间符号本来就不应该复用同一条名字来源链。

## 第六层：demangle 不是一步，而是“先识别 ABI，再选解码器”

### C++ demangle 只是其中一种解释器

`Demangle::demangleCpp()` 在 `src/demangle.cpp:13-27` 使用 `abi::__cxa_demangle()`，并在失败时尝试去掉 `.part.123` 之类编译器后缀再重试。这一步解决的是：**已经拿到原始 mangled symbol 之后，怎样把 C++ ABI 名字变成人类可读形式。**

### Rust 不能被粗暴地当成 C++

`Demangle::isRustSymbol()` 与 `demangleRust()` 在 `src/demangle.cpp:29-70` 先识别 `_R` 或 legacy Rust 哈希形式，再调用 Rust demangler。注释里还特意提到：某些看起来像 `_ZN...E` 的名字，若误交给 Rust 或 C++ 都可能把匿名命名空间之类语义还原错。

### 统一入口 `demangle()` 的关键不是解码，而是分流

`Demangle::demangle()` 在 `src/demangle.cpp:88-101` 的顺序其实非常值得写出来：

1. 先 `isRustSymbol()`；
2. 若 Rust 识别成立且 demangler 认得，再走 Rust；
3. 否则再退回 `demangleCpp()`；
4. 若不要求 full signature，还会 `cutArguments()` 去掉参数列表。

所以 native 名字恢复的最后一步，并不是：

```text
所有名字 → __cxa_demangle
```

而是：

```text
原始符号
  → 先判断属于哪种 ABI
    → 再选对应 demangler
      → 必要时裁剪参数签名
```

这条边界很重要，因为它直接决定“人类可读”是不是准确，而不只是“看起来像个函数名”。

*关键设计（斜体）：* *demangle 真正统一的是入口，不是解释器；先识别 ABI，再选 C++/Rust 解码器，必要时再裁签名。* [模式: ABI 识别先于 demangle]

## 第七层：本篇还没到 Java/JIT 帧命名，它只把 native 地址恢复成可信函数名

把整篇压缩成一句话：

```text
地址先归属到某个 native 库/内核来源
  → 再决定读哪张 ELF 表或哪条 debug fallback 链
    → 遇到 PLT 还要单独修正跳板名
      → 最后按 ABI 选择 demangler
```

换一种不看图的复述方式：

- 库名只回答“地址属于谁”；
- ELF 表回答“这个库里有哪些原始符号”；
- build-id/debuglink/debuginfod cache 回答“原始库缺符号时去哪补”；
- `.plt`/relocation 回答“地址是不是停在跳板上”；
- demangle 回答“原始 ABI 名字怎样变成人类可读函数名”；
- kernel symbols 则走 `/proc/kallsyms` 旁路，而不是 ELF 文件路径。

本篇的一句话困惑是：**为什么地址已经知道属于某个库，火焰图上的 native 帧名还是不能直接确定？**

本篇的一句话顿悟是：**因为“库归属”只提供上下文；真正的名字还要在正确的 ELF 表或外部 debug 文件里恢复，并在 `.plt` 和 ABI 解码层继续校正，最后才变成可读函数名。**

*关键设计（斜体）：* *native 名字恢复不是一步查表，而是一串层层补洞的恢复链：表缺了就补，地址歪到跳板上就校正，名字 mangled 了再按 ABI 解码。* [模式: 名字恢复的层层补洞]

[跨层标注：`/proc/self/maps` / 地址归属——库上下文；ELF `.symtab` / dynamic section / GNU hash——原始符号来源；build-id / `.gnu_debuglink` / debuginfod cache——外部 debug 补全；`.plt` / relocation——跳板符号修正；C++/Rust ABI——demangle 分流]

## 下一篇：native 名字有了，Java/JIT/native 三类帧怎样被统一命名

这一篇先把 native 地址恢复成可信函数名。下一篇继续看：

- jmethodID、classMap、JMethodCache 怎样把 Java 帧变成类名/方法名；
- native/JIT/Java 三类帧怎样统一落成 frame name；
- 火焰图上的类型后缀、方法缓存与帧归一化怎样协作。

**→ 下一篇：Java 帧命名与 JMethodCache。**
