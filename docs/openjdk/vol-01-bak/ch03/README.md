# ch03 进度与下一步计划

> 更新日期：2026-06-30

## 已完成

| 文件 | 内容 | 状态 |
|------|------|------|
| 01-overview.md | 进程/线程模型、JNI_CreateJavaVM 入口 | ✅ |
| 02-threads-create-vm.md | create_vm 9 阶段骨架 | ✅ |
| 03-preamble-init.md | Stage 1 前置初始化 | ✅ |
| 04-args-parse.md | Stage 2 参数解析 | ✅ |
| 05-os-init2.md | Stage 3 OS 后初始化 + HotSpot 锁机制 | ✅ |
| 06-main-thread-create.md | Stage 4 主线程创建 | ✅ |

## 下一步：ch04 init_globals()

**边界**：从 `jint status = init_globals()` 开始，初始化 Java 堆、类加载器、代码缓存等 20+ 个 JVM 核心子系统。

## 后续章节规划

| 章节 | 文件 | 内容 |
|------|------|------|
| ch04/01 | init-globals.md | `init_globals()` —— Universe/Heap/SystemDictionary 初始化 |
