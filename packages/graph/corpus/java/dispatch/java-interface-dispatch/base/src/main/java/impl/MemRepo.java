package impl;

import store.Item;
import store.Repo;

public class MemRepo implements Repo { // @IMPL
    public Item find(String id) { // @FIND
        return new Item();
    }
}
