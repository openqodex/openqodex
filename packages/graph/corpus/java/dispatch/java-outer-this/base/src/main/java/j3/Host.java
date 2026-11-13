package j3;
public class Host {
    void work() {}
    class Inner {
        void work() {}
        void run() {
            Host.this.work();
            this.work();
        }
    }
}
