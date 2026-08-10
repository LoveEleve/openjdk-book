public class DeadLoop {
    public static void main(String[] args) throws Exception {
        System.out.println("PID=" + ProcessHandle.current().pid() + " — attach GDB now");
        while (true) {
            Thread.sleep(1000);
        }
    }
}
