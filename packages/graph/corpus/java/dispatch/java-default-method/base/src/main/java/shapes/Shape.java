package shapes;

public interface Shape {
    double area();

    default String describe() {
        return "area " + area(); // @AREA
    }
}
