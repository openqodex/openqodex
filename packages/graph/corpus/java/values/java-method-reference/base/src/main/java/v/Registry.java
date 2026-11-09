package v;

import java.util.ArrayList;
import java.util.List;

public class Registry {
    private final List<String> names = new ArrayList<>();

    public void register(Runnable r) {
        r.run();
    }

    public void handle(String s) {
        System.out.println(s);
    }

    public void setup() {
        register(Worker::run); // @REG
        names.forEach(this::handle); // @EACH
    }
}
