# 域 08: Interpreter — 全视角提问验证

> 13 KP / 🔴3 + 🟡5 + 🟢5 | ~50文件/~27,000行 | 拆 4 篇

## 大纲对照

| 篇 | 覆盖范围 |
|:--:|------|
| 01 | Bytecodes 256条定义表 |
| 02 | TemplateInterpreter + TemplateTable |
| 03 | InterpreterRuntime + OopMapCache + invocationCounter |
| 04 | LinkResolver + Rewriter |

## 维度 1: 开发者

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| D1 | TemplateInterpreter 怎么把 iload_0 → x86 机器码？ | ✅ 02 §1 |
| D2 | Rewriter 把 `invokevirtual #5` 改成什么——为什么省时间？ | ✅ 04 §2 |
| D3 | InterpreterRuntime::_new() 怎么分配对象？ | ✅ 03 §1 |

## 维度 2: 性能工程师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| P1 | 解释器 dispatch——TemplateInterpreter vs C++ switch 的性能差多少？ | ✅ 01 + 02 |
| P2 | InvocationCounter 怎么触发 JIT——解释器跑多少次才编译？ | ✅ 03 §2 |

## 维度 3: 架构师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| A1 | 为什么用 TemplateInterpreter 而不是纯 C++ switch？ | ✅ 02 §1 |
| A2 | tosState 设计——不同类型共享 template——好处是什么？ | ✅ 02 §1 |
| A3 | 重写为什么在类加载时做——为什么不在解释器中？ | ✅ 04 §2 |

## 维度 4: 学生

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| L1 | 解释器和 JIT 的关系——什么时候解释，什么时候编译？ | ✅ 03 §2 |

---

## 审查结论

| 维度 | 问题数 | 全覆盖 | 状态 |
|------|:--:|:--:|:--:|
| 开发者 | 3 | 3 | ✅ |
| 性能工程师 | 2 | 2 | ✅ |
| 架构师 | 3 | 3 | ✅ |
| 学生 | 1 | 1 | ✅ |
| **合计** | **9** | **9** | ✅ |
