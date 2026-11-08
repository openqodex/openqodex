package generic;
class Box<T> {
  T get() { return null; }
}
class Pair<A, B> {
  B get() { return null; }
}
class Shadow<T> {
  <T> T get() { return null; }
}
class SBox extends Box<Repo> {}
class P<X> extends Box<Repo> {}
class Other {
  int find() { return 3; }
}
