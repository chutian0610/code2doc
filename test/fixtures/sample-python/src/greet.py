"""A greeter module."""

MOTTO = "hello "


def greet(name):
    """Return the greeting for name."""
    return MOTTO + name


class Greeter:
    """A greeter with a personality."""

    def __init__(self, prefix):
        self.prefix = prefix

    def greet(self, name):
        return self.prefix + name
