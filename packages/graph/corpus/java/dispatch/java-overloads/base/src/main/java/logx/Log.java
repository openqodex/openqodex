package logx;

public class Log {
    public static void log(String m) { // @L1
        System.out.println(m);
    }

    public static void log(String m, Throwable t) { // @L2
        System.out.println(m + t);
    }

    public static void log(String a, String b, String c) { // @L3
        System.out.println(a + b + c);
    }

    public static String fmt(String f, Object... args) { // @F
        return String.format(f, args);
    }
}
