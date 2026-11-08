package app;

import repo.MemRepo;
import repo.Repo;
import repo.SqlRepo;

public class Run {
    public String go() {
        Repo r = new SqlRepo();
        String a = r.find("1"); // @DECL
        var m = new MemRepo();
        String b = m.find("2"); // @VAR
        return a + b;
    }
}
