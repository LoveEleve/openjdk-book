# 06-oops/02-klass-hierarchy 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释对象头拿到 `Klass*` 后，JVM 为什么能用这一份元数据同时回答对象大小、子类型判断、虚调用、接口调用、类初始化与 mirror/static 字段问题

## 1. 选题判断

本篇值得独立成篇，但不能继续写成“列出 Klass 家族字段和子类”。

真正的读者困惑是：

**对象头第二个槽位只给了我一个 `Klass*`，为什么 JVM 拿到它以后，就能立刻知道对象有多大、`instanceof` 是否成立、`invokevirtual`/`invokeinterface` 该跳哪里、类是否初始化完成、`obj.getClass()` 和静态字段又该去哪里找？为什么这些能力没有拆成多张表再逐步查？**

这篇必须把 `Klass` 讲成“对象到类型能力的统一入口”，而不是“一个类描述结构”。

## 2. 一句话顿悟

**`Klass*` 不是只存类名的元数据指针，而是 HotSpot 给每个运行时类型准备的一份能力索引：`layout_helper` 负责大小与形态，super-check 负责子类型判断，vtable/itable 负责调用分派，`java_mirror` 负责连到 `Class` 对象，`InstanceKlass` 负责把普通类的字段、方法、常量池和初始化状态收拢到同一入口。**

## 3. 总图

