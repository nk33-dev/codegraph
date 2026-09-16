#include "util.hpp"

namespace fixture {

Calculator::Calculator(int seed) : seed_(seed) {}

int Calculator::add(int value) const {
  return seed_ + value;
}

int util_add(int a, int b) {
  return a + b;
}

}  // namespace fixture
