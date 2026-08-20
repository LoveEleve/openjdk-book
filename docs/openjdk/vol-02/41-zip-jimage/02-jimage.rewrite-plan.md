# 41-zip-jimage/02-jimage 重写规划

> 基于 `OpenJDK 11u / libjimage / Linux / x86_64`
> 目标：解释 JDK 9+ 为什么不再把自己运行所需的类和资源继续放在 ZIP/JAR 里，而要单独设计 jimage；同时讲清 jimage 如何把“索引构建成本”从运行时转移到构建时，用前置索引、完美哈希、mmap 与资源头协议换取更稳定的启动期读取路径

## 1. 选题判断

现稿已有较强事实基础：
- `ImageFileReader::open`
- `memory_map_image`
- redirect table 三态与 `ImageStrings::find`
- `verify_location`
- `get_resource`
- `ResourceHeader` 与 `ImageDecompressor`

但当前正文仍偏“jimage 的组件说明书”。真正该打穿的读者困惑更集中：

**既然上一章的 ZIP/JAR 路径已经能靠 CEN + 哈希表 + 惰性读取把查找成本压下来，JDK 为什么还要单独发明 jimage？它到底把哪些运行时成本提前搬到了构建期，为什么这会让 JDK 自己的模块镜像比 ZIP 更合适？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**jimage 不是“另一个压缩包格式”，而是把 JDK 自己当成近乎只读镜像来组织：ZIP 把目录放尾部、运行时打开时再建哈希，jimage 则在构建阶段就把整套前置索引、完美哈希和字符串去重表算好。运行时打开镜像时，HotSpot 主要是在映射一份已经预排好的查找结构；查找资源时不再构建索引，而是直接用 redirect table 驱动的最小完美哈希定位，再用 verify 作最后保险。**

## 3. 总图

```text
ZIP/JAR
  运行时打开时
    ├─ 先找尾部目录(CEN)
    ├─ 再建哈希表
    └─ 条目读取时惰性碰 LOCAL / 解压

jimage
  构建时(jlink)
    ├─ 先算前置索引
    ├─ 先算完美哈希 redirect table
    └─ 先做字符串去重与资源属性编码

  运行时打开时
    ├─ 校验头部
    ├─ mmap 全文件或索引区
    ├─ 切出 redirect / offsets / location / strings 四段
    └─ 查找时直接 find + verify_location
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——ZIP 已经够快了，为什么 JDK 还要造 jimage

目标约 1200 字。

- 从上一章的 libzip 路径切入
- 点出：ZIP 已经有目录区、哈希、惰性读取，但运行时仍然要先“打开并建索引”
- 埋主线：JDK 自己的镜像可以把这笔成本前置到构建期

### 第二节：两个朴素方案为什么都不行

目标约 1800 字。

必须推演：
1. 继续沿用 ZIP，只要把 JAR 再做大一点、缓存再积极一点
2. 运行时打开 jimage 后再像 ZIP 那样临时建哈希表

结论：
- JDK 自己的基础镜像是“高频、稳定、只读”资源集合，值得预计算
- jimage 的价值恰恰在于把运行时建索引这件事消掉

### 第三节：打开阶段——为什么 jimage 像映射磁盘镜像，不像打开压缩包

目标约 2100 字。

- `ImageFileReader::open`
- `ImageHeader` 校验
- `index_size()`、四段切分
- `memory_map_image` 的 64 位/32 位分流
- 强调“映射一份已经排好的索引结构”

### 第四节：查找阶段——为什么 redirect table 是构建期算好的完美哈希

目标约 2300 字。

- `ImageStrings::find`
- 负值 / 正值 / 0 三态
- `HASH_MULTIPLIER` 与 FNV-1a 变体
- 论文注释和“运行时不再建哈希”主线
- `verify_location` 的必要性：完美哈希也不等于完全不验

### 第五节：为什么 verify 仍然存在——完美哈希不是无需复核的神谕

目标约 1700 字。

- `verify_location` 分段比对 `/module/parent/base.extension`
- 说明 `find()` 的结果仍是“should be”位置
- 强调这层保险是针对任意查询字符串，而不是构建集合内部资源名

### 第六节：读取资源——为什么 mmap、压缩头和解压器栈能同时存在

目标约 2200 字。

- `get_resource`
- `memory_map_image` 时压缩数据直取地址，否则 `read_at`
- 未压缩资源仍走 `read_at`
- `ResourceHeader` 与 `ImageDecompressor::decompress_resource`
- “镜像 ≠ 全都不压缩”；真正被前置的是索引，不是所有正文成本

### 第七节：布局与 ZIP 的总对比——为什么一个前置索引，一个尾部目录

目标约 1800 字。

- `index_size` 与四段布局
- 字符串表去重
- 对比上一章 CEN + 哈希的运行时建表模型
- 收回“jimage 把运行时索引成本前置到构建时”主线

### 第八节：误解澄清与收网

目标约 1300 字。

至少回答：
1. jimage 是否只是“更快的 ZIP”
2. mmap 全文件是否在所有平台都默认
3. 完美哈希是否意味着完全不需要 verify
4. jimage 是否不支持压缩
5. 未压缩资源是否总能零拷贝

## 5. 失败方案必须写进正文

1. 继续用 ZIP，只靠运行时缓存和建表就够了
2. jimage 运行时再临时建索引
3. 把完美哈希误解成“运行时无需任何复核”

## 6. 证据清单

- `src/java.base/share/native/libjimage/imageFile.cpp:44`：`memory_map_image`
- `src/java.base/share/native/libjimage/imageFile.cpp:52`：jimage 目标注释
- `src/java.base/share/native/libjimage/imageFile.cpp:59`：`ImageStrings::hash_code`
- `src/java.base/share/native/libjimage/imageFile.cpp:75`：`ImageStrings::find`
- `src/java.base/share/native/libjimage/imageFile.cpp:369`：`ImageFileReader::open`
- `src/java.base/share/native/libjimage/imageFile.hpp:437`：`index_size`
- `src/java.base/share/native/libjimage/imageFile.hpp:443`：`IMAGE_MAGIC` / 版本
- `src/java.base/share/native/libjimage/imageFile.hpp:493`：`map_size`
- `src/java.base/share/native/libjimage/imageFile.cpp:483`：`verify_location`
- `src/java.base/share/native/libjimage/imageFile.cpp:533`：`get_resource`
- `src/java.base/share/native/libjimage/imageDecompressor.hpp:56`：`ResourceHeader`
- `src/java.base/share/native/libjimage/imageDecompressor.hpp:68`：解压器栈注释
- `src/java.base/share/native/libjimage/imageDecompressor.cpp:142`：`decompress_resource`
- `src/java.base/share/native/libjimage/imageDecompressor.cpp:189`：`ZipDecompressor`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / libjimage / Linux / x86_64`
- 本篇聚焦运行时读取视角，不展开 jlink 构建算法细节
- `jrt:/` 文件系统与 Java 层 API 只在必要处点边界
- 不把压缩机制扩成完整 imageDecompressor 专题
- 后续如不继续本域，也要让本篇自成“为什么 JDK 不用 ZIP”的闭环

## 8. 完成后 review

- 删除代码后，能否复述“jimage 把运行时索引成本前置到构建时”
- 是否清楚区分完美哈希定位与 verify 最终裁决
- 是否至少完整推演了两个失败方案，而不是直接列组件
- 是否讲清 `memory_map_image`、资源读取和解压器栈的边界
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
