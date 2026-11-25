package j3;
class NamedJobs {
    void refresh() {}
    class Job extends OutsideBase {
        void done() { refresh(); } // OUTSIDE_REFRESH
    }
}
class LocalBase {}
class LocalJobs {
    void refresh() {}
    class Job extends LocalBase {
        void done() { refresh(); } // LOCAL_REFRESH
    }
}
