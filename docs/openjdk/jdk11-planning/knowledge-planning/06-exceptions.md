# 域 06: 异常体系 — 知识规划

> 源码路径: java.base/share/classes/java/lang/{Throwable,Exception,Error,StackTraceElement}.java + 51 个异常/错误类
> 源码量: ~60 文件 / ~9,000 行 | 非巨型域
> 写作层: Layer 0(无前置,所有代码的错误通道)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| Throwable.java (1092 行) | **StackTrace 存储与填充**: `private StackTraceElement[] stackTrace = UNASSIGNED_STACK`(211),`fillInStackTrace()`(784, native 快照栈) | High |
| Throwable.java | **cause 链**: `getCause()`(419),`initCause`,构造器传播——异常链(包装异常的标准做法) | High |
| Throwable.java | **suppressed 异常**: `SUPPRESSED_SENTINEL` 空列表懒初始化(220/232),`addSuppressed`,try-with-resources 关闭失败自动附加 | High |
| Throwable.java | **构造器设计**: 4 个构造(message/cause 组合),`fillInStackTrace` 在构造中调用(254-305) | Medium |
| Throwable.java | **打印与 toString**: `toString()`(483)输出 类名: message;printStackTrace 系列 | Medium |
| Throwable.java | **native backtrace**: `private transient Object backtrace`(122,由 JVM 保存栈回溯,Java 层不直接使用) | Low |
| StackTraceElement.java (559) | **栈帧快照**: declaringClass/methodName/fileName/lineNumber/isNativeMethod(66-67/251/262)——toString 格式(ClassName.method(File.java:line)) | High |
| Exception.java / Error.java | **层次骨架**: Exception extends Throwable(checked 基础),Error extends Throwable;RuntimeException extends Exception | Medium |
| RuntimeException.java | **unchecked 标记**: RuntimeException extends Exception——checked/unchecked 的分界 | High |
| 51 个异常/错误类 | **类型体系**: IllegalArgumentException/NullPointerException/IndexOutOfBounds/ClassCastException(运行时);IOException/ClassNotFoundException(受检);OOM/StackOverflowError(错误) | Medium |
| java/lang/invoke 内? | **异常在字节码层面**: athrow 指令、异常表(ExceptionTable)——JVM 规范层面,非本域 Java 代码 | — |

*11 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | Throwable 核心(cause/suppressed/stackTrace) | 2 (Throwable/StackTraceElement) | 面试与生产核心 |
| P1 | checked/unchecked 分界 | 3 (Exception/Error/RuntimeException) | 面试必考 |
| P2 | 异常类型体系 | 51 (各类异常/错误类) | 逐类列出无价值,归类讲 |
| P3 | toString/printStackTrace | 1 | 使用层 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | Throwable 三件套(cause/suppressed/stackTrace) | 面试: 异常链、try-with-resources suppressed、堆栈丢失场景(生产日志无栈根因);实现细节有区分度 |
| 🔴 Deep | checked vs unchecked 语义 | 面试必考;Spring 对 checked 的立场(RuntimeException 包装);生产异常设计规范 |
| 🟡 Working | 构造器与 fillInStackTrace 时机 | 知道"抛异常慢"的原因(native 栈快照) |
| 🟡 Working | StackTraceElement 格式 | 日志解析(异常堆栈字符串切分) |
| 🟢 Surface | 51 个具体异常类 | 分类记忆,无实现细节 |

## 04 聚类

### 依赖图(域内)
```
Throwable ←── Exception(受检基础) ←── RuntimeException(unchecked) ←── 运行时异常族
         ←── Error ←── 致命错误族(OOM/StackOverflow/Linkage)
Throwable ──持有── StackTraceElement[](栈快照) / cause(自引用链) / suppressed[]
```

### 教学顺序与文章拆分(2 篇)

1. **Throwable 的结构与机制** — stackTrace 快照、cause 链、suppressed 异常、构造器、toString 格式
2. **异常类型体系与设计哲学** — checked/unchecked 分界、运行时异常分类、Error vs Exception、生产异常设计规范(包装/转换/吞异常反模式)

> 前置: 域 01 字符串(toString 格式依赖)。跨层: fillInStackTrace 的 native 实现(内部卷 interpreter/stack 遍历);athrow/异常表(JVM Spec §6.5)
