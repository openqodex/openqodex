package j3.scoped;
class Pair {
    static Pair of() { return new Pair(); }
    void use() {}
}
class Mode {
    static Mode valueOf(String name) { return new Mode(); }
}
class Local {
    static void run() {}
    static Local make() { return new Local(); }
    void use() {}
}
class Box<T> {
    static <T> Box<T> make() { return new Box<T>(); }
}
