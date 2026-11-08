package lam;

import java.util.function.Consumer;

public class Each {
    public static void each(String[] items, Consumer<String> fn) {
        for (String s : items) {
            fn.accept(s);
        }
    }
}
