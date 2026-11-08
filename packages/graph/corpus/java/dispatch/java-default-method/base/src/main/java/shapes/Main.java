package shapes;

public class Main {
    public String show(Shape s) {
        return s.describe(); // @DESC
    }

    public String circle() {
        Circle c = new Circle();
        return c.describe(); // @CIRC
    }
}
