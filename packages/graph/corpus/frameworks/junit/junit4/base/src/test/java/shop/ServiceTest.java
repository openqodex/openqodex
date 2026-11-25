package shop;
import org.junit.Test;
import org.junit.Before;
import org.junit.BeforeClass;
import org.junit.After;
import org.junit.AfterClass;
class ServiceTest {
  @Test(timeout = 100) public void reads() { new Service().read(); }
  @Before public void before() { new Service().read(); }
  @BeforeClass public static void beforeClass() { new Service().read(); }
  @After public void after() { new Service().read(); }
  @AfterClass public static void afterClass() { new Service().read(); }
}
