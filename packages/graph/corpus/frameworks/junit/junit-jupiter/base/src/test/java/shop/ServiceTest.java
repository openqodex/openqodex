package shop;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.RepeatedTest;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.AfterAll;
class ServiceTest {
  @Test void direct() { new Service().read(); }
  @RepeatedTest(2) void repeated() { new Service().read(); }
  @ParameterizedTest void parameterized(String value) { new Service().pick(value); }
  @BeforeEach void beforeEach() { new Service().read(); }
  @BeforeAll static void beforeAll() { new Service().read(); }
  @AfterEach void afterEach() { new Service().read(); }
  @AfterAll static void afterAll() { new Service().read(); }
  void helper() { new Service().read(); }
  @Test void indirect() { helper(); }
  @org.junit.jupiter.api.Disabled @Test void disabled() { new Service().read(); }
}
