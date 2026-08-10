import java.util.*;

/** 类加载完整追踪
 *  用法：java -Xint -Xlog:probe_class=debug,probe_oop=debug:stdout P02_ClassLoadTracer
 *  关注：ClassFileParser 解析阶段 → SystemDictionary 查找 → link/init
 */
public class P02_ClassLoadTracer {
    public static void main(String[] args) {
        // 触发 String 类解析（常量池 ldc）
        String s = "hello";

        // 触发 ArrayList 类加载 + 方法调用（invokevirtual → vtable）
        ArrayList<String> list = new ArrayList<>();
        list.add(s);
        list.size();

        // 自定义接口 + 实现类（触发 itable + interface class loading）
        Greeter g = new EnglishGreeter();
        g.greet("world");    // invokeinterface → itable lookup
        System.out.println("ClassLoad trace complete");
    }
}

interface Greeter { void greet(String name); }

class EnglishGreeter implements Greeter {
    public void greet(String name) {
        System.out.println("Hello, " + name + "!");
    }
}
