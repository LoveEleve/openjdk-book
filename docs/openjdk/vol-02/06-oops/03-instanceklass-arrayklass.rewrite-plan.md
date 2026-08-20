# 06-oops/03-instanceklass-arrayklass 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释为什么 `Klass` 统一入口之后，HotSpot 还要把普通类、对象数组、基本类型数组继续分成不同“仓库”，并且各自提前把哪些运行时成本编码好

## 1. 选题判断

本篇值得独立成篇，但不能继续写成“字段表 + 数组长度 + 两种数组 GC 差异”的并列表达。

真正的读者困惑是：

**既然上一篇已经说明 `Klass*` 是统一能力入口，为什么 HotSpot 还要继续区分 `InstanceKlass`、`ObjArrayKlass`、`TypeArrayKlass` 这些仓库内部结构？为什么一个 `String[]` 和一个 `int[]` 不能只是同一数组类的不同标记？JVM 到底提前把哪些运行时成本——字段访问、长度读取、GC 扫描、元素访问——编码进了这三种不同仓库里？**

## 2. 一句话顿悟

**`Klass` 统一的是入口，不是成本模型：`InstanceKlass` 把普通类的方法/字段/常量池和初始化状态集中成类仓库；`ObjArrayKlass` 把“元素是 oop、GC 必须逐个处理”的成本前置编码；`TypeArrayKlass` 则把“元素绝不可能是引用、GC 可以整段跳过”的事实固化进类型本身。**

## 3. 总图

