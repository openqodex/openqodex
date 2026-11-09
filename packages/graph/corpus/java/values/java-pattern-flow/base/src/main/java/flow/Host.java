package flow;

class Host {
  Baz x;
  Baz s;
  void earlyReturn(Object o) {
    if (!(o instanceof Bar x)) return;
    x.go();
  }
  void negatedBranches(Object o) {
    if (!(o instanceof Bar x)) {
      x.go();
    } else {
      x.go();
    }
    x.go();
  }
  void nonAbrupt(Object o) {
    if (!(o instanceof Bar x)) { o = null; }
    x.go();
  }
  void positiveBranches(Object o) {
    if (o instanceof Bar x) {
      x.go();
    } else {
      x.go();
    }
    x.go();
  }
  void negatedWhile(Object o) {
    while (!(o instanceof Bar x)) {
      x.go();
      o = null;
    }
    x.go();
  }
  void positiveWhile(Object o) {
    while (o instanceof Bar x) { x.go(); }
    x.go();
  }
  void switchRule(Object o) {
    switch (o) {
      case Bar s -> s.go();
      default -> s.go();
    }
    s.go();
  }
  void abruptBlock(Object o) {
    if (!(o instanceof Bar x)) { o = null; return; }
    x.go();
  }
  void abruptThrow(Object o, RuntimeException failure) {
    if (!(o instanceof Bar x)) throw failure;
    x.go();
  }
  void abruptBreak(Object o) {
    for (;;) {
      if (!(o instanceof Bar x)) break;
      x.go();
    }
    x.go();
  }
  void abruptContinue(Object o, boolean keep) {
    for (; keep;) {
      if (!(o instanceof Bar x)) continue;
      x.go();
    }
    x.go();
  }
  void doubleNegation(Object o) {
    if (!!(o instanceof Bar x)) { x.go(); }
    x.go();
  }
  void tripleNegation(Object o) {
    if (!(!(!(o instanceof Bar x)))) return;
    x.go();
  }
  void disjunction(Object o, boolean flag) {
    if (o instanceof Bar x || flag) { x.go(); }
    if (!(o instanceof Bar x || flag)) return;
    x.go();
  }
  void conjunction(Object o) {
    if (o instanceof Bar x && x.ok()) { x.go(); }
  }
  void nestedBlock(Object o) {
    {
      if (!(o instanceof Bar x)) return;
      x.go();
    }
    x.go();
  }
  void nestedCondition(Object o, boolean flag) {
    if (o instanceof Bar x) {
      if (flag) { x.go(); }
    }
  }
  void negatedConjunctionLeft(Object o, boolean flag) {
    if (!(o instanceof Bar x) && flag) return;
    else { x.go(); }
    x.go();
  }
  void negatedConjunctionRight(Object o, boolean flag) {
    if (flag && !(o instanceof Bar x)) return;
    else { x.go(); }
    x.go();
  }
  void wrappedPattern(Object o) {
    if (!check(o instanceof Bar x)) return;
    else { x.go(); }
    x.go();
  }
  void equalityPattern(Object o, boolean flag) {
    if ((o instanceof Bar x) == flag) { x.go(); }
    x.go();
  }
  void conditionalPattern(Object o, boolean flag) {
    if (flag ? o instanceof Bar x : false) { x.go(); }
    x.go();
  }
  void negatedWholeConjunction(Object o, boolean flag) {
    if (!(o instanceof Bar x && flag)) return;
    x.go();
  }
  void whileBreak(Object o, boolean done) {
    while (!(o instanceof Bar x)) {
      if (done) break;
      o = next();
    }
    x.go();
  }
  void whileNestedBreaks(Object o, boolean done, int mode, Object[] items) {
    while (!(o instanceof Bar x)) {
      for (int i = 0; i < 1; i++) { break; }
      for (Object item : items) { break; }
      while (done) { break; }
      do { break; } while (done);
      switch (mode) { case 0: break; default: break; }
      Runnable task = () -> { while (done) { break; } };
      class Nested { void stop() { while (done) { break; } } }
      o = next();
    }
    x.go();
  }
  void whileLabeledBreak(Object o, boolean done) {
    outer: while (!(o instanceof Bar x)) {
      for (;;) {
        if (done) break outer;
        break;
      }
      o = next();
    }
    x.go();
  }
  void branchReferences(Object o) {
    if (o instanceof Bar x) {
      run(x::go);
      Runnable r = x::go;
      r.run();
      x.go();
    } else {
      other();
    }
  }
  boolean check(boolean value) { return value; }
  Object next() { return null; }
  void run(Runnable task) { task.run(); }
  void other() {}
  void unbracedWhile(Object o, boolean a) {
    if (a) while (!(o instanceof Bar x)) o = next();
    else x.go();
  }
  void unbracedIf(Object o, boolean a) {
    if (a) if (!(o instanceof Bar x)) return; else other();
    else x.go();
  }
  void unbracedDo(Object o, boolean flag) {
    do if (!(o instanceof Bar x)) break; while (flag);
    x.go();
  }
  void ownLabelBreak(Object o) {
    L: if (!(o instanceof Bar x)) break L;
    x.go();
  }
  void nestedOwnLabelBreak(Object o, boolean c) {
    L: if (!(o instanceof Bar x)) { if (c) break L; return; }
    x.go();
  }
  void labeledReturn(Object o) {
    M: if (!(o instanceof Bar x)) return;
    x.go();
  }
}
