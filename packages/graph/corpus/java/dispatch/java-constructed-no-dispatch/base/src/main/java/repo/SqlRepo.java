package repo;

public class SqlRepo implements Repo {
    public String find(String id) {
        return "sql " + id;
    }
}
