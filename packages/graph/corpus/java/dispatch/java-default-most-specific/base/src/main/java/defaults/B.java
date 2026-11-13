package defaults;

interface B extends A {
    default void m() {}
    default void n(int value) {}
    default void arity(int first, int second) {}
}
