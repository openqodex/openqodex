package shop;
class ServiceTest {
  @org.junit.jupiter.api.Test void reads() { new Service().read(); }
  @org.junit.jupiter.api.custom.Test void unrelated() { new Service().read(); }
}
