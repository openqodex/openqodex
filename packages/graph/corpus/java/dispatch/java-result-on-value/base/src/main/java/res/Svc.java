package res;

public class Svc {
    private Repo r;

    public String go(String id) {
        return r.find(id).normalize(); // @CALL
    }
}
