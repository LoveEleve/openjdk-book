/** JVM 启动完整追踪
 *  用法：java -Xint -Xlog:probe_runtime=debug:stdout P01_StartupTracer
 *  关注：INST_PHASE_RUNTIME 的 7 个阶段标记
 */
public class P01_StartupTracer {
    public static void main(String[] args) {
        System.out.println("Hello JVM — startup trace complete");
    }
}
