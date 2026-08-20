# 03-arguments-flags/02-flag-processing-and-management 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：把 flag 从“字符串”到“运行期状态变更”的全过程写成一条可审计的生命周期

## 1. 选题判断

本篇值得独立成篇。

统一问题：

**`-XX:+UseG1GC`、环境变量、配置文件和 jcmd 写入，如何经过同一个 flag 系统变成类型安全、带来源、受权限和约束保护的状态变化？**

## 2. 一句话顿悟

**Flag 处理不是简单赋值，而是一条带来源、权限、类型、默认值保护和阶段约束的状态变更管线；同一个名字能否被改变，取决于来源和 flag 的可写身份。**

## 3. 结构大纲

### 第一节：事故开场——同一个 flag，四种入口

- 命令行、`JAVA_TOOL_OPTIONS`、`_JAVA_OPTIONS`、JIMAGE/config
- 同一解析器，不同 Origin
- 为什么入口不同但不能各自实现解析逻辑

### 第二节：文本解析——`+`/`-`/`=` 如何找到变量并按类型写入

- `Arguments::parse_argument/process_argument`
- `JVMFlag::find_flag` 线性扫描与 locked 检查
- bool 与数值/字符串 setter
- alias/obsolete flag
- diagnostic/experimental 解锁

### 第三节：Ergonomics——JVM 什么时候可以覆盖默认值

- `FLAG_IS_DEFAULT`
- CPU 数 → GC 线程数公式
- 物理/cgroup 内存 → heap ergonomics
- 用户显式设置为什么不能被 ergo 覆盖
- deprecated flag 转换

### 第四节：阶段性校验——范围和约束什么时候执行

- parse 时范围
- apply_ergo 后
- memory init 后
- 运行时写 flag 时是否重用校验
- 错误发生太早/太晚的失败推演

### 第五节：打印与审计——Initial vs Final

- PrintFlagsInitial 发生时机
- PrintFlagsFinal 发生时机
- Origin/ergonomic 标记如何解释“谁改了值”
- 与 jcmd VM.flags 的区别

### 第六节：运行期管理——jcmd 为什么只能改一小部分 flag

- DCmd 注册与 VM.set_flag
- WriteableFlags
- MANAGEABLE / product_rw
- 结构性 flag 为什么不能热改
- 修改后的约束、即时生效和线程安全边界

### 第七节：收网——一条 flag 的状态机

```text
来源
  → 文本解析
  → 找到 JVMFlag
  → 权限/解锁
  → 类型 setter
  → Origin 更新
  → ergo 可能只改 default
  → 分阶段 range/constraint
  → Print/jcmd 观察或受限修改
```

## 4. 必须展开的失败方案

1. 每种入口各写一套解析器
2. 解析时直接写字符串 Map
3. ergonomic 无条件覆盖用户命令行
4. 所有约束只在 parse 时检查
5. jcmd 允许任意 flag 热修改
6. PrintFlagsFinal 不记录 Origin

## 5. 必须澄清的误解

- `JAVA_TOOL_OPTIONS` 与命令行不是同一 Origin
- find_flag 线性扫描是启动期设计，不等于运行期热路径
- ergo 不是任意覆盖，`FLAG_IS_DEFAULT` 是关键保护
- `PrintFlagsInitial` 不是 ergo 之后的结果
- `manageable`/writeable 不代表 flag 的任何副作用都安全
- `jcmd VM.flags` 查询与 `VM.set_flag` 修改是两条权限不同的路径

## 6. 证据清单

- `arguments.cpp:1034`：`parse_argument`
- `arguments.cpp:1243`：`process_argument`
- `arguments.cpp:857`：类型 setter
- `jvmFlag.cpp:903-923`：`find_flag`
- `jvmFlag.cpp:134/182/266`：setter
- `jvmFlag.cpp:346-373`：解锁检查
- `arguments.cpp:3963`：`apply_ergo`
- `abstract_vm_version.cpp:366-402`：GC 线程 ergonomics
- `arguments.cpp:1729-1751`：heap ergonomics
- `arguments.cpp:3681-3711`：Initial/Final 打印
- `writeableFlags.cpp:243-265`：运行时写 flag
- `jvmFlag.cpp:398-399`：可写判定
- `diagnosticCommand.cpp:82/241-247`：DCmd 管理路径

## 7. 版本边界

- 基于 OpenJDK 11u
- 本篇重点是生命周期与权限；完整语法细节以源码为准
- GC 线程和堆公式是当前 HotSpot 实现示例，不是 Java 规范
- 运行时 flag 修改的安全性依赖具体 flag 的 writeable 注册和 setter

## 8. 字数预算

- 正文目标：`10000-14000`
- 叙述性正文目标：`7000+`

## 9. 完成后 review

- 删除代码后能否复述 flag 状态变更管线
- 是否区分来源、分类、默认保护、权限和约束
- 是否明确 parse、ergo、memory init、management 的时间顺序
- 是否把查询与热修改分开
- 是否完成 file:line、版本边界和禁用词检查
