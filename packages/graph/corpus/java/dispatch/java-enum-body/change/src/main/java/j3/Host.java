package j3;
enum Choice {
    FIRST {
        void run() { this.work(); }
        void work() { int changed = 1; }
    },
    SECOND {
        void run() { work(); }
        void work() {}
    };
    abstract void run();
    void named() { FIRST.run(); SECOND.run(); }
}
public class Host {
    void use(Choice choice) { choice.run(); }
}
