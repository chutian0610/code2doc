# Greeting flow

One call, two shapes:

1. [greet](../../src/greet.ts "c2d:src/greet.ts#greet:d8d678d808e29df0.e25615d447c0fabf")
   computes the greeting directly — the common path.
2. [Greeter](../../src/greet.ts "c2d:src/greet.ts#Greeter:ff8c388155116962.6b4c8d8f5cfc9e4b")
   stores the greeting first; its `greet()` returns it unchanged.

For practical use, see [how to greet a user](../howtos/greet-a-user.md);
for the full surface, the [symbol reference](../reference/symbols.md).
