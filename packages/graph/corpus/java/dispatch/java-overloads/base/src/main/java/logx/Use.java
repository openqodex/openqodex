package logx;

public class Use {
    public void go(Throwable err) {
        Log.log("one"); // @C1
        Log.log("two", err); // @C2
        Log.log("a", "b", "c"); // @C3
        String s = Log.fmt("%s %s %s", "x", "y", "z"); // @C4
    }
}
