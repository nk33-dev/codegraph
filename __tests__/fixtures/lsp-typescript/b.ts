import { targetFn } from './a';

export function callerInB(): number {
  return targetFn(2);
}
