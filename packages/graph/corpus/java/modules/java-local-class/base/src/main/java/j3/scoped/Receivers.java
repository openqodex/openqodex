package j3.scoped;
class Receivers {
    void register(Runnable task) { task.run(); }
    void factories() {
        record Pair(int value) {
            static Pair of() { return new Pair(1); }
            void use() {}
        }
        Pair.of(); // LOCAL_PAIR
        Pair.of().use(); // PAIR_RESULT
        enum Mode { A; }
        Mode.valueOf("A"); // LOCAL_MODE
        class Local {
            static void run() {}
            static Local make() { return new Local(); }
            void use() {}
        }
        register(Local::run); // LOCAL_REFERENCE
        var p = Local.make(); // LOCAL_FACTORY
        p.use(); // LOCAL_RESULT
    }
    void packagePair() { Pair.of(); } // PACKAGE_PAIR
    void genericReference() {
        class Box<T> {
            static <T> Box<T> make() { return new Box<T>(); }
        }
        register(Box::make); // LOCAL_GENERIC_REFERENCE
    }
}
