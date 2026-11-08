package shop;
class ServiceTest {
  String text = "@org.junit.jupiter.api.Test void fake() {}";
  // @org.junit.jupiter.api.Test void comment() {}
  @org.junit.jupiter.api.TestFactory void factory() { new Service().read(); }
  @org.junit.jupiter.api.Test void reads() { new Service().read(); }
}
