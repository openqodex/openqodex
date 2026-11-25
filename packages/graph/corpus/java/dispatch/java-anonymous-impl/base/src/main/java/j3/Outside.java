package j3;
class Outside {
    void start() {}
    boolean cancel() { return true; }
    void create() {
        new Thread() {
            public void run() { start(); } // THREAD
        };
        new java.util.TimerTask() {
            public void run() { cancel(); } // TIMER
        };
    }
}
