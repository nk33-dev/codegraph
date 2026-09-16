#include "util.hpp"

int main() {
  fixture::Calculator calculator(1);
  return calculator.add(fixture::util_add(1, 2));
}
