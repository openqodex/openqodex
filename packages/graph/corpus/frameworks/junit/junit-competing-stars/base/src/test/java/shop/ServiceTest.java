package shop;
import org.junit.jupiter.api.*;
import org.mockito.*;
import org.junit.jupiter.params.provider.*;
class ServiceTest {
  @Test void reads() { new Service().read(); }
}
