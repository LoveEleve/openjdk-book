# 域 02: 数字与数学 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "Integer == 陷阱 / 缓存范围" — 01 篇 §1-2(IntegerCache, Integer.java:998-1000/1056)
- [x] "0.1+0.2 为什么不精确" — 02 篇 §1(IEEE-754)
- [x] "BigDecimal 为什么不用 new(double)" — 02 篇 §2(String 构造, BigDecimal.java:837)
- [x] "equals vs compareTo(1.0≠1.00)" — 02 篇 §3(BigDecimal.java:3077)
- [x] "BigInteger 怎么存储/乘法复杂度" — 02 篇 §4(mag, BigInteger.java:150/1565)
- [x] "NaN/Infinity 表示" — 03 篇 §1(doubleToLongBits, Double.java:854)
- [x] "Math vs StrictMath" — 03 篇 §3(StrictMath fdlibm)

## 身份 2: 生产工程师
- [x] 金额计算规范(intCompact/scale/HALF_UP)— 02 篇 §2-3
- [x] 浮点比较陷阱 — 03 篇 §4
- [x] 日志 Infinity/NaN 排查 — 03 篇 §1

## 身份 3: 框架工程师
- [x] 哈希扰动/位运算(衔接域 09 Map)— 01 篇 §3 提及,域 09 展开
- [x] 集合装箱成本(衔接域 08)— 01 篇 §2

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 Integer.java:437/499/604/997-1000/1056, BigDecimal.java:240/280/837/1601/2648/2882/3077, BigInteger.java:150/1565/1603/1662, Math.java:311/669/1433, Double.java:854)/关键设计/跨层([JLS]/[IEEE]/[内部卷])/核心悬念+OUTBOUND
- [x] 无文字描述源锚

## 身份 5: 完整性缺口检查
- [x] 缓存装箱(01)/精确计算(02)/浮点表示(03)三篇覆盖全部面试主战场
- [x] MathContext/RoundingMode 已并入 02 篇 §3
- [x] FloatingDecimal/DoubleToDecimal 已并入 03 篇 §2(注明 JDK19 演进)
- [x] StrictMath 实现细节(fdlibm 移植)不展开——🟢 Surface 决策
- [x] 未覆盖确认: Number 抽象与转换协议(01 篇 §4 覆盖)
- [ ] 待办: DoubleToDecimal 算法细节(最短往返表示)写作时需 grep JDK11 实际类名(旧 FloatingDecimal vs 新 DoubleToDecimal 在 JDK11 的分界)避免编造
