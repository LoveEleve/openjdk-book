## 全视角提问验证：StubRoutines (域23)

> 域: 大域 (~12000 行, 10 文件) | 3 篇大纲 | 目标 15+ 题

| # | 身份 | 子主题 | 问题 | 覆盖 |
|:--:|------|------|------|:--:|
| 1 | 开发者 | _code1 vs _code2 | _code1(initialize1)和_code2(initialize2)的分界是什么？哪些stub在genesis前必须存在？ | ✅ 篇1-§1 |
| 2 | 开发者 | atomic stubs | _atomic_cmpxchg_long_entry 为什么不能用内联汇编代替stub？ | ✅ 篇1-§3 |
| 3 | 开发者 | arraycopy | conjoint和disjoint路径——overlap检测在哪做？backward copy什么时候触发？ | ✅ 篇2-§1,§2 |
| 4 | 开发者 | SHA intrinsics | generate_sha256_implCompress — 用SHA-NI做什么优化？MB版比非MB版快在哪？ | ✅ 篇3-§1 |
| 5 | 开发者 | AES + GHASH | AES-GCM的 GHASH — 用pclmulqdq在Galois field做乘？ | ✅ 篇3-§1 |
| 6 | 开发者 | multiplyToLen | adcx/adox双carry-chain在BigInteger乘法中的作用？ | ✅ 篇3-§2 |
| 7 | 开发者 | math intrinsic | dsin为什么不用硬件FSIN？range reduction怎么做？ | ✅ 篇3-§3 |
| 8 | 性能工程师 | arraycopy 加速比 | erMSB vs SSE vs AVX2 vs AVX-512——各路径的吞吐/copy？ | ✅ 篇2-§2(3x vs rep_movsb) |
| 9 | SRE/运维 | 选择fallback | CPU不支持AES-NI——stub如何降级？是否有警告日志？ | ⚠️ 篇3-§1有硬件指令, fallback行为未展开 |
| 10 | 架构师 | StubRoutines vs JIT intrinsic | stub和JIT intrinsic的区别——什么情况选stub什么情况走intrinsic？ | ✅ 篇1-§1(genesis前vs后期) |
| 11 | 架构师 | generator解耦 | StubGenerator + StubRoutines 解耦 — 新CPU要添加AVX-512路径改哪里？ | ✅ 篇1-§1 |
| 12 | 学生 | stub vs 函数 | stub是存进CodeCache的汇编代码——为什么不能是C++函数？ | ✅ 篇1-§2 |
| 13 | 学生 | arraycopy 14入口 | 为什么需要14个入口而不是一个通用 arraycopy？ | ✅ 篇2-§1 |

## 覆盖汇总

| 状态 | 数量 | 占比 |
|:--:|:--:|:--:|
| ✅ | 12 | 92% |
| ⚠️ | 1 | 8% |
| **总计** | **13** | **100%** |

### ⚠️ (1)

| # | 缺失 | 补全 |
|:--:|------|------|
| 9 | crypto fallback行为 | 篇3-§1 补充: AES-NI不可用→用 lookup-table 软件实现(4x S-box substitution)→10-100x慢→log warning一次 |
