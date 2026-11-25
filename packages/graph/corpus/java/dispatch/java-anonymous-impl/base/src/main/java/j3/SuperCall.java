package j3;
interface Printable { String toString(); }
class SuperCall {
    void create() {
        new Printable() {
            public String toString() { return super.toString(); } // INTERFACE_SUPER
        };
    }
}
