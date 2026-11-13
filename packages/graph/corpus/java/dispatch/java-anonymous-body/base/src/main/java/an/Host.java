package an;

public class Host {
    void m() {
        System.out.println("host");
    }

    Runnable task() {
        return new Runnable() {
            void m() {
                System.out.println("anonymous");
            }

            public void run() {
                this.m(); // @ANON
            }
        };
    }
}
