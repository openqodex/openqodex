package defaults;

class C implements A, B {}
class Reversed implements B, A {}
interface Bridge extends A {}
interface Leaf extends Bridge {
    default void m() {}
    default void n(int value) {}
}
class Transitive implements A, Leaf {}
interface Other {
    default void m() {}
    default void n(int value) {}
}
class Diamond implements A, Other {}
class Override implements A, B {
    public void m() {}
}
class Parent {
    public void m() {}
}
class ClassWins extends Parent implements A {}
interface B2 extends A {
    void m();
    void n(int x);
}
abstract class ReAbstract implements A, B2 {}
abstract class ReAbstractReversed implements B2, A {}
interface StringDefault {
    default void m(String s) {}
}
interface IntegerDefault extends StringDefault {
    default void m(Integer i) {}
}
class DifferentTypes implements IntegerDefault {}
