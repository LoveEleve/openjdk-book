# 02. 异常类型体系与设计哲学 — checked/unchecked、Error、生产规范

> 🔴 Deep | 域 06 异常体系第 2 篇 | Layer 0
> 读者处境: 面试"受检异常 vs 非受检异常";生产"该抛什么异常、该不该包装"——从 JDK 类型体系找设计依据。

### 1. "异常金字塔" — 类型层次

场景: 一眼看懂异常全图——Java 异常就三种颜色

- `Exception.java:53` `public Exception extends Throwable` — 受检异常之根
- `RuntimeException.java:43` `public class RuntimeException extends Exception` — **unchecked 分界点**: 编译期不强制处理
- `Error.java:57` `public Error extends Throwable` — 致命错误之根(独立分支,不经过 Exception)
- 运行时异常族(15 个,全部 extends RuntimeException): NullPointerException/IllegalArgumentException/IllegalStateException/IndexOutOfBoundsException/ClassCastException/UnsupportedOperationException/ArithmeticException 等
- 受检异常代表: IOException/ClassNotFoundException/InterruptedException(在 java.io/其他模块)
- 关键设计 (斜体): *受检异常是编译期契约——方法签名 throws 即"调用者必须处理";Error 刻意不检查(恢复无意义);设计意图: 受检=预期内可恢复(文件缺失),运行时=程序 bug(空指针),Error=JVM 级灾难(OOM)*

### 2. "哪些异常不能捕获？" — Error 家族

场景: 面试"catch (Exception e) 能抓到 OOM 吗?"

- 22 个 Error 类: OutOfMemoryError/StackOverflowError(内存)、LinkageError 族(NoClassDefFoundError/ClassFormatError/UnsupportedClassVersionError——类加载)、AssertionError/ExceptionInInitializerError
- 关键设计 (斜体): *catch (Exception) 抓不到 Error——因为 Error 不继承 Exception;但 catch (Throwable) 能——生产禁止 catch Throwable 的理由: 连 OOM 都吞掉了*
- 常见坑: 静态初始化块抛异常 → ExceptionInInitializerError;类缺失 → NoClassDefFoundError(不是 ClassNotFoundException——后者是受检的反射路径异常)
- 面试点: 捕获异常 vs 错误的边界;"Error 不可恢复"是经验法则而非规范
- [JLS §11.2: 异常类型与编译期检查规则;JVM Spec §4.7.3 异常表(athrow 与 handler 匹配)]
- [内部卷: 08-interpreter 异常表查找,21-shared-runtime 异常处理路径]

### 3. "Spring 为什么全包 RuntimeException？" — 设计哲学之争

场景: 生产代码规范"自定义异常继承 RuntimeException"——依据是什么?

- 受检异常的问题: 强制处理传染(接口签名污染)、调用方只能兜底捕获、lambda/Stream 里无法抛受检异常(函数式接口没有 throws)
- Spring 的选择: 一切基础设施异常包成 NestedRuntimeException(DataAccessException 等)——JDBC 的 SQLException 被转换(域 36 会看到)
- JDK 自己的趋势: JDK7+ 新增 API 全面偏好运行时异常(Objects.requireNonNull → NPE,UnsupportedOperationException 替代 checked)
- 关键设计 (斜体): *"受检 vs 非受检"是 Java 特有争议(Lisp/Smalltalk 无此概念);现代共识: 业务可预期错误用受检/自定义,程序缺陷用运行时异常——但生产规范几乎一律 RuntimeException + 错误码,原因见上*
- 面试话术: 能说出"lambda 无法抛受检异常""接口签名污染"两个具体论据即可

### 4. 生产异常规范 — 包装、转换与吞异常反模式

场景: 线上日志只有 "Exception caught" 没有堆栈——谁干的?

- 反模式清单:
  1. `catch (Exception e) { log.error("xxx", e); throw new BizException("xxx"); }` 不传 cause → 根因丢失
  2. `catch (Exception e) { }` 空捕获(吞异常)
  3. `catch (Exception e) { throw e; }` 直接重抛(不如不抓)
- 正确姿势: 包装时 `throw new BizException("msg", e)`(走 Throwable(String, Throwable) 构造,域 06 第 1 篇 cause 链)
- 日志打印: 必须 log.error(msg, e) 传入异常对象(而非 e.getMessage())——否则堆栈缺失
- 关键设计 (斜体): *异常链的哲学: 每一层包装保留 cause,让"顶层看到业务语义,底层看到技术根因"——这是 Throwable.cause 设计的最终目的*

---

### 核心悬念

异常会**穿越线程边界**——子线程的异常主线程看不到,线程池里任务抛异常怎么办?这是域 11(线程与 ThreadLocal)和域 14(线程池)的战场。下一站: 数字与数学——BigDecimal 为什么不能直接 ==?

> → 下一篇: 域 02 数字与数学(02-number-math 系列) | 关联: 域 11 线程(线程内异常), 域 14 线程池(execute/submit 差异)
