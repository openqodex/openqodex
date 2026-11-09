package lam;

public class App {
    public void go(String[] xs) {
        Each.each(xs, s -> { // @EACH
            Printer.show(s); // @SHOW
        });
    }
}
