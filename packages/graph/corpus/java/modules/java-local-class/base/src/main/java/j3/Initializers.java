package j3;
class Initializers {
    void h() {}
    {
        class Local {
            void run() { h(); } // INSTANCE_INITIALIZER
        }
        new Local().run();
    }
    static void stat() {}
    static {
        class Local {
            void run() { stat(); } // STATIC_INITIALIZER
        }
        new Local().run();
    }
}
