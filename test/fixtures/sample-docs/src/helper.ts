function helper(): void {
  // internal helper, not exported
}

const internalAnswer = 42;

export function usesHelper(): boolean {
  helper();
  return internalAnswer === 42;
}
