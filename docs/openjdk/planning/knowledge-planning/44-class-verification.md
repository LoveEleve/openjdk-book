# 域 44: Class Verification — 知识规划

> 源码: hotspot/share/classfile/verifier.cpp + verificationType.cpp | ~4文件/~3000行 | 🟡 普通域(2篇)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| verifier.cpp (2913行) | **字节码验证引擎**: Verifier::verify→ClassVerifier::verify_class→verify_method(逐方法验证), StackMapTable 类型检查, bytecode→opcode stream→operand stack 类型推导 | High |
| verifier.hpp | **Verifier 接口**: verify() static method, should_verify_for→-Xverify:all/none/remote, StackMapTable/StackMapFrame 内存模型 | High |
| verificationType.cpp/hpp | **验证类型系统**: VerificationType(Top/Integer/Float/Long/Double/Null/Reference), is_reference_assignable_from, is_assignable_from—类型兼容性检查 | High |

*3 知识点*

## 02 聚合

### P1 (≥5文件) — 无, 仅3个源文件

### P2 (2-4文件)
| KP | 出现文件 |
|----|---------|
| 字节码验证 (verifier + StackMapTable) | verifier.cpp, verifier.hpp, verificationType.cpp |

### P3 (=1文件) — 无

## 03 深度分类

### 🔴 Deep (1 KP)
| KP | 为什么 🔴 |
|----|---------|
| StackMapTable 类型检查 | Class 文件中的 StackMapTable 属性(JDK 7+) 提供了每个 branch target 的栈/局部变量类型状态——Verifier 逐字节码指令 type-check operand stack(压栈/弹栈类型兼容)→类型错误→VerifyError。这是 Java 安全模型的第一道防线——防止恶意识 class 文件中的类型混淆攻击(如 integer→object pointer→JVM crash) |

### 🟡 Working (1 KP)
| KP | 为什么 🟡 |
|----|---------|
| VerificationType 类型系统 | Top/Integer/Float/Long/Double/Null/Reference——类型 lattice 的 meet/join 操作 |

### 🟢 Surface (1 KP)
| KP | 为什么 🟢 |
|----|---------|
| -Xverify 开关 | should_verify_for→-Xverify:all/none/remote——简单 flag 检查 |

## 04 聚类 — 2篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | 字节码验证引擎 | "ClassLoader 加载 class→Verifier 逐方法 type-check bytecode→VerifyError 怎么产生？StackMapTable 怎么用？" |
| 2 | 验证类型系统 | "VerificationType: Top→Integer→Float→...→类型 lattice 怎么定义？is_assignable_from 怎么判断类型兼容？" |
