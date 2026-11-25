package j3;
public class Host {
    void work() { int changed = 1; }
    class Inner {
        void work() {}
        void run() {
            Host.this.work();
            this.work();
        }
    }
}
