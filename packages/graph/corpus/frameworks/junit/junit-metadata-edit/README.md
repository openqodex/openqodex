The base declares a same-package Test annotation in another file. That declaration shadows the JUnit star import.
The change deletes only the shadowing annotation file. ServiceTest.java stays byte-identical. Resolution must use the new repository context.
