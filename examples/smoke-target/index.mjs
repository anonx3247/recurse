// A tiny library with one deliberate bug, used by the live smoke cycle.
// The smoke worker agent is asked to make the failing test pass.

/** Add two numbers. */
export function add(a, b) {
  return a + b;
}

/** Subtract `b` from `a`. BUG: this currently adds instead of subtracting. */
export function subtract(a, b) {
  return a + b;
}
