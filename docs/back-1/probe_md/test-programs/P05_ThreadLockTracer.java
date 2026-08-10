/** 线程与锁追踪：线程创建 + synchronized + wait/notify + 锁竞争
 *  用法：java -Xint -Xlog:probe_runtime=debug:stdout P05_ThreadLockTracer
 *  关注：JavaThread 创建/运行/销毁、ObjectMonitor enter/exit/wait/notify 全路径
 */
public class P05_ThreadLockTracer {
    private static final Object LOCK = new Object();
    private static volatile boolean ready = false;

    public static void main(String[] args) throws Exception {
        // 1. 线程创建与启动（JavaThread::JavaThread → os::create_thread → run）
        Thread worker = new Thread(() -> {
            // 2. 无竞争快速加锁（FAST_PATH uncontended CAS）
            synchronized (LOCK) {
                ready = true;
                try {
                    // 3. wait + notify（ObjectMonitor::wait/notify 全路径）
                    LOCK.wait(100);
                } catch (InterruptedException e) { }
            }
        }, "Worker-1");
        worker.start();

        // 4. 主线程竞争同一把锁 → ObjectMonitor::EnterI 慢路径
        synchronized (LOCK) {
            while (!ready) {
                LOCK.wait(10);     // wait 重入路径
            }
            LOCK.notifyAll();     // 唤醒 worker 线程
        }

        worker.join();             // 线程退出 → JavaThread::~JavaThread
        System.out.println("ThreadLock trace complete");
    }
}
