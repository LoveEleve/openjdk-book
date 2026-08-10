/** 对象模型追踪：分配 + 字段布局 + 方法分派
 *  用法：java -Xint -Xlog:probe_oop=debug,probe_interp=debug:stdout P03_ObjectModelTracer
 *  关注：oop 分配、klass_at_impl 常量池解析、虚表方法查找
 */
public class P03_ObjectModelTracer {
    private int    id;
    private String name;
    private long   timestamp;

    public P03_ObjectModelTracer(int id, String name) {
        this.id = id;
        this.name = name;
        this.timestamp = System.currentTimeMillis();
    }

    public int    getId()        { return id; }        // getfield (int)
    public String getName()      { return name; }      // getfield (reference)
    public long   getTimestamp() { return timestamp; } // getfield (long, 8bytes)

    public static void main(String[] args) {
        // new + invokespecial (构造器) → 触发 InstanceKlass::allocate_instance
        P03_ObjectModelTracer obj = new P03_ObjectModelTracer(1, "test");

        // invokevirtual → vtable index lookup
        int    i = obj.getId();
        String n = obj.getName();
        long   t = obj.getTimestamp();

        // ldc "hello" → ConstantPool::string_at
        String msg = "hello";

        System.out.println(msg + ": " + i + ", " + n + ", " + t);
    }
}
