package an;

class Named extends java.util.ArrayList<Object> {
    void m() {}
    void m(Object... args) {}
    void run() { m(); }
}

class Spread extends java.util.ArrayList<Object> {
    void m(Object... args) {}
    void run() { m(); }
}

class Sub extends Named {
    void invoke() { m(); } // INHERITED_FIXED
}
