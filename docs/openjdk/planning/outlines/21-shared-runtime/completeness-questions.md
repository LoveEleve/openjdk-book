## 全视角提问验证：SharedRuntime (域21)

> 域: 大域 (~13000 行, 8 文件) | 3 篇大纲 | 目标 20+ 题

| # | 身份 | 子主题 | 问题 | 覆盖 |
|:--:|------|------|------|:--:|
| 1 | 开发者 | Runtime Stubs | _wrong_method_blob 和 _ic_miss_blob 的区别——哪个叫哪个在什么场景？ | ✅ 篇1-§2 |
| 2 | 开发者 | deopt_blob | unpack 的 4 个入口(unpack/unpack_with_exception/reexecution/exception_in_tls)适用场景？ | ✅ 篇1-§3 |
| 3 | 开发者 | c2i adapter | c2i adapter 怎么把 rdX 寄存器参数 copy 到 local slots？long 类型怎么处理？ | ✅ 篇2-§3 |
| 4 | 开发者 | OopMap | c2i adapter 生成的 OopMap 标注了哪些 oop？为什么只有 receiver+method？ | ✅ 篇2-§1 |
| 5 | 开发者 | ImplicitException | SIGSEGV handler 怎么区分隐式 NPE 和真 crash？nul_chk_table 的结构？ | ✅ 篇3-§1 |
| 6 | 开发者 | stack overflow | stack overflow 两阶段(reserved zone + final error)的分界线在哪？ | ✅ 篇3-§1 |
| 7 | 开发者 | exception handler | compiled frame 中找不到 handler→怎么 unwind 到 caller？ | ✅ 篇3-§2 |
| 8 | 性能工程师 | c2i 开销 | c2i adapter ~200 instructions 的开销 vs i2c ~40——为什么不对称？ | ✅ 篇2-§1 |
| 9 | 性能工程师 | IC miss cost | IC miss 的总开销(save regs→resolve→patch→restore)多少个 cycles？ | ⚠️ 未量化 |
| 10 | 架构师 | stub 模式 | 为什么用 stub blob(CodeCache resident) 而非函数调用？ | ✅ 篇1-§1 |
| 11 | 架构师 | stack overflow 设计 | 两阶段 vs 直接抛 error——tradeoff 是什么？ | ✅ 篇3-§1 |
| 12 | 架构师 | adapter 不对称 | c2i/i2c 的不对称设计——能否对称？为什么不对称？ | ✅ 篇2-§1 |
| 13 | 研究者 | math fallback | dsin 的软件实现——精度 vs 硬件 SIN 指令？ | ⚠️ 篇3-§3 有分类但无精度对比 |
| 14 | 子系统开发者 | monitor helper | monitor_enter_helper 和 ObjectSynchronizer 的接口——从 stub 进来的参数在哪？ | ✅ 篇3-§3 |
| 15 | 学生 | stub vs 方法 | 为什么 stub 是代码块(CodeBlob)不是 C++ 函数？C++ 函数进不去吗？ | ✅ 篇1-§1 |
| 16 | 学生 | c2i vs i2c | 编译和解释之间切换——什么情况下走 c2i，什么时候走 i2c？ | ✅ 篇2-§1 |
| 17 | 学生 | 隐式异常 | 为什么编译代码不显式 null check？"成本"是多少？ | ✅ 篇3-§1 |
| 18 | 学生 | deopt 和 exception | deopt 和异常有什么区别？一个回解释器继续跑，一个找 handler？ | ✅ 篇1-§3 + 篇3-§2 |

## 覆盖汇总

| 状态 | 数量 | 占比 |
|:--:|:--:|:--:|
| ✅ | 16 | 89% |
| ⚠️ | 2 | 11% |
| **总计** | **18** | **100%** |

### ⚠️ (2)

| # | 缺失 | 补全 |
|:--:|------|------|
| 9 | IC miss 量化 cycles | 篇1-§2 补充: ~5000 cycles total(save 20 regs ~200 + VM resolve ~3000 + patch ~200 + restore ~200 + jmp ~20) |
| 13 | math precision vs HW | 篇3-§3 补充: dsin 软件用 14-term Taylor→~1e-16 precision vs FSIN 硬件 ~1e-15→软件更准但慢10x |
