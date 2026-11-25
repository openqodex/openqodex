package shop;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;
class ServiceTest {
  @Test void reads() { new Service().read(); }
}
