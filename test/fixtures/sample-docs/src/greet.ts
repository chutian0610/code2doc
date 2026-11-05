export function greet(name: string): string {
  return 'hello ' + name;
}

export class Greeter {
  greeting: string;
  constructor(g: string) {
    this.greeting = g;
  }
  greet(): string {
    return this.greeting;
  }
}
