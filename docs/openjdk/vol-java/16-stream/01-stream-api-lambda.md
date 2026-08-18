# 01. Stream 接口全景与函数式接口 — 中间/终端分类、Lambda 机制

> **前置依赖**: [08-collections/01 — ArrayList](../08-collections/01-arraylist.md)(集合数据源)、[01-string/03 — 构建与拼接](../01-string/03-build-concat.md)(invokedynamic 机制,JEP 280)
> → **后续**:[16-stream/02 — 流水线结构与惰性机制](02-pipeline-lazy.md)
> 关联: 域 08 集合(数据源);域 04 反射(indy 引导);域 15 JIT(内联衔接)

## 一行链式调用,怎么分类

`list.stream().filter(x -> x > 0).map(x -> x * 2).collect(toList())`——四段调用,两类操作。面试从"中间操作和终端操作区别"问起,一路到"lambda 和匿名类区别""orElse 和 orElseGet 区别"。这一篇画 Stream 的 API 地图、讲函数式接口与 lambda 的编译真相、数据源创建、以及 Optional 的空安全链。

## 1. "Stream 的 API 地图" — 中间 vs 终端

### 1.1 第一原理:中间惰性 + 终端触发

Stream 的所有操作分两类(`Stream.java`,1445 行):

**中间操作**(返回 Stream,惰性——不执行):

| 操作 | 源码 | 语义 |
|------|------|------|
| `filter` | `:182` | 过滤 |
| `map` | `:197` | 映射 |
| `flatMap` | `:283` | 展平 |
| `distinct` | `:372` | 去重(有状态) |
| `sorted` | `:388` | 排序(有状态) |
| `peek` | `:441` | 调试观察 |
| `limit` | `:468` | 截断 |
| `skip` | `:497` | 跳过 |
| `takeWhile` | `:555` | 条件截断(短路) |

**终端操作**(触发求值——链上所有中间操作此时才执行):

| 操作 | 源码 |
|------|------|
| `forEach` | `:647` |
| `collect` | `:905`/`:961` |
| `count` | `:1027` |
| `anyMatch` | `:1048` |
| `findFirst` | `:1108` |
| `reduce` | `:757`/`:797` |

**第一原理: 没有终端操作,中间操作什么都不做**——`list.stream().filter(...)` 只是搭了条管道,`collect` 才是按下开关。这也是"stream 不 collect 会怎样"的答案: 无副作用——peek 是唯一接受 Consumer 的中间操作(常用于调试打印),但其 Javadoc 明确要求 action 是 **non-interfering**(不干扰流,`Stream.java:436-437`)——设计上不应产生副作用。

### 1.2 短路:进阶分类

- **短路中间操作**: `limit`/`takeWhile`——结果确定后不再消费剩余元素
- **短路终端操作**: `anyMatch`/`allMatch`/`noneMatch`/`findFirst`/`findAny`——结果确定即停止

关键设计(斜体):*"中间惰性 + 终端触发"是 Stream 的第一原理——**没有终端操作,中间操作什么都不做**。面试"中间操作有哪些/终端有哪些": 能完整分类是基础;短路中间(takeWhile)与短路终端(anyMatch)是进阶。*

## 2. "函数式接口是什么？" — function 包四族

### 2.1 四大族

`java.util.function`(44 个接口)四大族(`Function.java:40-41`、`Predicate.java:39-40`、`Consumer.java:41-42`、`Supplier.java:40-41` 都是 `@FunctionalInterface`):

| 族 | 接口 | 用途 | 方法 |
|----|------|------|------|
| 映射 | `Function<T,R>` | 转换 | `R apply(T)` |
| 断言 | `Predicate<T>` | 条件判断 | `boolean test(T)` |
| 消费 | `Consumer<T>` | 副作用 | `void accept(T)` |
| 供给 | `Supplier<T>` | 惰性生成 | `T get()` |

加上 Bi 版(两参数)与原始类型版(int/long/double 的 IntFunction/IntPredicate 等,避免装箱)。

### 2.2 lambda 的编译真相:invokedynamic

`x -> x > 0` 不是匿名内部类——javac 生成一条 **`invokedynamic`**,引导方法 `LambdaMetafactory.metafactory` 在运行时生成实现类。这与字符串拼接的 `StringConcatFactory` 是同一机制(域 01 第 3 篇已详述 JEP 280)。

关键设计(斜体):*lambda 是"接口实例的语法糖"——SAM 接口 + invokedynamic 引导。面试"lambda 和匿名类区别": 捕获变量要求 effectively final(值捕获)、invokedynamic 生成(不创建独立类文件,引导后可内联);"为什么 lambda 快/慢": indy 引导一次后走内联(JIT 衔接)。*

## 3. "Stream 怎么创建？" — 数据源

四种来源:

- **集合**: `Collection.stream()`/`parallelStream()`——默认接口方法,底层走 `StreamSupport.stream`
- **数组**: `Arrays.stream`
- **值**: `Stream.of`(`:1159`/`:1187`)
- **生成**: `Stream.iterate(seed, f)`(`:1214`,无限)、`Stream.generate(s)`(`:1331`,无限)、`Stream.concat`(`:1374`)

**无限流必须配 limit**(惰性保证安全): `Stream.iterate(0, n -> n+1).limit(10)`——iterate 是惰性序列,limit 截断后才求值。

关键设计(斜体):*"源 → 流水线"的抽象: 任何 Spliterator 都能变 Stream——`StreamSupport.stream(spliterator, parallel)` 是通用桥(域 16 后文)。面试"无限流怎么用": iterate/generate + limit(惰性);大集合注意并行流的线程模型(域 16 后文)。*

跨层标注: [域 01: 03-build-concat——invokedynamic 机制(JEP 280 的 StringConcatFactory)与 lambda 的 LambdaMetafactory 是同一引导技术;域 04 反射——indy 的引导与 MethodHandle 衔接]

## 4. "Optional 与空安全" — 链式空处理

### 4.1 链式 API

`Optional`(`Optional.java`,469 行)的核心链(`map@260`/`filter@218`/`orElse@354`/`orElseGet@368`):

```java
// Optional.java:354 + 368(截取核心,逐字)
    public T orElse(T other) {
        return value != null ? value : other;
    }
...
    public T orElseGet(Supplier<? extends T> supplier) {
        return value != null ? value : supplier.get();
    }
```

### 4.2 orElse vs orElseGet:求值时机

- **`orElse(other)`**: 参数**总是已求值**——即使 value 非空,`other` 也早就算好了
- **`orElseGet(supplier)`**: **惰性**——value 为空才调 supplier

```java
// 用法示意(API 形式,非源码片段)
opt.orElse(expensiveDefault());      // 无论是否为空,expensiveDefault() 都执行
opt.orElseGet(() -> expensiveDefault());  // 只在为空时执行
```

生产坑: `orElse(expensiveDefault())` 里传"方法调用"——默认值每次都被计算,浪费。

关键设计(斜体):*Optional 是"空值语义化"——强迫调用方处理为空路径。面试"orElse 和 orElseGet 区别": **求值时机**(参数已算好 vs 惰性);生产: 返回值用 Optional,字段/参数不用(规范争议——Optional 不能完全替代 null,作返回值契约)。*

## 核心悬念

API 知道了——**内部怎么组织**?`filter().map().sorted().collect()` 怎么串成一条链?为什么中间操作惰性?Sink 链是什么?——下一篇: 流水线结构与惰性机制。

> → [16-stream/02 — 流水线结构与惰性机制](02-pipeline-lazy.md)
