package j3;
public class Host {
    void first() {
        class Local {
            void run() { this.work(); }
            void work() {}
        }
        Local x = new Local();
        x.run();
    }
    void second() {
        class Local {
            void run() { work(); }
            void work() {}
        }
        Local x = new Local();
        x.run();
    }
    void blocks() {
        {
            class Local { void run() {} }
            new Local().run();
        }
        {
            class Local { void run() {} }
            new Local().run();
        }
        new Local().run();
    }
}
