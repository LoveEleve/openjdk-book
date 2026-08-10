# 域 08: Interpreter — 知识规划

> 源码路径: hotspot/share/interpreter/ + hotspot/cpu/x86/template* | 源码量: ~50 文件 / ~27,000 行 | 大域
> 拆 4 篇

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| bytecodes.hpp.cpp + bytecodes.hpp | **Bytecodes — 256 条字节码定义**: 每条(iload/aload/invokevirtual/...)的 opcode/length/format/stack_effect, Code 枚举 + 字符串名 + flags(conditional/branch/...) | High |
| templateInterpreter.cpp.hpp + templateInterpreterGenerator.cpp.hpp | **TemplateInterpreter — 模板解释器**: 为每条字节码生成机器码 template, DispatchTable 索引,tosState (栈顶类型状态), 每条字节码的 template 在 CodeCache | High |
| templateTable.cpp.hpp + cpu/x86/templateTable_x86.cpp.hpp | **TemplateTable — 字节码的机器码生成表**: templateTable 数组, 每 entry 对应一个字节码的机器码生成函数 | High |
| interpreterRuntime.cpp.hpp | **InterpreterRuntime — C++ 运行时支持**: ldc/resolve/new/checkcast/monitorenter...——解释器调 C++ 的 entry,INVOKE_RESOLVE_SO/SO_SO 不同的 JavaCalls 参数 | High |
| interpreter.hpp.cpp | **Interpreter — 解释器入口/出口**: method entry point,return entry, deopt entry, invoke return entry,Uncommon_trap entry | High |
| abstractInterpreter.hpp.cpp + cpu/x86/abstractInterpreter_x86.cpp | **AbstractInterpreter — 平台无关抽象**: MethodKind 枚举(zerolocals/synchronized/native/...), entry point 抽象 | High |
| linkResolver.hpp.cpp | **LinkResolver — 方法/字段解析**: resolve_invokevirtual/resolve_invokestatic/resolve_field, 访问检查, klass 解析 | High |
| bytecodeInterpreter.hpp.cpp | **BytecodeInterpreter — C++ switch 解释器** (fallback): 纯 C++ switch(opcode) 实现, 慢但可调试 | Medium |
| cppInterpreter.hpp.cpp.generator.hpp.cpp | **CppInterpreter — C++ 解释器生成器**: C++ 实现(已弃用, 仅 Zero port 用), code generation | Low |
| invocationCounter.hpp.cpp | **InvocationCounter — 方法调用计数**: 解释器→JIT 编译的触发,backedge counter (循环迭代→OSR) | High |
| bytecodeStream.hpp.cpp + bytecodeTracer.hpp.cpp | **BytecodeStream + BytecodeTracer**: 字节码迭代器, 调试打印 | Medium |
| rewriter.hpp.cpp | **Rewriter — 字节码重写**: invokedynamic/wide/newarray 的 prerequisite 重写, cpCache index 填充 | High |
| oopMapCache.hpp.cpp | **OopMapCache — GC 栈映射缓存**: 解释器帧内的 OOP 位置, GC 扫描栈的需要 | High |

*13 个知识点*

## 02 聚合

### P1 — 系统级共识 (≥5 文件)
| KP | 出现文件 |
|----|---------|
| TemplateInterpreter + TemplateTable (机器码生成) | templateInterpreter*, templateTable*, cpu/x86/templateTable*, interpreterRuntime*, abstractInterpreter* |
| 字节码定义 + dispatch | bytecodes.*, templateTable.*, interpreter.*, bytecodeInterpreter.* |

### P2 — 局部重要 (2-4 文件)
| KP | 出现文件 |
|----|---------|
| LinkResolver | linkResolver.*, interpreterRuntime.* |
| Rewriter | rewriter.*, templateTable.* |
| OopMapCache | oopMapCache.*, interpreterRuntime.* |
| InvocationCounter + JIT 触发 | invocationCounter.*, interpreterRuntime.* |

### P3 — 孤立 (1 文件)
| KP | 文件 |
|----|------|
| BytecodeInterpreter (C++ fallback) | bytecodeInterpreter.* |
| CppInterpreter (弃用) | cppInterpreter.* |
| BytecodeStream/Tracer | bytecodeStream.*, bytecodeTracer.* |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (3 KP)
| KP | 为什么🔴 |
|----|---------|
| TemplateInterpreter — 字节码→机器码 template | 每条字节码**不是** switch dispatch——是预生成的机器码 template——每次执行都走 template——共享 code。iload 和 aload 共享同一 template——只是 tosState 不同 (int vs ref) |
| LinkResolver — 符号→直接引用 | 方法/字段的符号引用解析——查 constantPool→resolve→Klass*/Method*/field offset——缓存在 cpCache |
| Rewriter — 字节码重写 | 类加载时一次性遍历 bytecodes——把 invokedynamic index→cpCache index, 把 newarray→fast_newarray——省去解释器每次执行时的 index 转换 |

### 🟡 Working — 有设计但非核心 (5 KP)
| KP | 说明 |
|----|------|
| 字节码定义 (256 条) | format/stack_effect/flags——编译时表 |
| InterpreterRuntime — C++ runtime | 解释器调 C++ 的各种 entry |
| InvocationCounter — OSR 触发 | 解释器→JIT 的编译触发 |
| OopMapCache — GC 栈映射 | 解释器帧中 OOP 位置 |
| TemplateTable — 字节码→机器码 | template 数组和生成 |

### 🟢 Surface — 了解即可 (5 KP)
| KP | 说明 |
|----|------|
| BytecodeInterpreter (C++ fallback) | debug/Zero port 用 |
| CppInterpreter | 已弃用 |
| AbstractInterpreter | 平台无关抽象——薄层 |
| BytecodeStream/Tracer | 迭代/调试工具 |
| Interpreter entry/return | 入口出口抽象 |

## 04 聚类 — 教学顺序与文章拆分

### 依赖图

```
A: 字节码定义 — 无前置
  ├─ B: TemplateInterpreter — 依赖 A (generated for each bytecode)
  └─ C: Rewriter — 依赖 A (scanning bytecodes to rewrite)
D: LinkResolver — 依赖 ClassFile (此域外)
E: Runtime support (InterpreterRuntime + invocationCounter + OopMapCache)
```

### 教学顺序

```
1. 字节码定义 — 256 条的格式和语义 (A)
2. TemplateInterpreter — 字节码怎么变成机器码 (B)
3. Runtime — InterpreterRuntime + invocation + OopMap (C+E)
4. LinkResolver + Rewriter — 符号解析 + 字节码重写 (D+C)
```

### 文章拆分建议

4 篇（~27K行）

- **01-bytecodes-definition.md** — 256 字节码定义
- **02-template-interpreter.md** — TemplateInterpreter + TemplateTable
- **03-interpreter-runtime.md** — InterpreterRuntime + invocationCounter + OopMapCache
- **04-linkresolver-rewriter.md** — LinkResolver + Rewriter
