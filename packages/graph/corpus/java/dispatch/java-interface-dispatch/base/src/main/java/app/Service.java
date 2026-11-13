package app;

import store.Item;
import store.Repo;

public class Service {
    private Repo repo; // @FIELD

    public Item get(String id) {
        return repo.find(id); // @CALL
    }
}
