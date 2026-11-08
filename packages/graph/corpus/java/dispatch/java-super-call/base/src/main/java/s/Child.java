package s;

public class Child extends Base {
    public void run() {
        super.run(); // @SUPER
        System.out.println("child");
    }
}
