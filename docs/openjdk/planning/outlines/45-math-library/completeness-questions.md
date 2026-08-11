# 域 45 Math Library — 全视角提问验证

> 🟡 普通域 | 5 身份 | 8 问

## 1. Java 开发者 (2问)

1. `Math.sin(1e100)` — 这么大的数怎么算 sin？double 不是只有 53-bit mantissa 吗——为什么还能得到正确结果？
2. `Math.sin(x)` vs `StrictMath.sin(x)` — 为什么 Math.sin 快(~38 cycles)但 StrictMath.sin 慢(~300 cycles JNI)？精度有区别吗？

## 2. 性能工程师 (2问)

3. fast_sin 多项式用 Horner's method 9 terms — 为什么不是 13 terms？多加 4 terms 能把误差从 <1 ULP 降到 <0.5 ULP 吗？
4. StubRoutines::_dsin 在 JVM 启动时生成——如果 JVM 启动 100 次(serverless cold start)——这些 stub 的生成时间能缓存吗？

## 3. 编译器研究者 (2问)

5. Payne-Hanek 用 160-bit extended precision 计算 `x * 2/π` — 为什么 160-bit 不是 128-bit(SSE) 或 256-bit(AVX)？5 个 32-bit word = 160-bit 这个数字是怎么选的？
6. C2 intrinsic inline Math.sin 时——是直接 inline fast_sin 的 x86 code 还是 call StubRoutines stub？两种方式的 trade-off？

## 4. 安全研究者 (1问)

7. `Float.floatToRawIntBits(Float.NaN)` 返回 int bits——这个 bits 是 canonical NaN 还是 payload-preserving？不同 NaN payload 编码会泄漏什么信息？

## 5. SRE/运维 (1问)

8. `-XX:-UseSinIntrinsic` flag 禁用后——Math.sin(x) 走什么路径？StubRoutines stub？还是 SharedRuntime JNI？性能降多少？
