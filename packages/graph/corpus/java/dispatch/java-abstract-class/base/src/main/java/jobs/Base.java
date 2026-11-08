package jobs;

public abstract class Base {
    abstract void run();

    void go() {
        run(); // @CALL
    }
}
