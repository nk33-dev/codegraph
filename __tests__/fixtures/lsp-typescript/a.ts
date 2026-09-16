export function targetFn(input: number): number {
  return input + 1;
}

export function callerFn(): number {
  return targetFn(1);
}
