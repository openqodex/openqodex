package j3;
class Constants {
    void use() {
        Choice.FIRST.run(); // FIRST_VALUE
        Choice.SECOND.run(); // SECOND_VALUE
        Plain.ONLY.run(); // PLAIN_VALUE
    }
}
enum Plain {
    ONLY;
    void run() {}
    void named() { ONLY.run(); } // PLAIN_BARE
}
