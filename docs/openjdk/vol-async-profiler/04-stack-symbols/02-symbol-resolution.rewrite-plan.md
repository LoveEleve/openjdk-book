# 02-symbol-resolution 重写规划

> 状态：正文已重写，待 deep review
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“ELF/symtab/demangle 说明文”重写成一篇围绕“地址已经归属到某个世界后，为什么 native 符号仍然要经历 ELF 表、debug 补全、PLT 合成和语言 ABI 解码，才能变成火焰图上的函数名”的机制文章

## 1. 读者困惑

- 为什么地址已经知道属于某个库，还不能直接拿到函数名？
- `.symtab`、`.dynsym`、GNU hash、`.gnu_debuglink`、build-id、debuginfod 分别在补哪一层缺口？
- stripped 库为什么不是“没符号就算了”，而要走外部 debug 补全链？
- `.plt` 跳板为什么会污染函数名，需要单独合成符号？
- demangle 为什么还要先判断语言 ABI，不能全部丢给 `__cxa_demangle`？
- kernel symbols 为什么又是一条特殊旁路？

## 2. 一句话顿悟

**地址解析并不是“地址 → 名字”的一次映射，而是“地址归属 → 库内地址/ELF 表 → debug 补全 → PLT/重定位修正 → ABI 解码”的多级恢复链；只有把这些层都过一遍，火焰图上的 native 帧名才既可读又不误导。**

## 3. 总图

```text
PC
  → 所属映射/CodeCache/内核
    → 库内地址与 ELF sections / dynamic tables
      → .symtab / dynsym / GNU hash / relocations
        → build-id / debuglink / debuginfod fallback
          → C++/Rust demangle
            → 最终 native frame name
```

## 4. 版本与边界

- 本篇聚焦 Linux ELF 路径；kernel symbols、JIT CodeCache、macOS Mach-O 都只作为边界对照。
- `lookup`/mapping 解决“地址属于谁”，本篇重点是“属于某个 native 库之后，它叫什么”。
- `.symtab` 存在时优先使用原始库内调试符号；`use_debug` 时才走 build-id/debuglink/PLT 合成分支。
- `.plt`/relocation 合成不是所有路径都执行，只在 `use_debug` 下触发。
- demangle 先做语言识别，不能把 Rust/C++/其他 ABI 混用一个解码器。

## 5. 现稿方法论差距审计

- 现稿已经有“地址属于哪个库”与 “ELF+demangle” 主线，但“为什么地址归属后还不够”的失败方案不够厚。
- `lookup.cpp` 的引用需要核准当前实际文件位置与职责边界，避免用旧路径泛指地址归属。
- `.symtab`、GNU hash、debug 补全、PLT 合成目前像串珠列表，还没收成“原始名字从哪里来，缺失时怎样补”。
- kernel symbols 与 `requestKallsymsFd()` 的特殊旁路还没纳入统一叙事。
- demangle 章节还缺“语言 ABI 识别失败会怎样”的失败边界。

## 6. 重写策略

1. 用“已经知道地址属于 libc/libstdc++，为什么火焰图还是不能直接显示可读函数名”开场。
2. 推演并否定：有库名就够、只靠 `.dynsym`、strip 了就没法看、所有 mangled name 都交给 C++ demangle。
3. 给出总图：地址归属 → ELF 表 → debug fallback → PLT 修正 → ABI 解码。
4. 分层讲：
   - ELF 文件和动态段里到底哪些表在给名字；
   - stripped 场景如何靠 build-id/debuglink/debuginfod 补全；
   - `.plt` 和 relocation 为什么会制造“跳板名字”；
   - kernel symbols 和 fdtransfer 为什么是另一条特殊来源；
   - demangle 为什么要先判断语言。
5. 收网时强调：本篇仍在 native 符号身份恢复层，Java/JIT 命名是下一层问题。

## 7. 结构大纲

### 第一节：事故开场——地址已经知道属于某个库，为什么名字还是不可信

回答：地址归属不是名字恢复，库内仍有多个表、多个 fallback 和 ABI 解码层。

### 第二节：先排除四个错误直觉——有库名就够、只靠 `.dynsym`、strip 了就没办法、全部交给 C++ demangle

### 第三节：第一层——ELF 表里到底谁在提供名字

证据：`symbols_linux.cpp` 的 dynamic section、`.symtab`、GNU hash。

### 第四节：第二层——stripped 库如何靠 build-id/debuglink/debuginfod 补符号

证据：`loadSymbolsUsingBuildId()` / `loadSymbolsUsingDebugLink()` / cache path。

### 第五节：第三层——`.plt` 与 relocation 为什么必须单独修名字

证据：`loadSymbols()` 中 `.plt` 和 `addRelocationSymbols()`。

### 第六节：第四层——kernel symbols 与 `requestKallsymsFd()` 的特殊旁路

证据：`parseKernelSymbols()` 与 fdtransfer 路径。

### 第七节：第五层——demangle 为什么要先判断语言 ABI

证据：`demangle.cpp` 的 Rust/C++ 分支。

### 第八节：收网——native 名字恢复完成后，下一层才轮到 frame naming

## 8. 必须展开的失败方案

1. 地址只要知道属于哪个库，就已经知道函数名了。
2. 动态符号表足以覆盖所有有用函数。
3. strip 之后 native 栈就彻底不可读。
4. `.plt` 地址与真实函数名可以混着用。
5. 所有 mangled symbol 都能直接交给 `__cxa_demangle`。

## 9. 证据清单

- `src/symbols_linux.cpp:314-339`
- `src/symbols_linux.cpp:364-457`
- `src/symbols_linux.cpp:489-689`
- `src/symbols_linux.cpp:698-741`
- `src/demangle.cpp:13-97`
- 必要时补地址归属的实际调用点（`Profiler::findNativeMethod()` / lookup 边界）

## 10. 完成后检查

1. 删除代码块后，读者仍能复述“库归属 → ELF 表 → debug fallback → PLT 修正 → demangle”。
2. 至少展开 4 个失败方案。
3. 不把 `.symtab` / `.dynsym` / GNU hash / debuglink / build-id / debuginfod 写成并列术语表。
4. 不把 kernel symbols 当作普通 ELF 文件处理。
5. 不把 demangle 写成统一 C++ 解码步骤。
6. 每个 `file:line` 重新核对，链接、结构标记和禁用词通过。
