# 12-ci/01-ci-overview-mirror 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JIT 明明需要读大量 VM 元数据，为什么不能直接抓 `InstanceKlass/Method/oop`，以及 ci 镜像层如何在 GC、并发类加载、类重定义与编译性能之间找平衡

## 1. 选题判断

现稿已有丰富素材：ciObject 双通道引用、ciObjectFactory 唯一镜像、well-known 全局共享、ciInstanceKlass 的快照与懒字段、ciMethod 的标量快照、ciField 的常量判定、Dependencies 的收尾。

但现稿主线仍偏“模块说明书”：先讲 ciObject，再讲工厂，再讲 ciInstanceKlass，再讲 ciMethod、ciField、Dependencies。读者看完会知道很多点，却未必真正回答开篇那个最重要的问题：

**JIT 明明就跑在 HotSpot 里面，为什么不能直接去读 `InstanceKlass`、`Method`、`fieldDescriptor` 和 `oop`？它到底缺的是什么，才逼出了一整层 ci 镜像？**

这才是本篇真正的读者困惑。

## 2. 一句话顿悟

**JIT 缺的不是“访问 VM 对象的入口”，而是一份在整个编译期间都稳定、便宜、可跨 GC、又不会把 VM 运行时细节整桶带进编译热路径的只读视图。ci 层的作用，就是把 VM 的活对象降级成编译器可持有的镜像快照；对会移动的 oop 用句柄隔离，对不会移动的 Metadata 直接引用，对会变旧的假设再交给 Dependencies 托底。**

## 3. 总图

