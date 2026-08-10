import java.util.ArrayList;

/** G1 分配与 GC 追踪：TLAB 分配 / Humongous 对象 / Young GC 触发
 *  用法：java -Xms256m -Xmx256m -XX:+UseG1GC \
 *            -Xlog:probe_gc=debug:stdout \
 *            -Xlog:probe_runtime=debug:stdout \
 *            -cp . P07_G1AllocTracer
 *  注意：256MB 堆 → 1MB Region（快速触发 GC）
 *  关注：TLAB refill、Humongous 分配、Young GC pause 全路径
 */
public class P07_G1AllocTracer {
    public static void main(String[] args) {
        ArrayList<byte[]> list = new ArrayList<>();

        // Phase 1: 小对象 TLAB 分配（不触发 GC）
        for (int i = 0; i < 100; i++) {
            list.add(new byte[1024]);        // 1KB → TLAB 分配
        }

        // Phase 2: 中等对象 → 可能触发 TLAB refill 或 Young GC
        for (int i = 0; i < 50; i++) {
            list.add(new byte[512 * 1024]);  // 512KB 对象
        }

        // Phase 3: Humongous 对象（> 512KB = Region 大小一半）
        byte[] humongous = new byte[600 * 1024];  // 600KB → Humongous Region

        // Phase 4: 释放一半引用 → 后续 GC 回收
        for (int i = 0; i < list.size() / 2; i++) {
            list.set(i, null);
        }

        System.gc();  // 显式触发 GC
        System.out.println("humongous size=" + humongous.length
            + ", list size=" + list.size());
    }
}
