package app;

import com.acme.Thing;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class Svc {
    private static final Logger LOG = LoggerFactory.getLogger(Svc.class); // @FACTORY

    public void run() {
        LOG.info("run"); // @LOG
        Thing.create(); // @THING
        helper(); // @HELPER
    }

    void helper() {
        LOG.debug("help");
    }
}
