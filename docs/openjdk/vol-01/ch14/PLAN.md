# ch14 解释器模板系统——interpreter_init 与 templateTable_init

> **定位**：`init_globals()` 第 11、14 步——解释器的全部汇编代码生成。涵盖 `TemplateInterpreter::initialize()` → `TemplateTable::initialize()`（202 条字节码模板注册）→ `TemplateInterpreterGenerator::generate_all()`（Codelet 批量生成）→ `_active_table = _normal_table`（dispatch 表激活）。
>
> **前置依赖**：[ch09 universe_init](openjdk/vol-01/ch09)、[ch10 G1 BarrierSet](openjdk/vol-01/ch10)、[ch12 三表就绪](openjdk/vol-01/ch12/02-string-table-create.md)、[ch13 JIT 阈值设立](openjdk/vol-01/ch13/01-init-globals-facade.md)
>
> **后置依赖**：[ch15 CodeCache 初始化](openjdk/vol-01/ch15)（待写）

## 文章

| # | 文件 | 内容 | 状态 |
|---|------|------|------|
| 01 | [01-interpreter-init.md](01-interpreter-init.md) | Template → CodeletMark → generate_all → TemplateTable → DispatchTable | ✅ |

## 设计决策

- **单篇不拆子章**：解释器模板系统的 5 个核心概念（Template、CodeletMark、generate_all、TemplateTable、DispatchTable）是概念递进关系（配方→工具→产出→注册→调度），拆分反而破坏阅读连贯性。读者从"为什么需要模板"一路读到"三张 dispatch 表怎么切换"可以形成完整 mental model。
- **运行时行为不在此章**：本文定位是构造阶段（init_globals 第 11 步生成了什么），各字节码的运行时执行细节、safepoint 触发时机、去优化流程留在后续运行时章节。