```text
oop -> klass()
      ├─ layout_helper            → 这是实例还是数组？对象/数组有多大？
      ├─ primary/secondary supers → instanceof / checkcast
      ├─ vtable                   → invokevirtual
      ├─ itable                   → invokeinterface
      ├─ java_mirror              → obj.getClass() / Class mirror
      └─ InstanceKlass 扩展区
           ├─ methods / fields / constants
           ├─ init_state / init_thread
           └─ static field base / 特殊子类行为
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——为什么 `obj.getClass()` 只是两次解引用，却像知道了整个世界

目标约 900 字。

- 从 `obj.getClass()`、`instanceof`、虚调用这些现象切入
- 提出真正问题：一个 `Klass*` 为什么够用
- 回收上篇：对象头只给一个类型入口
- 预告：这是“统一能力索引”，不是单纯类名表

### 第二节：先拆掉三个朴素方案

目标约 1600 字。

- 把对象大小、类型判断、调用分派分别放独立全局表
- 每次调用再沿父类链/接口链动态查找
- 把静态字段、mirror、初始化状态全部散落在不同管理结构
- 引出为什么 HotSpot 要把高频能力折叠进 `Klass`

### 第三节：`Klass` 是什么——放在 Metaspace 的类型能力入口

目标约 1500 字。

- `Klass : Metadata`
- 一份运行时类型一份 `Klass`
- `_layout_helper`、`_name`、`_java_mirror`
- `KlassID` 与 `layout_helper` 的分工
- “对象共享 Klass，实例只付一个指针成本”

### 第四节：为什么不是一个大而全的 `Klass`

目标约 1700 字。

- `Klass / InstanceKlass / ArrayKlass / ObjArrayKlass / TypeArrayKlass`
- 镜像、引用、类加载器专门子类的行为差异
- 数组和普通类的布局/分派需求根本不同
- “特殊行为换子类，而不是在一个结构里堆条件分支”

### 第五节：`layout_helper`——对象大小与形态的快路径索引

目标约 1700 字。

- 正数实例 / 负数数组 / 0 中性值
- 数组四字节打包含义
- `oop.inline.hpp` 如何直接用它计算对象大小
- 为什么 `layout_helper` 放在 `Klass` 开头
- 它同时承载“类型形态 + 布局”两类信息

### 第六节：super-check——为什么 `instanceof` 不需要一层层爬父类树

目标约 1700 字。

- `_primary_supers[8]`
- `_secondary_supers` / `_secondary_super_cache`
- `_super_check_offset`
- primary 与 secondary 的分流
- 为什么高频 case 是一次槽位比较

### 第七节：vtable / itable——为什么虚调用和接口调用要分成两套表

目标约 2000 字。

- vtable 内嵌在 Klass 后部
- 复制父表再覆写/追加
- vtable index 链接期固定，运行期一次寻址
- 接口方法为什么不能直接塞进统一 vtable
- itable offset entry + method block
- invokeinterface 的扫描换空间

### 第八节：`InstanceKlass`——普通类元数据仓库与初始化状态机

目标约 1700 字。

- `_methods` / `_fields` / `_constants`
- `_init_state` / `_init_thread`
- `<clinit>` 协作与递归初始化边界
- 为什么字段解析在 `ClassFileParser`，而运行时承载在 `InstanceKlass`

### 第九节：mirror——为什么 `Klass` 最后还要连回 `java.lang.Class`

目标约 1300 字。

- `_java_mirror` 把类型入口连回 Java 世界
- `InstanceMirrorKlass`
- 静态字段放在 mirror 对象尾部
- `getClass()` 与 `ClassName.field` 的连接
- 明确 `Klass` 与 `Class` 是 native 元数据对象 / Java 镜像对象两层

### 第十节：特殊子类只是能力分叉，不是另一套主线

目标约 1100 字。

- `InstanceRefKlass` / `InstanceClassLoaderKlass`
- 为什么它们存在，但不抢走本篇主线
- 只点出“特殊行为换子类”的模式
- 不展开 GC 引用处理和类加载器机制细节

### 第十一节：误解澄清与收网

目标约 1200 字。

至少回答：

- `Klass` 是不是 `java.lang.Class` 本身
- `instanceof` 是否每次都要沿父类链遍历
- 接口方法是否也有固定 vtable index
- 数组是否只是 `InstanceKlass` 的一种字段标记
- 静态字段是否存放在 `Klass` 自身内存里
- `layout_helper` 是否只表示大小

## 5. 失败方案必须写进正文

至少展开：

1. 把对象大小、类型判断、虚调用都拆成独立全局表
2. 运行时每次方法调用都从父类/接口链动态查找
3. 把数组和普通类压进同一个“大而全 InstanceKlass”结构

## 6. 证据清单

- `klass.hpp:78-166`：Klass 基础字段
- `klass.hpp:89-115, 348-429`：`layout_helper` 注释、解包与构造
- `klass.hpp:120-145, 221-257, 454-467`：super-check 相关字段、primary super 逻辑与 `is_subtype_of`
- `klass.hpp:138-163`：mirror、prototype header、vtable len
- `klass.hpp:371-381, 589-599`：instance/array/typeArray/objArray 快速判断
- `oop.inline.hpp:200-244`：`is_a` 与对象大小对 `Klass` 快路径信息的直接使用
- `klassVtable.cpp:56-128`：vtable 大小和 miranda 计算
- `klassVtable.cpp:135-225`：复制父表、覆写/追加
- `macroAssembler_x86.cpp` / `templateTable_x86.cpp`：虚调用查表路径
- `klassVtable.hpp:236-269`：itable offset entry / method entry
- `klassVtable.cpp:1093-1130`：itable 初始化
- `instanceKlass.hpp:131-138, 246-303`：初始化状态和核心数组字段
- `instanceKlass.cpp:891+`：初始化等待与递归初始化边界
- `instanceMirrorKlass.hpp:76-83`：mirror 上静态字段偏移
- `klass.cpp:50-56`：`java_mirror` 访问
- `klass.inline.hpp:32-35`：`prototype_header` 只作上一篇边界引用，不进本篇主线

## 7. 必须明确的边界

- 基于 JDK 11u 的 `Klass` 层次与 `layout_helper` 语义
- 本篇讲的是对象到类型能力的入口，不展开常量池解析、C2 内联缓存、GC 闭包细节
- `Klass` 位于 Metaspace/Metadata 体系，不等同于 Java 层 `Class` 对象
- `java_mirror` 和 `InstanceMirrorKlass` 只讲对象关联与静态字段位置，不扩展到反射 API 全貌
- vtable/itable 讲解释器/通用运行时路径，不把所有 JIT 优化细节都塞入本篇
- 数组细节下一篇还会继续讲对象数组与基本类型数组的区别

## 8. 完成后 review

- 删除代码后能否复述“一个 `Klass*` 如何回答大小、类型、分派、初始化、mirror”
- 是否解释了为什么不用多个独立全局表
- 是否把 `Klass` 和 `java.lang.Class` 区分清楚
- 是否把 vtable 与 itable 的分工讲明白
- 是否没有把下一篇 `InstanceKlass`/数组细节提前讲爆
- 是否完成叙事字数、删码测试、禁用词与 `file:line` 核对
