from .http import Wrapper
from .store import Cache, Store


class Service:
    def __init__(self, store: Store, wrapper: Wrapper, raw, mixed: Store):
        self.store = store
        self.wrapper = wrapper
        self.raw = raw
        self.mixed = mixed
        self.made = Cache()

    def swap(self):
        self.mixed = Cache()

    def run(self, key):
        self.store.get(key)
        self.wrapper.http.send(key)
        self.raw.get(key)
        self.mixed.get(key)
        self.made.get(key)
