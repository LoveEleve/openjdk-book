# 07-classfile-classloader/06-jpms-modules 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JPMS 在类加载与访问控制上究竟多加了哪两道门，以及这些门如何叠加在上一章的 parent delegation / bootstrap visibility 之上

## 1. 选题判断

现稿的开场“public 不再对所有人可见”方向是对的，但整体仍偏组件说明书：ModuleEntryTable、PackageEntry、can_read、`--add-exports` 并排介绍。读者容易知道字段名，却不一定记住 JPMS 到底新增了什么机制。

真正的读者困惑：

**上一章已经有了 class loader 的委派与 SystemDictionary 的 initiating/defining loader 协议，JPMS 还额外加了什么？为什么类字节可以被定位到，不代表这个类就能被另一个模块正常链接或反射访问？readability、export/open、boot-loader 包可见性三者到底分别卡在哪一层？**

## 2. 一句话顿悟

**JPMS 没有替代 class loader，而是在“类能否被找到”之后，再叠加两道门：第一道是模块可读性（source module 是否 reads target module），第二道是包导出/开放（target package 是否 export/open 给 caller）。加载器和模块表先决定能不能找到 bytes；`ModuleEntry` 决定能不能读目标模块；`PackageEntry` 决定目标包是否对你公开；Java reflection 再按自己路径重放这些规则。**

## 3. 总图

