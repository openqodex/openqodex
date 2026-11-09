package c;

public class Widget {
    private int size;

    public Widget(int size) {
        this.size = size;
        this.init(); // @INIT
    }

    void init() {
        System.out.println(size);
    }
}
