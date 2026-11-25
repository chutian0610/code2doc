"""Internal helpers: underscore names never count for Missing."""

import greet

_QUOTA = 12


def _resolve(name):
    return greet.Greeter(name).greet()[:_QUOTA]
