package c;

public class Widget {
    private int size;

    public Widget(int size) {
        this.size = size * 2;
        this.init(); // @INIT
    }

    void init() {
        System.out.println(size + 1);
    }
}
