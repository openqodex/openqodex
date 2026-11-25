package shop;
import org.junit.jupiter.api.Test;
class ServiceTest extends AbstractIntegrationTest {
  @Test void reads() { new Service().read(); }
}
class Middle extends external.Base {}
class IndirectTest extends Middle {
  @Test void reads() { new Service().read(); }
}
class KnownBase {}
class KnownTest extends KnownBase {
  @Test void reads() { new Service().read(); }
}
