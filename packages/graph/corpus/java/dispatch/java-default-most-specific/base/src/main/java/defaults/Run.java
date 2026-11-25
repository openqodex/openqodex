package defaults;

class Run {
    void direct() {
        new C().m();
        new C().n(1);
    }
    void reversed() {
        new Reversed().m();
        new Reversed().n(1);
    }
    void transitive() {
        new Transitive().m();
        new Transitive().n(1);
    }
    void diamond() {
        new Diamond().m();
        new Diamond().n(1);
    }
    void override() {
        new Override().m();
    }
    void superclass() {
        new ClassWins().m();
    }
    void counts() {
        new C().arity(1);
        new C().arity(1, 2);
    }
    void reAbstract(ReAbstract r) {
        r.m();
        r.n(1);
    }
    void reAbstractReversed(ReAbstractReversed r) {
        r.m();
        r.n(1);
    }
    void differentTypes() {
        new DifferentTypes().m("x");
    }
}
