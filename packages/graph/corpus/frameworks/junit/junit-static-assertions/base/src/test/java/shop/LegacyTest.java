package shop;
import org.junit.*;
import static org.junit.Assert.*;
class LegacyTest {
  @Test public void reads() { new Service().read(); }
}
