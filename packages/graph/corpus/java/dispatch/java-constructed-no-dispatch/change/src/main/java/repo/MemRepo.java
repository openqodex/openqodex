package repo;

public class MemRepo implements Repo {
    public String find(String id) {
        return "mem:" + id;
    }
}
