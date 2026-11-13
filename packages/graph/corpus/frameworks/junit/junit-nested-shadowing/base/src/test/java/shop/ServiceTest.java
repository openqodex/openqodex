package shop;
import org.junit.jupiter.api.Test;
class ServiceTest {
  @Test void shadowed() { new Service().read(); }
  @interface Test {}
  class Inner {
    @Test void nested() { new Service().read(); }
  }
}
class InheritedTest extends Parent {
  @Test void inherited() { new Service().read(); }
}
