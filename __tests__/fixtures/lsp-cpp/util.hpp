#pragma once

namespace fixture {

int util_add(int a, int b);

class Calculator {
 public:
  explicit Calculator(int seed);
  int add(int value) const;

 private:
  int seed_;
};

}  // namespace fixture
