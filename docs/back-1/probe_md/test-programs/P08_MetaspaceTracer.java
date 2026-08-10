import java.lang.reflect.*;

/** 元空间追踪：类加载 → Metaspace 分配 → Reflection 元数据
 *  用法：java -Xint \
 *            -Xlog:probe_meta=trace:stdout \
 *            -Xlog:probe_class=debug:stdout \
 *            -cp . P08_MetaspaceTracer
 *  注意：probe_meta 是 trace 级别
 *  关注：Metaspace 分块分配、ClassLoaderData、Klass 元数据创建
 */
public class P08_MetaspaceTracer {

    // 多个不同形状的内部类 → 触发不同大小的 Klass 元数据分配
    static class InnerA { int x; }
    static class InnerB { long y; String z; }
    static class InnerC { double a; float b; }
    static class InnerD implements java.io.Serializable { }
    static class InnerE extends InnerD { int[] arr; }

    public static void main(String[] args) throws Exception {
        // 加载内部类（触发 Klass 创建 → Metaspace 分配）
        Class<?>[] classes = {
            InnerA.class, InnerB.class, InnerC.class,
            InnerD.class, InnerE.class
        };

        // 反射访问（触发 ConstantPool 和 Method 元数据解析）
        for (Class<?> c : classes) {
            String name = c.getSimpleName();
            for (Field f : c.getDeclaredFields()) {
                System.out.println(name + "." + f.getName());
            }
        }

        // 动态代理（生成新类 → Metaspace allocation）
        InvocationHandler handler = (proxy, method, args1) -> "proxy result";
        Runnable proxy = (Runnable) Proxy.newProxyInstance(
            P08_MetaspaceTracer.class.getClassLoader(),
            new Class<?>[] { Runnable.class },
            handler
        );
        proxy.run();

        System.out.println("Metaspace trace complete");
    }
}
