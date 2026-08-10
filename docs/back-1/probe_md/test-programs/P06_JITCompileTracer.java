/** JIT 编译追踪：热点方法编译 + 分层编译升级
 *  用法：java -Xlog:probe_jit=debug:stdout -XX:+PrintCompilation P06_JITCompileTracer
 *  注意：不加 -Xint，让 JIT 自然触发
 *  关注：compile_method 触发、CompileTaskWrapper 生命周期、编译结果安装
 */
public class P06_JITCompileTracer {

    // 热点方法1：纯计算，触发 C1 编译
    static long hotLoop(int n) {
        long sum = 0;
        for (int i = 0; i < n; i++) {
            sum += i * i;
        }
        return sum;
    }

    // 热点方法2：字符串操作，C2 编译（profile 充足后）
    static String hotString(int n) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) {
            sb.append(i % 10);
        }
        return sb.toString();
    }

    public static void main(String[] args) {
        long total = 0;
        // 循环 10000 次 → hotLoop 热点触发 compile_method
        for (int i = 0; i < 10_000; i++) {
            total += hotLoop(100);
        }
        // 循环 5000 次 → hotString 热点触发编译
        String result = "";
        for (int i = 0; i < 5_000; i++) {
            result = hotString(50);
        }
        System.out.println("total=" + total + ", last=" + result);
    }
}