```text
klass()
  ├─ InstanceKlass
  │    ├─ methods / fields / constants / init state
  │    └─ 普通类运行时仓库
  └─ ArrayKlass
       ├─ 公共数组事实：length、header、维度链、mirror
       ├─ ObjArrayKlass
       │    └─ 元素是 oop：访问走 Access API，GC 逐元素闭包
       └─ TypeArrayKlass
            └─ 元素是裸值：按字节类型访问，GC 不扫元素区
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——`new String[10]` 和 `new int[10]` 都叫数组，为什么 JVM 完全不是同一种态度

目标约 900 字。

- Java 语法层面的“同名概念”与 JVM 成本模型分叉
- 回收上篇：`klass()` 给的是统一入口
- 提出真正问题：入口统一之后，仓库内部为什么还要分家

### 第二节：先拆掉三个朴素方案

目标约 1600 字。

- 数组长度声明成普通 C++ 字段、所有对象都带着走
- 所有数组只用一个统一数组类，运行时靠元素类型分支
- GC 对所有数组都逐元素扫描
- 引出：头部布局、访问协议、GC 成本必须提前编码，不能运行时现猜

### 第三节：`InstanceKlass`——普通类仓库为什么继续存在

目标约 1700 字。

- `_methods` / `_fields` / `_constants`
- 字段表为何是 `Array<u2>` + `FieldInfo` 视窗
- 方法表为何保留 class file 顺序
- 运行时仓库 vs 解析器填充边界
- `InstanceRefKlass` 作为“特殊遍历协议换子类”的预告例子

### 第四节：数组头为什么单独长这样——length 不是普通字段

目标约 1700 字。

- `arrayOopDesc` 的 length 不声明为 C++ 非静态字段
- 压缩类指针下 length 占 klass gap 区
- `length_offset_in_bytes()` / `header_size(type)`
- 为什么不能写死偏移
- `arraylength` 字节码只是带偏移取整型

### 第五节：`ArrayKlass`——数组先共享哪些事实

目标约 1500 字。

- `_dimension` / `_higher_dimension` / `_lower_dimension`
- 维度链、惰性创建、高维数组原子挂链
- 数组 mirror
- Object/Cloneable/Serializable 子类型边界
- 这部分是所有数组共同仓库

### 第六节：`ObjArrayKlass`——为什么元素是引用就必须换一种仓库

目标约 1800 字。

- `_element_klass`
- 元素访问走 `HeapAccess<IS_ARRAY>`
- `obj_at` / `obj_at_put`
- 写 barrier 与 GC 闭包逐元素遍历
- “数组里装的是 oop”如何改变访问和扫描成本

### 第七节：`TypeArrayKlass`——为什么元素不是引用时，GC 可以整段跳过

目标约 1700 字。

- `oop_oop_iterate_impl` 空实现
- 裸值数组的 load/store 与元素偏移
- `long[]` / `double[]` 的头部额外对齐
- `copy_array` 走字节批量拷贝的边界
- “不可能含引用”如何直接消掉整条 GC 扫描成本

### 第八节：特殊 `InstanceKlass`——引用对象为什么要独占子类

目标约 1200 字。

- `InstanceRefKlass`
- referent / discovered 不按普通 oop-map 遍历
- 这是“特殊遍历协议换子类”的另一个证据
- 不展开 ReferenceQueue/GC 细节

### 第九节：误解澄清与收网

目标约 1200 字。

至少回答：

- 数组 length 是不是普通 Java 字段
- `String[]` 和 `int[]` 是否只是同一个数组类上不同 tag
- 对象数组和基本类型数组的 GC 成本是否同阶
- `InstanceKlass` 是否负责 class 文件解析本身
- 压缩模式下数组头大小是否可以写死成一个常数
- `InstanceRefKlass` 是否意味着引用对象不是普通实例对象

## 5. 失败方案必须写进正文

至少展开：

1. 把数组 length 作为普通字段塞进所有对象头
2. 所有数组共用一个统一数组类，运行时再看元素类型决定分支
3. GC 对对象数组和基本类型数组一视同仁、逐元素扫描

## 6. 证据清单

- `instanceKlass.hpp:246-303`：`_methods` / `_fields` / `_constants`
- `fieldInfo.hpp:45-69`：字段表 6 个 `u2` 布局
- `arrayOop.hpp:49-127`：数组头、length 偏移、header size
- `templateTable_x86.cpp`：`arraylength` 读取偏移
- `arrayKlass.hpp:41-43`：维度链字段
- `arrayKlass.cpp` / `objArrayKlass.cpp` / `typeArrayKlass.cpp`：高维数组创建、维度挂链
- `arrayKlass.cpp:122`：数组接口共享
- `objArrayOop.inline.hpp:47-57`：对象数组访问
- `objArrayKlass.inline.hpp:38-46`：对象数组逐元素 GC 闭包
- `typeArrayKlass.inline.hpp:36-50`：基本类型数组 GC 空遍历
- `typeArrayOop.inline.hpp` / `typeArrayOop.hpp`：裸值元素访问与偏移
- `typeArrayKlass.cpp:126+`：`copy_array`
- `instanceRefKlass.cpp:31-70`：referent/discovered 的特殊处理

## 7. 必须明确的边界

- 基于 JDK 11u 的对象模型、压缩类指针和当前 GC 访问协议
- 本篇讲“仓库内部结构如何提前编码运行时成本”，不展开常量池解析、字节码链接、ReferenceQueue 语义
- 数组 mirror 和多维数组链只讲对象模型与创建边界，不展开反射数组 API
- `InstanceRefKlass` 只作为特殊遍历协议案例，不深入 GC 引用处理细节
- `arraycopy`、边界检查、RCE 等只在需要处点到为止，不把本篇带成解释器/JIT 专题

## 8. 完成后 review

- 删除代码后能否复述“普通类仓库 / 对象数组仓库 / 基本类型数组仓库”三种不同成本模型
- 是否解释了为什么数组长度不是普通字段
- 是否把对象数组与基本类型数组的 GC 差异讲成对象模型差异，而不只是‘一个扫描一个不扫描’的事实卡片
- 是否没有把常量池解析或 GC 引用处理细节提前讲爆
- 是否完成删码测试、禁用词、`file:line` 和边界检查
