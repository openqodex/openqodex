package generic;
import java.util.List;
class Host {
  void direct(Box<Repo> box) {
    box.get().find();
  }
  void nested(Box<Box<Repo>> box) {
    box.get().get().find();
  }
  void second(Pair<String, Repo> pair) {
    pair.get().find();
  }
  void raw(Box box) {
    box.get().find();
  }
  void external(List<Repo> list) {
    list.get(0).find();
  }
  void wildcard(Box<? extends Repo> box) {
    box.get().find();
  }
  void shadow(Shadow<Repo> box) {
    box.get().find();
  }
  void inherited(SBox box) {
    box.get().find();
  }
  void parameterized(P<Other> box) {
    box.get().find();
  }
}
