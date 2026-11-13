package n;

public class Outer {
    public static class Inner {
        public static int run() {
            return 3;
        }
    }

    public int local() {
        return Inner.run(); // @INSIDE
    }
}
