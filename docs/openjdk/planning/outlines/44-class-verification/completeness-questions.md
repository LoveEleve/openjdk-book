# 域 44 Class Verification — 全视角提问验证

> 🟡 普通域 | 5 身份 | 8 问

## 1. Java 开发者 (2问)

1. 我的 class 文件用 JDK 8 编译但运行在 JDK 11 上——Verifier 会重新验证吗？StackMapTable 版本兼容性怎么处理？
2. `new Foo(); astore_1; aload_1; invokevirtual Foo.bar()` — 这段 bytecode 为什么 VerifyError？`<init>` 调用必须在 invokevirtual 之前？

## 2. 安全研究者 (2问)

3. StackMapTable 的类型检查能防止所有类型混淆攻击吗？如果攻击者篡改 StackMapTable 本身(改成 all-Top), Verifier 会怎么处理？
4. `-Xverify:none` 完全跳过验证——性能提升多少？OpenJDK 是否有 exploit 利用 `-Xverify:none` 绕过安全沙箱？

## 3. JVM 开发者 (2问)

5. StackMapTable split verifier (JDK 7+) 和旧 inferencing verifier (JDK 6-) 有什么区别？为什么 split verifier 更快？
6. VerificationType::from_tag 在 verificationType.cpp:33——为什么 `ITEM_Top` 映射到 `bogus_type()` 而非 "top_type()"？

## 4. 性能工程师 (1问)

7. ClassVerifier 在 safepoint 外执行——多个 ClassLoader 并发 load class 时 verification 是否线程安全？verification 能不能被 GC 中断？

## 5. 架构师 (1问)

8. 为什么验证在 JVM 层而不在 javac 层？javac 产生 valid bytecode——但为什么还要 Verifier？
