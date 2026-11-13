package j3;
class RepoResult { void done() {} }
class OtherResult { void done() {} }
class Repo { RepoResult go() { return new RepoResult(); } }
class Other { OtherResult go() { return new OtherResult(); } }
class Fields {
    void create() {
        Repo repo = new Repo();
        new FieldTask() {
            Other repo = new Other();
            public void run() { repo.go().done(); } // ANONYMOUS_FIELD
        };
        class Local {
            Other repo = new Other();
            void run() { repo.go().done(); } // LOCAL_FIELD
            void parameter(Repo repo) { repo.go().done(); } // PARAMETER
        }
        new Local().run();
        new FieldTask() {
            public void run() { repo.go().done(); } // CAPTURED_LOCAL
        };
    }
}
interface FieldTask { void run(); }
