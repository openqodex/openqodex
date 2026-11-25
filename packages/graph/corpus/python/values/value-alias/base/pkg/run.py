from .steps import helper


def run():
    fn = helper
    return fn()


def other():
    return "other"


def outer():
    cb = helper

    def inner():
        cb = other
        return cb()

    return cb()


handler = helper


def separate():
    handler = other
    return handler()


handler()
