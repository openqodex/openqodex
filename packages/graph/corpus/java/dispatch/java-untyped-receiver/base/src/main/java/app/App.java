package app;

import com.vendor.Service;

public class App {
    private Service service;

    public void go() {
        service.client().send("x"); // @CALL
    }
}
