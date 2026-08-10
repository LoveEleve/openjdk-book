/** 解释器字节码追踪：覆盖 10+ 种关键字节码
 *  用法：java -Xint -Xlog:probe_interp=debug:stdout P04_InterpBytecodeTracer
 *  关注字节码：ldc / getstatic / new / dup / invokespecial / invokevirtual /
 *              getfield / putfield / monitorenter / monitorexit / return
 */
public class P04_InterpBytecodeTracer {
    private int counter = 42;     // putfield / getfield

    public void increment() {     // aload_0 / dup / getfield / iconst_1 / iadd / putfield
        counter++;
    }

    public int getCounter() {     // aload_0 / getfield / ireturn
        return counter;
    }

    public static void main(String[] args) {
        // ldc: 字符串常量 → InterpreterRuntime::ldc()
        String label = "counter value: ";

        // new + dup + invokespecial → InterpreterRuntime::_new()
        P04_InterpBytecodeTracer obj = new P04_InterpBytecodeTracer();

        // getfield(counter=42) + iconst_1 + iadd + putfield(counter=43)
        // → InterpreterRuntime::resolve_get_put()
        obj.increment();

        // invokevirtual → InterpreterRuntime::resolve_invoke()
        int val = obj.getCounter();

        // getstatic(System.out) + ldc + invokevirtual(println)
        System.out.println(label + val);

        // monitorenter + monitorexit → InterpreterRuntime::monitorenter()
        synchronized (obj) {
            obj.increment();
        }
    }
}
