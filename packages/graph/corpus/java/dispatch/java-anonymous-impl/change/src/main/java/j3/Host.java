package j3;
interface Task { void run(); }
public class Host {
    void enclosing() {}
    void shared() {}
    void accept(Task task) { task.run(); }
    void start() {
        accept(new Task() {
            void shared() {}
            void helper() { int changed = 1; }
            public void run() {
                helper();
                this.helper();
                shared();
                enclosing();
                Host.this.shared();
            }
        });
    }
}