```text
类请求 / 反射请求
  │
  ├─ loader visibility（上一章）
  │    ├─ package -> module owner routing
  │    ├─ bootstrap visibility / search_append_only
  │    └─ bytes 是否能被定位并定义成 Class
  │
  ├─ readability gate
  │    └─ ModuleEntry::can_read(target_module)
  │         ├─ unnamed reads everyone
  │         ├─ everyone reads java.base
  │         ├─ default read edges (special JVMTI case)
  │         └─ explicit _reads list
  │
  ├─ package export/open gate
  │    └─ PackageEntry
  │         ├─ unqualified export
  │         ├─ qualified export list
  │         ├─ all-unnamed export
  │         └─ open module override
  │
  ├─ C++ linkage/access checks
  │    └─ Reflection::verify_class_access / LinkResolver
  │
  └─ Java reflection checks
       └─ Module.isExported / Reflection.verifyModuleAccess / AccessibleObject rules
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——类已经能被找到，为什么还会 `IllegalAccessError`

目标约 1000 字。

- 从“类能 load 到，但链接/反射仍失败”的事故开场
- 区分三种问题：能不能定位 bytes、能不能读目标模块、目标包有没有 export/open 给你
- 指出“public 不再是唯一门槛”，但也不能写成“public 失效了”
- 回收上一章：class loader delegation 只解决了去哪里找类，不解决跨模块访问策略

### 第二节：三个朴素方案为什么都不够

目标约 1800 字。

至少推演：

1. 只靠 class loader 委派决定可见性 → 找到类不等于允许使用它
2. 只加模块级可读性，不管 package export/open → 内部包会被整个模块暴露出去
3. 只靠 Java `Module.isExported` 判断一切 → VM 链接期、superclass/interface 检查、boot visibility 与 Java reflection 不是同一条路径

引出：
- loader/package ownership 先决定“类在哪”
- readability 决定“模块之间能不能看”
- package export/open 决定“这个包对谁公开到什么程度”

### 第三节：ModuleEntryTable / PackageEntryTable——为什么模块与导出必须分两层存

目标约 1800 字。

- 每个 non-anonymous CLD 拥有 package table 和（按需创建的）module table
- `ModuleEntry` 记 `_reads`、`_module`、`_pd`、`_is_open`、`_is_patched` 等
- 关键纠偏：没有 `_exports` 字段，导出信息不在模块条目里
- `PackageEntry` 才有 `_export_flags` 和 `_qualified_exports`
- 这样拆层的原因：可读性是模块级，导出是包级

### 第四节：第一道门——类字节能不能被 loader 看到

目标约 1700 字。

- boot / builtin loader 的 package -> module owner 路由
- `ClassPathImageEntry::open_stream_for_loader` 如何先用 package 找 module，再在 jimage 下查 `/module/package/class`
- boot loader 的 search_append_only 边界来自 `SystemDictionary::load_instance_class`
- `--patch-module`、runtime image、boot append 搜索顺序
- 这一层是物理定位/定义边界，不等于 export/readability

### 第五节：第二道门——readability，为什么读不到模块就别谈类型访问

目标约 1800 字（核心拆解层）。

- `ModuleEntry::can_read`
- 三个特例：unnamed reads everyone、everyone reads java.base、default read edges
- `_reads` 是 direct read list，不是运行时递归做整个图传递闭包
- `addReads` / `--add-reads` 修改的是这一层
- 强调：readability 失败时，即使类被 loader 找到，也不能完成正常的跨模块类型访问

### 第六节：第三道门——export/open，为什么 public 仍然不够

目标约 2200 字（核心拆解层）。

- `PackageEntry` 的三态：未导出、限定导出、未限定导出；另加 open module override
- `PKG_EXP_ALLUNNAMED` 不是未限定导出，是“对所有 unnamed modules 的限定导出语义”
- `set_exported` / `set_is_exported_allUnnamed` 的单向加强：不能从 unqualified 退回 qualified，也不能退回未导出
- `ModuleEntry::_is_open` 不是 per-package `_opens` list，而是 module-wide open override
- `--add-exports` / `--add-opens` 修改的是这层，不是 readability
- 纠偏：“public 不再对所有人可见”要改成“public 仍是类/成员级前提，但跨模块还要满足 read + export/open”

### 第七节：C++ 与 Java 两条检查路径——同一规则，不是同一个函数

目标约 1900 字。

- C++ linkage: `Reflection::verify_class_access` / `LinkResolver::check_klass_accessability`
  - 先 same module / unnamed / readability
  - 再 open/export
  - 失败抛 `IllegalAccessError`
- Java reflection: `Reflection.verifyModuleAccess` / `Module.isExported`
  - 主要是 export check
  - member-level Java modifier/nestmate/protected/package checks 再后续处理
  - `Module.isExported` 自身不检查 readability
- `AccessibleObject` 对 open package 的额外要求
- 这解释了“C++ 存数据、Java 做部分判断”的上一版说法需要细化：VM 链接和 Java 反射各有一套检查入口，但依赖同一底层模块/package state

### 第八节：`--add-exports` / `--add-opens` / `--add-reads`——三条“走后门”的链路不要混

目标约 1700 字。

- HotSpot 参数解析只把它们转成 `jdk.module.*` properties，不直接改 ModuleEntry
- `ModuleBootstrap` 在 boot layer 定义后才 decode 和应用这些选项
- `--add-reads` 改 reads
- `--add-exports` 改 export flags / qualified targets
- `--add-opens` 改 opens 语义，主要服务深反射
- `Modules` facade -> JVM entry -> `Modules::*` -> HotSpot tables
- 强调 default read edges 与 `--add-exports` 不是一回事

### 第九节：误解澄清与收网

目标约 1100 字。

至少回答：

1. public 是否在模块时代失效
2. 类被 loader 找到是否等于模块可访问
3. `ModuleEntry` 是否保存 exports
4. `can_read` 是否就是完整访问检查
5. `Module.isExported` 是否会检查 readability
6. `--add-exports` 是否等于 `--add-reads`
7. `ALL-UNNAMED` 是否等于 unqualified export
8. open module / `--add-opens` 是否等于把模块读边放开

## 5. 失败方案必须写进正文

1. 只靠 class loader 委派决定可见性
2. 只加模块级 reads，不管 package export/open
3. 只用 Java `Module.isExported` 概括全部模块访问检查

## 6. 证据清单

- `classLoaderData.hpp:250-255`、`classLoaderData.cpp:164-180,636-653`：module/package table per CLD
- `moduleEntry.hpp:52-78,124-160,195-216`：ModuleEntry / ModuleEntryTable fields 与 open/patched/default-read flags
- `packageEntry.hpp:47-111,133-190,217-219`：PackageEntry / export flags / qualified exports / per-CLD package table
- `packageEntry.cpp:37-48,50-65,90-127`：qualified export checks, list semantics, monotonic strengthening
- `systemDictionary.cpp:1403-1476`：bootstrap visibility checks and search_append_only
- `classLoader.cpp:490-520,1405-1487`：package -> module owner lookup and bootstrap byte search order
- `moduleEntry.cpp:115-145,147-168,192-196,296-305,361-397`：`can_read`, all-unnamed, open, patched modules
- `Reflection::verify_class_access` in `runtime/reflection.cpp:491-568,596-643`：C++ access/linkage path and error messages
- `linkResolver.cpp:285-324`：link-time `IllegalAccessError`
- `Reflection.java:92-214`：Java reflection `ensureMemberAccess` / `verifyModuleAccess`
- `Module.java:302-331,356-415,429-565,608-665,775-909,1634-1653`：Java-side reads/exports/opens APIs and runtime reflective state
- `Modules.java:81-123`：internal addExports/addOpens facade
- `ModuleBootstrap.java:403-427,607-731,835-902`：boot-time decode and application of add-reads/exports/opens properties
- `jvm.cpp:1008-1037`：native entry points for define module / add exports / add reads
- `modules.cpp:501-728`：HotSpot implementation of exports to named/all-unnamed and reads
- `jvmtiExport.cpp:438-465,878-883`：default read edges for instrumentation

## 7. 必须明确的边界

- 基于 OpenJDK 11u / HotSpot / Linux / x86_64
- JPMS 不替代 class loader；它叠加在 loader 可见性之上
- 物理定位类字节、readability、export/open、Java language access flags 是四层不同问题
- `ModuleEntry` 记录 reads/open/patched；package export state在 `PackageEntry`
- `can_read` 不是 transitive graph 算法，也不是完整访问检查
- `Module.isExported` 不检查 readability
- `--add-exports` / `--add-opens` / `--add-reads` 三条链路必须分开
- default read edges 是 JVMTI/instrumentation 特例，不是普通 module graph 默认规则

## 8. 完成后 review

- 删除代码后能否复述“loader 找到类 -> reads -> export/open -> Java/VM 各自访问检查”的完整链条
- 是否纠正了 public 失效、ModuleEntry 带 exports、Module.isExported 包打天下等误解
- 是否把 loader visibility 与 JPMS policy 两层真正分开
- 是否明确 `ALL-UNNAMED`、open module、default read edges 的各自语义
- 是否完成删码测试、禁用词、file:line、链接和版本边界检查
