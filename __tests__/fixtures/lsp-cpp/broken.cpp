// Deliberate type error for the get_diagnostics assertion (clangd reports an incompatible conversion).
int broken_call() {
  return "not a number";
}
