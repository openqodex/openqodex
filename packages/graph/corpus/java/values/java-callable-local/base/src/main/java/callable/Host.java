package callable;

import java.util.function.Function;
import java.util.function.Supplier;

class Host {
    void refresh() {}
    void replacement() {}
    String overloaded(String value) { return value; }
    String overloaded(Integer value) { return value.toString(); }
    void run() {}

    void direct() {
        Runnable r = this::refresh;
        r.run();
    }

    void staticValue() {
        Supplier<String> s = Factory::make;
        s.get();
    }

    void overload() {
        Function<String, String> f = this::overloaded;
        f.apply("input");
    }

    void reassigned(boolean again) {
        Runnable r = this::refresh;
        if (again) {
            r = this::replacement;
        }
        r.run();
    }

    void passedOn() {
        Runnable r = this::refresh;
        submit(r);
    }

    void submit(Runnable r) {
        r.run();
    }
}