```text
编译器需要类/方法/字段信息
  │
  ├─ 直接抓 VM 对象？
  │    ├─ oop 会被 GC 搬动
  │    ├─ VM 对象太重，查询成本高
  │    └─ 类层级/重定义会让假设过期
  │
  ├─ ciEnv
  │    └─ 一次编译的上下文与 Arena
  │
  ├─ ciObject / ciMetadata
  │    ├─ oop -> JNI handle
  │    └─ Metadata -> 直接指针
  │
  ├─ ciObjectFactory
  │    ├─ 一次编译一份镜像缓存
  │    └─ well-known 对象全局共享
  │
  ├─ 具体镜像
  │    ├─ ciInstanceKlass: 快照标量 + 懒字段
  │    ├─ ciMethod: 编译决策常用标量快照
  │    └─ ciField: 偏移/常量性/链接预检
  │
  └─ Dependencies
       └─ 快照过期时，编译产物作废
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——JIT 明明在 VM 里，为什么不能直接读 `InstanceKlass`

目标约 1300 字。

- 从 `PrintInlining` / 调用去虚拟化现象开场
- 明确编译器确实需要类、方法、字段、profile 信息
- 反问：既然这些对象都在 VM 里，为什么不直接读

### 第二节：三个朴素方案为什么都会出事

目标约 2000 字。

必须推演：
1. 直接持有 oop / `InstanceKlass*` / `Method*`
2. 编译时每查一次都进 VM 现问现答
3. 做一个“永远共享”的全局编译缓存

结论：
- oop 会移动，裸指针会悬空
- 每次都回 VM 查询，编译热路径会被 VM 运行时复杂性拖垮
- 全局缓存跨编译会话会过期，类加载/重定义会让镜像失真

### 第三节：ci 层真正提供的，不是语法糖，而是“编译期稳定视图”

目标约 1600 字。

- `ciBaseObject` / `ciObject` / `ciMetadata` 的分工
- 把“编译器对象”定义为镜像，而不是 VM 实体
- 埋一句：镜像不追求永真，只追求本次编译足够稳定

### 第四节：双通道引用——为什么 oop 走句柄，Metadata 走裸指针

目标约 1900 字。

- `ciObject` 的 handle 语义
- `ciMetadata` 的直接指针语义
- `is_loaded()` / unloaded 语义
- 解释“为什么编译与 GC 可以互不干扰”

### 第五节：为什么是一编译一工厂，而不是一个全局镜像池

目标约 2200 字。

- `ciEnv` 的 Arena 生命周期
- `ciObjectFactory` 的唯一镜像不变量
- `_ci_metadata` 排序数组 + `_non_perm_bucket` 桶缓存
- 只在 well-known 类/符号上做全局共享
- 讲清“跨编译共享”和“每次编译新建”的边界

### 第六节：`ciInstanceKlass`——快照哪些，懒算哪些，哪些还要回 VM

目标约 2200 字。

- `_init_state/_flags/_nonstatic_field_size` 等标量快照
- `update_if_shared` / shared klass 特殊处理
- `_super/_java_mirror/_nonstatic_fields` 懒展开
- `is_subtype_of` 仍回 VM
- `implementor` / `unique_concrete_subklass` 的保守策略

### 第七节：`ciMethod` 与 `ciField`——编译决策最常用的两份快照

目标约 2200 字。

- `ciMethod` 抄哪些标量、哪些延迟
- snapshot invocation counts 的意义
- hotswap 让方法直接变不可编译
- `ciField` 的 offset / constant / `will_link`
- 强调这两者是“把高频查询降成快照位读”

### 第八节：快照为什么不会把编译器带偏——Dependencies 收尾

目标约 1500 字。

- 快照天然会过期
- Dependencies 负责登记“编译建立在哪些事实之上”
- 假设失效时 nmethod 作废，不要求 ci 镜像实时同步世界变化

### 第九节：误解清单与收网

目标约 1200 字。

至少回答：
1. ci 层是不是 VM 对象的深拷贝
2. ci 层是不是完全不回 VM
3. Metadata 裸指针为什么可以，而 oop 不行
4. 为什么普通类不能跨编译共享 ci 镜像
5. Dependencies 和 ci 镜像分别负责什么

## 5. 失败方案必须写进正文

1. 直接把 VM 对象指针交给编译器长期持有
2. 所有问题都靠“每次查询回 VM”解决
3. 给所有类做一份跨编译永久共享的 ci 镜像缓存

## 6. 证据清单

- `share/ci/ciObject.hpp:33-44`：ciObject 的总注释
- `share/ci/ciObject.cpp:53-76`：oop/Handle 构造与 JNI handle
- `share/ci/ciObject.hpp:138-140`：`is_loaded()`
- `share/ci/ciBaseObject.hpp:50-66`：ci 对象基类与 ident
- `share/ci/ciEnv.cpp:130-132` / `:190-192` / `:215-222`：per-compilation env/factory 生命周期
- `share/ci/ciObjectFactory.hpp:32-37`：唯一镜像不变量
- `share/ci/ciObjectFactory.cpp:106-120`：全局共享初始化
- `share/ci/ciObjectFactory.cpp:123-206`：shared objects / shared ident
- `share/ci/ciObjectFactory.cpp:238-258`：oop 镜像缓存
- `share/ci/ciObjectFactory.cpp:292-334`：metadata 镜像缓存
- `share/ci/ciObjectFactory.cpp:379-399`：Metadata 分派
- `share/ci/ciKlass.cpp:68-82`：`is_subtype_of` 仍回 VM
- `share/ci/ciInstanceKlass.hpp:50-68` / `:108-129` / `:165-175`：快照字段与 shared 更新
- `share/ci/ciMethod.cpp:76-149`：方法快照
- `share/ci/ciField.cpp:216-324`：字段常量性与读值
- 现稿中的 Dependencies 相关 file:line 后续补齐

## 7. 必须明确的边界

- 基于 JDK 11u 当前 HotSpot C1/C2 共用的 ci 层，不外推到 Graal/JVMCI
- 本篇聚焦镜像层与编译可见性，不展开 CompileBroker 调度与后续 IR 构建细节
- Dependencies 只讲角色，不在本篇深挖失效链路与 deopt 细节

## 8. 完成后 review

- 删除代码后，能否复述“ci 层解决的是稳定视图问题，而不是单纯封装 API”
- 是否把 GC、并发类加载、重定义、编译热路径成本串成一个共同动机
- 是否清楚区分了：哪些信息是快照、哪些是懒算、哪些仍需回 VM、哪些靠 Dependencies 托底
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
