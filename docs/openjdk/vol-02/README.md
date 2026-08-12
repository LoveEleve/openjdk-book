# 卷 2 · 运行时深处（按域规划写作中）

> 2026-08-11 建立 | 组织方式: 按 `planning/outlines/` 的 48 域目录,213 个 md 文件(152 篇正文大纲)逐域写作
> 写作顺序: **48 域依赖拓扑 7 层**（`../planning/knowledge-planning/00-domain-writing-order.md`）——依赖驱动排序（WRITING-GUIDELINES §2），从基础域写起
> 素材: 工具卷素材库 `planning/outlines/00-jvm-tools/materials/INDEX.md`（130+ 命令输出 / 21 截图 / 10 JFR 录制）

## 进行中

| 批 | 域 | 状态 |
|---|---|---|
| 第 1 批（地基） | 01-os（[01-platform-detection](01-os/01-platform-detection.md) / [02-virtual-memory](01-os/02-virtual-memory.md) / [03-threads-and-sync](01-os/03-threads-and-sync.md) / [04-signals-and-safepoint](01-os/04-signals-and-safepoint.md) 完成 — **01-os 域完结**）；05-cpu-primitives（[01-atomic-and-memory-order](05-cpu-primitives/01-atomic-and-memory-order.md) / [02-safefetch-and-platform](05-cpu-primitives/02-safefetch-and-platform.md) 完成 — **05 域完结**）；45-math-library（[01-poly-approximation](45-math-library/01-poly-approximation.md) / [02-stubroutine-native](45-math-library/02-stubroutine-native.md) 完成 — **45 域完结**）；48-utilities（[01-vmerror](48-utilities/01-vmerror.md) / [02-concurrent-bitmap](48-utilities/02-concurrent-bitmap.md) / [03-stream-exception](48-utilities/03-stream-exception.md) / [04-utf8-json-decoder](48-utilities/04-utf8-json-decoder.md) 完成 — **48 域完结,第 1 批 12 篇全部完成**） | ✅ 第 1 批完结 |
| 第 2 批（原语） | 02-assembler（[01-codebuffer-abstract-assembler](02-assembler/01-codebuffer-abstract-assembler.md) / [02-x86-register-operand-encoding](02-assembler/02-x86-register-operand-encoding.md) / [03-x86-assembler-instruction-set](02-assembler/03-x86-assembler-instruction-set.md) 完成,04 待写） / 03-flags / 04-logging / 06-oops / 16-codecache / 38-perfdata / 41-zipjimage / 42-core-native | 进行中 |
| 第 3 批（对象/类） | 07-classfile-classloader / 09-memory-core / 17-threads | 未开始 |
| 第 4 批（执行/帧） | 10-metaspace / 19-sync / 23-stub / 24-frame-stack / 08-interpreter / 31-unsafe / 44-verification | 未开始 |
| 第 5 批（VM 核心） | 11-cds / 12-ci / 13-jit / 18-safepoint / 20-vmops / 27-jni / 30-jvm-entry / 32-jfr / 34-nmt / 36-attach / 37-heapdump / 39-runtime-mon / 46-sa | 未开始 |
| 第 6 批（JIT/GC） | 14-c1 / 15-c2 / 21-shared-runtime / 25-gc / 28-jvmti / 29-mh / 33-jmx / 43-nio-net | 未开始 |
| 第 7 批（上层） | 22-deopt / 26-g1 / 35-dcmd / 40-launcher / 47-instrumentation | 未开始 |

## 归档说明

- 旧 `vol-01`（启动链叙事 14 章）已归档为 [`vol-01-bak`](../vol-01-bak/ch01)，新写作按域规划组织
