package n;

public class Other {
    public int go() {
        return Outer.Inner.run(); // @OUTSIDE
    }
}
