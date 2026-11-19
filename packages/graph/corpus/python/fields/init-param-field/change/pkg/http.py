class Http:
    def send(self, path):
        return [path]


class Wrapper:
    def __init__(self, *, http: Http):
        self.http = http
