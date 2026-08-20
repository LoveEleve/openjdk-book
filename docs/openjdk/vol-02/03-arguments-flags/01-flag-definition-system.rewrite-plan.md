# 03-arguments-flags/01-flag-definition-system 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：把“宏展开”重写成“一条 `-XX:` 参数如何同时拥有变量、元数据和校验身份”的机制文

## 1. 选题判断

本篇值得独立成篇，但不能写成宏展开目录。

统一问题：

**`-XX:+UseG1GC` 这种启动参数，为什么既像一个普通 C++ 变量，又能出现在 `PrintFlagsFinal`、`jcmd VM.flags`、约束检查和运行时管理接口里？HotSpot 如何保证这几种身份不失同步？**

## 2. 一句话顿悟

**HotSpot 的 flag 系统不是“解析字符串再写配置表”，而是先在编译期用一套统一声明生成变量、元数据表和约束注册，运行期解析只是给这些现成实体赋值。**

## 3. 结构大纲

### 第一节：事故开场——一个 `-XX:` 参数为什么不只是一个 bool

- `UseG1GC` 在代码里像普通全局变量
- `PrintFlagsFinal` 又能知道它的名字、类型、文档和来源
- 启动时还要做范围/约束检查
- 运行中部分 flag 还可被管理接口改写

### 第二节：统一声明——同一行 flag 为什么能生成三份身份

- `RUNTIME_FLAGS(...)` 巨型宏本体
- 分类前缀：product/diagnostic/manageable/... 
- 一行声明如何对应变量、JVMFlag 表项和约束挂载点
- 为什么这比手写三份定义更安全

### 第三节：第一次展开——变成真正的 C++ 变量

- `MATERIALIZE_*` 宏
- `UseG1GC` / `UseCompressedOops` 如何 materialize
- `product_pd/lp64_product` 等平台相关变体
- 为什么说 flag 在编译期就存在，而不是解析时动态生成

### 第四节：第二次展开——变成 `JVMFlag` 元数据表

- `flagTable[]`
- 名字、类型、地址、文档、KIND 位
- `PrintFlagsFinal` / `jcmd` / SA 为何依赖它
- 分类前缀如何进入 KIND_* 标记

### 第五节：第三次展开——范围、约束与阶段性校验

- `range()` / `constraint()`
- AtParse / AfterErgo / AfterMemoryInit 三个时机
- 为什么不能都在 parse 阶段校验
- 典型跨 flag / 内存依赖约束

### 第六节：三套宏集合——全局 / OS / 架构 flag 为什么编译期隔离

- `VM_FLAGS`
- `RUNTIME_OS_FLAGS`
- `ARCH_FLAGS`
- `UseAVX` 为什么只在 x86 存在
- 为什么平台上不存在的 flag 在编译期就应消失

### 第七节：分类与 Origin——“这是什么 flag”和“这个值从哪来”是两回事

- KIND_* 与 Origin 两个维度
- DEFAULT / COMMAND_LINE / ERGONOMIC / MANAGEMENT 等来源
- 覆盖优先级与 PrintFlagsFinal 来源列
- 解锁 diagnostic / experimental 的边界

### 第八节：收网——一条 flag 的完整生命史

```text
统一声明
  → 编译期生成变量
  → 编译期生成 JVMFlag 表项
  → 编译期挂上范围/约束元数据
  → 运行期解析字符串
  → 写入变量并记录 Origin
  → 运行时工具再通过元数据表观察/修改
```

## 4. 必须展开的失败方案

1. 只保留全局变量，不维护元数据表
2. 变量、文档、约束分别手写三份
3. 所有约束都在 parse 阶段检查
4. 所有平台共享同一份 flag 集合
5. 把分类和来源混成一个维度

## 5. 必须澄清的误解

- flag 不是运行期动态“创建”出来的对象
- `UseG1GC` 之类在代码里就是普通变量
- 分类前缀不等于值来源
- `manageable` 不等于任何 flag 都能随时改
- 平台 flag 不存在于不支持的平台，不是“存在但永远关闭”

## 6. 证据清单

- `globals.hpp:213-226`：`RUNTIME_FLAGS`
- `globals.hpp:228-249`：`UseCompressedOops` / `ObjectAlignmentInBytes`
- `globals.hpp:2767-2769`：`MATERIALIZE_*`
- `globals.cpp:58-96`：三套宏展开入口
- `jvmFlag.cpp:769-816`：`*_FLAG_STRUCT`
- `jvmFlag.cpp:818-832`：`flagTable[]`
- `jvmFlag.cpp:894`：表指针
- `globals_linux.hpp` / `globals_x86.hpp`：OS/ARCH flag 定义
- `jvmFlag.hpp:35-69`：Origin/Flags 位布局
- `jvmFlagConstraintList.hpp:54-61`：约束时机

## 7. 版本边界

- 基于 OpenJDK 11u HotSpot
- 宏名称、flag 种类和来源枚举可能随版本演进
- 本篇聚焦“定义体系”，解析写值细节留给下一篇
- 某些 flag 的具体定义位置依赖平台头文件

## 8. 字数预算

- 正文目标：`9000-13000`
- 叙述性正文目标：`6000+`

## 9. 完成后 review

- 删除代码后能否复述“统一声明 → 变量/表/约束 → 运行期赋值”链路
- 是否把宏展开写成机制而不是预处理器技巧展示
- 是否区分分类(KIND)与来源(Origin)
- 是否区分定义体系与解析体系
- 是否明确平台/架构 flag 的编译期隔离
