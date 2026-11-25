package shop;
import org.junit.jupiter.api.*;
import other.annotations.*;
class RepositoryTest {
  @Test void reads() { new Service().read(); }
}
