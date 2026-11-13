package bound;
class Host<T extends Repo & Marker> {
  void bounded(T value) {
    value.find();
  }
  <U extends Repo> void method(U value) {
    value.find();
  }
  <T> void unbounded(T value) {
    value.find();
  }
}
interface Marker {}
