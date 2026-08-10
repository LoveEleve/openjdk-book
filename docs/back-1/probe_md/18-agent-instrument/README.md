# Phase 18: Agent & Instrument — libinstrument.so + libattach.so + libdt_socket.so + libjdwp.so + libmanagement_agent.so

## 概述

深度分析 OpenJDK HotSpot 的 Agent 加载机制、java.lang.instrument API、JVMTI 核心、Attach API、JDWP 调试协议、以及 Management Agent 的完整实现。覆盖 **5 个独立 .so 文件** 和 `libjvm.so` 中的 JVMTI 核心实现。

## BUILD_LIBRARY 目标

| .gmk 文件 | NAME | .so | 模块 |
|-----------|------|-----|------|
| `make/lib/Lib-java.instrument.gmk:40` | instrument | libinstrument.so | java.instrument |
| `make/lib/Lib-jdk.attach.gmk:38` | attach | libattach.so | jdk.attach |
| `make/lib/Lib-jdk.jdwp.agent.gmk:31` | dt_socket | libdt_socket.so | jdk.jdwp.agent |
| `make/lib/Lib-jdk.jdwp.agent.gmk:54` | jdwp | libjdwp.so | jdk.jdwp.agent |
| `make/lib/Lib-jdk.management.agent.gmk:31` | management_agent | libmanagement_agent.so | jdk.management.agent |

JVMTI 核心（`JvmtiEnv`, `JvmtiExport`, `VM_RedefineClasses` 等）编译进 `libjvm.so`，通过 `make/hotspot/lib/JvmFeatures.gmk:71-78` 的 `jvmti` feature flag 控制。

## 源码规模

| 子系统 | C/CPP | Header | Java | 总行数 |
|--------|-------|--------|------|--------|
| libinstrument.so | 4,426 | 935 | 2,437 | 7,798 |
| libattach.so | 265 | — | 771 | 1,036 |
| libdt_socket.so | 1,400 | 128 | — | 1,528 |
| libjdwp.so | 23,810 | 2,418 | — | 26,228 |
| libmanagement_agent.so | 74 | — | — | 74 |
| JVMTI 核心 (libjvm.so) | 22,163 | 4,350 | — | 26,513 |
| Agent 参数解析 + ClassFileLoadHook | ~10,933 | — | — | ~10,933 |
| **总计** | **63,071** | **7,831** | **3,208** | **74,110** |

## 核心架构

```
Java API 层:   Instrumentation / VirtualMachine / JDWP
      ↓
Native Agent:  libinstrument.so (JPLISAgent)  /  libattach.so  /  libjdwp.so
      ↓
JVMTI 核心:    libjvm.so (JvmtiEnv / JvmtiExport / VM_RedefineClasses)
      ↓
OS 层:         Unix Domain Socket / SIGQUIT / dlopen
```

## 文档拆分方案（7 篇，按执行流顺序）

| # | 文档 | 覆盖 .so | 核心源码行数 | 核心内容 |
|:--:|------|---------|:---:|---------|
| **01** | Agent 加载 | libinstrument.so | ~4,700 | 参数解析 → Agent_OnLoad → JPLISAgent → VMInit → premain |
| **02** | ClassFileLoadHook | libinstrument.so + libjvm.so | ~6,000 | ClassFileLoadHook → transformClassFile → Java Transformer |
| **03** | Attach API | libattach.so + libjvm.so + libmanagement_agent.so | ~1,800 | Socket → SIGQUIT → loadAgent → Agent_OnAttach → agentmain |
| **04** | Redefine/Retransform | libjvm.so | ~8,000 | VM_RedefineClasses → safepoint → redefine_single_class |
| **05** | JVMTI 核心 | libjvm.so | ~14,000 | JvmtiEnv 300+ 函数、事件控制器、能力管理、TagMap |
| **06** | JDWP Transport+Init | libdt_socket.so + libjdwp.so | ~8,000 | dt_socket → debugInit → debugLoop 主循环 → 命令分发 |
| **07** | JDWP 命令+事件 | libjdwp.so | ~18,000 | 17 CommandSet → eventHandler → threadControl → stepControl |

### 依赖关系

```
01 (Agent 加载) ──→ 02 (ClassFileLoadHook) ──→ 04 (Redefine/Retransform)
  │                    │                              │
  │                    └────→ 05 (JVMTI 核心) ←───────┘
  │
  └──→ 03 (Attach API — 第二条加载路径)
        
06 (JDWP Transport+Init) ──→ 07 (JDWP 命令+事件)
```

### 推荐阅读顺序

01 → 02 → 03 → 04 → 05 → 06 → 07

## libmanagement_agent.so 归属

`libmanagement_agent.so` 仅 74 行 native 代码（`FileSystemImpl.c` 的 `isAccessUserOnly0` 函数），合并到 **03 (Attach API)** 作为安全权限检查小节。

## 标准工作流

```
① 规划(本文件) → ② Prompt 写作(会话A) → ③ 文档生成(会话B) → ④ Review
```

0. 规划确认（已完成）
1. Prompt 写作：scout → reader → tracer → 汇总写出 prompt（≥450行/篇）
2. 文档生成：在新会话中读 prompt → 按指令生成文档
3. Review：自检 12 项 Checklist → 修复 gap → 标记完成

**IMPORTANT**：
- Prompt 写作和文档生成必须在不同会话中完成
- 每次最多生成 2 篇文档
- 生成前 re-read 质量锚点 `probe_md/15-core-native/prompts/prompt-00-System-Arraycopy.md`
