# 11-cds/02-cds-load-shared 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释共享 archive 被 `mmap` 进来之后，为什么里面的 `InstanceKlass` 还不能直接当成活类使用，以及 HotSpot 如何把这批共享元数据重新接回运行时世界

## 1. 选题判断

现稿信息量大，覆盖了参数、校验、映射、初始化、三条类加载路径、恢复、符号表与堆子图，事实层面很扎实，但读者读完后可能仍然抓不住一个中心：

**既然 dump 端已经把类压成一份可映射内存镜像，为什么 load 端还要做这么多事？`mmap` 成功之后，这些共享类为什么不会“自动活过来”？**

这是本篇真正要打穿的困惑。

如果这个问题没回答透，读者就会把加载端误解成“文件打开成功 + 指针可用 = 类已经加载完成”。实际情况是：`mmap` 只把字节放到了正确地址，离“成为当前 JVM 的活类”还差几道门：运行环境兼容、共享字典接线、运行期地址补丁、类可见性检查、超类/接口一致性检查、`restore_unshareable_info` 恢复、最小化链接动作。

## 2. 一句话顿悟

**CDS load 端并不是“重新解析类”，也不是“什么都不用做”；它做的是一件更克制的事：先确认当前 JVM 仍满足 dump 时的全部前提，再把共享镜像映射回原位，补上所有不能跨进程保存的运行期地址与状态，最后让这些 `InstanceKlass` 以最轻的代价重新穿过类加载状态机，进入 `SystemDictionary`。**

## 3. 总图

```text
启动参数决定能不能尝试 CDS
  │
  ├─ FileMapInfo::initialize
  │    └─ 先验：这份 archive 还是不是“同一份世界观”
  │
  ├─ map_shared_spaces
  │    └─ 对位：把 mc/rw/ro/md 放回原来地址
  │
  ├─ initialize_shared_spaces
  │    └─ 接线：vtable / shared_dictionary / symbol&string table / heap archive
  │
  ├─ load_shared_class(...)
  │    └─ 可见性 + 超类/接口一致性 + CFLH 检查
  │
  ├─ restore_unshareable_info
  │    └─ 把 dump 时剥掉的运行期信息补回
  │
  └─ link_class
       └─ 跳过重解析/重写，只补验证约束与链接末梢
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么 `mmap` 进来不等于类已经加载完成

目标约 1200 字。

- 从 `source: shared objects file` 开场
- 点破读者直觉：文件映射成功 ≠ 当前 JVM 接受这批类
- 提前埋一句：共享类不是“读出来”，而是“接回去”

### 第二节：两个最自然的误解为什么都不对

目标约 1800 字。

必须推演：
1. 只要 `mmap` 成功，类就自动活了
2. 既然 dump 时已经处理完，load 端应该什么都不用做

落出的结论：
- `mmap` 只解决字节位置，不解决当前进程的运行期地址与状态
- dump 时剥掉的内容必须在当前进程重建，否则类不可执行

### 第三节：第一道门——先验“这还是不是当年那份世界”

目标约 1700 字。

- `-Xshare:on/auto/off`
- `Metaspace::global_initialize` → `initialize_runtime_shared_and_meta_spaces`
- `FileMapInfo::initialize`
- magic / version / jvm ident / verification / path misc info
- 讲清“拒绝归档”本质上是在拒绝一份不再满足假设的内存镜像

### 第四节：第二道门——为什么必须对位到原地址

目标约 1800 字。

- `map_shared_spaces`
- 连续布局要求 `mc->rw->ro->md`
- 预留整块地址空间，逐区 `map_region`
- 讲清“同址映射”不是优化，而是共享指针关系成立的前提
- 简述 heap regions 与 compressed class space 的相邻布局

### 第五节：第三道门——为什么映射完还要 `initialize_shared_spaces`

目标约 2200 字。

- `clone_cpp_vtables`
- `set_shared_dictionary`
- `serialize(&rc)` 读回 well-known klasses / symbol / string / offsets
- `patch_archived_heap_embedded_pointers`
- 主线：不能跨进程保存的地址、表头、函数入口，需要在当前 JVM 接线

### 第六节：共享类到底怎么进 `SystemDictionary`

目标约 2200 字。

- boot loader 路径：`find_shared_class` / `load_shared_class`
- builtin loader 路径：`find_or_load_shared_class`
- custom loader 路径：`lookup_from_stream` + `(name, size, crc32)`
- 讲清三条路径的共同点：最终都汇入 `load_shared_class(InstanceKlass*)`

### 第七节：共享类怎么“活过来”——`restore_unshareable_info` 与最轻量链接

目标约 2400 字。

- `is_shared_class_visible`
- 超类/接口必须与 dump 时同对象
- `restore_unshareable_info`
- `Method::unlink_method` / `link_method` / trampoline / adapter
- `InstanceKlass::link_class` 中 shared 分支只做 `check_verification_constraints`
- 主线：不是重新解析，而是恢复运行期缺失部件并走最轻的链接路径

### 第八节：符号、字符串与堆子图为什么也要单独恢复

目标约 1500 字。

- CompactHashtable 的只读查找意义
- shared symbol / shared string 的接入
- archived heap subgraph 只在需要时 materialize
- 让读者明白“共享类活了”，依赖的不只是 `InstanceKlass`

### 第九节：误解清单与总收网

目标约 1200 字。

至少回答：
1. `mmap` 成功是不是就等于类可用
2. load 端是否会重新跑 `ClassFileParser`
3. load 端是否会完整重跑 verifier / rewriter
4. 为什么要恢复 vtable 与 method entry
5. 为什么共享类还要重新走可见性与层级一致性检查

## 5. 失败方案必须写进正文

1. 只要文件映射成功，共享类就自动可用
2. dump 都做完了，load 端不应该再做任何修补

## 6. 证据清单

- `share/memory/metaspace.cpp:1294-1315`：运行时初始化入口
- `share/memory/metaspaceShared.cpp:216-249`：`initialize_runtime_shared_and_meta_spaces`
- `share/memory/filemap.cpp:1313-1413`：打开与头校验
- `share/memory/metaspaceShared.cpp:2033-2094`：`map_shared_spaces`
- `share/memory/metaspaceShared.cpp:2100-2141`：`initialize_shared_spaces`
- `share/classfile/systemDictionary.cpp:1133-1175`：共享字典与 boot 路径
- `share/classfile/systemDictionary.cpp:1183-1372`：`load_shared_class`
- `share/classfile/systemDictionaryShared.cpp:480-660`：builtin/custom loader 路径
- `share/oops/instanceKlass.cpp:777-841`：shared 类链接分支
- `share/oops/instanceKlass.cpp:2345-2380`：`restore_unshareable_info`
- `share/oops/method.cpp:977-1160`：method unlink / relink / trampoline

## 7. 必须明确的边界

- 基于 JDK 11u 当前 HotSpot 实现，不外推到所有版本或所有 JVM
- 本篇聚焦静态 CDS/AppCDS 的加载端，不展开 dynamic CDS
- Linux `mmap` 语义只作为当前平台实现背景，不外推到所有 OS
- heap archive 只讲恢复入口，不展开 G1 归档区管理细节

## 8. 完成后 review

- 删除代码后，能否复述“共享类不是自动活过来，而是被重新接入当前 JVM”
- 是否把校验、对位、接线、恢复、最小链接串成了一条主线
- 是否明确说明 load 端省掉了什么，又仍必须补什么
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
